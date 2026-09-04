import type { HistoryRecorderLogEvent } from './history/recorder.js';
import type { RuntimeManager, RuntimeManagerOperationalStatus } from './runtime-manager.js';

export interface LocalOperationalAlert {
  code: string;
  severity: 'critical' | 'warning';
  since: string;
}

export interface LocalSecurityMetricEvent {
  kind:
    | 'http_rejected'
    | 'runtime_capacity_rejected'
    | 'ws_revalidation_failed'
    | 'ws_revalidation_succeeded'
    | 'ws_upgrade_rejected';
  status: number;
}

interface LocalOperationalCounters {
  historyDatabaseUnavailable: number;
  historyEventsRejected: number;
  historyOutboxOverflows: number;
  historyReconciliationFailures: number;
  historyReconciliationTruncations: number;
  historySpoolInvalid: number;
  httpRejected: number;
  runtimeCapacityRejected: number;
  wsRevalidationFailed: number;
  wsRevalidationSucceeded: number;
  wsUpgradeRejected: number;
}

export interface LocalOperationalStatus {
  alerts: LocalOperationalAlert[];
  authorization: {
    lastUnavailableAt: string | null;
    revalidationFailed: number;
    revalidationSucceeded: number;
  };
  component: 'local-server';
  counters: LocalOperationalCounters;
  database: {
    consecutiveFailures: number;
    lastCheckedAt: string;
    lastFailureAt: string | null;
    status: 'down' | 'up';
  };
  generatedAt: string;
  process: {
    status: 'running';
    uptimeSeconds: number;
  };
  runtimes: RuntimeManagerOperationalStatus;
  status: 'degraded' | 'healthy';
}

type AlertCandidate = Omit<LocalOperationalAlert, 'since'>;

function emptyCounters(): LocalOperationalCounters {
  return {
    historyDatabaseUnavailable: 0,
    historyEventsRejected: 0,
    historyOutboxOverflows: 0,
    historyReconciliationFailures: 0,
    historyReconciliationTruncations: 0,
    historySpoolInvalid: 0,
    httpRejected: 0,
    runtimeCapacityRejected: 0,
    wsRevalidationFailed: 0,
    wsRevalidationSucceeded: 0,
    wsUpgradeRejected: 0,
  };
}

export class LocalOperationalTelemetry {
  readonly #alertSince = new Map<string, string>();
  readonly #counters = emptyCounters();
  readonly #startedAt: number;
  #consecutiveDatabaseFailures = 0;
  #lastDatabaseFailureAt: string | null = null;
  #lastRevalidationSucceededAt: string | null = null;
  #lastRevalidationUnavailableAt: string | null = null;

  constructor(
    private readonly runtimeManager: Pick<RuntimeManager, 'operationalStatus'>,
    private readonly databaseCheck: () => Promise<void>,
    private readonly clock: () => number = Date.now,
  ) {
    this.#startedAt = this.clock();
  }

  recordHistory(event: HistoryRecorderLogEvent): void {
    if (event.kind === 'history_database_unavailable') this.#counters.historyDatabaseUnavailable += 1;
    else if (event.kind === 'history_event_rejected') this.#counters.historyEventsRejected += 1;
    else if (event.kind === 'history_outbox_overflow') this.#counters.historyOutboxOverflows += 1;
    else if (event.kind === 'history_spool_invalid') this.#counters.historySpoolInvalid += 1;
    else if (event.kind === 'history_reconciliation_failed') this.#counters.historyReconciliationFailures += 1;
    else if (event.kind === 'history_reconciliation_truncated') this.#counters.historyReconciliationTruncations += 1;
  }

