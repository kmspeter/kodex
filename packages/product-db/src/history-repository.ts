import { createHash } from 'node:crypto';
import { isUuid } from '@kodex/product-contract';
import type { PoolClient } from 'pg';
import type { ProductDatabase } from './database.js';
import {
  HistoryCursorError,
  type HistoryApprovalRecord,
  type HistoryEventSink,
  type HistoryIngestEvent,
  type HistoryItemRecord,
  type HistoryReader,
  type HistoryScope,
  type HistoryThreadDetail,
  type HistoryThreadPage,
  type HistoryThreadStatus,
  type HistoryThreadSummary,
  type HistoryToolCallRecord,
  type HistoryTurnRecord,
} from './history-types.js';

interface ThreadRow {
  created_at: Date;
  cursor_id: string;
  id: string;
  project_id: string;
  project_name: string;
  status: HistoryThreadStatus;
  title: string | null;
  updated_at: Date;
}

interface TurnRow {
  completed_at: Date | null;
  cursor_id: string;
  id: string;
  source_sort_key: string;
  started_at: Date;
  status: HistoryTurnRecord['status'];
}

interface ItemRow {
  completed_at: Date | null;
  id: string;
  item_type: string;
  lifecycle_status: HistoryItemRecord['status'];
  payload: Record<string, unknown>;
  role: string | null;
  started_at: Date | null;
  turn_id: string;
}

interface ToolCallRow {
  arguments: Record<string, unknown>;
  completed_at: Date | null;
  id: string;
  requested_at: Date;
  result: Record<string, unknown> | null;
  started_at: Date | null;
  status: HistoryToolCallRecord['status'];
  tool_name: string;
  turn_id: string;
}

interface ApprovalRow {
  approval_type: string;
  id: string;
  request_payload: Record<string, unknown>;
  requested_at: Date;
  resolved_at: Date | null;
  response_payload: Record<string, unknown> | null;
  status: HistoryApprovalRecord['status'];
  turn_id: string | null;
}

interface CursorPayload {
  id: string;
  key: string;
  kind: 'thread' | 'turn';
  version: 1;
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeCursor(value: string | undefined, kind: CursorPayload['kind']): CursorPayload | undefined {
  if (!value) return undefined;
  if (value.length > 512) throw new HistoryCursorError();
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<CursorPayload>;
    if (
      parsed.version !== 1
      || parsed.kind !== kind
      || typeof parsed.key !== 'string'
      || parsed.key.length === 0
      || parsed.key.length > 256
      || !isUuid(parsed.id)
    ) {
      throw new HistoryCursorError();
    }
    return parsed as CursorPayload;
  } catch (error) {
    if (error instanceof HistoryCursorError) throw error;
    throw new HistoryCursorError();
  }
}

function assertScope(scope: HistoryScope): void {
  if (!isUuid(scope.userId) || !isUuid(scope.workspaceId)) {
    throw new Error('History scope must contain valid user and workspace IDs.');
  }
}

function stableOrdinal(value: string): string {
  const digest = createHash('sha256').update(value).digest();
  return (digest.readBigUInt64BE(0) & 0x7fff_ffff_ffff_ffffn).toString();
}

function asDate(value: string | undefined, fallback: string): Date {
  const parsed = new Date(value ?? fallback);
  if (!Number.isFinite(parsed.getTime())) return new Date(fallback);
  return parsed;
}

