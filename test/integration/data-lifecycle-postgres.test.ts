import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  Argon2idPasswordHasher,
  AuthService,
  DataLifecycleService,
  loadMigrations,
  PostgresAuthRepository,
  PostgresDataLifecycleRepository,
  PostgresLoginRateLimiter,
  requireProductDatabaseFromEnv,
  type AuthSessionResult,
  type ProductDatabase,
} from '@kodex/product-db';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { ProductApiConfig } from '../../apps/api/src/config.js';
import { createCsrfToken, csrfCookieName, sessionCookieName } from '../../apps/api/src/cookies.js';
import { ProductDataLifecycleWorker } from '../../apps/api/src/data-lifecycle-worker.js';
import { ProductApiServer } from '../../apps/api/src/server.js';
import { LocalHttpServer } from '../../apps/local-server/src/api/http-server.js';
import {
  createLifecycleTenantObserver,
  LocalLifecycleWorker,
} from '../../apps/local-server/src/local-lifecycle-worker.js';
import { RuntimeManager } from '../../apps/local-server/src/runtime-manager.js';

const mode = process.env.DATA_LIFECYCLE_MIGRATION_MODE === 'legacy-upgrade' ? 'legacy-upgrade' : 'fresh';
const origin = 'http://127.0.0.1:5173';
const cookieSecret = Buffer.alloc(32, 83);
const password = 'data lifecycle password';
let database: ProductDatabase;
let auth: AuthService;
let repository: PostgresDataLifecycleRepository;
let lifecycle: DataLifecycleService;
let api: ProductApiServer;
let apiBase: string;
let temporaryRoot: string;

function requestHeaders(session: AuthSessionResult): Record<string, string> {
  const csrf = createCsrfToken(session.token, cookieSecret);
  return {
    Origin: origin,
    'Content-Type': 'application/json',
    'X-CSRF-Token': csrf,
    Cookie: `${sessionCookieName}=${session.token}; ${csrfCookieName}=${csrf}`,
  };
}

function fakeRuntime() {
  return {
    initialize: async () => undefined,
    stop: async () => undefined,
  } as never;
}

