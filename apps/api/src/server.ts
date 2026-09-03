import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  isUuid,
  PRODUCT_HISTORY_DEFAULT_LIMIT,
  PRODUCT_HISTORY_MAX_LIMIT,
  PRODUCT_HISTORY_PREVIEW_CHARACTERS,
  PRODUCT_WORKSPACE_HEADER_NAME,
  PRODUCT_WORKSPACE_QUERY_PARAM,
  workspaceRoles,
  type ProductAuthResponseDto,
  type ProductHistoryPreviewDto,
  type ProductHistoryThreadDetailDto,
  type ProductHistoryThreadPageDto,
  type ProductHistoryThreadSummaryDto,
  type WorkspaceRole,
} from '@kodex/product-contract';
import type {
  AuthContext,
  AuthSessionResult,
  HistoryReader,
  HistoryScope,
  IndexTextDocumentInput,
  IndexTextDocumentResult,
  KnowledgeDocumentPage,
  KnowledgeScope,
  RagConfig,
  RetrievalResult,
  WorkspaceApplication,
} from '@kodex/product-db';
import {
  AuthServiceError,
  HistoryCursorError,
  KnowledgeCursorError,
  KnowledgeNotFoundError,
  KnowledgeOperationError,
  WorkspaceOperationError,
} from '@kodex/product-db';
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

export interface KnowledgeApplication {
  readonly config: Pick<RagConfig, 'maxDocumentCharacters' | 'maxQueryCharacters' | 'maxTopK'>;
  deleteDocument(scope: KnowledgeScope, documentId: string): Promise<void>;
  indexTextDocument(scope: KnowledgeScope, input: IndexTextDocumentInput): Promise<IndexTextDocumentResult>;
  listDocuments(scope: KnowledgeScope, options: { cursor?: string; limit: number }): Promise<KnowledgeDocumentPage>;
  retrieve(scope: KnowledgeScope, query: string, options?: { threshold?: number; topK?: number }): Promise<RetrievalResult>;
}

export interface ProductApiReadiness {
  check(): Promise<void>;
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
  if (error instanceof KnowledgeCursorError) {
    json(response, 400, {
      ok: false,
      error: { code: 'invalid_cursor', message: 'Knowledge cursor is invalid.' },
    });
    return;
  }
  if (error instanceof KnowledgeNotFoundError) {
    json(response, 404, { ok: false, error: { code: 'not_found', message: 'Not found.' } });
    return;
  }
  if (error instanceof KnowledgeOperationError) {
    json(response, 503, {
      ok: false,
      error: { code: 'knowledge_unavailable', message: 'Knowledge retrieval is temporarily unavailable.' },
    });
    return;
  }
  if (error instanceof WorkspaceOperationError) {
    const responses = {
      forbidden: [403, 'workspace_forbidden', 'Workspace access is not permitted.'],
      not_found: [404, 'not_found', 'The existing account or membership was not found.'],
      conflict: [409, 'membership_conflict', 'That account is already a workspace member.'],
      last_owner: [409, 'last_owner', 'A workspace must keep at least one owner.'],
    } as const;
    const [status, code, message] = responses[error.code];
    json(response, status, { ok: false, error: { code, message } });
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
    private readonly knowledge?: KnowledgeApplication,
    private readonly readiness?: ProductApiReadiness,
    private readonly workspaces?: WorkspaceApplication,
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
        response.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
        response.setHeader(
          'Access-Control-Allow-Headers',
          `Content-Type,X-CSRF-Token,${PRODUCT_WORKSPACE_HEADER_NAME}`,
        );
        response.setHeader('Access-Control-Max-Age', '600');
        response.end();
        return;
      }

