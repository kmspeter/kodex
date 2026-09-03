import type { ServerNotification, Thread } from '@kodex/codex-protocol';
import { describe, expect, it } from 'vitest';
import { eventReducer, initialEventState } from '../../apps/ui/src/state/events';
import { helloDecision, sequenceDecision } from '../../apps/ui/src/state/sequence';

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
    const envelope = { type: 'notification', epoch: 'epoch-1', sequence: 42, notification } as const;
    const first = sequenceDecision({ epoch: 'epoch-1', lastSequence: 41 }, envelope);
    const replay = sequenceDecision(first.cursor, envelope);
    expect(first.accept).toBe(true);
    expect(replay).toEqual({ accept: false, cursor: { epoch: 'epoch-1', lastSequence: 42 } });
  });

  it('does not advance the replay cursor from hello and resets it only for a new epoch', () => {
    const hello = { type: 'hello', epoch: 'epoch-1', latestSequence: 99, oldestSequence: 80, engine: null as never } as Parameters<typeof helloDecision>[1];
    expect(helloDecision({ epoch: 'epoch-1', lastSequence: 41 }, hello)).toMatchObject({ replayAfter: 41, serverRestarted: false });
    const restarted = helloDecision({ epoch: 'epoch-1', lastSequence: 41 }, { ...hello, epoch: 'epoch-2' });
    expect(restarted).toMatchObject({ cursor: { epoch: 'epoch-2', lastSequence: 0 }, replayAfter: 0, serverRestarted: true });
  });

  it('accepts a missed delta once and safely resets transient state on a replay gap', () => {
    const notification = { method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', delta: 'during disconnect' } } satisfies ServerNotification;
    expect(sequenceDecision({ epoch: 'epoch-1', lastSequence: 5 }, { type: 'notification', epoch: 'epoch-1', sequence: 6, notification }).accept).toBe(true);
    let state = eventReducer(initialEventState, { type: 'thread-selected', thread: thread() });
    state = eventReducer(state, { type: 'notification', notification });
    state = eventReducer({ ...state, activeTurnId: 'turn-1' }, { type: 'resync-started' });
    expect(state.liveText).toEqual({});
    expect(state.activeTurnId).toBeNull();
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

  it('retains streamed command items when turn completion contains only final message items', () => {
    let state = eventReducer(initialEventState, { type: 'thread-selected', thread: thread() });
    state = eventReducer(state, {
      type: 'notification',
      notification: {
        method: 'item/completed',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          completedAtMs: 2,
          item: {
            type: 'commandExecution', id: 'command-1', pluginId: null, scriptPath: null,
            command: 'echo marker', cwd: 'D:/project', processId: null, source: 'agent',
            status: 'completed', commandActions: [], aggregatedOutput: 'marker', exitCode: 0,
            durationMs: 10,
          },
        },
      },
    });
    const completedTurn = {
      ...thread().turns[0]!,
      status: 'completed' as const,
      completedAt: 2,
      durationMs: 1,
      items: [{
        type: 'agentMessage' as const,
        id: 'item-1',
        text: 'done',
        phase: null,
        memoryCitation: null,
        delivery: null,
      }],
    };
    state = eventReducer(state, {
      type: 'notification',
      notification: {
        method: 'turn/completed',
        params: { threadId: 'thread-1', turn: completedTurn },
      },
    });

    expect(state.activeThread?.turns[0]?.items.map((item) => item.type))
      .toEqual(['agentMessage', 'commandExecution']);
    expect(state.activeThread?.turns[0]?.items[0]).toMatchObject({ text: 'done' });
  });
});