  recordSecurity(event: LocalSecurityMetricEvent): void {
    if (event.kind === 'http_rejected') this.#counters.httpRejected += 1;
    else if (event.kind === 'runtime_capacity_rejected') this.#counters.runtimeCapacityRejected += 1;
    else if (event.kind === 'ws_upgrade_rejected') this.#counters.wsUpgradeRejected += 1;
    else if (event.kind === 'ws_revalidation_succeeded') {
      this.#counters.wsRevalidationSucceeded += 1;
      this.#lastRevalidationSucceededAt = new Date(this.clock()).toISOString();
    } else {
      this.#counters.wsRevalidationFailed += 1;
      if (event.status === 503) {
        this.#lastRevalidationUnavailableAt = new Date(this.clock()).toISOString();
      }
    }
  }

  async snapshot(): Promise<LocalOperationalStatus> {
    const now = this.clock();
    const generatedAt = new Date(now).toISOString();
    let databaseStatus: 'down' | 'up' = 'up';
    try {
      await this.databaseCheck();
      this.#consecutiveDatabaseFailures = 0;
    } catch {
      databaseStatus = 'down';
      if (this.#consecutiveDatabaseFailures === 0) this.#lastDatabaseFailureAt = generatedAt;
      this.#consecutiveDatabaseFailures += 1;
    }

    const runtimes = this.runtimeManager.operationalStatus();
    const candidates: AlertCandidate[] = [];
    if (databaseStatus === 'down') {
      candidates.push({ code: 'local_database_unavailable', severity: 'critical' });
    }
    if (runtimes.atCapacity) {
      candidates.push({ code: 'runtime_capacity_saturated', severity: 'warning' });
    }
    if (runtimes.engine.failed > 0 || runtimes.engine.missingBinary > 0) {
      candidates.push({ code: 'codex_app_server_unavailable', severity: 'critical' });
    }
    if (runtimes.engine.missingKey > 0) {
      candidates.push({ code: 'codex_provider_credentials_missing', severity: 'warning' });
    }
    if (runtimes.history.overflowedRuntimes > 0) {
      candidates.push({ code: 'history_outbox_overflow', severity: 'critical' });
    }
    if (runtimes.history.databaseUnavailableRuntimes > 0) {
      candidates.push({ code: 'history_outbox_database_unavailable', severity: 'critical' });
    }
    if (runtimes.history.invalidSpoolRuntimes > 0) {
      candidates.push({ code: 'history_outbox_spool_invalid', severity: 'critical' });
    }
    if (
      runtimes.history.reconciliationFailedRuntimes > 0
      || runtimes.history.reconciliationPartialRuntimes > 0
    ) {
      candidates.push({ code: 'history_reconciliation_failed', severity: 'warning' });
    }
    if (
      this.#lastRevalidationUnavailableAt
      && (!this.#lastRevalidationSucceededAt
        || this.#lastRevalidationUnavailableAt > this.#lastRevalidationSucceededAt)
    ) {
      candidates.push({ code: 'authorization_revalidation_unavailable', severity: 'critical' });
    }

    const activeCodes = new Set(candidates.map((candidate) => candidate.code));
    for (const code of this.#alertSince.keys()) {
      if (!activeCodes.has(code)) this.#alertSince.delete(code);
    }
    const alerts = candidates.map((candidate) => {
      const since = this.#alertSince.get(candidate.code) ?? generatedAt;
      this.#alertSince.set(candidate.code, since);
      return { ...candidate, since };
    });

    return {
      alerts,
      authorization: {
        lastUnavailableAt: this.#lastRevalidationUnavailableAt,
        revalidationFailed: this.#counters.wsRevalidationFailed,
        revalidationSucceeded: this.#counters.wsRevalidationSucceeded,
      },
      component: 'local-server',
      counters: { ...this.#counters },
      database: {
        consecutiveFailures: this.#consecutiveDatabaseFailures,
        lastCheckedAt: generatedAt,
        lastFailureAt: this.#lastDatabaseFailureAt,
        status: databaseStatus,
      },
      generatedAt,
      process: {
        status: 'running',
        uptimeSeconds: Math.max(0, Math.floor((now - this.#startedAt) / 1_000)),
      },
      runtimes,
      status: alerts.length > 0 ? 'degraded' : 'healthy',
    };
  }
}
