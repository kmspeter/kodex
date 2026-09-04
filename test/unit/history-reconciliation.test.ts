import type {
  Thread,
  ThreadItem,
  ThreadItemsListParams,
  ThreadListParams,
  ThreadTurnsListParams,
  Turn,
} from '@kodex/codex-protocol';
import type { HistoryIngestEvent } from '@kodex/product-db';
import { describe, expect, it, vi } from 'vitest';
import { HistoryEventNormalizer } from '../../apps/local-server/src/history/normalizer.js';
import {
  HISTORY_THREAD_SOURCE_KINDS,
  HistoryReconciler,
  type HistoryReconciliationClient,
  type HistoryReconciliationLogEvent,
} from '../../apps/local-server/src/history/reconciler.js';

type RequestParams = ThreadListParams | ThreadTurnsListParams | ThreadItemsListParams;

function sourceThread(id: string): Thread {
  return {
    id,
    sessionId: `session-${id}`,
    forkedFromId: null,
    parentThreadId: null,
    preview: '',
    ephemeral: false,
    section: null,
    sectionEnteredAt: null,
    projectId: null,
    historyMode: 'paginated',
    modelProvider: 'openai',
    createdAt: 100,
    updatedAt: 120,
    recencyAt: 120,
    status: { type: 'idle' },
    path: null,
    cwd: 'D:\\tenant\\project',
    cliVersion: 'test',
    source: 'appServer',
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: id,
    turns: [],
  };
}

function sourceTurn(threadId: string, suffix: string): Turn {
  return {
    id: `turn-${threadId}-${suffix}`,
    items: [],
    itemsView: 'notLoaded',
    status: 'completed',
    error: null,
    startedAt: 101,
    completedAt: 119,
    durationMs: 18_000,
  };
}

function userItem(id: string): ThreadItem {
  return {
    type: 'userMessage',
    id,
    clientId: null,
    content: [{ type: 'text', text: id, text_elements: [] }],
  };
}

function clientFrom(
  handler: (method: string, params: RequestParams) => unknown | Promise<unknown>,
): { calls: Array<{ method: string; params: RequestParams }>; client: HistoryReconciliationClient } {
  const calls: Array<{ method: string; params: RequestParams }> = [];
  const request = vi.fn(async (method: string, params: RequestParams) => {
    calls.push({ method, params });
    return handler(method, params);
  });
  return { calls, client: { request } as unknown as HistoryReconciliationClient };
}

function reconciler(
  client: HistoryReconciliationClient,
  events: HistoryIngestEvent[],
  logs: HistoryReconciliationLogEvent[] = [],
  options: Partial<ConstructorParameters<typeof HistoryReconciler>[0]> = {},
): HistoryReconciler {
  return new HistoryReconciler({
    client,
    enqueue: (event) => { events.push(event); return true; },
    normalizer: new HistoryEventNormalizer({ repositoryRoot: 'D:\\repository', sourceInstance: 'source' }),
    onLog: (event) => logs.push(event),
    intervalMs: 60_000,
    retryInitialMs: 60_000,
    retryMaximumMs: 60_000,
    ...options,
  });
}

