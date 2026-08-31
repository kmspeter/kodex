import path from 'node:path';
import type { HistoryEventSink, HistoryScope } from '@kodex/product-db';
import type { KodexRuntime } from '../runtime.js';
import { DurableHistoryOutbox, type HistoryOutboxStatus } from './durable-outbox.js';
import { HistoryEventNormalizer } from './normalizer.js';

export type HistoryRecorderLogEvent =
  | { kind: 'history_database_unavailable' }
  | { kind: 'history_event_rejected'; reason: 'disk_write_failed' | 'event_size_limit' }
  | { kind: 'history_outbox_overflow'; maxBytes: number; maxRecords: number }
  | { kind: 'history_spool_invalid' };

export interface RuntimeHistoryRecorderOptions {
  dataRoot: string;
  maxEventBytes?: number;
  maxOutboxBytes?: number;
  maxOutboxRecords?: number;
  onLog?: (event: HistoryRecorderLogEvent) => void;
  repositoryRoot: string;
  retryInitialMs?: number;
  retryMaximumMs?: number;
  runtime: KodexRuntime;
  scope: HistoryScope;
  sink: HistoryEventSink;
}

export class RuntimeHistoryRecorder {
  readonly outbox: DurableHistoryOutbox;
  #lastStatus: HistoryOutboxStatus | undefined;
  #normalizer: HistoryEventNormalizer;
  #onLog: (event: HistoryRecorderLogEvent) => void;
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
  }

  start(): void {
    if (this.#started) return;
    this.outbox.start();
    this.#unsubscribe = this.#runtime.subscribe((_sequence, runtimeEvent) => {
      try {
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

  status(): HistoryOutboxStatus {
    return this.outbox.status();
  }

  async stop(): Promise<void> {
    if (!this.#started) return;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
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
