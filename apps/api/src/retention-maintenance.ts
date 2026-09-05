import type { RetentionRepository } from '@kodex/product-db';
import type { ProductRetentionMaintenanceConfig } from './config.js';

export interface RetentionMaintenanceRuntimeConfig extends ProductRetentionMaintenanceConfig {
  abuseRateLimitStaleMs: number;
  rateLimitStaleMs: number;
}

export interface RetentionMaintenanceCounts {
  abuseRateLimitsDeleted: number;
  batches: number;
  emailDeliveriesDeleted: number;
  emailVerificationsDeleted: number;
  invitationsDeleted: number;
  passwordResetsDeleted: number;
  rateLimitsDeleted: number;
  sessionsDeleted: number;
}

export type RetentionMaintenanceLogEvent = {
  category: 'product_retention_maintenance';
  outcome: 'complete';
  trigger: 'periodic' | 'startup';
} & RetentionMaintenanceCounts | {
  category: 'product_retention_maintenance';
  errorClass: 'DatabaseError' | 'Error' | 'NonError';
  outcome: 'failed';
  trigger: 'periodic' | 'startup';
} & RetentionMaintenanceCounts;

export interface RetentionMaintenanceOptions {
  clock?: () => Date;
  log?: (event: RetentionMaintenanceLogEvent) => void;
}

export interface RetentionMaintenanceStatus {
  enabled: boolean;
  lastCompletedAt: string | null;
  lastCounts: RetentionMaintenanceCounts;
  lastFailureAt: string | null;
  lastOutcome: 'complete' | 'failed' | null;
  running: boolean;
  started: boolean;
  stopped: boolean;
}

function assertRuntimeConfig(config: RetentionMaintenanceRuntimeConfig): void {
  if (!Number.isSafeInteger(config.intervalMs) || config.intervalMs < 1) {
    throw new Error('Retention maintenance interval must be a positive integer');
  }
  if (!Number.isSafeInteger(config.batchSize) || config.batchSize < 1 || config.batchSize > 1_000) {
    throw new Error('Retention maintenance batch size must be between 1 and 1000');
  }
  if (!Number.isSafeInteger(config.maxBatches) || config.maxBatches < 1 || config.maxBatches > 100) {
    throw new Error('Retention maintenance max batches must be between 1 and 100');
  }
  for (const [name, value] of [
    ['session retention', config.sessionRetentionMs],
    ['invitation retention', config.invitationRetentionMs],
    ['password reset retention', config.passwordResetRetentionMs],
    ['email verification retention', config.emailVerificationRetentionMs],
    ['email delivery retention', config.emailDeliveryRetentionMs],
    ['rate-limit stale age', config.rateLimitStaleMs],
    ['abuse rate-limit stale age', config.abuseRateLimitStaleMs],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`Retention maintenance ${name} must be a positive integer`);
    }
  }
}

function errorClass(error: unknown): 'DatabaseError' | 'Error' | 'NonError' {
  if (!(error instanceof Error)) return 'NonError';
  return error.name === 'DatabaseError' ? 'DatabaseError' : 'Error';
}

function emptyCounts(): RetentionMaintenanceCounts {
  return {
    abuseRateLimitsDeleted: 0,
    batches: 0,
    emailDeliveriesDeleted: 0,
    emailVerificationsDeleted: 0,
    invitationsDeleted: 0,
    passwordResetsDeleted: 0,
    rateLimitsDeleted: 0,
    sessionsDeleted: 0,
  };
}

