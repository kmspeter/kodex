import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Argon2idPasswordHasher,
  AuthService,
  PostgresAbuseRateLimiter,
  PostgresAuthRepository,
  PostgresHistoryRepository,
  PostgresDataLifecycleRepository,
  PostgresLoginRateLimiter,
  PostgresPasswordResetRepository,
  PostgresEmailVerificationRepository,
  PostgresEmailDeliveryRepository,
  PostgresRetentionRepository,
  PostgresWorkspaceRepository,
  ProductDatabaseConfigurationError,
  createKnowledgeRuntimeFromEnv,
  bootstrapProductDatabase,
  PasswordResetService,
  EmailVerificationService,
  DataLifecycleService,
} from '@kodex/product-db';
import { operationsBearerTokenFromEnv } from '@kodex/shared';
import dotenv from 'dotenv';
import {
  ProductApiConfigurationError,
  productApiConfigFromEnv,
  productRetentionMaintenanceConfigFromEnv,
  validateKnowledgeBodyCapacity,
} from './config.js';
import {
  ProductRetentionMaintenance,
  type RetentionMaintenanceLogEvent,
} from './retention-maintenance.js';
import { ProductApiServer } from './server.js';
import { loadProductReleaseIdentity } from './release-identity.js';
import {
  passwordResetDeliveryConfigFromEnv,
  WebhookPasswordResetDelivery,
} from './password-reset-delivery.js';
import { ProductOperationalTelemetry } from './operational-status.js';
import { emailDeliveryConfigFromEnv, WebhookEmailDelivery } from './email-delivery.js';
import { EmailDeliveryWorker, type EmailDeliveryLogEvent } from './email-delivery-worker.js';
import {
  ProductDataLifecycleWorker,
  productDataLifecycleConfigFromEnv,
  type ProductDataLifecycleLogEvent,
} from './data-lifecycle-worker.js';