function threadFromRow(row: ThreadRow): HistoryThreadSummary {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    project: { id: row.project_id, name: row.project_name },
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export class PostgresHistoryRepository implements HistoryEventSink, HistoryReader {
  constructor(private readonly database: ProductDatabase) {}

  async ingest(scope: HistoryScope, event: HistoryIngestEvent): Promise<void> {
    assertScope(scope);
    if (event.version !== 1 || event.thread.codexThreadId.length === 0) {
      throw new Error('History event is invalid.');
    }
    await this.database.transaction(async (client) => {
      const ledgerKey = `${scope.workspaceId}\u001f${event.sourceInstance}\u001f${event.eventId}`;
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [ledgerKey],
      );
      const duplicate = await client.query(
        `SELECT 1
         FROM agent_events
         WHERE workspace_id = $1
           AND source_instance = $2
           AND source_event_id = $3
         LIMIT 1`,
        [scope.workspaceId, event.sourceInstance, event.eventId],
      );
      if ((duplicate.rowCount ?? 0) > 0) return;

      const projectId = await this.#upsertProject(client, scope, event);
      const threadId = await this.#upsertThread(client, scope, projectId, event);
      const turnId = event.turn
        ? await this.#upsertTurn(client, scope, threadId, event)
        : undefined;
      const itemId = event.item && turnId
        ? await this.#upsertItem(client, scope, turnId, event)
        : undefined;
      if (event.toolCall && turnId) {
        await this.#upsertToolCall(client, scope, threadId, turnId, itemId, event);
      }
      if (event.approval) {
        await this.#upsertApproval(client, scope, threadId, turnId, itemId, event);
      }
      const ledger = await client.query(
        `INSERT INTO agent_events
          (workspace_id, created_by_user_id, thread_id, turn_id, item_id,
           source_instance, source_event_id, event_type, sequence, payload, occurred_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (workspace_id, source_instance, source_event_id) DO NOTHING
         RETURNING id`,
        [
          scope.workspaceId,
          scope.userId,
          threadId,
          turnId ?? null,
          itemId ?? null,
          event.sourceInstance,
          event.eventId,
          event.eventType,
          stableOrdinal(event.eventId),
          event.payload,
          asDate(event.occurredAt, event.occurredAt),
        ],
      );
      if ((ledger.rowCount ?? 0) !== 1) {
        throw new Error('History event ledger claim conflicted during projection.');
      }
    });
  }

  async #upsertProject(
    client: PoolClient,
    scope: HistoryScope,
    event: HistoryIngestEvent,
  ): Promise<string> {
    const result = await client.query<{ id: string }>(
      `INSERT INTO projects
        (workspace_id, created_by_user_id, name, external_key, metadata, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (workspace_id, created_by_user_id, external_key)
         WHERE external_key IS NOT NULL AND created_by_user_id IS NOT NULL
       DO UPDATE SET
         name = EXCLUDED.name,
         metadata = projects.metadata || EXCLUDED.metadata,
         updated_at = GREATEST(projects.updated_at, EXCLUDED.updated_at)
       RETURNING id`,
      [
        scope.workspaceId,
        scope.userId,
        event.project.name,
        event.project.externalKey,
        event.project.metadata,
        asDate(event.thread.sourceUpdatedAt, event.occurredAt),
      ],
    );
    return result.rows[0].id;
  }

  async #upsertThread(
    client: PoolClient,
    scope: HistoryScope,
    projectId: string,
    event: HistoryIngestEvent,
  ): Promise<string> {
    const sourceUpdatedAt = asDate(event.thread.sourceUpdatedAt, event.occurredAt);
    const createdAt = asDate(event.thread.createdAt, event.occurredAt);
    const titleProvided = Object.hasOwn(event.thread, 'title');
    const result = await client.query<{ id: string }>(
      `INSERT INTO agent_threads
        (workspace_id, project_id, created_by_user_id, codex_thread_id, title,
         status, metadata, created_at, updated_at, source_updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
       ON CONFLICT (workspace_id, created_by_user_id, codex_thread_id)
         WHERE created_by_user_id IS NOT NULL
       DO UPDATE SET
         project_id = CASE WHEN $10 THEN EXCLUDED.project_id ELSE agent_threads.project_id END,
         title = CASE
           WHEN $11 AND EXCLUDED.source_updated_at >= COALESCE(agent_threads.source_updated_at, '-infinity')
             THEN EXCLUDED.title
           ELSE agent_threads.title
         END,
         status = CASE
           WHEN EXCLUDED.source_updated_at >= COALESCE(agent_threads.source_updated_at, '-infinity')
             THEN EXCLUDED.status
           ELSE agent_threads.status
         END,
         metadata = agent_threads.metadata || EXCLUDED.metadata,
         source_updated_at = GREATEST(
           COALESCE(agent_threads.source_updated_at, '-infinity'),
           EXCLUDED.source_updated_at
         ),
         updated_at = GREATEST(agent_threads.updated_at, EXCLUDED.updated_at)
       RETURNING id`,
      [
        scope.workspaceId,
        projectId,
        scope.userId,
        event.thread.codexThreadId,
        event.thread.title ?? null,
        event.thread.status,
        event.thread.metadata ?? {},
        createdAt,
        sourceUpdatedAt,
        event.thread.projectIsAuthoritative,
        titleProvided,
      ],
    );
    return result.rows[0].id;
  }

  async #upsertTurn(
    client: PoolClient,
    scope: HistoryScope,
    threadId: string,
    event: HistoryIngestEvent,
  ): Promise<string> {
    const turn = event.turn!;
    const startedAt = asDate(turn.startedAt ?? undefined, event.occurredAt);
    const completedAt = turn.completedAt ? asDate(turn.completedAt, event.occurredAt) : null;
    const result = await client.query<{ id: string }>(
      `INSERT INTO agent_turns
        (workspace_id, thread_id, created_by_user_id, codex_turn_id, ordinal,
         status, started_at, completed_at, source_sort_key, lifecycle_rank, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (workspace_id, thread_id, codex_turn_id)
         WHERE codex_turn_id IS NOT NULL
       DO UPDATE SET
         status = CASE
           WHEN EXCLUDED.lifecycle_rank >= agent_turns.lifecycle_rank THEN EXCLUDED.status
           ELSE agent_turns.status
         END,
         started_at = LEAST(agent_turns.started_at, EXCLUDED.started_at),
         completed_at = CASE
           WHEN EXCLUDED.lifecycle_rank >= agent_turns.lifecycle_rank
             THEN COALESCE(EXCLUDED.completed_at, agent_turns.completed_at)
           ELSE agent_turns.completed_at
         END,
         source_sort_key = LEAST(
           COALESCE(agent_turns.source_sort_key, EXCLUDED.source_sort_key),
           EXCLUDED.source_sort_key
         ),
         lifecycle_rank = GREATEST(agent_turns.lifecycle_rank, EXCLUDED.lifecycle_rank),
         updated_at = GREATEST(agent_turns.updated_at, EXCLUDED.updated_at)
       RETURNING id`,
      [
        scope.workspaceId,
        threadId,
        scope.userId,
        turn.codexTurnId,
        stableOrdinal(turn.codexTurnId),
        turn.status,
        startedAt,
        completedAt,
        turn.sourceSortKey,
        turn.lifecycleRank,
        asDate(event.occurredAt, event.occurredAt),
      ],
    );
    return result.rows[0].id;
  }

  async #upsertItem(
    client: PoolClient,
    scope: HistoryScope,
    turnId: string,
    event: HistoryIngestEvent,
  ): Promise<string> {
    const item = event.item!;
    const result = await client.query<{ id: string }>(
      `INSERT INTO agent_items
        (workspace_id, turn_id, created_by_user_id, codex_item_id, sequence,
         item_type, role, payload, source_sort_key, lifecycle_status, lifecycle_rank,
         started_at, completed_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       ON CONFLICT (workspace_id, turn_id, codex_item_id)
         WHERE codex_item_id IS NOT NULL
       DO UPDATE SET
         item_type = CASE
           WHEN EXCLUDED.lifecycle_rank >= agent_items.lifecycle_rank THEN EXCLUDED.item_type
           ELSE agent_items.item_type
         END,
         role = CASE
           WHEN EXCLUDED.lifecycle_rank >= agent_items.lifecycle_rank THEN EXCLUDED.role
           ELSE agent_items.role
         END,
         payload = CASE
           WHEN EXCLUDED.lifecycle_rank >= agent_items.lifecycle_rank THEN EXCLUDED.payload
           ELSE agent_items.payload
         END,
         source_sort_key = LEAST(
           COALESCE(agent_items.source_sort_key, EXCLUDED.source_sort_key),
           EXCLUDED.source_sort_key
         ),
         lifecycle_status = CASE
           WHEN EXCLUDED.lifecycle_rank >= agent_items.lifecycle_rank THEN EXCLUDED.lifecycle_status
           ELSE agent_items.lifecycle_status
         END,
         lifecycle_rank = GREATEST(agent_items.lifecycle_rank, EXCLUDED.lifecycle_rank),
         started_at = CASE
           WHEN agent_items.started_at IS NULL THEN EXCLUDED.started_at
           WHEN EXCLUDED.started_at IS NULL THEN agent_items.started_at
           ELSE LEAST(agent_items.started_at, EXCLUDED.started_at)
         END,
         completed_at = CASE
           WHEN EXCLUDED.lifecycle_rank >= agent_items.lifecycle_rank
             THEN COALESCE(EXCLUDED.completed_at, agent_items.completed_at)
           ELSE agent_items.completed_at
         END,
         updated_at = GREATEST(agent_items.updated_at, EXCLUDED.updated_at)
       RETURNING id`,
      [
        scope.workspaceId,
        turnId,
        scope.userId,
        item.codexItemId,
        stableOrdinal(item.codexItemId),
        item.itemType,
        item.role ?? null,
        item.payload,
        item.sourceSortKey,
        item.status,
        item.lifecycleRank,
        item.startedAt ? asDate(item.startedAt, event.occurredAt) : null,
        item.completedAt ? asDate(item.completedAt, event.occurredAt) : null,
        asDate(event.occurredAt, event.occurredAt),
      ],
    );
    return result.rows[0].id;
  }

  async #upsertToolCall(
    client: PoolClient,
    scope: HistoryScope,
    threadId: string,
    turnId: string,
    itemId: string | undefined,
    event: HistoryIngestEvent,
  ): Promise<void> {
    const call = event.toolCall!;
    await client.query(
      `INSERT INTO tool_calls
        (workspace_id, thread_id, turn_id, item_id, created_by_user_id,
         codex_call_id, tool_name, status, arguments, result,
         requested_at, started_at, completed_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       ON CONFLICT (workspace_id, thread_id, codex_call_id)
       DO UPDATE SET
         item_id = COALESCE(EXCLUDED.item_id, tool_calls.item_id),
         tool_name = EXCLUDED.tool_name,
         status = CASE
           WHEN tool_calls.status IN ('completed', 'failed', 'cancelled')
             AND EXCLUDED.status IN ('requested', 'running') THEN tool_calls.status
           ELSE EXCLUDED.status
         END,
         arguments = CASE
           WHEN tool_calls.status IN ('completed', 'failed', 'cancelled')
             AND EXCLUDED.status IN ('requested', 'running') THEN tool_calls.arguments
           ELSE EXCLUDED.arguments
         END,
         result = COALESCE(EXCLUDED.result, tool_calls.result),
         requested_at = LEAST(tool_calls.requested_at, EXCLUDED.requested_at),
         started_at = CASE
           WHEN tool_calls.started_at IS NULL THEN EXCLUDED.started_at
           WHEN EXCLUDED.started_at IS NULL THEN tool_calls.started_at
           ELSE LEAST(tool_calls.started_at, EXCLUDED.started_at)
         END,
         completed_at = COALESCE(EXCLUDED.completed_at, tool_calls.completed_at),
         updated_at = GREATEST(tool_calls.updated_at, EXCLUDED.updated_at)`,
      [
        scope.workspaceId,
        threadId,
        turnId,
        itemId ?? null,
        scope.userId,
        call.codexCallId,
        call.toolName,
        call.status,
        call.arguments,
        call.result ?? null,
        asDate(call.requestedAt, event.occurredAt),
        call.startedAt ? asDate(call.startedAt, event.occurredAt) : null,
        call.completedAt ? asDate(call.completedAt, event.occurredAt) : null,
        asDate(event.occurredAt, event.occurredAt),
      ],
    );
  }

  async #upsertApproval(
    client: PoolClient,
    scope: HistoryScope,
    threadId: string,
    turnId: string | undefined,
    itemId: string | undefined,
    event: HistoryIngestEvent,
  ): Promise<void> {
    const approval = event.approval!;
    const toolCallResult = itemId && turnId
      ? await client.query<{ id: string }>(
        `SELECT id FROM tool_calls
         WHERE workspace_id = $1 AND created_by_user_id = $2
           AND thread_id = $3 AND turn_id = $4 AND item_id = $5
         LIMIT 1`,
        [scope.workspaceId, scope.userId, threadId, turnId, itemId],
      )
      : undefined;
    await client.query(
      `INSERT INTO approvals
        (workspace_id, thread_id, turn_id, tool_call_id, created_by_user_id,
         codex_request_id, approval_type, status, request_payload, response_payload,
         resolved_by_user_id, requested_at, resolved_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       ON CONFLICT (workspace_id, thread_id, codex_request_id)
       DO UPDATE SET
         turn_id = COALESCE(EXCLUDED.turn_id, approvals.turn_id),
         tool_call_id = COALESCE(EXCLUDED.tool_call_id, approvals.tool_call_id),
         status = CASE
           WHEN approvals.status <> 'pending' AND EXCLUDED.status = 'pending' THEN approvals.status
           ELSE EXCLUDED.status
         END,
         request_payload = CASE
           WHEN EXCLUDED.status = 'pending' THEN EXCLUDED.request_payload
           ELSE approvals.request_payload
         END,
         response_payload = COALESCE(EXCLUDED.response_payload, approvals.response_payload),
         resolved_by_user_id = COALESCE(EXCLUDED.resolved_by_user_id, approvals.resolved_by_user_id),
         requested_at = LEAST(approvals.requested_at, EXCLUDED.requested_at),
         resolved_at = COALESCE(EXCLUDED.resolved_at, approvals.resolved_at),
         updated_at = GREATEST(approvals.updated_at, EXCLUDED.updated_at)`,
      [
        scope.workspaceId,
        threadId,
        turnId ?? null,
        toolCallResult?.rows[0]?.id ?? null,
        scope.userId,
        approval.codexRequestId,
        approval.approvalType,
        approval.status,
        approval.requestPayload,
        approval.responsePayload ?? null,
        approval.status === 'approved' || approval.status === 'denied' ? scope.userId : null,
        asDate(approval.requestedAt, event.occurredAt),
        approval.resolvedAt ? asDate(approval.resolvedAt, event.occurredAt) : null,
        asDate(event.occurredAt, event.occurredAt),
      ],
    );
  }

  async listThreads(
    scope: HistoryScope,
    options: { cursor?: string; limit: number },
  ): Promise<HistoryThreadPage> {
    assertScope(scope);
    const cursor = decodeCursor(options.cursor, 'thread');
    const result = await this.database.query<ThreadRow>(
      `SELECT
         thread_record.codex_thread_id AS id,
         thread_record.id AS cursor_id,
         thread_record.title,
         thread_record.status,
         thread_record.created_at,
         thread_record.updated_at,
         project_record.id AS project_id,
         project_record.name AS project_name
       FROM agent_threads thread_record
       JOIN projects project_record
         ON project_record.id = thread_record.project_id
        AND project_record.workspace_id = thread_record.workspace_id
       WHERE thread_record.workspace_id = $1
         AND thread_record.created_by_user_id = $2
         AND thread_record.deleted_at IS NULL
         AND ($3::timestamptz IS NULL OR (thread_record.created_at, thread_record.id) < ($3, $4::uuid))
       ORDER BY thread_record.created_at DESC, thread_record.id DESC
       LIMIT $5`,
      [
        scope.workspaceId,
        scope.userId,
        cursor?.key ?? null,
        cursor?.id ?? null,
        options.limit + 1,
      ],
    );
    const hasMore = result.rows.length > options.limit;
    const pageRows = result.rows.slice(0, options.limit);
    const last = pageRows.at(-1);
    return {
      threads: pageRows.map(threadFromRow),
      nextCursor: hasMore && last
        ? encodeCursor({
          version: 1,
          kind: 'thread',
          key: last.created_at.toISOString(),
          id: last.cursor_id,
        })
        : null,
    };
  }

  async readThread(
    scope: HistoryScope,
    codexThreadId: string,
    options: { cursor?: string; limit: number },
  ): Promise<HistoryThreadDetail | undefined> {
    assertScope(scope);
    const cursor = decodeCursor(options.cursor, 'turn');
    const threadResult = await this.database.query<ThreadRow>(
      `SELECT
         thread_record.codex_thread_id AS id,
         thread_record.id AS cursor_id,
         thread_record.title,
         thread_record.status,
         thread_record.created_at,
         thread_record.updated_at,
         project_record.id AS project_id,
         project_record.name AS project_name
       FROM agent_threads thread_record
       JOIN projects project_record
         ON project_record.id = thread_record.project_id
        AND project_record.workspace_id = thread_record.workspace_id
       WHERE thread_record.workspace_id = $1
         AND thread_record.created_by_user_id = $2
         AND thread_record.codex_thread_id = $3
         AND thread_record.deleted_at IS NULL
       LIMIT 1`,
      [scope.workspaceId, scope.userId, codexThreadId],
    );
    const thread = threadResult.rows[0];
    if (!thread) return undefined;

    const turnsResult = await this.database.query<TurnRow>(
      `SELECT
         turn_record.codex_turn_id AS id,
         turn_record.id AS cursor_id,
         turn_record.status,
         turn_record.started_at,
         turn_record.completed_at,
         turn_record.source_sort_key
       FROM agent_turns turn_record
       JOIN agent_threads thread_record
         ON thread_record.id = turn_record.thread_id
        AND thread_record.workspace_id = turn_record.workspace_id
       WHERE turn_record.workspace_id = $1
         AND turn_record.created_by_user_id = $2
         AND thread_record.codex_thread_id = $3
         AND (
           $4::text IS NULL
           OR (turn_record.source_sort_key, turn_record.id) > ($4, $5::uuid)
         )
       ORDER BY turn_record.source_sort_key, turn_record.id
       LIMIT $6`,
      [
        scope.workspaceId,
        scope.userId,
        codexThreadId,
        cursor?.key ?? null,
        cursor?.id ?? null,
        options.limit + 1,
      ],
    );
    const hasMore = turnsResult.rows.length > options.limit;
    const turnRows = turnsResult.rows.slice(0, options.limit);
    const turnIds = turnRows.map((row) => row.id);
    const [itemsResult, callsResult] = turnIds.length > 0
      ? await Promise.all([
        this.database.query<ItemRow>(
          `SELECT
             item_record.codex_item_id AS id,
             turn_record.codex_turn_id AS turn_id,
             item_record.item_type,
             item_record.role,
             item_record.payload,
             item_record.lifecycle_status,
             item_record.started_at,
             item_record.completed_at
           FROM agent_items item_record
           JOIN agent_turns turn_record
             ON turn_record.id = item_record.turn_id
            AND turn_record.workspace_id = item_record.workspace_id
           JOIN agent_threads thread_record
             ON thread_record.id = turn_record.thread_id
            AND thread_record.workspace_id = turn_record.workspace_id
           WHERE item_record.workspace_id = $1
             AND item_record.created_by_user_id = $2
             AND thread_record.codex_thread_id = $3
             AND turn_record.codex_turn_id = ANY($4::text[])
           ORDER BY turn_record.source_sort_key, item_record.source_sort_key, item_record.id`,
          [scope.workspaceId, scope.userId, codexThreadId, turnIds],
        ),
        this.database.query<ToolCallRow>(
          `SELECT
             call_record.codex_call_id AS id,
             turn_record.codex_turn_id AS turn_id,
             call_record.tool_name,
             call_record.status,
             call_record.arguments,
             call_record.result,
             call_record.requested_at,
             call_record.started_at,
             call_record.completed_at
           FROM tool_calls call_record
           JOIN agent_turns turn_record
             ON turn_record.id = call_record.turn_id
            AND turn_record.workspace_id = call_record.workspace_id
           JOIN agent_threads thread_record
             ON thread_record.id = turn_record.thread_id
            AND thread_record.workspace_id = turn_record.workspace_id
           WHERE call_record.workspace_id = $1
             AND call_record.created_by_user_id = $2
             AND thread_record.codex_thread_id = $3
             AND turn_record.codex_turn_id = ANY($4::text[])
           ORDER BY turn_record.source_sort_key, call_record.requested_at, call_record.id`,
          [scope.workspaceId, scope.userId, codexThreadId, turnIds],
        ),
      ])
      : [{ rows: [] }, { rows: [] }];
    const approvalsResult = await this.database.query<ApprovalRow>(
      `SELECT
         approval_record.codex_request_id AS id,
         turn_record.codex_turn_id AS turn_id,
         approval_record.approval_type,
         approval_record.status,
         approval_record.request_payload,
         approval_record.response_payload,
         approval_record.requested_at,
         approval_record.resolved_at
       FROM approvals approval_record
       JOIN agent_threads thread_record
         ON thread_record.id = approval_record.thread_id
        AND thread_record.workspace_id = approval_record.workspace_id
       LEFT JOIN agent_turns turn_record
         ON turn_record.id = approval_record.turn_id
        AND turn_record.workspace_id = approval_record.workspace_id
       WHERE approval_record.workspace_id = $1
         AND approval_record.created_by_user_id = $2
         AND thread_record.codex_thread_id = $3
         AND (
           turn_record.codex_turn_id = ANY($4::text[])
           OR ($5::boolean AND approval_record.turn_id IS NULL)
         )
       ORDER BY approval_record.requested_at, approval_record.id`,
      [scope.workspaceId, scope.userId, codexThreadId, turnIds, !cursor],
    );

    const last = turnRows.at(-1);
    return {
      thread: threadFromRow(thread),
      turns: turnRows.map((row) => ({
        id: row.id,
        status: row.status,
        startedAt: row.started_at.toISOString(),
        completedAt: row.completed_at?.toISOString() ?? null,
      })),
      items: itemsResult.rows.map((row) => ({
        id: row.id,
        turnId: row.turn_id,
        itemType: row.item_type,
        role: row.role,
        payload: row.payload,
        status: row.lifecycle_status,
        startedAt: row.started_at?.toISOString() ?? null,
        completedAt: row.completed_at?.toISOString() ?? null,
      })),
      toolCalls: callsResult.rows.map((row) => ({
        id: row.id,
        turnId: row.turn_id,
        toolName: row.tool_name,
        status: row.status,
        arguments: row.arguments,
        result: row.result,
        requestedAt: row.requested_at.toISOString(),
        startedAt: row.started_at?.toISOString() ?? null,
        completedAt: row.completed_at?.toISOString() ?? null,
      })),
      approvals: approvalsResult.rows.map((row) => ({
        id: row.id,
        turnId: row.turn_id,
        approvalType: row.approval_type,
        status: row.status,
        requestPayload: row.request_payload,
        responsePayload: row.response_payload,
        requestedAt: row.requested_at.toISOString(),
        resolvedAt: row.resolved_at?.toISOString() ?? null,
      })),
      nextCursor: hasMore && last
        ? encodeCursor({ version: 1, kind: 'turn', key: last.source_sort_key, id: last.cursor_id })
        : null,
    };
  }
}
