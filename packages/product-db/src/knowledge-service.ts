import { randomUUID } from 'node:crypto';
import { isUuid } from '@kodex/product-contract';
import { chunkText, contentChecksum, indexConfigurationChecksum } from './chunking.js';
import type { PostgresKnowledgeRepository, StoredDocument } from './knowledge-repository.js';
import {
  KnowledgeNotFoundError,
  KnowledgeCursorError,
  KnowledgeOperationError,
  type EmbeddingProvider,
  type KnowledgeDocumentPage,
  type KnowledgeScope,
  type RagFailureCode,
  type RetrievalResult,
} from './knowledge-types.js';
import type { RagConfig } from './rag-config.js';

export interface IndexTextDocumentInput {
  content: string;
  documentId?: string;
  sourceId?: string;
  title: string;
}

export interface IndexTextDocumentResult {
  chunkCount: number;
  document: StoredDocument;
  skipped: boolean;
}

function sameChecksum(left: Buffer | null, right: Buffer): boolean {
  return Boolean(left && left.length === right.length && left.equals(right));
}

function validateEmbeddings(
  embeddings: readonly (readonly number[])[],
  expectedCount: number,
  dimensions: number,
): void {
  if (
    embeddings.length !== expectedCount
    || embeddings.some((embedding) => (
      embedding.length !== dimensions
      || embedding.some((entry) => typeof entry !== 'number' || !Number.isFinite(entry))
      || embedding.every((entry) => entry === 0)
    ))
  ) {
    throw new KnowledgeOperationError('provider_invalid_response');
  }
}

function failureCode(error: unknown): RagFailureCode {
  return error instanceof KnowledgeOperationError ? error.code : 'unknown';
}

interface DocumentCursor {
  id: string;
  updatedAt: string;
}

function encodeCursor(document: StoredDocument): string {
  return Buffer.from(JSON.stringify({ id: document.id, updatedAt: document.updatedAt.toISOString() })).toString('base64url');
}

function decodeCursor(cursor: string | undefined): DocumentCursor | undefined {
  if (!cursor) return undefined;
  if (cursor.length > 512 || !/^[A-Za-z0-9_-]+$/u.test(cursor)) throw new KnowledgeCursorError();
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    const record = value as Record<string, unknown>;
    if (Object.keys(record).length !== 2 || typeof record.id !== 'string' || !isUuid(record.id) || typeof record.updatedAt !== 'string') throw new Error();
    const date = new Date(record.updatedAt);
    if (!Number.isFinite(date.getTime()) || date.toISOString() !== record.updatedAt) throw new Error();
    return { id: record.id, updatedAt: record.updatedAt };
  } catch {
    throw new KnowledgeCursorError();
  }
}

export class KnowledgeService {
  constructor(
    readonly repository: PostgresKnowledgeRepository,
    readonly embeddingProvider: EmbeddingProvider,
    readonly config: RagConfig,
  ) {}

  upsertSource(
    scope: KnowledgeScope,
    input: { externalKey: string; name: string; sourceType: string },
  ) {
    return this.repository.upsertSource(scope, input);
  }

  listSources(scope: KnowledgeScope) {
    return this.repository.listSources(scope);
  }

  async deleteSource(scope: KnowledgeScope, sourceId: string): Promise<void> {
    if (!await this.repository.deleteSource(scope, sourceId)) throw new KnowledgeNotFoundError();
  }