const repositoryRoot = process.env.KODEX_RUNTIME_ROOT
  ? path.resolve(process.env.KODEX_RUNTIME_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
if (process.env.KODEX_DISABLE_ENV_FILE !== '1') {
  dotenv.config({ path: path.join(repositoryRoot, '.env.local'), quiet: true });
}

let database: Awaited<ReturnType<typeof bootstrapProductDatabase>> | undefined;
let server: ProductApiServer | undefined;
let retentionMaintenance: ProductRetentionMaintenance | undefined;
let dataLifecycleWorker: ProductDataLifecycleWorker | undefined;
let emailDeliveryWorker: EmailDeliveryWorker | undefined;
let stopping = false;

function logRetentionMaintenance(event: RetentionMaintenanceLogEvent): void {
  const output = `${JSON.stringify(event)}\n`;
  if (event.outcome === 'failed') process.stderr.write(output);
  else process.stdout.write(output);
}

function logDataLifecycle(event: ProductDataLifecycleLogEvent): void {
  const output = `${JSON.stringify(event)}\n`;
  if (event.outcome === 'failed' || event.outcome === 'retry') process.stderr.write(output);
  else process.stdout.write(output);
}

function logEmailDelivery(event: EmailDeliveryLogEvent): void {
  const output = `${JSON.stringify(event)}\n`;
  if (event.outcome === 'failed' || event.outcome === 'retry') process.stderr.write(output);
  else process.stdout.write(output);
}

async function stop(exitCode = 0): Promise<void> {
  if (stopping) {
    return;
  }
  stopping = true;
  try {
    await emailDeliveryWorker?.stop().catch(() => undefined);
    await dataLifecycleWorker?.stop().catch(() => undefined);
    await retentionMaintenance?.stop().catch(() => undefined);
    await server?.close().catch(() => undefined);
    await database?.close().catch(() => undefined);
  } finally {
    process.exitCode = exitCode;
    if (process.connected) {
      try { process.disconnect(); } catch { /* IPC may have disconnected concurrently */ }
    }
  }
}

try {
  const config = productApiConfigFromEnv();
  const release = await loadProductReleaseIdentity(repositoryRoot);
  const retentionConfig = productRetentionMaintenanceConfigFromEnv();
  const dataLifecycleConfig = productDataLifecycleConfigFromEnv();
  const passwordResetConfig = passwordResetDeliveryConfigFromEnv();
  const emailDeliveryConfig = emailDeliveryConfigFromEnv();
  const operationsToken = operationsBearerTokenFromEnv(
    process.env.PRODUCT_OPERATIONS_BEARER_TOKEN,
    'PRODUCT_OPERATIONS_BEARER_TOKEN',
  );
  database = await bootstrapProductDatabase();
  const repository = new PostgresAuthRepository(database);
  const passwordHasher = new Argon2idPasswordHasher();
  const lifecycleRepository = new PostgresDataLifecycleRepository(database);
  const lifecycleService = new DataLifecycleService(lifecycleRepository, passwordHasher);
  if (!config.abuseRateLimitPolicies) throw new ProductApiConfigurationError('Abuse rate limit policies are required');
  const abuseRateLimiter = new PostgresAbuseRateLimiter(
    database,
    config.cookieSecret,
    config.abuseRateLimitPolicies,
  );
  const auth = await AuthService.create(repository, passwordHasher, {
    abuseRateLimiter,
    sessionTtlMs: config.sessionTtlMs,
    loginRateLimitSecret: config.cookieSecret,
    loginRateLimiter: new PostgresLoginRateLimiter(database, {
      maxAttempts: config.loginRateLimitMaxAttempts,
      windowMs: config.loginRateLimitWindowMs,
      blockMs: config.loginRateLimitBlockMs,
    }),
    requireEmailVerification: Boolean(emailDeliveryConfig),
  });
  const knowledgeRuntime = createKnowledgeRuntimeFromEnv(database);
  const passwordReset = passwordResetConfig
    ? new PasswordResetService(
      new PostgresPasswordResetRepository(database),
      passwordHasher,
      new WebhookPasswordResetDelivery(passwordResetConfig),
      abuseRateLimiter,
      { ttlMs: passwordResetConfig.ttlMs },
    )
    : undefined;
  const emailVerification = emailDeliveryConfig
    ? new EmailVerificationService(
      new PostgresEmailVerificationRepository(database),
      abuseRateLimiter,
    )
    : undefined;
  emailDeliveryWorker = emailDeliveryConfig
    ? new EmailDeliveryWorker(
      new PostgresEmailDeliveryRepository(database),
      new WebhookEmailDelivery(emailDeliveryConfig),
      emailDeliveryConfig,
      logEmailDelivery,
    )
    : undefined;
  validateKnowledgeBodyCapacity(config, knowledgeRuntime.config);
  const readiness = { check: async () => { await database!.query('SELECT 1'); } };
  retentionMaintenance = new ProductRetentionMaintenance(
    new PostgresRetentionRepository(database),
    {
      ...retentionConfig,
      rateLimitStaleMs: Math.max(
        config.loginRateLimitWindowMs,
        config.loginRateLimitBlockMs,
      ) * 2,
      abuseRateLimitStaleMs: Math.max(
        ...Object.values(config.abuseRateLimitPolicies).flatMap((policy) => [
          policy.windowMs,
          policy.blockMs,
        ]),
      ) * 2,
    },
    { log: logRetentionMaintenance },
  );
  dataLifecycleWorker = new ProductDataLifecycleWorker(
    lifecycleRepository,
    dataLifecycleConfig,
    logDataLifecycle,
  );
  const operationalTelemetry = new ProductOperationalTelemetry(
    readiness,
    retentionMaintenance,
    Date.now,
    dataLifecycleWorker,
  );
  server = new ProductApiServer(
    auth,
    config,
    new PostgresHistoryRepository(database),
    knowledgeRuntime.service,
    readiness,
    new PostgresWorkspaceRepository(database, {
      cursorSecret: config.cookieSecret,
      emailDeliveryEnabled: Boolean(emailDeliveryConfig),
      pendingLimit: config.workspaceInvitationPendingLimit ?? 100,
      ttlMs: config.workspaceInvitationTtlMs ?? 7 * 24 * 60 * 60 * 1_000,
    }),
    abuseRateLimiter,
    release,
    passwordReset,
    operationsToken ? {
      token: operationsToken,
      snapshot: () => operationalTelemetry.snapshot(),
      createLegalHold: (target, reasonCode) => lifecycleRepository.createLegalHold(target, reasonCode),
      releaseLegalHold: (holdId) => lifecycleRepository.releaseLegalHold(holdId),
      retryLifecycleJob: (jobId) => lifecycleRepository.retryLifecycleJob(jobId),
    } : undefined,
    {
      requestUserExport: (userId, sessionId, value) => lifecycleService.requestUserExport(userId, sessionId, value),
      requestAccountDeletion: (userId, sessionId, value) => lifecycleService.requestAccountDeletion(userId, sessionId, value),
      requestWorkspaceDeletion: (userId, sessionId, workspaceId, value) => lifecycleService.requestWorkspaceDeletion(userId, sessionId, workspaceId, value),
      getJobForUser: (userId, jobId) => lifecycleRepository.getJobForUser(userId, jobId),
      getExportForUser: (userId, jobId) => lifecycleRepository.getExportForUser(userId, jobId),
    },
    emailVerification,
  );
  const port = await server.listen();
  retentionMaintenance.start();
  dataLifecycleWorker.start();
  emailDeliveryWorker?.start();
  process.stdout.write(`Kodex Product API: http://${config.host}:${port}\n`);

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => void stop());
  }
  process.on('message', (message: unknown) => {
    if (typeof message === 'object' && message !== null && 'type' in message && message.type === 'kodex-shutdown') {
      void stop();
    }
  });
  process.once('disconnect', () => void stop());
  process.once('uncaughtException', () => {
    process.stderr.write('Kodex Product API stopped after an uncaught internal error.\n');
    void stop(1);
  });
  process.once('unhandledRejection', () => {
    process.stderr.write('Kodex Product API stopped after an unhandled internal error.\n');
    void stop(1);
  });
} catch (error) {
  if (
    error instanceof ProductApiConfigurationError
    || error instanceof ProductDatabaseConfigurationError
    || (error instanceof Error && error.message.startsWith('PRODUCT_OPERATIONS_BEARER_TOKEN'))
  ) {
    process.stderr.write(`Kodex Product API configuration error: ${error.message}\n`);
  } else {
    process.stderr.write('Kodex Product API failed to start.\n');
  }
  await stop(1);
}
