import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  Argon2idPasswordHasher,
  AuthService,
  createProductDatabase,
  KnowledgeService,
  PostgresAuthRepository,
  PostgresHistoryRepository,
  PostgresKnowledgeRepository,
  PostgresLoginRateLimiter,
} from '@kodex/product-db';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  createOfflineBackup,
  restoreOfflineBackup,
  verifyOfflineBackup,
} from '../../scripts/lib/offline-backup.mjs';

const sourceUrl = process.env.KODEX_BACKUP_TEST_SOURCE_URL;
const targetUrl = process.env.KODEX_BACKUP_TEST_TARGET_URL;
const sourceContainer = process.env.KODEX_BACKUP_TEST_SOURCE_CONTAINER;
const targetContainer = process.env.KODEX_BACKUP_TEST_TARGET_CONTAINER;
if (!sourceUrl || !targetUrl || !sourceContainer || !targetContainer) {
  throw new Error('Backup/restore acceptance requires isolated source and target PostgreSQL settings.');
}

const root = path.join(os.tmpdir(), `kodex-backup-restore-${randomUUID()}`);
await mkdir(root, { recursive: true });
const sourceDataRoot = path.join(root, 'source-data');
const restoredDataRoot = path.join(root, 'restored-data');
const backupRoot = path.join(root, 'backup');
const sourceDatabase = createProductDatabase({ connectionString: sourceUrl, ssl: false });
const targetDatabase = createProductDatabase({ connectionString: targetUrl, ssl: false });

function loginLimiter(database) {
  return new PostgresLoginRateLimiter(database, {
    blockMs: 30_000,
    maxAttempts: 5,
    windowMs: 60_000,
  });
}

async function authService(database) {
  return AuthService.create(new PostgresAuthRepository(database), new Argon2idPasswordHasher(), {
    loginRateLimiter: loginLimiter(database),
    loginRateLimitSecret: Buffer.alloc(32, 31),
  });
}

beforeAll(async () => {
  await sourceDatabase.migrate();
  await mkdir(sourceDataRoot, { recursive: true });
});

afterAll(async () => {
  await Promise.all([sourceDatabase.close(), targetDatabase.close()]);
  await rm(root, { recursive: true, force: true });
});