beforeAll(async () => {
  database = requireProductDatabaseFromEnv();
  if (mode === 'legacy-upgrade') {
    const migrations = await loadMigrations();
    await database.transaction(async (client) => {
      await client.query(`CREATE TABLE public.schema_migrations (
        version bigint PRIMARY KEY, name text NOT NULL, checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
      for (const migration of migrations.slice(0, 11)) {
        await client.query(migration.sql);
        await client.query(
          'INSERT INTO public.schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
          [migration.version, migration.name, migration.checksum],
        );
      }
    });
  }
  const applied = await database.migrate();
  expect(applied.map((entry) => entry.version)).toEqual(
    mode === 'legacy-upgrade' ? [12] : Array.from({ length: 12 }, (_, index) => index + 1),
  );
  const hasher = new Argon2idPasswordHasher();
  auth = await AuthService.create(new PostgresAuthRepository(database), hasher, {
    loginRateLimitSecret: cookieSecret,
    loginRateLimiter: new PostgresLoginRateLimiter(database, {
      maxAttempts: 20,
      windowMs: 60_000,
      blockMs: 30_000,
    }),
  });
  repository = new PostgresDataLifecycleRepository(database);
  lifecycle = new DataLifecycleService(repository, hasher);
  const config: ProductApiConfig = {
    host: '127.0.0.1', port: 0, allowedHosts: new Set(), allowedOrigins: new Set([origin]),
    cookieSecret, secureCookies: false, sessionTtlMs: 60 * 60_000, maxBodyBytes: 65_536,
    loginRateLimitMaxAttempts: 20, loginRateLimitWindowMs: 60_000, loginRateLimitBlockMs: 30_000,
  };
  api = new ProductApiServer(
    auth,
    config,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      token: 'operations-token-for-lifecycle-test-123456',
      snapshot: async () => ({ ok: true }),
      createLegalHold: (target, reasonCode) => repository.createLegalHold(target, reasonCode),
      releaseLegalHold: (holdId) => repository.releaseLegalHold(holdId),
      retryLifecycleJob: (jobId) => repository.retryLifecycleJob(jobId),
    },
    {
      requestUserExport: (userId, sessionId, value) => lifecycle.requestUserExport(userId, sessionId, value),
      requestAccountDeletion: (userId, sessionId, value) => lifecycle.requestAccountDeletion(userId, sessionId, value),
      requestWorkspaceDeletion: (userId, sessionId, workspaceId, value) => lifecycle.requestWorkspaceDeletion(userId, sessionId, workspaceId, value),
      getJobForUser: (userId, jobId) => repository.getJobForUser(userId, jobId),
      getExportForUser: (userId, jobId) => repository.getExportForUser(userId, jobId),
    },
  );
  apiBase = `http://127.0.0.1:${await api.listen()}`;
  temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'kodex-data-lifecycle-'));
});

afterAll(async () => {
  await api?.close();
  await database?.close();
  if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
});

it(`exports bounded private JSON without credentials or vectors and isolates job reads (${mode})`, async () => {
  const first = await auth.register({ email: `export-a-${randomUUID()}@example.invalid`, password });
  const second = await auth.register({ email: `export-b-${randomUUID()}@example.invalid`, password });
  const workspaceId = first.context.memberships[0].id;
  const source = await database.query<{ id: string }>(
    `INSERT INTO knowledge_sources (workspace_id, created_by_user_id, source_type, name, status)
     VALUES ($1, $2, 'manual', 'Export source', 'ready') RETURNING id`,
    [workspaceId, first.context.user.id],
  );
  const document = await database.query<{ id: string }>(
    `INSERT INTO documents (workspace_id, created_by_user_id, source_id, source_document_id, content_text)
     VALUES ($1, $2, $3, 'export-document', 'private export content') RETURNING id`,
    [workspaceId, first.context.user.id, source.rows[0].id],
  );
  await database.query(
    `INSERT INTO document_chunks
       (workspace_id, created_by_user_id, document_id, chunk_index, content, embedding, embedding_model, embedding_dimensions)
     VALUES ($1, $2, $3, 0, 'private export content', '[0.1,0.2,0.3]', 'fixture-model', 3)`,
    [workspaceId, first.context.user.id, document.rows[0].id],
  );

  const responses = await Promise.all([1, 2].map(() => fetch(`${apiBase}/api/data-exports`, {
    method: 'POST', headers: requestHeaders(first), body: JSON.stringify({ currentPassword: password }),
  })));
  expect(responses.map((entry) => entry.status)).toEqual([202, 202]);
  const jobs = await Promise.all(responses.map((entry) => entry.json() as Promise<{ id: string }>));
  expect(new Set(jobs.map((entry) => entry.id)).size).toBe(1);

  const claims = await Promise.all([
    repository.claimProductJob('export-worker-a', 30_000),
    repository.claimProductJob('export-worker-b', 30_000),
  ]);
  expect(claims.filter(Boolean)).toHaveLength(1);
  const claimed = claims.find(Boolean)!;
  await repository.processExportJob(claimed, claims[0] ? 'export-worker-a' : 'export-worker-b', {
    exportMaxBytes: 16_777_216,
    exportMaxRowsPerCategory: 10_000,
    exportRetentionMs: 60_000,
  });
  const artifact = await repository.getExportForUser(first.context.user.id, claimed.id);
  const serialized = JSON.stringify(artifact?.document);
  expect(serialized).toContain('private export content');
  expect(serialized).not.toContain('[0.1,0.2,0.3]');
  expect(serialized).not.toContain(first.token);
  expect(serialized).not.toMatch(/password_hash|token_hash|query_embedding|"embedding"/u);
  expect(await repository.getExportForUser(second.context.user.id, claimed.id)).toBeUndefined();
  const foreignRead = await fetch(`${apiBase}/api/data-lifecycle/jobs/${claimed.id}`, {
    headers: { Cookie: requestHeaders(second).Cookie },
  });
  expect(foreignRead.status).toBe(404);
});

it(`protects operator legal-hold mutation routes and never echoes target identifiers (${mode})`, async () => {
  const account = await auth.register({ email: `hold-api-${randomUUID()}@example.invalid`, password });
  const endpoint = `${apiBase}/api/operations/legal-holds`;
  const unauthorized = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ targetType: 'user', userId: account.context.user.id, reasonCode: 'litigation' }),
  });
  expect(unauthorized.status).toBe(401);
  expect(unauthorized.headers.get('www-authenticate')).toBe('Bearer');
  expect((await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer operations-token-for-lifecycle-test-123456',
      'Content-Type': 'application/json',
      Origin: origin,
    },
    body: JSON.stringify({ targetType: 'user', userId: account.context.user.id, reasonCode: 'litigation' }),
  })).status).toBe(401);
  const created = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer operations-token-for-lifecycle-test-123456',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ targetType: 'user', userId: account.context.user.id, reasonCode: 'litigation' }),
  });
  expect(created.status).toBe(201);
  const body = await created.json() as { id: string; targetType: string };
  expect(body.targetType).toBe('user');
  expect(JSON.stringify(body)).not.toContain(account.context.user.id);
  expect((await fetch(`${endpoint}/${body.id}`, {
    method: 'DELETE',
    headers: { Authorization: 'Bearer operations-token-for-lifecycle-test-123456' },
  })).status).toBe(204);

  const failedJob = await database.query<{ id: string }>(
    `INSERT INTO data_lifecycle_jobs
       (kind, status, requested_by_user_id, target_user_id, last_error_code, completed_at)
     VALUES ('user_export', 'failed', $1, $1, 'retry_fixture', now()) RETURNING id`,
    [account.context.user.id],
  );
  const retryEndpoint = `${apiBase}/api/operations/data-lifecycle/jobs/${failedJob.rows[0].id}/retry`;
  expect((await fetch(retryEndpoint, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer operations-token-for-lifecycle-test-123456',
      Origin: origin,
    },
  })).status).toBe(401);
  expect((await fetch(retryEndpoint, {
    method: 'POST',
    headers: { Authorization: 'Bearer operations-token-for-lifecycle-test-123456' },
  })).status).toBe(202);
  expect((await database.query(
    'SELECT status, completed_at, last_error_code FROM data_lifecycle_jobs WHERE id = $1',
    [failedJob.rows[0].id],
  )).rows[0]).toMatchObject({ status: 'pending', completed_at: null, last_error_code: null });
  await database.query(
    `UPDATE data_lifecycle_jobs SET status = 'completed', completed_at = now() WHERE id = $1`,
    [failedJob.rows[0].id],
  );
  expect((await fetch(retryEndpoint, {
    method: 'POST',
    headers: { Authorization: 'Bearer operations-token-for-lifecycle-test-123456' },
  })).status).toBe(404);
});

