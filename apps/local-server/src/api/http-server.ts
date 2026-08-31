import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { ServerSocketMessage } from '@kodex/kodex-api';
import { redactSecrets, sanitizeUnknown } from '@kodex/shared';
import { WebSocket, WebSocketServer } from 'ws';
import { ALLOWED_METHODS, type KodexRuntime, type RuntimeEvent } from '../runtime.js';
import { getGitDiff, getGitStatus } from '../projects/git.js';
import { LocalSecurity } from './security.js';
import {
  validateAutomationInput, validateIdBody, validateProjectMutation, validateSettingsPatch, validateSocketMessage,
} from './validation.js';

export interface LocalHttpServerOptions {
  host: '127.0.0.1';
  port: number;
  allowedOrigins: Set<string>;
  uiRoot?: string;
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
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; } catch (error) {
    throw new Error(`Request body contains invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
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

interface ClientConnection {
  id: string;
  replayComplete: boolean;
  queued: Array<{ sequence: number; event: RuntimeEvent }>;
}

export class LocalHttpServer {
  readonly security: LocalSecurity;
  readonly http: Server;
  readonly webSockets: WebSocketServer;
  #unsubscribe: (() => void) | null = null;
  #clients = new Map<WebSocket, ClientConnection>();

  constructor(readonly runtime: KodexRuntime, readonly options: LocalHttpServerOptions) {
    this.security = new LocalSecurity(options);
    this.http = createServer((request, response) => void this.#handleHttp(request, response));
    this.webSockets = new WebSocketServer({ noServer: true, maxPayload: this.security.maxBodyBytes, clientTracking: true });
    this.http.on('upgrade', (request, socket, head) => {
      try {
        const url = requestUrl(request, options.port);
        if (url.pathname !== '/ws') throw new Error('Unknown WebSocket path.');
        this.security.verifyWebSocket(request);
        this.webSockets.handleUpgrade(request, socket, head, (webSocket) => this.webSockets.emit('connection', webSocket, request));
      } catch (error) {
        void this.runtime.store.appendLog('security.log', `${new Date().toISOString()} WebSocket upgrade rejected: ${error instanceof Error ? error.message : String(error)}`);
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        socket.destroy();
      }
    });
    this.webSockets.on('connection', (socket) => this.#handleSocket(socket));
    this.#unsubscribe = runtime.subscribe((sequence, event) => this.#broadcastEvent(sequence, event));
  }

  async listen(): Promise<number> {
    await this.runtime.initialize();
    await new Promise<void>((resolve, reject) => {
      this.http.once('error', reject);
      this.http.listen(this.options.port, this.options.host, () => { this.http.off('error', reject); resolve(); });
    });
    const actualPort = (this.http.address() as AddressInfo).port;
    this.security.options.port = actualPort;
    return actualPort;
  }

  async close(): Promise<void> {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    for (const [socket, client] of this.#clients) {
      this.runtime.unregisterUi(client.id);
      socket.close(1001, 'Kodex is shutting down');
    }
    this.#clients.clear();
    await new Promise<void>((resolve) => this.webSockets.close(() => resolve()));
    await new Promise<void>((resolve, reject) => this.http.close((error) => error ? reject(error) : resolve()));
  }

  #broadcastEvent(sequence: number, event: RuntimeEvent): void {
    for (const [socket, client] of this.#clients) {
      if (!client.replayComplete) {
        client.queued.push({ sequence, event });
        if (client.queued.length > 1_000) socket.close(1013, 'Replay handshake did not complete.');
        continue;
      }
      this.#send(socket, socketMessage(this.runtime, client.id, sequence, event));
    }
  }

  #send(socket: WebSocket, message: ServerSocketMessage): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > 4 * 1024 * 1024) { socket.close(1013, 'Client cannot keep up; reconnect and replay.'); return; }
    socket.send(JSON.stringify(message));
  }

  #handleSocket(socket: WebSocket): void {
    const clientId = randomUUID();
    this.#clients.set(socket, { id: clientId, replayComplete: false, queued: [] });
    this.runtime.registerUi(clientId);
    this.#send(socket, {
      type: 'hello', epoch: this.runtime.epoch, latestSequence: this.runtime.events.sequence,
      oldestSequence: this.runtime.events.oldestSequence, engine: this.runtime.appServer.status(),
    });
    socket.on('message', (raw) => {
      this.runtime.touchUi(clientId);
      void this.#handleSocketMessage(socket, clientId, raw.toString()).catch((error: unknown) => {
        this.#send(socket, { type: 'rpc-error', requestId: 'protocol', code: -32600, message: redactSecrets(error instanceof Error ? error.message : String(error)) });
      });
    });
    socket.once('close', () => {
      this.#clients.delete(socket);
      this.runtime.unregisterUi(clientId);
    });
  }

  async #handleSocketMessage(socket: WebSocket, clientId: string, raw: string): Promise<void> {
    let parsed: unknown;
    try { parsed = JSON.parse(raw) as unknown; } catch { throw new Error('WebSocket message contains invalid JSON.'); }
    const message = validateSocketMessage(parsed, ALLOWED_METHODS);
    if (message.type === 'ping') { this.#send(socket, { type: 'pong' }); return; }
    if (message.type === 'replay') {
      const client = this.#clients.get(socket);
      if (!client) return;
      if (message.epoch !== this.runtime.epoch) {
        this.#send(socket, { type: 'resync-required', reason: 'server-restart', epoch: this.runtime.epoch, oldestAvailable: this.runtime.events.oldestSequence, newestAvailable: this.runtime.events.sequence });
        client.replayComplete = true;
        client.queued = [];
        return;
      }
      if (message.afterSequence < this.runtime.events.oldestSequence - 1) {
        this.#send(socket, { type: 'resync-required', reason: 'replay-gap', epoch: this.runtime.epoch, oldestAvailable: this.runtime.events.oldestSequence, newestAvailable: this.runtime.events.sequence });
        client.replayComplete = true;
        client.queued = [];
        return;
      }
      const replayHead = this.runtime.events.sequence;
      for (const entry of this.runtime.events.after(message.afterSequence)) {
        if (entry.sequence <= replayHead) this.#send(socket, socketMessage(this.runtime, clientId, entry.sequence, entry.value));
      }
      client.replayComplete = true;
      const afterReplay = client.queued.filter((entry) => entry.sequence > replayHead);
      client.queued = [];
      for (const entry of afterReplay) this.#send(socket, socketMessage(this.runtime, clientId, entry.sequence, entry.event));
      return;
    }
    if (message.type === 'server-response') {
      if (!await this.runtime.respondToServerRequest(clientId, message.requestId, message.result)) throw new Error('This request is read-only, expired, or was already answered.');
      return;
    }
    if (message.type === 'server-error') {
      if (!await this.runtime.respondToServerRequestError(clientId, message.requestId, message.code, message.message)) throw new Error('This request is read-only, expired, or was already answered.');
      return;
    }
    try {
      const result = await this.runtime.handleRpc(message.request);
      this.#send(socket, { type: 'rpc-result', requestId: message.requestId, result: sanitizeUnknown(result) });
    } catch (error) {
      this.#send(socket, { type: 'rpc-error', requestId: message.requestId, code: -32000, message: redactSecrets(error instanceof Error ? error.message : String(error)) });
    }
  }

  async #handleHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    this.security.applyCors(request, response);
    if (request.method === 'OPTIONS') {
      response.statusCode = 204;
      response.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
      response.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-Kodex-CSRF,X-Kodex-Session');
      response.end();
      return;
    }
    try {
      const url = requestUrl(request, this.options.port);
      const mutation = !['GET', 'HEAD'].includes(request.method ?? 'GET');
      this.security.verify(request, mutation);
      if (url.pathname === '/api/health' && request.method === 'GET') { json(response, 200, { ok: true, engine: this.runtime.appServer.status() }); return; }
      if (url.pathname === '/api/bootstrap' && request.method === 'GET') {
        this.security.verifyBootstrap(request);
        this.security.setSessionCookie(response);
        json(response, 200, await this.runtime.bootstrap(`http://127.0.0.1:${this.options.port}`, this.security.csrfToken, this.security.sessionToken));
        return;
      }
      if (url.pathname === '/api/settings' && request.method === 'PUT') {
        json(response, 200, await this.runtime.updateSettings(validateSettingsPatch(await readJsonBody(request, this.security.maxBodyBytes)))); return;
      }
      if (url.pathname === '/api/projects' && request.method === 'GET') {
        json(response, 200, { data: await this.runtime.projects.list(), active: await this.runtime.projects.active() }); return;
      }
      if (url.pathname === '/api/projects' && request.method === 'POST') {
        const body = validateProjectMutation(await readJsonBody(request, this.security.maxBodyBytes));
        const project = 'id' in body ? await this.runtime.projects.select(body.id) : await this.runtime.projects.add(body.path, body.name);
        json(response, 200, project); return;
      }
      if (url.pathname === '/api/projects' && request.method === 'DELETE') {
        const body = validateIdBody(await readJsonBody(request, this.security.maxBodyBytes), 'project');
        await this.runtime.projects.remove(body.id); json(response, 200, {}); return;
      }
      if (url.pathname === '/api/automations' && request.method === 'GET') { json(response, 200, { data: await this.runtime.store.listAutomations() }); return; }
      if (url.pathname === '/api/automations' && request.method === 'POST') {
        json(response, 200, await this.runtime.createAutomation(validateAutomationInput(await readJsonBody(request, this.security.maxBodyBytes)))); return;
      }
      if (url.pathname === '/api/automations/run' && request.method === 'POST') {
        const body = validateIdBody(await readJsonBody(request, this.security.maxBodyBytes), 'automation');
        json(response, 200, await this.runtime.runAutomation(body.id)); return;
      }
      if (url.pathname === '/api/automations' && request.method === 'DELETE') {
        const body = validateIdBody(await readJsonBody(request, this.security.maxBodyBytes), 'automation');
        await this.runtime.store.deleteAutomation(body.id); json(response, 200, {}); return;
      }
      if (url.pathname === '/api/engine/restart' && request.method === 'POST') { json(response, 200, await this.runtime.restartAppServer()); return; }
      if (url.pathname === '/api/git/status' && request.method === 'GET') { json(response, 200, await getGitStatus((await this.runtime.projects.active()).path)); return; }
      if (url.pathname === '/api/git/diff' && request.method === 'GET') {
        const selectedPath = url.searchParams.get('path') ?? '';
        json(response, 200, { path: selectedPath, diff: await getGitDiff((await this.runtime.projects.active()).path, selectedPath) }); return;
      }
      if (url.pathname.startsWith('/api/')) { json(response, 404, { ok: false, error: 'Not found.' }); return; }
      if (this.options.uiRoot && ['GET', 'HEAD'].includes(request.method ?? 'GET')) {
        await this.#serveUi(url.pathname, request.method === 'HEAD', response);
        return;
      }
      json(response, 404, { ok: false, error: 'Not found.' });
    } catch (error) {
      json(response, 400, { ok: false, error: redactSecrets(error instanceof Error ? error.message : String(error)) });
    }
  }

  async #serveUi(pathname: string, head: boolean, response: ServerResponse): Promise<void> {
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
    const contents = await readFile(filename);
    response.statusCode = 200;
    response.setHeader('Content-Type', contentType(filename));
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    if (relative.startsWith('assets/')) response.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    response.end(head ? undefined : contents);
  }
}
