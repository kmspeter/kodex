import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ClientRequest, ServerRequest } from '@kodex/codex-protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KodexRuntime } from '../../apps/local-server/src/runtime';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function approval(id: string): ServerRequest {
  return {
    method: 'item/commandExecution/requestApproval', id,
    params: {
      threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', startedAtMs: Date.now(),
      environmentId: null, kind: 'command', reason: 'test', command: 'npm test', cwd: 'D:/project', commandActions: [],
      proposedExecpolicyAmendment: null, proposedNetworkPolicyAmendments: null,
    },
  };
}

describe('runtime ownership and automation coordination', () => {
  it('resumes only threads that are not live in the current App Server process', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodex-new-thread-turn-'));
    roots.push(root);
    const runtime = new KodexRuntime(root, undefined, { startAppServer: false });
    await runtime.initialize();
    const methods: string[] = [];
    vi.spyOn(runtime.appServer, 'request').mockImplementation(async (method) => {
      methods.push(method);
      if (method === 'thread/start') return { thread: { id: 'thread-new' } } as never;
      if (method === 'thread/resume') {
        return { thread: { id: 'thread-existing' } } as never;
      }
      if (method === 'turn/start') return { turn: { id: 'turn-new' } } as never;
      throw new Error(`Unexpected method ${method}`);
    });
    await expect(runtime.handleRpc({ method: 'thread/start', id: 1, params: {} }))
      .resolves.toMatchObject({ thread: { id: 'thread-new' } });
    await expect(runtime.handleRpc({
      method: 'turn/start',
      id: 2,
      params: {
        threadId: 'thread-new',
        input: [{ type: 'text', text: 'hello', text_elements: [] }],
      },
    })).resolves.toMatchObject({ turn: { id: 'turn-new' } });
    expect(methods).toEqual(['thread/start', 'turn/start']);

    await runtime.handleRpc({
      method: 'turn/start',
      id: 3,
      params: {
        threadId: 'thread-existing',
        input: [{ type: 'text', text: 'resume me', text_elements: [] }],
      },
    });
    expect(methods).toEqual(['thread/start', 'turn/start', 'thread/resume', 'turn/start']);

    runtime.appServer.emit('status', { ...runtime.appServer.status(), state: 'stopped' });
    await runtime.handleRpc({
      method: 'turn/start',
      id: 4,
      params: {
        threadId: 'thread-new',
        input: [{ type: 'text', text: 'resume after restart', text_elements: [] }],
      },
    });
    expect(methods).toEqual([
      'thread/start', 'turn/start',
      'thread/resume', 'turn/start',
      'thread/resume', 'turn/start',
    ]);
    await runtime.stop();
  });

  it('assigns an approval to the most recently active UI and forwards exactly one response', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodex-owner-'));
    roots.push(root);
    const runtime = new KodexRuntime(root, undefined, { startAppServer: false });
    await runtime.initialize();
    runtime.registerUi('ui-one');
    runtime.registerUi('ui-two');
    const forwarded = vi.spyOn(runtime.appServer, 'respond').mockImplementation(() => undefined);
    runtime.appServer.emit('server-request', approval('approval-1'));
    expect(runtime.isRequestOwner('ui-one', 'approval-1')).toBe(false);
    expect(runtime.isRequestOwner('ui-two', 'approval-1')).toBe(true);
    await expect(runtime.respondToServerRequest('ui-one', 'approval-1', { decision: 'accept' })).resolves.toBe(false);
    await expect(runtime.respondToServerRequest('ui-two', 'approval-1', { decision: 'accept' })).resolves.toBe(true);
    await expect(runtime.respondToServerRequest('ui-two', 'approval-1', { decision: 'accept' })).resolves.toBe(false);
    expect(forwarded).toHaveBeenCalledTimes(1);
    await runtime.stop();
  });

  it('clears a pending request when its owning UI disconnects', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodex-owner-disconnect-'));
    roots.push(root);
    const runtime = new KodexRuntime(root, undefined, { startAppServer: false });
    await runtime.initialize();
    runtime.registerUi('ui-one');
    const rejected = vi.spyOn(runtime.appServer, 'respondError').mockImplementation(() => undefined);
    runtime.appServer.emit('server-request', approval('approval-disconnect'));
    runtime.unregisterUi('ui-one');
    expect(runtime.isRequestOwner('ui-one', 'approval-disconnect')).toBe(false);
    expect(rejected).toHaveBeenCalledTimes(1);
    await runtime.stop();
  });

  it('keeps automation project context isolated and prevents a second run after more than 30 seconds', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodex-automation-'));
    const secondRoot = await mkdtemp(path.join(os.tmpdir(), 'kodex-automation-project-'));
    roots.push(root, secondRoot);
    const runtime = new KodexRuntime(root, undefined, { startAppServer: false });
    await runtime.initialize();
    const firstProject = await runtime.projects.active();
    const secondProject = await runtime.projects.add(secondRoot, 'Second');
    await runtime.projects.select(firstProject.id);
    const first = await runtime.createAutomation({ name: 'First', prompt: 'one', intervalMinutes: 1, projectId: firstProject.id }) as { id: string };
    const second = await runtime.createAutomation({ name: 'Second', prompt: 'two', intervalMinutes: 1, projectId: secondProject.id }) as { id: string };
    const contexts: string[] = [];
    const ragFlags: Array<boolean | undefined> = [];
    let counter = 0;
    vi.spyOn(runtime, 'handleRpc').mockImplementation(async (request: ClientRequest, context = {}) => {
      contexts.push(context.projectId ?? 'active');
      ragFlags.push(context.rag);
      if (request.method === 'thread/start') return { thread: { id: `thread-${++counter}` } };
      if (request.method === 'turn/start') return { turn: { id: `turn-${counter}` } };
      return {};
    });
    await Promise.all([runtime.runAutomation(first.id), runtime.runAutomation(second.id)]);
    expect(new Set(contexts)).toEqual(new Set([firstProject.id, secondProject.id]));
    expect(new Set(ragFlags)).toEqual(new Set([false]));
    expect((await runtime.projects.active()).id).toBe(firstProject.id);
    const threadStartsBefore = contexts.length;
    await runtime.runDueAutomations(Date.now() + 61_000);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(contexts.length).toBe(threadStartsBefore);
    await expect(runtime.runAutomation(first.id)).resolves.toMatchObject({ threadId: 'thread-1' });
    expect(contexts.length).toBe(threadStartsBefore);
    await runtime.stop();
  });
});
