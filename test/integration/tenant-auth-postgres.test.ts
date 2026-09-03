import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PRODUCT_SESSION_COOKIE_NAME, PRODUCT_WORKSPACE_HEADER_NAME } from '@kodex/product-contract';
import {
  Argon2idPasswordHasher,
  hashSessionToken,
  PostgresAuthRepository,
  requireProductDatabaseFromEnv,
  type ProductDatabase,
} from '@kodex/product-db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { LocalHttpServer } from '../../apps/local-server/src/api/http-server';
import { DatabaseProductAuthorizer, type RuntimeScope } from '../../apps/local-server/src/auth/product-authorization';
import { KodexRuntime } from '../../apps/local-server/src/runtime';
import { RuntimeCapacityError, RuntimeManager } from '../../apps/local-server/src/runtime-manager';

const origin = 'http://127.0.0.1:5173';
const runPrefix = `tenant-it-${randomUUID()}`;

function token(): string {
  return randomBytes(32).toString('base64url');
}

function productCookie(value: string): string {
  return `${PRODUCT_SESSION_COOKIE_NAME}=${value}`;
}

function waitForMessage(messages: Array<Record<string, unknown>>, type: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 5_000;
    const inspect = () => {
      const message = messages.find((entry) => entry.type === type);
      if (message) { resolve(message); return; }
      if (Date.now() >= deadline) { reject(new Error(`Timed out waiting for ${type}`)); return; }
      setTimeout(inspect, 10);
    };
    inspect();
  });
}

