import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ClientRequest } from '@kodex/codex-protocol';
import type { ClientSocketMessage, ServerSocketMessage } from '@kodex/kodex-api';
import { redactSecrets, sanitizeUnknown } from '@kodex/shared';
import { WebSocket, WebSocketServer } from 'ws';
import type { KodexRuntime, RuntimeEvent } from '../runtime.js';
import { getGitDiff, getGitStatus } from '../projects/git.js';
import { LocalSecurity } from './security.js';

export interface LocalHttpServerOptions {
  host: '127.0.0.1';
  port: number;
  allowedOrigins: Set<string>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
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
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function socketMessage(sequence: number, event: RuntimeEvent): ServerSocketMessage {
  if (event.type === 'notification') return { type: 'notification', sequence, notification: event.notification };
  if (event.type === 'server-request') return { type: 'server-request', sequence, request: event.request };
  return { type: 'engine', sequence, engine: event.engine };
}

export class LocalHttpServer {
  readonly security: LocalSecurity;
  readonly http: Server;
  readonly webSockets: WebSocketServer;
  #unsubscribe: (() => void) | null = null;

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
    this.#unsubscribe = runtime.subscribe((sequence, event) => this.broadcast(socketMessage(sequence, event)));
  }

  async listen(): Promise<number> {
    await this.runtime.initialize();
    await new Promise<void>((resolve, reject) => {
      this.http.once('error', reject);
      this.http.listen(this.options.port, this.options.host, () => {
        this.http.off('error', reject);
        resolve();
      });
    });
    const actualPort = (this.http.address() as AddressInfo).port;
    this.security.options.port = actualPort;
    return actualPort;
  }

  async close(): Promise<void> {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    for (const socket of this.webSockets.clients) socket.close(1001, 'Kodex is shutting down');
    await new Promise<void>((resolve) => this.webSockets.close(() => resolve()));
    await new Promise<void>((resolve, reject) => this.http.close((error) => error ? reject(error) : resolve()));
  }

  broadcast(message: ServerSocketMessage): void {
    for (const socket of this.webSockets.clients) this.#send(socket, message);
  }

