import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServerNotification, ServerRequest } from '@kodex/codex-protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { AppServerClient } from '../../apps/local-server/src/process/app-server-client';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const fakeServer = path.join(repositoryRoot, 'test', 'fixtures', 'fake-app-server.mjs');
const temporaryRoots: string[] = [];
afterEach(async () => Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function waitFor<T>(subscribe: (resolve: (value: T) => void) => void): Promise<T> {
  return new Promise<T>((resolve) => subscribe(resolve));
}

describe('AppServerClient', () => {
  it('performs initialize/initialized, correlates out-of-order RPC, forwards approvals, handles malformed JSON, and masks the key', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodex-bridge-'));
    temporaryRoots.push(root);
    const logLines: string[] = [];
    const secret = 'sk-test-abcdefghijklmnop';
    const client = new AppServerClient({
      repositoryRoot,
      codexHome: path.join(root, 'codex-home'),
      apiKey: secret,
      binary: { command: process.execPath, source: 'local' },
      spawnArgs: [fakeServer, 'normal'],
      log: async (_filename, line) => { logLines.push(line); },
    });
    const protocolError = waitFor<Error>((resolve) => client.once('protocol-error', resolve));
    const serverRequest = waitFor<ServerRequest>((resolve) => client.once('server-request', resolve));
    const warning = waitFor<ServerNotification>((resolve) => client.once('notification', resolve));
    await client.start();
    expect(client.status().state).toBe('ready');
    await expect(protocolError).resolves.toBeInstanceOf(Error);
    const approval = await serverRequest;
    expect(approval.method).toBe('item/commandExecution/requestApproval');
    expect(JSON.stringify(await warning)).not.toContain(secret);
    client.respond(approval.id, { decision: 'accept' });

    const slow = client.requestRaw<{ token: string }>('test/correlation', { token: 'slow', delay: 40 }, 2_000);
    const fast = client.requestRaw<{ token: string }>('test/correlation', { token: 'fast', delay: 1 }, 2_000);
    await expect(Promise.all([slow, fast])).resolves.toEqual([{ token: 'slow' }, { token: 'fast' }]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(logLines.join('\n')).not.toContain(secret);
    expect(logLines.join('\n')).toContain('[REDACTED]');
    await client.stop();
    expect(client.status().state).toBe('stopped');
  });

  it('restarts after one abnormal child exit and cleans up the replacement child', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodex-restart-'));
    temporaryRoots.push(root);
    const counter = path.join(root, 'starts.txt');
    const client = new AppServerClient({
      repositoryRoot,
      codexHome: path.join(root, 'codex-home'),
      apiKey: 'sk-test-restart-secret',
      binary: { command: process.execPath, source: 'local' },
      spawnArgs: [fakeServer, 'exit-once', counter],
      log: async () => undefined,
    });
    await client.start();
    const deadline = Date.now() + 6_000;
    while (Date.now() < deadline) {
      if (existsSync(counter) && Number(await readFile(counter, 'utf8')) >= 2 && client.status().state === 'ready') break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(Number(await readFile(counter, 'utf8'))).toBeGreaterThanOrEqual(2);
    expect(client.status().state).toBe('ready');
    await client.stop();
    expect(client.status().pid).toBeNull();
  });

  it('stops automatic restart after repeated ready-then-crash cycles', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodex-crash-loop-'));
    temporaryRoots.push(root);
    const counter = path.join(root, 'starts.txt');
    const client = new AppServerClient({
      repositoryRoot,
      codexHome: path.join(root, 'codex-home'),
      apiKey: 'sk-test-crash-loop',
      binary: { command: process.execPath, source: 'local' },
      spawnArgs: [fakeServer, 'always-exit', counter],
      stableRunMs: 10_000,
      maxConsecutiveRestarts: 2,
      restartDelaysMs: [5, 5],
      log: async () => undefined,
    });
    await client.start();
    const deadline = Date.now() + 4_000;
    while (Date.now() < deadline && client.status().consecutiveFailures < 3) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(Number(await readFile(counter, 'utf8'))).toBe(3);
    expect(client.status()).toMatchObject({ state: 'failed', restartCount: 2, consecutiveFailures: 3 });
    expect(client.status().message).toContain('Automatic restart stopped');
    await client.stop();
  });
});
