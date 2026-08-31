/** Browser-safe product authentication and tenant-scope contract. */
export const PRODUCT_SESSION_COOKIE_NAME = 'kodex_product_session';
export const PRODUCT_WORKSPACE_HEADER_NAME = 'X-Kodex-Workspace-Id';
export const PRODUCT_WORKSPACE_QUERY_PARAM = 'workspace_id';

export const workspaceRoles = ['owner', 'admin', 'member', 'viewer'] as const;
export type WorkspaceRole = (typeof workspaceRoles)[number];

export const runtimeWorkspaceRoles = ['owner', 'admin', 'member'] as const;
export type RuntimeWorkspaceRole = (typeof runtimeWorkspaceRoles)[number];

export function canUseWorkspaceRuntime(role: WorkspaceRole): role is RuntimeWorkspaceRole {
  return runtimeWorkspaceRoles.includes(role as RuntimeWorkspaceRole);
}

export interface ProductUserDto {
  createdAt: string;
  displayName: string | null;
  email: string;
  id: string;
}

export interface ProductWorkspaceDto {
  id: string;
  name: string;
  role: WorkspaceRole;
  slug: string;
}

export interface ProductAuthContextDto {
  defaultWorkspace?: ProductWorkspaceDto;
  session: { expiresAt: string };
  user: ProductUserDto;
  workspaces: ProductWorkspaceDto[];
}

export interface ProductAuthResponseDto extends ProductAuthContextDto {
  csrfToken: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}
