import { afterEach, describe, expect, it, vi } from 'vitest';
import { KodexClient, type ConnectionState } from '../../apps/ui/src/client/kodex-client';

type SocketEvent = 'open' | 'message' | 'close' | 'error';
type SocketListener = (event: { data?: unknown }) => void;

class FakeWebSocket {
  static readonly OPEN = 1;
  static readonly instances: FakeWebSocket[] = [];
  readonly listeners = new Map<SocketEvent, SocketListener[]>();
  readonly sent: string[] = [];
  readyState = 0;

  constructor(readonly url: string, readonly protocols: string[]) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: SocketEvent, listener: SocketListener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  send(message: string): void { this.sent.push(message); }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit('open', {});
  }

  serverClose(): void {
    this.readyState = 3;
    this.emit('close', {});
  }

  close(): void { this.serverClose(); }

  emit(type: SocketEvent, event: { data?: unknown }): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

afterEach(() => {
  FakeWebSocket.instances.length = 0;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Kodex browser client reconnection', () => {
  it('rejects interrupted RPC and refreshes bootstrap credentials before reconnecting', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('window', {
      location: { origin: 'http://127.0.0.1:47831' },
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    });
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ sessionToken: 'session-1' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ sessionToken: 'session-2' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new KodexClient();
    const states: ConnectionState[] = [];
    client.onConnection((state) => states.push(state));
    await client.start();
    const first = FakeWebSocket.instances[0]!;
    expect(first.protocols).toEqual(['kodex', 'session-1']);
    first.open();

    const pending = client.rpc('thread/list', { limit: 1, archived: false });
    first.serverClose();
    await expect(pending).rejects.toThrow('connection was interrupted');

    await vi.advanceTimersByTimeAsync(1_000);
    const second = FakeWebSocket.instances[1]!;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(second.protocols).toEqual(['kodex', 'session-2']);
    second.open();
    expect(states.at(-1)).toBe('connected');
    client.close();
    await expect(client.http('/api/settings')).rejects.toThrow('bootstrap has not completed');
  });
});
