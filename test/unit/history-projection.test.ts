import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { HistoryEventSink, HistoryIngestEvent, HistoryScope } from '@kodex/product-db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DurableHistoryOutbox } from '../../apps/local-server/src/history/durable-outbox.js';
import { HistoryEventNormalizer } from '../../apps/local-server/src/history/normalizer.js';
import { sanitizeHistoryValue } from '../../apps/local-server/src/history/sanitize.js';
import type { RuntimeScope } from '../../apps/local-server/src/auth/product-authorization.js';
import type { RuntimeEvent } from '../../apps/local-server/src/runtime.js';
import { RuntimeManager } from '../../apps/local-server/src/runtime-manager.js';

const temporaryRoots: string[] = [];
const scope: HistoryScope = {
  userId: '11111111-1111-4111-8111-111111111111',
  workspaceId: '22222222-2222-4222-8222-222222222222',
};

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodex-history-unit-'));
  temporaryRoots.push(root);
  return root;
}

function historyEvent(id: string): HistoryIngestEvent {
  const occurredAt = '2026-01-01T00:00:00.000Z';
  return {
    version: 1,
    sourceInstance: `kodex-app-server:${scope.workspaceId}:${scope.userId}`,
    eventId: id,
    eventType: 'thread.started',
    occurredAt,
    project: { externalKey: 'project', name: 'Project', metadata: {} },
    thread: {
      codexThreadId: 'thread-1', status: 'active', sourceUpdatedAt: occurredAt,
      projectIsAuthoritative: true,
    },
    payload: {},
  };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for history condition.');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('history projection redaction and normalization', () => {
  it('recursively redacts credentials and bounds nested values', () => {
    const clean = sanitizeHistoryValue({
      authorization: 'Bearer secret-bearer-value',
      nested: {
        cookie: 'kodex_product_session=plain-session',
        command: 'OPENAI_API_KEY=sk-super-secret-value npm test',
        long: 'x'.repeat(10_000),
      },
    }) as Record<string, unknown>;
    const serialized = JSON.stringify(clean);

    expect(serialized).not.toContain('secret-bearer-value');
    expect(serialized).not.toContain('plain-session');
    expect(serialized).not.toContain('sk-super-secret-value');
    expect(serialized).toContain('[REDACTED]');
    expect(serialized).toContain('[TRUNCATED]');
  });

  it('projects completed items and tool calls without retaining raw secrets', () => {
    const normalizer = new HistoryEventNormalizer({
      repositoryRoot: 'D:\\project',
      sourceInstance: 'stable-source',
    });
    const threadEvent = {
      type: 'notification',
      notification: {
        method: 'thread/started',
        params: {
          thread: {
            id: 'thread-1', sessionId: 'session-1', createdAt: 10, updatedAt: 11,
            cwd: 'D:\\project', projectId: null, name: 'Thread', modelProvider: 'openai',
            source: 'appServer', parentThreadId: null, forkedFromId: null,
          },
        },
      },
    } as unknown as RuntimeEvent;
    const itemEvent = {
      type: 'notification',
      notification: {
        method: 'item/completed',
        params: {
          threadId: 'thread-1', turnId: 'turn-1', completedAtMs: 12_000,
          item: {
            id: 'item-1', type: 'commandExecution', status: 'completed',
            command: 'OPENAI_API_KEY=sk-history-secret npm test', cwd: 'D:\\project',
            commandActions: [], source: 'agent', aggregatedOutput: 'Authorization: Bearer hidden-token',
            exitCode: 0, durationMs: 20,
          },
        },
      },
    } as unknown as RuntimeEvent;

    expect(normalizer.normalize(threadEvent)).toMatchObject({
      eventType: 'thread.started',
      thread: { projectIsAuthoritative: true },
    });
    const projected = normalizer.normalize(itemEvent);
    expect(projected).toMatchObject({
      eventType: 'item.completed',
      item: { codexItemId: 'item-1', status: 'completed' },
      toolCall: { codexCallId: 'item-1', toolName: 'shell', status: 'completed' },
    });
    const serialized = JSON.stringify(projected);
    expect(serialized).not.toContain('sk-history-secret');
    expect(serialized).not.toContain('hidden-token');
  });

  it('derives distinct bounded approval identities when a raw JSON-RPC id is reused', () => {
    const normalizer = new HistoryEventNormalizer({
      repositoryRoot: 'D:\\project',
      sourceInstance: 'stable-source',
    });
    const request = (itemId: string, startedAtMs: number) => ({
      method: 'item/commandExecution/requestApproval',
      id: 'same-raw-request-id',
      params: {
        threadId: 'thread-1', turnId: 'turn-1', itemId, startedAtMs,
        environmentId: null, command: 'npm test', cwd: 'D:\\project',
      },
    });
    const firstRequest = request('item-1', 1_000);
    const secondRequest = request('item-2', 2_000);
    const first = normalizer.normalize({
      type: 'server-request', request: firstRequest, ownerId: 'ui-1',
    } as unknown as RuntimeEvent)!;
    const second = normalizer.normalize({
      type: 'server-request', request: secondRequest, ownerId: 'ui-1',
    } as unknown as RuntimeEvent)!;
    const firstResolved = normalizer.normalize({
      type: 'server-request-resolved', requestId: 'same-raw-request-id', reason: 'answered',
      request: firstRequest, response: { decision: 'accept' },
    } as unknown as RuntimeEvent)!;
    const secondResolved = normalizer.normalize({
      type: 'server-request-resolved', requestId: 'same-raw-request-id', reason: 'answered',
      request: secondRequest, response: { decision: 'decline' },
    } as unknown as RuntimeEvent)!;

    expect(first.approval?.codexRequestId).toMatch(/^approval:[a-f0-9]{64}$/u);
    expect(second.approval?.codexRequestId).toMatch(/^approval:[a-f0-9]{64}$/u);
    expect(first.approval?.codexRequestId).not.toBe(second.approval?.codexRequestId);
    expect(firstResolved.approval?.codexRequestId).toBe(first.approval?.codexRequestId);
    expect(secondResolved.approval?.codexRequestId).toBe(second.approval?.codexRequestId);
    expect(firstResolved.approval?.status).toBe('approved');
    expect(secondResolved.approval?.status).toBe('denied');
    expect(JSON.stringify([first, second, firstResolved, secondResolved]))
      .not.toContain('same-raw-request-id');

    const mcpFormRequest = {
      method: 'mcpServer/elicitation/request',
      id: 7,
      params: {
        threadId: 'thread-1', turnId: null, serverName: 'safe-server', mode: 'form',
        message: 'Choose a value', requestedSchema: { type: 'object' }, _meta: null,
      },
    };
    const firstMcp = normalizer.normalize({
      type: 'server-request', request: mcpFormRequest, ownerId: 'ui-1',
    } as unknown as RuntimeEvent, new Date('2026-01-01T00:00:00.000Z'))!;
    const firstMcpResolved = normalizer.normalize({
      type: 'server-request-resolved', requestId: 7, reason: 'answered',
      request: mcpFormRequest, response: { action: 'accept', content: {} },
    } as unknown as RuntimeEvent, new Date('2026-01-01T00:00:01.000Z'))!;
    const reusedMcp = normalizer.normalize({
      type: 'server-request', request: mcpFormRequest, ownerId: 'ui-1',
    } as unknown as RuntimeEvent, new Date('2026-01-01T00:01:00.000Z'))!;
    expect(firstMcpResolved.approval?.codexRequestId).toBe(firstMcp.approval?.codexRequestId);
    expect(reusedMcp.approval?.codexRequestId).not.toBe(firstMcp.approval?.codexRequestId);
  });

  it('fits oversized item/tool/approval records under the final serialized outbox limit', async () => {
    const root = await temporaryRoot();
    const maxEventBytes = 4_096;
    const secret = 'sk-final-size-secret-value';
    const huge = `OPENAI_API_KEY=${secret} ${'x'.repeat(150_000)}`;
    const normalizer = new HistoryEventNormalizer({
      repositoryRoot: root,
      sourceInstance: 'stable-source',
      maxEventBytes,
    });
    const item = normalizer.normalize({
      type: 'notification',
      notification: {
        method: 'item/completed',
        params: {
          threadId: 'thread-large', turnId: 'turn-large', completedAtMs: 2_000,
          item: {
            id: 'item-large', type: 'commandExecution', status: 'completed',
            command: huge, cwd: root, commandActions: [{ type: 'unknown', command: huge }],
            source: 'agent', aggregatedOutput: `Cookie: ${huge}`,
            exitCode: 0, durationMs: 1,
          },
        },
      },
    } as unknown as RuntimeEvent)!;
    const approval = normalizer.normalize({
      type: 'server-request',
      ownerId: 'ui-1',
      request: {
        method: 'item/tool/requestUserInput', id: 'large-request',
        params: {
          threadId: 'thread-large', turnId: 'turn-large', itemId: 'item-large',
          questions: [{ id: 'question', header: 'Secret', question: huge, options: [] }],
          isBlocking: true, autoResolutionMs: null,
        },
      },
    } as unknown as RuntimeEvent)!;

    for (const event of [item, approval]) {
      const serialized = JSON.stringify(event);
      expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThanOrEqual(maxEventBytes);
      expect(serialized).not.toContain(secret);
      expect(serialized).toContain('event_size_limit');
    }

    const outbox = new DurableHistoryOutbox({
      directory: path.join(root, 'bounded-outbox'),
      scope,
      sink: { ingest: async () => { throw new Error('offline'); } },
      maxBytes: 20_000,
      maxRecordBytes: maxEventBytes,
      maxRecords: 10,
      retryInitialMs: 10_000,
      retryMaximumMs: 10_000,
    });
    outbox.start();
    expect(outbox.enqueue(item)).toBe(true);
    expect(outbox.enqueue(approval)).toBe(true);
    expect(outbox.status().pendingRecords).toBe(2);
    await outbox.stop(50);
  });
});

