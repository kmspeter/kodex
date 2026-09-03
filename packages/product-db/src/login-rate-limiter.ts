import type { ProductDatabase } from './database.js';

export interface LoginRateLimitPolicy {
  blockMs: number;
  maxAttempts: number;
  windowMs: number;
}

export interface LoginRateLimitResult {
  allowed: boolean;
  retryAfterSeconds?: number;
  succeeded?: boolean;
}

export interface LoginRateLimiter {
  run(
    bucketHashes: readonly Buffer[],
    resetOnSuccess: readonly Buffer[],
    now: Date,
    attempt: () => Promise<boolean>,
  ): Promise<LoginRateLimitResult>;
}

interface RateLimitRow {
  blocked_until: Date | null;
  failed_attempts: number;
  window_started_at: Date;
}

function validatePolicy(policy: LoginRateLimitPolicy): void {
  if (!Number.isSafeInteger(policy.maxAttempts) || policy.maxAttempts < 2 || policy.maxAttempts > 20) {
    throw new Error('Login rate limit attempts must be between 2 and 20');
  }
  if (!Number.isSafeInteger(policy.windowMs) || policy.windowMs < 60_000 || policy.windowMs > 3_600_000) {
    throw new Error('Login rate limit window must be between 60 and 3600 seconds');
  }
  if (!Number.isSafeInteger(policy.blockMs) || policy.blockMs < 30_000 || policy.blockMs > 86_400_000) {
    throw new Error('Login rate limit block must be between 30 and 86400 seconds');
  }
}

function normalizedBuckets(hashes: readonly Buffer[]): Buffer[] {
  const unique = new Map<string, Buffer>();
  for (const hash of hashes) {
    if (!Buffer.isBuffer(hash) || hash.length !== 32) {
      throw new Error('Login rate limit bucket hashes must be 32 bytes');
    }
    unique.set(hash.toString('hex'), hash);
  }
  if (unique.size === 0 || unique.size > 4) {
    throw new Error('Login rate limit requires between one and four buckets');
  }
  return [...unique.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, hash]) => hash);
}

export class PostgresLoginRateLimiter implements LoginRateLimiter {
  constructor(
    private readonly database: ProductDatabase,
    private readonly policy: LoginRateLimitPolicy,
  ) {
    validatePolicy(policy);
  }

  async run(
    bucketHashes: readonly Buffer[],
    resetOnSuccess: readonly Buffer[],
    now: Date,
    attempt: () => Promise<boolean>,
  ): Promise<LoginRateLimitResult> {
    const buckets = normalizedBuckets(bucketHashes);
    const reset = normalizedBuckets(resetOnSuccess);
    const resetKeys = new Set(reset.map((hash) => hash.toString('hex')));
    if (reset.some((hash) => !buckets.some((bucket) => bucket.equals(hash)))) {
      throw new Error('Login success reset buckets must be part of the guarded buckets');
    }
    if (!Number.isFinite(now.getTime())) throw new Error('Login rate limit clock returned an invalid date');

    return this.database.transaction(async (client) => {
      const staleBefore = new Date(
        now.getTime() - (Math.max(this.policy.windowMs, this.policy.blockMs) * 2),
      );
      await client.query(
        `WITH stale AS (
           SELECT bucket_hash
           FROM auth_login_rate_limits
           WHERE updated_at < $1
           ORDER BY updated_at, bucket_hash
           LIMIT 100
           FOR UPDATE SKIP LOCKED
         )
         DELETE FROM auth_login_rate_limits AS rate_limit
         USING stale
         WHERE rate_limit.bucket_hash = stale.bucket_hash`,
        [staleBefore],
      );
      const rows: Array<{ bucket: Buffer; state: RateLimitRow }> = [];
      for (const bucket of buckets) {
        await client.query(
          `INSERT INTO auth_login_rate_limits
             (bucket_hash, window_started_at, failed_attempts, blocked_until, updated_at)
           VALUES ($1, $2, 0, NULL, $2)
           ON CONFLICT (bucket_hash) DO NOTHING`,
          [bucket, now],
        );
        const result = await client.query<RateLimitRow>(
          `SELECT window_started_at, failed_attempts, blocked_until
           FROM auth_login_rate_limits
           WHERE bucket_hash = $1
           FOR UPDATE`,
          [bucket],
        );
        const state = result.rows[0];
        if (!state) throw new Error('Login rate limit bucket could not be locked');
        rows.push({ bucket, state });
      }

      let retryAfterMs = 0;
      for (const { bucket, state } of rows) {
        const blockedUntil = state.blocked_until?.getTime() ?? 0;
        if (blockedUntil > now.getTime()) {
          retryAfterMs = Math.max(retryAfterMs, blockedUntil - now.getTime());
          continue;
        }
        const blockExpired = state.blocked_until !== null;
        const windowExpired = now.getTime() - state.window_started_at.getTime() >= this.policy.windowMs;
        const clockRewound = now.getTime() < state.window_started_at.getTime();
        if (blockExpired || windowExpired || clockRewound) {
          state.failed_attempts = 0;
          state.window_started_at = now;
          state.blocked_until = null;
          await client.query(
            `UPDATE auth_login_rate_limits
             SET window_started_at = $2, failed_attempts = 0,
                 blocked_until = NULL, updated_at = $2
             WHERE bucket_hash = $1`,
            [bucket, now],
          );
        }
      }
      if (retryAfterMs > 0) {
        return {
          allowed: false,
          retryAfterSeconds: Math.max(1, Math.min(
            Math.ceil(retryAfterMs / 1_000),
            Math.ceil(this.policy.blockMs / 1_000),
          )),
        };
      }

      const succeeded = await attempt();
      if (succeeded) {
        for (const { bucket } of rows) {
          if (!resetKeys.has(bucket.toString('hex'))) continue;
          await client.query(
            `UPDATE auth_login_rate_limits
             SET window_started_at = $2, failed_attempts = 0,
                 blocked_until = NULL, updated_at = $2
             WHERE bucket_hash = $1`,
            [bucket, now],
          );
        }
        return { allowed: true, succeeded: true };
      }

      let newlyBlocked = false;
      const blockedUntil = new Date(now.getTime() + this.policy.blockMs);
      for (const { bucket, state } of rows) {
        const attempts = Math.min(this.policy.maxAttempts, state.failed_attempts + 1);
        const block = attempts >= this.policy.maxAttempts;
        newlyBlocked ||= block;
        await client.query(
          `UPDATE auth_login_rate_limits
           SET failed_attempts = $2,
               blocked_until = CASE WHEN $3::boolean THEN $4::timestamptz ELSE NULL END,
               updated_at = $5
           WHERE bucket_hash = $1`,
          [bucket, attempts, block, blockedUntil, now],
        );
      }
      return newlyBlocked
        ? { allowed: false, retryAfterSeconds: Math.ceil(this.policy.blockMs / 1_000) }
        : { allowed: true, succeeded: false };
    });
  }
}
