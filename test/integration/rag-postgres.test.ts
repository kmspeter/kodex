import { randomUUID } from 'node:crypto';
import { PRODUCT_WORKSPACE_HEADER_NAME } from '@kodex/product-contract';
import {
  AuthService,
  KnowledgeOperationError,
  KnowledgeService,
  PostgresAuthRepository,
  PostgresKnowledgeRepository,
  createProductDatabase,
  hashSessionToken,
  requireProductDatabaseConfig,
  requireProductDatabaseFromEnv,
  type EmbeddingProvider,
  type PasswordHasher,
  type ProductDatabase,
  type RagConfig,
} from '@kodex/product-db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ProductApiConfig } from '../../apps/api/src/config.js';
import { createCsrfToken, csrfCookieName, sessionCookieName } from '../../apps/api/src/cookies.js';
import { ProductApiServer } from '../../apps/api/src/server.js';

const runId = randomUUID();
const userA = randomUUID();
const userB = randomUUID();
const workspaceA = randomUUID();
const workspaceB = randomUUID();
const scopeA = { userId: userA, workspaceId: workspaceA };
const scopeB = { userId: userB, workspaceId: workspaceA };
const scopeOtherWorkspace = { userId: userA, workspaceId: workspaceB };

const config: RagConfig = {
  enabled: true,
  automationsEnabled: false,
  chunking: { chunkCharacters: 128, overlapCharacters: 16 },
  contextMaxCharacters: 2_000,
  defaultThreshold: -1,
  defaultTopK: 10,
  maxTopK: 20,
  maxDocumentCharacters: 10_000,
  maxQueryCharacters: 1_000,
};

function unitVector(text: string, dimensions: number): number[] {
  const lower = text.toLocaleLowerCase();
  const base = lower.includes('alpha') ? 0 : lower.includes('beta') ? 1 : 2;
  return Array.from({ length: dimensions }, (_entry, index) => index === Math.min(base, dimensions - 1) ? 1 : 0);
}

class FakeEmbeddingProvider implements EmbeddingProvider {
  calls: string[][] = [];
  failNext = false;

  constructor(readonly model = 'fake-embedding-v1', readonly dimensions = 3) {}

  async embed(inputs: readonly string[]): Promise<number[][]> {
    this.calls.push([...inputs]);
    if (this.failNext) {
      this.failNext = false;
      throw new KnowledgeOperationError('provider_unavailable');
    }
    return inputs.map((input) => unitVector(input, this.dimensions));
  }
}

class CoordinatedEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions = 3;
  readonly model = 'fake-coordinated-v1';
  calls: string[][] = [];
  #arrivals = 0;
  #release!: () => void;
  readonly #barrier = new Promise<void>((resolve) => { this.#release = resolve; });

  async embed(inputs: readonly string[]): Promise<number[][]> {
    this.calls.push([...inputs]);
    this.#arrivals += 1;
    if (this.#arrivals === 2) this.#release();
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.#barrier,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error('Concurrent embedding barrier timed out.')), 2_000);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    return inputs.map((input) => unitVector(input, this.dimensions));
  }
}

async function within<T>(operation: Promise<T>, milliseconds = 5_000): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`Operation exceeded ${milliseconds}ms.`)), milliseconds);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function databaseWithPoolSize(max: number): ProductDatabase {
  return createProductDatabase({
    ...requireProductDatabaseConfig(),
    application_name: `kodex-rag-pool-${max}-regression`,
    connectionTimeoutMillis: 1_000,
    max,
  });
}

function passwordHasher(): PasswordHasher {
  return {
    hash: async (value) => `fake:${value}`,
    verify: async (encoded, value) => encoded === `fake:${value}`,
    needsRehash: () => false,
  };
}

