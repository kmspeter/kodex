import type { ClientRequest } from '@kodex/codex-protocol';
import type {
  BootstrapResponse,
  ClientMethod,
  ClientSocketMessage,
  ParamsFor,
  ResponseFor,
  ServerSocketMessage,
} from '@kodex/kodex-api';
import { helloDecision, sequenceDecision, type SequenceCursor } from '../state/sequence';

interface PendingRpc {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: number;
}

export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export class KodexClient {
  readonly apiBase = import.meta.env.DEV
    ? (import.meta.env.VITE_KODEX_API_URL || 'http://127.0.0.1:47831')
    : window.location.origin;
  #bootstrap: BootstrapResponse | null = null;
  #socket: WebSocket | null = null;
  #pending = new Map<string, PendingRpc>();
  #listeners = new Set<(message: ServerSocketMessage) => void>();
  #connectionListeners = new Set<(state: ConnectionState) => void>();
  #cursor: SequenceCursor = { epoch: null, lastSequence: 0 };
  #reconnectAttempt = 0;
  #reconnectTimer: number | null = null;
  #closed = false;
  #generation = 0;

  async start(): Promise<BootstrapResponse> {
    const generation = ++this.#generation;
    this.#closed = false;
    this.#clearReconnectTimer();
    const bootstrap = await this.#loadBootstrap(generation);
    this.#connect('connecting', generation);
    return bootstrap;
  }

  async #loadBootstrap(generation: number): Promise<BootstrapResponse> {
    const response = await fetch(`${this.apiBase}/api/bootstrap`, {
      credentials: 'include',
      cache: 'no-store',
      headers: { 'X-Kodex-Bootstrap': '1' },
    });
    if (!response.ok) throw new Error(await this.#errorMessage(response));
    if (generation !== this.#generation) throw new Error('Kodex client start was superseded.');
    const bootstrap = await response.json() as BootstrapResponse;
    this.#bootstrap = bootstrap;
    return bootstrap;
  }

  subscribe(listener: (message: ServerSocketMessage) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  onConnection(listener: (state: ConnectionState) => void): () => void {
    this.#connectionListeners.add(listener);
    return () => this.#connectionListeners.delete(listener);
  }

  async rpc<M extends ClientMethod>(method: M, params: ParamsFor<M>): Promise<ResponseFor<M>> {
    if (!this.#socket || this.#socket.readyState !== WebSocket.OPEN) throw new Error('Kodex Local Server is reconnecting.');
    const requestId = crypto.randomUUID();
    const request = { method, id: 0, params } as ClientRequest;
    const message: ClientSocketMessage = { type: 'rpc', requestId, request };
    return new Promise<ResponseFor<M>>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.#pending.delete(requestId);
        reject(new Error(`${method} timed out.`));
      }, 120_000);
      this.#pending.set(requestId, { resolve: (value) => resolve(value as ResponseFor<M>), reject, timer });
      this.#socket!.send(JSON.stringify(message));
    });
  }

  sendServerResponse(requestId: string | number, result: unknown): void {
    this.#send({ type: 'server-response', requestId, result });
  }

  sendServerError(requestId: string | number, code: number, message: string): void {
    this.#send({ type: 'server-error', requestId, code, message });
  }

  async http<T>(pathname: string, init: RequestInit = {}): Promise<T> {
    if (!this.#bootstrap) throw new Error('Kodex bootstrap has not completed.');
    const headers = new Headers(init.headers);
    if (init.body) headers.set('Content-Type', 'application/json');
    if (init.method && init.method !== 'GET') headers.set('X-Kodex-CSRF', this.#bootstrap.csrfToken);
    headers.set('X-Kodex-Session', this.#bootstrap.sessionToken);
    const response = await fetch(`${this.apiBase}${pathname}`, { ...init, headers, credentials: 'include', cache: 'no-store' });
    if (!response.ok) throw new Error(await this.#errorMessage(response));
    return response.json() as Promise<T>;
  }

  close(): void {
    this.#closed = true;
    this.#generation += 1;
    this.#clearReconnectTimer();
    this.#socket?.close(1000, 'UI closed');
    this.#socket = null;
    this.#rejectPending('Kodex connection closed.');
    this.#bootstrap = null;
    this.#cursor = { epoch: null, lastSequence: 0 };
    this.#reconnectAttempt = 0;
    this.#listeners.clear();
    this.#connectionListeners.clear();
  }

  #connect(state: ConnectionState, generation: number): void {
    if (this.#closed || generation !== this.#generation || !this.#bootstrap) return;
    this.#clearReconnectTimer();
    this.#emitConnection(state);
    const socketUrl = this.apiBase.replace(/^http/u, 'ws') + '/ws';
    const socket = new WebSocket(socketUrl, ['kodex', this.#bootstrap.sessionToken]);
    this.#socket = socket;
    socket.addEventListener('open', () => {
      if (generation !== this.#generation) { socket.close(); return; }
      this.#reconnectAttempt = 0;
      this.#emitConnection('connected');
    });
    socket.addEventListener('message', (event) => this.#handleMessage(String(event.data)));
    socket.addEventListener('close', () => {
      if (this.#closed || generation !== this.#generation || this.#socket !== socket) return;
      this.#socket = null;
      this.#rejectPending('Kodex connection was interrupted. Retry the operation.');
      this.#scheduleReconnect(generation);
    });
    socket.addEventListener('error', () => socket.close());
  }

  #scheduleReconnect(generation: number): void {
    if (this.#closed || generation !== this.#generation || this.#reconnectTimer !== null) return;
    this.#emitConnection('reconnecting');
    const delay = Math.min(10_000, 400 * 2 ** this.#reconnectAttempt++) + Math.floor(Math.random() * 250);
    this.#reconnectTimer = window.setTimeout(() => {
      this.#reconnectTimer = null;
      void this.#refreshSessionAndReconnect(generation);
    }, delay);
  }

  async #refreshSessionAndReconnect(generation: number): Promise<void> {
    try {
      await this.#loadBootstrap(generation);
      this.#connect('reconnecting', generation);
    } catch {
      this.#scheduleReconnect(generation);
    }
  }

  #clearReconnectTimer(): void {
    if (this.#reconnectTimer === null) return;
    window.clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
  }

  #rejectPending(message: string): void {
    for (const pending of this.#pending.values()) {
      window.clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }
    this.#pending.clear();
  }

  #handleMessage(raw: string): void {
    const parsed = JSON.parse(raw) as unknown;
    if (!isObject(parsed) || typeof parsed.type !== 'string') return;
    const message = parsed as ServerSocketMessage;
    if (message.type === 'hello') {
      const decision = helloDecision(this.#cursor, message);
      this.#cursor = decision.cursor;
      if (decision.serverRestarted) {
        const resync: ServerSocketMessage = {
          type: 'resync-required', reason: 'server-restart', epoch: message.epoch,
          oldestAvailable: message.oldestSequence, newestAvailable: message.latestSequence,
        };
        for (const listener of this.#listeners) listener(resync);
      }
      this.#send({ type: 'replay', epoch: message.epoch, afterSequence: decision.replayAfter });
      for (const listener of this.#listeners) listener(message);
      return;
    }
    if (message.type === 'resync-required') {
      this.#cursor = { epoch: message.epoch, lastSequence: message.newestAvailable };
      for (const listener of this.#listeners) listener(message);
      return;
    }
    const decision = sequenceDecision(this.#cursor, message);
    if (!decision.accept) return;
    this.#cursor = decision.cursor;
    if (message.type === 'rpc-result' || message.type === 'rpc-error') {
      const pending = this.#pending.get(message.requestId);
      if (!pending) return;
      window.clearTimeout(pending.timer);
      this.#pending.delete(message.requestId);
      if (message.type === 'rpc-error') pending.reject(new Error(message.message));
      else pending.resolve(message.result);
      return;
    }
    for (const listener of this.#listeners) listener(message);
  }

  #send(message: ClientSocketMessage): void {
    if (!this.#socket || this.#socket.readyState !== WebSocket.OPEN) throw new Error('Kodex Local Server is not connected.');
    this.#socket.send(JSON.stringify(message));
  }

  #emitConnection(state: ConnectionState): void {
    for (const listener of this.#connectionListeners) listener(state);
  }

  async #errorMessage(response: Response): Promise<string> {
    try {
      const body = await response.json() as { error?: string };
      return body.error ?? `HTTP ${response.status}`;
    } catch {
      return `HTTP ${response.status}`;
    }
  }
}
