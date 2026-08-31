import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  isUuid,
  PRODUCT_WORKSPACE_HEADER_NAME,
  PRODUCT_WORKSPACE_QUERY_PARAM,
  type ProductAuthResponseDto,
} from '@kodex/product-contract';
import type { AuthContext, AuthSessionResult, HistoryReader, HistoryScope } from '@kodex/product-db';
import { AuthServiceError, HistoryCursorError } from '@kodex/product-db';
import type { ProductApiConfig } from './config.js';
import {
  clearSessionCookies,
  createCsrfToken,
  createSessionCookies,
  csrfCookieName,
  parseCookies,
  sessionCookieName,
  verifyCsrfToken,
} from './cookies.js';

export interface AuthApplication {
  authenticate(token: string | undefined): Promise<AuthContext>;
  login(value: unknown): Promise<AuthSessionResult>;
  logout(token: string | undefined): Promise<void>;
  register(value: unknown): Promise<AuthSessionResult>;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly publicMessage: string,
  ) {
    super(code);
    this.name = 'HttpError';
  }
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(value));
}

function applySecurityHeaders(response: ServerResponse): void {
  response.setHeader('Cache-Control', 'no-store, max-age=0');
  response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  response.setHeader('Cross-Origin-Resource-Policy', 'same-site');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
}

function applyCors(
  request: IncomingMessage,
  response: ServerResponse,
  allowedOrigins: ReadonlySet<string>,
): void {
  const origin = request.headers.origin;
  if (origin && allowedOrigins.has(origin)) {
    response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Access-Control-Allow-Credentials', 'true');
    response.setHeader('Vary', 'Origin');
  }
}

function verifyOrigin(request: IncomingMessage, allowedOrigins: ReadonlySet<string>): void {
  const origin = request.headers.origin;
  if (!origin || !allowedOrigins.has(origin)) {
    throw new HttpError(403, 'forbidden', 'Request origin is not allowed.');
  }
}

function verifyHost(request: IncomingMessage, allowedHosts: ReadonlySet<string>): void {
  const host = request.headers.host?.toLowerCase();
  if (!host || !allowedHosts.has(host)) {
    throw new HttpError(403, 'forbidden', 'Request host is not allowed.');
  }
}

function requireJson(request: IncomingMessage): void {
  const contentType = request.headers['content-type']?.split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    throw new HttpError(415, 'unsupported_media_type', 'Content-Type must be application/json.');
  }
}

async function readJsonBody(request: IncomingMessage, limit: number): Promise<unknown> {
  const declaredLength = Number(request.headers['content-length'] ?? 0);
  if (!Number.isFinite(declaredLength) || declaredLength < 0 || declaredLength > limit) {
    throw new HttpError(413, 'payload_too_large', 'Request body is too large.');
  }
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > limit) {
      throw new HttpError(413, 'payload_too_large', 'Request body is too large.');
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) {
    throw new HttpError(400, 'invalid_request', 'Request body is invalid.');
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new HttpError(400, 'invalid_request', 'Request body is invalid.');
  }
}

function publicAuthContext(context: AuthContext, csrfToken: string): ProductAuthResponseDto {
  return {
    user: {
      id: context.user.id,
      email: context.user.email,
      displayName: context.user.displayName,
      createdAt: context.user.createdAt.toISOString(),
    },
    workspaces: context.memberships,
    session: { expiresAt: context.expiresAt.toISOString() },
    csrfToken,
  };
}

function authResponse(result: AuthSessionResult, csrfToken: string): ProductAuthResponseDto {
  return {
    ...publicAuthContext(result.context, csrfToken),
    ...(result.defaultWorkspace ? { defaultWorkspace: result.defaultWorkspace } : {}),
  };
}

