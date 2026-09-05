import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { isUuid } from '@kodex/product-contract';
import {
  type LocalLifecycleTarget,
  type LocalTenantScope,
  type PostgresDataLifecycleRepository,
} from '@kodex/product-db';
import {
  RuntimeManager,
  TenantCleanupSafetyError,
} from './runtime-manager.js';

const INSTALLATION_FILENAME = '.kodex-installation-id';

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;
}

export class TenantDeletionPendingError extends Error {
  readonly code = 'tenant_deletion_pending';
  readonly status = 403;

  constructor() {
    super('Tenant data deletion is pending.');
    this.name = 'TenantDeletionPendingError';
  }
}

export function createLifecycleTenantObserver(
  repository: PostgresDataLifecycleRepository,
  installationId: string,
): (scope: LocalTenantScope) => Promise<void> {
  return async (scope) => {
    await repository.registerLocalTenants(installationId, [scope]);
    if (await repository.localTenantDeletionRequired(scope)) {
      throw new TenantDeletionPendingError();
    }
  };
}

export async function loadLocalLifecycleInstallationId(dataRoot: string): Promise<string> {
  await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  const filename = path.join(dataRoot, INSTALLATION_FILENAME);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const metadata = await lstat(filename).catch((error: unknown) => {
      if (errorCode(error) === 'ENOENT') return undefined;
      throw error;
    });
    if (metadata) {
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 64) {
        throw new Error('Local lifecycle installation identity is invalid.');
      }
      const value = (await readFile(filename, 'utf8')).trim();
      if (!isUuid(value)) throw new Error('Local lifecycle installation identity is invalid.');
      return value;
    }
    const value = randomUUID();
    try {
      const handle = await open(filename, 'wx', 0o600);
      try { await handle.writeFile(`${value}\n`, 'utf8'); } finally { await handle.close(); }
      return value;
    } catch (error) {
      if (errorCode(error) !== 'EEXIST' || attempt > 0) throw error;
    }
  }
  throw new Error('Local lifecycle installation identity could not be created.');
}

export async function discoverLocalTenantScopes(
  tenantRoot: string,
  maximumScopes = 100_000,
): Promise<LocalTenantScope[]> {
  if (!Number.isSafeInteger(maximumScopes) || maximumScopes < 1 || maximumScopes > 100_000) {
    throw new Error('Local lifecycle discovery bound is invalid.');
  }
  const usersRoot = path.join(tenantRoot, 'users');
  const root = await lstat(usersRoot).catch((error: unknown) => {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  });
  if (!root) return [];
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('Local tenant registry root is unsafe.');
  const scopes: LocalTenantScope[] = [];
  for (const userEntry of await readdir(usersRoot, { withFileTypes: true })) {
    if (!isUuid(userEntry.name)) continue;
    if (!userEntry.isDirectory() || userEntry.isSymbolicLink()) throw new Error('Local tenant user directory is unsafe.');
    const workspacesRoot = path.join(usersRoot, userEntry.name, 'workspaces');
    const workspaces = await lstat(workspacesRoot).catch((error: unknown) => {
      if (errorCode(error) === 'ENOENT') return undefined;
      throw error;
    });
    if (!workspaces) continue;
    if (!workspaces.isDirectory() || workspaces.isSymbolicLink()) throw new Error('Local tenant workspace directory is unsafe.');
    for (const workspaceEntry of await readdir(workspacesRoot, { withFileTypes: true })) {
      if (!isUuid(workspaceEntry.name)) continue;
      if (!workspaceEntry.isDirectory() || workspaceEntry.isSymbolicLink()) {
        throw new Error('Local tenant workspace directory is unsafe.');
      }
      scopes.push({ userId: userEntry.name, workspaceId: workspaceEntry.name });
      if (scopes.length > maximumScopes) throw new Error('Local tenant discovery exceeded its bound.');
    }
  }
  return scopes;
}

export interface LocalLifecycleWorkerConfig {
  enabled: boolean;
  intervalMs: number;
  leaseMs: number;
  maxTargetsPerSweep: number;
  retryMs: number;
}

export interface LocalLifecycleStatus {
  enabled: boolean;
  lastFailureAt: string | null;
  lastOutcome: 'failed' | 'never' | 'succeeded';
  processedTargets: number;
  running: boolean;
}

export type LocalLifecycleLogEvent = {
  category: 'local_data_lifecycle';
  errorClass?: 'Error' | 'NonError' | 'TenantCleanupSafetyError';
  outcome: 'blocked' | 'completed' | 'failed' | 'retry' | 'started';
};

