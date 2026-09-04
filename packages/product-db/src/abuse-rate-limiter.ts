import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';
import type { ProductDatabase } from './database.js';

export type AbuseRateLimitAction =
  | 'register'
  | 'invitation_preview'
  | 'invitation_accept'
  | 'password_reset_request'
  | 'password_reset_complete';
export type AbuseRateLimitSubjectKind = 'account' | 'address' | 'email' | 'token';

export interface AbuseRateLimitPolicy {
  blockMs: number;
  maxAttempts: number;
  windowMs: number;
}

export type AbuseRateLimitPolicies = Readonly<Record<AbuseRateLimitAction, AbuseRateLimitPolicy>>;

export interface AbuseRateLimitSubject {
  kind: AbuseRateLimitSubjectKind;
  value: string;
}

export interface AbuseRateLimitResult {
  allowed: boolean;
  retryAfterSeconds?: number;
}

export class ProductAbuseRateLimitError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super('rate_limited');
    this.name = 'ProductAbuseRateLimitError';
  }
}

export interface AbuseRateLimiter {
  consume(
    action: AbuseRateLimitAction,
    subjects: readonly AbuseRateLimitSubject[],
    now: Date,
  ): Promise<AbuseRateLimitResult>;
}

interface RateLimitRow {
  attempt_count: number;
  blocked_until: Date | null;
  window_started_at: Date;
}

interface Bucket {
  action: AbuseRateLimitAction;
  hash: Buffer;
  kind: AbuseRateLimitSubjectKind;
  key: string;
}

class ActiveAbuseRateLimitBlock {
  constructor(readonly retryAfterSeconds: number) {}
}

const ACTION_SUBJECTS: Readonly<Record<AbuseRateLimitAction, readonly AbuseRateLimitSubjectKind[]>> = {
  register: ['address', 'email'],
  invitation_preview: ['address', 'token'],
  invitation_accept: ['account', 'address', 'token'],
  password_reset_request: ['address', 'email'],
  password_reset_complete: ['address', 'token'],
};

function validatePolicy(action: AbuseRateLimitAction, policy: AbuseRateLimitPolicy): void {
  if (!Number.isSafeInteger(policy.maxAttempts) || policy.maxAttempts < 2 || policy.maxAttempts > 100) {
    throw new Error(`${action} abuse rate limit attempts must be between 2 and 100`);
  }
  if (!Number.isSafeInteger(policy.windowMs) || policy.windowMs < 60_000 || policy.windowMs > 86_400_000) {
    throw new Error(`${action} abuse rate limit window must be between 60 and 86400 seconds`);
  }
  if (!Number.isSafeInteger(policy.blockMs) || policy.blockMs < 30_000 || policy.blockMs > 86_400_000) {
    throw new Error(`${action} abuse rate limit block must be between 30 and 86400 seconds`);
  }
}

export function normalizeDirectAddress(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized.length < 1 || normalized.length > 128) {
    throw new Error('Direct socket address must contain between 1 and 128 characters');
  }
  const mappedIpv4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/u.exec(normalized)?.[1];
  if (mappedIpv4 && isIP(mappedIpv4) === 4) return mappedIpv4;
  return normalized;
}

export function abuseRateLimitSubjectHash(
  secret: Buffer,
  action: AbuseRateLimitAction,
  kind: AbuseRateLimitSubjectKind,
  value: string,
): Buffer {
  if (!Buffer.isBuffer(secret) || secret.length < 32) {
    throw new Error('Abuse rate limit secret must contain at least 32 bytes');
  }
  if (!ACTION_SUBJECTS[action]?.includes(kind)) {
    throw new Error('Abuse rate limit action and subject kind are incompatible');
  }
  if (typeof value !== 'string' || value.length < 1 || value.length > 512) {
    throw new Error('Abuse rate limit subject must contain between 1 and 512 characters');
  }
  return createHmac('sha256', secret)
    .update('kodex-product-abuse-rate-limit-v1\0', 'utf8')
    .update(action, 'utf8')
    .update('\0', 'utf8')
    .update(kind, 'utf8')
    .update('\0', 'utf8')
    .update(value, 'utf8')
    .digest();
}

function bucketsFor(
  secret: Buffer,
  action: AbuseRateLimitAction,
  subjects: readonly AbuseRateLimitSubject[],
): Bucket[] {
  const expectedKinds = ACTION_SUBJECTS[action];
  if (!expectedKinds || subjects.length !== expectedKinds.length) {
    throw new Error('Abuse rate limit subjects do not match the action policy');
  }
  const byKind = new Map<AbuseRateLimitSubjectKind, AbuseRateLimitSubject>();
  for (const subject of subjects) {
    if (!expectedKinds.includes(subject.kind) || byKind.has(subject.kind)) {
      throw new Error('Abuse rate limit subjects do not match the action policy');
    }
    byKind.set(subject.kind, subject);
  }
  if (byKind.size !== expectedKinds.length) {
    throw new Error('Abuse rate limit subjects do not match the action policy');
  }
  return expectedKinds.map((kind) => {
    const subject = byKind.get(kind);
    if (!subject) throw new Error('Abuse rate limit subject is missing');
    const hash = abuseRateLimitSubjectHash(secret, action, kind, subject.value);
    return { action, kind, hash, key: `${action}\0${kind}\0${hash.toString('hex')}` };
  }).sort((left, right) => left.key.localeCompare(right.key));
}

