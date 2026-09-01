import {
  parseProductHistoryThreadDetail,
  parseProductHistoryThreadPage,
} from '@kodex/product-contract';
import { describe, expect, it } from 'vitest';

const thread = {
  threadId: 'thread-1', title: null, status: 'active', projectName: 'Project',
  createdAt: '2026-08-31T00:00:00.000Z', updatedAt: '2026-08-31T01:00:00.000Z',
};

describe('saved history browser DTO parsers', () => {
  it('accepts only the explicit thread page shape', () => {
    expect(parseProductHistoryThreadPage({ nextCursor: null, threads: [thread] }).threads[0]?.threadId).toBe('thread-1');
    expect(() => parseProductHistoryThreadPage({ nextCursor: null, threads: [{ ...thread, projectId: 'db-id' }] })).toThrow();
    expect(() => parseProductHistoryThreadPage({ nextCursor: 'not a cursor!', threads: [] })).toThrow();
  });

  it('accepts bounded previews and rejects raw or oversized detail payloads', () => {
    const detail = {
      thread, nextCursor: null, omitted: { items: false, toolCalls: false, approvals: false },
      turns: [{ turnId: 'turn-1', status: 'completed', startedAt: thread.createdAt, completedAt: thread.updatedAt }],
      items: [{
        itemId: 'item-1', turnId: 'turn-1', itemType: 'agentMessage', role: 'assistant', status: 'completed',
        startedAt: thread.createdAt, completedAt: thread.updatedAt,
        payload: { content: '{"text":"safe"}', truncated: false },
      }],
      toolCalls: [], approvals: [],
    };
    expect(parseProductHistoryThreadDetail(detail).items[0]?.role).toBe('assistant');
    expect(() => parseProductHistoryThreadDetail({
      ...detail,
      items: [{ ...detail.items[0], payload: { text: 'raw JSONB' } }],
    })).toThrow();
    expect(() => parseProductHistoryThreadDetail({
      ...detail,
      items: [{ ...detail.items[0], payload: { content: 'x'.repeat(4_001), truncated: true } }],
    })).toThrow();
  });
});
