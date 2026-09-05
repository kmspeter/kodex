import { randomUUID } from 'node:crypto';
import {
  Argon2idPasswordHasher,
  AuthService,
  loadMigrations,
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
const prefix = `invitation-it-${randomUUID()}`;
const password = 'correct horse battery staple';
const mode = process.env.INVITATION_MIGRATION_MODE === 'upgrade'
  ? 'upgrade'
  : process.env.INVITATION_MIGRATION_MODE === 'phase17-upgrade'
    ? 'phase17-upgrade'
    : process.env.INVITATION_MIGRATION_MODE === 'phase19-upgrade'
      ? 'phase19-upgrade'
      : 'fresh';

interface Session {
  cookie: string;
  csrf: string;
  email: string;
  userId: string;
}

function authCookies(response: Response): { cookie: string; csrf: string } {
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

describe(`real PostgreSQL workspace invitation lifecycle (${mode})`, () => {
  let database: ProductDatabase;
  let server: ProductApiServer;
  let baseUrl: string;
  let migratedVersions: number[];
  const email = (label: string) => `${prefix}-${label}@example.invalid`;

  beforeAll(async () => {
    database = requireProductDatabaseFromEnv();
    if (mode !== 'fresh') {
      const migrations = await loadMigrations();
      await database.transaction(async (client) => {
        await client.query(`CREATE TABLE public.schema_migrations (
          version bigint PRIMARY KEY, name text NOT NULL, checksum text NOT NULL,
          applied_at timestamptz NOT NULL DEFAULT now()
        )`);
        const legacyCount = mode === 'upgrade' ? 6 : mode === 'phase17-upgrade' ? 7 : 8;
        for (const migration of migrations.slice(0, legacyCount)) {
          await client.query(migration.sql);
          await client.query(
            'INSERT INTO public.schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
            [migration.version, migration.name, migration.checksum],
          );
        }
      });
    }
    migratedVersions = (await database.migrate()).map((entry) => entry.version);
    const config: ProductApiConfig = {
      host: '127.0.0.1', port: 0, allowedHosts: new Set(), allowedOrigins: new Set([origin]),
      cookieSecret: Buffer.alloc(32, 73), secureCookies: false, sessionTtlMs: 3_600_000, maxBodyBytes: 65_536,
      loginRateLimitMaxAttempts: 5, loginRateLimitWindowMs: 900_000, loginRateLimitBlockMs: 900_000,
      workspaceInvitationPendingLimit: 2, workspaceInvitationTtlMs: 3_600_000,
    };
    const auth = await AuthService.create(new PostgresAuthRepository(database), new Argon2idPasswordHasher(), {
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
      new PostgresWorkspaceRepository(database, {
        cursorSecret: config.cookieSecret,
        pendingLimit: 2,
        ttlMs: 3_600_000,
      }),
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
    const address = email(label);
    const response = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: address, password, displayName: label.toUpperCase() }),
    });
    expect(response.status).toBe(201);
    const body = await response.json() as { user: { id: string } };
    return { ...authCookies(response), email: address, userId: body.user.id };
  }

  async function request(session: Session | null, path: string, method = 'GET', body?: unknown): Promise<Response> {
    const headers = new Headers({ Origin: origin });
    if (session) headers.set('Cookie', session.cookie);
    if (session && method !== 'GET') headers.set('X-CSRF-Token', session.csrf);
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    return fetch(`${baseUrl}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }

  async function createWorkspace(owner: Session, name: string): Promise<string> {
    const response = await request(owner, '/api/workspaces', 'POST', { name });
    expect(response.status).toBe(201);
    return (await response.json() as { id: string }).id;
  }

  async function invite(owner: Session, workspaceId: string, targetEmail: string, role: string): Promise<{ id: string; token: string }> {
    const response = await request(owner, `/api/workspaces/${workspaceId}/invitations`, 'POST', { email: targetEmail, role });
    expect(response.status).toBe(201);
    const body = await response.json() as { invitation: { id: string }; token: string };
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    return { id: body.invitation.id, token: body.token };
  }

  it('applies fresh and immutable legacy upgrade paths through migration 0013', async () => {
    expect(migratedVersions).toEqual(
      mode === 'upgrade'
        ? [7, 8, 9, 10, 11, 12, 13]
        : mode === 'phase17-upgrade'
          ? [8, 9, 10, 11, 12, 13]
          : mode === 'phase19-upgrade'
            ? [9, 10, 11, 12, 13]
            : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
    );
    const ledger = await database.query<{ version: string }>('SELECT version FROM schema_migrations ORDER BY version');
    expect(ledger.rows.map((entry) => Number(entry.version))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
  });

  it('enforces permissions, limits, hash-only storage, IDOR protection, and one-time atomic acceptance', async () => {
    const [owner, admin, member, viewer, mismatch, extra] = await Promise.all([
      register('owner'), register('admin'), register('member'), register('viewer'),
      register('mismatch'), register('extra'),
    ]);
    const inviteeEmail = email('invitee');
    const workspaceId = await createWorkspace(owner, 'Invitation Platform');
    for (const [session, role] of [[admin, 'admin'], [member, 'member'], [viewer, 'viewer']] as const) {
      expect((await request(owner, `/api/workspaces/${workspaceId}/members`, 'POST', { email: session.email, role })).status).toBe(201);
    }
    for (const session of [owner, admin, member, viewer]) {
      expect((await request(session, `/api/workspaces/${workspaceId}/members`)).status).toBe(200);
    }

    expect((await request(admin, `/api/workspaces/${workspaceId}/invitations`, 'POST', { email: extra.email, role: 'admin' })).status).toBe(403);
    expect((await request(member, `/api/workspaces/${workspaceId}/invitations`, 'POST', { email: extra.email, role: 'member' })).status).toBe(403);
    expect((await request(viewer, `/api/workspaces/${workspaceId}/invitations`)).status).toBe(403);

    const created = await invite(owner, workspaceId, inviteeEmail.toUpperCase(), 'member');
    const stored = await database.query<{ encoded: string; target_email: string }>(
      `SELECT encode(token_hash, 'hex') AS encoded, target_email FROM workspace_invitations WHERE id = $1`, [created.id],
    );
    expect(stored.rows[0].encoded).toMatch(/^[a-f0-9]{64}$/u);
    expect(stored.rows[0].encoded).not.toContain(created.token);
    expect(stored.rows[0].target_email).toBe(inviteeEmail);

    const duplicate = await request(owner, `/api/workspaces/${workspaceId}/invitations`, 'POST', { email: inviteeEmail, role: 'viewer' });
    expect(duplicate.status).toBe(409);
    const second = await invite(admin, workspaceId, extra.email, 'viewer');
    expect((await request(owner, `/api/workspaces/${workspaceId}/invitations`, 'POST', { email: email('over-limit'), role: 'member' })).status).toBe(409);

    const floodWorkspaceId = await createWorkspace(owner, 'Invitation Flood');
    const floodResponses = await Promise.all(['one', 'two', 'three'].map((label) => request(
      owner,
      `/api/workspaces/${floodWorkspaceId}/invitations`,
      'POST',
      { email: email(`flood-${label}`), role: 'member' },
    )));
    expect(floodResponses.map((entry) => entry.status).sort((a, b) => a - b)).toEqual([201, 201, 409]);

    const pending = await request(owner, `/api/workspaces/${workspaceId}/invitations`).then((response) => response.json()) as { invitations: Array<Record<string, unknown>> };
    expect(pending.invitations).toHaveLength(2);
    expect(pending.invitations.every((entry) => !('token' in entry) && !('tokenHash' in entry))).toBe(true);
    expect((await request(admin, `/api/workspaces/${workspaceId}/invitations`)).status).toBe(200);

    const otherWorkspace = await createWorkspace(mismatch, 'Other Workspace');
    expect((await request(mismatch, `/api/workspaces/${workspaceId}/invitations`)).status).toBe(403);
    expect((await request(mismatch, `/api/workspaces/${workspaceId}/invitations/${second.id}`, 'DELETE')).status).toBe(403);
    expect(otherWorkspace).not.toBe(workspaceId);

    const preview = await request(null, '/api/invitations/preview', 'POST', { token: created.token });
    expect(preview.status).toBe(200);
    expect(await preview.json()).toEqual(expect.objectContaining({
      workspaceName: 'Invitation Platform', role: 'member', targetEmailHint: 'i***@example.invalid',
    }));
    expect((await request(mismatch, '/api/invitations/accept', 'POST', { token: created.token })).status).toBe(403);

    const invitee = await register('invitee');
    const accepted = await Promise.all([
      request(invitee, '/api/invitations/accept', 'POST', { token: created.token }),
      request(invitee, '/api/invitations/accept', 'POST', { token: created.token }),
    ]);
    expect(accepted.map((entry) => entry.status).sort((a, b) => a - b)).toEqual([200, 410]);
    expect((await request(invitee, '/api/invitations/accept', 'POST', { token: created.token })).status).toBe(410);
    const me = await request(invitee, '/api/auth/me').then((response) => response.json()) as { workspaces: Array<{ id: string; role: string }> };
    expect(me.workspaces).toContainEqual(expect.objectContaining({ id: workspaceId, role: 'member' }));

    const audit = await database.query<{ action: string; details: Record<string, string>; target_id: string }>(
      `SELECT action, details, target_id FROM audit_logs
       WHERE workspace_id = $1 AND action LIKE 'workspace.invitation_%' ORDER BY id`, [workspaceId],
    );
    expect(audit.rows.map((entry) => entry.action)).toEqual(expect.arrayContaining([
      'workspace.invitation_created', 'workspace.invitation_accepted',
    ]));
    const auditText = JSON.stringify(audit.rows);
    expect(auditText).not.toContain(created.token);
    expect(auditText).not.toContain(stored.rows[0].encoded);
    expect(auditText).not.toContain(inviteeEmail);
  });

  it('uses one safe terminal response for revoked, expired, and reused tokens and preserves existing roles', async () => {
    const [owner, revokedUser, expiredUser, existing] = await Promise.all([
      register('state-owner'), register('revoked'), register('expired'), register('existing'),
    ]);
    const workspaceId = await createWorkspace(owner, 'Invitation States');

    const revoked = await invite(owner, workspaceId, revokedUser.email, 'member');
    expect((await request(owner, `/api/workspaces/${workspaceId}/invitations/${revoked.id}`, 'DELETE')).status).toBe(204);
    const revokedPreview = await request(null, '/api/invitations/preview', 'POST', { token: revoked.token });
    const revokedAccept = await request(revokedUser, '/api/invitations/accept', 'POST', { token: revoked.token });
    expect([revokedPreview.status, revokedAccept.status]).toEqual([410, 410]);
    expect(await revokedPreview.json()).toEqual(await revokedAccept.json());

    const expired = await invite(owner, workspaceId, expiredUser.email, 'viewer');
    await database.query(
      `UPDATE workspace_invitations
       SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour'
       WHERE id = $1`,
      [expired.id],
    );
    expect((await request(null, '/api/invitations/preview', 'POST', { token: expired.token })).status).toBe(410);
    expect((await request(expiredUser, '/api/invitations/accept', 'POST', { token: expired.token })).status).toBe(410);

    const existingInvite = await invite(owner, workspaceId, existing.email, 'admin');
    expect((await request(owner, `/api/workspaces/${workspaceId}/members`, 'POST', { email: existing.email, role: 'viewer' })).status).toBe(201);
    expect((await request(existing, '/api/invitations/accept', 'POST', { token: existingInvite.token })).status).toBe(409);
    const membership = await database.query<{ role: string }>(
      'SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [workspaceId, existing.userId],
    );
    expect(membership.rows[0].role).toBe('viewer');
    const revokedAudit = await database.query<{ details: Record<string, string> }>(
      `SELECT details FROM audit_logs
       WHERE workspace_id = $1 AND action = 'workspace.invitation_revoked' AND target_id = $2`,
      [workspaceId, revoked.id],
    );
    expect(revokedAudit.rows).toEqual([{ details: { role: 'member' } }]);
    expect(JSON.stringify(revokedAudit.rows)).not.toContain(revoked.token);
    expect(JSON.stringify(revokedAudit.rows)).not.toContain(revokedUser.email);
  });

  it('paginates tied pending invitations with opaque endpoint-bound cursors and live mutation semantics', async () => {
    const owner = await register('page-owner');
    const workspaceId = await createWorkspace(owner, 'Paged Invitations');
    await database.query(
      `INSERT INTO workspace_invitations
         (workspace_id, target_email, requested_role, created_by_user_id, token_hash, created_at, expires_at)
       SELECT $1,
              $2 || '-page-' || lpad(value::text, 3, '0') || '@example.invalid',
              CASE value % 3 WHEN 0 THEN 'admin' WHEN 1 THEN 'member' ELSE 'viewer' END,
              $3,
              decode(lpad(to_hex(value), 64, '0'), 'hex'),
              '2026-09-01 00:00:00.654321+00'::timestamptz,
              '2027-09-01 00:00:00.654321+00'::timestamptz
       FROM generate_series(1, 105) value`,
      [workspaceId, prefix, owner.userId],
    );
    const initialOrder = await database.query<{ id: string }>(
      `SELECT id FROM workspace_invitations
       WHERE workspace_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()
       ORDER BY created_at, id`,
      [workspaceId],
    );
    const invitationPlan = await database.transaction(async (client) => {
      await client.query('SET LOCAL enable_seqscan = off');
      return client.query<{ 'QUERY PLAN': unknown }>(
        `EXPLAIN (FORMAT JSON)
         SELECT id, workspace_id, target_email, requested_role, created_by_user_id, expires_at, created_at
         FROM workspace_invitations
         WHERE workspace_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()
           AND ($2::timestamptz IS NULL OR (created_at, id) > ($2::timestamptz, $3::uuid))
         ORDER BY created_at, id
         LIMIT 31`,
        [workspaceId, null, null],
      );
    });
    expect(JSON.stringify(invitationPlan.rows[0]['QUERY PLAN']))
      .toContain('workspace_invitations_pending_created_idx');
    const firstResponse = await request(owner, `/api/workspaces/${workspaceId}/invitations?limit=30`);
    expect(firstResponse.status).toBe(200);
    const first = await firstResponse.json() as {
      invitations: Array<Record<string, unknown> & { id: string; targetEmail: string }>;
      nextCursor?: string;
    };
    expect(first.invitations).toHaveLength(30);
    expect(first.invitations.every((entry) => !('token' in entry) && !('tokenHash' in entry))).toBe(true);
    const packedCursor = Buffer.from(first.nextCursor!, 'base64url').toString('utf8');
    expect(packedCursor).not.toContain(workspaceId);
    expect(packedCursor).not.toContain(first.invitations.at(-1)!.id);
    expect(packedCursor).not.toContain(first.invitations.at(-1)!.targetEmail);
    expect(packedCursor).not.toContain('2026-09-01');

    const revokedId = initialOrder.rows[35].id;
    await database.query('UPDATE workspace_invitations SET revoked_at = now() WHERE id = $1', [revokedId]);
    const newcomer = await database.query<{ id: string }>(
      `INSERT INTO workspace_invitations
         (workspace_id, target_email, requested_role, created_by_user_id, token_hash, created_at, expires_at)
       VALUES ($1, $2, 'member', $3, $4, '2027-01-01 00:00:00+00', '2027-09-01 00:00:00+00')
       RETURNING id`,
      [workspaceId, `${prefix}-page-new@example.invalid`, owner.userId, Buffer.alloc(32, 255)],
    );

    const seen = first.invitations.map((entry) => entry.id);
    let cursor = first.nextCursor;
    while (cursor) {
      const response = await request(
        owner,
        `/api/workspaces/${workspaceId}/invitations?limit=30&cursor=${encodeURIComponent(cursor)}`,
      );
      expect(response.status).toBe(200);
      const page = await response.json() as { invitations: Array<{ id: string }>; nextCursor?: string };
      seen.push(...page.invitations.map((entry) => entry.id));
      cursor = page.nextCursor;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).not.toContain(revokedId);
    expect(seen).toContain(newcomer.rows[0].id);
    const currentCount = await database.query<{ count: string }>(
      `SELECT count(*) FROM workspace_invitations
       WHERE workspace_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()`,
      [workspaceId],
    );
    expect(seen).toHaveLength(Number(currentCount.rows[0].count));

    expect((await request(owner, `/api/workspaces/${workspaceId}/members?cursor=${first.nextCursor}`)).status).toBe(400);
    const otherWorkspaceId = await createWorkspace(owner, 'Invitation Cursor Scope');
    expect((await request(owner, `/api/workspaces/${otherWorkspaceId}/invitations?cursor=${first.nextCursor}`)).status).toBe(400);
    const tampered = `${first.nextCursor!.slice(0, -1)}${first.nextCursor!.endsWith('A') ? 'B' : 'A'}`;
    expect((await request(owner, `/api/workspaces/${workspaceId}/invitations?cursor=${tampered}`)).status).toBe(400);
    expect((await request(owner, `/api/workspaces/${workspaceId}/invitations?limit=101`)).status).toBe(400);
  });
});
