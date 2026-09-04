import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import { PRODUCT_WORKSPACE_HEADER_NAME, PRODUCT_WORKSPACE_QUERY_PARAM } from '@kodex/product-contract';
import type { ServerSocketMessage } from '@kodex/kodex-api';
import { redactSecrets, sanitizeUnknown, verifyOperationsBearer } from '@kodex/shared';
import { WebSocket, WebSocketServer } from 'ws';
import {
  ProductAuthorizationError,
  type ProductAuthorization,
  type ProductAuthorizer,
} from '../auth/product-authorization.js';
import { getGitDiff, getGitStatus } from '../projects/git.js';
import { ALLOWED_METHODS, type KodexRuntime, type RuntimeEvent } from '../runtime.js';
import {
  RuntimeCapacityError,
  type RuntimeLease,
  type RuntimeManager,
} from '../runtime-manager.js';
import { LocalSecurity, LocalSecurityError, parseProductApiOrigins } from './security.js';
import {
  validateAutomationInput, validateIdBody, validateProjectMutation, validateRepositoryConfirm,
  validateRepositoryPreview, validateSettingsPatch, validateSocketMessage,
} from './validation.js';
import { RepositoryIndexError, type RepositoryIndexer } from '../rag/repository-indexer.js';
import type { LocalSecurityMetricEvent } from '../operational-status.js';

export interface LocalOperationsEndpoint {
  snapshot(): Promise<unknown>;
  token: string;
}

export interface LocalHttpServerOptions {
  allowedOrigins: Set<string>;
  authorizationRevalidateMs?: number;
  host: '127.0.0.1';
  port: number;
  productApiOrigins?: ReadonlySet<string>;
  operations?: LocalOperationsEndpoint;
  repositoryIndexer?: RepositoryIndexer;
  securityLog?: (event: LocalSecurityMetricEvent) => void;
  uiRoot?: string;
}

const PRODUCTION_REVALIDATION_MINIMUM_MS = 1_000;

export function authorizationRevalidationDelay(
  expiresAt: Date,
  now: number,
  maximumMs: number,
  afterSuccessfulRevalidation: boolean,
): number {
  const remaining = expiresAt.getTime() - now;
  if (Number.isFinite(remaining) && remaining > 0) return Math.min(maximumMs, remaining);
  return afterSuccessfulRevalidation ? Math.min(PRODUCTION_REVALIDATION_MINIMUM_MS, maximumMs) : 0;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(body));
}

function requestUrl(request: IncomingMessage, port: number): URL {
  return new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
}

async function readJsonBody(request: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > limit) throw new Error('Request body is too large.');
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; } catch {
    throw new Error('Request body contains invalid JSON.');
  }
}

function socketMessage(runtime: KodexRuntime, clientId: string, sequence: number, event: RuntimeEvent): ServerSocketMessage {
  const epoch = runtime.epoch;
  if (event.type === 'notification') return { type: 'notification', epoch, sequence, notification: event.notification };
  if (event.type === 'server-request') return { type: 'server-request', epoch, sequence, request: event.request, owned: event.ownerId === clientId };
  if (event.type === 'server-request-resolved') return { type: 'server-request-resolved', epoch, sequence, requestId: event.requestId, reason: event.reason };
  return { type: 'engine', epoch, sequence, engine: event.engine };
}

function contentType(filename: string): string {
  switch (path.extname(filename).toLocaleLowerCase()) {
    case '.html': return 'text/html; charset=utf-8';
    case '.js': return 'text/javascript; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    case '.svg': return 'image/svg+xml';
    case '.png': return 'image/png';
    case '.ico': return 'image/x-icon';
    case '.woff2': return 'font/woff2';
    default: return 'application/octet-stream';
  }
}

export function injectProductApiOrigin(html: string, origin: string): string {
  if (!html.includes('</head>')) throw new Error('UI index is missing its closing head element.');
  const escaped = origin
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
  return html.replace(
    '</head>',
    `<meta name="kodex-product-api-origin" content="${escaped}"></head>`,
  );
}