describe('PostgreSQL-backed Local Server tenant authorization', () => {
  let database: ProductDatabase;
  let repository: PostgresAuthRepository;
  let manager: RuntimeManager;
  let server: LocalHttpServer;
  let root: string;
  let baseUrl: string;
  let port: number;
  let userA: string;
  let userB: string;
  let workspaceA: string;
  let workspaceB: string;
  let sharedWorkspace: string;
  let viewerWorkspace: string;
  let sessionIdA: string;
  let sessionIdB: string;
  let passwordHashA: string;
  const tokenA = token();
  const tokenB = token();
  const expiredToken = token();
  const revokedToken = token();
  let creations = 0;

  beforeAll(async () => {
    database = requireProductDatabaseFromEnv();
    await database.migrate();
    repository = new PostgresAuthRepository(database);
    const passwordHash = await new Argon2idPasswordHasher().hash('integration-only-password');
    passwordHashA = passwordHash;
    const expiresAt = new Date(Date.now() + 60 * 60_000);
    const accountA = await repository.registerAccount({
      email: `${runPrefix}-a@example.invalid`, displayName: null, passwordHash,
      workspaceName: 'A', workspaceSlug: `${runPrefix}-a`,
      sessionTokenHash: hashSessionToken(tokenA), sessionExpiresAt: expiresAt,
    });
    const accountB = await repository.registerAccount({
      email: `${runPrefix}-b@example.invalid`, displayName: null, passwordHash,
      workspaceName: 'B', workspaceSlug: `${runPrefix}-b`,
      sessionTokenHash: hashSessionToken(tokenB), sessionExpiresAt: expiresAt,
    });
    userA = accountA.context.user.id;
    userB = accountB.context.user.id;
    sessionIdA = accountA.context.sessionId;
    sessionIdB = accountB.context.sessionId;
    workspaceA = accountA.defaultWorkspace.id;
    workspaceB = accountB.defaultWorkspace.id;

    const shared = await database.query<{ id: string }>(
      `INSERT INTO workspaces (slug, name, owner_user_id)
       VALUES ($1, 'Shared test workspace', $2)
       RETURNING id`,
      [`${runPrefix}-shared`, userA],
    );
    sharedWorkspace = shared.rows[0].id;
    await database.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role)
       VALUES ($1, $2, 'owner'), ($1, $3, 'member')`,
      [sharedWorkspace, userA, userB],
    );
    const viewerOnly = await database.query<{ id: string }>(
      `INSERT INTO workspaces (slug, name, owner_user_id)
       VALUES ($1, 'Viewer-only test workspace', $2)
       RETURNING id`,
      [`${runPrefix}-viewer`, userA],
    );
    viewerWorkspace = viewerOnly.rows[0].id;
    await database.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role)
       VALUES ($1, $2, 'owner'), ($1, $3, 'viewer')`,
      [viewerWorkspace, userA, userB],
    );
    await database.query(
      `INSERT INTO auth_sessions (user_id, token_hash, expires_at)
       VALUES ($1, $2, now() + interval '1 hour'), ($1, $3, now() + interval '1 hour')`,
      [userA, hashSessionToken(expiredToken), hashSessionToken(revokedToken)],
    );
    await database.query(
      `UPDATE auth_sessions
       SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour'
       WHERE token_hash = $1`,
      [hashSessionToken(expiredToken)],
    );
    await database.query(
      `UPDATE auth_sessions SET revoked_at = now() WHERE token_hash = $1`,
      [hashSessionToken(revokedToken)],
    );

    root = await mkdtemp(path.join(os.tmpdir(), 'kodex-pg-tenant-'));
    manager = new RuntimeManager({
      repositoryRoot: root,
      dataRoot: path.join(root, 'data'),
      tenantRoot: path.join(root, 'data', 'tenants'),
      maxActiveRuntimes: 8,
      idleTimeoutMs: 50,
      sweepIntervalMs: 60_000,
      createRuntime: (_scope, dataRoot) => {
        creations += 1;
        return new KodexRuntime(root, undefined, { dataRoot, startAppServer: false });
      },
    });
    server = new LocalHttpServer(manager, new DatabaseProductAuthorizer(repository), {
      host: '127.0.0.1', port: 0, allowedOrigins: new Set([origin]), authorizationRevalidateMs: 50,
    });
    port = await server.listen();
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await server?.close();
    await manager?.close();
    if (root) await rm(root, { recursive: true, force: true });
    if (database) {
      await database.query('DELETE FROM workspaces WHERE slug LIKE $1', [`${runPrefix}-%`]);
      await database.query('DELETE FROM users WHERE email LIKE $1', [`${runPrefix}-%`]);
      await database.close();
    }
  });

  async function localRequest(sessionToken: string | undefined, workspaceId: string | undefined): Promise<Response> {
    const headers = new Headers({ Origin: origin });
    if (sessionToken) headers.set('Cookie', productCookie(sessionToken));
    if (workspaceId) headers.set(PRODUCT_WORKSPACE_HEADER_NAME, workspaceId);
    return fetch(`${baseUrl}/api/bootstrap`, { headers });
  }

  async function bootstrap(sessionToken: string, workspaceId: string) {
    const response = await localRequest(sessionToken, workspaceId);
    const body = await response.json() as { sessionToken: string };
    return { body, response };
  }

  async function socket(sessionToken: string, workspaceId: string, localSession: string) {
    const webSocket = new WebSocket(`ws://127.0.0.1:${port}/ws?workspace_id=${workspaceId}`, ['kodex', localSession], {
      origin,
      headers: { Cookie: productCookie(sessionToken) },
    });
    const messages: Array<Record<string, unknown>> = [];
    webSocket.on('message', (raw) => messages.push(JSON.parse(raw.toString()) as Record<string, unknown>));
    const hello = await waitForMessage(messages, 'hello');
    webSocket.send(JSON.stringify({ type: 'replay', epoch: hello.epoch, afterSequence: hello.latestSequence }));
    return { messages, webSocket };
  }

  it('rejects missing, expired, revoked, and non-member sessions before resolving a runtime', async () => {
    expect((await localRequest(undefined, workspaceA)).status).toBe(401);
    expect((await localRequest(expiredToken, workspaceA)).status).toBe(401);
    expect((await localRequest(revokedToken, workspaceA)).status).toBe(401);
    expect((await localRequest(tokenA, workspaceB)).status).toBe(403);
    expect((await localRequest(tokenB, viewerWorkspace)).status).toBe(403);
    expect((await localRequest(tokenA, undefined)).status).toBe(403);
  });

  it('uses separate user/workspace roots, including two users in one shared workspace, and deduplicates creation', async () => {
    expect((await localRequest(tokenA, workspaceA)).status).toBe(200);
    expect((await localRequest(tokenA, sharedWorkspace)).status).toBe(200);
    expect((await localRequest(tokenB, sharedWorkspace)).status).toBe(200);
    const roots = manager.inspect().map((entry) => entry.root);
    expect(roots).toContain(path.join(root, 'data', 'tenants', 'users', userA, 'workspaces', sharedWorkspace));
    expect(roots).toContain(path.join(root, 'data', 'tenants', 'users', userB, 'workspaces', sharedWorkspace));

    const scope: RuntimeScope = {
      userId: userB, workspaceId: workspaceB,
      sessionId: (await repository.findAuthContext(hashSessionToken(tokenB)))!.sessionId,
      sessionExpiresAt: new Date(Date.now() + 60_000), workspaceRole: 'owner',
    };
    const before = creations;
    const [first, second] = await Promise.all([manager.acquire(scope), manager.acquire(scope)]);
    expect(creations - before).toBe(1);
    expect(first.runtime).toBe(second.runtime);
    first.release();
    second.release();
  });

  it('blocks WS cross-tenant upgrades, isolates events, and revalidates password/session revocation', async () => {
    const establishedA = await bootstrap(tokenA, workspaceA);
    const establishedB = await bootstrap(tokenB, workspaceB);
    const establishedSharedB = await bootstrap(tokenB, sharedWorkspace);
    const denied = new Promise<number>((resolve, reject) => {
      const attempted = new WebSocket(`ws://127.0.0.1:${port}/ws?workspace_id=${workspaceB}`, ['kodex', establishedA.body.sessionToken], {
        origin,
        headers: { Cookie: productCookie(tokenA) },
      });
      attempted.once('unexpected-response', (_request, response) => resolve(response.statusCode ?? 0));
      attempted.once('open', () => reject(new Error('Cross-tenant WebSocket unexpectedly opened')));
      attempted.once('error', () => undefined);
    });
    await expect(denied).resolves.toBe(403);

    const viewerDenied = new Promise<number>((resolve, reject) => {
      const attempted = new WebSocket(`ws://127.0.0.1:${port}/ws?workspace_id=${viewerWorkspace}`, ['kodex', establishedB.body.sessionToken], {
        origin,
        headers: { Cookie: productCookie(tokenB) },
      });
      attempted.once('unexpected-response', (_request, response) => resolve(response.statusCode ?? 0));
      attempted.once('open', () => reject(new Error('Viewer WebSocket unexpectedly opened')));
      attempted.once('error', () => undefined);
    });
    await expect(viewerDenied).resolves.toBe(403);

    const socketA = await socket(tokenA, workspaceA, establishedA.body.sessionToken);
    const socketB = await socket(tokenB, workspaceB, establishedB.body.sessionToken);
    const sharedSocketB = await socket(tokenB, sharedWorkspace, establishedSharedB.body.sessionToken);
    const otherTokenA = token();
    await repository.createSession({
      userId: userA,
      credentialHash: passwordHashA,
      tokenHash: hashSessionToken(otherTokenA),
      expiresAt: new Date(Date.now() + 60 * 60_000),
    });
    const establishedOtherA = await bootstrap(otherTokenA, workspaceA);
    const otherSocketA = await socket(otherTokenA, workspaceA, establishedOtherA.body.sessionToken);
    try {
      const authA = (await repository.findAuthContext(hashSessionToken(tokenA)))!;
      const lease = await manager.acquire({
        userId: userA, workspaceId: workspaceA, sessionId: authA.sessionId,
        sessionExpiresAt: authA.expiresAt, workspaceRole: 'owner',
      });
      lease.runtime.emit({ type: 'engine', engine: lease.runtime.appServer.status() });
      lease.release();
      await waitForMessage(socketA.messages, 'engine');
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(socketB.messages.some((message) => message.type === 'engine')).toBe(false);

      const passwordRevoked = new Promise<number>((resolve) => otherSocketA.webSocket.once('close', (code) => resolve(code)));
      const hasher = new Argon2idPasswordHasher();
      await repository.changePassword({
        userId: userA,
        currentSessionId: sessionIdA,
        nextPasswordHash: await hasher.hash('integration-password-after-change'),
        verifyCurrentPassword: (storedHash) => hasher.verify(storedHash, 'integration-only-password'),
      });
      await expect(passwordRevoked).resolves.toBe(1008);
      expect((await localRequest(otherTokenA, workspaceA)).status).toBe(401);
      expect((await localRequest(tokenA, workspaceA)).status).toBe(200);
      expect(socketA.webSocket.readyState).toBe(WebSocket.OPEN);

      const closed = new Promise<number>((resolve) => socketA.webSocket.once('close', (code) => resolve(code)));
      await repository.revokeSessionById(userA, sessionIdA, sessionIdA);
      await expect(closed).resolves.toBe(1008);
      expect(socketB.webSocket.readyState).toBe(WebSocket.OPEN);

      const membershipClosed = new Promise<number>((resolve) => socketB.webSocket.once('close', (code) => resolve(code)));
      await database.query(
        'DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
        [workspaceB, userB],
      );
      await expect(membershipClosed).resolves.toBe(1008);

      const downgradedClosed = new Promise<number>((resolve) => sharedSocketB.webSocket.once('close', (code) => resolve(code)));
      await database.query(
        `UPDATE workspace_members SET role = 'viewer', updated_at = now()
         WHERE workspace_id = $1 AND user_id = $2`,
        [sharedWorkspace, userB],
      );
      await expect(downgradedClosed).resolves.toBe(1008);
      expect((await localRequest(tokenB, sharedWorkspace)).status).toBe(403);
      await database.query(
        `UPDATE workspace_members SET role = 'member', updated_at = now()
         WHERE workspace_id = $1 AND user_id = $2`,
        [sharedWorkspace, userB],
      );
    } finally {
      socketA.webSocket.close();
      otherSocketA.webSocket.close();
      socketB.webSocket.close();
      sharedSocketB.webSocket.close();
    }
  });

  it('evicts released runtimes after the configured idle timeout', async () => {
    await new Promise((resolve) => setTimeout(resolve, 60));
    const before = manager.inspect().length;
    expect(before).toBeGreaterThan(0);
    await expect(manager.evictIdle()).resolves.toBeGreaterThan(0);
    expect(manager.inspect().length).toBeLessThan(before);
  });

  it('enforces the runtime limit without evicting an active lease, then cleans the released runtime', async () => {
    let now = 10_000;
    const limited = new RuntimeManager({
      repositoryRoot: root,
      dataRoot: path.join(root, 'limited-data'),
      tenantRoot: path.join(root, 'limited-data', 'tenants'),
      maxActiveRuntimes: 1,
      idleTimeoutMs: 10,
      sweepIntervalMs: 60_000,
      clock: () => now,
      runtimeOptions: { startAppServer: false },
    });
    const scopeA: RuntimeScope = {
      userId: userA, workspaceId: sharedWorkspace, sessionId: sessionIdA,
      sessionExpiresAt: new Date(Date.now() + 60_000), workspaceRole: 'owner',
    };
    const scopeB: RuntimeScope = {
      userId: userB, workspaceId: sharedWorkspace, sessionId: sessionIdB,
      sessionExpiresAt: new Date(Date.now() + 60_000), workspaceRole: 'member',
    };
    try {
      const active = await limited.acquire(scopeA);
      await expect(limited.acquire(scopeB)).rejects.toBeInstanceOf(RuntimeCapacityError);
      active.release();
      now += 1;
      const replacement = await limited.acquire(scopeB);
      expect(limited.inspect()).toHaveLength(1);
      replacement.release();
      now += 11;
      await expect(limited.evictIdle(now)).resolves.toBe(1);
      expect(limited.inspect()).toHaveLength(0);
    } finally {
      await limited.close();
    }
  });
});
