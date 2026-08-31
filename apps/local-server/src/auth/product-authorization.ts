import type { IncomingMessage } from 'node:http';
import {
  canUseWorkspaceRuntime,
  isUuid,
  PRODUCT_SESSION_COOKIE_NAME,
  PRODUCT_WORKSPACE_HEADER_NAME,
} from '@kodex/product-contract';
import {
  hashSessionToken,
  type AuthContext,
  type AuthRepository,
  type WorkspaceRole,
} from '@kodex/product-db';

export interface RuntimeScope {
  sessionExpiresAt: Date;
  sessionId: string;
  userId: string;
  workspaceId: string;
  workspaceRole: WorkspaceRole;
}

export interface ProductAuthorization extends RuntimeScope {
  /** Server-only bearer used solely for periodic DB revalidation. */
  sessionToken: string;
}

export interface ProductAuthorizer {
  authorizeRequest(request: IncomingMessage, workspaceId: unknown): Promise<ProductAuthorization>;
  reauthorize(authorization: ProductAuthorization): Promise<ProductAuthorization>;
}

export class ProductAuthorizationError extends Error {
  constructor(
    readonly status: 401 | 403 | 503,
    readonly code: 'auth_unavailable' | 'unauthenticated' | 'workspace_forbidden',
    message: string,
  ) {
    super(message);
    this.name = 'ProductAuthorizationError';
  }
}

function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of (header ?? '').split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    try {
      cookies.set(name, decodeURIComponent(part.slice(separator + 1).trim()));
    } catch {
      // Invalid encoding is indistinguishable from a missing credential.
    }
  }
  return cookies;
}

function authorizationFromContext(
  context: AuthContext | undefined,
  sessionToken: string,
  workspaceId: string,
): ProductAuthorization {
  if (!context) {
    throw new ProductAuthorizationError(401, 'unauthenticated', 'Product authentication is required.');
  }
  const membership = context.memberships.find(
    (entry) => entry.id === workspaceId && canUseWorkspaceRuntime(entry.role),
  );
  if (!membership) {
    throw new ProductAuthorizationError(403, 'workspace_forbidden', 'Workspace access is not permitted.');
  }
  return {
    sessionToken,
    sessionId: context.sessionId,
    sessionExpiresAt: context.expiresAt,
    userId: context.user.id,
    workspaceId,
    workspaceRole: membership.role,
  };
}

export class DatabaseProductAuthorizer implements ProductAuthorizer {
  constructor(private readonly repository: Pick<AuthRepository, 'findAuthContext'>) {}

  async authorizeRequest(
    request: IncomingMessage,
    workspaceId: unknown = request.headers[PRODUCT_WORKSPACE_HEADER_NAME.toLowerCase()],
  ): Promise<ProductAuthorization> {
    if (!isUuid(workspaceId)) {
      throw new ProductAuthorizationError(403, 'workspace_forbidden', 'A valid workspace scope is required.');
    }
    const token = parseCookies(request.headers.cookie).get(PRODUCT_SESSION_COOKIE_NAME);
    if (!token) {
      throw new ProductAuthorizationError(401, 'unauthenticated', 'Product authentication is required.');
    }
    try {
      return authorizationFromContext(
        await this.repository.findAuthContext(hashSessionToken(token)),
        token,
        workspaceId,
      );
    } catch (error) {
      if (error instanceof ProductAuthorizationError) throw error;
      throw new ProductAuthorizationError(503, 'auth_unavailable', 'Product authorization is temporarily unavailable.');
    }
  }

  async reauthorize(previous: ProductAuthorization): Promise<ProductAuthorization> {
    let current: ProductAuthorization;
    try {
      current = authorizationFromContext(
        await this.repository.findAuthContext(hashSessionToken(previous.sessionToken)),
        previous.sessionToken,
        previous.workspaceId,
      );
    } catch (error) {
      if (error instanceof ProductAuthorizationError) throw error;
      throw new ProductAuthorizationError(503, 'auth_unavailable', 'Product authorization is temporarily unavailable.');
    }
    if (current.userId !== previous.userId || current.sessionId !== previous.sessionId) {
      throw new ProductAuthorizationError(401, 'unauthenticated', 'Product authentication is required.');
    }
    return current;
  }
}