it(`resumes expired claims and deletes only exact filesystem/database scopes with legal hold and lease safety (${mode})`, async () => {
  const owner = await auth.register({ email: `workspace-owner-${randomUUID()}@example.invalid`, password });
  const other = await auth.register({ email: `workspace-other-${randomUUID()}@example.invalid`, password });
  const workspaceId = owner.context.memberships[0].id;
  const unrelatedWorkspaceId = other.context.memberships[0].id;
  await database.query(
    `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'member')`,
    [workspaceId, other.context.user.id],
  );
  const installationId = randomUUID();
  const dataRoot = path.join(temporaryRoot, randomUUID(), 'data');
  const tenantRoot = path.join(dataRoot, 'tenants');
  const targetRoot = path.join(tenantRoot, 'users', owner.context.user.id, 'workspaces', workspaceId);
  const memberTargetRoot = path.join(tenantRoot, 'users', other.context.user.id, 'workspaces', workspaceId);
  const unrelatedRoot = path.join(tenantRoot, 'users', other.context.user.id, 'workspaces', unrelatedWorkspaceId);
  await Promise.all([targetRoot, memberTargetRoot, unrelatedRoot].map((root) => mkdir(root, { recursive: true })));
  await Promise.all([
    writeFile(path.join(targetRoot, 'settings.json'), '{}'),
    writeFile(path.join(memberTargetRoot, 'settings.json'), '{}'),
    writeFile(path.join(unrelatedRoot, 'keep.txt'), 'keep'),
  ]);
  await repository.registerLocalTenants(installationId, [
    { userId: owner.context.user.id, workspaceId },
    { userId: other.context.user.id, workspaceId },
    { userId: other.context.user.id, workspaceId: unrelatedWorkspaceId },
  ]);
  const manager = new RuntimeManager({
    repositoryRoot: path.join(temporaryRoot, randomUUID(), 'repository'),
    dataRoot,
    tenantRoot,
    createRuntime: () => fakeRuntime(),
    idleTimeoutMs: 60_000,
    sweepIntervalMs: 60_000,
  });
  const activeLease = await manager.acquire({
    userId: owner.context.user.id,
    workspaceId,
    sessionId: owner.context.sessionId,
    sessionExpiresAt: owner.context.expiresAt,
    workspaceRole: 'owner',
  });
  const userHold = await repository.createLegalHold(
    { targetType: 'user', targetUserId: other.context.user.id },
    'litigation',
  );
  await expect(lifecycle.requestWorkspaceDeletion(
    owner.context.user.id,
    owner.context.sessionId,
    workspaceId,
    { currentPassword: password, confirmationName: 'Personal Workspace', confirmation: 'DELETE WORKSPACE' },
  )).rejects.toMatchObject({ code: 'legal_hold' });
  await repository.releaseLegalHold(userHold.id);
  const deletion = await lifecycle.requestWorkspaceDeletion(
    owner.context.user.id,
    owner.context.sessionId,
    workspaceId,
    { currentPassword: password, confirmationName: 'Personal Workspace', confirmation: 'DELETE WORKSPACE' },
  );

  const guardedManager = new RuntimeManager({
    repositoryRoot: path.join(temporaryRoot, randomUUID(), 'repository'),
    dataRoot,
    tenantRoot,
    createRuntime: () => fakeRuntime(),
    tenantObserver: createLifecycleTenantObserver(repository, installationId),
  });
  const authorization = {
    sessionExpiresAt: new Date(Date.now() + 60_000),
    sessionId: owner.context.sessionId,
    sessionToken: 'cached-local-session',
    userId: owner.context.user.id,
    workspaceId,
    workspaceRole: 'owner' as const,
  };
  const localServer = new LocalHttpServer(guardedManager, {
    authorizeRequest: async () => authorization,
    reauthorize: async () => authorization,
  }, { host: '127.0.0.1', port: 0, allowedOrigins: new Set([origin]) });
  const localPort = await localServer.listen();
  try {
    const localResponse = await fetch(`http://127.0.0.1:${localPort}/api/bootstrap`, {
      headers: { Origin: origin, 'X-Kodex-Workspace-Id': workspaceId },
    });
    expect(localResponse.status).toBe(403);
    expect(await localResponse.json()).toMatchObject({ error: { code: 'tenant_deletion_pending' } });
  } finally {
    await localServer.close();
    await guardedManager.close();
  }

  const expired = await repository.claimProductJob('crashed-worker', 5_000);
  expect(expired?.id).toBe(deletion.id);
  await database.query(
    `UPDATE data_lifecycle_jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1`,
    [deletion.id],
  );
  expect((await repository.claimProductJob('restarted-worker', 30_000))?.id).toBe(deletion.id);
  await repository.retryProductJob(deletion.id, 'restarted-worker', 'restart_test', 1);

  const workspaceHold = await repository.createLegalHold(
    { targetType: 'workspace', targetWorkspaceId: workspaceId },
    'preservation',
  );
  const localWorker = new LocalLifecycleWorker(repository, manager, installationId, {
    enabled: true, intervalMs: 60_000, leaseMs: 30_000, retryMs: 1, maxTargetsPerSweep: 10,
  });
  await localWorker.runOnce();
  expect(await pathExists(targetRoot)).toBe(true);
  const productWorker = new ProductDataLifecycleWorker(repository, {
    enabled: true, intervalMs: 60_000, leaseMs: 30_000, retryMs: 1,
    exportRetentionMs: 60_000, exportMaxRowsPerCategory: 10_000,
    exportMaxBytes: 16_777_216, maxJobsPerSweep: 10,
  });
  await productWorker.runOnce();
  expect((await repository.getJobForUser(owner.context.user.id, deletion.id))?.status).toBe('blocked_legal_hold');
  await repository.releaseLegalHold(workspaceHold.id);
  await localWorker.runOnce();
  expect(await pathExists(targetRoot)).toBe(true);
  activeLease.release();
  await new Promise((resolve) => setTimeout(resolve, 10));
  await localWorker.runOnce();
  await productWorker.runOnce();
  expect(await pathExists(targetRoot)).toBe(false);
  expect(await pathExists(memberTargetRoot)).toBe(false);
  expect(await pathExists(unrelatedRoot)).toBe(true);
  expect((await database.query('SELECT 1 FROM workspaces WHERE id = $1', [workspaceId])).rowCount).toBe(0);
  expect((await database.query('SELECT 1 FROM workspaces WHERE id = $1', [unrelatedWorkspaceId])).rowCount).toBe(1);
  expect((await database.query(
    `SELECT 1 FROM data_legal_holds WHERE target_workspace_id = $1`,
    [workspaceId],
  )).rowCount).toBe(0);

  await mkdir(targetRoot, { recursive: true });
  await writeFile(path.join(targetRoot, 'restored-after-deletion.txt'), 'restore fixture');
  expect(await repository.registerLocalTenants(installationId, [{
    userId: owner.context.user.id,
    workspaceId,
  }], true)).toBe(1);
  expect((await repository.getJobForUser(owner.context.user.id, deletion.id))?.status).toBe('waiting_local');
  await localWorker.runOnce();
  await productWorker.runOnce();
  expect(await pathExists(targetRoot)).toBe(false);
  expect((await repository.getJobForUser(owner.context.user.id, deletion.id))?.status).toBe('completed');
  await manager.close();
});

