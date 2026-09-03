import { createHash } from 'node:crypto';
import { isUuid } from '@kodex/product-contract';
import type { PoolClient, QueryResult } from 'pg';
import type { ProductDatabase } from './database.js';
import {
  DEFAULT_OPENAI_EMBEDDING_DIMENSIONS,
  DEFAULT_OPENAI_EMBEDDING_MODEL,
} from './embedding-provider.js';
import { KnowledgeNotFoundError, type KnowledgeDocumentRecord, type KnowledgeScope, type KnowledgeSourceRecord, type RagFailureCode, type RetrievalCitation } from './knowledge-types.js';

interface SourceRow {
  created_at: Date;
  id: string;
  name: string;
  source_type: string;
  status: KnowledgeSourceRecord['status'];
  updated_at: Date;
}

interface DocumentRow {
  content_checksum: Buffer | null;
  created_at: Date;
  id: string;
  index_configuration_checksum: Buffer | null;
  source_document_id: string;
  source_id: string;
  source_type: string;
  title: string | null;
  updated_at: Date;
}

interface CitationRow {
  chunk_id: string;
  content: string;
  document_id: string;
  document_title: string | null;
  score: number;
  source_type: string;
}

const ANN_CANDIDATE_MULTIPLIER = 8;
const ANN_MAX_CANDIDATES = 800;

// This statement must stay structurally identical to the expression and partial
// predicate in 0005_default_embedding_hnsw.sql. All identifiers, typmods, and
// model/dimension literals are trusted source constants, never configuration.
const DEFAULT_ANN_SEARCH_SQL = `
  WITH nearest AS MATERIALIZED (
    SELECT chunk.id AS chunk_id,
           chunk.embedding::vector(1536) <=> $1::vector(1536) AS distance
    FROM document_chunks AS chunk
    WHERE chunk.workspace_id = $2
      AND chunk.created_by_user_id = $3
      AND chunk.embedding_model = 'text-embedding-3-small'
      AND chunk.embedding_dimensions = 1536
      AND chunk.embedding IS NOT NULL
      AND chunk.embedding::vector(1536) <=> $1::vector(1536) <= 1 - $4::double precision
    ORDER BY chunk.embedding::vector(1536) <=> $1::vector(1536) ASC, chunk.id ASC
    LIMIT $5
  )
  SELECT chunk.id AS chunk_id, chunk.content, document.id AS document_id,
         document.title AS document_title, source.source_type,
         1 - nearest.distance AS score
  FROM nearest
  JOIN document_chunks AS chunk ON chunk.id = nearest.chunk_id
  JOIN documents AS document
    ON document.id = chunk.document_id
   AND document.workspace_id = chunk.workspace_id
   AND document.created_by_user_id = chunk.created_by_user_id
  JOIN knowledge_sources AS source
    ON source.id = document.source_id
   AND source.workspace_id = document.workspace_id
   AND source.created_by_user_id = document.created_by_user_id
  ORDER BY nearest.distance ASC, nearest.chunk_id ASC
  LIMIT $6
  FOR KEY SHARE OF chunk, document
`;

const GENERIC_EXACT_SEARCH_SQL = `
  WITH compatible AS MATERIALIZED (
    SELECT chunk.id AS chunk_id, chunk.content, chunk.embedding,
           document.id AS document_id, document.title AS document_title,
           source.source_type
    FROM document_chunks AS chunk
    JOIN documents AS document
      ON document.id = chunk.document_id
     AND document.workspace_id = chunk.workspace_id
     AND document.created_by_user_id = chunk.created_by_user_id
    JOIN knowledge_sources AS source
      ON source.id = document.source_id
     AND source.workspace_id = document.workspace_id
     AND source.created_by_user_id = document.created_by_user_id
    WHERE chunk.workspace_id = $2
      AND chunk.created_by_user_id = $3
      AND chunk.embedding_model = $4
      AND chunk.embedding_dimensions = $5
  )
  SELECT compatible.chunk_id, compatible.content, compatible.document_id,
         compatible.document_title, compatible.source_type,
         1 - (compatible.embedding <=> $1::vector) AS score
  FROM compatible
  JOIN document_chunks AS locked_chunk ON locked_chunk.id = compatible.chunk_id
  JOIN documents AS locked_document ON locked_document.id = compatible.document_id
  WHERE 1 - (compatible.embedding <=> $1::vector) >= $6
  ORDER BY compatible.embedding <=> $1::vector ASC, compatible.chunk_id ASC
  LIMIT $7
  FOR KEY SHARE OF locked_chunk, locked_document
`;