  #send(socket: WebSocket, message: ServerSocketMessage): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > 4 * 1024 * 1024) {
      socket.close(1013, 'Client cannot keep up; reconnect and replay.');
      return;
    }
    socket.send(JSON.stringify(message));
  }

  #handleSocket(socket: WebSocket): void {
    this.#send(socket, { type: 'hello', sequence: this.runtime.events.sequence, engine: this.runtime.appServer.status() });
    socket.on('message', (raw) => {
      void this.#handleSocketMessage(socket, raw.toString()).catch((error: unknown) => {
        this.#send(socket, { type: 'rpc-error', requestId: 'protocol', code: -32600, message: redactSecrets(error instanceof Error ? error.message : String(error)) });
      });
    });
  }

  async #handleSocketMessage(socket: WebSocket, raw: string): Promise<void> {
    const parsed = JSON.parse(raw) as unknown;
    if (!isObject(parsed) || typeof parsed.type !== 'string') throw new Error('Invalid Kodex WebSocket message.');
    const message = parsed as ClientSocketMessage;
    if (message.type === 'ping') {
      this.#send(socket, { type: 'pong' });
      return;
    }
    if (message.type === 'replay') {
      const after = Math.max(0, Number(message.afterSequence) || 0);
      if (after > 0 && after < this.runtime.events.oldestSequence - 1) {
        this.#send(socket, { type: 'replay-gap', oldestAvailable: this.runtime.events.oldestSequence, newestAvailable: this.runtime.events.sequence });
      }
      for (const entry of this.runtime.events.after(after)) this.#send(socket, socketMessage(entry.sequence, entry.value));
      return;
    }
    if (message.type === 'server-response') {
      await this.runtime.respondToServerRequest(message.requestId, message.result);
      return;
    }
    if (message.type === 'server-error') {
      this.runtime.appServer.respondError(message.requestId, message.code, message.message);
      return;
    }
    if (message.type === 'rpc') {
      if (typeof message.requestId !== 'string' || !isObject(message.request) || typeof message.request.method !== 'string') {
        throw new Error('Invalid RPC request envelope.');
      }
      try {
        const result = await this.runtime.handleRpc(message.request as ClientRequest);
        this.#send(socket, { type: 'rpc-result', requestId: message.requestId, result: sanitizeUnknown(result) });
      } catch (error) {
        this.#send(socket, {
          type: 'rpc-error',
          requestId: message.requestId,
          code: -32000,
          message: redactSecrets(error instanceof Error ? error.message : String(error)),
        });
      }
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
      if (url.pathname === '/api/health' && request.method === 'GET') {
        json(response, 200, { ok: true, engine: this.runtime.appServer.status() });
        return;
      }
      if (url.pathname === '/api/bootstrap' && request.method === 'GET') {
        this.security.verifyBootstrap(request);
        this.security.setSessionCookie(response);
        json(response, 200, await this.runtime.bootstrap(`http://127.0.0.1:${this.options.port}`, this.security.csrfToken, this.security.sessionToken));
        return;
      }
      if (url.pathname === '/api/settings' && request.method === 'PUT') {
        const body = await readJsonBody(request, this.security.maxBodyBytes);
        json(response, 200, await this.runtime.store.writeSettings(isObject(body) ? body : {}));
        return;
      }
      if (url.pathname === '/api/projects' && request.method === 'GET') {
        json(response, 200, { data: await this.runtime.projects.list(), active: await this.runtime.projects.active() });
        return;
      }
      if (url.pathname === '/api/projects' && request.method === 'POST') {
        const body = await readJsonBody(request, this.security.maxBodyBytes);
        if (!isObject(body)) throw new Error('Project body must be an object.');
        const project = typeof body.id === 'string'
          ? await this.runtime.projects.select(body.id)
          : await this.runtime.projects.add(String(body.path ?? ''), typeof body.name === 'string' ? body.name : undefined);
        json(response, 200, project);
        return;
      }
      if (url.pathname === '/api/projects' && request.method === 'DELETE') {
        const body = await readJsonBody(request, this.security.maxBodyBytes);
        if (!isObject(body) || typeof body.id !== 'string') throw new Error('Project id is required.');
        await this.runtime.projects.remove(body.id);
        json(response, 200, {});
        return;
      }
      if (url.pathname === '/api/automations' && request.method === 'GET') {
        json(response, 200, { data: await this.runtime.store.listAutomations() });
        return;
      }
      if (url.pathname === '/api/automations' && request.method === 'POST') {
        const body = await readJsonBody(request, this.security.maxBodyBytes);
        if (!isObject(body)) throw new Error('Automation body must be an object.');
        json(response, 200, await this.runtime.createAutomation({
          name: String(body.name ?? ''),
          prompt: String(body.prompt ?? ''),
          intervalMinutes: Number(body.intervalMinutes ?? 60),
          projectId: typeof body.projectId === 'string' ? body.projectId : undefined,
        }));
        return;
      }
      if (url.pathname === '/api/automations/run' && request.method === 'POST') {
        const body = await readJsonBody(request, this.security.maxBodyBytes);
        if (!isObject(body) || typeof body.id !== 'string') throw new Error('Automation id is required.');
        json(response, 200, await this.runtime.runAutomation(body.id));
        return;
      }
      if (url.pathname === '/api/automations' && request.method === 'DELETE') {
        const body = await readJsonBody(request, this.security.maxBodyBytes);
        if (!isObject(body) || typeof body.id !== 'string') throw new Error('Automation id is required.');
        await this.runtime.store.deleteAutomation(body.id);
        json(response, 200, {});
        return;
      }
      if (url.pathname === '/api/git/status' && request.method === 'GET') {
        json(response, 200, await getGitStatus((await this.runtime.projects.active()).path));
        return;
      }
      if (url.pathname === '/api/git/diff' && request.method === 'GET') {
        json(response, 200, { path: url.searchParams.get('path') ?? '', diff: await getGitDiff((await this.runtime.projects.active()).path, url.searchParams.get('path') ?? '') });
        return;
      }
      json(response, 404, { ok: false, error: 'Not found.' });
    } catch (error) {
      json(response, 400, { ok: false, error: redactSecrets(error instanceof Error ? error.message : String(error)) });
    }
  }
}
