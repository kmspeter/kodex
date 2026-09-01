import { setTimeout as delay } from 'node:timers/promises';
import { KnowledgeOperationError, type EmbeddingProvider, type RagFailureCode } from './knowledge-types.js';

export interface OpenAIEmbeddingConfig {
  apiKey?: string;
  batchSize: number;
  dimensions: number;
  maxRetries: number;
  maxResponseBytes: number;
  model: string;
  timeoutMs: number;
}

export interface OpenAIEmbeddingProviderOptions {
  fetch?: typeof globalThis.fetch;
  sleep?: (milliseconds: number) => Promise<void>;
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
export const DEFAULT_OPENAI_EMBEDDING_MODEL = 'text-embedding-3-small';
export const DEFAULT_OPENAI_EMBEDDING_DIMENSIONS = 1_536;

function positiveInteger(
  value: string | undefined,
  fallback: number,
  name: string,
  maximum: number,
): number {
  const candidate = value?.trim() ? Number(value) : fallback;
  if (!Number.isSafeInteger(candidate) || candidate <= 0 || candidate > maximum) {
    throw new Error(`${name} must be a positive integer no greater than ${maximum}.`);
  }
  return candidate;
}

function nonNegativeInteger(
  value: string | undefined,
  fallback: number,
  name: string,
  maximum: number,
): number {
  const candidate = value?.trim() ? Number(value) : fallback;
  if (!Number.isSafeInteger(candidate) || candidate < 0 || candidate > maximum) {
    throw new Error(`${name} must be a non-negative integer no greater than ${maximum}.`);
  }
  return candidate;
}

export function openAIEmbeddingConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): OpenAIEmbeddingConfig {
  const model = env.OPENAI_EMBEDDING_MODEL?.trim() || DEFAULT_OPENAI_EMBEDDING_MODEL;
  if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(model)) {
    throw new Error('OPENAI_EMBEDDING_MODEL has an invalid format.');
  }
  return {
    apiKey: env.OPENAI_API_KEY?.trim() || undefined,
    model,
    dimensions: positiveInteger(
      env.OPENAI_EMBEDDING_DIMENSIONS,
      DEFAULT_OPENAI_EMBEDDING_DIMENSIONS,
      'OPENAI_EMBEDDING_DIMENSIONS',
      16_000,
    ),
    timeoutMs: positiveInteger(env.OPENAI_EMBEDDING_TIMEOUT_MS, 15_000, 'OPENAI_EMBEDDING_TIMEOUT_MS', 120_000),
    batchSize: positiveInteger(env.OPENAI_EMBEDDING_BATCH_SIZE, 32, 'OPENAI_EMBEDDING_BATCH_SIZE', 2_048),
    maxRetries: nonNegativeInteger(env.OPENAI_EMBEDDING_MAX_RETRIES, 2, 'OPENAI_EMBEDDING_MAX_RETRIES', 5),
    maxResponseBytes: positiveInteger(
      env.OPENAI_EMBEDDING_MAX_RESPONSE_BYTES,
      16 * 1_024 * 1_024,
      'OPENAI_EMBEDDING_MAX_RESPONSE_BYTES',
      64 * 1_024 * 1_024,
    ),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function boundedJson(response: Response, maximumBytes: number): Promise<unknown> {
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (Number.isFinite(declared) && declared > maximumBytes) {
    throw new KnowledgeOperationError('provider_invalid_response');
  }
  if (!response.body) throw new KnowledgeOperationError('provider_invalid_response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    length += next.value.byteLength;
    if (length > maximumBytes) {
      await reader.cancel().catch(() => undefined);
      throw new KnowledgeOperationError('provider_invalid_response');
    }
    chunks.push(next.value);
  }
  const body = Buffer.concat(chunks.map((entry) => Buffer.from(entry))).toString('utf8');
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new KnowledgeOperationError('provider_invalid_response');
  }
}