function errorResponse(response: ServerResponse, error: unknown): void {
  if (error instanceof HttpError) {
    json(response, error.status, {
      ok: false,
      error: { code: error.code, message: error.publicMessage },
    });
    return;
  }
  if (error instanceof AuthServiceError) {
    const responses = {
      invalid_request: [400, 'invalid_request', 'Request credentials do not meet the required format.'],
      invalid_credentials: [401, 'invalid_credentials', 'Email or password is invalid.'],
      registration_failed: [400, 'registration_failed', 'Account could not be created.'],
      unauthenticated: [401, 'unauthenticated', 'Authentication is required.'],
    } as const;
    const [status, code, message] = responses[error.code];
    json(response, status, { ok: false, error: { code, message } });
    return;
  }
  if (error instanceof HistoryCursorError) {
    json(response, 400, {
      ok: false,
      error: { code: 'invalid_cursor', message: 'History cursor is invalid.' },
    });
    return;
  }
  process.stderr.write('Product API request failed without exposing internal details.\n');
  json(response, 500, {
    ok: false,
    error: { code: 'internal_error', message: 'The request could not be completed.' },
  });
}

export class ProductApiServer {
  readonly http: Server;
  readonly #allowedHosts: Set<string>;

  constructor(
    private readonly auth: AuthApplication,
    private readonly config: ProductApiConfig,
    private readonly history?: HistoryReader,
  ) {
    this.#allowedHosts = new Set(config.allowedHosts);
    this.http = createServer((request, response) => {
      void this.#handle(request, response);
    });
  }

