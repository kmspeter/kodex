import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { LocalHttpServer } from '../../apps/local-server/src/api/http-server';
import { KodexRuntime } from '../../apps/local-server/src/runtime';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe('localhost HTTP security and missing-key startup', () => {
  it('binds loopback, masks auth state, validates Origin/session/CSRF, and applies request limits', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodex-http-'));
    roots.push(root);
    const runtime = new KodexRuntime(root, undefined);
    const origin = 'http://127.0.0.1:5173';
    const server = new LocalHttpServer(runtime, { host: '127.0.0.1', port: 0, allowedOrigins: new Set([origin]) });
    const port = await server.listen();
    try {
      const bootstrapResponse = await fetch(`http://127.0.0.1:${port}/api/bootstrap`, { headers: { origin } });
      expect(bootstrapResponse.status).toBe(200);
      const cookie = bootstrapResponse.headers.get('set-cookie')!.split(';')[0]!;
      const bootstrap = await bootstrapResponse.json() as { csrfToken: string; sessionToken: string; engine: { state: string }; apiKey?: string };
      expect(bootstrap.engine.state).toBe('missing-key');
      expect(JSON.stringify(bootstrap)).not.toContain('OPENAI_API_KEY=');
      expect(bootstrap.apiKey).toBeUndefined();

      const denied = await fetch(`http://127.0.0.1:${port}/api/settings`, { method: 'PUT', headers: { origin, cookie, 'content-type': 'application/json' }, body: '{}' });
      expect(denied.status).toBe(400);
      const accepted = await fetch(`http://127.0.0.1:${port}/api/settings`, { method: 'PUT', headers: { origin, 'x-kodex-session': bootstrap.sessionToken, 'x-kodex-csrf': bootstrap.csrfToken, 'content-type': 'application/json' }, body: JSON.stringify({ network: { webSearch: false } }) });
      expect(accepted.status).toBe(200);
      expect((await accepted.json() as { network: { webSearch: boolean } }).network.webSearch).toBe(false);

      const invalid = await fetch(`http://127.0.0.1:${port}/api/settings`, { method: 'PUT', headers: { origin, 'x-kodex-session': bootstrap.sessionToken, 'x-kodex-csrf': bootstrap.csrfToken, 'content-type': 'application/json' }, body: JSON.stringify({ notifications: false }) });
      expect(invalid.status).toBe(400);

      const external = await fetch(`http://127.0.0.1:${port}/api/bootstrap`, { headers: { origin: 'https://example.invalid', 'x-kodex-bootstrap': '1' } });
      expect(external.status).toBe(400);
    } finally {
      await runtime.stop();
      await server.close();
    }
  });

  it('serves the built SPA and API from one production localhost origin', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodex-static-'));
    roots.push(root);
    const uiRoot = path.join(root, 'ui');
    await mkdir(uiRoot, { recursive: true });
    await writeFile(path.join(uiRoot, 'index.html'), '<!doctype html><title>Kodex local</title><div id="root"></div>', 'utf8');
    const runtime = new KodexRuntime(root, undefined);
    const server = new LocalHttpServer(runtime, { host: '127.0.0.1', port: 0, allowedOrigins: new Set(), uiRoot });
    const port = await server.listen();
    const origin = `http://127.0.0.1:${port}`;
    server.options.allowedOrigins.add(origin);
    try {
      const page = await fetch(`${origin}/some/spa/route`);
      expect(page.status).toBe(200);
      expect(page.headers.get('referrer-policy')).toBe('same-origin');
      expect(await page.text()).toContain('Kodex local');
      const bootstrap = await fetch(`${origin}/api/bootstrap`, { headers: { 'x-kodex-bootstrap': '1' } });
      expect(bootstrap.status).toBe(200);
    } finally {
      await server.close();
      await runtime.stop();
    }
  });

  it('reports replay gaps and sequence epoch changes over WebSocket', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodex-replay-'));
    roots.push(root);
    const runtime = new KodexRuntime(root, undefined, { startAppServer: false });
    const origin = 'http://127.0.0.1:5173';
    const server = new LocalHttpServer(runtime, { host: '127.0.0.1', port: 0, allowedOrigins: new Set([origin]) });
    const port = await server.listen();
    try {
      for (let index = 0; index < 1_001; index += 1) runtime.emit({ type: 'engine', engine: runtime.appServer.status() });
      const bootstrapResponse = await fetch(`http://127.0.0.1:${port}/api/bootstrap`, { headers: { origin } });
      const cookie = bootstrapResponse.headers.get('set-cookie')!.split(';')[0]!;
      const bootstrap = await bootstrapResponse.json() as { sessionToken: string };
      const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, ['kodex', bootstrap.sessionToken], { origin, headers: { Cookie: cookie } });
      const messages: Array<Record<string, unknown>> = [];
      socket.on('message', (raw) => messages.push(JSON.parse(raw.toString()) as Record<string, unknown>));
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline && !messages.some((message) => message.type === 'hello')) await new Promise((resolve) => setTimeout(resolve, 10));
      const hello = messages.find((message) => message.type === 'hello')!;
      socket.send(JSON.stringify({ type: 'replay', epoch: hello.epoch, afterSequence: 0 }));
      while (Date.now() < deadline && !messages.some((message) => message.type === 'resync-required' && message.reason === 'replay-gap')) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(messages.some((message) => message.type === 'resync-required' && message.reason === 'replay-gap')).toBe(true);
      socket.send(JSON.stringify({ type: 'replay', epoch: 'stale-epoch', afterSequence: 0 }));
      while (Date.now() < deadline && !messages.some((message) => message.type === 'resync-required' && message.reason === 'server-restart')) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(messages.some((message) => message.type === 'resync-required' && message.reason === 'server-restart')).toBe(true);
      socket.close();
    } finally {
      await server.close();
      await runtime.stop();
    }
  });
});
