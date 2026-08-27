import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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
      const accepted = await fetch(`http://127.0.0.1:${port}/api/settings`, { method: 'PUT', headers: { origin, 'x-kodex-session': bootstrap.sessionToken, 'x-kodex-csrf': bootstrap.csrfToken, 'content-type': 'application/json' }, body: JSON.stringify({ notifications: false }) });
      expect(accepted.status).toBe(200);
      expect((await accepted.json() as { notifications: boolean }).notifications).toBe(false);

      const external = await fetch(`http://127.0.0.1:${port}/api/bootstrap`, { headers: { origin: 'https://example.invalid' } });
      expect(external.status).toBe(400);
    } finally {
      await runtime.stop();
      await server.close();
    }
  });
});
