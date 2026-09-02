import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ServerNotification } from '@kodex/codex-protocol';
import { afterEach, expect, it } from 'vitest';
import { AppServerClient } from '../../apps/local-server/src/process/app-server-client';
import { startResponsesLoopbackFixture } from '../fixtures/responses-loopback';

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');
const binary = path.join(repositoryRoot, 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex');
const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, {
  recursive: true,
  force: true,
  maxRetries: 10,
  retryDelay: 100,
}))));

it.skipIf(!existsSync(binary))('uses a keyless loopback Responses provider for streaming and a tool-call round trip', async () => {
  const fixture = await startResponsesLoopbackFixture();
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodex-local-provider-'));
  roots.push(root);
  const notifications: ServerNotification[] = [];
  const client = new AppServerClient({
    repositoryRoot, codexHome: path.join(root, 'codex-home'), apiKey: undefined,
    provider: { mode: 'local', baseUrl: fixture.baseUrl, model: 'kodex-loopback-model' },
    extraArgs: ['-c', 'web_search="disabled"', '-c', 'analytics.enabled=false'],
    log: async () => undefined,
  });
  client.on('notification', (notification: ServerNotification) => notifications.push(notification));
  try {
    await client.start();
    expect(client.status()).toMatchObject({ state: 'ready', apiKeyConfigured: false, providerMode: 'local', providerModel: 'kodex-loopback-model' });
    const thread = await client.request('thread/start', {
      model: 'kodex-loopback-model', modelProvider: 'kodex_local', cwd: root,
      approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: 'danger-full-access',
      config: { web_search: 'disabled' }, ephemeral: true,
    });
    const turn = await client.request('turn/start', {
      threadId: thread.thread.id,
      input: [{ type: 'text', text: 'Run the provided local echo tool, then answer.', text_elements: [] }],
      cwd: root, approvalPolicy: 'never', approvalsReviewer: 'user', sandboxPolicy: { type: 'dangerFullAccess' },
      model: 'kodex-loopback-model',
    });
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && !notifications.some((notification) => notification.method === 'turn/completed' && notification.params.turn.id === turn.turn.id)) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(fixture.requests.length).toBeGreaterThanOrEqual(2);
    expect(fixture.requests.every((entry) => entry.url === '/v1/responses')).toBe(true);
    expect(fixture.requests.every((entry) => !entry.headers.authorization)).toBe(true);
    expect(fixture.sawToolOutput()).toBe(true);
    expect(fixture.toolOutputContainsExpectedText()).toBe(true);
    expect(fixture.toolOutputSucceeded()).toBe(true);
    const itemTypes = notifications
      .filter((notification) => notification.method === 'item/started' || notification.method === 'item/completed')
      .map((notification) => notification.params.item.type);
    const notificationMethods = notifications.map((notification) => notification.method);
    expect({ itemTypes, notificationMethods }).toMatchObject({ itemTypes: expect.arrayContaining(['commandExecution']) });
    expect(notifications.some((notification) => notification.method === 'item/agentMessage/delta' && notification.params.delta.includes('local stream ok'))).toBe(true);
    expect(notifications.some((notification) => notification.method === 'turn/completed' && notification.params.turn.status === 'completed')).toBe(true);
  } finally {
    await client.stop();
    await fixture.close();
  }
}, 30_000);