  async listen(): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      this.http.once('error', reject);
      this.http.listen(this.config.port, this.config.host, () => {
        this.http.off('error', reject);
        resolve();
      });
    });
    const port = (this.http.address() as AddressInfo).port;
    if (this.config.port === 0) {
      this.#allowedHosts.add(`${this.config.host.toLowerCase()}:${port}`);
      if (this.config.host === '127.0.0.1') {
        this.#allowedHosts.add(`localhost:${port}`);
      }
    }
    return port;
  }

  async close(): Promise<void> {
    if (!this.http.listening) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      this.http.close((error) => error ? reject(error) : resolve());
    });
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    applySecurityHeaders(response);
    applyCors(request, response, this.config.allowedOrigins);
    try {
      verifyHost(request, this.#allowedHosts);
      const origin = request.headers.origin;
      if (origin && !this.config.allowedOrigins.has(origin)) {
        throw new HttpError(403, 'forbidden', 'Request origin is not allowed.');
      }
      if (request.method === 'OPTIONS') {
        verifyOrigin(request, this.config.allowedOrigins);
        response.statusCode = 204;
        response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
        response.setHeader(
          'Access-Control-Allow-Headers',
          `Content-Type,X-CSRF-Token,${PRODUCT_WORKSPACE_HEADER_NAME}`,
        );
        response.setHeader('Access-Control-Max-Age', '600');
        response.end();
        return;
      }

      const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
      if (url.pathname === '/api/auth/register' && request.method === 'POST') {
        verifyOrigin(request, this.config.allowedOrigins);
        requireJson(request);
        const result = await this.auth.register(
          await readJsonBody(request, this.config.maxBodyBytes),
        );
        response.setHeader('Set-Cookie', createSessionCookies(
          result.token,
          result.context.expiresAt,
          this.config.cookieSecret,
          this.config.secureCookies,
        ));
        json(response, 201, authResponse(
          result,
          createCsrfToken(result.token, this.config.cookieSecret),
        ));
        return;
      }
      if (url.pathname === '/api/auth/login' && request.method === 'POST') {
        verifyOrigin(request, this.config.allowedOrigins);
        requireJson(request);
        const result = await this.auth.login(
          await readJsonBody(request, this.config.maxBodyBytes),
        );
        response.setHeader('Set-Cookie', createSessionCookies(
          result.token,
          result.context.expiresAt,
          this.config.cookieSecret,
          this.config.secureCookies,
        ));
        json(response, 200, authResponse(
          result,
          createCsrfToken(result.token, this.config.cookieSecret),
        ));
        return;
      }
      if (url.pathname === '/api/auth/logout' && request.method === 'POST') {
        verifyOrigin(request, this.config.allowedOrigins);
        const cookies = parseCookies(request.headers.cookie);
        const sessionToken = cookies.get(sessionCookieName);
        const csrfHeader = request.headers['x-csrf-token'];
        if (
          !sessionToken
          || typeof csrfHeader !== 'string'
          || !verifyCsrfToken(
            sessionToken,
            cookies.get(csrfCookieName),
            csrfHeader,
            this.config.cookieSecret,
          )
        ) {
          throw new HttpError(403, 'csrf_failed', 'CSRF validation failed.');
        }
        await this.auth.logout(sessionToken);
        response.statusCode = 204;
        response.setHeader('Set-Cookie', clearSessionCookies(this.config.secureCookies));
        response.end();
        return;
      }
      if (url.pathname === '/api/auth/me' && request.method === 'GET') {
        const cookies = parseCookies(request.headers.cookie);
        const sessionToken = cookies.get(sessionCookieName);
        if (!sessionToken) {
          throw new HttpError(401, 'unauthenticated', 'Authentication is required.');
        }
        const context = await this.auth.authenticate(sessionToken);
        json(response, 200, publicAuthContext(
          context,
          createCsrfToken(sessionToken, this.config.cookieSecret),
        ));
        return;
      }
      if (url.pathname === '/api/history/threads' && request.method === 'GET' && this.history) {
        const scope = await this.#historyScope(request, url);
        const options = historyPageOptions(url);
        json(response, 200, await this.history.listThreads(scope, options));
        return;
      }
      const historyThreadMatch = /^\/api\/history\/threads\/([^/]+)$/u.exec(url.pathname);
      if (historyThreadMatch && request.method === 'GET' && this.history) {
        const scope = await this.#historyScope(request, url);
        let codexThreadId: string;
        try {
          codexThreadId = decodeURIComponent(historyThreadMatch[1]);
        } catch {
          throw new HttpError(404, 'not_found', 'Not found.');
        }
        if (codexThreadId.length === 0 || codexThreadId.length > 256) {
          throw new HttpError(404, 'not_found', 'Not found.');
        }
        const detail = await this.history.readThread(scope, codexThreadId, historyPageOptions(url));
        if (!detail) throw new HttpError(404, 'not_found', 'Not found.');
        json(response, 200, detail);
        return;
      }
      json(response, 404, {
        ok: false,
        error: { code: 'not_found', message: 'Not found.' },
      });
    } catch (error) {
      errorResponse(response, error);
    }
  }

  async #historyScope(request: IncomingMessage, url: URL): Promise<HistoryScope> {
    const queryWorkspaces = url.searchParams.getAll(PRODUCT_WORKSPACE_QUERY_PARAM);
    const headerWorkspace = request.headers[PRODUCT_WORKSPACE_HEADER_NAME.toLowerCase()];
    if (
      queryWorkspaces.length !== 1
      || !isUuid(queryWorkspaces[0])
      || typeof headerWorkspace !== 'string'
      || !isUuid(headerWorkspace)
      || headerWorkspace !== queryWorkspaces[0]
    ) {
      throw new HttpError(403, 'workspace_forbidden', 'Workspace access is not permitted.');
    }
    const token = parseCookies(request.headers.cookie).get(sessionCookieName);
    if (!token) throw new HttpError(401, 'unauthenticated', 'Authentication is required.');
    const context = await this.auth.authenticate(token);
    if (!context.memberships.some((membership) => membership.id === headerWorkspace)) {
      throw new HttpError(403, 'workspace_forbidden', 'Workspace access is not permitted.');
    }
    return { userId: context.user.id, workspaceId: headerWorkspace };
  }
}

function historyPageOptions(url: URL): { cursor?: string; limit: number } {
  const rawLimit = url.searchParams.get('limit');
  const limit = rawLimit === null ? 25 : Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new HttpError(400, 'invalid_request', 'History page limit must be between 1 and 100.');
  }
  const cursors = url.searchParams.getAll('cursor');
  if (cursors.length > 1 || (cursors[0]?.length ?? 0) > 512) {
    throw new HttpError(400, 'invalid_cursor', 'History cursor is invalid.');
  }
  return { limit, ...(cursors[0] ? { cursor: cursors[0] } : {}) };
}