function integer(value: string | undefined, fallback: number, minimum: number, maximum: number, name: string): number {
  const candidate = value?.trim() ? Number(value) : fallback;
  if (!Number.isSafeInteger(candidate) || candidate < minimum || candidate > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return candidate;
}

function enabled(value: string | undefined): boolean {
  if (value === undefined || value === '') return true;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw new Error('KODEX_DATA_LIFECYCLE_ENABLED must be true or false.');
}

export function localLifecycleConfigFromEnv(env: NodeJS.ProcessEnv = process.env): LocalLifecycleWorkerConfig {
  return {
    enabled: enabled(env.KODEX_DATA_LIFECYCLE_ENABLED),
    intervalMs: integer(env.KODEX_DATA_LIFECYCLE_INTERVAL_SECONDS, 5, 1, 3_600, 'KODEX_DATA_LIFECYCLE_INTERVAL_SECONDS') * 1_000,
    leaseMs: integer(env.KODEX_DATA_LIFECYCLE_LEASE_SECONDS, 30, 5, 3_600, 'KODEX_DATA_LIFECYCLE_LEASE_SECONDS') * 1_000,
    retryMs: integer(env.KODEX_DATA_LIFECYCLE_RETRY_SECONDS, 5, 1, 3_600, 'KODEX_DATA_LIFECYCLE_RETRY_SECONDS') * 1_000,
    maxTargetsPerSweep: integer(env.KODEX_DATA_LIFECYCLE_MAX_TARGETS, 10, 1, 100, 'KODEX_DATA_LIFECYCLE_MAX_TARGETS'),
  };
}

export class LocalLifecycleWorker {
  readonly #workerId = `local:${randomUUID()}`;
  #lastOutcome: LocalLifecycleStatus['lastOutcome'] = 'never';
  #lastFailureAt: string | null = null;
  #processedTargets = 0;
  #run: Promise<void> | null = null;
  #stopped = false;
  #timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly repository: PostgresDataLifecycleRepository,
    private readonly runtimeManager: RuntimeManager,
    readonly installationId: string,
    readonly config: LocalLifecycleWorkerConfig,
    private readonly log: (event: LocalLifecycleLogEvent) => void = () => undefined,
  ) {}

  start(): void {
    if (!this.config.enabled || this.#stopped || this.#timer) return;
    this.#timer = setInterval(() => void this.runOnce(), this.config.intervalMs);
    this.#timer.unref?.();
    void this.runOnce();
  }

  status(): LocalLifecycleStatus {
    return {
      enabled: this.config.enabled,
      lastFailureAt: this.#lastFailureAt,
      running: this.#run !== null,
      lastOutcome: this.#lastOutcome,
      processedTargets: this.#processedTargets,
    };
  }

  async runOnce(): Promise<void> {
    if (!this.config.enabled || this.#stopped) return;
    if (this.#run) return this.#run;
    this.#run = this.#sweep().finally(() => { this.#run = null; });
    return this.#run;
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    await this.#run?.catch(() => undefined);
  }

  async #sweep(): Promise<void> {
    this.log({ category: 'local_data_lifecycle', outcome: 'started' });
    let failed = false;
    for (let index = 0; index < this.config.maxTargetsPerSweep; index += 1) {
      let target: LocalLifecycleTarget | undefined;
      try {
        target = await this.repository.claimLocalTarget(this.installationId, this.#workerId, this.config.leaseMs);
        if (!target) break;
        const claimedTarget = target;
        const outcome = await this.repository.executeLocalTarget(
          claimedTarget,
          this.#workerId,
          this.config.retryMs,
          () => this.runtimeManager.cleanupTenantData(claimedTarget),
        );
        if (outcome === 'blocked_legal_hold') {
          this.log({ category: 'local_data_lifecycle', outcome: 'blocked' });
          continue;
        }
        if (outcome === 'completed') {
          this.#processedTargets += 1;
          this.log({ category: 'local_data_lifecycle', outcome: 'completed' });
        } else {
          this.log({ category: 'local_data_lifecycle', outcome: 'retry' });
        }
      } catch (error) {
        failed = true;
        if (target) {
          if (error instanceof TenantCleanupSafetyError) {
            await this.repository.failLocalTarget(target.id, this.#workerId, 'unsafe_filesystem').catch(() => undefined);
          } else {
            await this.repository.retryLocalTarget(target.id, this.#workerId, 'internal_error', this.config.retryMs).catch(() => undefined);
          }
        }
        this.log({
          category: 'local_data_lifecycle',
          outcome: error instanceof TenantCleanupSafetyError ? 'failed' : 'retry',
          errorClass: error instanceof TenantCleanupSafetyError
            ? 'TenantCleanupSafetyError'
            : error instanceof Error ? 'Error' : 'NonError',
        });
      }
    }
    this.#lastOutcome = failed ? 'failed' : 'succeeded';
    if (failed) this.#lastFailureAt = new Date().toISOString();
  }
}
