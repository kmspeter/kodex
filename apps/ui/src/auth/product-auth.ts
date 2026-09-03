import {
  canUseWorkspaceRuntime,
  isUuid,
  parseProductCreatedWorkspaceInvitation,
  parseProductHistoryThreadDetail,
  parseProductHistoryThreadPage,
  parseProductSessions,
  parseProductWorkspace,
  parseProductWorkspaceInvitationPreview,
  parseProductWorkspaceInvitations,
  parseProductWorkspaceMember,
  parseProductWorkspaceMembers,
  PRODUCT_HISTORY_DEFAULT_LIMIT,
  PRODUCT_HISTORY_MAX_LIMIT,
  PRODUCT_WORKSPACE_HEADER_NAME,
  PRODUCT_WORKSPACE_QUERY_PARAM,
  workspaceRoles,
  type ProductAuthContextDto,
  type ProductHistoryThreadDetailDto,
  type ProductHistoryThreadPageDto,
  type ProductSessionDto,
  type ProductCreatedWorkspaceInvitationDto,
  type ProductUserDto,
  type ProductWorkspaceMemberDto,
  type ProductWorkspaceInvitationDto,
  type ProductWorkspaceInvitationPreviewDto,
  type ProductWorkspaceDto,
  type WorkspaceRole,
  type WorkspaceInvitationRole,
} from '@kodex/product-contract';

export type ProductUser = ProductUserDto;
export type ProductWorkspace = ProductWorkspaceDto;
export type ProductWorkspaceMember = ProductWorkspaceMemberDto;
export type ProductWorkspaceInvitation = ProductWorkspaceInvitationDto;
export type ProductWorkspaceInvitationPreview = ProductWorkspaceInvitationPreviewDto;
export type CreatedProductWorkspaceInvitation = ProductCreatedWorkspaceInvitationDto;
export type ProductAuthContext = ProductAuthContextDto;
export type ProductSession = ProductSessionDto;

export interface ProductRuntimeWorkspaceSelection {
  userId: string;
  workspaceId: string;
}

export function selectProductRuntimeWorkspace(context: ProductAuthContext): ProductWorkspace | undefined {
  const runnable = context.workspaces.filter((workspace) => canUseWorkspaceRuntime(workspace.role));
  if (
    context.defaultWorkspace
    && canUseWorkspaceRuntime(context.defaultWorkspace.role)
    && runnable.some((workspace) => workspace.id === context.defaultWorkspace?.id)
  ) {
    return context.defaultWorkspace;
  }
  return runnable[0];
}

export function reconcileProductRuntimeWorkspace(
  context: ProductAuthContext,
  selection: ProductRuntimeWorkspaceSelection | null,
): ProductRuntimeWorkspaceSelection | null {
  if (selection?.userId === context.user.id) {
    const selectedMembership = context.workspaces.find((workspace) => (
      workspace.id === selection.workspaceId && canUseWorkspaceRuntime(workspace.role)
    ));
    if (selectedMembership) return selection;
  }
  const fallback = selectProductRuntimeWorkspace(context);
  return fallback ? { userId: context.user.id, workspaceId: fallback.id } : null;
}

export type ProductAuthErrorKind =
  | 'invalid-response'
  | 'rejected'
  | 'unauthenticated'
  | 'unavailable';

export class ProductAuthError extends Error {
  constructor(
    readonly kind: ProductAuthErrorKind,
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ProductAuthError';
  }
}

export class ProductAuthConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProductAuthConfigurationError';
  }
}

interface ParsedAuthResponse {
  context: ProductAuthContext;
  csrfToken: string;
}

interface ProductAuthClientOptions {
  apiBase?: string;
  development?: boolean;
  fetch?: typeof globalThis.fetch;
  pageUrl?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key))
    && keys.every((key) => allowed.has(key));
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isoDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function parseUser(value: unknown): ProductUser {
  if (
    !isRecord(value)
    || !hasExactKeys(value, ['id', 'email', 'displayName', 'createdAt'])
    || !nonEmptyString(value.id)
    || !nonEmptyString(value.email)
    || (value.displayName !== null && typeof value.displayName !== 'string')
    || !isoDate(value.createdAt)
  ) {
    throw new ProductAuthError('invalid-response', 'The authentication API returned an invalid user.');
  }
  return {
    id: value.id,
    email: value.email,
    displayName: value.displayName,
    createdAt: value.createdAt,
  };
}

