import { randomUUID } from 'node:crypto';
import {
  Argon2idPasswordHasher,
  AuthService,
  PostgresAuthRepository,
  PostgresLoginRateLimiter,
  PostgresWorkspaceRepository,
  requireProductDatabaseFromEnv,
  type ProductDatabase,
} from '@kodex/product-db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ProductApiConfig } from '../../apps/api/src/config.js';
import { csrfCookieName, sessionCookieName } from '../../apps/api/src/cookies.js';
import { ProductApiServer } from '../../apps/api/src/server.js';

const origin = 'http://127.0.0.1:5173';
const prefix = `workspace-it-${randomUUID()}`;
const password = 'correct horse battery staple';

interface Session {
  cookie: string;
  csrf: string;
  userId: string;
}

function cookies(response: Response): { cookie: string; csrf: string } {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const setCookies = headers.getSetCookie?.() ?? [response.headers.get('set-cookie') ?? ''].filter(Boolean);
  const pairs = setCookies.map((entry) => entry.split(';', 1)[0]);
  const values = new Map(pairs.map((pair) => {
    const separator = pair.indexOf('=');
    return [pair.slice(0, separator), decodeURIComponent(pair.slice(separator + 1))];
  }));
  const csrf = values.get(csrfCookieName);
  if (!values.get(sessionCookieName) || !csrf) throw new Error('Missing authentication cookies');
  return { cookie: pairs.join('; '), csrf };
}

