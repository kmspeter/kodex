import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { productDatabaseConfigFromEnv } from '../../packages/product-db/src/config.js';
import { createProductDatabase } from '../../packages/product-db/src/database.js';
import {
  loadMigrations,
  migrateProductDatabase,
} from '../../packages/product-db/src/migrations.js';

describe('product database configuration', () => {
  it('stays disabled when DATABASE_URL is absent', () => {
    expect(productDatabaseConfigFromEnv({})).toBeUndefined();
  });

  it('builds bounded pool defaults without connecting', () => {
    const config = productDatabaseConfigFromEnv({
      DATABASE_URL: 'postgresql://user:secret@127.0.0.1:5432/kodex',
    });

    expect(config).toMatchObject({
      application_name: 'kodex-product',
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
    expect(config?.ssl).toBeUndefined();
  });

  it('owns an idempotently closable lazy pool without requiring a server', async () => {
    const config = productDatabaseConfigFromEnv({
      DATABASE_URL: 'postgresql://user:secret@127.0.0.1:5432/kodex',
    });
    expect(config).toBeDefined();

    const database = createProductDatabase(config!);
    expect(database.closed).toBe(false);
    await database.close();
    await database.close();
    expect(database.closed).toBe(true);
    await expect(database.query('SELECT 1')).rejects.toThrow('Product database pool is closed');
  });

  it('validates explicit pool and TLS settings', () => {
    expect(
      productDatabaseConfigFromEnv({
        DATABASE_URL: 'postgresql://example.invalid/kodex',
        PRODUCT_DB_POOL_MAX: '4',
        PRODUCT_DB_SSL: 'verify-full',
      }),
    ).toMatchObject({ max: 4, ssl: { rejectUnauthorized: true } });

    expect(() =>
      productDatabaseConfigFromEnv({
        DATABASE_URL: 'postgresql://example.invalid/kodex',
        PRODUCT_DB_POOL_MAX: 'zero',
      }),
    ).toThrow('PRODUCT_DB_POOL_MAX must be a positive integer');
  });
});

describe('product database migration SQL', () => {
  it('applies pending SQL and its ledger in one transaction', async () => {
    const query = vi.fn(async (text: string) => {
      if (text.startsWith('SELECT version')) {
        return { rows: [] };
      }
      return { rows: [] };
    });
    const release = vi.fn();
    const pool = {
      connect: vi.fn(async () => ({ query, release })),
    } as unknown as Pool;

    const applied = await migrateProductDatabase(pool);
    const statements = query.mock.calls.map(([text]) => text);

    expect(applied.map((migration) => migration.version)).toEqual([1]);
    expect(statements[0]).toBe('BEGIN');
    expect(statements).toContain('SET LOCAL search_path TO public, pg_catalog');
    expect(statements.some((statement) => statement.includes('CREATE EXTENSION IF NOT EXISTS vector'))).toBe(true);
    expect(statements.at(-1)).toBe('COMMIT');
    expect(release).toHaveBeenCalledOnce();
  });

  it('contains the phase-one tenant, history, audit, and RAG schema', async () => {
    const migrations = await loadMigrations();
    expect(migrations).toHaveLength(1);
    expect(migrations[0].version).toBe(1);
    expect(migrations[0].checksum).toMatch(/^[a-f0-9]{64}$/);

    const sql = migrations[0].sql;
    const requiredTables = [
      'users',
      'auth_sessions',
      'workspaces',
      'workspace_members',
      'projects',
      'agent_threads',
      'agent_turns',
      'agent_items',
      'agent_events',
      'tool_calls',
      'approvals',
      'audit_logs',
      'knowledge_sources',
      'documents',
      'document_chunks',
      'retrieval_runs',
      'retrieval_citations',
    ];

    for (const table of requiredTables) {
      expect(sql).toContain(`CREATE TABLE ${table} (`);
    }

    const authSessionDefinition = /CREATE TABLE auth_sessions \(([\s\S]*?)\n\);/.exec(sql)?.[1];
    expect(authSessionDefinition).toContain('token_hash bytea NOT NULL UNIQUE');
    expect(authSessionDefinition).not.toMatch(/^\s*token\s/m);
    expect(sql).toContain('UNIQUE (workspace_id, source_instance, source_event_id)');
    expect(sql).toContain('UNIQUE (id, workspace_id, thread_id)');
    expect(sql).toContain('UNIQUE (id, workspace_id, turn_id)');
    expect(sql).toContain('FOREIGN KEY (item_id, workspace_id, turn_id)');
    expect(sql).toContain('FOREIGN KEY (tool_call_id, workspace_id, thread_id, turn_id)');
    expect(sql).toContain('CHECK (item_id IS NULL OR turn_id IS NOT NULL)');
    expect(sql).toContain('CHECK (tool_call_id IS NULL OR turn_id IS NOT NULL)');
    expect(sql).toContain('CHECK (turn_id IS NULL OR thread_id IS NOT NULL)');
    expect(sql).toContain('stable worker identity and process epoch');
    expect(sql).toContain('embedding vector,');
    expect(sql).not.toMatch(/embedding vector\(\d+\)/);
    expect(sql).toContain('embedding_dimensions = vector_dims(embedding)');
    expect(sql).toContain('never a replacement for or reader of CODEX_HOME SQLite');
  });
});
