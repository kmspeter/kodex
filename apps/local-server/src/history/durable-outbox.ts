import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { HistoryEventSink, HistoryIngestEvent, HistoryScope } from '@kodex/product-db';

const RECORD_PATTERN = /^(\d{20})-[a-f0-9]{16}\.json$/u;

interface PendingRecord {
  filename: string;
  sequence: number;
  size: number;
}

export interface HistoryOutboxStatus {
  lastError: 'database_unavailable' | 'invalid_spool_record' | null;
  overflowed: boolean;
  pendingBytes: number;
  pendingRecords: number;
  running: boolean;
}

export interface DurableHistoryOutboxOptions {
  directory: string;
  maxBytes?: number;
  maxRecordBytes?: number;
  maxRecords?: number;
  onStatus?: (status: HistoryOutboxStatus) => void;
  retryInitialMs?: number;
  retryMaximumMs?: number;
  scope: HistoryScope;
  sink: HistoryEventSink;
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return candidate;
}

export class DurableHistoryOutbox {
  readonly directory: string;
  readonly maxBytes: number;
  readonly maxRecordBytes: number;
  readonly maxRecords: number;
  readonly retryInitialMs: number;
  readonly retryMaximumMs: number;
  #accepting = false;
  #flushPromise: Promise<void> | null = null;
  #lastError: HistoryOutboxStatus['lastError'] = null;
  #nextSequence = 1;
  #onStatus: (status: HistoryOutboxStatus) => void;
  #overflowed = false;
  #pending: PendingRecord[] = [];
  #pendingBytes = 0;
  #pendingEventIds = new Map<string, number>();
  #retryDelayMs: number;
  #retryTimer: NodeJS.Timeout | null = null;
  #scope: HistoryScope;
  #sink: HistoryEventSink;

  constructor(options: DurableHistoryOutboxOptions) {
    this.directory = path.resolve(options.directory);
    this.maxBytes = positiveInteger(options.maxBytes, 16 * 1024 * 1024, 'maxBytes');
    this.maxRecordBytes = positiveInteger(options.maxRecordBytes, 65_536, 'maxRecordBytes');
    this.maxRecords = positiveInteger(options.maxRecords, 10_000, 'maxRecords');
    this.retryInitialMs = positiveInteger(options.retryInitialMs, 250, 'retryInitialMs');
    this.retryMaximumMs = positiveInteger(options.retryMaximumMs, 30_000, 'retryMaximumMs');
    if (this.maxRecordBytes > this.maxBytes) {
      throw new Error('maxRecordBytes cannot exceed maxBytes.');
    }
    if (this.retryInitialMs > this.retryMaximumMs) {
      throw new Error('retryInitialMs cannot exceed retryMaximumMs.');
    }
    this.#retryDelayMs = this.retryInitialMs;
    this.#scope = { ...options.scope };
    this.#sink = options.sink;
    this.#onStatus = options.onStatus ?? (() => undefined);
  }