function statusFailure(status: number): RagFailureCode {
  if (status === 429) return 'provider_rate_limited';
  if (status >= 500) return 'provider_unavailable';
  return 'provider_rejected';
}

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions: number;
  readonly model: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #sleep: (milliseconds: number) => Promise<void>;

  constructor(readonly config: OpenAIEmbeddingConfig, options: OpenAIEmbeddingProviderOptions = {}) {
    if (!Number.isSafeInteger(config.dimensions) || config.dimensions <= 0) throw new Error('Embedding dimensions are invalid.');
    if (!Number.isSafeInteger(config.batchSize) || config.batchSize <= 0 || config.batchSize > 2_048) throw new Error('Embedding batch size is invalid.');
    if (!Number.isSafeInteger(config.maxRetries) || config.maxRetries < 0 || config.maxRetries > 5) throw new Error('Embedding retry count is invalid.');
    if (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs <= 0) throw new Error('Embedding timeout is invalid.');
    this.model = config.model;
    this.dimensions = config.dimensions;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#sleep = options.sleep ?? ((milliseconds) => delay(milliseconds));
  }

  async embed(inputs: readonly string[]): Promise<number[][]> {
    if (!this.config.apiKey) throw new KnowledgeOperationError('configuration');
    if (inputs.length === 0) return [];
    if (inputs.some((input) => typeof input !== 'string' || input.length === 0)) {
      throw new KnowledgeOperationError('provider_rejected');
    }
    const embeddings: number[][] = [];
    for (let offset = 0; offset < inputs.length; offset += this.config.batchSize) {
      embeddings.push(...await this.#requestBatch(inputs.slice(offset, offset + this.config.batchSize)));
    }
    return embeddings;
  }

  async #requestBatch(inputs: readonly string[]): Promise<number[][]> {
    for (let attempt = 0; ; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
      try {
        const body: Record<string, unknown> = {
          input: inputs,
          model: this.model,
          encoding_format: 'float',
        };
        if (this.model.startsWith('text-embedding-3')) body.dimensions = this.dimensions;
        const response = await this.#fetch('https://api.openai.com/v1/embeddings', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!response.ok) {
          if (RETRYABLE_STATUS.has(response.status) && attempt < this.config.maxRetries) {
            await response.body?.cancel().catch(() => undefined);
            await this.#sleep(250 * 2 ** attempt);
            continue;
          }
          await response.body?.cancel().catch(() => undefined);
          throw new KnowledgeOperationError(statusFailure(response.status));
        }
        return this.#parseResponse(await boundedJson(response, this.config.maxResponseBytes), inputs.length);
      } catch (error) {
        if (error instanceof KnowledgeOperationError) throw error;
        if (controller.signal.aborted) {
          if (attempt < this.config.maxRetries) {
            await this.#sleep(250 * 2 ** attempt);
            continue;
          }
          throw new KnowledgeOperationError('provider_timeout');
        }
        if (attempt < this.config.maxRetries) {
          await this.#sleep(250 * 2 ** attempt);
          continue;
        }
        throw new KnowledgeOperationError('provider_unavailable');
      } finally {
        clearTimeout(timer);
      }
    }
  }

  #parseResponse(value: unknown, inputCount: number): number[][] {
    if (!isRecord(value) || value.model !== this.model || !Array.isArray(value.data) || value.data.length !== inputCount) {
      throw new KnowledgeOperationError('provider_invalid_response');
    }
    const output: Array<number[] | undefined> = Array.from({ length: inputCount });
    for (const item of value.data) {
      if (!isRecord(item) || !Number.isSafeInteger(item.index) || !Array.isArray(item.embedding)) {
        throw new KnowledgeOperationError('provider_invalid_response');
      }
      const index = item.index as number;
      if (index < 0 || index >= inputCount || output[index]) throw new KnowledgeOperationError('provider_invalid_response');
      if (
        item.embedding.length !== this.dimensions
        || item.embedding.some((entry) => typeof entry !== 'number' || !Number.isFinite(entry))
        || item.embedding.every((entry) => entry === 0)
      ) {
        throw new KnowledgeOperationError('provider_invalid_response');
      }
      output[index] = item.embedding as number[];
    }
    if (output.some((entry) => !entry)) throw new KnowledgeOperationError('provider_invalid_response');
    return output as number[][];
  }
}
