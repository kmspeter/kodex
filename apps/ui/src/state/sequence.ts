import type { ServerSocketMessage } from '@kodex/kodex-api';

export function sequenceDecision(lastSequence: number, message: ServerSocketMessage): { accept: boolean; lastSequence: number } {
  if (!('sequence' in message) || typeof message.sequence !== 'number') return { accept: true, lastSequence };
  if (message.type !== 'hello' && message.sequence <= lastSequence) return { accept: false, lastSequence };
  return { accept: true, lastSequence: Math.max(lastSequence, message.sequence) };
}