      const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
      if (url.pathname === '/api/health/live' && request.method === 'GET') {
        json(response, 200, { ok: true });
        return;
      }
      if (url.pathname === '/api/health/ready' && request.method === 'GET') {
        try {
          if (!this.readiness) throw new Error('readiness dependency is unavailable');
          await this.readiness.check();
          json(response, 200, { ok: true });
        } catch {
          json(response, 503, { ok: false });
        }
        return;
      }
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
      if (url.pathname === '/api/workspaces' && request.method === 'POST') {
        const { context } = await this.#workspaceMutationContext(request);
        const application = this.#requireWorkspaces();
        requireJson(request);
        const input = validateCreateWorkspace(await readJsonBody(request, this.config.maxBodyBytes));
        json(response, 201, publicWorkspace(await application.createWorkspace(context.user.id, input.name)));
        return;
      }
      const workspaceMembersMatch = /^\/api\/workspaces\/([^/]+)\/members$/u.exec(url.pathname);
      if (workspaceMembersMatch && request.method === 'GET') {
        const context = await this.#authenticatedContext(request);
        const workspaceId = decodeUuidPath(workspaceMembersMatch[1]);
        const members = await this.#requireWorkspaces().listMembers(context.user.id, workspaceId);
        json(response, 200, { members: members.map(publicWorkspaceMember) });
        return;
      }
      if (workspaceMembersMatch && request.method === 'POST') {
        const { context } = await this.#workspaceMutationContext(request);
        const workspaceId = decodeUuidPath(workspaceMembersMatch[1]);
        requireJson(request);
        const input = validateAddWorkspaceMember(await readJsonBody(request, this.config.maxBodyBytes));
        json(response, 201, publicWorkspaceMember(await this.#requireWorkspaces().addMember(
          context.user.id, workspaceId, input.email, input.role,
        )));
        return;
      }
      const workspaceMemberMatch = /^\/api\/workspaces\/([^/]+)\/members\/([^/]+)$/u.exec(url.pathname);
      if (workspaceMemberMatch && request.method === 'PATCH') {
        const { context } = await this.#workspaceMutationContext(request);
        const workspaceId = decodeUuidPath(workspaceMemberMatch[1]);
        const targetUserId = decodeUuidPath(workspaceMemberMatch[2]);
        requireJson(request);
        const { role } = validateWorkspaceRoleUpdate(await readJsonBody(request, this.config.maxBodyBytes));
        json(response, 200, publicWorkspaceMember(await this.#requireWorkspaces().updateMemberRole(
          context.user.id, workspaceId, targetUserId, role,
        )));
        return;
      }
      if (workspaceMemberMatch && request.method === 'DELETE') {
        const { context } = await this.#workspaceMutationContext(request);
        const workspaceId = decodeUuidPath(workspaceMemberMatch[1]);
        const targetUserId = decodeUuidPath(workspaceMemberMatch[2]);
        await this.#requireWorkspaces().removeMember(context.user.id, workspaceId, targetUserId);
        response.statusCode = 204;
        response.end();
        return;
      }
      if (url.pathname === '/api/history/threads' && request.method === 'GET' && this.history) {
        const scope = await this.#historyScope(request, url);
        const options = historyPageOptions(url);
        json(response, 200, publicHistoryPage(await this.history.listThreads(scope, options)));
        return;
      }
      if (url.pathname === '/api/knowledge/documents' && request.method === 'GET') {
        const scope = await this.#knowledgeScope(request, url, false);
        const knowledge = this.#requireKnowledge();
        const page = await knowledge.listDocuments(scope, knowledgePageOptions(url));
        json(response, 200, {
          data: page.data.map(publicKnowledgeDocument),
          ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        });
        return;
      }
      if (url.pathname === '/api/knowledge/documents' && request.method === 'POST') {
        const scope = await this.#knowledgeScope(request, url, true);
        const knowledge = this.#requireKnowledge();
        requireJson(request);
        const input = validateKnowledgeDocument(
          await readJsonBody(request, this.config.maxBodyBytes),
          knowledge.config.maxDocumentCharacters,
        );
        const result = await knowledge.indexTextDocument(scope, input);
        json(response, 200, {
          document: publicKnowledgeDocument(result.document),
          chunkCount: result.chunkCount,
          skipped: result.skipped,
        });
        return;
      }
      const knowledgeDocumentMatch = /^\/api\/knowledge\/documents\/([^/]+)$/u.exec(url.pathname);
      if (knowledgeDocumentMatch && request.method === 'DELETE') {
        const scope = await this.#knowledgeScope(request, url, true);
        const knowledge = this.#requireKnowledge();
        const documentId = decodeUuidPath(knowledgeDocumentMatch[1]);
        await knowledge.deleteDocument(scope, documentId);
        response.statusCode = 204;
        response.end();
        return;
      }
      if (url.pathname === '/api/knowledge/query' && request.method === 'POST') {
        const scope = await this.#knowledgeScope(request, url, true);
        const knowledge = this.#requireKnowledge();
        requireJson(request);
        const input = validateKnowledgeQuery(
          await readJsonBody(request, this.config.maxBodyBytes),
          knowledge.config.maxQueryCharacters,
          knowledge.config.maxTopK,
        );
        json(response, 200, await knowledge.retrieve(scope, input.query, input.options));
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
        json(response, 200, publicHistoryDetail(detail));
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
    return this.#authenticatedWorkspaceScope(request, url);
  }

  #requireWorkspaces(): WorkspaceApplication {
    if (!this.workspaces) throw new HttpError(503, 'workspace_unavailable', 'Workspace management is temporarily unavailable.');
    return this.workspaces;
  }

  async #authenticatedContext(request: IncomingMessage): Promise<AuthContext> {
    const token = parseCookies(request.headers.cookie).get(sessionCookieName);
    if (!token) throw new HttpError(401, 'unauthenticated', 'Authentication is required.');
    return this.auth.authenticate(token);
  }

  async #workspaceMutationContext(request: IncomingMessage): Promise<{ context: AuthContext; token: string }> {
    verifyOrigin(request, this.config.allowedOrigins);
    const cookies = parseCookies(request.headers.cookie);
    const token = cookies.get(sessionCookieName);
    if (!token) throw new HttpError(401, 'unauthenticated', 'Authentication is required.');
    const csrfHeader = request.headers['x-csrf-token'];
    if (
      typeof csrfHeader !== 'string'
      || !verifyCsrfToken(token, cookies.get(csrfCookieName), csrfHeader, this.config.cookieSecret)
    ) throw new HttpError(403, 'csrf_failed', 'CSRF validation failed.');
    return { context: await this.auth.authenticate(token), token };
  }

  #requireKnowledge(): KnowledgeApplication {
    if (!this.knowledge) {
      throw new HttpError(503, 'knowledge_unavailable', 'Knowledge retrieval is disabled.');
    }
    return this.knowledge;
  }

  async #knowledgeScope(
    request: IncomingMessage,
    url: URL,
    mutation: boolean,
  ): Promise<KnowledgeScope> {
    if (mutation) {
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
    }
    return this.#authenticatedWorkspaceScope(request, url);
  }

  async #authenticatedWorkspaceScope(request: IncomingMessage, url: URL): Promise<HistoryScope> {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