describe('real pgvector private RAG integration', () => {
  let database: ProductDatabase;
  let repository: PostgresKnowledgeRepository;
  let provider: FakeEmbeddingProvider;
  let service: KnowledgeService;

  beforeAll(async () => {
    database = requireProductDatabaseFromEnv();
    await database.migrate();
    await database.query('INSERT INTO users (id, email) VALUES ($1, $2), ($3, $4)', [
      userA, `rag-a-${runId}@example.invalid`, userB, `rag-b-${runId}@example.invalid`,
    ]);
    await database.query(`
      INSERT INTO workspaces (id, slug, name, owner_user_id)
      VALUES ($1, $2, 'RAG A', $3), ($4, $5, 'RAG B', $3)
    `, [workspaceA, `rag-a-${runId}`, userA, workspaceB, `rag-b-${runId}`]);
    await database.query(`
      INSERT INTO workspace_members (workspace_id, user_id, role)
      VALUES ($1, $2, 'owner'), ($1, $3, 'member'), ($4, $2, 'owner')
    `, [workspaceA, userA, userB, workspaceB]);
    repository = new PostgresKnowledgeRepository(database);
    provider = new FakeEmbeddingProvider();
    service = new KnowledgeService(repository, provider, config);
  });

  afterAll(async () => {
    await database?.query('DELETE FROM workspaces WHERE id = ANY($1::uuid[])', [[workspaceA, workspaceB]]).catch(() => undefined);
    await database?.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [[userA, userB]]).catch(() => undefined);
    await database?.close();
  });

  async function index(
    activeService: KnowledgeService,
    scope: { userId: string; workspaceId: string },
    content: string,
  ) {
    const documentId = randomUUID();
    const result = await activeService.indexTextDocument(scope, { documentId, title: content, content });
    return { documentId, result };
  }

  it('orders cosine nearest neighbors and records completed runs plus citations', async () => {
    const alpha = await index(service, scopeA, 'alpha reference');
    await index(service, scopeA, 'beta reference');
    const result = await service.retrieve(scopeA, 'alpha question', { topK: 10, threshold: -1 });

    expect(result.citations[0]).toMatchObject({ documentId: alpha.documentId, rank: 1, score: 1 });
    const persisted = await database.query<{ citation_count: string; status: string }>(`
      SELECT run.status, count(citation.id)::text AS citation_count
      FROM retrieval_runs AS run
      LEFT JOIN retrieval_citations AS citation
        ON citation.retrieval_run_id = run.id
       AND citation.workspace_id = run.workspace_id
       AND citation.created_by_user_id = run.created_by_user_id
      WHERE run.id = $1 AND run.workspace_id = $2 AND run.created_by_user_id = $3
      GROUP BY run.status
    `, [result.runId, workspaceA, userA]);
    expect(persisted.rows[0]).toMatchObject({ status: 'completed' });
    expect(Number(persisted.rows[0].citation_count)).toBe(result.citations.length);
  });

  it('filters identical content by both embedding model and dimensions', async () => {
    const modelTwo = new KnowledgeService(repository, new FakeEmbeddingProvider('fake-embedding-v2', 3), config);
    const dimensionTwo = new KnowledgeService(repository, new FakeEmbeddingProvider('fake-embedding-v1', 2), config);
    const wrongModel = await index(modelTwo, scopeA, 'alpha wrong model');
    const wrongDimension = await index(dimensionTwo, scopeA, 'alpha wrong dimension');

    const result = await service.retrieve(scopeA, 'alpha filter', { topK: 20, threshold: -1 });
    expect(result.citations.map((entry) => entry.documentId)).not.toContain(wrongModel.documentId);
    expect(result.citations.map((entry) => entry.documentId)).not.toContain(wrongDimension.documentId);
  });

  it('skips unchanged checksums and atomically preserves the old index after failed re-embedding', async () => {
    const documentId = randomUUID();
    const first = await service.indexTextDocument(scopeA, { documentId, title: 'Atomic', content: 'gamma old index' });
    const chunksBefore = await database.query<{ content: string; id: string }>(
      'SELECT id, content FROM document_chunks WHERE document_id = $1 ORDER BY chunk_index',
      [documentId],
    );
    const callsBeforeSkip = provider.calls.length;
    const unchanged = await service.indexTextDocument(scopeA, { documentId, title: 'Atomic', content: 'gamma old index' });
    expect(unchanged.skipped).toBe(true);
    expect(provider.calls).toHaveLength(callsBeforeSkip);
    expect(unchanged.document.updatedAt).toEqual(first.document.updatedAt);

    provider.failNext = true;
    await expect(service.indexTextDocument(scopeA, {
      documentId, title: 'Atomic changed', content: 'beta replacement must fail',
    })).rejects.toMatchObject({ code: 'provider_unavailable' });
    const afterFailure = await database.query<{ content: string; id: string }>(
      'SELECT id, content FROM document_chunks WHERE document_id = $1 ORDER BY chunk_index',
      [documentId],
    );
    expect(afterFailure.rows).toEqual(chunksBefore.rows);

    const changed = await service.indexTextDocument(scopeA, {
      documentId, title: 'Atomic changed', content: 'beta replacement succeeds',
    });
    expect(changed.skipped).toBe(false);
    const afterSuccess = await database.query<{ content: string; id: string }>(
      'SELECT id, content FROM document_chunks WHERE document_id = $1 ORDER BY chunk_index',
      [documentId],
    );
    expect(afterSuccess.rows[0].content).toBe('beta replacement succeeds');
    expect(afterSuccess.rows[0].id).not.toBe(chunksBefore.rows[0].id);
  });

  it('serializes duplicate concurrent upserts so only one embeds and the other skips', async () => {
    const localProvider = new FakeEmbeddingProvider();
    const localService = new KnowledgeService(repository, localProvider, config);
    const documentId = randomUUID();
    const results = await Promise.all([
      localService.indexTextDocument(scopeA, { documentId, title: 'Concurrent', content: 'alpha concurrent' }),
      localService.indexTextDocument(scopeA, { documentId, title: 'Concurrent', content: 'alpha concurrent' }),
    ]);
    expect(results.filter((entry) => entry.skipped)).toHaveLength(1);
    expect(localProvider.calls).toHaveLength(1);
    expect(await repository.countChunks(scopeA, documentId)).toBe(1);
  });

  it('indexes, updates, and deletes through one advisory-lock client with pool max 1', async () => {
    const singleConnectionDatabase = databaseWithPoolSize(1);
    const singleConnectionRepository = new PostgresKnowledgeRepository(singleConnectionDatabase);
    const singleConnectionProvider = new FakeEmbeddingProvider('fake-pool-one-v1');
    const singleConnectionService = new KnowledgeService(
      singleConnectionRepository,
      singleConnectionProvider,
      config,
    );
    const documentId = randomUUID();
    try {
      const created = await within(singleConnectionService.indexTextDocument(scopeA, {
        documentId,
        title: 'Pool one initial',
        content: 'alpha pool one initial',
      }));
      expect(created.skipped).toBe(false);

      const titleOnly = await within(singleConnectionService.indexTextDocument(scopeA, {
        documentId,
        title: 'Pool one title changed',
        content: 'alpha pool one initial',
      }));
      expect(titleOnly).toMatchObject({ skipped: true, chunkCount: 1 });

      const replaced = await within(singleConnectionService.indexTextDocument(scopeA, {
        documentId,
        title: 'Pool one replaced',
        content: 'beta pool one replacement',
      }));
      expect(replaced.skipped).toBe(false);

      await within(singleConnectionService.deleteDocument(scopeA, documentId));
      await expect(singleConnectionRepository.getDocument(scopeA, documentId)).resolves.toBeUndefined();
      expect(singleConnectionProvider.calls).toHaveLength(2);
    } finally {
      await singleConnectionDatabase.close();
    }
  });

  it('indexes pool-size distinct documents concurrently without connection starvation', async () => {
    const twoConnectionDatabase = databaseWithPoolSize(2);
    const twoConnectionRepository = new PostgresKnowledgeRepository(twoConnectionDatabase);
    const coordinatedProvider = new CoordinatedEmbeddingProvider();
    const twoConnectionService = new KnowledgeService(
      twoConnectionRepository,
      coordinatedProvider,
      config,
    );
    const documentIds = [randomUUID(), randomUUID()];
    try {
      const results = await within(Promise.all(documentIds.map((documentId, index) => (
        twoConnectionService.indexTextDocument(scopeA, {
          documentId,
          title: `Pool two ${index}`,
          content: index === 0 ? 'alpha pool two first' : 'beta pool two second',
        })
      ))));
      expect(results.every((result) => result.skipped === false)).toBe(true);
      expect(coordinatedProvider.calls).toHaveLength(2);
      await expect(Promise.all(documentIds.map((documentId) => (
        twoConnectionRepository.countChunks(scopeA, documentId)
      )))).resolves.toEqual([1, 1]);
    } finally {
      await twoConnectionDatabase.close();
    }
  });

  it('isolates same-workspace users and the same user across workspaces at SQL and FK boundaries', async () => {
    const otherUser = await index(service, scopeB, 'alpha private user B');
    const otherWorkspace = await index(service, scopeOtherWorkspace, 'alpha private workspace B');
    const result = await service.retrieve(scopeA, 'alpha isolation', { topK: 20, threshold: -1 });
    const ids = result.citations.map((entry) => entry.documentId);
    expect(ids).not.toContain(otherUser.documentId);
    expect(ids).not.toContain(otherWorkspace.documentId);
    await expect(repository.getDocument(scopeA, otherUser.documentId)).resolves.toBeUndefined();

    const foreignChunk = await database.query<{ id: string }>(
      'SELECT id FROM document_chunks WHERE document_id = $1',
      [otherUser.documentId],
    );
    const running = await repository.createRetrievalRun(scopeA, { query: 'boundary', parameters: {} });
    const crossScopeInsert = database.query(`
      INSERT INTO retrieval_citations (
        workspace_id, created_by_user_id, retrieval_run_id, chunk_id, rank
      ) VALUES ($1, $2, $3, $4, 1)
    `, [workspaceA, userA, running, foreignChunk.rows[0].id]);
    await expect(crossScopeInsert).rejects.toMatchObject({ code: '23503' });
    await repository.failRetrievalRun(scopeA, running, 'unknown');
  });

  it('cascades chunks and their citations when an owned document is deleted', async () => {
    const target = await index(service, scopeA, 'beta delete cascade');
    const result = await service.retrieve(scopeA, 'beta deletion', { topK: 20, threshold: -1 });
    expect(result.citations.some((entry) => entry.documentId === target.documentId)).toBe(true);
    const chunk = await database.query<{ id: string }>('SELECT id FROM document_chunks WHERE document_id = $1', [target.documentId]);
    await service.deleteDocument(scopeA, target.documentId);
    const counts = await database.query<{ chunks: string; citations: string }>(`
      SELECT
        (SELECT count(*) FROM document_chunks WHERE document_id = $1)::text AS chunks,
        (SELECT count(*) FROM retrieval_citations WHERE chunk_id = $2)::text AS citations
    `, [target.documentId, chunk.rows[0].id]);
    expect(counts.rows[0]).toEqual({ chunks: '0', citations: '0' });
  });

  it('rechecks revoked sessions and removed memberships on every Product API RAG request', async () => {
    const authRepository = new PostgresAuthRepository(database);
    const auth = await AuthService.create(authRepository, passwordHasher(), { dummyPasswordHash: 'fake:dummy' });
    const tokenOne = `rag-session-${randomUUID()}`;
    const tokenTwo = `rag-session-${randomUUID()}`;
    const sessionOne = randomUUID();
    const sessionTwo = randomUUID();
    await database.query(`
      INSERT INTO auth_sessions (id, user_id, token_hash, expires_at)
      VALUES ($1, $2, $3, now() + interval '1 hour'), ($4, $2, $5, now() + interval '1 hour')
    `, [sessionOne, userA, hashSessionToken(tokenOne), sessionTwo, hashSessionToken(tokenTwo)]);
    const apiConfig: ProductApiConfig = {
      host: '127.0.0.1', port: 0, allowedHosts: new Set(),
      allowedOrigins: new Set(['http://127.0.0.1:5173']),
      cookieSecret: Buffer.alloc(32, 27), secureCookies: false,
      sessionTtlMs: 60_000, maxBodyBytes: 65_536,
    };
    const server = new ProductApiServer(auth, apiConfig, undefined, service);
    const port = await server.listen();
    const request = async (token: string) => {
      const csrf = createCsrfToken(token, apiConfig.cookieSecret);
      return fetch(`http://127.0.0.1:${port}/api/knowledge/query?workspace_id=${workspaceA}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'http://127.0.0.1:5173',
          Cookie: `${sessionCookieName}=${token}; ${csrfCookieName}=${csrf}`,
          'X-CSRF-Token': csrf,
          [PRODUCT_WORKSPACE_HEADER_NAME]: workspaceA,
        },
        body: JSON.stringify({ query: 'alpha auth boundary', topK: 2 }),
      });
    };
    try {
      expect((await request(tokenOne)).status).toBe(200);
      await database.query('UPDATE auth_sessions SET revoked_at = now() WHERE id = $1', [sessionOne]);
      expect((await request(tokenOne)).status).toBe(401);
      await database.query('DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [workspaceA, userA]);
      expect((await request(tokenTwo)).status).toBe(403);
    } finally {
      await server.close();
    }
  });
});
