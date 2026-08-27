import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { AppServerClient } from '../../apps/local-server/src/process/app-server-client';

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');
const binary = path.join(repositoryRoot, 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex');
const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

it.skipIf(!existsSync(binary))('handshakes with the locally built official Codex App Server', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodex-real-'));
  roots.push(root);
  const client = new AppServerClient({ repositoryRoot, codexHome: path.join(root, 'codex-home'), apiKey: 'sk-local-handshake-only', log: async () => undefined });
  try {
    await client.start();
    expect(client.status().state).toBe('ready');
    const result = await client.request('thread/list', { limit: 1, archived: false });
    expect(Array.isArray(result.data)).toBe(true);
  } finally {
    await client.stop();
  }
});