function parseWorkspace(value: unknown): ProductWorkspace {
  if (
    !isRecord(value)
    || !hasExactKeys(value, ['id', 'name', 'role', 'slug'])
    || !nonEmptyString(value.id)
    || !nonEmptyString(value.name)
    || !nonEmptyString(value.slug)
    || typeof value.role !== 'string'
    || !workspaceRoles.includes(value.role as WorkspaceRole)
  ) {
    throw new ProductAuthError('invalid-response', 'The authentication API returned an invalid workspace.');
  }
  return {
    id: value.id,
    name: value.name,
    role: value.role as WorkspaceRole,
    slug: value.slug,
  };
}

export function parseProductAuthResponse(
  value: unknown,
  allowDefaultWorkspace: boolean,
): ParsedAuthResponse {
  if (
    !isRecord(value)
    || !hasExactKeys(
      value,
      ['user', 'workspaces', 'session', 'csrfToken'],
      allowDefaultWorkspace ? ['defaultWorkspace'] : [],
    )
    || !Array.isArray(value.workspaces)
    || !isRecord(value.session)
    || !hasExactKeys(value.session, ['expiresAt'])
    || !isoDate(value.session.expiresAt)
    || typeof value.csrfToken !== 'string'
    || !/^[A-Za-z0-9_-]{43}$/u.test(value.csrfToken)
  ) {
    throw new ProductAuthError('invalid-response', 'The authentication API returned an invalid response.');
  }
  const workspaces = value.workspaces.map(parseWorkspace);
  const defaultWorkspace = value.defaultWorkspace === undefined
    ? undefined
    : parseWorkspace(value.defaultWorkspace);
  if (
    defaultWorkspace
    && !workspaces.some((workspace) => workspace.id === defaultWorkspace.id)
  ) {
    throw new ProductAuthError('invalid-response', 'The default workspace is not a membership.');
  }
  return {
    csrfToken: value.csrfToken,
    context: {
      user: parseUser(value.user),
      workspaces,
      session: { expiresAt: value.session.expiresAt },
      ...(defaultWorkspace ? { defaultWorkspace } : {}),
    },
  };
}

interface ParsedErrorResponse {
  code: string;
  message: string;
}

function parseErrorResponse(value: unknown): ParsedErrorResponse {
  if (
    !isRecord(value)
    || !hasExactKeys(value, ['ok', 'error'])
    || value.ok !== false
    || !isRecord(value.error)
    || !hasExactKeys(value.error, ['code', 'message'])
    || !nonEmptyString(value.error.code)
    || !nonEmptyString(value.error.message)
  ) {
    throw new ProductAuthError('invalid-response', 'The authentication API returned an invalid error response.');
  }
  return { code: value.error.code, message: value.error.message };
}

function loopbackAlias(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1';
}

function runtimeProductApiBase(): string | undefined {
  if (typeof document === 'undefined') return undefined;
  const entries = document.querySelectorAll<HTMLMetaElement>('meta[name="kodex-product-api-origin"]');
  if (entries.length > 1) {
    throw new ProductAuthConfigurationError('Product API runtime configuration is ambiguous.');
  }
  return entries[0]?.content.trim() || undefined;
}