describe('durable history outbox', () => {
  it('replays in order after a failed sink and a simulated process restart', async () => {
    const root = await temporaryRoot();
    const directory = path.join(root, 'outbox');
    const unavailable: HistoryEventSink = { ingest: vi.fn(async () => { throw new Error('offline'); }) };
    const first = new DurableHistoryOutbox({
      directory, scope, sink: unavailable, retryInitialMs: 10_000, retryMaximumMs: 10_000,
    });
    first.start();
    expect(first.enqueue(historyEvent('event-1'))).toBe(true);
    expect(first.enqueue(historyEvent('event-2'))).toBe(true);
    await waitUntil(() => first.status().lastError === 'database_unavailable');
    expect(first.status()).toMatchObject({ pendingRecords: 2, pendingBytes: expect.any(Number) });
    await first.stop(50);

    const observed: string[] = [];
    const recovered = new DurableHistoryOutbox({
      directory,
      scope,
      sink: { ingest: async (_eventScope, event) => { observed.push(event.eventId); } },
    });
    recovered.start();
    await waitUntil(() => recovered.status().pendingRecords === 0);
    expect(observed).toEqual(['event-1', 'event-2']);
    await recovered.stop();
  });

  it('stays bounded and reports overflow instead of growing without limit', async () => {
    const root = await temporaryRoot();
    const statuses: Array<{ overflowed: boolean }> = [];
    const outbox = new DurableHistoryOutbox({
      directory: path.join(root, 'outbox'),
      scope,
      sink: { ingest: async () => { throw new Error('offline'); } },
      maxBytes: 2_048,
      maxRecordBytes: 1_024,
      maxRecords: 1,
      retryInitialMs: 10_000,
      retryMaximumMs: 10_000,
      onStatus: (status) => statuses.push(status),
    });
    outbox.start();
    expect(outbox.enqueue(historyEvent('event-1'))).toBe(true);
    expect(outbox.enqueue(historyEvent('event-2'))).toBe(false);
    expect(outbox.status()).toMatchObject({ overflowed: true, pendingRecords: 1 });
    expect(statuses.some((status) => status.overflowed)).toBe(true);
    await outbox.stop(50);
  });

  it('keeps exactly one recorder subscription per tenant runtime across reuse and eviction', async () => {
    const root = await temporaryRoot();
    const observed: string[] = [];
    let now = 1_000;
    const manager = new RuntimeManager({
      repositoryRoot: root,
      tenantRoot: path.join(root, 'tenants'),
      runtimeOptions: { startAppServer: false },
      idleTimeoutMs: 1,
      sweepIntervalMs: 60_000,
      clock: () => now,
      historySink: {
        ingest: async (_eventScope, event) => { observed.push(event.eventId); },
      },
    });
    const runtimeScope: RuntimeScope = {
      ...scope,
      sessionId: '33333333-3333-4333-8333-333333333333',
      sessionExpiresAt: new Date(Date.now() + 60_000),
      workspaceRole: 'owner',
    };
    try {
      const [first, second] = await Promise.all([
        manager.acquire(runtimeScope),
        manager.acquire(runtimeScope),
      ]);
      expect(first.runtime).toBe(second.runtime);
      const oldRuntime = first.runtime;
      oldRuntime.emit({
        type: 'notification',
        notification: {
          method: 'thread/started',
          params: { thread: {
            id: 'thread-one', sessionId: 'session-one', createdAt: 1, updatedAt: 1,
            cwd: root, projectId: null, name: null, modelProvider: 'openai', source: 'appServer',
            parentThreadId: null, forkedFromId: null,
          } },
        },
      } as unknown as RuntimeEvent);
      await waitUntil(() => observed.length === 1);
      first.release();
      second.release();
      now += 2;
      await manager.evictIdle(now);

      oldRuntime.emit({
        type: 'notification',
        notification: {
          method: 'thread/archived', params: { threadId: 'thread-one' },
        },
      } as unknown as RuntimeEvent);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(observed).toHaveLength(1);

      const replacement = await manager.acquire(runtimeScope);
      replacement.runtime.emit({
        type: 'notification',
        notification: {
          method: 'thread/started',
          params: { thread: {
            id: 'thread-two', sessionId: 'session-two', createdAt: 2, updatedAt: 2,
            cwd: root, projectId: null, name: null, modelProvider: 'openai', source: 'appServer',
            parentThreadId: null, forkedFromId: null,
          } },
        },
      } as unknown as RuntimeEvent);
      await waitUntil(() => observed.length === 2);
      replacement.release();
    } finally {
      await manager.close();
    }
    expect(observed).toHaveLength(2);
  });
});
