import { createHash } from 'node:crypto';
import path from 'node:path';
import type {
  HistoryApprovalStatus,
  HistoryIngestEvent,
  HistoryItemSnapshot,
  HistoryProjectSnapshot,
  HistoryThreadSnapshot,
  HistoryToolCallSnapshot,
  HistoryToolStatus,
  HistoryTurnSnapshot,
  HistoryTurnStatus,
} from '@kodex/product-db';
import type { RuntimeEvent } from '../runtime.js';
import { sanitizeHistoryValue, sanitizedRecordWithinBytes } from './sanitize.js';

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isoFromMilliseconds(value: number | undefined, fallback: string): string {
  if (value === undefined) return fallback;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : fallback;
}

function isoFromSeconds(value: number | undefined, fallback: string): string {
  return isoFromMilliseconds(value === undefined ? undefined : value * 1_000, fallback);
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function eventHash(value: unknown): string {
  return hash(JSON.stringify(sanitizeHistoryValue(value))).slice(0, 32);
}

function sourceSortKey(occurredAt: string, id: string): string {
  const milliseconds = new Date(occurredAt).getTime();
  const safeMilliseconds = Number.isFinite(milliseconds) ? Math.max(0, milliseconds) : 0;
  return `${String(safeMilliseconds).padStart(16, '0')}:${id}`;
}

function turnStatus(value: unknown, fallback: HistoryTurnStatus): HistoryTurnStatus {
  if (value === 'completed') return 'completed';
  if (value === 'failed') return 'failed';
  if (value === 'interrupted') return 'interrupted';
  return fallback;
}

function toolStatus(value: unknown, completed: boolean): HistoryToolStatus {
  if (value === 'completed') return 'completed';
  if (value === 'failed') return 'failed';
  if (value === 'declined' || value === 'interrupted' || value === 'cancelled') return 'cancelled';
  return completed ? 'completed' : 'running';
}

function itemRole(item: UnknownRecord): string | null {
  if (item.type === 'userMessage') return 'user';
  if (item.type === 'agentMessage') return 'assistant';
  return null;
}

function cleanObject(value: unknown): Record<string, unknown> {
  const clean = sanitizeHistoryValue(value);
  return record(clean) ?? { value: clean };
}

function toolCallFromItem(
  item: UnknownRecord,
  lifecycle: 'started' | 'completed',
  occurredAt: string,
): HistoryToolCallSnapshot | undefined {
  const id = text(item.id);
  const type = text(item.type);
  if (!id || !type) return undefined;
  const status = toolStatus(item.status, lifecycle === 'completed');
  const completedAt = lifecycle === 'completed' ? occurredAt : null;
  if (type === 'commandExecution') {
    return {
      codexCallId: id,
      toolName: 'shell',
      status,
      arguments: cleanObject({
        command: item.command,
        cwd: item.cwd,
        commandActions: item.commandActions,
        source: item.source,
      }),
      result: lifecycle === 'completed'
        ? cleanObject({
          output: item.aggregatedOutput,
          exitCode: item.exitCode,
          durationMs: item.durationMs,
        })
        : null,
      requestedAt: occurredAt,
      startedAt: occurredAt,
      completedAt,
    };
  }
  if (type === 'mcpToolCall') {
    return {
      codexCallId: id,
      toolName: `mcp:${text(item.server) ?? 'unknown'}/${text(item.tool) ?? 'unknown'}`,
      status,
      arguments: cleanObject(item.arguments),
      result: lifecycle === 'completed'
        ? cleanObject({ result: item.result, error: item.error, durationMs: item.durationMs })
        : null,
      requestedAt: occurredAt,
      startedAt: occurredAt,
      completedAt,
    };
  }
  if (type === 'dynamicToolCall') {
    const namespace = text(item.namespace);
    return {
      codexCallId: id,
      toolName: `dynamic:${namespace ? `${namespace}/` : ''}${text(item.tool) ?? 'unknown'}`,
      status,
      arguments: cleanObject(item.arguments),
      result: lifecycle === 'completed'
        ? cleanObject({ contentItems: item.contentItems, success: item.success, durationMs: item.durationMs })
        : null,
      requestedAt: occurredAt,
      startedAt: occurredAt,
      completedAt,
    };
  }
  if (type === 'collabAgentToolCall') {
    return {
      codexCallId: id,
      toolName: `collaboration:${text(item.tool) ?? 'unknown'}`,
      status,
      arguments: cleanObject({
        senderThreadId: item.senderThreadId,
        receiverThreadIds: item.receiverThreadIds,
        prompt: item.prompt,
        model: item.model,
        reasoningEffort: item.reasoningEffort,
      }),
      result: lifecycle === 'completed' ? cleanObject({ agentsStates: item.agentsStates }) : null,
      requestedAt: occurredAt,
      startedAt: occurredAt,
      completedAt,
    };
  }
  if (type === 'fileChange') {
    return {
      codexCallId: id,
      toolName: 'file_change',
      status,
      arguments: cleanObject({ changes: item.changes }),
      result: lifecycle === 'completed' ? cleanObject({ status: item.status }) : null,
      requestedAt: occurredAt,
      startedAt: occurredAt,
      completedAt,
    };
  }
  return undefined;
}

function approvalStatus(reason: unknown, response: unknown): HistoryApprovalStatus {
  if (reason === 'timeout') return 'expired';
  if (reason === 'disconnect' || reason === 'app-server-restart') return 'cancelled';
  if (reason === 'unsupported') return 'denied';
  const responseRecord = record(response);
  if (responseRecord?.error) return 'denied';
  const decision = text(responseRecord?.decision)?.toLocaleLowerCase();
  if (decision && /(?:abort|decline|deny|cancel|reject)/u.test(decision)) return 'denied';
  return 'approved';
}

interface ApprovalIdentity {
  identity: string;
  mapKey: string;
  weak: boolean;
}

function approvalIdentitySeed(request: UnknownRecord): { mapKey: string; weak: boolean } | undefined {
  const method = text(request.method);
  const params = record(request.params);
  const threadId = text(params?.threadId);
  if (!method || !params || !threadId) return undefined;
  const itemId = text(params.itemId);
  const startedAtMs = number(params.startedAtMs);
  const approvalId = text(params.approvalId);
  const elicitationId = text(params.elicitationId);
  const publicCorrelation = {
    method,
    rawRequestIdType: typeof request.id,
    rawRequestIdHash: hash(String(request.id)),
    threadId,
    turnId: text(params.turnId) ?? null,
    itemId: itemId ?? null,
    startedAtMs: startedAtMs ?? null,
    approvalId: approvalId ?? null,
    elicitationId: elicitationId ?? null,
    serverName: text(params.serverName) ?? null,
    mode: text(params.mode) ?? null,
  };
  return {
    mapKey: hash(JSON.stringify(publicCorrelation)),
    weak: !itemId && startedAtMs === undefined && !approvalId && !elicitationId,
  };
}

export interface HistoryEventNormalizerOptions {
  maxEventBytes?: number;
  repositoryRoot: string;
  sourceInstance: string;
}

export class HistoryEventNormalizer {
  readonly maxEventBytes: number;
  readonly sourceInstance: string;
  #approvalIdentities = new Map<string, string>();
  #defaultProject: HistoryProjectSnapshot;
  #projectsByThread = new Map<string, HistoryProjectSnapshot>();

  constructor(options: HistoryEventNormalizerOptions) {
    this.maxEventBytes = options.maxEventBytes ?? 65_536;
    this.sourceInstance = options.sourceInstance;
    const root = path.resolve(options.repositoryRoot);
    this.#defaultProject = {
      externalKey: `runtime:${hash(root.toLocaleLowerCase())}`,
      name: path.basename(root).slice(0, 120) || 'Kodex project',
      metadata: { source: 'runtime-default' },
    };
  }

  normalize(runtimeEvent: RuntimeEvent, observedAt = new Date()): HistoryIngestEvent | undefined {
    const fallbackOccurredAt = observedAt.toISOString();
    let event: HistoryIngestEvent | undefined;
    if (runtimeEvent.type === 'notification') {
      event = this.#notification(runtimeEvent.notification as unknown as UnknownRecord, fallbackOccurredAt);
    } else if (runtimeEvent.type === 'server-request') {
      event = this.#approvalRequested(runtimeEvent.request as unknown as UnknownRecord, fallbackOccurredAt);
    } else if (runtimeEvent.type === 'server-request-resolved' && runtimeEvent.request) {
      event = this.#approvalResolved(
        runtimeEvent.request as unknown as UnknownRecord,
        runtimeEvent.reason,
        runtimeEvent.response,
        fallbackOccurredAt,
      );
    }
    if (!event) return undefined;
    return sanitizedRecordWithinBytes(
      event as unknown as Record<string, unknown>,
      this.maxEventBytes,
    ) as unknown as HistoryIngestEvent;
  }

  #base(
    eventType: string,
    eventId: string,
    occurredAt: string,
    thread: HistoryThreadSnapshot,
    payload: Record<string, unknown>,
  ): HistoryIngestEvent {
    return {
      version: 1,
      sourceInstance: this.sourceInstance,
      eventId,
      eventType,
      occurredAt,
      project: this.#projectsByThread.get(thread.codexThreadId) ?? this.#defaultProject,
      thread,
      payload,
    };
  }

  #thread(
    codexThreadId: string,
    occurredAt: string,
    values: Partial<HistoryThreadSnapshot> = {},
  ): HistoryThreadSnapshot {
    return {
      codexThreadId,
      status: 'active',
      sourceUpdatedAt: occurredAt,
      projectIsAuthoritative: false,
      ...values,
    };
  }

  #turn(
    codexTurnId: string,
    occurredAt: string,
    values: Partial<HistoryTurnSnapshot> = {},
  ): HistoryTurnSnapshot {
    return {
      codexTurnId,
      status: 'in_progress',
      lifecycleRank: 0,
      sourceSortKey: sourceSortKey(occurredAt, codexTurnId),
      startedAt: occurredAt,
      ...values,
    };
  }

  #item(
    item: UnknownRecord,
    lifecycle: 'started' | 'completed',
    occurredAt: string,
  ): HistoryItemSnapshot | undefined {
    const itemId = text(item.id);
    if (!itemId) return undefined;
    return {
      codexItemId: itemId,
      itemType: text(item.type) ?? 'unknown',
      role: itemRole(item),
      payload: cleanObject(item),
      sourceSortKey: sourceSortKey(occurredAt, itemId),
      status: lifecycle,
      lifecycleRank: lifecycle === 'completed' ? 2 : 1,
      startedAt: lifecycle === 'started' ? occurredAt : null,
      completedAt: lifecycle === 'completed' ? occurredAt : null,
    };
  }

  #notification(notification: UnknownRecord, fallback: string): HistoryIngestEvent | undefined {
    const method = text(notification.method);
    const params = record(notification.params);
    if (!method || !params) return undefined;

    if (method === 'thread/started') {
      const sourceThread = record(params.thread);
      const threadId = text(sourceThread?.id);
      if (!sourceThread || !threadId) return undefined;
      const occurredAt = isoFromSeconds(number(sourceThread.updatedAt) ?? number(sourceThread.createdAt), fallback);
      const cwd = text(sourceThread.cwd);
      const codexProjectId = text(sourceThread.projectId);
      const project: HistoryProjectSnapshot = {
        externalKey: codexProjectId
          ? `codex:${codexProjectId}`
          : `cwd:${hash((cwd ?? this.#defaultProject.externalKey).toLocaleLowerCase())}`,
        name: (cwd ? path.basename(cwd) : this.#defaultProject.name).slice(0, 120),
        metadata: { source: codexProjectId ? 'codex-project' : 'codex-cwd' },
      };
      this.#projectsByThread.set(threadId, project);
      const thread = this.#thread(threadId, occurredAt, {
        createdAt: isoFromSeconds(number(sourceThread.createdAt), occurredAt),
        sourceUpdatedAt: occurredAt,
        projectIsAuthoritative: true,
        title: text(sourceThread.name) ?? null,
        metadata: cleanObject({
          modelProvider: sourceThread.modelProvider,
          source: sourceThread.source,
          parentThreadId: sourceThread.parentThreadId,
          forkedFromId: sourceThread.forkedFromId,
        }),
      });
      const event = this.#base(
        'thread.started',
        `thread:${threadId}:started:${text(sourceThread.sessionId) ?? 'unknown'}`,
        occurredAt,
        thread,
        { lifecycle: 'started' },
      );
      event.project = project;
      return event;
    }

    const threadId = text(params.threadId);
    if (!threadId) return undefined;
    if (method === 'thread/status/changed') {
      const status = record(params.status)?.type ?? params.status;
      return this.#base(
        'thread.status_changed',
        `thread:${threadId}:status:${eventHash(status)}`,
        fallback,
        this.#thread(threadId, fallback),
        cleanObject({ status }),
      );
    }
    if (method === 'thread/archived' || method === 'thread/unarchived' || method === 'thread/deleted') {
      const status = method === 'thread/archived' ? 'archived'
        : method === 'thread/deleted' ? 'deleted' : 'active';
      return this.#base(
        method.replace('/', '.'),
        `thread:${threadId}:${method}`,
        fallback,
        this.#thread(threadId, fallback, { status }),
        { lifecycle: status },
      );
    }
    if (method === 'thread/name/updated') {
      const title = text(params.threadName) ?? null;
      return this.#base(
        'thread.name_updated',
        `thread:${threadId}:name:${eventHash(title)}`,
        fallback,
        this.#thread(threadId, fallback, { title }),
        { lifecycle: 'name_updated' },
      );
    }
    if (method === 'turn/started' || method === 'turn/completed') {
      const sourceTurn = record(params.turn);
      const turnId = text(sourceTurn?.id);
      if (!sourceTurn || !turnId) return undefined;
      const completed = method === 'turn/completed';
      const occurredAt = completed
        ? isoFromSeconds(number(sourceTurn.completedAt), fallback)
        : isoFromSeconds(number(sourceTurn.startedAt), fallback);
      const startedAt = isoFromSeconds(number(sourceTurn.startedAt), occurredAt);
      const turn = this.#turn(turnId, startedAt, {
        status: turnStatus(sourceTurn.status, completed ? 'completed' : 'in_progress'),
        lifecycleRank: completed ? 2 : 1,
        startedAt,
        completedAt: completed ? occurredAt : null,
      });
      const event = this.#base(
        completed ? 'turn.completed' : 'turn.started',
        `turn:${turnId}:${completed ? 'completed' : 'started'}`,
        occurredAt,
        this.#thread(threadId, occurredAt),
        completed
          ? cleanObject({ lifecycle: 'completed', error: sourceTurn.error })
          : { lifecycle: 'started' },
      );
      event.turn = turn;
      return event;
    }
    if (method === 'item/started' || method === 'item/completed') {
      const sourceItem = record(params.item);
      const turnId = text(params.turnId);
      if (!sourceItem || !turnId) return undefined;
      const completed = method === 'item/completed';
      const occurredAt = isoFromMilliseconds(
        number(completed ? params.completedAtMs : params.startedAtMs),
        fallback,
      );
      const item = this.#item(sourceItem, completed ? 'completed' : 'started', occurredAt);
      if (!item) return undefined;
      const event = this.#base(
        completed ? 'item.completed' : 'item.started',
        `item:${item.codexItemId}:${completed ? 'completed' : 'started'}`,
        occurredAt,
        this.#thread(threadId, occurredAt),
        { lifecycle: completed ? 'completed' : 'started', itemType: item.itemType },
      );
      event.turn = this.#turn(turnId, occurredAt);
      event.item = item;
      const toolCall = toolCallFromItem(sourceItem, completed ? 'completed' : 'started', occurredAt);
      if (toolCall) event.toolCall = toolCall;
      return event;
    }
    return undefined;
  }

  #approvalRequested(
    request: UnknownRecord,
    fallback: string,
    knownIdentity?: string,
  ): HistoryIngestEvent | undefined {
    const method = text(request.method);
    const params = record(request.params);
    const threadId = text(params?.threadId);
    if (!method || !params || !threadId) return undefined;
    const approvalIdentity = knownIdentity ?? this.#approvalIdentity(request, fallback, false)?.identity;
    if (!approvalIdentity) return undefined;
    const occurredAt = isoFromMilliseconds(number(params.startedAtMs), fallback);
    const turnId = text(params.turnId);
    const itemId = text(params.itemId);
    const event = this.#base(
      'approval.requested',
      `${approvalIdentity}:requested`,
      occurredAt,
      this.#thread(threadId, occurredAt),
      { lifecycle: 'requested', approvalType: method },
    );
    if (turnId) event.turn = this.#turn(turnId, occurredAt);
    if (turnId && itemId) {
      event.item = {
        codexItemId: itemId,
        itemType: 'approvalTarget',
        role: null,
        payload: {},
        sourceSortKey: sourceSortKey(occurredAt, itemId),
        status: 'started',
        lifecycleRank: 0,
        startedAt: occurredAt,
        completedAt: null,
      };
    }
    event.approval = {
      codexRequestId: approvalIdentity,
      approvalType: method,
      status: 'pending',
      requestPayload: cleanObject(params),
      responsePayload: null,
      requestedAt: occurredAt,
      resolvedAt: null,
    };
    return event;
  }

  #approvalResolved(
    request: UnknownRecord,
    reason: string,
    response: unknown,
    fallback: string,
  ): HistoryIngestEvent | undefined {
    const approvalIdentity = this.#approvalIdentity(request, fallback, true);
    if (!approvalIdentity) return undefined;
    const requested = this.#approvalRequested(request, fallback, approvalIdentity.identity);
    if (!requested?.approval) return undefined;
    if (approvalIdentity.weak) this.#approvalIdentities.delete(approvalIdentity.mapKey);
    const status = approvalStatus(reason, response);
    requested.eventType = 'approval.resolved';
    requested.eventId = `${approvalIdentity.identity}:resolved`;
    requested.payload = { lifecycle: 'resolved', approvalType: requested.approval.approvalType, status };
    requested.approval = {
      ...requested.approval,
      status,
      responsePayload: cleanObject(response),
      resolvedAt: fallback,
    };
    return requested;
  }

  #approvalIdentity(
    request: UnknownRecord,
    fallback: string,
    resolving: boolean,
  ): ApprovalIdentity | undefined {
    const seed = approvalIdentitySeed(request);
    if (!seed) return undefined;
    if (!seed.weak) {
      return { ...seed, identity: `approval:${seed.mapKey}` };
    }
    const existing = this.#approvalIdentities.get(seed.mapKey);
    if (existing) return { ...seed, identity: existing };
    const identity = `approval:${hash(`${seed.mapKey}\u001f${fallback}`)}`;
    if (!resolving) this.#approvalIdentities.set(seed.mapKey, identity);
    return { ...seed, identity };
  }
}
