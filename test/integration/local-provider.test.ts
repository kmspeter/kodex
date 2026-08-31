import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { ServerNotification } from '@kodex/codex-protocol';
import { afterEach, expect, it } from 'vitest';
import { AppServerClient } from '../../apps/local-server/src/process/app-server-client';

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');
const binary = path.join(repositoryRoot, 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex');
const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function event(value: unknown): string {
  const type = (value as { type: string }).type;
  return `event: ${type}\ndata: ${JSON.stringify(value)}\n\n`;
}

function completed(id: string): unknown {
  return { type: 'response.completed', response: { id, usage: { input_tokens: 1, input_tokens_details: null, output_tokens: 1, output_tokens_details: null, total_tokens: 2 } } };
}

it.skipIf(!existsSync(binary))('uses a keyless loopback Responses provider for streaming and a tool-call round trip', async () => {
  const requests: Array<{ url: string; headers: http.IncomingHttpHeaders; body: Record<string, unknown> }> = [];
  let sawToolOutput = false;
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
    requests.push({ url: request.url ?? '', headers: request.headers, body });
    const input = Array.isArray(body.input) ? body.input as Array<Record<string, unknown>> : [];
    sawToolOutput ||= input.some((item) => item.type === 'function_call_output' && item.call_id === 'call-local-1');
    response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
    if (!sawToolOutput) {
      const args = JSON.stringify({ cmd: process.platform === 'win32' ? 'cmd /d /c echo kodex-loopback-tool' : 'printf kodex-loopback-tool' });
      response.end([
        event({ type: 'response.created', response: { id: 'resp-local-tool' } }),
        event({ type: 'response.output_item.done', item: { type: 'function_call', call_id: 'call-local-1', name: 'exec_command', arguments: args } }),
        event(completed('resp-local-tool')),
      ].join(''));
      return;
    }
    response.end([
      event({ type: 'response.created', response: { id: 'resp-local-message' } }),
      event({ type: 'response.output_item.added', item: { type: 'message', role: 'assistant', id: 'message-local-1', content: [{ type: 'output_text', text: '' }] } }),
      event({ type: 'response.output_text.delta', delta: 'local stream ok' }),
      event({ type: 'response.output_item.done', item: { type: 'message', role: 'assistant', id: 'message-local-1', content: [{ type: 'output_text', text: 'local stream ok' }] } }),
      event(completed('resp-local-message')),
    ].join(''));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Loopback server did not bind.');
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodex-local-provider-'));
  roots.push(root);
  const notifications: ServerNotification[] = [];
  const client = new AppServerClient({
    repositoryRoot, codexHome: path.join(root, 'codex-home'), apiKey: undefined,
    provider: { mode: 'local', baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'kodex-loopback-model' },
    extraArgs: ['-c', 'web_search="disabled"', '-c', 'analytics.enabled=false'],
    log: async () => undefined,
  });
  client.on('notification', (notification: ServerNotification) => notifications.push(notification));
  try {
    await client.start();
    expect(client.status()).toMatchObject({ state: 'ready', apiKeyConfigured: false, providerMode: 'local', providerModel: 'kodex-loopback-model' });
    const thread = await client.request('thread/start', {
      model: 'kodex-loopback-model', modelProvider: 'kodex_local', cwd: root,
      approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: 'read-only',
      config: { web_search: 'disabled' }, ephemeral: true,
    });
    const turn = await client.request('turn/start', {
      threadId: thread.thread.id,
      input: [{ type: 'text', text: 'Run the provided local echo tool, then answer.', text_elements: [] }],
      cwd: root, approvalPolicy: 'never', approvalsReviewer: 'user', sandboxPolicy: { type: 'readOnly', networkAccess: false },
      model: 'kodex-loopback-model',
    });
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && !notifications.some((notification) => notification.method === 'turn/completed' && notification.params.turn.id === turn.turn.id)) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(requests.length).toBeGreaterThanOrEqual(2);
    expect(requests.every((entry) => entry.url === '/v1/responses')).toBe(true);
    expect(requests.every((entry) => !entry.headers.authorization)).toBe(true);
    expect(sawToolOutput).toBe(true);
    expect(notifications.some((notification) => notification.method === 'item/agentMessage/delta' && notification.params.delta.includes('local stream ok'))).toBe(true);
    expect(notifications.some((notification) => notification.method === 'turn/completed' && notification.params.turn.status === 'completed')).toBe(true);
  } finally {
    await client.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 30_000);