export function resolveProductApiBase(
  configuredBase: string | undefined,
  pageUrl: string,
  development: boolean,
): string {
  const page = new URL(pageUrl);
  const candidate = configuredBase?.trim() || (development
    ? 'http://127.0.0.1:47832'
    : loopbackAlias(page.hostname)
      ? undefined
      : page.origin);
  if (!candidate) {
    throw new ProductAuthConfigurationError('Product API runtime configuration is missing.');
  }
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new ProductAuthConfigurationError('Product API URL must be an absolute HTTP(S) origin.');
  }
  if (
    !['http:', 'https:'].includes(url.protocol)
    || url.origin !== candidate
    || url.username
    || url.password
  ) {
    throw new ProductAuthConfigurationError('Product API URL must be an exact HTTP(S) origin.');
  }
  if (
    loopbackAlias(page.hostname)
    && loopbackAlias(url.hostname)
    && page.hostname !== url.hostname
  ) {
    throw new ProductAuthConfigurationError(
      'The UI and product API must use the same loopback hostname; do not mix localhost and 127.0.0.1.',
    );
  }
  if (
    !development
    && loopbackAlias(page.hostname)
    && (
      !loopbackAlias(url.hostname)
      || url.hostname !== page.hostname
      || url.protocol !== page.protocol
    )
  ) {
    throw new ProductAuthConfigurationError(
      'Production loopback Product API runtime configuration must use the UI protocol and hostname.',
    );
  }
  if (!development && !loopbackAlias(page.hostname) && url.origin !== page.origin) {
    throw new ProductAuthConfigurationError('Production Product API runtime configuration must use the UI origin.');
  }
  return url.origin;
}

export class ProductAuthClient {
  readonly apiBase: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #unauthenticatedListeners = new Set<() => void>();
  #csrfToken: string | null = null;

  constructor(options: ProductAuthClientOptions = {}) {
    const pageUrl = options.pageUrl ?? window.location.href;
    const bundledDevelopment = import.meta.env.DEV;
    const development = options.development ?? bundledDevelopment;
    const configuredBase = options.apiBase
      ?? (bundledDevelopment ? import.meta.env.VITE_PRODUCT_API_URL : runtimeProductApiBase());
    this.apiBase = resolveProductApiBase(
      configuredBase,
      pageUrl,
      development,
    );
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async me(options: { signal?: AbortSignal } = {}): Promise<ProductAuthContext> {
    const response = await this.#request('/api/auth/me', {
      method: 'GET',
      signal: options.signal,
    });
    const parsed = parseProductAuthResponse(await this.#json(response), false);
    this.#csrfToken = parsed.csrfToken;
    return parsed.context;
  }

  async login(input: { email: string; password: string }): Promise<ProductAuthContext> {
    return this.#establish('/api/auth/login', 200, input);
  }

  async register(input: {
    displayName?: string;
    email: string;
    password: string;
  }): Promise<ProductAuthContext> {
    return this.#establish('/api/auth/register', 201, input);
  }

