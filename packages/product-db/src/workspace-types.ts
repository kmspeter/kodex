import type { WorkspaceRole } from './auth-types.js';

export interface WorkspaceMember {
  displayName: string | null;
  email: string;
  joinedAt: Date;
  role: WorkspaceRole;
  userId: string;
}

export interface WorkspaceRecord {
  id: string;
  name: string;
  role: WorkspaceRole;
  slug: string;
}

export type WorkspaceOperationErrorCode =
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'last_owner';

export class WorkspaceOperationError extends Error {
  constructor(readonly code: WorkspaceOperationErrorCode) {
    super(code);
    this.name = 'WorkspaceOperationError';
  }
}

export interface WorkspaceApplication {
  addMember(actorUserId: string, workspaceId: string, email: string, role: WorkspaceRole): Promise<WorkspaceMember>;
  createWorkspace(actorUserId: string, name: string): Promise<WorkspaceRecord>;
  listMembers(actorUserId: string, workspaceId: string): Promise<WorkspaceMember[]>;
  removeMember(actorUserId: string, workspaceId: string, targetUserId: string): Promise<void>;
  updateMemberRole(actorUserId: string, workspaceId: string, targetUserId: string, role: WorkspaceRole): Promise<WorkspaceMember>;
}
