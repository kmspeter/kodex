import type {
  Thread,
  ThreadItemEntry,
  ThreadItemsListParams,
  ThreadItemsListResponse,
  ThreadListParams,
  ThreadListResponse,
  ThreadSourceKind,
  ThreadTurnsListParams,
  ThreadTurnsListResponse,
  Turn,
} from '@kodex/codex-protocol';
import type { HistoryIngestEvent } from '@kodex/product-db';
import { HistoryEventNormalizer } from './normalizer.js';

export const HISTORY_THREAD_SOURCE_KINDS: readonly ThreadSourceKind[] = [
  'cli',
  'vscode',
  'exec',
  'appServer',
  'subAgent',
  'subAgentReview',
  'subAgentCompact',
  'subAgentThreadSpawn',
  'subAgentOther',
  'unknown',
];

type ReconciliationPhase = 'active_threads' | 'archived_threads' | 'turns' | 'items' | 'outbox';
type ReconciliationResult = 'success' | 'partial' | 'failed' | 'cancelled' | null;

export interface HistoryReconciliationClient {
  request(method: 'thread/list', params: ThreadListParams, timeoutMs?: number): Promise<ThreadListResponse>;
  request(method: 'thread/turns/list', params: ThreadTurnsListParams, timeoutMs?: number): Promise<ThreadTurnsListResponse>;
  request(method: 'thread/items/list', params: ThreadItemsListParams, timeoutMs?: number): Promise<ThreadItemsListResponse>;
}

export interface HistoryReconciliationCounts {
  failedThreads: number;
  items: number;
  threadPages: number;
  threads: number;
  truncated: boolean;
  turnPages: number;
  turns: number;
}

export interface HistoryReconciliationStatus {
  counts: HistoryReconciliationCounts;
  lastCompletedAt: string | null;
  lastFailurePhase: ReconciliationPhase | null;
  lastResult: ReconciliationResult;
  lastStartedAt: string | null;
  nextRunAt: string | null;
  running: boolean;
  stopped: boolean;
}

export type HistoryReconciliationLogEvent =
  | { kind: 'history_reconciliation_completed'; counts: HistoryReconciliationCounts }
  | { kind: 'history_reconciliation_failed'; counts: HistoryReconciliationCounts; phase: ReconciliationPhase; retryInMs: number }
  | { kind: 'history_reconciliation_truncated'; counts: HistoryReconciliationCounts; limit: 'threads' | 'turns' | 'items' };

export interface HistoryReconcilerOptions {
  client: HistoryReconciliationClient;
  enqueue: (event: HistoryIngestEvent) => boolean;
  intervalMs?: number;
  maxItemsPerThread?: number;
  maxThreadsPerState?: number;
  maxTurnsPerThread?: number;
  normalizer: HistoryEventNormalizer;
  onLog?: (event: HistoryReconciliationLogEvent) => void;
  pageSize?: number;
  requestTimeoutMs?: number;
  retryInitialMs?: number;
  retryMaximumMs?: number;
}

interface Page<T> {
  data: T[];
  nextCursor: string | null;
}

class ReconciliationError extends Error {
  constructor(readonly phase: ReconciliationPhase) {
    super(`History reconciliation failed during ${phase}.`);
    this.name = 'ReconciliationError';
  }
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate <= 0) throw new Error(`${name} must be a positive integer.`);
  return candidate;
}

function emptyCounts(): HistoryReconciliationCounts {
  return {
    failedThreads: 0,
    items: 0,
    threadPages: 0,
    threads: 0,
    truncated: false,
    turnPages: 0,
    turns: 0,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function publicId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

function cursor(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > 4_096) throw new Error('invalid cursor');
  return value;
}

function page<T>(value: unknown, limit: number, validate: (entry: unknown) => entry is T): Page<T> {
  if (!isRecord(value) || !Array.isArray(value.data) || value.data.length > limit) throw new Error('invalid page');
  if (!value.data.every(validate)) throw new Error('invalid page entry');
  return { data: value.data, nextCursor: cursor(value.nextCursor) };
}

function thread(value: unknown): value is Thread {
  if (!isRecord(value)) return false;
  return publicId(value.id)
    && typeof value.createdAt === 'number'
    && Number.isFinite(value.createdAt)
    && typeof value.updatedAt === 'number'
    && Number.isFinite(value.updatedAt)
    && typeof value.cwd === 'string'
    && typeof value.modelProvider === 'string'
    && (value.name === null || typeof value.name === 'string')
    && (value.projectId === null || typeof value.projectId === 'string');
}

function turn(value: unknown): value is Turn {
  if (!isRecord(value) || !publicId(value.id)) return false;
  if (!['completed', 'interrupted', 'failed', 'inProgress'].includes(String(value.status))) return false;
  return (value.startedAt === null || (typeof value.startedAt === 'number' && Number.isFinite(value.startedAt)))
    && (value.completedAt === null || (typeof value.completedAt === 'number' && Number.isFinite(value.completedAt)));
}

function itemEntry(value: unknown): value is ThreadItemEntry {
  return isRecord(value)
    && publicId(value.turnId)
    && isRecord(value.item)
    && publicId(value.item.id)
    && typeof value.item.type === 'string';
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('History reconciliation was cancelled.', 'AbortError');
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function yieldToRuntime(signal: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolve) => setImmediate(resolve));
}

