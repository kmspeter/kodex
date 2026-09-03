import type { ServerNotification, Thread, ThreadItem, ThreadTokenUsage, Turn, TurnPlanStep } from '@kodex/codex-protocol';
import type { PendingServerRequest } from '@kodex/kodex-api';

export interface ProcessState {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export interface EventState {
  threads: Thread[];
  activeThread: Thread | null;
  activeTurnId: string | null;
  liveText: Record<string, string>;
  pendingRequests: PendingServerRequest[];
  notices: string[];
  turnDiff: string;
  tokenUsage: ThreadTokenUsage | null;
  turnPlan: { explanation: string | null; plan: TurnPlanStep[] } | null;
  processes: Record<string, ProcessState>;
}

export const initialEventState: EventState = {
  threads: [], activeThread: null, activeTurnId: null, liveText: {}, pendingRequests: [], notices: [],
  turnDiff: '', tokenUsage: null, turnPlan: null, processes: {},
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

function mergeTurn(current: Turn | undefined, incoming: Turn): Turn {
  if (!current) return incoming;
  const incomingById = new Map(incoming.items.map((item) => [item.id, item]));
  const currentIds = new Set(current.items.map((item) => item.id));
  return {
    ...current,
    ...incoming,
    items: [
      ...current.items.map((item) => incomingById.get(item.id) ?? item),
      ...incoming.items.filter((item) => !currentIds.has(item.id)),
    ],
  };
}

function upsertTurn(thread: Thread, incoming: Turn): Thread {
  const current = thread.turns.find((turn) => turn.id === incoming.id);
  const merged = mergeTurn(current, incoming);
  return {
    ...thread,
    turns: current
      ? thread.turns.map((turn) => turn.id === incoming.id ? merged : turn)
      : [...thread.turns, merged],
  };
}

function appendLive(state: EventState, itemId: string, delta: string): EventState {
  return { ...state, liveText: { ...state.liveText, [itemId]: `${state.liveText[itemId] ?? ''}${delta}` } };
}

function decodeBase64(value: string): string {
  try {
    const binary = globalThis.atob(value);
    const bytes = Uint8Array.from(binary, (character) => character.codePointAt(0) ?? 0);
    return new TextDecoder().decode(bytes);
  } catch { return '[invalid base64 output]'; }
}

export type EventAction =
  | { type: 'threads-loaded'; threads: Thread[] }
  | { type: 'thread-selected'; thread: Thread | null }
  | { type: 'turn-accepted'; threadId: string; turn: Turn }
  | { type: 'server-request'; request: PendingServerRequest }
  | { type: 'server-request-resolved'; id: string | number }
  | { type: 'resync-started' }
  | { type: 'notification'; notification: ServerNotification };

export function eventReducer(state: EventState, action: EventAction): EventState {
  if (action.type === 'threads-loaded') return { ...state, threads: action.threads };
  if (action.type === 'thread-selected') return { ...state, activeThread: action.thread, activeTurnId: null, liveText: {}, turnDiff: '', tokenUsage: null, turnPlan: null };
  if (action.type === 'resync-started') return { ...state, activeTurnId: null, liveText: {}, pendingRequests: [], processes: {} };
  if (action.type === 'turn-accepted') {
    if (!state.activeThread || state.activeThread.id !== action.threadId) return state;
    return {
      ...state,
      activeThread: upsertTurn(state.activeThread, action.turn),
      activeTurnId: action.turn.id,
    };
  }
  if (action.type === 'server-request') {
    return { ...state, pendingRequests: [...state.pendingRequests.filter((entry) => String(entry.request.id) !== String(action.request.request.id)), action.request] };
  }
  if (action.type === 'server-request-resolved') {
    return { ...state, pendingRequests: state.pendingRequests.filter((entry) => String(entry.request.id) !== String(action.id)) };
  }

  const notification = action.notification;
  switch (notification.method) {
    case 'thread/started': {
      const { thread } = notification.params;
      return { ...state, threads: [thread, ...state.threads.filter((entry) => entry.id !== thread.id)] };
    }
    case 'thread/status/changed': {
      const { threadId, status } = notification.params;
      return {
        ...state,
        threads: state.threads.map((thread) => thread.id === threadId ? { ...thread, status } : thread),
        activeThread: state.activeThread?.id === threadId ? { ...state.activeThread, status } : state.activeThread,
      };
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
      const { threadId } = notification.params;
      return { ...state, threads: state.threads.filter((thread) => thread.id !== threadId), activeThread: state.activeThread?.id === threadId ? null : state.activeThread };
    }
    case 'turn/started': {
      const params = notification.params;
      if (params.threadId !== state.activeThread?.id || !state.activeThread) return state;
      return {
        ...state,
        activeTurnId: params.turn.id,
        activeThread: upsertTurn(state.activeThread, params.turn),
      };
    }
    case 'turn/completed': {
      const params = notification.params;
      if (params.threadId !== state.activeThread?.id || !state.activeThread) return state;
      return {
        ...state,
        activeTurnId: null,
        activeThread: upsertTurn(state.activeThread, params.turn),
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
    case 'item/agentMessage/delta':
    case 'item/plan/delta':
    case 'item/reasoning/summaryTextDelta':
    case 'item/reasoning/textDelta':
    case 'item/commandExecution/outputDelta':
    case 'item/fileChange/outputDelta': {
      const params = notification.params;
      if (params.threadId !== state.activeThread?.id) return state;
      return appendLive(state, params.itemId, params.delta);
    }
    case 'item/reasoning/summaryPartAdded': {
      const params = notification.params;
      if (params.threadId !== state.activeThread?.id) return state;
      return appendLive(state, params.itemId, state.liveText[params.itemId] ? '\n' : '');
    }
    case 'item/commandExecution/terminalInteraction': {
      const params = notification.params;
      if (params.threadId !== state.activeThread?.id) return state;
      return appendLive(state, params.itemId, params.stdin);
    }
    case 'item/fileChange/patchUpdated': {
      const params = notification.params;
      if (!state.activeThread || params.threadId !== state.activeThread.id) return state;
      const turns = state.activeThread.turns.map((turn): Turn => turn.id !== params.turnId ? turn : {
        ...turn,
        items: turn.items.map((item): ThreadItem => item.id === params.itemId && item.type === 'fileChange' ? { ...item, changes: params.changes } : item),
      });
      return { ...state, activeThread: { ...state.activeThread, turns } };
    }
    case 'turn/diff/updated':
      return notification.params.threadId === state.activeThread?.id ? { ...state, turnDiff: notification.params.diff } : state;
    case 'turn/plan/updated':
      return notification.params.threadId === state.activeThread?.id ? { ...state, turnPlan: { explanation: notification.params.explanation, plan: notification.params.plan } } : state;
    case 'thread/tokenUsage/updated':
      return notification.params.threadId === state.activeThread?.id ? { ...state, tokenUsage: notification.params.tokenUsage } : state;
    case 'command/exec/outputDelta': {
      const params = notification.params;
      const current = state.processes[params.processId] ?? { stdout: '', stderr: '', exitCode: null };
      return { ...state, processes: { ...state.processes, [params.processId]: { ...current, [params.stream]: `${current[params.stream]}${decodeBase64(params.deltaBase64)}` } } };
    }
    case 'process/outputDelta': {
      const params = notification.params;
      const current = state.processes[params.processHandle] ?? { stdout: '', stderr: '', exitCode: null };
      return { ...state, processes: { ...state.processes, [params.processHandle]: { ...current, [params.stream]: `${current[params.stream]}${decodeBase64(params.deltaBase64)}` } } };
    }
    case 'process/exited': {
      const params = notification.params;
      const current = state.processes[params.processHandle] ?? { stdout: '', stderr: '', exitCode: null };
      return { ...state, processes: { ...state.processes, [params.processHandle]: { stdout: current.stdout + params.stdout, stderr: current.stderr + params.stderr, exitCode: params.exitCode } } };
    }
    case 'error': return { ...state, notices: [...state.notices.slice(-9), notification.params.error.message] };
    case 'warning': return { ...state, notices: [...state.notices.slice(-9), notification.params.message] };
    default: return state;
  }
}