it('restores auth, workspace, History, RAG, and pending tenant outbox from a verified offline backup', async () => {
  const email = `restore-${randomUUID()}@example.com`;
  const password = 'Correct horse battery staple 2026!';
  const auth = await authService(sourceDatabase);
  const registration = await auth.register({ email, password, displayName: 'Restore Drill' });
  const workspace = registration.defaultWorkspace;
  if (!workspace) throw new Error('Registration did not create a personal workspace.');
  const scope = { userId: registration.context.user.id, workspaceId: workspace.id };

  const threadId = randomUUID();
  await new PostgresHistoryRepository(sourceDatabase).ingest(scope, {
    version: 1,
    sourceInstance: `backup-restore:${scope.workspaceId}:${scope.userId}`,
    eventId: `thread:${threadId}:snapshot`,
    eventType: 'thread.snapshot',
    occurredAt: '2026-09-04T00:00:00.000Z',
    project: { externalKey: 'backup-restore-project', name: 'Restore project', metadata: {} },
    thread: {
      codexThreadId: threadId,
      status: 'active',
      title: 'Restored history',
      sourceUpdatedAt: '2026-09-04T00:00:00.000Z',
      projectIsAuthoritative: true,
    },
    payload: { provenance: 'restore-drill' },
  });

  const knowledge = new KnowledgeService(
    new PostgresKnowledgeRepository(sourceDatabase),
    {
      dimensions: 3,
      model: 'restore-drill-embedding',
      embed: async (inputs) => inputs.map(() => [1, 0, 0]),
    },
    {
      automationsEnabled: false,
      chunking: { chunkCharacters: 64, overlapCharacters: 8 },
      contextMaxCharacters: 1_024,
      defaultThreshold: 0,
      defaultTopK: 3,
      enabled: true,
      maxDocumentCharacters: 4_096,
      maxQueryCharacters: 1_024,
      maxTopK: 10,
    },
  );
  await knowledge.indexTextDocument(scope, {
    content: 'A restored private knowledge document for the disaster recovery drill.',
    title: 'Restore drill knowledge',
  });

  const tenantRoot = path.join(sourceDataRoot, 'tenants', 'users', scope.userId, 'workspaces', scope.workspaceId);
  const outboxRoot = path.join(tenantRoot, 'product-history-outbox');
  await mkdir(outboxRoot, { recursive: true });
  await writeFile(path.join(tenantRoot, 'settings.json'), '{"sidebarOpen":true}\n', 'utf8');
  await writeFile(
    path.join(outboxRoot, '00000000000000000001-0123456789abcdef.json'),
    '{"version":1,"eventId":"pending-after-backup"}\n',
    'utf8',
  );

  const activeLock = path.join(tenantRoot, 'instance.lock');
  await writeFile(activeLock, '{}\n', 'utf8');
  await expect(createOfflineBackup({
    applicationVersion: '0.2.0',
    commit: 'd01c10e18beb8e446e617a60e02935d96586152b',
    dataRoot: sourceDataRoot,
    database: sourceDatabase,
    databaseContainer: sourceContainer,
    databaseUrl: sourceUrl,
    output: backupRoot,
    sslMode: 'disable',
  })).rejects.toThrow('instance lock');
  await rm(activeLock);
  const startIntent = path.join(sourceDataRoot, `.kodex-runtime-start.${randomUUID()}.lock`);
  await writeFile(startIntent, '', 'utf8');
  await expect(createOfflineBackup({
    applicationVersion: '0.2.0',
    dataRoot: sourceDataRoot,
    database: sourceDatabase,
    databaseContainer: sourceContainer,
    databaseUrl: sourceUrl,
    output: backupRoot,
  })).rejects.toThrow('instance lock');
  await rm(startIntent);

  const created = await createOfflineBackup({
    applicationVersion: '0.2.0',
    commit: 'd01c10e18beb8e446e617a60e02935d96586152b',
    dataRoot: sourceDataRoot,
    database: sourceDatabase,
    databaseContainer: sourceContainer,
    databaseUrl: sourceUrl,
    output: backupRoot,
    sslMode: 'disable',
  });
  expect(created.manifest.database.migrations.at(-1)?.version).toBe(11);
  expect(created.manifest.tenantData.fileCount).toBe(2);
  expect((await verifyOfflineBackup(backupRoot)).database.sha256).toBe(created.manifest.database.sha256);

  const restored = await restoreOfflineBackup({
    dataRoot: restoredDataRoot,
    database: targetDatabase,
    databaseContainer: targetContainer,
    databaseUrl: targetUrl,
    input: backupRoot,
    sslMode: 'disable',
  });
  expect(restored.manifest.tenantData).toEqual(created.manifest.tenantData);

  const restoredAuth = await authService(targetDatabase);
  const login = await restoredAuth.login({ email, password }, { directAddress: '127.0.0.1' });
  expect(login.context.user.email).toBe(email);
  const restoredHistory = await new PostgresHistoryRepository(targetDatabase).listThreads(scope, { limit: 10 });
  expect(restoredHistory.threads.map((thread) => thread.id)).toContain(threadId);
  const restoredDocuments = await new KnowledgeService(
    new PostgresKnowledgeRepository(targetDatabase),
    { dimensions: 3, model: 'restore-drill-embedding', embed: async (inputs) => inputs.map(() => [1, 0, 0]) },
    knowledge.config,
  ).listDocuments(scope, { limit: 10 });
  expect(restoredDocuments.data.map((document) => document.title)).toContain('Restore drill knowledge');
  expect(await readFile(
    path.join(restoredDataRoot, 'tenants', 'users', scope.userId, 'workspaces', scope.workspaceId,
      'product-history-outbox', '00000000000000000001-0123456789abcdef.json'),
    'utf8',
  )).toContain('pending-after-backup');

  await expect(restoreOfflineBackup({
    dataRoot: restoredDataRoot,
    database: targetDatabase,
    databaseContainer: targetContainer,
    databaseUrl: targetUrl,
    input: backupRoot,
  })).rejects.toThrow('new KODEX_DATA_ROOT');

  await writeFile(path.join(backupRoot, 'tenant-data', 'unlisted.txt'), 'not in manifest\n', 'utf8');
  await expect(verifyOfflineBackup(backupRoot)).rejects.toThrow('unlisted');
  await rm(path.join(backupRoot, 'tenant-data', 'unlisted.txt'));
  await writeFile(path.join(backupRoot, 'tenant-data', 'tenants', 'users', scope.userId, 'workspaces', scope.workspaceId, 'settings.json'), '{}\n', 'utf8');
  await expect(verifyOfflineBackup(backupRoot)).rejects.toThrow('checksum');
});