export function selectProductApiOrigin(
  productApiOrigins: ReadonlySet<string>,
  requestHost: string | undefined,
): string {
  let hostname: string;
  try {
    hostname = new URL(`http://${requestHost ?? ''}`).hostname;
  } catch {
    throw new Error('Product API runtime origin could not be selected safely.');
  }
  const matches = [...productApiOrigins].filter(
    (origin) => new URL(origin).hostname === hostname,
  );
  if (matches.length !== 1) {
    throw new Error('Product API runtime origin could not be selected safely.');
  }
  return matches[0];
}

interface ClientConnection {
  authorization: ProductAuthorization;
  authorizationTimer: NodeJS.Timeout | null;
  id: string;
  lease: RuntimeLease;
  queued: Array<{ sequence: number; event: RuntimeEvent }>;
  replayComplete: boolean;
  unsubscribe: () => void;
}

function publicError(error: unknown): { code: string; message: string; status: number } {
  if (error instanceof RepositoryIndexError) {
    return { code: error.code, message: error.publicMessage, status: error.status };
  }
  if (error instanceof ProductAuthorizationError || error instanceof LocalSecurityError || error instanceof RuntimeCapacityError) {
    return { code: error.code, message: error.message, status: error.status };
  }
  return { code: 'request_rejected', message: 'The local request could not be completed.', status: 400 };
}

export class LocalHttpServer {
  readonly security: LocalSecurity;
  readonly http: Server;
  readonly webSockets: WebSocketServer;
  readonly authorizationRevalidateMs: number;
  readonly productApiOrigins: ReadonlySet<string>;
  #clients = new Map<WebSocket, ClientConnection>();
  #closing = false;
  #pendingUpgrades = new Set<Duplex>();