  start(): void {
    if (this.#accepting) return;
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.#pending = [];
    this.#pendingBytes = 0;
    this.#pendingEventIds.clear();
    let highestSequence = 0;
    for (const filename of readdirSync(this.directory).sort()) {
      const match = RECORD_PATTERN.exec(filename);
      const absolute = path.join(this.directory, filename);
      if (!match) {
        if (filename.endsWith('.tmp')) unlinkSync(absolute);
        continue;
      }
      const sequence = Number(match[1]);
      const size = statSync(absolute).size;
      highestSequence = Math.max(highestSequence, sequence);
      this.#pending.push({ filename, sequence, size });
      this.#pendingBytes += size;
      try {
        const parsed = JSON.parse(readFileSync(absolute, 'utf8')) as { eventId?: unknown };
        if (typeof parsed.eventId === 'string') this.#addPendingEventId(parsed.eventId);
      } catch { /* Invalid records remain in place and stop ordered replay in #drain. */ }
    }
    this.#pending.sort((left, right) => left.sequence - right.sequence);
    this.#nextSequence = highestSequence + 1;
    this.#accepting = true;
    if (this.#pendingBytes > this.maxBytes || this.#pending.length > this.maxRecords) {
      this.#overflowed = true;
      this.#report();
    }
    this.#triggerFlush();
  }

  enqueue(event: HistoryIngestEvent): boolean {
    if (!this.#accepting) return false;
    if (this.#pendingEventIds.has(event.eventId)) return true;
    const serialized = JSON.stringify(event);
    const size = Buffer.byteLength(serialized, 'utf8');
    if (
      size > this.maxRecordBytes
      || this.#pending.length >= this.maxRecords
      || this.#pendingBytes + size > this.maxBytes
    ) {
      this.#overflowed = true;
      this.#report();
      return false;
    }
    const sequence = this.#nextSequence;
    this.#nextSequence += 1;
    const digest = createHash('sha256').update(event.eventId).digest('hex').slice(0, 16);
    const filename = `${String(sequence).padStart(20, '0')}-${digest}.json`;
    const absolute = path.join(this.directory, filename);
    const temporary = `${absolute}.${process.pid}.${Date.now()}.tmp`;
    let descriptor: number | undefined;
    try {
      descriptor = openSync(temporary, 'wx', 0o600);
      writeFileSync(descriptor, serialized, 'utf8');
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporary, absolute);
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      if (existsSync(temporary)) unlinkSync(temporary);
      throw error;
    }
    this.#pending.push({ filename, sequence, size });
    this.#pendingBytes += size;
    this.#addPendingEventId(event.eventId);
    this.#report();
    this.#triggerFlush();
    return true;
  }

  status(): HistoryOutboxStatus {
    return {
      running: this.#accepting,
      pendingRecords: this.#pending.length,
      pendingBytes: this.#pendingBytes,
      overflowed: this.#overflowed,
      lastError: this.#lastError,
    };
  }

  async flush(): Promise<void> {
    if (this.#flushPromise) return this.#flushPromise;
    this.#flushPromise = this.#drain().finally(() => {
      this.#flushPromise = null;
    });
    return this.#flushPromise;
  }

  async stop(timeoutMs = 5_000): Promise<void> {
    this.#accepting = false;
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      this.flush().catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
      }),
    ]);
    if (timer) clearTimeout(timer);
    this.#report();
  }

  #triggerFlush(): void {
    queueMicrotask(() => void this.flush().catch(() => undefined));
  }

  async #drain(): Promise<void> {
    while (this.#pending.length > 0) {
      const pending = this.#pending[0];
      let event: HistoryIngestEvent;
      try {
        const parsed = JSON.parse(readFileSync(path.join(this.directory, pending.filename), 'utf8')) as HistoryIngestEvent;
        if (parsed.version !== 1 || typeof parsed.eventId !== 'string') throw new Error('invalid');
        event = parsed;
      } catch {
        this.#lastError = 'invalid_spool_record';
        this.#report();
        return;
      }
      try {
        await this.#sink.ingest(this.#scope, event);
      } catch {
        this.#lastError = 'database_unavailable';
        this.#scheduleRetry();
        this.#report();
        return;
      }
      unlinkSync(path.join(this.directory, pending.filename));
      this.#pending.shift();
      this.#pendingBytes -= pending.size;
      this.#removePendingEventId(event.eventId);
      this.#lastError = null;
      this.#retryDelayMs = this.retryInitialMs;
      this.#report();
    }
  }

  #scheduleRetry(): void {
    if (!this.#accepting || this.#retryTimer) return;
    const delay = this.#retryDelayMs;
    this.#retryDelayMs = Math.min(this.retryMaximumMs, this.#retryDelayMs * 2);
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      void this.flush().catch(() => undefined);
    }, delay);
    this.#retryTimer.unref?.();
  }

  #report(): void {
    this.#onStatus(this.status());
  }

  #addPendingEventId(eventId: string): void {
    this.#pendingEventIds.set(eventId, (this.#pendingEventIds.get(eventId) ?? 0) + 1);
  }

  #removePendingEventId(eventId: string): void {
    const count = this.#pendingEventIds.get(eventId) ?? 0;
    if (count <= 1) this.#pendingEventIds.delete(eventId);
    else this.#pendingEventIds.set(eventId, count - 1);
  }
}
