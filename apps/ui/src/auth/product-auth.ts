export const workspaceRoles = ['owner', 'admin', 'member', 'viewer'] as const;

export type WorkspaceRole = (typeof workspaceRoles)[number];

export interface ProductUser {
  createdAt: string;
  displayName: string | null;
  email: string;
  id: string;
}

export interface ProductWorkspace {
  id: string;
  name: string;
  role: WorkspaceRole;
  slug: string;
}

export interface ProductAuthContext {
  defaultWorkspace?: ProductWorkspace;
  session: { expiresAt: string };
  user: ProductUser;
  workspaces: ProductWorkspace[];
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

export function resolveProductApiBase(
  configuredBase: string | undefined,
  pageUrl: string,
  development: boolean,
): string {
  const page = new URL(pageUrl);
  const candidate = configuredBase?.trim() || (development
    ? 'http://127.0.0.1:47832'
    : page.origin);
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new ProductAuthConfigurationError('VITE_PRODUCT_API_URL must be an absolute HTTP(S) origin.');
  }
  if (
    !['http:', 'https:'].includes(url.protocol)
    || url.origin !== candidate
    || url.username
    || url.password
  ) {
    throw new ProductAuthConfigurationError('VITE_PRODUCT_API_URL must be an exact HTTP(S) origin.');
  }
  if (
    development
    && loopbackAlias(page.hostname)
    && loopbackAlias(url.hostname)
    && page.hostname !== url.hostname
  ) {
    throw new ProductAuthConfigurationError(
      'The UI and product API must use the same loopback hostname; do not mix localhost and 127.0.0.1.',
    );
  }
  return url.origin;
}

export class ProductAuthClient {
  readonly apiBase: string;
  readonly #fetch: typeof globalThis.fetch;
  #csrfToken: string | null = null;

  constructor(options: ProductAuthClientOptions = {}) {
    const pageUrl = options.pageUrl ?? window.location.href;
    const development = options.development ?? import.meta.env.DEV;
    this.apiBase = resolveProductApiBase(
      options.apiBase ?? import.meta.env.VITE_PRODUCT_API_URL,
      pageUrl,
      development,
    );
    this.#fetch = options.fetch ?? globalThis.fetch;
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

  clearMemory(): void {
    this.#csrfToken = null;
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
      response = await this.#fetch(`${this.apiBase}${pathname}`, {
        ...init,
        credentials: 'include',
        cache: 'no-store',
        headers: { Accept: 'application/json', ...init.headers },
      });
    } catch {
      throw new ProductAuthError('unavailable', 'The authentication API is unavailable.');
    }
    if (response.ok) return response;

    const error = parseErrorResponse(await this.#json(response));
    if (response.status === 401 && error.code === 'unauthenticated') {
      this.#csrfToken = null;
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
