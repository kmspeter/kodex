import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PostgresAuthRepository,
  PostgresHistoryRepository,
  ProductDatabaseConfigurationError,
  createKnowledgeRuntimeFromEnv,
  requireProductDatabaseFromEnv,
} from '@kodex/product-db';
import dotenv from 'dotenv';
import { LocalHttpServer } from './api/http-server.js';
import { parseProductApiOrigins } from './api/security.js';
import { DatabaseProductAuthorizer } from './auth/product-authorization.js';
import { RuntimeManager } from './runtime-manager.js';
import { RepositoryIndexer } from './rag/repository-indexer.js';

const repositoryRoot = process.env.KODEX_RUNTIME_ROOT
  ? path.resolve(process.env.KODEX_RUNTIME_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
if (process.env.KODEX_DISABLE_ENV_FILE !== '1') dotenv.config({ path: path.join(repositoryRoot, '.env.local'), quiet: true });

function positiveInteger(value: string | undefined, fallback: number, maximum: number, name: string): number {
  const candidate = value?.trim() ? Number(value) : fallback;
  if (!Number.isSafeInteger(candidate) || candidate <= 0 || candidate > maximum) {
    throw new Error(`${name} must be a positive integer no greater than ${maximum}.`);
  }
  return candidate;
}

const host = '127.0.0.1' as const;
const port = positiveInteger(process.env.KODEX_SERVER_PORT, 47_831, 65_535, 'KODEX_SERVER_PORT');
const productApiPort = positiveInteger(process.env.PRODUCT_API_PORT, 47_832, 65_535, 'PRODUCT_API_PORT');
const productApiOrigins = parseProductApiOrigins(
  process.env.KODEX_PRODUCT_API_ORIGINS
    ?? `http://127.0.0.1:${productApiPort},http://localhost:${productApiPort}`,
);
const allowedOrigins = new Set((process.env.KODEX_UI_ORIGINS ?? 'http://127.0.0.1:5173,http://localhost:5173,http://127.0.0.1:47831,http://localhost:47831')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean));
const uiRoot = process.env.KODEX_SERVE_UI === '1'
  ? path.resolve(process.env.KODEX_UI_ROOT || path.join(repositoryRoot, 'apps', 'ui', 'dist'))
  : undefined;

let database: ReturnType<typeof requireProductDatabaseFromEnv> | undefined;
let runtimeManager: RuntimeManager | undefined;
let server: LocalHttpServer | undefined;
let stopping = false;

async function stop(exitCode = 0): Promise<void> {
  if (stopping) return;
  stopping = true;
  try {
    await server?.close().catch(() => undefined);
    await runtimeManager?.close().catch(() => undefined);
    await database?.close().catch(() => undefined);
  } finally {
    process.exitCode = exitCode;
    if (process.connected) {
      try { process.disconnect(); } catch { /* IPC may have disconnected concurrently */ }
    }
  }
}

