import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { requireProductDatabaseFromEnv, type ProductDatabase } from '@kodex/product-db';

const requiredTables = [
  'agent_events',
  'agent_items',
  'agent_threads',
  'agent_turns',
  'approvals',
  'auth_sessions',
  'auth_login_rate_limits',
  'audit_logs',
  'document_chunks',
  'email_delivery_jobs',
  'email_verification_requests',
  'data_export_artifacts',
  'data_legal_holds',
  'data_lifecycle_jobs',
  'data_lifecycle_job_workspaces',
  'data_lifecycle_local_targets',
  'data_lifecycle_local_tenants',
  'documents',
  'knowledge_sources',
  'password_credentials',
  'password_reset_requests',
  'product_abuse_rate_limits',
  'projects',
  'retrieval_citations',
  'retrieval_runs',
  'schema_migrations',
  'tool_calls',
  'users',
  'workspace_members',
  'workspace_invitations',
  'workspaces',
];

interface HierarchyFixture {
  itemAId: string;
  itemBId: string;
  projectId: string;
  sourceInstance: string;
  threadAId: string;
  threadBId: string;
  toolCallAId: string;
  turnAId: string;
  turnBId: string;
  userId: string;
  workspaceId: string;
}

function postgresErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

async function expectPostgresError(
  client: PoolClient,
  sql: string,
  values: unknown[],
  expectedCode: string,
): Promise<void> {
  await client.query('SAVEPOINT expected_constraint_failure');
  let caught: unknown;
  try {
    await client.query(sql, values);
  } catch (error) {
    caught = error;
  }
  await client.query('ROLLBACK TO SAVEPOINT expected_constraint_failure');
  await client.query('RELEASE SAVEPOINT expected_constraint_failure');
  expect(postgresErrorCode(caught)).toBe(expectedCode);
}

