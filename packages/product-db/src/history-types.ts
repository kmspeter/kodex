export interface HistoryScope {
  userId: string;
  workspaceId: string;
}

export interface HistoryProjectSnapshot {
  externalKey: string;
  metadata: Record<string, unknown>;
  name: string;
}

export type HistoryThreadStatus = 'active' | 'archived' | 'deleted';
export type HistoryTurnStatus = 'in_progress' | 'completed' | 'failed' | 'interrupted';
export type HistoryItemStatus = 'started' | 'completed';
export type HistoryToolStatus = 'requested' | 'running' | 'completed' | 'failed' | 'cancelled';
export type HistoryApprovalStatus = 'pending' | 'approved' | 'denied' | 'cancelled' | 'expired';

export interface HistoryThreadSnapshot {
  codexThreadId: string;
  createdAt?: string;
  metadata?: Record<string, unknown>;
  projectIsAuthoritative: boolean;
  sourceUpdatedAt: string;
  status: HistoryThreadStatus;
  title?: string | null;
}

export interface HistoryTurnSnapshot {
  codexTurnId: string;
  completedAt?: string | null;
  lifecycleRank: 0 | 1 | 2;
  sourceSortKey: string;
  startedAt?: string | null;
  status: HistoryTurnStatus;
}

export interface HistoryItemSnapshot {
  codexItemId: string;
  completedAt?: string | null;
  itemType: string;
  lifecycleRank: 0 | 1 | 2;
  payload: Record<string, unknown>;
  role?: string | null;
  sourceSortKey: string;
  startedAt?: string | null;
  status: HistoryItemStatus;
}

export interface HistoryToolCallSnapshot {
  arguments: Record<string, unknown>;
  codexCallId: string;
  completedAt?: string | null;
  requestedAt: string;
  result?: Record<string, unknown> | null;
  startedAt?: string | null;
  status: HistoryToolStatus;
  toolName: string;
}

export interface HistoryApprovalSnapshot {
  approvalType: string;
  codexRequestId: string;
  requestPayload: Record<string, unknown>;
  requestedAt: string;
  resolvedAt?: string | null;
  responsePayload?: Record<string, unknown> | null;
  status: HistoryApprovalStatus;
}

/** A bounded, already-redacted projection command written to the tenant outbox. */
export interface HistoryIngestEvent {
  approval?: HistoryApprovalSnapshot;
  eventId: string;
  eventType: string;
  item?: HistoryItemSnapshot;
  occurredAt: string;
  payload: Record<string, unknown>;
  project: HistoryProjectSnapshot;
  sourceInstance: string;
  thread: HistoryThreadSnapshot;
  toolCall?: HistoryToolCallSnapshot;
  turn?: HistoryTurnSnapshot;
  version: 1;
}

export interface HistoryEventSink {
  ingest(scope: HistoryScope, event: HistoryIngestEvent): Promise<void>;
}

export interface HistoryThreadSummary {
  createdAt: string;
  id: string;
  project: { id: string; name: string };
  status: HistoryThreadStatus;
  title: string | null;
  updatedAt: string;
}

export interface HistoryThreadPage {
  nextCursor: string | null;
  threads: HistoryThreadSummary[];
}

export interface HistoryTurnRecord {
  completedAt: string | null;
  id: string;
  startedAt: string;
  status: HistoryTurnStatus;
}

export interface HistoryItemRecord {
  completedAt: string | null;
  id: string;
  itemType: string;
  payload: Record<string, unknown>;
  role: string | null;
  startedAt: string | null;
  status: HistoryItemStatus;
  turnId: string;
}

export interface HistoryToolCallRecord {
  arguments: Record<string, unknown>;
  completedAt: string | null;
  id: string;
  requestedAt: string;
  result: Record<string, unknown> | null;
  startedAt: string | null;
  status: HistoryToolStatus;
  toolName: string;
  turnId: string;
}

export interface HistoryApprovalRecord {
  approvalType: string;
  id: string;
  requestPayload: Record<string, unknown>;
  requestedAt: string;
  resolvedAt: string | null;
  responsePayload: Record<string, unknown> | null;
  status: HistoryApprovalStatus;
  turnId: string | null;
}

export interface HistoryThreadDetail {
  approvals: HistoryApprovalRecord[];
  items: HistoryItemRecord[];
  nextCursor: string | null;
  thread: HistoryThreadSummary;
  toolCalls: HistoryToolCallRecord[];
  turns: HistoryTurnRecord[];
}

export interface HistoryReader {
  listThreads(scope: HistoryScope, options: { cursor?: string; limit: number }): Promise<HistoryThreadPage>;
  readThread(
    scope: HistoryScope,
    codexThreadId: string,
    options: { cursor?: string; limit: number },
  ): Promise<HistoryThreadDetail | undefined>;
}

export class HistoryCursorError extends Error {
  constructor() {
    super('History cursor is invalid.');
    this.name = 'HistoryCursorError';
  }
}
