import type { ServerNotification, Thread } from '@kodex/codex-protocol';
import { describe, expect, it } from 'vitest';
import { eventReducer, initialEventState } from '../../apps/ui/src/state/events';
import { sequenceDecision } from '../../apps/ui/src/state/sequence';

function thread(): Thread {
  return {
    id: 'thread-1', sessionId: 'session-1', forkedFromId: null, parentThreadId: null,
    preview: 'test', ephemeral: false, section: null, sectionEnteredAt: null, projectId: null,
    modelProvider: 'openai', createdAt: 1, updatedAt: 1, recencyAt: 1,
    historyMode: 'paginated',
    status: { type: 'idle' }, path: null, cwd: 'D:/project', cliVersion: 'test', source: { custom: 'kodex' },
    threadSource: null, agentNickname: null, agentRole: null, gitInfo: null, name: null,
    turns: [{ id: 'turn-1', items: [{ type: 'agentMessage', id: 'item-1', text: '', phase: null, memoryCitation: null, delivery: null }], itemsView: 'full', status: 'inProgress', error: null, startedAt: 1, completedAt: null, durationMs: null }],
  };
}

describe('typed notification reducer', () => {
  it('drops a replayed streaming delta with the same transport sequence', () => {
    const notification = { method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', delta: 'hello' } } satisfies ServerNotification;
    const envelope = { type: 'notification', sequence: 42, notification } as const;
    const first = sequenceDecision(41, envelope);
    const replay = sequenceDecision(first.lastSequence, envelope);
    expect(first.accept).toBe(true);
    expect(replay).toEqual({ accept: false, lastSequence: 42 });
  });

  it('deduplicates transport sequence externally and appends each streaming delta once', () => {
    let state = eventReducer(initialEventState, { type: 'thread-selected', thread: thread() });
    const delta = { method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', delta: 'hello' } } satisfies ServerNotification;
    state = eventReducer(state, { type: 'notification', notification: delta });
    expect(state.liveText['item-1']).toBe('hello');
  });

  it('replaces a completed command item and clears an active turn', () => {
    let state = eventReducer(initialEventState, { type: 'thread-selected', thread: thread() });
    state = { ...state, activeTurnId: 'turn-1' };
    const completed = { method: 'turn/completed', params: { threadId: 'thread-1', turn: { ...thread().turns[0]!, status: 'completed', completedAt: 2, durationMs: 1000 } } } satisfies ServerNotification;
    state = eventReducer(state, { type: 'notification', notification: completed });
    expect(state.activeTurnId).toBeNull();
    expect(state.activeThread?.turns[0]?.status).toBe('completed');
  });
});