const HISTORY_CHILD_LIMIT = 250;
const HISTORY_SECRET_TEXT = [
  /\b(?:sk|sess|proj)-[A-Za-z0-9_-]{8,}\b/giu,
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*\b/giu,
  /("?(?:api[_-]?key|token|secret|authorization|password|session)"?\s*[:=]\s*)"?[^\s",}]+"?/giu,
  /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/giu,
] as const;

interface SafeHistoryResult {
  truncated: boolean;
  value: unknown;
}

function normalizedHistoryKey(key: string): string {
  return key.normalize('NFKC').replace(/[^a-z0-9]/giu, '').toLowerCase();
}

function omittedHistoryKey(key: string): boolean {
  const normalized = normalizedHistoryKey(key);
  return normalized === 'sourceinstance'
    || normalized === 'sourceeventid'
    || ['dbid', 'databaseid', 'internalid', 'rowid'].includes(normalized)
    || normalized.includes('checksum')
    || normalized.includes('embedding')
    || normalized.includes('vector')
    || normalized === 'rag'
    || normalized.startsWith('rag')
    || normalized.endsWith('rag');
}

function secretHistoryKey(key: string): boolean {
  const normalized = normalizedHistoryKey(key);
  return [
    'authorization', 'cookie', 'credential', 'password', 'passphrase', 'secret',
    'session', 'token', 'apikey', 'privatekey', 'encrypted',
  ].some((fragment) => normalized.includes(fragment));
}

function cleanHistoryString(value: string): string {
  let clean = [...value].filter((character) => {
    const code = character.codePointAt(0) ?? 0;
    return character === '\n' || character === '\r' || character === '\t' || (code >= 32 && code !== 127);
  }).join('').replace(new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'gu'), '');
  for (const pattern of HISTORY_SECRET_TEXT) {
    clean = clean.replace(pattern, (_match, prefix: unknown) => (
      typeof prefix === 'string' ? `${prefix}[redacted]` : '[redacted]'
    ));
  }
  return clean;
}

function boundedHistoryLabel(value: string, maximum: number): string {
  const clean = cleanHistoryString(value);
  return clean.length <= maximum ? clean : `${clean.slice(0, maximum - 1)}…`;
}

