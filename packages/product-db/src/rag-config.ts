import type { ChunkingConfig } from './chunking.js';

export interface RagConfig {
  automationsEnabled: boolean;
  chunking: ChunkingConfig;
  contextMaxCharacters: number;
  defaultThreshold: number;
  defaultTopK: number;
  enabled: boolean;
  maxDocumentCharacters: number;
  maxQueryCharacters: number;
  maxTopK: number;
}

function booleanValue(value: string | undefined, fallback: boolean, name: string): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  if (value === '1' || value === 'true') return true;
  if (value === '0' || value === 'false') return false;
  throw new Error(`${name} must be true or false.`);
}

function integer(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  const candidate = value?.trim() ? Number(value) : fallback;
  if (!Number.isSafeInteger(candidate) || candidate < minimum || candidate > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return candidate;
}

function threshold(value: string | undefined): number {
  const candidate = value?.trim() ? Number(value) : 0.25;
  if (!Number.isFinite(candidate) || candidate < -1 || candidate > 1) {
    throw new Error('KODEX_RAG_SCORE_THRESHOLD must be between -1 and 1.');
  }
  return candidate;
}

export function ragConfigFromEnv(env: NodeJS.ProcessEnv = process.env): RagConfig {
  const chunkCharacters = integer(env.KODEX_RAG_CHUNK_CHARACTERS, 1_600, 32, 20_000, 'KODEX_RAG_CHUNK_CHARACTERS');
  const overlapCharacters = integer(env.KODEX_RAG_CHUNK_OVERLAP_CHARACTERS, 200, 0, chunkCharacters - 1, 'KODEX_RAG_CHUNK_OVERLAP_CHARACTERS');
  const maxTopK = integer(env.KODEX_RAG_MAX_TOP_K, 20, 1, 100, 'KODEX_RAG_MAX_TOP_K');
  return {
    enabled: booleanValue(env.KODEX_RAG_ENABLED, false, 'KODEX_RAG_ENABLED'),
    automationsEnabled: booleanValue(env.KODEX_RAG_AUTOMATIONS_ENABLED, false, 'KODEX_RAG_AUTOMATIONS_ENABLED'),
    chunking: { chunkCharacters, overlapCharacters },
    contextMaxCharacters: integer(env.KODEX_RAG_CONTEXT_MAX_CHARACTERS, 6_000, 512, 50_000, 'KODEX_RAG_CONTEXT_MAX_CHARACTERS'),
    defaultThreshold: threshold(env.KODEX_RAG_SCORE_THRESHOLD),
    defaultTopK: integer(env.KODEX_RAG_TOP_K, 5, 1, maxTopK, 'KODEX_RAG_TOP_K'),
    maxTopK,
    maxDocumentCharacters: integer(env.KODEX_RAG_DOCUMENT_MAX_CHARACTERS, 60_000, 1, 1_000_000, 'KODEX_RAG_DOCUMENT_MAX_CHARACTERS'),
    maxQueryCharacters: integer(env.KODEX_RAG_QUERY_MAX_CHARACTERS, 4_000, 1, 20_000, 'KODEX_RAG_QUERY_MAX_CHARACTERS'),
  };
}
