import { createHash } from 'node:crypto';

export interface ChunkingConfig {
  chunkCharacters: number;
  overlapCharacters: number;
}

export interface TextChunk {
  content: string;
  index: number;
}

export const CHUNKER_VERSION = 'unicode-codepoints-v1';

export function validateChunkingConfig(config: ChunkingConfig): void {
  if (!Number.isSafeInteger(config.chunkCharacters) || config.chunkCharacters < 32) {
    throw new Error('chunkCharacters must be an integer of at least 32.');
  }
  if (
    !Number.isSafeInteger(config.overlapCharacters)
    || config.overlapCharacters < 0
    || config.overlapCharacters >= config.chunkCharacters
  ) {
    throw new Error('overlapCharacters must be a non-negative integer smaller than chunkCharacters.');
  }
}

/** Splits by Unicode code points so surrogate pairs are never cut between chunks. */
export function chunkText(text: string, config: ChunkingConfig): TextChunk[] {
  validateChunkingConfig(config);
  const codePoints = Array.from(text);
  if (codePoints.length === 0) return [];
  const chunks: TextChunk[] = [];
  const step = config.chunkCharacters - config.overlapCharacters;
  for (let start = 0; start < codePoints.length; start += step) {
    chunks.push({ index: chunks.length, content: codePoints.slice(start, start + config.chunkCharacters).join('') });
    if (start + config.chunkCharacters >= codePoints.length) break;
  }
  return chunks;
}

export function contentChecksum(content: string): Buffer {
  return createHash('sha256').update(content, 'utf8').digest();
}

export function indexConfigurationChecksum(
  config: ChunkingConfig,
  model: string,
  dimensions: number,
): Buffer {
  return createHash('sha256').update(JSON.stringify({
    chunker: CHUNKER_VERSION,
    chunkCharacters: config.chunkCharacters,
    overlapCharacters: config.overlapCharacters,
    model,
    dimensions,
  })).digest();
}