function safeHistoryValue(value: unknown, depth = 0, seen = new WeakSet<object>()): SafeHistoryResult {
  if (depth >= 6) return { value: '[depth limited]', truncated: true };
  if (typeof value === 'string') {
    const clean = cleanHistoryString(value);
    return clean.length > PRODUCT_HISTORY_PREVIEW_CHARACTERS
      ? { value: `${clean.slice(0, PRODUCT_HISTORY_PREVIEW_CHARACTERS - 1)}…`, truncated: true }
      : { value: clean, truncated: false };
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return { value, truncated: false };
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return { value: '[circular reference]', truncated: true };
    seen.add(value);
    const results = value.slice(0, 50).map((entry) => safeHistoryValue(entry, depth + 1, seen));
    const entries = results.map((result) => result.value);
    const omitted = value.length - entries.length;
    if (omitted > 0) entries.push(`[${omitted} more entries]`);
    seen.delete(value);
    return {
      value: entries,
      truncated: omitted > 0 || results.some((result) => result.truncated),
    };
  }
  if (!isRecord(value)) return { value: cleanHistoryString(String(value)), truncated: false };
  if (seen.has(value)) return { value: '[circular reference]', truncated: true };
  seen.add(value);
  const safe: Record<string, unknown> = {};
  let accepted = 0;
  let truncated = false;
  for (const [key, entry] of Object.entries(value)) {
    if (omittedHistoryKey(key)) {
      truncated = true;
      continue;
    }
    if (accepted >= 50) {
      safe._truncated = 'additional fields omitted';
      truncated = true;
      break;
    }
    if (secretHistoryKey(key)) {
      safe[key] = '[redacted]';
    } else {
      const result = safeHistoryValue(entry, depth + 1, seen);
      safe[key] = result.value;
      truncated ||= result.truncated;
    }
    accepted += 1;
  }
  seen.delete(value);
  return { value: safe, truncated };
}

export function publicHistoryPreview(value: unknown): ProductHistoryPreviewDto {
  let content: string;
  let truncated: boolean;
  try {
    const safe = safeHistoryValue(value);
    content = JSON.stringify(safe.value, null, 2) ?? 'null';
    truncated = safe.truncated;
  } catch {
    content = '"[unavailable]"';
    truncated = true;
  }
  if (content.length <= PRODUCT_HISTORY_PREVIEW_CHARACTERS) return { content, truncated };
  return {
    content: `${content.slice(0, PRODUCT_HISTORY_PREVIEW_CHARACTERS - 1)}…`,
    truncated: true,
  };
}

function publicHistoryThread(thread: {
  createdAt: string;
  id: string;
  project: { name: string };
  status: ProductHistoryThreadSummaryDto['status'];
  title: string | null;
  updatedAt: string;
}): ProductHistoryThreadSummaryDto {
  return {
    createdAt: thread.createdAt,
    projectName: boundedHistoryLabel(thread.project.name, 500),
    status: thread.status,
    threadId: thread.id,
    title: thread.title === null ? null : boundedHistoryLabel(thread.title, 1_000),
    updatedAt: thread.updatedAt,
  };
}

function publicHistoryPage(page: Awaited<ReturnType<HistoryReader['listThreads']>>): ProductHistoryThreadPageDto {
  return { nextCursor: page.nextCursor, threads: page.threads.map(publicHistoryThread) };
}