  async logout(): Promise<void> {
    if (!this.#csrfToken) {
      throw new ProductAuthError('invalid-response', 'No CSRF proof is available for logout.');
    }
    const response = await this.#request('/api/auth/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': this.#csrfToken },
      body: '{}',
    });
    if (response.status !== 204) {
      throw new ProductAuthError('invalid-response', 'The logout response was invalid.', response.status);
    }
    this.#csrfToken = null;
  }

  async sessions(): Promise<ProductSession[]> {
    const response = await this.#request('/api/auth/sessions', { method: 'GET' });
    try {
      return parseProductSessions(await this.#json(response)).sessions;
    } catch {
      throw new ProductAuthError('invalid-response', 'The account security API returned an invalid session list.');
    }
  }

  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    const response = await this.#authMutation('/api/auth/password', 'PATCH', {
      currentPassword,
      newPassword,
    });
    if (response.status !== 204) {
      throw new ProductAuthError('invalid-response', 'The password change response was invalid.', response.status);
    }
  }

  async revokeSession(session: Pick<ProductSession, 'current' | 'id'>): Promise<void> {
    if (!isUuid(session.id) || typeof session.current !== 'boolean') {
      throw new ProductAuthError('rejected', 'Session request scope is invalid.');
    }
    const response = await this.#authMutation(
      `/api/auth/sessions/${encodeURIComponent(session.id)}`,
      'DELETE',
      undefined,
    );
    if (response.status !== 204) {
      throw new ProductAuthError('invalid-response', 'The session revoke response was invalid.', response.status);
    }
    if (session.current) this.#invalidateSession();
  }

  async revokeOtherSessions(): Promise<void> {
    const response = await this.#authMutation('/api/auth/sessions', 'DELETE', undefined);
    if (response.status !== 204) {
      throw new ProductAuthError('invalid-response', 'The session revoke response was invalid.', response.status);
    }
  }

  async logoutAll(): Promise<void> {
    const response = await this.#authMutation('/api/auth/logout-all', 'POST', {});
    if (response.status !== 204) {
      throw new ProductAuthError('invalid-response', 'The logout-all response was invalid.', response.status);
    }
    this.#invalidateSession();
  }

  async createWorkspace(name: string): Promise<ProductWorkspace> {
    const response = await this.#workspaceMutation('/api/workspaces', 'POST', { name });
    if (response.status !== 201) throw new ProductAuthError('invalid-response', 'The workspace create response was invalid.', response.status);
    try {
      return parseProductWorkspace(await this.#json(response));
    } catch {
      throw new ProductAuthError('invalid-response', 'The workspace API returned an invalid workspace.');
    }
  }

  async workspaceMembers(workspaceId: string): Promise<ProductWorkspaceMember[]> {
    const path = this.#workspacePath(workspaceId, '/members');
    const response = await this.#request(path, { method: 'GET' });
    try {
      return parseProductWorkspaceMembers(await this.#json(response)).members;
    } catch {
      throw new ProductAuthError('invalid-response', 'The workspace API returned an invalid member list.');
    }
  }

  async addWorkspaceMember(workspaceId: string, email: string, role: WorkspaceRole): Promise<ProductWorkspaceMember> {
    const response = await this.#workspaceMutation(this.#workspacePath(workspaceId, '/members'), 'POST', { email, role });
    if (response.status !== 201) throw new ProductAuthError('invalid-response', 'The member create response was invalid.', response.status);
    return this.#parseWorkspaceMember(response);
  }

  async updateWorkspaceMember(workspaceId: string, userId: string, role: WorkspaceRole): Promise<ProductWorkspaceMember> {
    const response = await this.#workspaceMutation(
      this.#workspacePath(workspaceId, `/members/${this.#uuid(userId)}`), 'PATCH', { role },
    );
    if (response.status !== 200) throw new ProductAuthError('invalid-response', 'The member update response was invalid.', response.status);
    return this.#parseWorkspaceMember(response);
  }

  async removeWorkspaceMember(workspaceId: string, userId: string): Promise<void> {
    const response = await this.#workspaceMutation(
      this.#workspacePath(workspaceId, `/members/${this.#uuid(userId)}`), 'DELETE', undefined,
    );
    if (response.status !== 204) throw new ProductAuthError('invalid-response', 'The member delete response was invalid.', response.status);
  }

  async workspaceInvitations(workspaceId: string): Promise<ProductWorkspaceInvitation[]> {
    const response = await this.#request(this.#workspacePath(workspaceId, '/invitations'), { method: 'GET' });
    try {
      return parseProductWorkspaceInvitations(await this.#json(response)).invitations;
    } catch {
      throw new ProductAuthError('invalid-response', 'The workspace API returned an invalid invitation list.');
    }
  }

  async createWorkspaceInvitation(
    workspaceId: string,
    email: string,
    role: WorkspaceInvitationRole,
  ): Promise<CreatedProductWorkspaceInvitation> {
    const response = await this.#workspaceMutation(
      this.#workspacePath(workspaceId, '/invitations'), 'POST', { email, role },
    );
    if (response.status !== 201) {
      throw new ProductAuthError('invalid-response', 'The invitation create response was invalid.', response.status);
    }
    try {
      return parseProductCreatedWorkspaceInvitation(await this.#json(response));
    } catch {
      throw new ProductAuthError('invalid-response', 'The workspace API returned an invalid created invitation.');
    }
  }

  async revokeWorkspaceInvitation(workspaceId: string, invitationId: string): Promise<void> {
    const response = await this.#workspaceMutation(
      this.#workspacePath(workspaceId, `/invitations/${this.#uuid(invitationId)}`), 'DELETE', undefined,
    );
    if (response.status !== 204) {
      throw new ProductAuthError('invalid-response', 'The invitation revoke response was invalid.', response.status);
    }
  }

  async previewWorkspaceInvitation(token: string): Promise<ProductWorkspaceInvitationPreview> {
    const response = await this.#request('/api/invitations/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: this.#invitationToken(token) }),
    });
    try {
      return parseProductWorkspaceInvitationPreview(await this.#json(response));
    } catch {
      throw new ProductAuthError('invalid-response', 'The invitation API returned an invalid preview.');
    }
  }

  async acceptWorkspaceInvitation(token: string): Promise<ProductWorkspace> {
    const response = await this.#authMutation('/api/invitations/accept', 'POST', {
      token: this.#invitationToken(token),
    });
    if (response.status !== 200) {
      throw new ProductAuthError('invalid-response', 'The invitation accept response was invalid.', response.status);
    }
    try {
      return parseProductWorkspace(await this.#json(response));
    } catch {
      throw new ProductAuthError('invalid-response', 'The invitation API returned an invalid workspace.');
    }
  }

  async knowledge<T>(
    pathname: string,
    workspaceId: string,
    init: RequestInit = {},
  ): Promise<T> {
    if (!isUuid(workspaceId) || !pathname.startsWith('/api/knowledge/')) {
      throw new ProductAuthError('rejected', 'Knowledge request scope is invalid.');
    }
    const url = new URL(pathname, this.apiBase);
    if (url.origin !== this.apiBase || url.pathname !== pathname.split('?', 1)[0]) {
      throw new ProductAuthError('rejected', 'Knowledge request path is invalid.');
    }
    url.searchParams.append(PRODUCT_WORKSPACE_QUERY_PARAM, workspaceId);
    const headers = new Headers(init.headers);
    headers.set(PRODUCT_WORKSPACE_HEADER_NAME, workspaceId);
    const mutation = !['GET', 'HEAD'].includes(init.method ?? 'GET');
    if (mutation) {
      if (!this.#csrfToken) throw new ProductAuthError('unauthenticated', 'Authentication is required.');
      headers.set('X-CSRF-Token', this.#csrfToken);
      if (init.body) headers.set('Content-Type', 'application/json');
    }
    const response = await this.#request(`${url.pathname}${url.search}`, { ...init, headers });
    if (response.status === 204) return undefined as T;
    return this.#json(response) as Promise<T>;
  }

  async historyThreads(
    workspaceId: string,
    options: { cursor?: string; limit?: number; signal?: AbortSignal } = {},
  ): Promise<ProductHistoryThreadPageDto> {
    const value = await this.#historyGet('/api/history/threads', workspaceId, options);
    try {
      return parseProductHistoryThreadPage(value);
    } catch {
      throw new ProductAuthError('invalid-response', 'The saved history API returned an invalid thread page.');
    }
  }

  async historyThread(
    workspaceId: string,
    threadId: string,
    options: { cursor?: string; limit?: number; signal?: AbortSignal } = {},
  ): Promise<ProductHistoryThreadDetailDto> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(threadId)) {
      throw new ProductAuthError('rejected', 'Saved history thread ID is invalid.');
    }
    const value = await this.#historyGet(
      `/api/history/threads/${encodeURIComponent(threadId)}`,
      workspaceId,
      options,
    );
    try {
      const detail = parseProductHistoryThreadDetail(value);
      if (detail.thread.threadId !== threadId) throw new Error('Saved history thread mismatch.');
      return detail;
    } catch {
      throw new ProductAuthError('invalid-response', 'The saved history API returned invalid thread details.');
    }
  }

  clearMemory(): void {
    this.#csrfToken = null;
  }

  onUnauthenticated(listener: () => void): () => void {
    this.#unauthenticatedListeners.add(listener);
    return () => this.#unauthenticatedListeners.delete(listener);
  }

  #uuid(value: string): string {
    if (!isUuid(value)) throw new ProductAuthError('rejected', 'Workspace request scope is invalid.');
    return encodeURIComponent(value);
  }

  #invitationToken(value: string): string {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(value)) {
      throw new ProductAuthError('rejected', 'Invitation token is invalid.');
    }
    return value;
  }

  #workspacePath(workspaceId: string, suffix: string): string {
    return `/api/workspaces/${this.#uuid(workspaceId)}${suffix}`;
  }

  async #workspaceMutation(
    pathname: string,
    method: 'DELETE' | 'PATCH' | 'POST',
    body: Record<string, unknown> | undefined,
  ): Promise<Response> {
    return this.#authMutation(pathname, method, body);
  }

  async #authMutation(
    pathname: string,
    method: 'DELETE' | 'PATCH' | 'POST',
    body: Record<string, unknown> | undefined,
  ): Promise<Response> {
    if (!this.#csrfToken) throw new ProductAuthError('unauthenticated', 'Authentication is required.');
    const response = await this.#request(pathname, {
      method,
      headers: {
        'X-CSRF-Token': this.#csrfToken,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return response;
  }

  #invalidateSession(): void {
    this.#csrfToken = null;
    for (const listener of this.#unauthenticatedListeners) listener();
  }

  async #parseWorkspaceMember(response: Response): Promise<ProductWorkspaceMember> {
    try {
      return parseProductWorkspaceMember(await this.#json(response));
    } catch {
      throw new ProductAuthError('invalid-response', 'The workspace API returned an invalid member.');
    }
  }

  async #historyGet(
    pathname: string,
    workspaceId: string,
    options: { cursor?: string; limit?: number; signal?: AbortSignal },
  ): Promise<unknown> {
    const limit = options.limit ?? PRODUCT_HISTORY_DEFAULT_LIMIT;
    if (
      !isUuid(workspaceId)
      || !Number.isSafeInteger(limit)
      || limit < 1
      || limit > PRODUCT_HISTORY_MAX_LIMIT
      || (options.cursor !== undefined && (!/^[A-Za-z0-9_-]+$/u.test(options.cursor) || options.cursor.length > 512))
      || !/^\/api\/history\/threads(?:\/[^/?#]+)?$/u.test(pathname)
    ) {
      throw new ProductAuthError('rejected', 'Saved history request scope is invalid.');
    }
    const url = new URL(pathname, this.apiBase);
    if (url.origin !== this.apiBase || url.pathname !== pathname || url.search || url.hash) {
      throw new ProductAuthError('rejected', 'Saved history request path is invalid.');
    }
    url.searchParams.set(PRODUCT_WORKSPACE_QUERY_PARAM, workspaceId);
    url.searchParams.set('limit', String(limit));
    if (options.cursor) url.searchParams.set('cursor', options.cursor);
    const response = await this.#request(`${url.pathname}${url.search}`, {
      method: 'GET',
      signal: options.signal,
      headers: { [PRODUCT_WORKSPACE_HEADER_NAME]: workspaceId },
    });
    return this.#json(response);
  }

  async #establish(
    pathname: string,
    expectedStatus: number,
    input: Record<string, unknown>,
  ): Promise<ProductAuthContext> {
    const response = await this.#request(pathname, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (response.status !== expectedStatus) {
      throw new ProductAuthError('invalid-response', 'The authentication response status was invalid.', response.status);
    }
    const parsed = parseProductAuthResponse(await this.#json(response), true);
    this.#csrfToken = parsed.csrfToken;
    return parsed.context;
  }

  async #request(pathname: string, init: RequestInit): Promise<Response> {
    let response: Response;
    try {
      const headers = init.headers instanceof Headers || Array.isArray(init.headers)
        ? new Headers(init.headers)
        : { Accept: 'application/json', ...init.headers };
      if (headers instanceof Headers && !headers.has('Accept')) headers.set('Accept', 'application/json');
      response = await this.#fetch(`${this.apiBase}${pathname}`, {
        ...init,
        credentials: 'include',
        cache: 'no-store',
        headers,
      });
    } catch {
      throw new ProductAuthError('unavailable', 'The authentication API is unavailable.');
    }
    if (response.ok) return response;

    const error = parseErrorResponse(await this.#json(response));
    if (response.status === 401 && error.code === 'unauthenticated') {
      this.#invalidateSession();
      throw new ProductAuthError('unauthenticated', error.message, response.status, error.code);
    }
    if (response.status >= 500) {
      throw new ProductAuthError('unavailable', error.message, response.status, error.code);
    }
    throw new ProductAuthError('rejected', error.message, response.status, error.code);
  }

  async #json(response: Response): Promise<unknown> {
    const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
    if (contentType !== 'application/json') {
      throw new ProductAuthError('invalid-response', 'The authentication API did not return JSON.', response.status);
    }
    try {
      return await response.json() as unknown;
    } catch {
      throw new ProductAuthError('invalid-response', 'The authentication API returned malformed JSON.', response.status);
    }
  }
}
