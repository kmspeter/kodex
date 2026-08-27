import type { ServerNotification, ServerRequest, Thread, ThreadItem, Turn } from '@kodex/codex-protocol';

export interface EventState {
  threads: Thread[];
  activeThread: Thread | null;
  activeTurnId: string | null;
  liveText: Record<string, string>;
  pendingRequests: ServerRequest[];
  notices: string[];
}

export const initialEventState: EventState = {
  threads: [],
  activeThread: null,
  activeTurnId: null,
  liveText: {},
  pendingRequests: [],
  notices: [],
};

function upsertItem(thread: Thread, turnId: string, item: ThreadItem): Thread {
  const turns = thread.turns.map((turn): Turn => {
    if (turn.id !== turnId) return turn;
    const index = turn.items.findIndex((entry) => entry.id === item.id);
    const items = index < 0 ? [...turn.items, item] : turn.items.map((entry, itemIndex) => itemIndex === index ? item : entry);
    return { ...turn, items };
  });
  return { ...thread, turns };
}

export type EventAction =
  | { type: 'threads-loaded'; threads: Thread[] }
  | { type: 'thread-selected'; thread: Thread | null }
  | { type: 'turn-accepted'; threadId: string; turn: Turn }
  | { type: 'server-request'; request: ServerRequest }
  | { type: 'server-request-resolved'; id: string | number }
  | { type: 'notification'; notification: ServerNotification };

export function eventReducer(state: EventState, action: EventAction): EventState {
  if (action.type === 'threads-loaded') return { ...state, threads: action.threads };
  if (action.type === 'thread-selected') return { ...state, activeThread: action.thread, activeTurnId: null, liveText: {} };
  if (action.type === 'turn-accepted') {
    if (!state.activeThread || state.activeThread.id !== action.threadId) return state;
    const turns = [...state.activeThread.turns.filter((turn) => turn.id !== action.turn.id), action.turn];
    return { ...state, activeThread: { ...state.activeThread, turns }, activeTurnId: action.turn.id };
  }
  if (action.type === 'server-request') {
    return { ...state, pendingRequests: [...state.pendingRequests.filter((entry) => String(entry.id) !== String(action.request.id)), action.request] };
  }
  if (action.type === 'server-request-resolved') {
    return { ...state, pendingRequests: state.pendingRequests.filter((entry) => String(entry.id) !== String(action.id)) };
  }

  const notification = action.notification;
  switch (notification.method) {
    case 'thread/started': {
      const params = notification.params;
      return { ...state, threads: [params.thread, ...state.threads.filter((thread) => thread.id !== params.thread.id)] };
    }
    case 'thread/name/updated': {
      const params = notification.params;
      return {
        ...state,
        threads: state.threads.map((thread) => thread.id === params.threadId ? { ...thread, name: params.threadName ?? null } : thread),
        activeThread: state.activeThread?.id === params.threadId ? { ...state.activeThread, name: params.threadName ?? null } : state.activeThread,
      };
    }
    case 'thread/archived': {
      const params = notification.params;
      return { ...state, threads: state.threads.filter((thread) => thread.id !== params.threadId), activeThread: state.activeThread?.id === params.threadId ? null : state.activeThread };
    }
    case 'turn/started': {
      const params = notification.params;
      if (params.threadId !== state.activeThread?.id || !state.activeThread) return state;
      return {
        ...state,
        activeTurnId: params.turn.id,
        activeThread: { ...state.activeThread, turns: [...state.activeThread.turns.filter((turn) => turn.id !== params.turn.id), params.turn] },
      };
    }
    case 'turn/completed': {
      const params = notification.params;
      if (params.threadId !== state.activeThread?.id || !state.activeThread) return state;
      return {
        ...state,
        activeTurnId: null,
        activeThread: { ...state.activeThread, turns: state.activeThread.turns.map((turn) => turn.id === params.turn.id ? params.turn : turn) },
      };
    }
    case 'item/started':
    case 'item/completed': {
      const params = notification.params;
      if (!state.activeThread || params.threadId !== state.activeThread.id) return state;
      const activeThread = upsertItem(state.activeThread, params.turnId, params.item);
      const liveText = notification.method === 'item/completed' ? Object.fromEntries(Object.entries(state.liveText).filter(([id]) => id !== params.item.id)) : state.liveText;
      return { ...state, activeThread, liveText };
    }
    case 'item/agentMessage/delta': {
      const params = notification.params;
      if (params.threadId !== state.activeThread?.id) return state;
      return { ...state, liveText: { ...state.liveText, [params.itemId]: `${state.liveText[params.itemId] ?? ''}${params.delta}` } };
    }
    case 'error':
      return { ...state, notices: [...state.notices.slice(-9), notification.params.error.message] };
    case 'warning':
      return { ...state, notices: [...state.notices.slice(-9), notification.params.message] };
    default:
      return state;
  }
}