try {
  database = requireProductDatabaseFromEnv();
  await database.migrate();
  const authorizer = new DatabaseProductAuthorizer(new PostgresAuthRepository(database));
  const history = new PostgresHistoryRepository(database);
  const knowledgeRuntime = createKnowledgeRuntimeFromEnv(database);
  const configuredDataRoot = process.env.KODEX_DATA_ROOT
    ? path.resolve(process.env.KODEX_DATA_ROOT)
    : path.join(repositoryRoot, '.kodex-data');
  runtimeManager = new RuntimeManager({
    repositoryRoot,
    dataRoot: configuredDataRoot,
    tenantRoot: process.env.KODEX_TENANT_ROOT ? path.resolve(process.env.KODEX_TENANT_ROOT) : undefined,
    apiKey: process.env.OPENAI_API_KEY,
    localApiKey: process.env.KODEX_LOCAL_LLM_API_KEY,
    historySink: history,
    knowledgeService: knowledgeRuntime.service,
    ragConfig: knowledgeRuntime.config,
    ragLog: (event) => process.stderr.write(
      `Kodex Local Server RAG state: ${JSON.stringify(event)}\n`,
    ),
    historyOptions: {
      maxEventBytes: positiveInteger(
        process.env.KODEX_HISTORY_EVENT_MAX_BYTES, 65_536, 1_048_576,
        'KODEX_HISTORY_EVENT_MAX_BYTES',
      ),
      maxOutboxBytes: positiveInteger(
        process.env.KODEX_HISTORY_OUTBOX_MAX_BYTES, 16 * 1024 * 1024, 1024 * 1024 * 1024,
        'KODEX_HISTORY_OUTBOX_MAX_BYTES',
      ),
      maxOutboxRecords: positiveInteger(
        process.env.KODEX_HISTORY_OUTBOX_MAX_RECORDS, 10_000, 1_000_000,
        'KODEX_HISTORY_OUTBOX_MAX_RECORDS',
      ),
      retryInitialMs: positiveInteger(
        process.env.KODEX_HISTORY_RETRY_INITIAL_MS, 250, 60_000,
        'KODEX_HISTORY_RETRY_INITIAL_MS',
      ),
      retryMaximumMs: positiveInteger(
        process.env.KODEX_HISTORY_RETRY_MAX_MS, 30_000, 60 * 60_000,
        'KODEX_HISTORY_RETRY_MAX_MS',
      ),
    },
    historyLog: (event) => process.stderr.write(
      `Kodex Local Server history state: ${JSON.stringify(event)}\n`,
    ),
    maxActiveRuntimes: positiveInteger(process.env.KODEX_MAX_ACTIVE_RUNTIMES, 8, 128, 'KODEX_MAX_ACTIVE_RUNTIMES'),
    idleTimeoutMs: positiveInteger(process.env.KODEX_RUNTIME_IDLE_MS, 15 * 60_000, 24 * 60 * 60_000, 'KODEX_RUNTIME_IDLE_MS'),
    sweepIntervalMs: positiveInteger(process.env.KODEX_RUNTIME_SWEEP_MS, 60_000, 60 * 60_000, 'KODEX_RUNTIME_SWEEP_MS'),
  });
  server = new LocalHttpServer(runtimeManager, authorizer, {
    host,
    port,
    allowedOrigins,
    authorizationRevalidateMs: positiveInteger(
      process.env.KODEX_AUTH_REVALIDATE_MS,
      5 * 60_000,
      5 * 60_000,
      'KODEX_AUTH_REVALIDATE_MS',
    ),
    productApiOrigins,
    repositoryIndexer: knowledgeRuntime.service
      ? new RepositoryIndexer(knowledgeRuntime.service, Date.now, {}, [configuredDataRoot])
      : undefined,
    uiRoot,
    securityLog: (event) => process.stderr.write(`Kodex Local Server security event: ${event.kind} status=${event.status}\n`),
  });
  const actualPort = await server.listen();
  process.stdout.write(`Kodex Local Server: http://${host}:${actualPort}\n`);
  process.stdout.write(`Kodex tenant root: ${runtimeManager.tenantRoot}\n`);
  process.stdout.write(`Kodex runtime policy: max=${runtimeManager.maxActiveRuntimes}, idleMs=${runtimeManager.idleTimeoutMs}\n`);

  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => void stop());
  process.on('message', (message: unknown) => {
    if (typeof message === 'object' && message !== null && 'type' in message && message.type === 'kodex-shutdown') {
      void stop();
    }
  });
  process.once('disconnect', () => void stop());
  process.once('uncaughtException', () => {
    process.stderr.write('Kodex Local Server stopped after an uncaught internal error.\n');
    void stop(1);
  });
  process.once('unhandledRejection', () => {
    process.stderr.write('Kodex Local Server stopped after an unhandled internal error.\n');
    void stop(1);
  });
} catch (error) {
  if (error instanceof ProductDatabaseConfigurationError) {
    process.stderr.write(`Kodex Local Server configuration error: ${error.message}\n`);
  } else if (error instanceof Error && /^(?:KODEX_|authorizationRevalidateMs|maxActiveRuntimes|idleTimeoutMs|sweepIntervalMs)/u.test(error.message)) {
    process.stderr.write(`Kodex Local Server configuration error: ${error.message}\n`);
  } else {
    process.stderr.write('Kodex Local Server failed to start.\n');
  }
  await stop(1);
}
