import { createHash } from 'node:crypto';
import type { ProductDatabase } from './database.js';

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const TOKEN_BYTES = 32;
const TOKEN_DOMAIN = Buffer.from('kodex-email-verification-v1\0', 'utf8');

export interface EmailVerificationSession {
  email: string;
  userId: string;
  verified: boolean;
}

export interface EmailVerificationRepository {
  consume(tokenHash: Buffer, consumedAt: Date): Promise<void>;
  enqueue(userId: string, requestedAt: Date): Promise<boolean>;
  findSession(tokenHash: Buffer): Promise<EmailVerificationSession | undefined>;
}

export class EmailVerificationUnavailableError extends Error {
  constructor() {
    super('Email verification is invalid or no longer available');
    this.name = 'EmailVerificationUnavailableError';
  }
}

export function hashEmailVerificationToken(token: string): Buffer {
  if (!TOKEN_PATTERN.test(token)) throw new EmailVerificationUnavailableError();
  const decoded = Buffer.from(token, 'base64url');
  if (decoded.length !== TOKEN_BYTES || decoded.toString('base64url') !== token) {
    throw new EmailVerificationUnavailableError();
  }
  return createHash('sha256').update(TOKEN_DOMAIN).update(decoded).digest();
}

interface VerificationRow {
  consumed_at: Date | null;
  expires_at: Date;
  id: string;
  revoked_at: Date | null;
  user_id: string;
}

export class PostgresEmailVerificationRepository implements EmailVerificationRepository {
  constructor(private readonly database: ProductDatabase) {}

  async findSession(tokenHash: Buffer): Promise<EmailVerificationSession | undefined> {
    const result = await this.database.query<{
      email: string;
      email_verified_at: Date | null;
      user_id: string;
    }>(
      `SELECT u.id AS user_id, u.email, u.email_verified_at
       FROM auth_sessions session
       JOIN users u ON u.id = session.user_id
       WHERE session.token_hash = $1
         AND session.revoked_at IS NULL
         AND session.expires_at > now()
         AND u.status = 'active'
         AND u.deleted_at IS NULL
       LIMIT 1`,
      [tokenHash],
    );
    const row = result.rows[0];
    return row ? {
      email: row.email,
      userId: row.user_id,
      verified: row.email_verified_at !== null,
    } : undefined;
  }

  async enqueue(userId: string, requestedAt: Date): Promise<boolean> {
    return this.database.transaction(async (client) => {
      const user = await client.query<{ email_verified_at: Date | null }>(
        `SELECT email_verified_at
         FROM users
         WHERE id = $1 AND status = 'active' AND deleted_at IS NULL
         FOR UPDATE`,
        [userId],
      );
      const row = user.rows[0];
      if (!row) throw new EmailVerificationUnavailableError();
      if (row.email_verified_at) return false;
      await client.query(
        `UPDATE email_verification_requests
         SET revoked_at = $2
         WHERE user_id = $1 AND consumed_at IS NULL AND revoked_at IS NULL`,
        [userId, requestedAt],
      );
      await client.query(
        `UPDATE email_delivery_jobs
         SET status = 'cancelled', lease_owner = NULL, lease_expires_at = NULL,
             completed_at = $2, updated_at = $2
         WHERE kind = 'email_verification' AND user_id = $1
           AND status IN ('pending', 'running', 'retry')`,
        [userId, requestedAt],
      );
      await client.query(
        `INSERT INTO email_delivery_jobs (kind, user_id, available_at, created_at, updated_at)
         VALUES ('email_verification', $1, $2, $2, $2)`,
        [userId, requestedAt],
      );
      return true;
    });
  }

  async consume(tokenHash: Buffer, consumedAt: Date): Promise<void> {
    await this.database.transaction(async (client) => {
      const candidate = await client.query<{ user_id: string }>(
        'SELECT user_id FROM email_verification_requests WHERE token_hash = $1 LIMIT 1',
        [tokenHash],
      );
      const userId = candidate.rows[0]?.user_id;
      if (!userId) throw new EmailVerificationUnavailableError();
      const user = await client.query<{ email_verified_at: Date | null }>(
        `SELECT email_verified_at
         FROM users
         WHERE id = $1 AND status = 'active' AND deleted_at IS NULL
         FOR UPDATE`,
        [userId],
      );
      if (!user.rows[0] || user.rows[0].email_verified_at) {
        throw new EmailVerificationUnavailableError();
      }
      const selected = await client.query<VerificationRow>(
        `SELECT id, user_id, expires_at, consumed_at, revoked_at
         FROM email_verification_requests
         WHERE token_hash = $1 AND user_id = $2
         FOR UPDATE`,
        [tokenHash, userId],
      );
      const verification = selected.rows[0];
      if (
        !verification
        || verification.consumed_at
        || verification.revoked_at
        || verification.expires_at.getTime() <= consumedAt.getTime()
      ) throw new EmailVerificationUnavailableError();
      await client.query(
        'UPDATE users SET email_verified_at = $2, updated_at = $2 WHERE id = $1',
        [userId, consumedAt],
      );
      await client.query(
        'UPDATE email_verification_requests SET consumed_at = $2 WHERE id = $1',
        [verification.id, consumedAt],
      );
      await client.query(
        `UPDATE email_verification_requests
         SET revoked_at = $2
         WHERE user_id = $1 AND id <> $3 AND consumed_at IS NULL AND revoked_at IS NULL`,
        [userId, consumedAt, verification.id],
      );
      await client.query(
        `UPDATE email_delivery_jobs
         SET status = 'cancelled', lease_owner = NULL, lease_expires_at = NULL,
             completed_at = $2, updated_at = $2
         WHERE kind = 'email_verification' AND user_id = $1
           AND status IN ('pending', 'running', 'retry')`,
        [userId, consumedAt],
      );
      await client.query(
        `INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, details, created_at)
         VALUES ($1, 'email_verified', 'account', $1, '{}'::jsonb, $2)`,
        [userId, consumedAt],
      );
    });
  }
}