export class PostgresAbuseRateLimiter implements AbuseRateLimiter {
  readonly #secret: Buffer;

  constructor(
    private readonly database: ProductDatabase,
    secret: Buffer,
    private readonly policies: AbuseRateLimitPolicies,
  ) {
    if (!Buffer.isBuffer(secret) || secret.length < 32) {
      throw new Error('Abuse rate limit secret must contain at least 32 bytes');
    }
    this.#secret = Buffer.from(secret);
    for (const action of Object.keys(ACTION_SUBJECTS) as AbuseRateLimitAction[]) {
      validatePolicy(action, policies[action]);
    }
  }

  async consume(
    action: AbuseRateLimitAction,
    subjects: readonly AbuseRateLimitSubject[],
    now: Date,
  ): Promise<AbuseRateLimitResult> {
    if (!Number.isFinite(now.getTime())) throw new Error('Abuse rate limit clock returned an invalid date');
    const policy = this.policies[action];
    validatePolicy(action, policy);
    const buckets = bucketsFor(this.#secret, action, subjects);

    try {
      return await this.database.transaction(async (client) => {
        const rows: Array<{ bucket: Bucket; state: RateLimitRow }> = [];
        for (const bucket of buckets) {
          await client.query(
            `INSERT INTO product_abuse_rate_limits
               (action, subject_kind, subject_hash, window_started_at, attempt_count, blocked_until, updated_at)
             VALUES ($1, $2, $3, $4, 0, NULL, $4)
             ON CONFLICT (action, subject_kind, subject_hash) DO NOTHING`,
            [bucket.action, bucket.kind, bucket.hash, now],
          );
          const result = await client.query<RateLimitRow>(
            `SELECT window_started_at, attempt_count, blocked_until
             FROM product_abuse_rate_limits
             WHERE action = $1 AND subject_kind = $2 AND subject_hash = $3
             FOR UPDATE`,
            [bucket.action, bucket.kind, bucket.hash],
          );
          const state = result.rows[0];
          if (!state) throw new Error('Abuse rate limit bucket could not be locked');
          rows.push({ bucket, state });
        }

        let retryAfterMs = 0;
        for (const { state } of rows) {
          const blockedUntil = state.blocked_until?.getTime() ?? 0;
          if (blockedUntil > now.getTime()) {
            retryAfterMs = Math.max(retryAfterMs, blockedUntil - now.getTime());
          }
        }
        if (retryAfterMs > 0) {
          // Roll back inserts for attacker-controlled new email/token subjects while a
          // shared bucket is already blocked. Otherwise blocked traffic can grow this
          // table without bound even though it never reaches the protected operation.
          throw new ActiveAbuseRateLimitBlock(Math.max(1, Math.min(
            Math.ceil(retryAfterMs / 1_000),
            Math.ceil(policy.blockMs / 1_000),
          )));
        }

        for (const { bucket, state } of rows) {
          const blockExpired = state.blocked_until !== null;
          const windowExpired = now.getTime() - state.window_started_at.getTime() >= policy.windowMs;
          const clockRewound = now.getTime() < state.window_started_at.getTime();
          if (blockExpired || windowExpired || clockRewound) {
            state.attempt_count = 0;
            state.window_started_at = now;
            state.blocked_until = null;
            await client.query(
              `UPDATE product_abuse_rate_limits
               SET window_started_at = $4, attempt_count = 0, blocked_until = NULL, updated_at = $4
               WHERE action = $1 AND subject_kind = $2 AND subject_hash = $3`,
              [bucket.action, bucket.kind, bucket.hash, now],
            );
          }
        }

        let newlyBlocked = false;
        const blockedUntil = new Date(now.getTime() + policy.blockMs);
        for (const { bucket, state } of rows) {
          const attempts = Math.min(policy.maxAttempts, state.attempt_count + 1);
          const block = attempts >= policy.maxAttempts;
          newlyBlocked ||= block;
          await client.query(
            `UPDATE product_abuse_rate_limits
             SET attempt_count = $4,
                 blocked_until = CASE WHEN $5::boolean THEN $6::timestamptz ELSE NULL END,
                 updated_at = $7
             WHERE action = $1 AND subject_kind = $2 AND subject_hash = $3`,
            [bucket.action, bucket.kind, bucket.hash, attempts, block, blockedUntil, now],
          );
        }
        return newlyBlocked
          ? { allowed: false, retryAfterSeconds: Math.ceil(policy.blockMs / 1_000) }
          : { allowed: true };
      });
    } catch (error) {
      if (error instanceof ActiveAbuseRateLimitBlock) {
        return { allowed: false, retryAfterSeconds: error.retryAfterSeconds };
      }
      throw error;
    }
  }
}
