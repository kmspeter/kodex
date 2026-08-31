import type { ServerSocketMessage } from '@kodex/kodex-api';

export interface SequenceCursor {
  epoch: string | null;
  lastSequence: number;
}

export function helloDecision(cursor: SequenceCursor, message: Extract<ServerSocketMessage, { type: 'hello' }>): { cursor: SequenceCursor; replayAfter: number; serverRestarted: boolean } {
  const serverRestarted = cursor.epoch !== null && cursor.epoch !== message.epoch;
  const next = serverRestarted ? { epoch: message.epoch, lastSequence: 0 } : { ...cursor, epoch: message.epoch };
  return { cursor: next, replayAfter: next.lastSequence, serverRestarted };
}

export function sequenceDecision(cursor: SequenceCursor, message: ServerSocketMessage): { accept: boolean; cursor: SequenceCursor } {
  if (message.type === 'hello') return { accept: true, cursor };
  if (!('sequence' in message)) return { accept: true, cursor };
  if (message.epoch !== cursor.epoch || message.sequence <= cursor.lastSequence) return { accept: false, cursor };
  return { accept: true, cursor: { epoch: cursor.epoch, lastSequence: message.sequence } };
}
