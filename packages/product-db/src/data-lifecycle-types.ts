export const dataLifecycleJobKinds = ['user_export', 'account_delete', 'workspace_delete'] as const;
export type DataLifecycleJobKind = (typeof dataLifecycleJobKinds)[number];

export const dataLifecycleJobStatuses = [
  'pending',
  'running',
  'waiting_local',
  'blocked_legal_hold',
  'completed',
  'failed',
] as const;
export type DataLifecycleJobStatus = (typeof dataLifecycleJobStatuses)[number];

export interface DataLifecycleJob {
  attemptCount: number;
  completedAt: Date | null;
  createdAt: Date;
  id: string;
  kind: DataLifecycleJobKind;
  lastErrorCode: string | null;
  status: DataLifecycleJobStatus;
  targetUserId: string | null;
  targetWorkspaceId: string | null;
  updatedAt: Date;
}

export interface DataExportArtifact {
  createdAt: Date;
  document: unknown;
  expiresAt: Date;
  jobId: string;
  sizeBytes: number;
  userId: string;
}

export interface LocalTenantScope {
  userId: string;
  workspaceId: string;
}

export interface LocalLifecycleTarget extends LocalTenantScope {
  attemptCount: number;
  id: string;
  jobId: string;
  jobKind: Extract<DataLifecycleJobKind, 'account_delete' | 'workspace_delete'>;
}

export type LocalLifecycleCleanupResult = 'busy' | 'deleted' | 'missing' | 'partial';
export type LocalLifecycleExecutionResult = 'blocked_legal_hold' | 'completed' | 'retry';

export type DataLifecycleErrorCode =
  | 'confirmation_mismatch'
  | 'credential_rejected'
  | 'export_limit'
  | 'forbidden'
  | 'invalid'
  | 'legal_hold'
  | 'not_found'
  | 'owned_workspace_conflict'
  | 'restore_confirmation_mismatch'
  | 'restore_conflict'
  | 'restore_unavailable'
  | 'scope_conflict';

export class DataLifecycleError extends Error {
  constructor(readonly code: DataLifecycleErrorCode) {
    super(code);
    this.name = 'DataLifecycleError';
  }
}

export interface CredentialConfirmation {
  currentSessionId: string;
  userId: string;
  verifyCurrentPassword(encodedHash: string): Promise<boolean>;
}

export interface DataLifecycleWorkerConfig {
  exportMaxBytes: number;
  exportMaxRowsPerCategory: number;
  exportRetentionMs: number;
  leaseMs: number;
  retryMs: number;
}

export interface LegalHold {
  createdAt: Date;
  id: string;
  reasonCode: string;
  targetType: 'user' | 'workspace';
  targetUserId: string | null;
  targetWorkspaceId: string | null;
}
