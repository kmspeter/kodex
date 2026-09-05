import { randomUUID } from 'node:crypto';
import {
  DataLifecycleError,
  type DataLifecycleJobKind,
  type DataLifecycleWorkerConfig,
  type PostgresDataLifecycleRepository,
} from '@kodex/product-db';

export interface ProductDataLifecycleRuntimeConfig extends DataLifecycleWorkerConfig {
  enabled: boolean;
  intervalMs: number;
  maxJobsPerSweep: number;
}

export interface ProductDataLifecycleStatus {
  enabled: boolean;
  lastFailureAt: string | null;
  lastOutcome: 'failed' | 'never' | 'succeeded';
  processedJobs: number;
  running: boolean;
}

export type ProductDataLifecycleLogEvent = {
  category: 'product_data_lifecycle';
  errorClass?: 'DataLifecycleError' | 'Error' | 'NonError';
  kind?: DataLifecycleJobKind;
  outcome: 'completed' | 'failed' | 'retry' | 'started' | 'waiting';
};

function integer(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
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
  throw new Error('PRODUCT_DATA_LIFECYCLE_ENABLED must be true or false.');
}

export function productDataLifecycleConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ProductDataLifecycleRuntimeConfig {
  return {
    enabled: enabled(env.PRODUCT_DATA_LIFECYCLE_ENABLED),
    intervalMs: integer(env.PRODUCT_DATA_LIFECYCLE_INTERVAL_SECONDS, 5, 1, 3_600, 'PRODUCT_DATA_LIFECYCLE_INTERVAL_SECONDS') * 1_000,
    leaseMs: integer(env.PRODUCT_DATA_LIFECYCLE_LEASE_SECONDS, 30, 5, 3_600, 'PRODUCT_DATA_LIFECYCLE_LEASE_SECONDS') * 1_000,
    retryMs: integer(env.PRODUCT_DATA_LIFECYCLE_RETRY_SECONDS, 5, 1, 3_600, 'PRODUCT_DATA_LIFECYCLE_RETRY_SECONDS') * 1_000,
    exportRetentionMs: integer(env.PRODUCT_DATA_EXPORT_RETENTION_DAYS, 7, 1, 365, 'PRODUCT_DATA_EXPORT_RETENTION_DAYS') * 24 * 60 * 60 * 1_000,
    exportMaxRowsPerCategory: integer(env.PRODUCT_DATA_EXPORT_MAX_ROWS, 10_000, 1, 100_000, 'PRODUCT_DATA_EXPORT_MAX_ROWS'),
    exportMaxBytes: integer(env.PRODUCT_DATA_EXPORT_MAX_BYTES, 16_777_216, 1_024, 16_777_216, 'PRODUCT_DATA_EXPORT_MAX_BYTES'),
    maxJobsPerSweep: integer(env.PRODUCT_DATA_LIFECYCLE_MAX_JOBS, 10, 1, 100, 'PRODUCT_DATA_LIFECYCLE_MAX_JOBS'),
  };
}

export class ProductDataLifecycleWorker {
  readonly #workerId = `product:${randomUUID()}`;
  #lastOutcome: ProductDataLifecycleStatus['lastOutcome'] = 'never';
  #lastFailureAt: string | null = null;
  #processedJobs = 0;
  #run: Promise<void> | null = null;
  #stopped = false;
  #timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly repository: PostgresDataLifecycleRepository,
    readonly config: ProductDataLifecycleRuntimeConfig,
    private readonly log: (event: ProductDataLifecycleLogEvent) => void = () => undefined,
  ) {}

  start(): void {
    if (!this.config.enabled || this.#stopped || this.#timer) return;
    this.#timer = setInterval(() => void this.runOnce(), this.config.intervalMs);
    this.#timer.unref?.();
    void this.runOnce();
  }

  status(): ProductDataLifecycleStatus {
    return {
      enabled: this.config.enabled,
      lastFailureAt: this.#lastFailureAt,
      running: this.#run !== null,
      lastOutcome: this.#lastOutcome,
      processedJobs: this.#processedJobs,
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
    this.log({ category: 'product_data_lifecycle', outcome: 'started' });
    let failed = false;
    try {
      await this.repository.purgeExpiredExports();
      for (let index = 0; index < this.config.maxJobsPerSweep; index += 1) {
        const claimed = await this.repository.claimProductJob(this.#workerId, this.config.leaseMs);
        if (!claimed) break;
        try {
          if (claimed.kind === 'user_export') {
            await this.repository.processExportJob(claimed, this.#workerId, this.config);
            this.log({ category: 'product_data_lifecycle', kind: claimed.kind, outcome: 'completed' });
          } else {
            const result = await this.repository.finalizeDeletionJob(claimed, this.#workerId, this.config.retryMs);
            this.log({
              category: 'product_data_lifecycle',
              kind: claimed.kind,
              outcome: result === 'completed' ? 'completed' : 'waiting',
            });
          }
          this.#processedJobs += 1;
        } catch (error) {
          failed = true;
          const terminal = error instanceof DataLifecycleError
            && ['export_limit', 'not_found', 'owned_workspace_conflict', 'scope_conflict'].includes(error.code);
          if (terminal) {
            await this.repository.failProductJob(claimed.id, this.#workerId, error.code);
          } else {
            await this.repository.retryProductJob(claimed.id, this.#workerId, 'internal_error', this.config.retryMs);
          }
          this.log({
            category: 'product_data_lifecycle',
            kind: claimed.kind,
            outcome: terminal ? 'failed' : 'retry',
            errorClass: error instanceof DataLifecycleError
              ? 'DataLifecycleError'
              : error instanceof Error ? 'Error' : 'NonError',
          });
        }
      }
      this.#lastOutcome = failed ? 'failed' : 'succeeded';
      if (failed) this.#lastFailureAt = new Date().toISOString();
    } catch (error) {
      this.#lastOutcome = 'failed';
      this.#lastFailureAt = new Date().toISOString();
      this.log({
        category: 'product_data_lifecycle',
        outcome: 'failed',
        errorClass: error instanceof DataLifecycleError
          ? 'DataLifecycleError'
          : error instanceof Error ? 'Error' : 'NonError',
      });
    }
  }
}
