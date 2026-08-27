import type { ClientRequest, ServerNotification, ServerRequest } from '@kodex/codex-protocol';
import { describe, expect, it } from 'vitest';

const requests = [
  { method: 'thread/start', id: 1, params: { cwd: 'D:/project', sandbox: 'workspace-write', approvalPolicy: 'on-request' } },
  { method: 'thread/list', id: 2, params: { limit: 100, archived: false } },
  { method: 'thread/read', id: 3, params: { threadId: 'thread-1', includeTurns: true } },
  { method: 'turn/start', id: 4, params: { threadId: 'thread-1', input: [{ type: 'text', text: 'hello', text_elements: [] }] } },
  { method: 'turn/interrupt', id: 5, params: { threadId: 'thread-1', turnId: 'turn-1' } },
  { method: 'model/list', id: 6, params: { limit: 100 } },
] satisfies ClientRequest[];

const notification = { method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', delta: 'hi' } } satisfies ServerNotification;
const serverRequest = { method: 'item/fileChange/requestApproval', id: 'approval-1', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', startedAtMs: 1, reason: 'write', grantRoot: null } } satisfies ServerRequest;

describe('generated protocol compile-time fixtures', () => {
  it('keeps every UI request and event coupled to generated unions', () => {
    expect(requests.map((request) => request.method)).toContain('turn/start');
    expect(notification.method).toBe('item/agentMessage/delta');
    expect(serverRequest.method).toBe('item/fileChange/requestApproval');
  });
});
