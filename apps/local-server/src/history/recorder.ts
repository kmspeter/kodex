import path from 'node:path';
import type { HistoryEventSink, HistoryScope } from '@kodex/product-db';
import type { KodexRuntime } from '../runtime.js';
import { DurableHistoryOutbox, type HistoryOutboxStatus } from './durable-outbox.js';
import { HistoryEventNormalizer } from './normalizer.js';
import {
  HistoryReconciler,
  type HistoryReconciliationLogEvent,
  type HistoryReconciliationStatus,
} from './reconciler.js';

export type HistoryRecorderLogEvent =
  | { kind: 'history_database_unavailable' }
  | { kind: 'history_event_rejected'; reason: 'disk_write_failed' | 'event_size_limit' }
  | { kind: 'history_outbox_overflow'; maxBytes: number; maxRecords: number }
  | { kind: 'history_spool_invalid' }
  | HistoryReconciliationLogEvent;

export interface HistoryRecorderStatus extends HistoryOutboxStatus {
  reconciliation: HistoryReconciliationStatus;
}

export interface RuntimeHistoryRecorderOptions {
  dataRoot: string;
  maxEventBytes?: number;
  maxOutboxBytes?: number;
  maxOutboxRecords?: number;
  onLog?: (event: HistoryRecorderLogEvent) => void;
  repositoryRoot: string;
  retryInitialMs?: number;
  retryMaximumMs?: number;
  reconciliationIntervalMs?: number;
  reconciliationMaxItemsPerThread?: number;
  reconciliationMaxThreadsPerState?: number;
  reconciliationMaxTurnsPerThread?: number;
  reconciliationPageSize?: number;
  reconciliationRequestTimeoutMs?: number;
  reconciliationRetryInitialMs?: number;
  reconciliationRetryMaximumMs?: number;
  runtime: KodexRuntime;
  scope: HistoryScope;
  sink: HistoryEventSink;
}

export class RuntimeHistoryRecorder {
  readonly outbox: DurableHistoryOutbox;
  #activeTurnIds = new Set<string>();
  #lastStatus: HistoryOutboxStatus | undefined;
  #normalizer: HistoryEventNormalizer;
  #onLog: (event: HistoryRecorderLogEvent) => void;
  #reconciler: HistoryReconciler;
  #runtime: KodexRuntime;
  #started = false;
  #unsubscribe: (() => void) | undefined;

  constructor(options: RuntimeHistoryRecorderOptions) {
    this.#runtime = options.runtime;
    this.#onLog = options.onLog ?? (() => undefined);
    const maxEventBytes = options.maxEventBytes ?? 65_536;
    this.#normalizer = new HistoryEventNormalizer({
      repositoryRoot: options.repositoryRoot,
      sourceInstance: `kodex-app-server:${options.scope.workspaceId}:${options.scope.userId}`,
      maxEventBytes,
    });
    this.outbox = new DurableHistoryOutbox({
      directory: path.join(options.dataRoot, 'product-history-outbox'),
      scope: options.scope,
      sink: options.sink,
      maxBytes: options.maxOutboxBytes,
      maxRecords: options.maxOutboxRecords,
      maxRecordBytes: maxEventBytes,
      retryInitialMs: options.retryInitialMs,
      retryMaximumMs: options.retryMaximumMs,
      onStatus: (status) => this.#onStatus(status),
    });
    this.#reconciler = new HistoryReconciler({
      client: this.#runtime.appServer,
      normalizer: this.#normalizer,
      enqueue: (event) => this.outbox.enqueue(event),
      intervalMs: options.reconciliationIntervalMs,
      maxItemsPerThread: options.reconciliationMaxItemsPerThread,
      maxThreadsPerState: options.reconciliationMaxThreadsPerState,
      maxTurnsPerThread: options.reconciliationMaxTurnsPerThread,
      pageSize: options.reconciliationPageSize,
      requestTimeoutMs: options.reconciliationRequestTimeoutMs,
      retryInitialMs: options.reconciliationRetryInitialMs,
      retryMaximumMs: options.reconciliationRetryMaximumMs,
      onLog: (event) => this.#onLog(event),
    });
  }

  start(): void {
    if (this.#started) return;
    this.outbox.start();
    this.#unsubscribe = this.#runtime.subscribe((_sequence, runtimeEvent) => {
      try {
        if (runtimeEvent.type === 'notification') {
          if (runtimeEvent.notification.method === 'turn/started') {
            this.#activeTurnIds.add(runtimeEvent.notification.params.turn.id);
            this.#reconciler.defer(this.#reconciler.intervalMs);
          } else if (runtimeEvent.notification.method === 'turn/completed') {
            this.#activeTurnIds.delete(runtimeEvent.notification.params.turn.id);
            if (this.#activeTurnIds.size === 0) this.#reconciler.defer(2_000);
          }
        }
        const event = this.#normalizer.normalize(runtimeEvent);
        if (!event) return;
        if (!this.outbox.enqueue(event)) {
          this.#onLog({
            kind: 'history_outbox_overflow',
            maxBytes: this.outbox.maxBytes,
            maxRecords: this.outbox.maxRecords,
          });
        }
      } catch (error) {
        this.#onLog({
          kind: 'history_event_rejected',
          reason: error instanceof Error && /size limit/u.test(error.message)
            ? 'event_size_limit'
            : 'disk_write_failed',
        });
      }
    });
    this.#started = true;
  }

  startReconciliation(): void {
    if (!this.#started) return;
    this.#reconciler.start();
  }

  cancelReconciliation(): void {
    this.#reconciler.cancel();
  }

  status(): HistoryRecorderStatus {
    return { ...this.outbox.status(), reconciliation: this.#reconciler.status() };
  }

  async stop(): Promise<void> {
    if (!this.#started) return;
    await this.#reconciler.stop();
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#activeTurnIds.clear();
    this.#started = false;
    await this.outbox.stop();
  }

  #onStatus(status: HistoryOutboxStatus): void {
    if (status.overflowed && !this.#lastStatus?.overflowed) {
      this.#onLog({
        kind: 'history_outbox_overflow',
        maxBytes: this.outbox.maxBytes,
        maxRecords: this.outbox.maxRecords,
      });
    }
    if (status.lastError === 'database_unavailable' && this.#lastStatus?.lastError !== status.lastError) {
      this.#onLog({ kind: 'history_database_unavailable' });
    }
    if (status.lastError === 'invalid_spool_record' && this.#lastStatus?.lastError !== status.lastError) {
      this.#onLog({ kind: 'history_spool_invalid' });
    }
    this.#lastStatus = status;
  }
}
