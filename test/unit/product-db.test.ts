import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import {
  productDatabaseConfigFromEnv,
  productMigrationDatabaseConfigFromEnv,
} from '../../packages/product-db/src/config.js';
import { createProductDatabase } from '../../packages/product-db/src/database.js';
import {
  loadMigrations,
  migrateProductDatabase,
} from '../../packages/product-db/src/migrations.js';
import {
  assertProductDatabaseRoleContract,
  productDatabaseDeploymentProfileFromEnv,
} from '../../packages/product-db/src/privileges.js';

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
        PRODUCT_DB_CA_CERT: '-----BEGIN CERTIFICATE-----\\ntest-ca\\n-----END CERTIFICATE-----',
      }),
    ).toMatchObject({
      max: 4,
      ssl: {
        rejectUnauthorized: true,
        ca: '-----BEGIN CERTIFICATE-----\ntest-ca\n-----END CERTIFICATE-----\n',
      },
    });

    expect(() => productDatabaseConfigFromEnv({
      DATABASE_URL: 'postgresql://example.invalid/kodex',
      PRODUCT_DB_SSL: 'verify-full',
      PRODUCT_DB_CA_CERT: 'not-a-pem',
    })).toThrow('PRODUCT_DB_CA_CERT must contain a bounded PEM certificate chain');

    expect(() =>
      productDatabaseConfigFromEnv({
        DATABASE_URL: 'postgresql://example.invalid/kodex',
        PRODUCT_DB_POOL_MAX: 'zero',
      }),
    ).toThrow('PRODUCT_DB_POOL_MAX must be a positive integer');

    expect(() => productDatabaseConfigFromEnv({ DATABASE_URL: 'not-a-database-url' }))
      .toThrow('DATABASE_URL must be a valid PostgreSQL URL');
    expect(() => productDatabaseConfigFromEnv({ DATABASE_URL: 'https://example.com/kodex' }))
      .toThrow('DATABASE_URL must be a valid PostgreSQL URL');
  });

  it('keeps production migration credentials separate and acceptance loopback-only', () => {
    expect(productMigrationDatabaseConfigFromEnv({
      PRODUCT_DB_MIGRATION_URL: 'postgresql://kodex_migration:opaque@example.invalid/kodex',
    })?.application_name).toBe('kodex-product-migration');
    expect(productDatabaseDeploymentProfileFromEnv({ NODE_ENV: 'production' })).toBe('production');
    expect(() => productDatabaseDeploymentProfileFromEnv({
      NODE_ENV: 'production',
      KODEX_DEPLOYMENT_PROFILE: 'development',
    })).toThrow('production process');
    expect(() => productDatabaseDeploymentProfileFromEnv({
      KODEX_DEPLOYMENT_PROFILE: 'acceptance',
      KODEX_ACCEPTANCE_ALLOW_SINGLE_DB: '1',
      DATABASE_URL: 'postgresql://kodex:opaque@example.invalid/kodex',
    })).toThrow('loopback-only');
  });

  it('rejects broad production database roles without exposing their identity', async () => {
    const query = vi.fn(async () => ({ rows: [{
      currentUser: 'kodex_app',
      canSuperuser: true,
      canCreateRole: false,
      canCreateDatabase: false,
      canReplicate: false,
      canBypassRls: false,
      memberOfOwner: false,
      canCreateSchema: false,
    }] }));
    await expect(assertProductDatabaseRoleContract({ query } as unknown as Pick<Pool, 'query'>, 'application', 'kodex_app'))
      .rejects.toThrow('least-privilege contract');
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

    expect(applied.map((migration) => migration.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    expect(statements[0]).toBe('BEGIN');
    expect(statements).toContain('SET LOCAL search_path TO public, pg_catalog');
    expect(statements.some((statement) => statement.includes('CREATE EXTENSION IF NOT EXISTS vector'))).toBe(true);
    expect(statements.at(-1)).toBe('COMMIT');
    expect(release).toHaveBeenCalledOnce();
  });

  it('contains the phase-one tenant, history, audit, and RAG schema', async () => {
    const migrations = await loadMigrations();
    expect(migrations).toHaveLength(13);
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

    const authSql = migrations[1].sql;
    expect(migrations[1].version).toBe(2);
    expect(authSql).toContain('CREATE TABLE password_credentials (');
    expect(authSql).toContain("CHECK (password_hash ~ '^\\$argon2id\\$')");
    expect(authSql).toContain('email = lower(btrim(email))');
    expect(authSql).toContain('octet_length(token_hash) = 32');
    expect(authSql).not.toMatch(/plaintext_password|session_token\s+text/iu);

    const historySql = migrations[2].sql;
    expect(migrations[2].version).toBe(3);
    expect(historySql).toContain('projects_owner_external_key_uq');
    expect(historySql).toContain('agent_threads_owner_codex_id_uq');
    expect(historySql).toContain('created_by_user_id uuid REFERENCES users(id) ON DELETE RESTRICT');
    expect(historySql).toContain('source_sort_key text');
    expect(historySql).toContain('agent_events_owner_time_idx');

    const ragSql = migrations[3].sql;
    expect(migrations[3].version).toBe(4);
    expect(ragSql).toContain('knowledge_sources_user_scope_uq');
    expect(ragSql).toContain('documents_source_user_scope_fk');
    expect(ragSql).toContain('document_chunks_document_user_scope_fk');
    expect(ragSql).toContain('retrieval_citations_run_user_scope_fk');
    expect(ragSql).toContain('retrieval_citations_chunk_user_scope_fk');
    expect(ragSql).toContain('created_by_user_id');
    expect(ragSql).toContain('embedding_model, embedding_dimensions');

    const annSql = migrations[4].sql;
    expect(migrations[4].version).toBe(5);
    expect(migrations[4].checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(annSql).toContain('document_chunks_openai_small_1536_hnsw_cosine_idx');
    expect(annSql).toContain('USING hnsw ((embedding::vector(1536)) vector_cosine_ops)');
    expect(annSql).toContain("embedding_model = 'text-embedding-3-small'");
    expect(annSql).toContain('embedding_dimensions = 1536');
    expect(annSql).not.toMatch(/CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS/iu);

    const authLifecycleSql = migrations[5].sql;
    expect(migrations[5].version).toBe(6);
    expect(authLifecycleSql).toContain('CREATE TABLE auth_login_rate_limits (');
    expect(authLifecycleSql).toContain('octet_length(bucket_hash) = 32');
    expect(authLifecycleSql).not.toMatch(/\b(email|password|ip_address|user_agent|session_token)\s+(?:text|inet)/iu);

    const invitationSql = migrations[6].sql;
    expect(migrations[6].version).toBe(7);
    expect(invitationSql).toContain('CREATE TABLE workspace_invitations');
    expect(invitationSql).toContain('octet_length(token_hash) = 32');
    expect(invitationSql).toContain('workspace_invitations_unresolved_email_uq');
    expect(invitationSql).not.toContain('raw_token');

    const paginationSql = migrations[7].sql;
    expect(migrations[7].version).toBe(8);
    expect(paginationSql).toContain('workspace_members_workspace_joined_idx');
    expect(paginationSql).toContain('(workspace_id, joined_at, user_id)');
    expect(paginationSql).toContain('workspace_invitations_pending_created_idx');
    expect(paginationSql).toContain('(workspace_id, created_at, id)');

    const retentionSql = migrations[8].sql;
    expect(migrations[8].version).toBe(9);
    expect(retentionSql).toContain('auth_sessions_retention_terminal_idx');
    expect(retentionSql).toContain('COALESCE(revoked_at, expires_at)');
    expect(retentionSql).toContain('workspace_invitations_retention_terminal_idx');
    expect(retentionSql).not.toMatch(/DELETE\s+FROM/iu);

    const abuseLimitSql = migrations[9].sql;
    expect(migrations[9].version).toBe(10);
    expect(abuseLimitSql).toContain('CREATE TABLE product_abuse_rate_limits');
    expect(abuseLimitSql).toContain("action IN ('register', 'invitation_preview', 'invitation_accept')");
    expect(abuseLimitSql).toContain('octet_length(subject_hash) = 32');
    expect(abuseLimitSql).toContain('product_abuse_rate_limits_updated_idx');
    expect(abuseLimitSql).not.toMatch(/raw_email|raw_token|ip_address|session_id|user_id/iu);

    const passwordResetSql = migrations[10].sql;
    expect(migrations[10].version).toBe(11);
    expect(passwordResetSql).toContain('CREATE TABLE password_reset_requests');
    expect(passwordResetSql).toContain('token_hash bytea NOT NULL UNIQUE');
    expect(passwordResetSql).toContain('password_reset_requests_pending_user_uq');
    expect(passwordResetSql).toContain('password_reset_requests_retention_terminal_idx');
    const dataLifecycleSql = migrations[11].sql;
    expect(dataLifecycleSql).toContain('CREATE TABLE data_lifecycle_jobs');
    expect(dataLifecycleSql).toContain('CREATE TABLE data_legal_holds');
    expect(dataLifecycleSql).toContain('CREATE TABLE data_lifecycle_local_targets');
    expect(dataLifecycleSql).toContain('data_lifecycle_jobs_claim_idx');
    expect(passwordResetSql).toContain("'password_reset_request'");
    expect(passwordResetSql).toContain("'password_reset_complete'");
    expect(passwordResetSql).not.toMatch(/\b(raw_token|reset_url|email)\s+(?:text|bytea)/iu);
  });
});