it(`blocks access immediately and permanently removes an account without crossing shared tenants (${mode})`, async () => {
  const keeper = await auth.register({ email: `account-keeper-${randomUUID()}@example.invalid`, password });
  const deleting = await auth.register({ email: `account-delete-${randomUUID()}@example.invalid`, password });
  const sharedWorkspaceId = keeper.context.memberships[0].id;
  await database.query(
    `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'member')`,
    [sharedWorkspaceId, deleting.context.user.id],
  );
  const privateProject = await database.query<{ id: string }>(
    `INSERT INTO projects (workspace_id, created_by_user_id, name, external_key)
     VALUES ($1, $2, 'Deleting private project', $3) RETURNING id`,
    [sharedWorkspaceId, deleting.context.user.id, `delete-${randomUUID()}`],
  );
  await database.query(
    `INSERT INTO agent_threads
       (workspace_id, project_id, created_by_user_id, codex_thread_id)
     VALUES ($1, $2, $3, $4)`,
    [sharedWorkspaceId, privateProject.rows[0].id, deleting.context.user.id, `delete-thread-${randomUUID()}`],
  );
  await expect(database.query(
    `INSERT INTO agent_threads
       (workspace_id, project_id, created_by_user_id, codex_thread_id)
     VALUES ($1, $2, $3, $4)`,
    [sharedWorkspaceId, privateProject.rows[0].id, keeper.context.user.id, `cross-tenant-${randomUUID()}`],
  )).rejects.toMatchObject({ constraint: 'agent_threads_lifecycle_project_owner_scope_fk' });
  const releasedHold = await repository.createLegalHold(
    { targetType: 'user', targetUserId: deleting.context.user.id },
    'completed_request',
  );
  await repository.releaseLegalHold(releasedHold.id);
  const response = await fetch(`${apiBase}/api/auth/account`, {
    method: 'DELETE',
    headers: requestHeaders(deleting),
    body: JSON.stringify({ currentPassword: password, confirmation: 'DELETE MY ACCOUNT' }),
  });
  expect(response.status).toBe(202);
  const deletionJob = await response.json() as { id: string };
  expect((await fetch(`${apiBase}/api/auth/me`, {
    headers: { Cookie: requestHeaders(deleting).Cookie },
  })).status).toBe(401);
  const productWorker = new ProductDataLifecycleWorker(repository, {
    enabled: true, intervalMs: 60_000, leaseMs: 30_000, retryMs: 1,
    exportRetentionMs: 60_000, exportMaxRowsPerCategory: 10_000,
    exportMaxBytes: 16_777_216, maxJobsPerSweep: 10,
  });
  await productWorker.runOnce();
  expect((await database.query('SELECT 1 FROM users WHERE id = $1', [deleting.context.user.id])).rowCount).toBe(0);
  expect((await database.query('SELECT 1 FROM workspaces WHERE id = $1', [sharedWorkspaceId])).rowCount).toBe(1);
  expect((await database.query('SELECT 1 FROM agent_threads WHERE created_by_user_id = $1', [deleting.context.user.id])).rowCount).toBe(0);
  expect((await database.query('SELECT 1 FROM users WHERE id = $1', [keeper.context.user.id])).rowCount).toBe(1);
  expect((await database.query(
    `SELECT 1 FROM data_legal_holds WHERE target_user_id = $1`,
    [deleting.context.user.id],
  )).rowCount).toBe(0);
  expect((await database.query(
    `SELECT 1 FROM audit_logs WHERE actor_user_id = $1
       OR (target_type IN ('account', 'user', 'workspace_member') AND target_id = $1::text)`,
    [deleting.context.user.id],
  )).rowCount).toBe(0);
  expect((await database.query('SELECT status FROM data_lifecycle_jobs WHERE id = $1', [deletionJob.id])).rows[0].status).toBe('completed');
});

async function pathExists(filename: string): Promise<boolean> {
  try {
    await stat(filename);
    return true;
  } catch {
    return false;
  }
}
