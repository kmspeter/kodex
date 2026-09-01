import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  AuthServiceError,
  hashSessionToken,
  PostgresAuthRepository,
  PostgresHistoryRepository,
  requireProductDatabaseFromEnv,
  type AuthContext,
  type AuthSessionResult,
  type HistoryEventSink,
  type HistoryIngestEvent,
  type HistoryScope,
  type ProductDatabase,
} from '@kodex/product-db';
import { PRODUCT_SESSION_COOKIE_NAME, PRODUCT_WORKSPACE_HEADER_NAME } from '@kodex/product-contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ProductApiConfig } from '../../apps/api/src/config.js';
import type { AuthApplication } from '../../apps/api/src/server.js';
import { ProductApiServer } from '../../apps/api/src/server.js';
import { DurableHistoryOutbox } from '../../apps/local-server/src/history/durable-outbox.js';
import { HistoryEventNormalizer } from '../../apps/local-server/src/history/normalizer.js';
import type { RuntimeEvent } from '../../apps/local-server/src/runtime.js';

const runPrefix = `history-it-${randomUUID()}`;
const allowedOrigin = 'http://127.0.0.1:5173';
const placeholderPasswordHash = '$argon2id$'.padEnd(80, 'x');

function token(): string {
  return randomBytes(32).toString('base64url');
}

function cookie(sessionToken: string): string {
  return `${PRODUCT_SESSION_COOKIE_NAME}=${sessionToken}`;
}