export class HistoryReconciler {
  readonly intervalMs: number;
  readonly maxItemsPerThread: number;
  readonly maxThreadsPerState: number;
  readonly maxTurnsPerThread: number;
  readonly pageSize: number;
  readonly requestTimeoutMs: number;
  readonly retryInitialMs: number;
  readonly retryMaximumMs: number;
  #abort: AbortController | null = null;
  #client: HistoryReconciliationClient;
  #current: Promise<void> | null = null;
  #enqueue: (event: HistoryIngestEvent) => boolean;
  #normalizer: HistoryEventNormalizer;
  #onLog: (event: HistoryReconciliationLogEvent) => void;
  #partialFailurePhase: ReconciliationPhase | null = null;
  #retryDelayMs: number;
  #status: HistoryReconciliationStatus = {
    counts: emptyCounts(),
    lastCompletedAt: null,
    lastFailurePhase: null,
    lastResult: null,
    lastStartedAt: null,
    nextRunAt: null,
    running: false,
    stopped: true,
  };
  #scheduleGeneration = 0;
  #timer: NodeJS.Timeout | null = null;

  constructor(options: HistoryReconcilerOptions) {
    this.#client = options.client;
    this.#enqueue = options.enqueue;
    this.#normalizer = options.normalizer;
    this.#onLog = options.onLog ?? (() => undefined);
    this.pageSize = positiveInteger(options.pageSize, 50, 'pageSize');
    this.maxThreadsPerState = positiveInteger(options.maxThreadsPerState, 500, 'maxThreadsPerState');
    this.maxTurnsPerThread = positiveInteger(options.maxTurnsPerThread, 1_000, 'maxTurnsPerThread');
    this.maxItemsPerThread = positiveInteger(options.maxItemsPerThread, 5_000, 'maxItemsPerThread');
    this.requestTimeoutMs = positiveInteger(options.requestTimeoutMs, 15_000, 'requestTimeoutMs');
    this.intervalMs = positiveInteger(options.intervalMs, 15 * 60_000, 'intervalMs');
    this.retryInitialMs = positiveInteger(options.retryInitialMs, 5_000, 'retryInitialMs');
    this.retryMaximumMs = positiveInteger(options.retryMaximumMs, 5 * 60_000, 'retryMaximumMs');
    if (this.pageSize > 100) throw new Error('pageSize cannot exceed 100.');
    if (this.retryInitialMs > this.retryMaximumMs) throw new Error('retryInitialMs cannot exceed retryMaximumMs.');
    this.#retryDelayMs = this.retryInitialMs;
  }

  start(): void {
    if (!this.#status.stopped) return;
    this.#status = { ...this.#status, stopped: false };
    this.#schedule(0);
  }

  cancel(): void {
    this.#scheduleGeneration += 1;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#abort?.abort();
    this.#status = { ...this.#status, nextRunAt: null, stopped: true };
  }

  defer(delayMs: number): void {
    if (this.#status.stopped) return;
    if (!Number.isSafeInteger(delayMs) || delayMs <= 0) throw new Error('History reconciliation defer delay must be positive.');
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#abort?.abort();
    this.#status = { ...this.#status, nextRunAt: null };
    this.#schedule(delayMs);
  }

  async stop(timeoutMs = 5_000): Promise<void> {
    this.cancel();
    if (!this.#current) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      this.#current.catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
      }),
    ]);
    if (timer) clearTimeout(timer);
  }

  status(): HistoryReconciliationStatus {
    return { ...this.#status, counts: { ...this.#status.counts } };
  }

  runNow(): Promise<void> {
    if (this.#status.stopped) this.#status = { ...this.#status, stopped: false };
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#status = { ...this.#status, nextRunAt: null };
    if (this.#current) return this.#current;
    this.#current = this.#run().finally(() => { this.#current = null; });
    return this.#current;
  }

  #schedule(delayMs: number): void {
    if (this.#status.stopped || this.#timer) return;
    const generation = ++this.#scheduleGeneration;
    const nextRunAt = new Date(Date.now() + delayMs).toISOString();
    this.#status = { ...this.#status, nextRunAt };
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#status = { ...this.#status, nextRunAt: null };
      const active = this.#current;
      const run = this.runNow();
      if (active) {
        void run.finally(() => {
          if (this.#status.stopped || this.#scheduleGeneration !== generation) return;
          this.#schedule(0);
        });
      }
    }, delayMs);
    this.#timer.unref?.();
  }

  async #run(): Promise<void> {
    const counts = emptyCounts();
    const abort = new AbortController();
    this.#abort = abort;
    this.#status = {
      ...this.#status,
      counts,
      lastFailurePhase: null,
      lastStartedAt: new Date().toISOString(),
      running: true,
    };
    this.#partialFailurePhase = null;
    let result: Exclude<ReconciliationResult, null> = 'success';
    let failurePhase: ReconciliationPhase | null = null;
    try {
      for (const archived of [false, true]) {
        try {
          await this.#reconcileThreadState(archived, counts, abort.signal);
        } catch (error) {
          if (isAbort(error)) throw error;
          result = 'failed';
          failurePhase = error instanceof ReconciliationError
            ? error.phase
            : archived ? 'archived_threads' : 'active_threads';
          break;
        }
      }
      if (result === 'success' && (counts.failedThreads > 0 || counts.truncated)) result = 'partial';
    } catch (error) {
      if (isAbort(error)) result = 'cancelled';
      else {
        result = 'failed';
        failurePhase = error instanceof ReconciliationError ? error.phase : 'active_threads';
      }
    } finally {
      if (this.#abort === abort) this.#abort = null;
      failurePhase ??= this.#partialFailurePhase;
      const stopped = this.#status.stopped;
      const retryInMs = this.#retryDelayMs;
      this.#status = {
        ...this.#status,
        counts: { ...counts },
        lastCompletedAt: new Date().toISOString(),
        lastFailurePhase: failurePhase,
        lastResult: result,
        running: false,
      };
      if (result === 'success') {
        this.#retryDelayMs = this.retryInitialMs;
        this.#onLog({ kind: 'history_reconciliation_completed', counts: { ...counts } });
        if (!stopped) this.#schedule(this.intervalMs);
      } else if (result === 'partial' || result === 'failed') {
        const phase = failurePhase ?? (counts.truncated ? 'outbox' : 'items');
        this.#onLog({
          kind: 'history_reconciliation_failed',
          phase,
          retryInMs,
          counts: { ...counts },
        });
        this.#retryDelayMs = Math.min(this.retryMaximumMs, this.#retryDelayMs * 2);
        if (!stopped) this.#schedule(retryInMs);
      }
    }
  }

  async #reconcileThreadState(
    archived: boolean,
    counts: HistoryReconciliationCounts,
    signal: AbortSignal,
  ): Promise<void> {
    const phase: ReconciliationPhase = archived ? 'archived_threads' : 'active_threads';
    let nextCursor: string | null = null;
    const seenCursors = new Set<string>();
    let stateThreads = 0;
    do {
      throwIfAborted(signal);
      let response: ThreadListResponse;
      const requestLimit = Math.min(this.pageSize, this.maxThreadsPerState - stateThreads);
      try {
        response = await this.#client.request('thread/list', {
          archived,
          cursor: nextCursor,
          limit: requestLimit,
          sortDirection: 'desc',
          sortKey: 'updated_at',
          sourceKinds: [...HISTORY_THREAD_SOURCE_KINDS],
        }, this.requestTimeoutMs);
      } catch {
        throw new ReconciliationError(phase);
      }
      throwIfAborted(signal);
      let current: Page<Thread>;
      try { current = page(response, requestLimit, thread); } catch { throw new ReconciliationError(phase); }
      counts.threadPages += 1;
      for (const sourceThread of current.data) {
        throwIfAborted(signal);
        if (stateThreads >= this.maxThreadsPerState) break;
        stateThreads += 1;
        counts.threads += 1;
        const threadEvent = this.#normalizer.normalizeThreadSnapshot(sourceThread, archived);
        if (!threadEvent) throw new ReconciliationError('outbox');
        this.#enqueueEvent(threadEvent);
        try {
          await this.#reconcileThread(sourceThread, archived, counts, signal);
        } catch (error) {
          if (isAbort(error) || (error instanceof ReconciliationError && error.phase === 'outbox')) throw error;
          counts.failedThreads += 1;
          this.#partialFailurePhase ??= error instanceof ReconciliationError ? error.phase : 'turns';
        }
      }
      if (current.nextCursor && stateThreads >= this.maxThreadsPerState) {
        this.#truncated(counts, 'threads');
        return;
      }
      nextCursor = this.#nextCursor(current.nextCursor, seenCursors, phase);
      await yieldToRuntime(signal);
    } while (nextCursor);
  }

  async #reconcileThread(
    sourceThread: Thread,
    archived: boolean,
    counts: HistoryReconciliationCounts,
    signal: AbortSignal,
  ): Promise<void> {
    const turns = new Map<string, Turn>();
    let nextCursor: string | null = null;
    const seenTurnCursors = new Set<string>();
    do {
      throwIfAborted(signal);
      let response: ThreadTurnsListResponse;
      const requestLimit = Math.min(this.pageSize, this.maxTurnsPerThread - turns.size);
      try {
        response = await this.#client.request('thread/turns/list', {
          threadId: sourceThread.id,
          cursor: nextCursor,
          limit: requestLimit,
          sortDirection: 'desc',
          itemsView: 'notLoaded',
        }, this.requestTimeoutMs);
      } catch { throw new ReconciliationError('turns'); }
      throwIfAborted(signal);
      let current: Page<Turn>;
      try { current = page(response, requestLimit, turn); } catch { throw new ReconciliationError('turns'); }
      counts.turnPages += 1;
      for (const sourceTurn of current.data) {
        throwIfAborted(signal);
        if (turns.size >= this.maxTurnsPerThread) break;
        turns.set(sourceTurn.id, sourceTurn);
        counts.turns += 1;
        const event = this.#normalizer.normalizeTurnSnapshot(sourceThread, archived, sourceTurn);
        if (!event) throw new ReconciliationError('outbox');
        this.#enqueueEvent(event);
      }
      if (current.nextCursor && turns.size >= this.maxTurnsPerThread) {
        this.#truncated(counts, 'turns');
        break;
      }
      nextCursor = this.#nextCursor(current.nextCursor, seenTurnCursors, 'turns');
      await yieldToRuntime(signal);
    } while (nextCursor);

    if (turns.size === 0) return;
    nextCursor = null;
    const seenItemCursors = new Set<string>();
    let threadItems = 0;
    do {
      throwIfAborted(signal);
      let response: ThreadItemsListResponse;
      const requestLimit = Math.min(this.pageSize, this.maxItemsPerThread - threadItems);
      try {
        response = await this.#client.request('thread/items/list', {
          threadId: sourceThread.id,
          cursor: nextCursor,
          limit: requestLimit,
          sortDirection: 'desc',
        }, this.requestTimeoutMs);
      } catch { throw new ReconciliationError('items'); }
      throwIfAborted(signal);
      let current: Page<ThreadItemEntry>;
      try { current = page(response, requestLimit, itemEntry); } catch { throw new ReconciliationError('items'); }
      for (const entry of current.data) {
        throwIfAborted(signal);
        if (threadItems >= this.maxItemsPerThread) break;
        threadItems += 1;
        const sourceTurn = turns.get(entry.turnId);
        if (!sourceTurn) continue;
        counts.items += 1;
        const event = this.#normalizer.normalizeItemSnapshot(sourceThread, archived, sourceTurn, entry.item);
        if (!event) throw new ReconciliationError('outbox');
        this.#enqueueEvent(event);
      }
      if (current.nextCursor && threadItems >= this.maxItemsPerThread) {
        this.#truncated(counts, 'items');
        break;
      }
      nextCursor = this.#nextCursor(current.nextCursor, seenItemCursors, 'items');
      await yieldToRuntime(signal);
    } while (nextCursor);
  }

  #nextCursor(
    value: string | null,
    seen: Set<string>,
    phase: ReconciliationPhase,
  ): string | null {
    if (!value) return null;
    if (seen.has(value)) throw new ReconciliationError(phase);
    seen.add(value);
    return value;
  }

  #enqueueEvent(event: HistoryIngestEvent): void {
    try {
      if (this.#enqueue(event)) return;
    } catch { /* The outbox owns payload-bearing diagnostics. */ }
    throw new ReconciliationError('outbox');
  }

  #truncated(counts: HistoryReconciliationCounts, limit: 'threads' | 'turns' | 'items'): void {
    counts.truncated = true;
    this.#onLog({ kind: 'history_reconciliation_truncated', limit, counts: { ...counts } });
  }
}
