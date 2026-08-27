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

it.skipIf(!process.env.OPENAI_API_KEY)('runs a user-invoked live model turn and approved shell tool through the local Codex binary', async () => {
  expect(existsSync(binary)).toBe(true);
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodex-live-'));
  roots.push(root);
  const client = new AppServerClient({ repositoryRoot, codexHome: path.join(root, 'codex-home'), apiKey: process.env.OPENAI_API_KEY, log: async () => undefined });
  try {
    await client.start();
    const started = await client.request('thread/start', { cwd: root, sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'user', ephemeral: true });
    const completed = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Live turn timed out.')), 240_000);
      client.on('server-request', (request) => {
        if (request.method === 'item/commandExecution/requestApproval') client.respond(request.id, { decision: 'accept' });
      });
      client.on('notification', (notification) => {
        if (notification.method === 'turn/completed' && notification.params.threadId === started.thread.id) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    await client.request('turn/start', {
      threadId: started.thread.id,
      input: [{ type: 'text', text: 'Use the shell to create kodex-live-tool.txt containing KODEX_LIVE_OK, then reply exactly KODEX_LIVE_OK.', text_elements: [] }],
      sandboxPolicy: { type: 'workspaceWrite', writableRoots: [root], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
    });
    await completed;
    expect(existsSync(path.join(root, 'kodex-live-tool.txt'))).toBe(true);
  } finally {
    await client.stop();
  }
}, 300_000);
