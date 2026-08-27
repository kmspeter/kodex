import type { ClientRequest } from '@kodex/codex-protocol';
import type {
  BootstrapResponse,
  ClientMethod,
  ClientSocketMessage,
  ParamsFor,
  ResponseFor,
  ServerSocketMessage,
} from '@kodex/kodex-api';
import { sequenceDecision } from '../state/sequence';

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
  readonly apiBase = import.meta.env.VITE_KODEX_API_URL || 'http://127.0.0.1:47831';
  #bootstrap: BootstrapResponse | null = null;
  #socket: WebSocket | null = null;
  #pending = new Map<string, PendingRpc>();
  #listeners = new Set<(message: ServerSocketMessage) => void>();
  #connectionListeners = new Set<(state: ConnectionState) => void>();
  #lastSequence = 0;
  #reconnectAttempt = 0;
  #closed = false;
  #generation = 0;

  async start(): Promise<BootstrapResponse> {
    const generation = ++this.#generation;
    this.#closed = false;
    const response = await fetch(`${this.apiBase}/api/bootstrap`, { credentials: 'include', cache: 'no-store' });
    if (!response.ok) throw new Error(await this.#errorMessage(response));
    if (generation !== this.#generation) throw new Error('Kodex client start was superseded.');
    this.#bootstrap = await response.json() as BootstrapResponse;
    this.#connect('connecting', generation);
    return this.#bootstrap;
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
    this.#socket?.close(1000, 'UI closed');
    this.#socket = null;
    for (const pending of this.#pending.values()) {
      window.clearTimeout(pending.timer);
      pending.reject(new Error('Kodex connection closed.'));
    }
    this.#pending.clear();
  }

  #connect(state: ConnectionState, generation: number): void {
    if (this.#closed || generation !== this.#generation) return;
    this.#emitConnection(state);
    const socketUrl = this.apiBase.replace(/^http/u, 'ws') + '/ws';
    const socket = new WebSocket(socketUrl, ['kodex', this.#bootstrap!.sessionToken]);
    this.#socket = socket;
    socket.addEventListener('open', () => {
      if (generation !== this.#generation) { socket.close(); return; }
      this.#reconnectAttempt = 0;
      this.#emitConnection('connected');
      this.#send({ type: 'replay', afterSequence: this.#lastSequence });
    });
    socket.addEventListener('message', (event) => this.#handleMessage(String(event.data)));
    socket.addEventListener('close', () => {
      if (this.#closed || generation !== this.#generation) return;
      this.#emitConnection('reconnecting');
      const delay = Math.min(10_000, 400 * 2 ** this.#reconnectAttempt++) + Math.floor(Math.random() * 250);
      window.setTimeout(() => this.#connect('reconnecting', generation), delay);
    });
    socket.addEventListener('error', () => socket.close());
  }

  #handleMessage(raw: string): void {
    const parsed = JSON.parse(raw) as unknown;
    if (!isObject(parsed) || typeof parsed.type !== 'string') return;
    const message = parsed as ServerSocketMessage;
    const sequence = sequenceDecision(this.#lastSequence, message);
    if (!sequence.accept) return;
    this.#lastSequence = sequence.lastSequence;
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
