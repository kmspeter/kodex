import type { WorkspaceRole } from './auth-types.js';

export type WorkspaceInvitationRole = Exclude<WorkspaceRole, 'owner'>;

export interface WorkspaceMember {
  displayName: string | null;
  email: string;
  joinedAt: Date;
  role: WorkspaceRole;
  userId: string;
}

export interface WorkspaceMemberPage {
  members: WorkspaceMember[];
  nextCursor?: string;
}

export interface WorkspaceRecord {
  id: string;
  name: string;
  role: WorkspaceRole;
  slug: string;
}

export interface WorkspaceInvitation {
  createdAt: Date;
  createdByUserId: string | null;
  expiresAt: Date;
  id: string;
  role: WorkspaceInvitationRole;
  targetEmail: string;
  workspaceId: string;
}

export interface WorkspaceInvitationPage {
  invitations: WorkspaceInvitation[];
  nextCursor?: string;
}

export interface WorkspacePageOptions {
  cursor?: string;
  limit: number;
}

export type CreatedWorkspaceInvitation = {
  invitation: WorkspaceInvitation;
  token: string;
} | {
  deliveryStatus: 'pending';
  invitation: WorkspaceInvitation;
};

export interface WorkspaceInvitationPreview {
  expiresAt: Date;
  role: WorkspaceInvitationRole;
  targetEmailHint: string;
  workspaceName: string;
}

export type WorkspaceOperationErrorCode =
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'last_owner'
  | 'confirmation_mismatch';

export type WorkspaceInvitationErrorCode =
  | 'conflict'
  | 'forbidden'
  | 'invalid'
  | 'limit'
  | 'not_found';

export class WorkspaceOperationError extends Error {
  constructor(readonly code: WorkspaceOperationErrorCode) {
    super(code);
    this.name = 'WorkspaceOperationError';
  }
}

export class WorkspaceInvitationError extends Error {
  constructor(readonly code: WorkspaceInvitationErrorCode) {
    super(code);
    this.name = 'WorkspaceInvitationError';
  }
}

export class WorkspaceCursorError extends Error {
  constructor() {
    super('Workspace cursor is invalid.');
    this.name = 'WorkspaceCursorError';
  }
}

export interface WorkspaceApplication {
  addMember(actorUserId: string, workspaceId: string, email: string, role: WorkspaceRole): Promise<WorkspaceMember>;
  archiveWorkspace(actorUserId: string, workspaceId: string, confirmationName: string): Promise<void>;
  createWorkspace(actorUserId: string, name: string): Promise<WorkspaceRecord>;
  listMembers(actorUserId: string, workspaceId: string, options: WorkspacePageOptions): Promise<WorkspaceMemberPage>;
  removeMember(actorUserId: string, workspaceId: string, targetUserId: string): Promise<void>;
  updateMemberRole(actorUserId: string, workspaceId: string, targetUserId: string, role: WorkspaceRole): Promise<WorkspaceMember>;
  acceptInvitation(actorUserId: string, token: string): Promise<WorkspaceRecord>;
  createInvitation(actorUserId: string, workspaceId: string, email: string, role: WorkspaceInvitationRole): Promise<CreatedWorkspaceInvitation>;
  listInvitations(actorUserId: string, workspaceId: string, options: WorkspacePageOptions): Promise<WorkspaceInvitationPage>;
  previewInvitation(token: string): Promise<WorkspaceInvitationPreview>;
  renameWorkspace(actorUserId: string, workspaceId: string, name: string): Promise<WorkspaceRecord>;
  revokeInvitation(actorUserId: string, workspaceId: string, invitationId: string): Promise<void>;
}
