import { randomUUID } from 'node:crypto';
import {
  loadMigrations,
  PostgresRetentionRepository,
  requireProductDatabaseFromEnv,
  type ProductDatabase,
} from '@kodex/product-db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const mode = process.env.RETENTION_MIGRATION_MODE === 'legacy-upgrade' ? 'legacy-upgrade' : 'fresh';
const referenceTime = new Date('2026-09-03T12:00:00.000Z');
const cutoff = new Date('2026-08-04T12:00:00.000Z');
const prefix = `retention-it-${randomUUID()}`;

interface ScopeFixture {
  userId: string;
  workspaceId: string;
}

async function createScope(database: ProductDatabase, label: string): Promise<ScopeFixture> {
  const userId = randomUUID();
  const workspaceId = randomUUID();
  await database.query('INSERT INTO users (id, email) VALUES ($1, $2)', [
    userId,
    `${prefix}-${label}@example.invalid`,
  ]);
  await database.query(
    'INSERT INTO workspaces (id, slug, name, owner_user_id) VALUES ($1, $2, $3, $4)',
    [workspaceId, `${prefix}-${label}`, `Retention ${label}`, userId],
  );
  await database.query(
    'INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3)',
    [workspaceId, userId, 'owner'],
  );
  return { userId, workspaceId };
}

function hashByte(value: number): Buffer {
  return Buffer.alloc(32, value);
}

