import { workspaceRoles, type WorkspaceRole } from '@kodex/product-contract';

export { workspaceRoles, type WorkspaceRole };

export interface AuthUser {
  createdAt: Date;
  displayName: string | null;
  email: string;
  id: string;
}

export interface WorkspaceMembership {
  id: string;
  name: string;
  role: WorkspaceRole;
  slug: string;
}

export interface AuthContext {
  expiresAt: Date;
  memberships: WorkspaceMembership[];
  sessionId: string;
  user: AuthUser;
}

export class WorkspaceAuthorizationError extends Error {
  constructor() {
    super('Workspace access is not permitted');
    this.name = 'WorkspaceAuthorizationError';
  }
}

export function requireWorkspaceRole(
  context: AuthContext,
  workspaceId: string,
  allowedRoles: readonly WorkspaceRole[] = workspaceRoles,
): WorkspaceMembership {
  const membership = context.memberships.find(
    (entry) => entry.id === workspaceId && allowedRoles.includes(entry.role),
  );
  if (!membership) {
    throw new WorkspaceAuthorizationError();
  }
  return membership;
}