async function withRollback(
  database: ProductDatabase,
  operation: (client: PoolClient) => Promise<void>,
): Promise<void> {
  const client = await database.pool.connect();
  await client.query('BEGIN');
  try {
    await operation(client);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

async function createHierarchyFixture(client: PoolClient): Promise<HierarchyFixture> {
  const fixture: HierarchyFixture = {
    userId: randomUUID(),
    workspaceId: randomUUID(),
    projectId: randomUUID(),
    threadAId: randomUUID(),
    threadBId: randomUUID(),
    turnAId: randomUUID(),
    turnBId: randomUUID(),
    itemAId: randomUUID(),
    itemBId: randomUUID(),
    toolCallAId: randomUUID(),
    sourceInstance: `history-worker:${randomUUID()}`,
  };
  const suffix = randomUUID();

  await client.query('INSERT INTO users (id, email) VALUES ($1, $2)', [
    fixture.userId,
    `db-test-${suffix}@example.invalid`,
  ]);
  await client.query(
    'INSERT INTO workspaces (id, slug, name, owner_user_id) VALUES ($1, $2, $3, $4)',
    [fixture.workspaceId, `db-test-${suffix}`, 'DB Test', fixture.userId],
  );
  await client.query(
    'INSERT INTO projects (id, workspace_id, created_by_user_id, name) VALUES ($1, $2, $3, $4)',
    [fixture.projectId, fixture.workspaceId, fixture.userId, 'DB Test Project'],
  );
  await client.query(
    `INSERT INTO agent_threads (id, workspace_id, project_id, codex_thread_id)
     VALUES ($1, $2, $3, $4), ($5, $2, $3, $6)`,
    [
      fixture.threadAId,
      fixture.workspaceId,
      fixture.projectId,
      `thread-a-${suffix}`,
      fixture.threadBId,
      `thread-b-${suffix}`,
    ],
  );
  await client.query(
    `INSERT INTO agent_turns (id, workspace_id, thread_id, ordinal)
     VALUES ($1, $2, $3, 0), ($4, $2, $5, 0)`,
    [
      fixture.turnAId,
      fixture.workspaceId,
      fixture.threadAId,
      fixture.turnBId,
      fixture.threadBId,
    ],
  );
  await client.query(
    `INSERT INTO agent_items (id, workspace_id, turn_id, sequence, item_type)
     VALUES ($1, $2, $3, 0, 'message'), ($4, $2, $5, 0, 'message')`,
    [
      fixture.itemAId,
      fixture.workspaceId,
      fixture.turnAId,
      fixture.itemBId,
      fixture.turnBId,
    ],
  );
  await client.query(
    `INSERT INTO tool_calls
       (id, workspace_id, thread_id, turn_id, item_id, codex_call_id, tool_name)
     VALUES ($1, $2, $3, $4, $5, $6, 'shell')`,
    [
      fixture.toolCallAId,
      fixture.workspaceId,
      fixture.threadAId,
      fixture.turnAId,
      fixture.itemAId,
      `call-a-${suffix}`,
    ],
  );

  return fixture;
}

describe('product database migrations', () => {
  let database: ProductDatabase;

  beforeAll(async () => {
    database = requireProductDatabaseFromEnv();
    await database.migrate();
  });

  afterAll(async () => {
    await database?.close();
  });

  it('installs pgvector and all product schema tables', async () => {
    const extension = await database.query<{ installed: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AS installed",
    );
    expect(extension.rows[0].installed).toBe(true);

    const tables = await database.query<{ table_name: string }>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = ANY($1::text[])
       ORDER BY table_name`,
      [requiredTables],
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual([...requiredTables].sort());
  });

  it('records the immutable migration checksum', async () => {
    const result = await database.query<{ checksum: string; version: string }>(
      'SELECT version, checksum FROM schema_migrations ORDER BY version',
    );
    expect(result.rows).toHaveLength(13);
    expect(result.rows[0]).toMatchObject({ version: '1' });
    expect(result.rows[1]).toMatchObject({ version: '2' });
    expect(result.rows[2]).toMatchObject({ version: '3' });
    expect(result.rows[3]).toMatchObject({ version: '4' });
    expect(result.rows[4]).toMatchObject({ version: '5' });
    expect(result.rows[5]).toMatchObject({ version: '6' });
    expect(result.rows[6]).toMatchObject({ version: '7' });
    expect(result.rows[7]).toMatchObject({ version: '8' });
    expect(result.rows[8]).toMatchObject({ version: '9' });
    expect(result.rows[9]).toMatchObject({ version: '10' });
    expect(result.rows[10]).toMatchObject({ version: '11' });
    expect(result.rows[11]).toMatchObject({ version: '12' });
    expect(result.rows[12]).toMatchObject({ version: '13' });
    expect(result.rows[0].checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(result.rows[4].checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(result.rows[5].checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(result.rows[6].checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(result.rows[7].checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(result.rows[8].checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(result.rows[9].checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(result.rows[10].checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(result.rows[11].checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(result.rows[12].checksum).toMatch(/^[a-f0-9]{64}$/);
  });

  it('is a no-op when migrations are run again', async () => {
    await expect(database.migrate()).resolves.toEqual([]);
  });

  it('rejects session hashes shorter than 32 bytes', async () => {
    await withRollback(database, async (client) => {
      const userId = randomUUID();
      await client.query('INSERT INTO users (id, email) VALUES ($1, $2)', [
        userId,
        `short-hash-${randomUUID()}@example.invalid`,
      ]);
      await expectPostgresError(
        client,
        `INSERT INTO auth_sessions (user_id, token_hash, expires_at)
         VALUES ($1, $2, now() + interval '1 hour')`,
        [userId, Buffer.alloc(31)],
        '23514',
      );
    });
  });

  it('rejects duplicate events within one worker process epoch', async () => {
    await withRollback(database, async (client) => {
      const fixture = await createHierarchyFixture(client);
      const values = [
        fixture.workspaceId,
        fixture.threadAId,
        fixture.turnAId,
        fixture.itemAId,
        fixture.sourceInstance,
        'event-1',
      ];
      const sql = `INSERT INTO agent_events
        (workspace_id, thread_id, turn_id, item_id, source_instance, source_event_id, event_type, occurred_at)
        VALUES ($1, $2, $3, $4, $5, $6, 'item.completed', now())`;
      await client.query(sql, values);
      await expectPostgresError(client, sql, values, '23505');
    });
  });

  it('enforces the thread, turn, item, tool, and nullable parent hierarchy', async () => {
    await withRollback(database, async (client) => {
      const fixture = await createHierarchyFixture(client);

      await expectPostgresError(
        client,
        `INSERT INTO agent_events
          (workspace_id, thread_id, turn_id, source_instance, source_event_id, event_type, occurred_at)
         VALUES ($1, $2, $3, $4, 'cross-thread', 'turn.completed', now())`,
        [
          fixture.workspaceId,
          fixture.threadBId,
          fixture.turnAId,
          fixture.sourceInstance,
        ],
        '23503',
      );
      await expectPostgresError(
        client,
        `INSERT INTO agent_events
          (workspace_id, thread_id, turn_id, item_id, source_instance, source_event_id, event_type, occurred_at)
         VALUES ($1, $2, $3, $4, $5, 'cross-item', 'item.completed', now())`,
        [
          fixture.workspaceId,
          fixture.threadAId,
          fixture.turnAId,
          fixture.itemBId,
          fixture.sourceInstance,
        ],
        '23503',
      );
      await expectPostgresError(
        client,
        `INSERT INTO agent_events
          (workspace_id, thread_id, item_id, source_instance, source_event_id, event_type, occurred_at)
         VALUES ($1, $2, $3, $4, 'item-without-turn', 'item.completed', now())`,
        [
          fixture.workspaceId,
          fixture.threadAId,
          fixture.itemAId,
          fixture.sourceInstance,
        ],
        '23514',
      );
      await expectPostgresError(
        client,
        `INSERT INTO tool_calls
          (workspace_id, thread_id, turn_id, item_id, codex_call_id, tool_name)
         VALUES ($1, $2, $3, $4, $5, 'shell')`,
        [
          fixture.workspaceId,
          fixture.threadAId,
          fixture.turnAId,
          fixture.itemBId,
          `cross-item-${randomUUID()}`,
        ],
        '23503',
      );

      await client.query(
        `INSERT INTO approvals
          (workspace_id, thread_id, codex_request_id, approval_type)
         VALUES ($1, $2, $3, 'thread')`,
        [fixture.workspaceId, fixture.threadBId, `thread-only-${randomUUID()}`],
      );
      await expectPostgresError(
        client,
        `INSERT INTO approvals
          (workspace_id, thread_id, turn_id, tool_call_id, codex_request_id, approval_type)
         VALUES ($1, $2, $3, $4, $5, 'tool')`,
        [
          fixture.workspaceId,
          fixture.threadBId,
          fixture.turnBId,
          fixture.toolCallAId,
          `cross-tool-${randomUUID()}`,
        ],
        '23503',
      );
      await expectPostgresError(
        client,
        `INSERT INTO approvals
          (workspace_id, thread_id, tool_call_id, codex_request_id, approval_type)
         VALUES ($1, $2, $3, $4, 'tool')`,
        [
          fixture.workspaceId,
          fixture.threadAId,
          fixture.toolCallAId,
          `tool-without-turn-${randomUUID()}`,
        ],
        '23514',
      );
      await expectPostgresError(
        client,
        `INSERT INTO retrieval_runs (workspace_id, created_by_user_id, thread_id, turn_id, query)
         VALUES ($1, $2, $3, $4, 'cross-thread retrieval')`,
        [fixture.workspaceId, fixture.userId, fixture.threadBId, fixture.turnAId],
        '23503',
      );
      await expectPostgresError(
        client,
        `INSERT INTO retrieval_runs (workspace_id, created_by_user_id, turn_id, query)
         VALUES ($1, $2, $3, 'turn without thread')`,
        [fixture.workspaceId, fixture.userId, fixture.turnAId],
        '23514',
      );
    });
  });

  it('rejects embeddings whose recorded dimension does not match the vector', async () => {
    await withRollback(database, async (client) => {
      const fixture = await createHierarchyFixture(client);
      const sourceId = randomUUID();
      const documentId = randomUUID();
      await client.query(
        `INSERT INTO knowledge_sources (id, workspace_id, created_by_user_id, project_id, source_type, name)
         VALUES ($1, $2, $3, $4, 'test', 'Test Source')`,
        [sourceId, fixture.workspaceId, fixture.userId, fixture.projectId],
      );
      await client.query(
        `INSERT INTO documents (id, workspace_id, created_by_user_id, source_id, source_document_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [documentId, fixture.workspaceId, fixture.userId, sourceId, `document-${randomUUID()}`],
      );
      await client.query(
        `INSERT INTO document_chunks
          (workspace_id, created_by_user_id, document_id, chunk_index, content, embedding, embedding_model, embedding_dimensions)
         VALUES ($1, $2, $3, 0, 'valid', '[1,2,3]', 'test-model', 3)`,
        [fixture.workspaceId, fixture.userId, documentId],
      );
      await expectPostgresError(
        client,
        `INSERT INTO document_chunks
          (workspace_id, created_by_user_id, document_id, chunk_index, content, embedding, embedding_model, embedding_dimensions)
         VALUES ($1, $2, $3, 1, 'invalid', '[1,2,3]', 'test-model', 2)`,
        [fixture.workspaceId, fixture.userId, documentId],
        '23514',
      );
    });
  });
});