function publicHistoryDetail(
  detail: NonNullable<Awaited<ReturnType<HistoryReader['readThread']>>>,
): ProductHistoryThreadDetailDto {
  const items = detail.items.slice(0, HISTORY_CHILD_LIMIT);
  const toolCalls = detail.toolCalls.slice(0, HISTORY_CHILD_LIMIT);
  const approvals = detail.approvals.slice(0, HISTORY_CHILD_LIMIT);
  return {
    thread: publicHistoryThread(detail.thread),
    turns: detail.turns.map((turn) => ({
      turnId: turn.id,
      status: turn.status,
      startedAt: turn.startedAt,
      completedAt: turn.completedAt,
    })),
    items: items.map((item) => ({
      itemId: item.id,
      turnId: item.turnId,
      itemType: boundedHistoryLabel(item.itemType, 200),
      role: item.role === null ? null : boundedHistoryLabel(item.role, 100),
      status: item.status,
      startedAt: item.startedAt,
      completedAt: item.completedAt,
      payload: publicHistoryPreview(item.payload),
    })),
    toolCalls: toolCalls.map((call) => ({
      callId: call.id,
      turnId: call.turnId,
      toolName: boundedHistoryLabel(call.toolName, 200),
      status: call.status,
      arguments: publicHistoryPreview(call.arguments),
      result: call.result === null ? null : publicHistoryPreview(call.result),
      requestedAt: call.requestedAt,
      startedAt: call.startedAt,
      completedAt: call.completedAt,
    })),
    approvals: approvals.map((approval) => ({
      requestId: approval.id,
      turnId: approval.turnId,
      approvalType: boundedHistoryLabel(approval.approvalType, 200),
      status: approval.status,
      requestPayload: publicHistoryPreview(approval.requestPayload),
      responsePayload: approval.responsePayload === null ? null : publicHistoryPreview(approval.responsePayload),
      requestedAt: approval.requestedAt,
      resolvedAt: approval.resolvedAt,
    })),
    nextCursor: detail.nextCursor,
    omitted: {
      items: detail.items.length > items.length,
      toolCalls: detail.toolCalls.length > toolCalls.length,
      approvals: detail.approvals.length > approvals.length,
    },
  };
}

function publicKnowledgeDocument(document: {
  createdAt: Date;
  id: string;
  sourceId: string;
  title: string | null;
  updatedAt: Date;
}): Record<string, unknown> {
  return {
    id: document.id,
    sourceId: document.sourceId,
    title: document.title,
    createdAt: document.createdAt.toISOString(),
    updatedAt: document.updatedAt.toISOString(),
  };
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
}

function invalidWorkspaceInput(): never {
  throw new HttpError(422, 'validation_failed', 'Workspace input is invalid.');
}

function workspaceName(value: unknown): string {
  if (typeof value !== 'string' || value !== value.trim() || value !== value.normalize('NFC')) {
    return invalidWorkspaceInput();
  }
  const characters = Array.from(value);
  if (
    characters.length < 1
    || characters.length > 100
    || /\s{2,}/u.test(value)
    || characters.some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || code === 127 || (code >= 0xD800 && code <= 0xDFFF);
    })
  ) return invalidWorkspaceInput();
  return value;
}

function workspaceRole(value: unknown): WorkspaceRole {
  if (typeof value !== 'string' || !workspaceRoles.includes(value as WorkspaceRole)) {
    return invalidWorkspaceInput();
  }
  return value as WorkspaceRole;
}

function workspaceEmail(value: unknown): string {
  if (typeof value !== 'string') return invalidWorkspaceInput();
  const email = value.trim().toLowerCase();
  if (
    email.length < 3
    || email.length > 320
    || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u.test(email)
  ) return invalidWorkspaceInput();
  return email;
}

function validateCreateWorkspace(value: unknown): { name: string } {
  if (!isRecord(value) || !exactKeys(value, ['name'])) return invalidWorkspaceInput();
  return { name: workspaceName(value.name) };
}

function validateAddWorkspaceMember(value: unknown): { email: string; role: WorkspaceRole } {
  if (!isRecord(value) || !exactKeys(value, ['email', 'role'])) return invalidWorkspaceInput();
  return { email: workspaceEmail(value.email), role: workspaceRole(value.role) };
}

function validateWorkspaceRoleUpdate(value: unknown): { role: WorkspaceRole } {
  if (!isRecord(value) || !exactKeys(value, ['role'])) return invalidWorkspaceInput();
  return { role: workspaceRole(value.role) };
}

function publicWorkspace(workspace: { id: string; name: string; role: WorkspaceRole; slug: string }): Record<string, unknown> {
  return { id: workspace.id, name: workspace.name, role: workspace.role, slug: workspace.slug };
}

function publicWorkspaceMember(entry: {
  displayName: string | null;
  email: string;
  joinedAt: Date;
  role: WorkspaceRole;
  userId: string;
}): Record<string, unknown> {
  return {
    displayName: entry.displayName,
    email: entry.email,
    joinedAt: entry.joinedAt.toISOString(),
    role: entry.role,
    userId: entry.userId,
  };
}

function decodeUuidPath(value: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new HttpError(404, 'not_found', 'Not found.');
  }
  if (!isUuid(decoded)) throw new HttpError(404, 'not_found', 'Not found.');
  return decoded;
}

function hasInvalidKnowledgeCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) as number;
    if (codePoint < 32 && codePoint !== 9 && codePoint !== 10 && codePoint !== 13) return true;
    if (codePoint >= 0xD800 && codePoint <= 0xDFFF) return true;
  }
  return false;
}

function validateKnowledgeDocument(value: unknown, maximumCharacters: number): IndexTextDocumentInput {
  if (!isRecord(value) || !exactKeys(value, ['title', 'content'], ['documentId', 'sourceId'])) {
    throw new HttpError(400, 'invalid_request', 'Knowledge document input is invalid.');
  }
  if (
    typeof value.title !== 'string'
    || value.title !== value.title.trim()
    || Array.from(value.title).length < 1
    || Array.from(value.title).length > 200
    || hasInvalidKnowledgeCharacter(value.title)
    || typeof value.content !== 'string'
    || value.content.trim().length === 0
    || Array.from(value.content).length > maximumCharacters
    || hasInvalidKnowledgeCharacter(value.content)
    || (value.documentId !== undefined && !isUuid(value.documentId))
    || (value.sourceId !== undefined && !isUuid(value.sourceId))
  ) {
    throw new HttpError(400, 'invalid_request', 'Knowledge document input is invalid.');
  }
  return {
    title: value.title,
    content: value.content,
    ...(typeof value.documentId === 'string' ? { documentId: value.documentId } : {}),
    ...(typeof value.sourceId === 'string' ? { sourceId: value.sourceId } : {}),
  };
}

function validateKnowledgeQuery(
  value: unknown,
  maximumCharacters: number,
  maximumTopK: number,
): { options: { threshold?: number; topK?: number }; query: string } {
  if (!isRecord(value) || !exactKeys(value, ['query'], ['threshold', 'topK'])) {
    throw new HttpError(400, 'invalid_request', 'Knowledge query input is invalid.');
  }
  if (
    typeof value.query !== 'string'
    || value.query !== value.query.trim()
    || Array.from(value.query).length < 1
    || Array.from(value.query).length > maximumCharacters
    || value.query.includes('\0')
    || (value.topK !== undefined && (!Number.isSafeInteger(value.topK) || (value.topK as number) < 1 || (value.topK as number) > maximumTopK))
    || (value.threshold !== undefined && (typeof value.threshold !== 'number' || !Number.isFinite(value.threshold) || value.threshold < -1 || value.threshold > 1))
  ) {
    throw new HttpError(400, 'invalid_request', 'Knowledge query input is invalid.');
  }
  return {
    query: value.query,
    options: {
      ...(typeof value.topK === 'number' ? { topK: value.topK } : {}),
      ...(typeof value.threshold === 'number' ? { threshold: value.threshold } : {}),
    },
  };
}

function knowledgePageOptions(url: URL): { cursor?: string; limit: number } {
  const rawLimit = url.searchParams.get('limit');
  const limit = rawLimit === null ? 25 : Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new HttpError(400, 'invalid_request', 'Knowledge page limit must be between 1 and 100.');
  }
  const cursors = url.searchParams.getAll('cursor');
  if (cursors.length > 1 || (cursors[0]?.length ?? 0) > 512 || (cursors[0] && !/^[A-Za-z0-9_-]+$/u.test(cursors[0]))) {
    throw new HttpError(400, 'invalid_cursor', 'Knowledge cursor is invalid.');
  }
  return { limit, ...(cursors[0] ? { cursor: cursors[0] } : {}) };
}

function historyPageOptions(url: URL): { cursor?: string; limit: number } {
  const limits = url.searchParams.getAll('limit');
  if (limits.length > 1) {
    throw new HttpError(400, 'invalid_request', 'History page limit must be specified at most once.');
  }
  const rawLimit = limits[0] ?? null;
  const limit = rawLimit === null ? PRODUCT_HISTORY_DEFAULT_LIMIT : Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > PRODUCT_HISTORY_MAX_LIMIT) {
    throw new HttpError(400, 'invalid_request', `History page limit must be between 1 and ${PRODUCT_HISTORY_MAX_LIMIT}.`);
  }
  const cursors = url.searchParams.getAll('cursor');
  if (cursors.length > 1 || (cursors[0]?.length ?? 0) > 512) {
    throw new HttpError(400, 'invalid_cursor', 'History cursor is invalid.');
  }
  return { limit, ...(cursors[0] ? { cursor: cursors[0] } : {}) };
}