export class ProductRetentionMaintenance {
  readonly #clock: () => Date;
  readonly #log: (event: RetentionMaintenanceLogEvent) => void;
  #running: Promise<void> | undefined;
  #lastCompletedAt: string | null = null;
  #lastCounts: RetentionMaintenanceCounts = emptyCounts();
  #lastFailureAt: string | null = null;
  #lastOutcome: RetentionMaintenanceStatus['lastOutcome'] = null;
  #started = false;
  #stopped = false;
  #timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly repository: RetentionRepository,
    private readonly config: RetentionMaintenanceRuntimeConfig,
    options: RetentionMaintenanceOptions = {},
  ) {
    assertRuntimeConfig(config);
    this.#clock = options.clock ?? (() => new Date());
    this.#log = options.log ?? (() => undefined);
  }

  start(): void {
    if (this.#started || this.#stopped) return;
    this.#started = true;
    if (!this.config.enabled) return;

    this.#timer = setInterval(() => {
      void this.runSweep('periodic');
    }, this.config.intervalMs);
    this.#timer.unref();
    void this.runSweep('startup');
  }

  runSweep(trigger: 'periodic' | 'startup' = 'periodic'): Promise<boolean> {
    if (!this.config.enabled || this.#stopped || this.#running) {
      return Promise.resolve(false);
    }
    const operation = this.#performSweep(trigger).finally(() => {
      if (this.#running === operation) this.#running = undefined;
    });
    this.#running = operation;
    return operation.then(() => true);
  }

  status(): RetentionMaintenanceStatus {
    return {
      enabled: this.config.enabled,
      lastCompletedAt: this.#lastCompletedAt,
      lastCounts: { ...this.#lastCounts },
      lastFailureAt: this.#lastFailureAt,
      lastOutcome: this.#lastOutcome,
      running: this.#running !== undefined,
      started: this.#started,
      stopped: this.#stopped,
    };
  }

  async stop(): Promise<void> {
    if (this.#stopped) {
      await this.#running;
      return;
    }
    this.#stopped = true;
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
    await this.#running;
  }

  async #performSweep(trigger: 'periodic' | 'startup'): Promise<void> {
    const counts = emptyCounts();
    try {
      const referenceTime = this.#clock();
      if (!Number.isFinite(referenceTime.getTime())) throw new Error('Retention clock returned an invalid date');
      const sessionCutoff = new Date(referenceTime.getTime() - this.config.sessionRetentionMs);
      const invitationCutoff = new Date(referenceTime.getTime() - this.config.invitationRetentionMs);
      const passwordResetCutoff = new Date(referenceTime.getTime() - this.config.passwordResetRetentionMs);
      const emailVerificationCutoff = new Date(referenceTime.getTime() - this.config.emailVerificationRetentionMs);
      const emailDeliveryCutoff = new Date(referenceTime.getTime() - this.config.emailDeliveryRetentionMs);
      const rateLimitCutoff = new Date(referenceTime.getTime() - this.config.rateLimitStaleMs);
      const abuseRateLimitCutoff = new Date(referenceTime.getTime() - this.config.abuseRateLimitStaleMs);

      for (let index = 0; index < this.config.maxBatches && !this.#stopped; index += 1) {
        counts.batches += 1;
        const sessions = await this.repository.deleteTerminalSessionsBatch({
          batchSize: this.config.batchSize,
          cutoff: sessionCutoff,
        });
        counts.sessionsDeleted += sessions;
        if (this.#stopped) break;

        const invitations = await this.repository.deleteTerminalInvitationsBatch({
          batchSize: this.config.batchSize,
          cutoff: invitationCutoff,
        });
        counts.invitationsDeleted += invitations;
        if (this.#stopped) break;

        const passwordResets = await this.repository.deleteTerminalPasswordResetsBatch({
          batchSize: this.config.batchSize,
          cutoff: passwordResetCutoff,
        });
        counts.passwordResetsDeleted += passwordResets;
        if (this.#stopped) break;

        const emailVerifications = await this.repository.deleteTerminalEmailVerificationsBatch({
          batchSize: this.config.batchSize,
          cutoff: emailVerificationCutoff,
        });
        counts.emailVerificationsDeleted += emailVerifications;
        if (this.#stopped) break;

        const emailDeliveries = await this.repository.deleteTerminalEmailDeliveriesBatch({
          batchSize: this.config.batchSize,
          cutoff: emailDeliveryCutoff,
        });
        counts.emailDeliveriesDeleted += emailDeliveries;
        if (this.#stopped) break;

        const rateLimits = await this.repository.deleteStaleLoginRateLimitsBatch({
          batchSize: this.config.batchSize,
          cutoff: rateLimitCutoff,
          referenceTime,
        });
        counts.rateLimitsDeleted += rateLimits;
        if (this.#stopped) break;

        const abuseRateLimits = await this.repository.deleteStaleAbuseRateLimitsBatch({
          batchSize: this.config.batchSize,
          cutoff: abuseRateLimitCutoff,
          referenceTime,
        });
        counts.abuseRateLimitsDeleted += abuseRateLimits;

        if (
          sessions < this.config.batchSize
          && invitations < this.config.batchSize
          && passwordResets < this.config.batchSize
          && emailVerifications < this.config.batchSize
          && emailDeliveries < this.config.batchSize
          && rateLimits < this.config.batchSize
          && abuseRateLimits < this.config.batchSize
        ) break;
      }
      this.#emit({ category: 'product_retention_maintenance', outcome: 'complete', trigger, ...counts });
    } catch (error) {
      this.#emit({
        category: 'product_retention_maintenance',
        errorClass: errorClass(error),
        outcome: 'failed',
        trigger,
        ...counts,
      });
    }
  }

  #emit(event: RetentionMaintenanceLogEvent): void {
    let observedAt: string;
    try {
      const observedTime = this.#clock();
      observedAt = Number.isFinite(observedTime.getTime())
        ? observedTime.toISOString()
        : new Date().toISOString();
    } catch {
      observedAt = new Date().toISOString();
    }
    this.#lastCounts = {
      abuseRateLimitsDeleted: event.abuseRateLimitsDeleted,
      batches: event.batches,
      emailDeliveriesDeleted: event.emailDeliveriesDeleted,
      emailVerificationsDeleted: event.emailVerificationsDeleted,
      invitationsDeleted: event.invitationsDeleted,
      passwordResetsDeleted: event.passwordResetsDeleted,
      rateLimitsDeleted: event.rateLimitsDeleted,
      sessionsDeleted: event.sessionsDeleted,
    };
    this.#lastOutcome = event.outcome;
    if (event.outcome === 'complete') this.#lastCompletedAt = observedAt;
    else this.#lastFailureAt = observedAt;
    try {
      this.#log(event);
    } catch {
      // Maintenance and its aggregate-only logging must never interrupt serving.
    }
  }
}
