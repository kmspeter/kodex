import type { ProductApiReadiness } from './server.js';
import type { ProductRetentionMaintenance } from './retention-maintenance.js';
import type { ProductDataLifecycleWorker } from './data-lifecycle-worker.js';

export type OperationalAlertSeverity = 'critical' | 'warning';

export interface OperationalAlert {
  code: string;
  severity: OperationalAlertSeverity;
  since: string;
}

export interface ProductOperationalStatus {
  alerts: OperationalAlert[];
  component: 'product-api';
  database: {
    consecutiveFailures: number;
    lastCheckedAt: string;
    lastFailureAt: string | null;
    status: 'down' | 'up';
  };
  generatedAt: string;
  lifecycle: ReturnType<ProductDataLifecycleWorker['status']> | null;
  process: {
    status: 'running';
    uptimeSeconds: number;
  };
  retention: ReturnType<ProductRetentionMaintenance['status']> | null;
  status: 'degraded' | 'healthy';
}

export class ProductOperationalTelemetry {
  readonly #startedAt: number;
  #consecutiveDatabaseFailures = 0;
  #lastDatabaseFailureAt: string | null = null;

  constructor(
    private readonly readiness: ProductApiReadiness,
    private readonly retention: ProductRetentionMaintenance | undefined,
    private readonly clock: () => number = Date.now,
    private readonly lifecycle: Pick<ProductDataLifecycleWorker, 'status'> | undefined = undefined,
  ) {
    this.#startedAt = this.clock();
  }

  async snapshot(): Promise<ProductOperationalStatus> {
    const now = this.clock();
    const generatedAt = new Date(now).toISOString();
    let databaseStatus: 'down' | 'up' = 'up';
    try {
      await this.readiness.check();
      this.#consecutiveDatabaseFailures = 0;
    } catch {
      databaseStatus = 'down';
      if (this.#consecutiveDatabaseFailures === 0) this.#lastDatabaseFailureAt = generatedAt;
      this.#consecutiveDatabaseFailures += 1;
    }

    const retention = this.retention?.status() ?? null;
    const lifecycle = this.lifecycle?.status() ?? null;
    const alerts: OperationalAlert[] = [];
    if (databaseStatus === 'down') {
      alerts.push({
        code: 'product_database_unavailable',
        severity: 'critical',
        since: this.#lastDatabaseFailureAt!,
      });
    }
    if (retention?.lastOutcome === 'failed' && retention.lastFailureAt) {
      alerts.push({
        code: 'product_retention_failed',
        severity: 'warning',
        since: retention.lastFailureAt,
      });
    }
    if (lifecycle?.lastOutcome === 'failed' && lifecycle.lastFailureAt) {
      alerts.push({
        code: 'product_data_lifecycle_failed',
        severity: 'warning',
        since: lifecycle.lastFailureAt,
      });
    }

    return {
      alerts,
      component: 'product-api',
      database: {
        consecutiveFailures: this.#consecutiveDatabaseFailures,
        lastCheckedAt: generatedAt,
        lastFailureAt: this.#lastDatabaseFailureAt,
        status: databaseStatus,
      },
      generatedAt,
      lifecycle,
      process: {
        status: 'running',
        uptimeSeconds: Math.max(0, Math.floor((now - this.#startedAt) / 1_000)),
      },
      retention,
      status: alerts.length > 0 ? 'degraded' : 'healthy',
    };
  }
}