describe(`real PostgreSQL terminal row retention (${mode})`, () => {
  let database: ProductDatabase;
  let repository: PostgresRetentionRepository;
  let migratedVersions: number[];

  beforeAll(async () => {
    database = requireProductDatabaseFromEnv();
    if (mode === 'legacy-upgrade') {
      const migrations = await loadMigrations();
      await database.transaction(async (client) => {
        await client.query(`CREATE TABLE public.schema_migrations (
          version bigint PRIMARY KEY, name text NOT NULL, checksum text NOT NULL,
          applied_at timestamptz NOT NULL DEFAULT now()
        )`);
        for (const migration of migrations.slice(0, 8)) {
          await client.query(migration.sql);
          await client.query(
            'INSERT INTO public.schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
            [migration.version, migration.name, migration.checksum],
          );
        }
      });
    }
    migratedVersions = (await database.migrate()).map((migration) => migration.version);
    repository = new PostgresRetentionRepository(database);
  });

  afterAll(async () => {
    await database?.close();
  });

  it('applies immutable migrations through 0013 for fresh and 0001-0008 upgrade databases', async () => {
    expect(migratedVersions).toEqual(mode === 'legacy-upgrade' ? [9, 10, 11, 12, 13] : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    const ledger = await database.query<{ version: string }>('SELECT version FROM schema_migrations ORDER BY version');
    expect(ledger.rows.map((row) => Number(row.version))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    const indexes = await database.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = 'public' AND indexname LIKE '%_retention_terminal_idx'
       ORDER BY indexname`,
    );
    expect(indexes.rows.map((row) => row.indexname)).toEqual([
      'auth_sessions_retention_terminal_idx',
      'email_delivery_jobs_retention_terminal_idx',
      'email_verification_requests_retention_terminal_idx',
      'password_reset_requests_retention_terminal_idx',
      'workspace_invitations_retention_terminal_idx',
    ]);
  });

  it('deletes only rows strictly beyond each terminal cutoff and is repeatable', async () => {
    const { userId, workspaceId } = await createScope(database, 'boundaries');
    const sessionIds = Array.from({ length: 6 }, () => randomUUID());
    await database.query(
      `INSERT INTO auth_sessions (id, user_id, token_hash, created_at, expires_at, revoked_at) VALUES
       ($1, $7, $8,  '2026-01-01T00:00:00Z', '2026-08-04T11:59:59.999Z', NULL),
       ($2, $7, $9,  '2026-01-01T00:00:00Z', '2026-08-04T12:00:00.000Z', NULL),
       ($3, $7, $10, '2026-01-01T00:00:00Z', '2026-09-04T12:00:00.000Z', NULL),
       ($4, $7, $11, '2026-01-01T00:00:00Z', '2026-09-04T12:00:00.000Z', '2026-08-04T11:59:59.999Z'),
       ($5, $7, $12, '2026-01-01T00:00:00Z', '2026-09-04T12:00:00.000Z', '2026-08-04T12:00:00.000Z'),
       ($6, $7, $13, '2026-01-01T00:00:00Z', '2026-09-04T12:00:00.000Z', '2026-09-03T11:00:00.000Z')`,
      [...sessionIds, userId, ...[1, 2, 3, 4, 5, 6].map(hashByte)],
    );

    const invitationIds = Array.from({ length: 7 }, () => randomUUID());
    const invitationValues: unknown[] = [];
    for (let index = 0; index < invitationIds.length; index += 1) {
      invitationValues.push(
        invitationIds[index], workspaceId, `${prefix}-boundary-${index}@example.invalid`, hashByte(20 + index),
      );
    }
    await database.query(
      `INSERT INTO workspace_invitations
         (id, workspace_id, target_email, requested_role, token_hash, created_at, expires_at, accepted_at, revoked_at)
       VALUES
       ($1,  $2,  $3,  'member', $4,  '2026-01-01T00:00:00Z', '2026-09-10T00:00:00Z', '2026-08-04T11:59:59.999Z', NULL),
       ($5,  $6,  $7,  'member', $8,  '2026-01-01T00:00:00Z', '2026-09-10T00:00:00Z', NULL, '2026-08-04T11:59:59.999Z'),
       ($9,  $10, $11, 'member', $12, '2026-01-01T00:00:00Z', '2026-08-04T11:59:59.999Z', NULL, NULL),
       ($13, $14, $15, 'member', $16, '2026-01-01T00:00:00Z', '2026-09-10T00:00:00Z', '2026-08-04T12:00:00.000Z', NULL),
       ($17, $18, $19, 'member', $20, '2026-01-01T00:00:00Z', '2026-09-10T00:00:00Z', NULL, '2026-08-04T12:00:00.000Z'),
       ($21, $22, $23, 'member', $24, '2026-01-01T00:00:00Z', '2026-08-04T12:00:00.000Z', NULL, NULL),
       ($25, $26, $27, 'member', $28, '2026-01-01T00:00:00Z', '2026-09-10T00:00:00Z', NULL, NULL)`,
      invitationValues,
    );

    await database.query(
      `INSERT INTO auth_login_rate_limits
         (bucket_hash, window_started_at, failed_attempts, blocked_until, updated_at) VALUES
       ($1, '2026-01-01T00:00:00Z', 1, NULL, '2026-08-04T11:59:59.999Z'),
       ($2, '2026-01-01T00:00:00Z', 1, NULL, '2026-08-04T12:00:00.000Z'),
       ($3, '2026-09-03T00:00:00Z', 1, NULL, '2026-09-03T11:00:00.000Z'),
       ($4, '2026-01-01T00:00:00Z', 5, '2026-09-03T13:00:00.000Z', '2026-08-04T11:59:59.999Z')`,
      [40, 41, 42, 43].map(hashByte),
    );
    const resetIds = Array.from({ length: 5 }, () => randomUUID());
    await database.query(
      `INSERT INTO password_reset_requests
         (id, user_id, token_hash, created_at, expires_at, consumed_at, revoked_at) VALUES
       ($1, $6, $7,  '2026-01-01T00:00:00Z', '2026-09-10T00:00:00Z', '2026-08-04T11:59:59.999Z', NULL),
       ($2, $6, $8,  '2026-01-01T00:00:00Z', '2026-09-10T00:00:00Z', NULL, '2026-08-04T11:59:59.999Z'),
       ($3, $6, $9,  '2026-01-01T00:00:00Z', '2026-08-04T11:59:59.999Z', NULL, NULL),
       ($4, $6, $10, '2026-01-01T00:00:00Z', '2026-09-10T00:00:00Z', '2026-08-04T12:00:00.000Z', NULL),
       ($5, $6, $11, '2026-01-01T00:00:00Z', '2026-09-10T00:00:00Z', NULL, '2026-09-03T11:00:00.000Z')`,
      [...resetIds, userId, ...[120, 121, 122, 123, 124].map(hashByte)],
    );
    const verificationIds = Array.from({ length: 4 }, () => randomUUID());
    await database.query(
      `INSERT INTO email_verification_requests
         (id, user_id, token_hash, created_at, expires_at, consumed_at, revoked_at) VALUES
       ($1, $5, $6, '2026-01-01T00:00:00Z', '2026-09-10T00:00:00Z', '2026-08-04T11:59:59.999Z', NULL),
       ($2, $5, $7, '2026-01-01T00:00:00Z', '2026-09-10T00:00:00Z', NULL, '2026-08-04T11:59:59.999Z'),
       ($3, $5, $8, '2026-01-01T00:00:00Z', '2026-09-10T00:00:00Z', '2026-08-04T12:00:00.000Z', NULL),
       ($4, $5, $9, '2026-01-01T00:00:00Z', '2026-09-10T00:00:00Z', NULL, NULL)`,
      [...verificationIds, userId, ...[130, 131, 132, 133].map(hashByte)],
    );
    const deliveryIds = Array.from({ length: 4 }, () => randomUUID());
    await database.query(
      `INSERT INTO email_delivery_jobs
         (id, kind, user_id, status, attempt_count, created_at, updated_at, completed_at) VALUES
       ($1, 'email_verification', $5, 'delivered', 1, '2026-01-01T00:00:00Z', '2026-08-04T11:59:59.999Z', '2026-08-04T11:59:59.999Z'),
       ($2, 'email_verification', $5, 'failed', 4, '2026-01-01T00:00:00Z', '2026-08-04T12:00:00.000Z', '2026-08-04T12:00:00.000Z'),
       ($3, 'email_verification', $5, 'cancelled', 0, '2026-01-01T00:00:00Z', '2026-09-03T11:00:00.000Z', '2026-09-03T11:00:00.000Z'),
       ($4, 'email_verification', $5, 'pending', 0, '2026-09-03T11:00:00.000Z', '2026-09-03T11:00:00.000Z', NULL)`,
      [...deliveryIds, userId],
    );
    await database.query(
      `INSERT INTO audit_logs (workspace_id, actor_user_id, action)
       VALUES ($1, $2, 'retention.boundary_fixture')`,
      [workspaceId, userId],
    );

    await expect(repository.deleteTerminalSessionsBatch({ batchSize: 100, cutoff })).resolves.toBe(2);
    await expect(repository.deleteTerminalInvitationsBatch({ batchSize: 100, cutoff })).resolves.toBe(3);
    await expect(repository.deleteTerminalPasswordResetsBatch({ batchSize: 100, cutoff })).resolves.toBe(3);
    await expect(repository.deleteTerminalEmailVerificationsBatch({ batchSize: 100, cutoff })).resolves.toBe(2);
    await expect(repository.deleteTerminalEmailDeliveriesBatch({ batchSize: 100, cutoff })).resolves.toBe(1);
    await expect(repository.deleteStaleLoginRateLimitsBatch({
      batchSize: 100,
      cutoff,
      referenceTime,
    })).resolves.toBe(1);

    const sessions = await database.query<{ id: string }>(
      'SELECT id FROM auth_sessions WHERE user_id = $1 ORDER BY id', [userId],
    );
    expect(sessions.rows.map((row) => row.id).sort()).toEqual(sessionIds.slice(1, 3).concat(sessionIds.slice(4)).sort());
    const invitations = await database.query<{ id: string }>(
      'SELECT id FROM workspace_invitations WHERE workspace_id = $1 ORDER BY id', [workspaceId],
    );
    expect(invitations.rows.map((row) => row.id).sort()).toEqual(invitationIds.slice(3).sort());
    const resets = await database.query<{ id: string }>(
      'SELECT id FROM password_reset_requests WHERE user_id = $1 ORDER BY id', [userId],
    );
    expect(resets.rows.map((row) => row.id).sort()).toEqual(resetIds.slice(3).sort());
    const verifications = await database.query<{ id: string }>(
      'SELECT id FROM email_verification_requests WHERE user_id = $1 ORDER BY id', [userId],
    );
    expect(verifications.rows.map((row) => row.id).sort()).toEqual(verificationIds.slice(2).sort());
    const deliveries = await database.query<{ id: string }>(
      'SELECT id FROM email_delivery_jobs WHERE user_id = $1 ORDER BY id', [userId],
    );
    expect(deliveries.rows.map((row) => row.id).sort()).toEqual(deliveryIds.slice(1).sort());
    expect((await database.query('SELECT 1 FROM users WHERE id = $1', [userId])).rowCount).toBe(1);
    expect((await database.query(
      `SELECT 1 FROM audit_logs WHERE workspace_id = $1 AND action = 'retention.boundary_fixture'`,
      [workspaceId],
    )).rowCount).toBe(1);
    await expect(repository.deleteTerminalSessionsBatch({ batchSize: 100, cutoff })).resolves.toBe(0);
    await expect(repository.deleteTerminalInvitationsBatch({ batchSize: 100, cutoff })).resolves.toBe(0);
    await expect(repository.deleteTerminalPasswordResetsBatch({ batchSize: 100, cutoff })).resolves.toBe(0);
    await expect(repository.deleteTerminalEmailVerificationsBatch({ batchSize: 100, cutoff })).resolves.toBe(0);
    await expect(repository.deleteTerminalEmailDeliveriesBatch({ batchSize: 100, cutoff })).resolves.toBe(0);
    await expect(repository.deleteStaleLoginRateLimitsBatch({ batchSize: 100, cutoff, referenceTime })).resolves.toBe(0);
  });

  it('enforces the batch cap and deterministic oldest-first order', async () => {
    const { userId } = await createScope(database, 'batch-cap');
    const ids = Array.from({ length: 7 }, () => randomUUID());
    for (let index = 0; index < ids.length; index += 1) {
      await database.query(
        `INSERT INTO auth_sessions (id, user_id, token_hash, created_at, expires_at)
         VALUES ($1, $2, $3, '2026-01-01T00:00:00Z', $4)`,
        [ids[index], userId, hashByte(60 + index), new Date(cutoff.getTime() - (ids.length - index) * 1_000)],
      );
    }
    await expect(repository.deleteTerminalSessionsBatch({ batchSize: 3, cutoff })).resolves.toBe(3);
    const remaining = await database.query<{ id: string }>(
      'SELECT id FROM auth_sessions WHERE user_id = $1 ORDER BY expires_at, id', [userId],
    );
    expect(remaining.rows.map((row) => row.id)).toEqual(ids.slice(3));
    await expect(repository.deleteTerminalSessionsBatch({ batchSize: 3, cutoff })).resolves.toBe(3);
    await expect(repository.deleteTerminalSessionsBatch({ batchSize: 3, cutoff })).resolves.toBe(1);
    await expect(repository.deleteTerminalSessionsBatch({ batchSize: 3, cutoff })).resolves.toBe(0);
  });

  it('lets concurrent sweepers share work without duplicate deletion counts', async () => {
    const { userId } = await createScope(database, 'concurrent');
    for (let index = 0; index < 20; index += 1) {
      await database.query(
        `INSERT INTO auth_sessions (user_id, token_hash, created_at, expires_at)
         VALUES ($1, $2, '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z')`,
        [userId, hashByte(80 + index)],
      );
    }
    const secondRepository = new PostgresRetentionRepository(database);
    const counts = await Promise.all([
      repository.deleteTerminalSessionsBatch({ batchSize: 12, cutoff }),
      secondRepository.deleteTerminalSessionsBatch({ batchSize: 12, cutoff }),
    ]);
    expect(counts[0] + counts[1]).toBe(20);
    expect((await database.query('SELECT 1 FROM auth_sessions WHERE user_id = $1', [userId])).rowCount).toBe(0);
  });

  it('rolls a failed delete statement back without reporting a count', async () => {
    const { userId } = await createScope(database, 'rollback');
    await database.query(
      `INSERT INTO auth_sessions (user_id, token_hash, created_at, expires_at)
       VALUES ($1, $2, '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z')`,
      [userId, hashByte(110)],
    );
    await database.query(`CREATE FUNCTION retention_test_reject_delete() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'retention test rejection'; END $$`);
    await database.query(`CREATE TRIGGER retention_test_reject_delete
      BEFORE DELETE ON auth_sessions FOR EACH STATEMENT EXECUTE FUNCTION retention_test_reject_delete()`);
    try {
      await expect(repository.deleteTerminalSessionsBatch({ batchSize: 10, cutoff })).rejects.toBeDefined();
      expect((await database.query('SELECT 1 FROM auth_sessions WHERE user_id = $1', [userId])).rowCount).toBe(1);
    } finally {
      await database.query('DROP TRIGGER retention_test_reject_delete ON auth_sessions');
      await database.query('DROP FUNCTION retention_test_reject_delete()');
    }
  });

  it('uses the retention indexes for the exact bounded candidate scans', async () => {
    const plans = await database.transaction(async (client) => {
      await client.query('SET LOCAL enable_seqscan = off');
      const sessions = await client.query<{ 'QUERY PLAN': unknown }>(
        `EXPLAIN (FORMAT JSON)
         SELECT id FROM auth_sessions
         WHERE COALESCE(revoked_at, expires_at) < $1
         ORDER BY COALESCE(revoked_at, expires_at), id
         LIMIT 10 FOR UPDATE SKIP LOCKED`,
        [cutoff],
      );
      const invitations = await client.query<{ 'QUERY PLAN': unknown }>(
        `EXPLAIN (FORMAT JSON)
         SELECT id FROM workspace_invitations
         WHERE COALESCE(accepted_at, revoked_at, expires_at) < $1
         ORDER BY COALESCE(accepted_at, revoked_at, expires_at), id
         LIMIT 10 FOR UPDATE SKIP LOCKED`,
        [cutoff],
      );
      const resets = await client.query<{ 'QUERY PLAN': unknown }>(
        `EXPLAIN (FORMAT JSON)
         SELECT id FROM password_reset_requests
         WHERE COALESCE(consumed_at, revoked_at, expires_at) < $1
         ORDER BY COALESCE(consumed_at, revoked_at, expires_at), id
         LIMIT 10 FOR UPDATE SKIP LOCKED`,
        [cutoff],
      );
      const verifications = await client.query<{ 'QUERY PLAN': unknown }>(
        `EXPLAIN (FORMAT JSON)
         SELECT id FROM email_verification_requests
         WHERE COALESCE(consumed_at, revoked_at, expires_at) < $1
         ORDER BY COALESCE(consumed_at, revoked_at, expires_at), id
         LIMIT 10 FOR UPDATE SKIP LOCKED`,
        [cutoff],
      );
      const deliveries = await client.query<{ 'QUERY PLAN': unknown }>(
        `EXPLAIN (FORMAT JSON)
         SELECT id FROM email_delivery_jobs
         WHERE completed_at < $1 AND status IN ('delivered', 'failed', 'cancelled')
         ORDER BY completed_at, id
         LIMIT 10 FOR UPDATE SKIP LOCKED`,
        [cutoff],
      );
      return [
        sessions.rows[0]['QUERY PLAN'],
        invitations.rows[0]['QUERY PLAN'],
        resets.rows[0]['QUERY PLAN'],
        verifications.rows[0]['QUERY PLAN'],
        deliveries.rows[0]['QUERY PLAN'],
      ];
    });
    expect(JSON.stringify(plans[0])).toContain('auth_sessions_retention_terminal_idx');
    expect(JSON.stringify(plans[1])).toContain('workspace_invitations_retention_terminal_idx');
    expect(JSON.stringify(plans[2])).toContain('password_reset_requests_retention_terminal_idx');
    expect(JSON.stringify(plans[3])).toContain('email_verification_requests_retention_terminal_idx');
    expect(JSON.stringify(plans[4])).toContain('email_delivery_jobs_retention_terminal_idx');
  });
});