export interface StoredDocument extends KnowledgeDocumentRecord {
  contentChecksum: Buffer | null;
  indexConfigurationChecksum: Buffer | null;
  sourceDocumentId: string;
}

export interface ReplacementChunk {
  content: string;
  embedding: readonly number[];
  index: number;
}

export interface ReplaceDocumentInput {
  content: string;
  contentChecksum: Buffer;
  documentId: string;
  indexConfigurationChecksum: Buffer;
  sourceDocumentId: string;
  sourceId: string;
  title: string;
}

function validateScope(scope: KnowledgeScope): void {
  if (!isUuid(scope.workspaceId) || !isUuid(scope.userId)) throw new Error('Knowledge scope IDs must be UUIDs.');
}

function sourceRecord(row: SourceRow): KnowledgeSourceRecord {
  return {
    id: row.id,
    sourceType: row.source_type,
    name: row.name,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function documentRecord(row: DocumentRow): StoredDocument {
  return {
    id: row.id,
    sourceId: row.source_id,
    sourceDocumentId: row.source_document_id,
    sourceType: row.source_type,
    title: row.title,
    contentChecksum: row.content_checksum,
    indexConfigurationChecksum: row.index_configuration_checksum,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function vectorLiteral(vector: readonly number[], dimensions: number): string {
  if (
    vector.length !== dimensions
    || vector.some((entry) => typeof entry !== 'number' || !Number.isFinite(entry))
    || vector.every((entry) => entry === 0)
  ) {
    throw new Error('Embedding vector failed finite dimension validation.');
  }
  return `[${vector.join(',')}]`;
}

function lockKey(scope: KnowledgeScope, identity: string): bigint {
  return createHash('sha256')
    .update(`${scope.workspaceId}\0${scope.userId}\0${identity}`)
    .digest()
    .readBigInt64BE(0);
}

export class PostgresKnowledgeRepository {
  constructor(readonly database: ProductDatabase) {}

  async withDocumentLock<Result>(
    scope: KnowledgeScope,
    identity: string,
    operation: (client: PoolClient) => Promise<Result>,
  ): Promise<Result> {
    validateScope(scope);
    const client = await this.database.pool.connect();
    const key = lockKey(scope, identity).toString();
    try {
      // A session advisory lock serializes identical upserts without holding a DB transaction
      // across the external embedding call.
      await client.query('SELECT pg_advisory_lock($1::bigint)', [key]);
      return await operation(client);
    } finally {
      await client.query('SELECT pg_advisory_unlock($1::bigint)', [key]).catch(() => undefined);
      client.release();
    }
  }

  async upsertSource(
    scope: KnowledgeScope,
    input: { externalKey: string; name: string; sourceType: string },
  ): Promise<KnowledgeSourceRecord> {
    validateScope(scope);
    const result = await this.database.query<SourceRow>(`
      INSERT INTO knowledge_sources (
        workspace_id, created_by_user_id, source_type, external_key, name, status, configuration
      ) VALUES ($1, $2, $3, $4, $5, 'ready', '{}'::jsonb)
      ON CONFLICT (workspace_id, created_by_user_id, source_type, external_key)
        WHERE external_key IS NOT NULL
      DO UPDATE SET name = EXCLUDED.name, status = 'ready', updated_at = now()
      RETURNING id, source_type, name, status, created_at, updated_at
    `, [scope.workspaceId, scope.userId, input.sourceType, input.externalKey, input.name]);
    return sourceRecord(result.rows[0]);
  }

  async getSource(scope: KnowledgeScope, sourceId: string): Promise<KnowledgeSourceRecord | undefined> {
    validateScope(scope);
    const result = await this.database.query<SourceRow>(`
      SELECT id, source_type, name, status, created_at, updated_at
      FROM knowledge_sources
      WHERE id = $1 AND workspace_id = $2 AND created_by_user_id = $3
    `, [sourceId, scope.workspaceId, scope.userId]);
    return result.rows[0] ? sourceRecord(result.rows[0]) : undefined;
  }

  async listSources(scope: KnowledgeScope): Promise<KnowledgeSourceRecord[]> {
    validateScope(scope);
    const result = await this.database.query<SourceRow>(`
      SELECT id, source_type, name, status, created_at, updated_at
      FROM knowledge_sources
      WHERE workspace_id = $1 AND created_by_user_id = $2
      ORDER BY updated_at DESC, id DESC
    `, [scope.workspaceId, scope.userId]);
    return result.rows.map(sourceRecord);
  }

  async deleteSource(scope: KnowledgeScope, sourceId: string): Promise<boolean> {
    validateScope(scope);
    const result = await this.database.query(`
      DELETE FROM knowledge_sources
      WHERE id = $1 AND workspace_id = $2 AND created_by_user_id = $3
    `, [sourceId, scope.workspaceId, scope.userId]);
    return result.rowCount === 1;
  }

  async getDocument(scope: KnowledgeScope, documentId: string): Promise<StoredDocument | undefined> {
    return this.#getDocument(scope, documentId);
  }

  async getDocumentWithClient(
    client: PoolClient,
    scope: KnowledgeScope,
    documentId: string,
  ): Promise<StoredDocument | undefined> {
    return this.#getDocument(scope, documentId, client);
  }

  async #getDocument(
    scope: KnowledgeScope,
    documentId: string,
    client?: PoolClient,
  ): Promise<StoredDocument | undefined> {
    validateScope(scope);
    const text = `
      SELECT id, source_id, source_document_id, title, content_checksum,
             index_configuration_checksum, created_at, updated_at,
             (SELECT source_type FROM knowledge_sources WHERE id = documents.source_id) AS source_type
      FROM documents
      WHERE id = $1 AND workspace_id = $2 AND created_by_user_id = $3
    `;
    const values = [documentId, scope.workspaceId, scope.userId];
    const result = client
      ? await client.query<DocumentRow>(text, values)
      : await this.database.query<DocumentRow>(text, values);
    return result.rows[0] ? documentRecord(result.rows[0]) : undefined;
  }

  async getDocumentBySourceIdentity(
    scope: KnowledgeScope,
    sourceId: string,
    sourceDocumentId: string,
  ): Promise<StoredDocument | undefined> {
    return this.#getDocumentBySourceIdentity(scope, sourceId, sourceDocumentId);
  }

  async getDocumentBySourceIdentityWithClient(
    client: PoolClient,
    scope: KnowledgeScope,
    sourceId: string,
    sourceDocumentId: string,
  ): Promise<StoredDocument | undefined> {
    return this.#getDocumentBySourceIdentity(scope, sourceId, sourceDocumentId, client);
  }

  async #getDocumentBySourceIdentity(
    scope: KnowledgeScope,
    sourceId: string,
    sourceDocumentId: string,
    client?: PoolClient,
  ): Promise<StoredDocument | undefined> {
    validateScope(scope);
    const text = `
      SELECT document.id, document.source_id, document.source_document_id,
             document.title, document.content_checksum,
             document.index_configuration_checksum, document.created_at,
             document.updated_at, source.source_type
      FROM documents AS document
      JOIN knowledge_sources AS source
        ON source.id = document.source_id
       AND source.workspace_id = document.workspace_id
       AND source.created_by_user_id = document.created_by_user_id
      WHERE document.source_id = $1 AND document.source_document_id = $2
        AND document.workspace_id = $3 AND document.created_by_user_id = $4
    `;
    const values = [sourceId, sourceDocumentId, scope.workspaceId, scope.userId];
    const result = client
      ? await client.query<DocumentRow>(text, values)
      : await this.database.query<DocumentRow>(text, values);
    return result.rows[0] ? documentRecord(result.rows[0]) : undefined;
  }

  async documentIdExists(documentId: string): Promise<boolean> {
    if (!isUuid(documentId)) throw new Error('Document ID must be a UUID.');
    const result = await this.database.query<{ exists: boolean }>(
      'SELECT EXISTS (SELECT 1 FROM documents WHERE id = $1) AS exists',
      [documentId],
    );
    return result.rows[0].exists;
  }

  async listDocuments(
    scope: KnowledgeScope,
    options: { beforeId?: string; beforeUpdatedAt?: Date; limit: number },
  ): Promise<KnowledgeDocumentRecord[]> {
    validateScope(scope);
    const result = await this.database.query<DocumentRow>(`
      SELECT document.id, document.source_id, document.source_document_id,
             document.title, document.content_checksum,
             document.index_configuration_checksum, document.created_at,
             document.updated_at, source.source_type
      FROM documents AS document
      JOIN knowledge_sources AS source
        ON source.id = document.source_id
       AND source.workspace_id = document.workspace_id
       AND source.created_by_user_id = document.created_by_user_id
      WHERE document.workspace_id = $1 AND document.created_by_user_id = $2
        AND ($3::timestamptz IS NULL OR (document.updated_at, document.id) < ($3::timestamptz, $4::uuid))
      ORDER BY document.updated_at DESC, document.id DESC
      LIMIT $5
    `, [scope.workspaceId, scope.userId, options.beforeUpdatedAt ?? null, options.beforeId ?? null, options.limit]);
    return result.rows.map(documentRecord);
  }

  async replaceDocument(
    client: PoolClient,
    scope: KnowledgeScope,
    input: ReplaceDocumentInput,
    chunks: readonly ReplacementChunk[],
    embedding: { dimensions: number; model: string },
  ): Promise<StoredDocument> {
    validateScope(scope);
    return this.database.transactionWithClient(client, async (transactionClient) => {
      const result = await transactionClient.query<DocumentRow>(`
        WITH upserted AS (
        INSERT INTO documents (
          id, workspace_id, created_by_user_id, source_id, source_document_id,
          title, mime_type, content_checksum, index_configuration_checksum, content_text
        ) VALUES ($1, $2, $3, $4, $5, $6, 'text/plain; charset=utf-8', $7, $8, $9)
        ON CONFLICT (source_id, source_document_id) DO UPDATE SET
          title = EXCLUDED.title,
          mime_type = EXCLUDED.mime_type,
          content_checksum = EXCLUDED.content_checksum,
          index_configuration_checksum = EXCLUDED.index_configuration_checksum,
          content_text = EXCLUDED.content_text,
          updated_at = now()
        WHERE documents.workspace_id = EXCLUDED.workspace_id
          AND documents.created_by_user_id = EXCLUDED.created_by_user_id
          AND documents.id = EXCLUDED.id
        RETURNING id, source_id, source_document_id, title, content_checksum,
                  index_configuration_checksum, created_at, updated_at
        )
        SELECT upserted.*, source.source_type
        FROM upserted
        JOIN knowledge_sources AS source ON source.id = upserted.source_id
      `, [
        input.documentId, scope.workspaceId, scope.userId, input.sourceId,
        input.sourceDocumentId, input.title, input.contentChecksum,
        input.indexConfigurationChecksum, input.content,
      ]);
      if (!result.rows[0]) throw new KnowledgeNotFoundError();
      await transactionClient.query(`
        DELETE FROM document_chunks
        WHERE document_id = $1 AND workspace_id = $2 AND created_by_user_id = $3
      `, [input.documentId, scope.workspaceId, scope.userId]);
      for (const chunk of chunks) {
        await transactionClient.query(`
          INSERT INTO document_chunks (
            workspace_id, created_by_user_id, document_id, chunk_index, content,
            embedding, embedding_model, embedding_dimensions
          ) VALUES ($1, $2, $3, $4, $5, $6::vector, $7, $8)
        `, [
          scope.workspaceId, scope.userId, input.documentId, chunk.index, chunk.content,
          vectorLiteral(chunk.embedding, embedding.dimensions), embedding.model, embedding.dimensions,
        ]);
      }
      return documentRecord(result.rows[0]);
    });
  }

  async deleteDocument(
    client: PoolClient,
    scope: KnowledgeScope,
    documentId: string,
  ): Promise<boolean> {
    validateScope(scope);
    const result = await client.query(`
      DELETE FROM documents
      WHERE id = $1 AND workspace_id = $2 AND created_by_user_id = $3
    `, [documentId, scope.workspaceId, scope.userId]);
    return result.rowCount === 1;
  }

  async updateDocumentTitle(
    client: PoolClient,
    scope: KnowledgeScope,
    documentId: string,
    title: string,
  ): Promise<StoredDocument> {
    validateScope(scope);
    const result = await client.query<DocumentRow>(`
      WITH updated AS (
      UPDATE documents SET title = $1, updated_at = now()
      WHERE id = $2 AND workspace_id = $3 AND created_by_user_id = $4
      RETURNING id, source_id, source_document_id, title, content_checksum,
                index_configuration_checksum, created_at, updated_at
      )
      SELECT updated.*, source.source_type
      FROM updated
      JOIN knowledge_sources AS source ON source.id = updated.source_id
    `, [title, documentId, scope.workspaceId, scope.userId]);
    if (!result.rows[0]) throw new KnowledgeNotFoundError();
    return documentRecord(result.rows[0]);
  }

  async createRetrievalRun(
    scope: KnowledgeScope,
    input: { query: string; parameters: Record<string, unknown> },
  ): Promise<string> {
    validateScope(scope);
    const result = await this.database.query<{ id: string }>(`
      INSERT INTO retrieval_runs (workspace_id, created_by_user_id, query, parameters, status)
      VALUES ($1, $2, $3, $4::jsonb, 'running')
      RETURNING id
    `, [scope.workspaceId, scope.userId, input.query, JSON.stringify(input.parameters)]);
    return result.rows[0].id;
  }

  async completeRetrievalRun(
    scope: KnowledgeScope,
    input: {
      dimensions: number;
      model: string;
      queryEmbedding: readonly number[];
      runId: string;
      threshold: number;
      topK: number;
    },
  ): Promise<RetrievalCitation[]> {
    validateScope(scope);
    const queryVector = vectorLiteral(input.queryEmbedding, input.dimensions);
    return this.database.transaction(async (client) => {
      const useDefaultAnn = input.model === DEFAULT_OPENAI_EMBEDDING_MODEL
        && input.dimensions === DEFAULT_OPENAI_EMBEDDING_DIMENSIONS;
      let candidates: QueryResult<CitationRow>;
      if (useDefaultAnn) {
        // pgvector applies ordinary WHERE clauses after an approximate scan. Strict
        // iterative scanning keeps expanding the HNSW scan for selective tenants,
        // while max_scan_tuples and candidate overfetch bound the work.
        await client.query("SET LOCAL hnsw.iterative_scan = 'strict_order'");
        await client.query('SET LOCAL hnsw.max_scan_tuples = 20000');
        const candidateLimit = Math.min(
          input.topK * ANN_CANDIDATE_MULTIPLIER,
          ANN_MAX_CANDIDATES,
        );
        candidates = await client.query<CitationRow>(DEFAULT_ANN_SEARCH_SQL, [
          queryVector, scope.workspaceId, scope.userId, input.threshold,
          candidateLimit, input.topK,
        ]);
      } else {
        candidates = await client.query<CitationRow>(GENERIC_EXACT_SEARCH_SQL, [
          queryVector, scope.workspaceId, scope.userId, input.model,
          input.dimensions, input.threshold, input.topK,
        ]);
      }
      const updated = await client.query(`
        UPDATE retrieval_runs SET
          query_embedding = $1::vector,
          embedding_model = $2,
          embedding_dimensions = $3,
          status = 'completed',
          completed_at = now(),
          error_code = NULL
        WHERE id = $4 AND workspace_id = $5 AND created_by_user_id = $6 AND status = 'running'
      `, [queryVector, input.model, input.dimensions, input.runId, scope.workspaceId, scope.userId]);
      if (updated.rowCount !== 1) throw new KnowledgeNotFoundError();
      const citations: RetrievalCitation[] = [];
      for (let index = 0; index < candidates.rows.length; index += 1) {
        const candidate = candidates.rows[index];
        const rank = index + 1;
        const score = Number(candidate.score);
        if (!Number.isFinite(score)) throw new Error('Database returned a non-finite similarity score.');
        await client.query(`
          INSERT INTO retrieval_citations (
            workspace_id, created_by_user_id, retrieval_run_id, chunk_id,
            rank, score, quoted_text, metadata
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
        `, [
          scope.workspaceId, scope.userId, input.runId, candidate.chunk_id,
          rank, score, candidate.content,
          JSON.stringify({
            documentId: candidate.document_id,
            documentTitle: candidate.document_title,
            sourceType: candidate.source_type,
          }),
        ]);
        citations.push({
          chunkId: candidate.chunk_id,
          content: candidate.content,
          documentId: candidate.document_id,
          documentTitle: candidate.document_title,
          rank,
          score,
          sourceType: candidate.source_type,
        });
      }
      return citations;
    });
  }

  async failRetrievalRun(scope: KnowledgeScope, runId: string, code: RagFailureCode): Promise<void> {
    validateScope(scope);
    await this.database.query(`
      UPDATE retrieval_runs SET status = 'failed', error_code = $1, completed_at = now()
      WHERE id = $2 AND workspace_id = $3 AND created_by_user_id = $4 AND status = 'running'
    `, [code, runId, scope.workspaceId, scope.userId]);
  }

  async countChunks(scope: KnowledgeScope, documentId: string): Promise<number> {
    return this.#countChunks(scope, documentId);
  }

  async countChunksWithClient(
    client: PoolClient,
    scope: KnowledgeScope,
    documentId: string,
  ): Promise<number> {
    return this.#countChunks(scope, documentId, client);
  }

  async #countChunks(
    scope: KnowledgeScope,
    documentId: string,
    client?: PoolClient,
  ): Promise<number> {
    validateScope(scope);
    const text = `
      SELECT count(*)::text AS count FROM document_chunks
      WHERE document_id = $1 AND workspace_id = $2 AND created_by_user_id = $3
    `;
    const values = [documentId, scope.workspaceId, scope.userId];
    const result = client
      ? await client.query<{ count: string }>(text, values)
      : await this.database.query<{ count: string }>(text, values);
    return Number(result.rows[0].count);
  }
}