describe('bounded tenant App Server history reconciliation', () => {
  it('pages active and archived threads, turns, and items with every pinned source kind', async () => {
    const events: HistoryIngestEvent[] = [];
    const threads = [sourceThread('active-1'), sourceThread('active-2'), sourceThread('archived-1')];
    const { calls, client } = clientFrom((method, params) => {
      if (method === 'thread/list') {
        const list = params as ThreadListParams;
        if (list.archived) return { data: [threads[2]], nextCursor: null, backwardsCursor: null };
        if (!list.cursor) return { data: [threads[0]], nextCursor: 'active-next', backwardsCursor: null };
        return { data: [threads[1]], nextCursor: null, backwardsCursor: null };
      }
      if (method === 'thread/turns/list') {
        const list = params as ThreadTurnsListParams;
        if (!list.cursor) {
          return { data: [sourceTurn(list.threadId, 'new')], nextCursor: 'turn-next', backwardsCursor: null };
        }
        return { data: [sourceTurn(list.threadId, 'old')], nextCursor: null, backwardsCursor: null };
      }
      const list = params as ThreadItemsListParams;
      const turnId = sourceTurn(list.threadId, list.cursor ? 'old' : 'new').id;
      return {
        data: [{ turnId, item: userItem(`item-${list.threadId}-${list.cursor ? 'old' : 'new'}`) }],
        nextCursor: list.cursor ? null : 'item-next',
        backwardsCursor: null,
      };
    });
    const runner = reconciler(client, events, [], { pageSize: 1 });
    try {
      await runner.runNow();
      expect(runner.status()).toMatchObject({
        lastResult: 'success',
        counts: { threads: 3, turns: 6, items: 6, threadPages: 3, turnPages: 6, failedThreads: 0 },
      });
      expect(events.filter((event) => event.eventType === 'thread.snapshot')).toHaveLength(3);
      expect(events.find((event) => event.thread.codexThreadId === 'archived-1')?.thread.status).toBe('archived');
      expect(events.every((event) => event.approval === undefined)).toBe(true);
      const listCalls = calls.filter((call) => call.method === 'thread/list');
      expect(listCalls.map((call) => (call.params as ThreadListParams).archived)).toEqual([false, false, true]);
      for (const call of listCalls) {
        expect((call.params as ThreadListParams).sourceKinds).toEqual(HISTORY_THREAD_SOURCE_KINDS);
        expect((call.params as ThreadListParams).cwd).toBeUndefined();
        expect((call.params as ThreadListParams).useStateDbOnly).toBeUndefined();
      }
    } finally {
      await runner.stop();
    }
  });

  it('applies per-state thread bounds while still scanning archived threads', async () => {
    const events: HistoryIngestEvent[] = [];
    const logs: HistoryReconciliationLogEvent[] = [];
    const { client } = clientFrom((method, params) => {
      if (method === 'thread/list') {
        const list = params as ThreadListParams;
        return {
          data: [sourceThread(list.archived ? 'archived-bounded' : 'active-bounded')],
          nextCursor: list.archived ? null : 'more-active',
          backwardsCursor: null,
        };
      }
      if (method === 'thread/turns/list') return { data: [], nextCursor: null, backwardsCursor: null };
      throw new Error('items should not be requested without turns');
    });
    const runner = reconciler(client, events, logs, { maxThreadsPerState: 1 });
    try {
      await runner.runNow();
      expect(runner.status()).toMatchObject({
        lastResult: 'partial', counts: { threads: 2, truncated: true },
      });
      expect(events.map((event) => event.thread.codexThreadId)).toEqual(['active-bounded', 'archived-bounded']);
      expect(logs.some((event) => event.kind === 'history_reconciliation_truncated' && event.limit === 'threads')).toBe(true);
    } finally {
      await runner.stop();
    }
  });

  it('continues after one thread fails, reports a bounded partial failure, and schedules retry', async () => {
    const events: HistoryIngestEvent[] = [];
    const logs: HistoryReconciliationLogEvent[] = [];
    const { client } = clientFrom((method, params) => {
      if (method === 'thread/list') {
        const list = params as ThreadListParams;
        return {
          data: list.archived ? [] : [sourceThread('broken'), sourceThread('healthy')],
          nextCursor: null,
          backwardsCursor: null,
        };
      }
      if (method === 'thread/turns/list') {
        const list = params as ThreadTurnsListParams;
        if (list.threadId === 'broken') throw new Error('response body must not reach logs');
        return { data: [], nextCursor: null, backwardsCursor: null };
      }
      throw new Error('unexpected items call');
    });
    const runner = reconciler(client, events, logs);
    try {
      await runner.runNow();
      expect(runner.status()).toMatchObject({
        lastResult: 'partial', counts: { threads: 2, failedThreads: 1 }, nextRunAt: expect.any(String),
      });
      const serializedLogs = JSON.stringify(logs);
      expect(serializedLogs).not.toContain('response body');
      expect(logs.at(-1)).toMatchObject({ kind: 'history_reconciliation_failed', retryInMs: 60_000 });
    } finally {
      await runner.stop();
    }
  });

  it('fails closed on malformed pages and repeated opaque cursors', async () => {
    for (const response of [
      { data: 'not-an-array', nextCursor: null },
      { data: [], nextCursor: 'same', backwardsCursor: null },
    ]) {
      let calls = 0;
      const { client } = clientFrom((method) => {
        if (method !== 'thread/list') throw new Error('unexpected call');
        calls += 1;
        if (calls > 1) return { data: [], nextCursor: 'same', backwardsCursor: null };
        return response;
      });
      const runner = reconciler(client, []);
      try {
        await runner.runNow();
        expect(runner.status()).toMatchObject({ lastResult: 'failed', lastFailurePhase: 'active_threads' });
      } finally {
        await runner.stop();
      }
    }
  });

  it('cancels a running scan without emitting payload-bearing diagnostics', async () => {
    let resolvePage: ((value: unknown) => void) | undefined;
    const pending = new Promise<unknown>((resolve) => { resolvePage = resolve; });
    const { client } = clientFrom(() => pending);
    const runner = reconciler(client, []);
    const run = runner.runNow();
    await vi.waitFor(() => expect(runner.status().running).toBe(true));
    runner.cancel();
    resolvePage?.({ data: [], nextCursor: null, backwardsCursor: null });
    await run;
    expect(runner.status()).toMatchObject({ lastResult: 'cancelled', running: false, stopped: true, nextRunAt: null });
  });

  it('does not lose a deferred scan when its timer elapses before the active request settles', async () => {
    let resolveFirstPage: ((value: unknown) => void) | undefined;
    const firstPage = new Promise<unknown>((resolve) => { resolveFirstPage = resolve; });
    let listCalls = 0;
    const { client } = clientFrom((method) => {
      if (method !== 'thread/list') throw new Error('unexpected call');
      listCalls += 1;
      if (listCalls === 1) return firstPage;
      return { data: [], nextCursor: null, backwardsCursor: null };
    });
    const runner = reconciler(client, []);
    try {
      const active = runner.runNow();
      runner.defer(1);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(listCalls).toBe(1);
      resolveFirstPage?.({ data: [], nextCursor: null, backwardsCursor: null });
      await active;
      await vi.waitFor(() => expect(listCalls).toBeGreaterThanOrEqual(3));
      expect(runner.status().lastResult).toBe('success');
    } finally {
      await runner.stop();
    }
  });

  it('classifies thrown outbox writes as an outbox failure without leaking the exception', async () => {
    const logs: HistoryReconciliationLogEvent[] = [];
    const { client } = clientFrom((method, params) => {
      if (method !== 'thread/list') throw new Error('unexpected call');
      const list = params as ThreadListParams;
      return {
        data: list.archived ? [] : [sourceThread('outbox-write-failure')],
        nextCursor: null,
        backwardsCursor: null,
      };
    });
    const runner = new HistoryReconciler({
      client,
      enqueue: () => { throw new Error('sensitive filesystem detail'); },
      normalizer: new HistoryEventNormalizer({ repositoryRoot: 'D:\\repository', sourceInstance: 'source' }),
      onLog: (event) => logs.push(event),
      intervalMs: 60_000,
      retryInitialMs: 60_000,
      retryMaximumMs: 60_000,
    });
    try {
      await runner.runNow();
      expect(runner.status()).toMatchObject({ lastResult: 'failed', lastFailurePhase: 'outbox' });
      expect(JSON.stringify(logs)).not.toContain('sensitive filesystem detail');
    } finally {
      await runner.stop();
    }
  });
});