  async indexTextDocument(
    scope: KnowledgeScope,
    input: IndexTextDocumentInput,
  ): Promise<IndexTextDocumentResult> {
    const requestedId = input.documentId ?? randomUUID();
    let before = input.documentId
      ? await this.repository.getDocument(scope, input.documentId)
      : undefined;
    if (input.documentId && !before && await this.repository.documentIdExists(input.documentId)) {
      // Another same-owner request may have created the document between the
      // scoped lookup and the global UUID collision check. Re-read the scoped
      // row so only a genuinely foreign document ID is rejected.
      before = await this.repository.getDocument(scope, input.documentId);
      if (!before) throw new KnowledgeNotFoundError();
    }
    const source = before
      ? await this.repository.getSource(scope, before.sourceId)
      : input.sourceId
        ? await this.repository.getSource(scope, input.sourceId)
        : await this.repository.upsertSource(scope, {
          externalKey: 'manual-text',
          name: 'Manual text documents',
          sourceType: 'manual_text',
        });
    if (!source) throw new KnowledgeNotFoundError();
    if (before && input.sourceId && input.sourceId !== before.sourceId) throw new KnowledgeNotFoundError();
    const sourceDocumentId = before?.sourceDocumentId ?? requestedId;
    const identity = `${source.id}:${sourceDocumentId}`;
    return this.repository.withDocumentLock(scope, identity, async (client) => {
      const current = input.documentId
        ? await this.repository.getDocumentWithClient(client, scope, input.documentId)
        : undefined;
      if (before && !current) throw new KnowledgeNotFoundError();
      const checksum = contentChecksum(input.content);
      const configurationChecksum = indexConfigurationChecksum(
        this.config.chunking,
        this.embeddingProvider.model,
        this.embeddingProvider.dimensions,
      );
      if (
        current
        && sameChecksum(current.contentChecksum, checksum)
        && sameChecksum(current.indexConfigurationChecksum, configurationChecksum)
      ) {
        const document = current.title === input.title
          ? current
          : await this.repository.updateDocumentTitle(client, scope, current.id, input.title);
        return {
          document,
          chunkCount: await this.repository.countChunksWithClient(client, scope, current.id),
          skipped: true,
        };
      }
      const chunks = chunkText(input.content, this.config.chunking);
      const embeddings = await this.embeddingProvider.embed(chunks.map((chunk) => chunk.content));
      validateEmbeddings(embeddings, chunks.length, this.embeddingProvider.dimensions);
      const document = await this.repository.replaceDocument(client, scope, {
        content: input.content,
        contentChecksum: checksum,
        documentId: current?.id ?? requestedId,
        indexConfigurationChecksum: configurationChecksum,
        sourceDocumentId: current?.sourceDocumentId ?? sourceDocumentId,
        sourceId: current?.sourceId ?? source.id,
        title: input.title,
      }, chunks.map((chunk, index) => ({ ...chunk, embedding: embeddings[index] })), {
        dimensions: this.embeddingProvider.dimensions,
        model: this.embeddingProvider.model,
      });
      return { document, chunkCount: chunks.length, skipped: false };
    });
  }

  async listDocuments(
    scope: KnowledgeScope,
    options: { cursor?: string; limit: number },
  ): Promise<KnowledgeDocumentPage> {
    const cursor = decodeCursor(options.cursor);
    const records = await this.repository.listDocuments(scope, {
      limit: options.limit + 1,
      ...(cursor ? { beforeId: cursor.id, beforeUpdatedAt: new Date(cursor.updatedAt) } : {}),
    });
    const hasMore = records.length > options.limit;
    const data = records.slice(0, options.limit);
    return {
      data,
      ...(hasMore && data.length > 0 ? { nextCursor: encodeCursor(data.at(-1) as StoredDocument) } : {}),
    };
  }

  async deleteDocument(scope: KnowledgeScope, documentId: string): Promise<void> {
    const before = await this.repository.getDocument(scope, documentId);
    if (!before) throw new KnowledgeNotFoundError();
    await this.repository.withDocumentLock(scope, `${before.sourceId}:${before.sourceDocumentId}`, async (client) => {
      const current = await this.repository.getDocumentWithClient(client, scope, documentId);
      if (!current || !await this.repository.deleteDocument(client, scope, documentId)) {
        throw new KnowledgeNotFoundError();
      }
    });
  }

  async retrieve(
    scope: KnowledgeScope,
    query: string,
    options: { threshold?: number; topK?: number } = {},
  ): Promise<RetrievalResult> {
    const topK = options.topK ?? this.config.defaultTopK;
    const threshold = options.threshold ?? this.config.defaultThreshold;
    let runId: string;
    try {
      runId = await this.repository.createRetrievalRun(scope, {
        query,
        parameters: {
          metric: 'cosine',
          model: this.embeddingProvider.model,
          dimensions: this.embeddingProvider.dimensions,
          topK,
          threshold,
        },
      });
    } catch {
      throw new KnowledgeOperationError('database_error');
    }
    let queryEmbedding: number[];
    try {
      const embeddings = await this.embeddingProvider.embed([query]);
      validateEmbeddings(embeddings, 1, this.embeddingProvider.dimensions);
      queryEmbedding = embeddings[0];
    } catch (error) {
      const code = failureCode(error);
      await this.repository.failRetrievalRun(scope, runId, code).catch(() => undefined);
      throw error instanceof KnowledgeOperationError ? error : new KnowledgeOperationError(code);
    }
    try {
      const citations = await this.repository.completeRetrievalRun(scope, {
        dimensions: this.embeddingProvider.dimensions,
        model: this.embeddingProvider.model,
        queryEmbedding,
        runId,
        threshold,
        topK,
      });
      return { runId, citations };
    } catch {
      await this.repository.failRetrievalRun(scope, runId, 'database_error').catch(() => undefined);
      throw new KnowledgeOperationError('database_error');
    }
  }
}
