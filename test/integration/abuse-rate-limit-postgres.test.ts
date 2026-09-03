import { randomUUID } from 'node:crypto';
import {
  abuseRateLimitSubjectHash,
  loadMigrations,
  PostgresAbuseRateLimiter,
  PostgresRetentionRepository,
  requireProductDatabaseFromEnv,
  type AbuseRateLimitPolicies,
  type ProductDatabase,
} from '@kodex/product-db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const mode = process.env.ABUSE_RATE_LIMIT_MIGRATION_MODE === 'legacy-upgrade' ? 'legacy-upgrade' : 'fresh';
const secret = Buffer.alloc(32, 73);
const baseTime = new Date('2026-09-03T12:00:00.000Z');

function policies(maxAttempts = 3): AbuseRateLimitPolicies {
  const policy = { maxAttempts, windowMs: 60_000, blockMs: 30_000 };
  return { register: policy, invitation_preview: policy, invitation_accept: policy };
}

function registerSubjects(address: string, email: string) {
  return [{ kind: 'address' as const, value: address }, { kind: 'email' as const, value: email }];
}

function previewSubjects(address: string, token: string) {
  return [{ kind: 'address' as const, value: address }, { kind: 'token' as const, value: token }];
}

describe(`real PostgreSQL product abuse limiter (${mode})`, () => {
  let database: ProductDatabase;
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
        for (const migration of migrations.slice(0, 9)) {
          await client.query(migration.sql);
          await client.query(
            'INSERT INTO public.schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
            [migration.version, migration.name, migration.checksum],
          );
        }
      });
    }
    migratedVersions = (await database.migrate()).map((migration) => migration.version);
  });

  afterAll(async () => {
    await database?.close();
  });

  it('applies migration 0010 on fresh and immutable 0001-0009 ledgers with enforced checks', async () => {
    expect(migratedVersions).toEqual(mode === 'legacy-upgrade'
      ? [10]
      : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const ledger = await database.query<{ version: string }>('SELECT version FROM schema_migrations ORDER BY version');
    expect(ledger.rows.map((row) => Number(row.version))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const columns = await database.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'product_abuse_rate_limits'
       ORDER BY column_name`,
    );
    expect(columns.rows.map((row) => row.column_name)).toEqual([
      'action', 'attempt_count', 'blocked_until', 'subject_hash', 'subject_kind',
      'updated_at', 'window_started_at',
    ]);

    const invalidRows: Array<[string, unknown[]]> = [
      [
        `INSERT INTO product_abuse_rate_limits
           (action, subject_kind, subject_hash, window_started_at, attempt_count, updated_at)
         VALUES ('login', 'address', $1, $2, 1, $2)`,
        [Buffer.alloc(32, 1), baseTime],
      ],
      [
        `INSERT INTO product_abuse_rate_limits
           (action, subject_kind, subject_hash, window_started_at, attempt_count, updated_at)
         VALUES ('register', 'token', $1, $2, 1, $2)`,
        [Buffer.alloc(32, 2), baseTime],
      ],
      [
        `INSERT INTO product_abuse_rate_limits
           (action, subject_kind, subject_hash, window_started_at, attempt_count, updated_at)
         VALUES ('register', 'address', $1, $2, 1, $2)`,
        [Buffer.alloc(31, 3), baseTime],
      ],
      [
        `INSERT INTO product_abuse_rate_limits
           (action, subject_kind, subject_hash, window_started_at, attempt_count, updated_at)
         VALUES ('register', 'address', $1, $2, 101, $2)`,
        [Buffer.alloc(32, 4), baseTime],
      ],
    ];
    for (const [sql, values] of invalidRows) {
      await expect(database.query(sql, values)).rejects.toMatchObject({ code: '23514' });
    }
  });

  it('shares state across instances and isolates action-and-kind HMAC domains', async () => {
    const limiterA = new PostgresAbuseRateLimiter(database, secret, policies(2));
    const limiterB = new PostgresAbuseRateLimiter(database, secret, policies(2));
    const suffix = randomUUID();
    await expect(limiterA.consume('invitation_preview', previewSubjects('127.0.0.1', `token-${suffix}`), baseTime))
      .resolves.toEqual({ allowed: true });
    await expect(limiterB.consume('invitation_preview', previewSubjects('127.0.0.1', `token-${suffix}`), baseTime))
      .resolves.toEqual({ allowed: false, retryAfterSeconds: 30 });

    const same = `same-${suffix}`;
    const hashes = [
      abuseRateLimitSubjectHash(secret, 'register', 'address', same),
      abuseRateLimitSubjectHash(secret, 'invitation_preview', 'address', same),
      abuseRateLimitSubjectHash(secret, 'invitation_accept', 'address', same),
      abuseRateLimitSubjectHash(secret, 'invitation_accept', 'account', same),
      abuseRateLimitSubjectHash(secret, 'invitation_accept', 'token', same),
    ];
    expect(new Set(hashes.map((hash) => hash.toString('hex'))).size).toBe(hashes.length);

    const crossAddress = `cross-action-${suffix}`;
    const preview = previewSubjects(crossAddress, `cross-token-${suffix}`);
    expect((await limiterA.consume('invitation_preview', preview, baseTime)).allowed).toBe(true);
    expect((await limiterA.consume('invitation_preview', preview, baseTime)).allowed).toBe(false);
    expect((await limiterA.consume('register', registerSubjects(
      crossAddress, `cross-${suffix}@example.invalid`,
    ), baseTime)).allowed).toBe(true);
    expect((await limiterA.consume('invitation_accept', [
      { kind: 'account', value: same },
      { kind: 'address', value: crossAddress },
      { kind: 'token', value: same },
    ], baseTime)).allowed).toBe(true);
  });

  it('serializes concurrent threshold races and locks overlapping buckets without deadlock', async () => {
    const limiterA = new PostgresAbuseRateLimiter(database, secret, policies(5));
    const limiterB = new PostgresAbuseRateLimiter(database, secret, policies(5));
    const suffix = randomUUID();
    const subjects = previewSubjects(`address-${suffix}`, `token-${suffix}`);
    const results = await Promise.all(Array.from({ length: 12 }, (_, index) => (
      (index % 2 === 0 ? limiterA : limiterB).consume(
        'invitation_preview',
        index % 3 === 0 ? [...subjects].reverse() : subjects,
        baseTime,
      )
    )));
    expect(results.filter((result) => result.allowed)).toHaveLength(4);
    expect(results.filter((result) => !result.allowed)).toHaveLength(8);
    const hashes = subjects.map((subject) => abuseRateLimitSubjectHash(
      secret, 'invitation_preview', subject.kind, subject.value,
    ));
    const rows = await database.query<{ attempt_count: number; blocked_until: Date }>(
      `SELECT attempt_count, blocked_until FROM product_abuse_rate_limits
       WHERE action = 'invitation_preview' AND subject_hash = ANY($1::bytea[])
       ORDER BY subject_kind`,
      [hashes],
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows.every((row) => row.attempt_count === 5)).toBe(true);
    expect(rows.rows.every((row) => row.blocked_until.getTime() === baseTime.getTime() + 30_000)).toBe(true);
  });

  it('does not increment or extend active blocks and resets at exact block/window boundaries', async () => {
    const limiter = new PostgresAbuseRateLimiter(database, secret, policies(3));
    const suffix = randomUUID();
    const subjects = previewSubjects(`boundary-address-${suffix}`, `boundary-token-${suffix}`);
    expect((await limiter.consume('invitation_preview', subjects, baseTime)).allowed).toBe(true);
    expect((await limiter.consume('invitation_preview', subjects, baseTime)).allowed).toBe(true);
    expect(await limiter.consume('invitation_preview', subjects, baseTime)).toEqual({
      allowed: false, retryAfterSeconds: 30,
    });
    expect(await limiter.consume('invitation_preview', subjects, new Date(baseTime.getTime() + 10_000)))
      .toEqual({ allowed: false, retryAfterSeconds: 20 });
    const unseenToken = `unseen-while-blocked-${suffix}`;
    expect(await limiter.consume('invitation_preview', previewSubjects(
      subjects[0].value,
      unseenToken,
    ), new Date(baseTime.getTime() + 10_000))).toEqual({
      allowed: false, retryAfterSeconds: 20,
    });
    expect((await database.query(
      `SELECT 1 FROM product_abuse_rate_limits
       WHERE action = 'invitation_preview' AND subject_kind = 'token' AND subject_hash = $1`,
      [abuseRateLimitSubjectHash(secret, 'invitation_preview', 'token', unseenToken)],
    )).rowCount).toBe(0);
    const beforeBoundary = await database.query<{ attempt_count: number; blocked_until: Date; updated_at: Date }>(
      `SELECT attempt_count, blocked_until, updated_at FROM product_abuse_rate_limits
       WHERE action = 'invitation_preview' AND subject_kind = 'token' AND subject_hash = $1`,
      [abuseRateLimitSubjectHash(secret, 'invitation_preview', 'token', subjects[1].value)],
    );
    expect(beforeBoundary.rows[0]).toMatchObject({ attempt_count: 3 });
    expect(beforeBoundary.rows[0].blocked_until.getTime()).toBe(baseTime.getTime() + 30_000);
    expect(beforeBoundary.rows[0].updated_at.getTime()).toBe(baseTime.getTime());
    expect(await limiter.consume('invitation_preview', subjects, new Date(baseTime.getTime() + 30_000)))
      .toEqual({ allowed: true });

    const windowSubjects = previewSubjects(`window-address-${suffix}`, `window-token-${suffix}`);
    expect((await limiter.consume('invitation_preview', windowSubjects, baseTime)).allowed).toBe(true);
    expect((await limiter.consume('invitation_preview', windowSubjects, new Date(baseTime.getTime() + 59_999))).allowed).toBe(true);
    expect((await limiter.consume('invitation_preview', windowSubjects, new Date(baseTime.getTime() + 60_000))).allowed).toBe(true);
    const window = await database.query<{ attempt_count: number }>(
      `SELECT attempt_count FROM product_abuse_rate_limits
       WHERE action = 'invitation_preview' AND subject_kind = 'token' AND subject_hash = $1`,
      [abuseRateLimitSubjectHash(secret, 'invitation_preview', 'token', windowSubjects[1].value)],
    );
    expect(window.rows[0].attempt_count).toBe(1);
  });

  it('bounds successful registrations by address while atomically accounting each email bucket', async () => {
    const limiter = new PostgresAbuseRateLimiter(database, secret, policies(3));
    const suffix = randomUUID();
    const address = `register-address-${suffix}`;
    expect((await limiter.consume('register', registerSubjects(address, `one-${suffix}@example.invalid`), baseTime)).allowed).toBe(true);
    expect((await limiter.consume('register', registerSubjects(address, `two-${suffix}@example.invalid`), baseTime)).allowed).toBe(true);
    expect(await limiter.consume('register', registerSubjects(address, `three-${suffix}@example.invalid`), baseTime))
      .toEqual({ allowed: false, retryAfterSeconds: 30 });
    const rows = await database.query<{ attempt_count: number; subject_kind: string }>(
      `SELECT subject_kind, attempt_count FROM product_abuse_rate_limits
       WHERE action = 'register' AND (
         subject_hash = $1 OR subject_hash = ANY($2::bytea[])
       ) ORDER BY subject_kind, subject_hash`,
      [
        abuseRateLimitSubjectHash(secret, 'register', 'address', address),
        ['one', 'two', 'three'].map((label) => abuseRateLimitSubjectHash(
          secret, 'register', 'email', `${label}-${suffix}@example.invalid`,
        )),
      ],
    );
    expect(rows.rows.filter((row) => row.subject_kind === 'address')).toEqual([{ subject_kind: 'address', attempt_count: 3 }]);
    expect(rows.rows.filter((row) => row.subject_kind === 'email').map((row) => row.attempt_count)).toEqual([1, 1, 1]);
  });

  it('retention deletes stale buckets in bounded order, preserves active blocks, and uses the cleanup index', async () => {
    const repository = new PostgresRetentionRepository(database);
    const suffix = randomUUID();
    const hashes = [1, 2, 3].map((value) => abuseRateLimitSubjectHash(
      secret, 'register', 'address', `retention-${suffix}-${value}`,
    ));
    await database.query(
      `INSERT INTO product_abuse_rate_limits
         (action, subject_kind, subject_hash, window_started_at, attempt_count, blocked_until, updated_at) VALUES
       ('register', 'address', $1, '2026-01-01T00:00:00Z', 1, NULL, '2026-08-01T00:00:00Z'),
       ('register', 'address', $2, '2026-01-01T00:00:00Z', 1, NULL, '2026-08-02T00:00:00Z'),
       ('register', 'address', $3, '2026-01-01T00:00:00Z', 3, '2026-09-04T00:00:00Z', '2026-08-01T00:00:00Z')`,
      hashes,
    );
    const cutoff = new Date('2026-09-01T00:00:00.000Z');
    await expect(repository.deleteStaleAbuseRateLimitsBatch({ batchSize: 1, cutoff, referenceTime: baseTime }))
      .resolves.toBe(1);
    expect((await database.query(
      `SELECT subject_hash FROM product_abuse_rate_limits
       WHERE action = 'register' AND subject_hash = ANY($1::bytea[])`, [hashes],
    )).rows).toHaveLength(2);
    await expect(repository.deleteStaleAbuseRateLimitsBatch({ batchSize: 10, cutoff, referenceTime: baseTime }))
      .resolves.toBe(1);
    expect((await database.query(
      `SELECT subject_hash FROM product_abuse_rate_limits
       WHERE action = 'register' AND subject_hash = ANY($1::bytea[])`, [hashes],
    )).rows).toHaveLength(1);

    const plan = await database.transaction(async (client) => {
      await client.query('SET LOCAL enable_seqscan = off');
      return client.query<{ 'QUERY PLAN': unknown }>(
        `EXPLAIN (FORMAT JSON)
         SELECT action, subject_kind, subject_hash FROM product_abuse_rate_limits
         WHERE updated_at < $1 AND (blocked_until IS NULL OR blocked_until <= $2)
         ORDER BY updated_at, action, subject_kind, subject_hash
         LIMIT 10 FOR UPDATE SKIP LOCKED`,
        [cutoff, baseTime],
      );
    });
    expect(JSON.stringify(plan.rows[0]['QUERY PLAN'])).toContain('product_abuse_rate_limits_updated_idx');
  });
});