function threadEvent(
  scope: HistoryScope,
  threadId: string,
  occurredAt: string,
  suffix = 'started',
): HistoryIngestEvent {
  return {
    version: 1,
    sourceInstance: `kodex-app-server:${scope.workspaceId}:${scope.userId}`,
    eventId: `thread:${threadId}:${suffix}`,
    eventType: 'thread.started',
    occurredAt,
    project: { externalKey: 'integration-project', name: 'Integration Project', metadata: {} },
    thread: {
      codexThreadId: threadId,
      status: 'active',
      title: `Thread ${threadId.slice(0, 8)}`,
      createdAt: occurredAt,
      sourceUpdatedAt: occurredAt,
      projectIsAuthoritative: true,
    },
    payload: { lifecycle: 'started' },
  };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for PostgreSQL history state.');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

class RepositoryAuthApplication implements AuthApplication {
  constructor(private readonly repository: PostgresAuthRepository) {}

  async authenticate(sessionToken: string | undefined): Promise<AuthContext> {
    const context = sessionToken
      ? await this.repository.findAuthContext(hashSessionToken(sessionToken))
      : undefined;
    if (!context) throw new AuthServiceError('unauthenticated');
    return context;
  }

  async login(): Promise<AuthSessionResult> {
    throw new AuthServiceError('invalid_credentials');
  }

  async logout(sessionToken: string | undefined): Promise<void> {
    if (sessionToken) await this.repository.revokeSession(hashSessionToken(sessionToken));
  }

  async register(): Promise<AuthSessionResult> {
    throw new AuthServiceError('registration_failed');
  }
}

describe('PostgreSQL App Server history projection and authenticated read API', () => {
  let api: ProductApiServer;
  let baseUrl: string;
  let database: ProductDatabase;
  let history: PostgresHistoryRepository;
  let repository: PostgresAuthRepository;
  let root: string;
  let scopeA: HistoryScope;
  let scopeB: HistoryScope;
  let workspaceA: string;
  let workspaceB: string;
  let sharedWorkspace: string;
  let userA: string;
  let userB: string;
  const tokenA = token();
  const tokenB = token();

  beforeAll(async () => {
    database = requireProductDatabaseFromEnv();
    await database.migrate();
    repository = new PostgresAuthRepository(database);
    history = new PostgresHistoryRepository(database);
    const expiresAt = new Date(Date.now() + 60 * 60_000);
    const accountA = await repository.registerAccount({
      email: `${runPrefix}-a@example.invalid`, displayName: null,
      passwordHash: placeholderPasswordHash,
      workspaceName: 'History A', workspaceSlug: `${runPrefix}-a`,
      sessionTokenHash: hashSessionToken(tokenA), sessionExpiresAt: expiresAt,
    });
    const accountB = await repository.registerAccount({
      email: `${runPrefix}-b@example.invalid`, displayName: null,
      passwordHash: placeholderPasswordHash,
      workspaceName: 'History B', workspaceSlug: `${runPrefix}-b`,
      sessionTokenHash: hashSessionToken(tokenB), sessionExpiresAt: expiresAt,
    });
    userA = accountA.context.user.id;
    userB = accountB.context.user.id;
    workspaceA = accountA.defaultWorkspace.id;
    workspaceB = accountB.defaultWorkspace.id;
    const shared = await database.query<{ id: string }>(
      `INSERT INTO workspaces (slug, name, owner_user_id)
       VALUES ($1, 'Shared history', $2)
       RETURNING id`,
      [`${runPrefix}-shared`, userA],
    );
    sharedWorkspace = shared.rows[0].id;
    await database.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role)
       VALUES ($1, $2, 'owner'), ($1, $3, 'admin')`,
      [sharedWorkspace, userA, userB],
    );
    scopeA = { userId: userA, workspaceId: sharedWorkspace };
    scopeB = { userId: userB, workspaceId: sharedWorkspace };
    root = await mkdtemp(path.join(os.tmpdir(), 'kodex-history-pg-'));

    const config: ProductApiConfig = {
      host: '127.0.0.1', port: 0, allowedHosts: new Set(),
      allowedOrigins: new Set([allowedOrigin]), cookieSecret: Buffer.alloc(32, 7),
      secureCookies: false, sessionTtlMs: 60 * 60_000, maxBodyBytes: 65_536,
    };
    api = new ProductApiServer(new RepositoryAuthApplication(repository), config, history);
    const port = await api.listen();
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await api?.close();
    if (root) await rm(root, { recursive: true, force: true });
    if (database) {
      await database.query('DELETE FROM workspaces WHERE slug LIKE $1', [`${runPrefix}-%`]);
      await database.query('DELETE FROM users WHERE email LIKE $1', [`${runPrefix}-%`]);
      await database.close();
    }
  });

  async function historyGet(
    sessionToken: string,
    workspaceId: string,
    pathname: string,
    headerWorkspace = workspaceId,
  ): Promise<Response> {
    const separator = pathname.includes('?') ? '&' : '?';
    return fetch(`${baseUrl}${pathname}${separator}workspace_id=${workspaceId}`, {
      headers: {
        Cookie: cookie(sessionToken),
        Origin: allowedOrigin,
        [PRODUCT_WORKSPACE_HEADER_NAME]: headerWorkspace,
      },
    });
  }

  it('is idempotent across duplicate/replayed and out-of-order lifecycle events', async () => {
    const threadId = randomUUID();
    const turnId = randomUUID();
    const itemId = randomUUID();
    const normalizer = new HistoryEventNormalizer({
      repositoryRoot: root,
      sourceInstance: `kodex-app-server:${sharedWorkspace}:${userA}`,
    });
    const startedThread = normalizer.normalize({
      type: 'notification',
      notification: {
        method: 'thread/started',
        params: { thread: {
          id: threadId, sessionId: randomUUID(), createdAt: 1_000, updatedAt: 1_000,
          cwd: root, projectId: null, name: 'Replay-safe', modelProvider: 'openai',
          source: 'appServer', parentThreadId: null, forkedFromId: null,
        } },
      },
    } as unknown as RuntimeEvent)!;
    const completedItem = normalizer.normalize({
      type: 'notification',
      notification: {
        method: 'item/completed',
        params: {
          threadId, turnId, completedAtMs: 1_002_000,
          item: {
            id: itemId, type: 'commandExecution', status: 'completed',
            command: 'OPENAI_API_KEY=sk-never-store-this npm test', cwd: root,
            commandActions: [], source: 'agent',
            aggregatedOutput: 'Cookie: session=never-store-this', exitCode: 0, durationMs: 10,
          },
        },
      },
    } as unknown as RuntimeEvent)!;
    const startedItem = normalizer.normalize({
      type: 'notification',
      notification: {
        method: 'item/started',
        params: {
          threadId, turnId, startedAtMs: 1_001_000,
          item: {
            id: itemId, type: 'commandExecution', status: 'inProgress',
            command: 'npm test', cwd: root, commandActions: [], source: 'agent',
            aggregatedOutput: null, exitCode: null, durationMs: null,
          },
        },
      },
    } as unknown as RuntimeEvent)!;

    await history.ingest(scopeA, startedThread);
    await history.ingest(scopeA, completedItem);
    await history.ingest(scopeA, completedItem);
    await history.ingest(scopeA, startedItem);

    const rows = await database.query<{
      event_count: string;
      item_payload: string;
      item_status: string;
      tool_status: string;
    }>(
      `SELECT
         (SELECT count(*) FROM agent_events e
          WHERE e.workspace_id = $1 AND e.created_by_user_id = $2 AND e.thread_id = t.id) AS event_count,
         i.lifecycle_status AS item_status,
         i.payload::text AS item_payload,
         c.status AS tool_status
       FROM agent_threads t
       JOIN agent_turns turn_record ON turn_record.thread_id = t.id
       JOIN agent_items i ON i.turn_id = turn_record.id
       JOIN tool_calls c ON c.item_id = i.id
       WHERE t.workspace_id = $1 AND t.created_by_user_id = $2 AND t.codex_thread_id = $3`,
      [sharedWorkspace, userA, threadId],
    );
    expect(rows.rows[0]).toMatchObject({
      event_count: '3', item_status: 'completed', tool_status: 'completed',
    });
    expect(rows.rows[0].item_payload).not.toContain('sk-never-store-this');
    expect(rows.rows[0].item_payload).not.toContain('never-store-this');
    expect(Buffer.byteLength(rows.rows[0].item_payload, 'utf8')).toBeLessThanOrEqual(65_536);
  });

  it('never regresses a newer thread state when an older semantic event is replayed', async () => {
    const threadId = randomUUID();
    const archived = {
      ...threadEvent(scopeA, threadId, '2026-01-10T00:00:00.000Z', 'archived'),
      eventId: `thread:${threadId}:archived`,
      eventType: 'thread.archived',
      thread: {
        ...threadEvent(scopeA, threadId, '2026-01-10T00:00:00.000Z').thread,
        status: 'archived' as const,
        sourceUpdatedAt: '2026-01-10T00:00:00.000Z',
      },
    };
    const unarchived = {
      ...threadEvent(scopeA, threadId, '2026-01-11T00:00:00.000Z', 'unarchived'),
      eventId: `thread:${threadId}:unarchived`,
      eventType: 'thread.unarchived',
      thread: {
        ...threadEvent(scopeA, threadId, '2026-01-11T00:00:00.000Z').thread,
        status: 'active' as const,
        title: 'Newest title',
        sourceUpdatedAt: '2026-01-11T00:00:00.000Z',
      },
    };
    const replayedArchive = {
      ...archived,
      occurredAt: '2026-01-12T00:00:00.000Z',
      thread: {
        ...archived.thread,
        title: 'Stale replay title',
        sourceUpdatedAt: '2026-01-12T00:00:00.000Z',
      },
    };

    await history.ingest(scopeA, archived);
    await history.ingest(scopeA, unarchived);
    await history.ingest(scopeA, replayedArchive);

    const result = await database.query<{
      event_count: string;
      source_updated_at: Date;
      status: string;
      title: string;
    }>(
      `SELECT
         thread_record.status,
         thread_record.title,
         thread_record.source_updated_at,
         (SELECT count(*) FROM agent_events event_record
          WHERE event_record.workspace_id = $1
            AND event_record.created_by_user_id = $2
            AND event_record.thread_id = thread_record.id) AS event_count
       FROM agent_threads thread_record
       WHERE thread_record.workspace_id = $1
         AND thread_record.created_by_user_id = $2
         AND thread_record.codex_thread_id = $3`,
      [sharedWorkspace, userA, threadId],
    );
    expect(result.rows[0]).toMatchObject({
      status: 'active', title: 'Newest title', event_count: '2',
    });
    expect(result.rows[0].source_updated_at.toISOString())
      .toBe('2026-01-11T00:00:00.000Z');
  });

  it('keeps separate approvals when a raw JSON-RPC id is reused and resolves each row', async () => {
    const threadId = randomUUID();
    const turnId = randomUUID();
    const firstItemId = randomUUID();
    const secondItemId = randomUUID();
    const normalizer = new HistoryEventNormalizer({
      repositoryRoot: root,
      sourceInstance: `kodex-app-server:${sharedWorkspace}:${userA}`,
    });
    const approvalRequest = (itemId: string, startedAtMs: number) => ({
      method: 'item/commandExecution/requestApproval',
      id: 'reused-json-rpc-id',
      params: {
        threadId, turnId, itemId, startedAtMs,
        environmentId: null, command: 'npm test', cwd: root,
      },
    });
    const firstRequest = approvalRequest(firstItemId, 10_000);
    const secondRequest = approvalRequest(secondItemId, 20_000);
    const requestedEvents = [firstRequest, secondRequest].map((request) => normalizer.normalize({
      type: 'server-request', request, ownerId: 'ui-1',
    } as unknown as RuntimeEvent)!);
    for (const event of requestedEvents) await history.ingest(scopeA, event);

    const requestedLedger = await database.query<{ count: string }>(
      `SELECT count(*)
       FROM agent_events event_record
       JOIN agent_threads thread_record ON thread_record.id = event_record.thread_id
       WHERE event_record.workspace_id = $1
         AND event_record.created_by_user_id = $2
         AND thread_record.codex_thread_id = $3
         AND event_record.event_type = 'approval.requested'`,
      [sharedWorkspace, userA, threadId],
    );
    expect(requestedLedger.rows[0].count).toBe('2');

    const resolvedEvents = [
      normalizer.normalize({
        type: 'server-request-resolved', requestId: 'reused-json-rpc-id', reason: 'answered',
        request: firstRequest, response: { decision: 'accept' },
      } as unknown as RuntimeEvent)!,
      normalizer.normalize({
        type: 'server-request-resolved', requestId: 'reused-json-rpc-id', reason: 'answered',
        request: secondRequest, response: { decision: 'decline' },
      } as unknown as RuntimeEvent)!,
    ];
    for (const event of resolvedEvents) await history.ingest(scopeA, event);

    const approvals = await database.query<{
      codex_request_id: string;
      item_id: string;
      status: string;
    }>(
      `SELECT
         approval_record.codex_request_id,
         approval_record.request_payload ->> 'itemId' AS item_id,
         approval_record.status
       FROM approvals approval_record
       JOIN agent_threads thread_record ON thread_record.id = approval_record.thread_id
       WHERE approval_record.workspace_id = $1
         AND approval_record.created_by_user_id = $2
         AND thread_record.codex_thread_id = $3
       ORDER BY item_id`,
      [sharedWorkspace, userA, threadId],
    );
    expect(approvals.rows).toHaveLength(2);
    expect(new Set(approvals.rows.map((row) => row.codex_request_id)).size).toBe(2);
    expect(approvals.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ item_id: firstItemId, status: 'approved' }),
      expect.objectContaining({ item_id: secondItemId, status: 'denied' }),
    ]));
    expect(JSON.stringify(approvals.rows)).not.toContain('reused-json-rpc-id');
    const finalLedger = await database.query<{ count: string }>(
      `SELECT count(*)
       FROM agent_events event_record
       JOIN agent_threads thread_record ON thread_record.id = event_record.thread_id
       WHERE event_record.workspace_id = $1
         AND event_record.created_by_user_id = $2
         AND thread_record.codex_thread_id = $3
         AND event_record.event_type LIKE 'approval.%'`,
      [sharedWorkspace, userA, threadId],
    );
    expect(finalLedger.rows[0].count).toBe('4');
  });

  it('retries an outage in order and replays the same durable spool after restart', async () => {
    const retryThread = randomUUID();
    let unavailable = true;
    const attempts: string[] = [];
    const transientSink: HistoryEventSink = {
      ingest: async (eventScope, event) => {
        attempts.push(event.eventId);
        if (unavailable) throw new Error('database unavailable');
        await history.ingest(eventScope, event);
      },
    };
    const retryDirectory = path.join(root, 'retry-outbox');
    const retrying = new DurableHistoryOutbox({
      directory: retryDirectory,
      scope: scopeA,
      sink: transientSink,
      retryInitialMs: 20,
      retryMaximumMs: 20,
    });
    retrying.start();
    retrying.enqueue(threadEvent(scopeA, retryThread, '2026-01-01T00:00:00.000Z'));
    await waitUntil(() => retrying.status().lastError === 'database_unavailable');
    unavailable = false;
    await waitUntil(() => retrying.status().pendingRecords === 0);
    expect(attempts).toEqual([
      `thread:${retryThread}:started`,
      `thread:${retryThread}:started`,
    ]);
    await retrying.stop();

    const replayThread = randomUUID();
    const replayDirectory = path.join(root, 'restart-outbox');
    const failed = new DurableHistoryOutbox({
      directory: replayDirectory,
      scope: scopeA,
      sink: { ingest: async () => { throw new Error('database unavailable'); } },
      retryInitialMs: 10_000,
      retryMaximumMs: 10_000,
    });
    failed.start();
    failed.enqueue(threadEvent(scopeA, replayThread, '2026-01-01T00:00:01.000Z'));
    await waitUntil(() => failed.status().lastError === 'database_unavailable');
    await failed.stop(50);
    const restarted = new DurableHistoryOutbox({
      directory: replayDirectory, scope: scopeA, sink: history,
    });
    restarted.start();
    await waitUntil(() => restarted.status().pendingRecords === 0);
    await restarted.stop();
    const replayed = await database.query<{ count: string }>(
      `SELECT count(*) FROM agent_threads
       WHERE workspace_id = $1 AND created_by_user_id = $2 AND codex_thread_id = $3`,
      [sharedWorkspace, userA, replayThread],
    );
    expect(replayed.rows[0].count).toBe('1');
  });

  it('enforces current-user/workspace isolation and stable cursor pagination in the API', async () => {
    const userAThreads = [0, 1, 2].map(() => randomUUID());
    const userBThread = randomUUID();
    for (const [index, threadId] of userAThreads.entries()) {
      await history.ingest(
        scopeA,
        threadEvent(scopeA, threadId, `2026-02-0${index + 1}T00:00:00.000Z`),
      );
    }
    await history.ingest(scopeB, threadEvent(scopeB, userBThread, '2026-02-02T12:00:00.000Z'));

    const first = await historyGet(tokenA, sharedWorkspace, '/api/history/threads?limit=2');
    expect(first.status).toBe(200);
    const firstBody = await first.json() as { nextCursor: string; threads: Array<{ threadId: string }> };
    expect(firstBody.threads).toHaveLength(2);
    expect(firstBody.threads.every((thread) => thread.threadId !== userBThread)).toBe(true);

    const insertedAfterPage = randomUUID();
    await history.ingest(
      scopeA,
      threadEvent(scopeA, insertedAfterPage, '2026-03-01T00:00:00.000Z'),
    );
    const second = await historyGet(
      tokenA,
      sharedWorkspace,
      `/api/history/threads?limit=50&cursor=${encodeURIComponent(firstBody.nextCursor)}`,
    );
    expect(second.status).toBe(200);
    const secondBody = await second.json() as { threads: Array<{ threadId: string }> };
    const pageIds = [...firstBody.threads, ...secondBody.threads].map((thread) => thread.threadId);
    expect(new Set(pageIds).size).toBe(pageIds.length);
    expect(pageIds).not.toContain(insertedAfterPage);
    expect(pageIds).not.toContain(userBThread);

    const userBPage = await historyGet(tokenB, sharedWorkspace, '/api/history/threads?limit=50');
    expect(userBPage.status).toBe(200);
    expect((await userBPage.json() as { threads: Array<{ threadId: string }> }).threads.map((thread) => thread.threadId))
      .toEqual([userBThread]);

    const emptyOwnedWorkspace = await historyGet(tokenA, workspaceA, '/api/history/threads');
    expect(emptyOwnedWorkspace.status).toBe(200);
    expect(await emptyOwnedWorkspace.json()).toMatchObject({ threads: [], nextCursor: null });
    expect((await historyGet(
      tokenA, workspaceA, `/api/history/threads/${userAThreads[0]}`,
    )).status).toBe(404);

    expect((await historyGet(
      tokenA, sharedWorkspace, '/api/history/threads', workspaceA,
    )).status).toBe(403);
    expect((await historyGet(tokenA, workspaceB, '/api/history/threads')).status).toBe(403);
    expect((await historyGet(tokenA, sharedWorkspace, '/api/history/threads?limit=51')).status).toBe(400);
    expect((await historyGet(tokenA, sharedWorkspace, '/api/history/threads?limit=2&limit=3')).status).toBe(400);
    expect((await historyGet(tokenA, sharedWorkspace, '/api/history/threads?cursor=not-valid!')).status).toBe(400);
    expect((await historyGet(
      tokenA, sharedWorkspace, `/api/history/threads/${userBThread}`,
    )).status).toBe(404);
  });

  it('returns one owned thread with turns/items/tool calls/approvals only', async () => {
    const threadId = randomUUID();
    const turnId = randomUUID();
    const itemId = randomUUID();
    const occurredAt = '2026-04-01T00:00:00.000Z';
    await history.ingest(scopeA, threadEvent(scopeA, threadId, occurredAt));
    await history.ingest(scopeA, {
      ...threadEvent(scopeA, threadId, occurredAt, 'detail'),
      eventId: `item:${itemId}:completed`,
      eventType: 'item.completed',
      turn: {
        codexTurnId: turnId, status: 'completed', lifecycleRank: 2,
        sourceSortKey: `0000000000001000:${turnId}`,
        startedAt: occurredAt, completedAt: occurredAt,
      },
      item: {
        codexItemId: itemId, itemType: 'commandExecution', role: null,
        payload: {
          type: 'commandExecution',
          nested: {
            authorization: 'Bearer browser-secret',
            sourceInstance: 'internal-worker', sourceEventId: 'internal-event',
            embeddingVector: [0.1, 0.2], contentChecksum: 'internal-checksum',
            sessionToken: 'internal-session', ragMetadata: { source: 'internal-rag' },
          },
        },
        sourceSortKey: `0000000000001001:${itemId}`,
        status: 'completed', lifecycleRank: 2,
        startedAt: occurredAt, completedAt: occurredAt,
      },
      toolCall: {
        codexCallId: itemId, toolName: 'shell', status: 'completed',
        arguments: { command: 'npm test', apiKey: 'internal-tool-secret' }, result: { exitCode: 0 },
        requestedAt: occurredAt, startedAt: occurredAt, completedAt: occurredAt,
      },
      approval: {
        codexRequestId: `string:${randomUUID()}`,
        approvalType: 'item/commandExecution/requestApproval', status: 'approved',
        requestPayload: { reason: 'test', cookie: 'internal-cookie' }, responsePayload: { decision: 'accept' },
        requestedAt: occurredAt, resolvedAt: occurredAt,
      },
    });
    const response = await historyGet(
      tokenA, sharedWorkspace, `/api/history/threads/${threadId}`,
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      thread: { threadId },
      turns: [{ turnId, status: 'completed' }],
      items: [{ itemId, turnId, status: 'completed' }],
      toolCalls: [{ callId: itemId, turnId, status: 'completed' }],
      approvals: [{ turnId, status: 'approved' }],
      omitted: { items: false, toolCalls: false, approvals: false },
    });
    expect(Object.keys(body.thread).sort()).toEqual([
      'createdAt', 'projectName', 'status', 'threadId', 'title', 'updatedAt',
    ]);
    expect(Object.keys(body.items[0].payload).sort()).toEqual(['content', 'truncated']);
    expect(typeof body.items[0].payload.content).toBe('string');
    expect(body.items[0].payload).not.toHaveProperty('type');
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('browser-secret');
    expect(serialized).not.toContain('internal-worker');
    expect(serialized).not.toContain('internal-event');
    expect(serialized).not.toContain('internal-checksum');
    expect(serialized).not.toContain('internal-session');
    expect(serialized).not.toContain('internal-rag');
    expect(serialized).not.toContain('internal-tool-secret');
    expect(serialized).not.toContain('internal-cookie');
    expect(serialized).not.toContain('embedding');
    expect(body.thread).not.toHaveProperty('project.id');
    expect(body).not.toHaveProperty('source_instance');
  });

  it('rejects revoked sessions and removed memberships at read time', async () => {
    await database.query(
      'UPDATE auth_sessions SET revoked_at = now() WHERE token_hash = $1',
      [hashSessionToken(tokenA)],
    );
    expect((await historyGet(tokenA, sharedWorkspace, '/api/history/threads')).status).toBe(401);

    await database.query(
      'DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
      [sharedWorkspace, userB],
    );
    expect((await historyGet(tokenB, sharedWorkspace, '/api/history/threads')).status).toBe(403);
  });
});