  constructor(
    readonly runtimeManager: RuntimeManager,
    readonly authorizer: ProductAuthorizer,
    readonly options: LocalHttpServerOptions,
  ) {
    this.security = new LocalSecurity(options);
    this.productApiOrigins = parseProductApiOrigins([
      ...(options.productApiOrigins ?? ['http://127.0.0.1:47832', 'http://localhost:47832']),
    ].join(','));
    this.authorizationRevalidateMs = options.authorizationRevalidateMs ?? 5 * 60_000;
    if (!Number.isSafeInteger(this.authorizationRevalidateMs) || this.authorizationRevalidateMs <= 0 || this.authorizationRevalidateMs > 5 * 60_000) {
      throw new Error('authorizationRevalidateMs must be between 1 and 300000.');
    }
    this.http = createServer((request, response) => void this.#handleHttp(request, response));
    this.webSockets = new WebSocketServer({ noServer: true, maxPayload: this.security.maxBodyBytes, clientTracking: true });
    this.http.on('upgrade', (request, socket, head) => {
      if (this.#closing) { socket.destroy(); return; }
      this.#pendingUpgrades.add(socket);
      socket.pause();
      void this.#handleUpgrade(request, socket, head);
    });
  }

  async listen(): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      this.http.once('error', reject);
      this.http.listen(this.options.port, this.options.host, () => { this.http.off('error', reject); resolve(); });
    });
    const actualPort = (this.http.address() as AddressInfo).port;
    this.security.options.port = actualPort;
    return actualPort;
  }

  async close(): Promise<void> {
    this.#closing = true;
    for (const socket of this.#pendingUpgrades) socket.destroy();
    this.#pendingUpgrades.clear();
    for (const socket of [...this.#clients.keys()]) {
      this.#cleanupSocket(socket);
      socket.close(1001, 'Kodex is shutting down');
    }
    if (this.webSockets.clients.size > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          for (const socket of this.webSockets.clients) socket.terminate();
        }, 1_000);
        this.webSockets.close(() => { clearTimeout(timer); resolve(); });
      });
    } else {
      this.webSockets.close();
    }
    if (this.http.listening) {
      await new Promise<void>((resolve, reject) => this.http.close((error) => error ? reject(error) : resolve()));
    }
  }

  async #handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    let lease: RuntimeLease | undefined;
    try {
      const url = requestUrl(request, this.options.port);
      if (url.pathname !== '/ws') throw new LocalSecurityError('Unknown WebSocket path.');
      this.security.verifyWebSocket(request);
      const scopes = url.searchParams.getAll(PRODUCT_WORKSPACE_QUERY_PARAM);
      const authorization = await this.authorizer.authorizeRequest(request, scopes.length === 1 ? scopes[0] : undefined);
      if (this.#closing || socket.destroyed) return;
      lease = await this.runtimeManager.acquire(authorization);
      if (socket.destroyed) { lease.release(); return; }
      const activeLease = lease;
      this.webSockets.handleUpgrade(request, socket, head, (webSocket) => {
        this.#handleSocket(webSocket, activeLease, authorization);
        lease = undefined;
        socket.resume();
      });
    } catch (error) {
      lease?.release();
      const failure = publicError(error);
      if (error instanceof RuntimeCapacityError) {
        this.options.securityLog?.({ kind: 'runtime_capacity_rejected', status: failure.status });
      }
      this.options.securityLog?.({ kind: 'ws_upgrade_rejected', status: failure.status });
      if (!socket.destroyed) {
        const reason = failure.status === 400 ? 'Bad Request'
          : failure.status === 401 ? 'Unauthorized'
            : failure.status === 503 ? 'Service Unavailable'
              : 'Forbidden';
        socket.write(`HTTP/1.1 ${failure.status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
        socket.destroy();
      }
    } finally {
      this.#pendingUpgrades.delete(socket);
    }
  }

  #handleSocket(socket: WebSocket, lease: RuntimeLease, authorization: ProductAuthorization): void {
    const runtime = lease.runtime;
    const clientId = randomUUID();
    const connection: ClientConnection = {
      authorization,
      authorizationTimer: null,
      id: clientId,
      lease,
      replayComplete: false,
      queued: [],
      unsubscribe: () => undefined,
    };
    this.#clients.set(socket, connection);
    runtime.registerUi(clientId);
    connection.unsubscribe = runtime.subscribe((sequence, event) => this.#deliverEvent(socket, connection, sequence, event));
    this.#scheduleAuthorizationCheck(socket, connection, false);
    this.#send(socket, {
      type: 'hello', epoch: runtime.epoch, latestSequence: runtime.events.sequence,
      oldestSequence: runtime.events.oldestSequence, engine: runtime.appServer.status(),
    });
    socket.on('message', (raw) => {
      runtime.touchUi(clientId);
      void this.#handleSocketMessage(socket, connection, raw.toString()).catch((error: unknown) => {
        this.#send(socket, { type: 'rpc-error', requestId: 'protocol', code: -32600, message: redactSecrets(error instanceof Error ? error.message : String(error)) });
      });
    });
    socket.once('close', () => this.#cleanupSocket(socket));
  }

  #cleanupSocket(socket: WebSocket): void {
    const connection = this.#clients.get(socket);
    if (!connection) return;
    this.#clients.delete(socket);
    if (connection.authorizationTimer) clearTimeout(connection.authorizationTimer);
    connection.authorizationTimer = null;
    connection.unsubscribe();
    connection.lease.runtime.unregisterUi(connection.id);
    connection.lease.release();
    connection.authorization.sessionToken = '';
    connection.queued = [];
  }

  #scheduleAuthorizationCheck(
    socket: WebSocket,
    connection: ClientConnection,
    afterSuccessfulRevalidation: boolean,
  ): void {
    if (!this.#clients.has(socket)) return;
    if (connection.authorizationTimer) clearTimeout(connection.authorizationTimer);
    const delay = authorizationRevalidationDelay(
      connection.authorization.sessionExpiresAt,
      Date.now(),
      this.authorizationRevalidateMs,
      afterSuccessfulRevalidation,
    );
    connection.authorizationTimer = setTimeout(() => {
      connection.authorizationTimer = null;
      void this.#revalidateSocket(socket, connection);
    }, delay);
    connection.authorizationTimer.unref?.();
  }

  async #revalidateSocket(socket: WebSocket, connection: ClientConnection): Promise<void> {
    if (this.#clients.get(socket) !== connection) return;
    try {
      const next = await this.authorizer.reauthorize(connection.authorization);
      if (this.#clients.get(socket) !== connection) return;
      connection.authorization = next;
      this.options.securityLog?.({ kind: 'ws_revalidation_succeeded', status: 200 });
      this.#scheduleAuthorizationCheck(socket, connection, true);
    } catch (error) {
      if (this.#clients.get(socket) !== connection) return;
      this.options.securityLog?.({ kind: 'ws_revalidation_failed', status: publicError(error).status });
      this.#cleanupSocket(socket);
      socket.close(1008, 'Product authorization is no longer valid');
    }
  }

  #deliverEvent(socket: WebSocket, connection: ClientConnection, sequence: number, event: RuntimeEvent): void {
    if (this.#clients.get(socket) !== connection) return;
    if (!connection.replayComplete) {
      connection.queued.push({ sequence, event });
      if (connection.queued.length > 1_000) socket.close(1013, 'Replay handshake did not complete.');
      return;
    }
    this.#send(socket, socketMessage(connection.lease.runtime, connection.id, sequence, event));
  }

  #send(socket: WebSocket, message: ServerSocketMessage): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > 4 * 1024 * 1024) { socket.close(1013, 'Client cannot keep up; reconnect and replay.'); return; }
    socket.send(JSON.stringify(message));
  }

  async #handleSocketMessage(socket: WebSocket, connection: ClientConnection, raw: string): Promise<void> {
    const runtime = connection.lease.runtime;
    let parsed: unknown;
    try { parsed = JSON.parse(raw) as unknown; } catch { throw new Error('WebSocket message contains invalid JSON.'); }
    const message = validateSocketMessage(parsed, ALLOWED_METHODS);
    if (message.type === 'ping') { this.#send(socket, { type: 'pong' }); return; }
    if (message.type === 'replay') {
      if (message.epoch !== runtime.epoch) {
        this.#send(socket, { type: 'resync-required', reason: 'server-restart', epoch: runtime.epoch, oldestAvailable: runtime.events.oldestSequence, newestAvailable: runtime.events.sequence });
        connection.replayComplete = true;
        connection.queued = [];
        return;
      }
      if (message.afterSequence < runtime.events.oldestSequence - 1) {
        this.#send(socket, { type: 'resync-required', reason: 'replay-gap', epoch: runtime.epoch, oldestAvailable: runtime.events.oldestSequence, newestAvailable: runtime.events.sequence });
        connection.replayComplete = true;
        connection.queued = [];
        return;
      }
      const replayHead = runtime.events.sequence;
      for (const entry of runtime.events.after(message.afterSequence)) {
        if (entry.sequence <= replayHead) this.#send(socket, socketMessage(runtime, connection.id, entry.sequence, entry.value));
      }
      connection.replayComplete = true;
      const afterReplay = connection.queued.filter((entry) => entry.sequence > replayHead);
      connection.queued = [];
      for (const entry of afterReplay) this.#send(socket, socketMessage(runtime, connection.id, entry.sequence, entry.event));
      return;
    }
    if (message.type === 'server-response') {
      if (!await runtime.respondToServerRequest(connection.id, message.requestId, message.result)) throw new Error('This request is read-only, expired, or was already answered.');
      return;
    }
    if (message.type === 'server-error') {
      if (!await runtime.respondToServerRequestError(connection.id, message.requestId, message.code, message.message)) throw new Error('This request is read-only, expired, or was already answered.');
      return;
    }
    try {
      const result = await runtime.handleRpc(message.request);
      this.#send(socket, { type: 'rpc-result', requestId: message.requestId, result: sanitizeUnknown(result) });
    } catch (error) {
      this.#send(socket, { type: 'rpc-error', requestId: message.requestId, code: -32000, message: redactSecrets(error instanceof Error ? error.message : String(error)) });
    }
  }

  async #handleHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    this.security.applyCors(request, response);
    try {
      this.security.verify(request, false);
      if (request.method === 'OPTIONS') {
        if (!request.headers.origin || !this.options.allowedOrigins.has(request.headers.origin)) {
          throw new LocalSecurityError('A valid Origin is required for preflight.');
        }
        response.statusCode = 204;
        response.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
        response.setHeader('Access-Control-Allow-Headers', `Content-Type,X-Kodex-Bootstrap,X-Kodex-CSRF,X-Kodex-Session,${PRODUCT_WORKSPACE_HEADER_NAME}`);
        response.setHeader('Access-Control-Max-Age', '600');
        response.end();
        return;
      }
      const url = requestUrl(request, this.options.port);
      if (url.pathname === '/api/operations/status' && request.method === 'GET') {
        if (!this.options.operations) {
          json(response, 404, { ok: false, error: { code: 'not_found', message: 'Not found.' } });
          return;
        }
        if (
          request.headers.origin
          || !verifyOperationsBearer(request.headers.authorization, this.options.operations.token)
        ) {
          response.setHeader('WWW-Authenticate', 'Bearer');
          json(response, 401, {
            ok: false,
            error: { code: 'operations_unauthorized', message: 'Operations authentication is required.' },
          });
          return;
        }
        json(response, 200, await this.options.operations.snapshot());
        return;
      }
      if (url.pathname === '/api/health' && request.method === 'GET') {
        json(response, 200, { ok: true });
        return;
      }
      if (url.pathname.startsWith('/api/')) {
        const mutation = !['GET', 'HEAD'].includes(request.method ?? 'GET');
        this.security.verify(request, mutation);
        if (url.pathname === '/api/bootstrap' && request.method === 'GET') this.security.verifyBootstrap(request);
        const authorization = await this.authorizer.authorizeRequest(request, request.headers[PRODUCT_WORKSPACE_HEADER_NAME.toLowerCase()]);
        const lease = await this.runtimeManager.acquire(authorization);
        try {
          await this.#routeApi(lease.runtime, lease.scope, request, response, url);
        } finally {
          lease.release();
        }
        return;
      }
      if (this.options.uiRoot && ['GET', 'HEAD'].includes(request.method ?? 'GET')) {
        await this.#serveUi(
          url.pathname,
          request.method === 'HEAD',
          request.headers.host,
          response,
        );
        return;
      }
      json(response, 404, { ok: false, error: { code: 'not_found', message: 'Not found.' } });
    } catch (error) {
      const failure = publicError(error);
      if (error instanceof RuntimeCapacityError) {
        this.options.securityLog?.({ kind: 'runtime_capacity_rejected', status: failure.status });
      }
      if (failure.status === 401 || failure.status === 403) this.options.securityLog?.({ kind: 'http_rejected', status: failure.status });
      json(response, failure.status, { ok: false, error: { code: failure.code, message: failure.message } });
    }
  }

  async #routeApi(
    runtime: KodexRuntime,
    scope: { userId: string; workspaceId: string },
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<void> {
    if (url.pathname === '/api/bootstrap' && request.method === 'GET') {
      this.security.setSessionCookie(response);
      json(response, 200, await runtime.bootstrap(`http://127.0.0.1:${this.options.port}`, this.security.csrfToken, this.security.sessionToken));
      return;
    }
    if (url.pathname === '/api/settings' && request.method === 'PUT') {
      json(response, 200, await runtime.updateSettings(validateSettingsPatch(await readJsonBody(request, this.security.maxBodyBytes)))); return;
    }
    if (url.pathname === '/api/projects' && request.method === 'GET') {
      json(response, 200, { data: await runtime.projects.list(), active: await runtime.projects.active() }); return;
    }
    if (url.pathname === '/api/projects' && request.method === 'POST') {
      const body = validateProjectMutation(await readJsonBody(request, this.security.maxBodyBytes));
      const project = 'id' in body ? await runtime.projects.select(body.id) : await runtime.projects.add(body.path, body.name);
      json(response, 200, project); return;
    }
    if (url.pathname === '/api/projects' && request.method === 'DELETE') {
      const body = validateIdBody(await readJsonBody(request, this.security.maxBodyBytes), 'project');
      await runtime.projects.remove(body.id); json(response, 200, {}); return;
    }
    if (url.pathname === '/api/knowledge/repository/preview' && request.method === 'POST') {
      if (!this.options.repositoryIndexer) {
        throw new RepositoryIndexError(503, 'repository_index_unavailable', 'Repository indexing is disabled.');
      }
      const body = validateRepositoryPreview(await readJsonBody(request, this.security.maxBodyBytes));
      const project = await runtime.projects.active();
      if (project.id !== body.projectId) {
        throw new RepositoryIndexError(409, 'project_changed', 'The active project changed. Create a new preview.');
      }
      json(response, 200, await this.options.repositoryIndexer.preview(scope, project));
      return;
    }
    if (url.pathname === '/api/knowledge/repository/confirm' && request.method === 'POST') {
      if (!this.options.repositoryIndexer) {
        throw new RepositoryIndexError(503, 'repository_index_unavailable', 'Repository indexing is disabled.');
      }
      const body = validateRepositoryConfirm(await readJsonBody(request, this.security.maxBodyBytes));
      const project = await runtime.projects.active();
      if (project.id !== body.projectId) {
        throw new RepositoryIndexError(409, 'project_changed', 'The active project changed. Create a new preview.');
      }
      json(response, 200, await this.options.repositoryIndexer.confirm(scope, project, body));
      return;
    }
    if (url.pathname === '/api/automations' && request.method === 'GET') { json(response, 200, { data: await runtime.store.listAutomations() }); return; }
    if (url.pathname === '/api/automations' && request.method === 'POST') {
      json(response, 200, await runtime.createAutomation(validateAutomationInput(await readJsonBody(request, this.security.maxBodyBytes)))); return;
    }
    if (url.pathname === '/api/automations/run' && request.method === 'POST') {
      const body = validateIdBody(await readJsonBody(request, this.security.maxBodyBytes), 'automation');
      json(response, 200, await runtime.runAutomation(body.id)); return;
    }
    if (url.pathname === '/api/automations' && request.method === 'DELETE') {
      const body = validateIdBody(await readJsonBody(request, this.security.maxBodyBytes), 'automation');
      await runtime.store.deleteAutomation(body.id); json(response, 200, {}); return;
    }
    if (url.pathname === '/api/engine/restart' && request.method === 'POST') { json(response, 200, await runtime.restartAppServer()); return; }
    if (url.pathname === '/api/git/status' && request.method === 'GET') { json(response, 200, await getGitStatus((await runtime.projects.active()).path)); return; }
    if (url.pathname === '/api/git/diff' && request.method === 'GET') {
      const selectedPath = url.searchParams.get('path') ?? '';
      json(response, 200, { path: selectedPath, diff: await getGitDiff((await runtime.projects.active()).path, selectedPath) }); return;
    }
    json(response, 404, { ok: false, error: { code: 'not_found', message: 'Not found.' } });
  }

  async #serveUi(
    pathname: string,
    head: boolean,
    requestHost: string | undefined,
    response: ServerResponse,
  ): Promise<void> {
    const root = path.resolve(this.options.uiRoot!);
    const requested = decodeURIComponent(pathname);
    let relative = requested === '/' ? 'index.html' : requested.replace(/^\/+/, '');
    let filename = path.resolve(root, relative);
    if (path.relative(root, filename).startsWith('..')) throw new Error('Static path must remain inside the UI bundle.');
    try {
      if (!(await stat(filename)).isFile()) throw new Error('not a file');
    } catch {
      relative = 'index.html';
      filename = path.join(root, relative);
    }
    let contents: Buffer | string = await readFile(filename);
    if (relative === 'index.html') {
      const productApiOrigin = selectProductApiOrigin(this.productApiOrigins, requestHost);
      contents = injectProductApiOrigin(contents.toString('utf8'), productApiOrigin);
    }
    response.statusCode = 200;
    response.setHeader('Content-Type', contentType(filename));
    response.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss: ${[...this.productApiOrigins].join(' ')}; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`);
    if (relative.startsWith('assets/')) response.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    response.end(head ? undefined : contents);
  }
}