describe('real PostgreSQL workspace membership product flow', () => {
  let database: ProductDatabase;
  let server: ProductApiServer;
  let baseUrl: string;
  let auth: AuthService;
  let config: ProductApiConfig;
  const email = (label: string) => `${prefix}-${label}@example.invalid`;

  beforeAll(async () => {
    database = requireProductDatabaseFromEnv();
    await database.migrate();
    const repository = new PostgresAuthRepository(database);
    config = {
      host: '127.0.0.1', port: 0, allowedHosts: new Set(), allowedOrigins: new Set([origin]),
      cookieSecret: Buffer.alloc(32, 31), secureCookies: false, sessionTtlMs: 3_600_000, maxBodyBytes: 65_536,
      loginRateLimitMaxAttempts: 5, loginRateLimitWindowMs: 900_000, loginRateLimitBlockMs: 900_000,
    };
    auth = await AuthService.create(repository, new Argon2idPasswordHasher(), {
      sessionTtlMs: config.sessionTtlMs,
      loginRateLimitSecret: config.cookieSecret,
      loginRateLimiter: new PostgresLoginRateLimiter(database, {
        maxAttempts: config.loginRateLimitMaxAttempts,
        windowMs: config.loginRateLimitWindowMs,
        blockMs: config.loginRateLimitBlockMs,
      }),
    });
    server = new ProductApiServer(
      auth, config, undefined, undefined, undefined,
      new PostgresWorkspaceRepository(database, { cursorSecret: config.cookieSecret }),
    );
    baseUrl = `http://127.0.0.1:${await server.listen()}`;
  });

  afterAll(async () => {
    await server?.close();
    if (database) {
      await database.query('DELETE FROM workspaces WHERE owner_user_id IN (SELECT id FROM users WHERE email LIKE $1)', [`${prefix}-%`]);
      await database.query('DELETE FROM users WHERE email LIKE $1', [`${prefix}-%`]);
      await database.close();
    }
  });

  async function register(label: string): Promise<Session> {
    const response = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email(label), password, displayName: label.toUpperCase() }),
    });
    expect(response.status).toBe(201);
    const body = await response.json() as { user: { id: string } };
    return { ...cookies(response), userId: body.user.id };
  }

  async function request(session: Session, path: string, method = 'GET', body?: unknown): Promise<Response> {
    const headers = new Headers({ Cookie: session.cookie, Origin: origin });
    if (method !== 'GET') headers.set('X-CSRF-Token', session.csrf);
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    return fetch(`${baseUrl}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }

  it('creates, revalidates, manages roles conservatively, prevents IDOR, audits, and serializes last-owner changes', async () => {
    const [a, b, c] = await Promise.all([register('a'), register('b'), register('c')]);
    const createdResponse = await request(a, '/api/workspaces', 'POST', { name: 'Shared Platform' });
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json() as { id: string; role: string; slug: string };
    expect(created).toMatchObject({ role: 'owner' });
    expect(created.slug).toMatch(/^workspace-[0-9a-f-]{36}$/u);

    const meA = await request(a, '/api/auth/me');
    expect((await meA.json() as { workspaces: Array<{ id: string }> }).workspaces.some((entry) => entry.id === created.id)).toBe(true);

    const addedB = await request(a, `/api/workspaces/${created.id}/members`, 'POST', { email: email('b').toUpperCase(), role: 'admin' });
    expect(addedB.status).toBe(201);
    expect(await addedB.json()).toMatchObject({ userId: b.userId, email: email('b'), role: 'admin' });
    const meB = await request(b, '/api/auth/me');
    expect((await meB.json() as { workspaces: Array<{ id: string; role: string }> }).workspaces).toContainEqual(expect.objectContaining({ id: created.id, role: 'admin' }));

    expect((await request(b, `/api/workspaces/${created.id}/members`, 'POST', { email: email('c'), role: 'admin' })).status).toBe(403);
    expect((await request(b, `/api/workspaces/${created.id}/members`, 'POST', { email: email('c'), role: 'member' })).status).toBe(201);
    expect((await request(b, `/api/workspaces/${created.id}/members/${b.userId}`, 'PATCH', { role: 'member' })).status).toBe(403);
    expect((await request(c, `/api/workspaces/${created.id}/members/${b.userId}`, 'DELETE')).status).toBe(403);
    expect((await request(a, `/api/workspaces/${created.id}/members/${b.userId}`, 'PATCH', { role: 'member' })).status).toBe(200);
    expect((await request(a, `/api/workspaces/${created.id}/members/${b.userId}`, 'PATCH', { role: 'admin' })).status).toBe(200);

    const privateWorkspace = (await request(b, '/api/workspaces', 'POST', { name: 'B Private' }).then((response) => response.json())) as { id: string };
    expect((await request(a, `/api/workspaces/${privateWorkspace.id}/members`)).status).toBe(403);
    expect((await request(a, `/api/workspaces/${privateWorkspace.id}/members/${c.userId}`, 'PATCH', { role: 'viewer' })).status).toBe(403);

    expect((await request(a, `/api/workspaces/${created.id}/members/${c.userId}`, 'PATCH', { role: 'owner' })).status).toBe(200);
    const concurrent = await Promise.all([
      request(a, `/api/workspaces/${created.id}/members/${a.userId}`, 'PATCH', { role: 'member' }),
      request(c, `/api/workspaces/${created.id}/members/${c.userId}`, 'DELETE'),
    ]);
    const statuses = concurrent.map((response) => response.status);
    expect(statuses).toContain(409);
    expect(statuses.some((status) => status === 200 || status === 204)).toBe(true);
    const owners = await database.query<{ count: string }>('SELECT count(*) FROM workspace_members WHERE workspace_id = $1 AND role = \'owner\'', [created.id]);
    expect(owners.rows[0].count).toBe('1');
    const remainingOwner = await database.query<{ user_id: string }>('SELECT user_id FROM workspace_members WHERE workspace_id = $1 AND role = \'owner\'', [created.id]);
    const ownerSession = remainingOwner.rows[0].user_id === a.userId ? a : c;
    expect((await request(ownerSession, `/api/workspaces/${created.id}/members/${b.userId}`, 'DELETE')).status).toBe(204);
    const meAfterRemoval = await request(b, '/api/auth/me').then((response) => response.json()) as { workspaces: Array<{ id: string }> };
    expect(meAfterRemoval.workspaces.some((entry) => entry.id === created.id)).toBe(false);

    const audit = await database.query<{ action: string; details: Record<string, string> }>(
      'SELECT action, details FROM audit_logs WHERE workspace_id = $1 ORDER BY id', [created.id],
    );
    expect(audit.rows.map((entry) => entry.action)).toEqual(expect.arrayContaining([
      'workspace.created', 'workspace.member_added', 'workspace.member_role_changed', 'workspace.member_removed',
    ]));
    expect(audit.rows.every((entry) => !JSON.stringify(entry).includes('password'))).toBe(true);
  });

  it('uses stable safe errors for validation, unknown accounts, conflicts, and last-owner removal', async () => {
    const owner = await register('errors-owner');
    expect((await request(owner, '/api/workspaces', 'POST', { name: ' padded ' })).status).toBe(422);
    const workspace = await request(owner, '/api/workspaces', 'POST', { name: 'Errors' }).then((response) => response.json()) as { id: string };
    const unknown = await request(owner, `/api/workspaces/${workspace.id}/members`, 'POST', { email: `${prefix}-missing@example.invalid`, role: 'member' });
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ ok: false, error: { code: 'not_found', message: 'The existing account or membership was not found.' } });
    expect((await request(owner, `/api/workspaces/${workspace.id}/members`, 'POST', { email: email('errors-owner'), role: 'member' })).status).toBe(409);
    expect((await request(owner, `/api/workspaces/${workspace.id}/members/${owner.userId}`, 'DELETE')).status).toBe(409);
  });

  it('renames and one-way archives without deleting product rows, while serializing invitation acceptance', async () => {
    const [owner, admin, member, invitee, pending] = await Promise.all([
      register('lifecycle-owner'),
      register('lifecycle-admin'),
      register('lifecycle-member'),
      register('lifecycle-invitee'),
      register('lifecycle-pending'),
    ]);
    const originalName = 'Lifecycle Original';
    const renamedName = 'Lifecycle Renamed';
    const workspace = await request(owner, '/api/workspaces', 'POST', { name: originalName })
      .then((response) => response.json()) as { id: string };
    expect((await request(owner, `/api/workspaces/${workspace.id}/members`, 'POST', {
      email: email('lifecycle-admin'), role: 'admin',
    })).status).toBe(201);
    expect((await request(owner, `/api/workspaces/${workspace.id}/members`, 'POST', {
      email: email('lifecycle-member'), role: 'member',
    })).status).toBe(201);

    const renamed = await request(admin, `/api/workspaces/${workspace.id}`, 'PATCH', { name: renamedName });
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toMatchObject({ id: workspace.id, name: renamedName, role: 'admin' });
    expect((await request(member, `/api/workspaces/${workspace.id}`, 'PATCH', { name: 'Denied Rename' })).status).toBe(403);
    expect((await request(admin, `/api/workspaces/${workspace.id}`, 'DELETE', { confirmationName: renamedName })).status).toBe(403);
    expect((await request(owner, `/api/workspaces/${workspace.id}`, 'DELETE', { confirmationName: originalName })).status).toBe(409);

    const acceptedInvitation = await request(owner, `/api/workspaces/${workspace.id}/invitations`, 'POST', {
      email: email('lifecycle-invitee'), role: 'member',
    }).then((response) => response.json()) as { invitation: { id: string }; token: string };
    const pendingInvitation = await request(owner, `/api/workspaces/${workspace.id}/invitations`, 'POST', {
      email: email('lifecycle-pending'), role: 'viewer',
    }).then((response) => response.json()) as { invitation: { id: string }; token: string };

    const retained = await database.transaction(async (client) => {
      const project = await client.query<{ id: string }>(
        `INSERT INTO projects (workspace_id, created_by_user_id, name, external_key)
         VALUES ($1, $2, 'retained project', $3) RETURNING id`,
        [workspace.id, owner.userId, `${prefix}-retained-project`],
      );
      const thread = await client.query<{ id: string }>(
        `INSERT INTO agent_threads (workspace_id, project_id, created_by_user_id, codex_thread_id, title)
         VALUES ($1, $2, $3, $4, 'retained thread') RETURNING id`,
        [workspace.id, project.rows[0].id, owner.userId, `${prefix}-retained-thread`],
      );
      const source = await client.query<{ id: string }>(
        `INSERT INTO knowledge_sources
           (workspace_id, created_by_user_id, source_type, external_key, name, status)
         VALUES ($1, $2, 'text', $3, 'retained source', 'ready') RETURNING id`,
        [workspace.id, owner.userId, `${prefix}-retained-source`],
      );
      const document = await client.query<{ id: string }>(
        `INSERT INTO documents
           (workspace_id, source_id, created_by_user_id, source_document_id, title, content_text)
         VALUES ($1, $2, $3, $4, 'retained document', 'retained content') RETURNING id`,
        [workspace.id, source.rows[0].id, owner.userId, `${prefix}-retained-document`],
      );
      await client.query(
        `INSERT INTO audit_logs (workspace_id, actor_user_id, action, target_type, target_id, details)
         VALUES ($1, $2, 'retained.marker', 'workspace', $3, '{"operation":"retain"}'::jsonb)`,
        [workspace.id, owner.userId, workspace.id],
      );
      return { projectId: project.rows[0].id, threadId: thread.rows[0].id, sourceId: source.rows[0].id, documentId: document.rows[0].id };
    });

    const [acceptResponse, archiveResponse] = await Promise.all([
      request(invitee, '/api/invitations/accept', 'POST', { token: acceptedInvitation.token }),
      request(owner, `/api/workspaces/${workspace.id}`, 'DELETE', { confirmationName: renamedName }),
    ]);
    expect(archiveResponse.status).toBe(204);
    expect([200, 410]).toContain(acceptResponse.status);

    const archivedRow = await database.query<{ deleted_at: Date; name: string }>(
      'SELECT deleted_at, name FROM workspaces WHERE id = $1', [workspace.id],
    );
    expect(archivedRow.rows[0]).toMatchObject({ name: renamedName });
    expect(archivedRow.rows[0].deleted_at).toBeInstanceOf(Date);
    const archivedAt = archivedRow.rows[0].deleted_at.toISOString();
    expect((await request(owner, `/api/workspaces/${workspace.id}`, 'DELETE', { confirmationName: renamedName })).status).toBe(403);
    expect((await database.query<{ deleted_at: Date }>('SELECT deleted_at FROM workspaces WHERE id = $1', [workspace.id])).rows[0].deleted_at.toISOString()).toBe(archivedAt);

    const invitationRows = await database.query<{ accepted_at: Date | null; id: string; revoked_at: Date | null }>(
      `SELECT id, accepted_at, revoked_at FROM workspace_invitations
       WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [[acceptedInvitation.invitation.id, pendingInvitation.invitation.id]],
    );
    const unresolved = invitationRows.rows.find((entry) => entry.id === pendingInvitation.invitation.id)!;
    expect(unresolved.accepted_at).toBeNull();
    expect(unresolved.revoked_at).toBeInstanceOf(Date);
    const raced = invitationRows.rows.find((entry) => entry.id === acceptedInvitation.invitation.id)!;
    expect(Boolean(raced.accepted_at) !== Boolean(raced.revoked_at)).toBe(true);

    const preserved = await database.query<{
      audit_count: string; document_count: string; member_count: string; project_count: string; source_count: string; thread_count: string;
    }>(
      `SELECT
         (SELECT count(*) FROM workspace_members WHERE workspace_id = $1) AS member_count,
         (SELECT count(*) FROM projects WHERE workspace_id = $1 AND id = $2) AS project_count,
         (SELECT count(*) FROM agent_threads WHERE workspace_id = $1 AND id = $3) AS thread_count,
         (SELECT count(*) FROM knowledge_sources WHERE workspace_id = $1 AND id = $4) AS source_count,
         (SELECT count(*) FROM documents WHERE workspace_id = $1 AND id = $5) AS document_count,
         (SELECT count(*) FROM audit_logs WHERE workspace_id = $1) AS audit_count`,
      [workspace.id, retained.projectId, retained.threadId, retained.sourceId, retained.documentId],
    );
    expect(Number(preserved.rows[0].member_count)).toBeGreaterThanOrEqual(3);
    expect(preserved.rows[0]).toMatchObject({ project_count: '1', thread_count: '1', source_count: '1', document_count: '1' });
    expect(Number(preserved.rows[0].audit_count)).toBeGreaterThanOrEqual(3);

    const me = await request(owner, '/api/auth/me').then((response) => response.json()) as { workspaces: Array<{ id: string }> };
    expect(me.workspaces.some((entry) => entry.id === workspace.id)).toBe(false);
    const deniedRequests = await Promise.all([
      request(owner, `/api/workspaces/${workspace.id}/members`),
      request(owner, `/api/workspaces/${workspace.id}/invitations`),
      request(owner, `/api/workspaces/${workspace.id}`, 'PATCH', { name: 'No Resurrection' }),
      request(owner, `/api/workspaces/${workspace.id}/members`, 'POST', { email: email('lifecycle-pending'), role: 'viewer' }),
      request(owner, `/api/workspaces/${workspace.id}/members/${member.userId}`, 'PATCH', { role: 'viewer' }),
      request(owner, `/api/workspaces/${workspace.id}/members/${member.userId}`, 'DELETE'),
      request(owner, `/api/workspaces/${workspace.id}/invitations`, 'POST', { email: email('lifecycle-pending'), role: 'viewer' }),
      request(owner, `/api/workspaces/${workspace.id}/invitations/${pendingInvitation.invitation.id}`, 'DELETE'),
    ]);
    expect(deniedRequests.map((response) => response.status)).toEqual(Array(8).fill(403));
    expect((await request(pending, '/api/invitations/accept', 'POST', { token: pendingInvitation.token })).status).toBe(410);
    const preview = await fetch(`${baseUrl}/api/invitations/preview`, {
      method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: pendingInvitation.token }),
    });
    expect(preview.status).toBe(410);

    const lifecycleAudit = await database.query<{ action: string; details: Record<string, string>; target_id: string }>(
      `SELECT action, details, target_id FROM audit_logs
       WHERE workspace_id = $1 AND action IN ('workspace.renamed', 'workspace.archived') ORDER BY id`,
      [workspace.id],
    );
    expect(lifecycleAudit.rows).toEqual([
      { action: 'workspace.renamed', details: { operation: 'rename' }, target_id: workspace.id },
      { action: 'workspace.archived', details: { operation: 'archive' }, target_id: workspace.id },
    ]);
    const serializedAudit = JSON.stringify(lifecycleAudit.rows);
    for (const secretValue of [originalName, renamedName, email('lifecycle-invitee'), acceptedInvitation.token, pendingInvitation.token]) {
      expect(serializedAudit).not.toContain(secretValue);
    }
  });

  it('serializes concurrent rename and archive without resurrecting an archived workspace', async () => {
    const owner = await register('rename-archive-race');
    const workspace = await request(owner, '/api/workspaces', 'POST', { name: 'Rename Race' })
      .then((response) => response.json()) as { id: string };
    const [renameResponse, archiveResponse] = await Promise.all([
      request(owner, `/api/workspaces/${workspace.id}`, 'PATCH', { name: 'Rename Won' }),
      request(owner, `/api/workspaces/${workspace.id}`, 'DELETE', { confirmationName: 'Rename Race' }),
    ]);
    const statuses = [renameResponse.status, archiveResponse.status];
    expect([[403, 204], [200, 409]]).toContainEqual(statuses);
    if (archiveResponse.status === 409) {
      expect((await request(owner, `/api/workspaces/${workspace.id}`, 'DELETE', { confirmationName: 'Rename Won' })).status).toBe(204);
    }
    const row = await database.query<{ deleted_at: Date | null; name: string }>(
      'SELECT name, deleted_at FROM workspaces WHERE id = $1', [workspace.id],
    );
    expect(row.rows[0].deleted_at).toBeInstanceOf(Date);
    expect(['Rename Race', 'Rename Won']).toContain(row.rows[0].name);
    expect((await request(owner, `/api/workspaces/${workspace.id}`, 'PATCH', { name: 'Resurrected' })).status).toBe(403);
  });

  it('paginates a large tied member set with opaque scoped keysets across a middle mutation', async () => {
    const owner = await register('page-owner');
    const workspace = await request(owner, '/api/workspaces', 'POST', { name: 'Paged Members' })
      .then((response) => response.json()) as { id: string };
    await database.query(
      `WITH inserted AS (
         INSERT INTO users (email, display_name, email_verified_at)
         SELECT $1 || '-page-' || lpad(value::text, 3, '0') || '@example.invalid',
                'Page ' || value::text, now()
         FROM generate_series(1, 105) value
         RETURNING id
       )
       INSERT INTO workspace_members (workspace_id, user_id, role, joined_at)
       SELECT $2, id, 'member', '2026-01-01 00:00:00.123456+00'::timestamptz
       FROM inserted`,
      [prefix, workspace.id],
    );
    const initialOrder = await database.query<{ user_id: string }>(
      'SELECT user_id FROM workspace_members WHERE workspace_id = $1 ORDER BY joined_at, user_id',
      [workspace.id],
    );
    await database.query('ANALYZE workspace_members');
    await database.query('ANALYZE users');
    const memberPlan = await database.transaction(async (client) => {
      await client.query('SET LOCAL enable_seqscan = off');
      return client.query<{ 'QUERY PLAN': unknown }>(
        `EXPLAIN (FORMAT JSON)
         SELECT wm.user_id, u.email, u.display_name, wm.role, wm.joined_at
         FROM workspace_members wm
         JOIN users u ON u.id = wm.user_id AND u.status = 'active' AND u.deleted_at IS NULL
         WHERE wm.workspace_id = $1
           AND ($2::timestamptz IS NULL OR (wm.joined_at, wm.user_id) > ($2::timestamptz, $3::uuid))
         ORDER BY wm.joined_at, wm.user_id
         LIMIT 26`,
        [workspace.id, null, null],
      );
    });
    expect(JSON.stringify(memberPlan.rows[0]['QUERY PLAN']))
      .toContain('workspace_members_workspace_joined_idx');
    const firstResponse = await request(owner, `/api/workspaces/${workspace.id}/members?limit=25`);
    expect(firstResponse.status).toBe(200);
    const first = await firstResponse.json() as { members: Array<{ userId: string }>; nextCursor?: string };
    expect(first.members).toHaveLength(25);
    expect(first.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/u);
    const packedCursor = Buffer.from(first.nextCursor!, 'base64url').toString('utf8');
    expect(packedCursor).not.toContain(workspace.id);
    expect(packedCursor).not.toContain(first.members.at(-1)!.userId);
    expect(packedCursor).not.toContain('2026-01-01');

    const removedId = initialOrder.rows[30].user_id;
    await database.query(
      'DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
      [workspace.id, removedId],
    );
    const newcomer = await database.query<{ id: string }>(
      `INSERT INTO users (email, display_name, email_verified_at)
       VALUES ($1, 'Page New', now()) RETURNING id`,
      [`${prefix}-page-new@example.invalid`],
    );
    await database.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role, joined_at)
       VALUES ($1, $2, 'viewer', '2027-01-01 00:00:00+00')`,
      [workspace.id, newcomer.rows[0].id],
    );

    const seen = first.members.map((entry) => entry.userId);
    let cursor = first.nextCursor;
    while (cursor) {
      const response = await request(
        owner,
        `/api/workspaces/${workspace.id}/members?limit=25&cursor=${encodeURIComponent(cursor)}`,
      );
      expect(response.status).toBe(200);
      const page = await response.json() as { members: Array<{ userId: string }>; nextCursor?: string };
      seen.push(...page.members.map((entry) => entry.userId));
      cursor = page.nextCursor;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).not.toContain(removedId);
    expect(seen).toContain(newcomer.rows[0].id);
    const currentCount = await database.query<{ count: string }>(
      'SELECT count(*) FROM workspace_members WHERE workspace_id = $1', [workspace.id],
    );
    expect(seen).toHaveLength(Number(currentCount.rows[0].count));

    const other = await request(owner, '/api/workspaces', 'POST', { name: 'Cursor Scope' })
      .then((response) => response.json()) as { id: string };
    expect((await request(owner, `/api/workspaces/${other.id}/members?cursor=${first.nextCursor}`)).status).toBe(400);
    expect((await request(owner, `/api/workspaces/${workspace.id}/invitations?cursor=${first.nextCursor}`)).status).toBe(400);
    const tampered = `${first.nextCursor!.slice(0, -1)}${first.nextCursor!.endsWith('A') ? 'B' : 'A'}`;
    const tamperedResponse = await request(owner, `/api/workspaces/${workspace.id}/members?cursor=${tampered}`);
    expect(tamperedResponse.status).toBe(400);
    expect(await tamperedResponse.json()).toEqual({
      ok: false,
      error: { code: 'invalid_cursor', message: 'Workspace cursor is invalid.' },
    });
    const rotatedServer = new ProductApiServer(
      auth,
      { ...config, port: 0, allowedHosts: new Set() },
      undefined,
      undefined,
      undefined,
      new PostgresWorkspaceRepository(database, { cursorSecret: Buffer.alloc(32, 99) }),
    );
    const rotatedBase = `http://127.0.0.1:${await rotatedServer.listen()}`;
    try {
      const rotatedResponse = await fetch(
        `${rotatedBase}/api/workspaces/${workspace.id}/members?cursor=${first.nextCursor}`,
        { headers: { Cookie: owner.cookie, Origin: origin } },
      );
      expect(rotatedResponse.status).toBe(400);
      expect(await rotatedResponse.json()).toEqual({
        ok: false,
        error: { code: 'invalid_cursor', message: 'Workspace cursor is invalid.' },
      });
    } finally {
      await rotatedServer.close();
    }
    expect((await request(owner, `/api/workspaces/${workspace.id}/members?cursor=not%21opaque`)).status).toBe(400);
    expect((await request(owner, `/api/workspaces/${workspace.id}/members?limit=101`)).status).toBe(400);
    const capped = await request(owner, `/api/workspaces/${workspace.id}/members?limit=100`)
      .then((response) => response.json()) as { members: unknown[] };
    expect(capped.members).toHaveLength(100);
  });
});
