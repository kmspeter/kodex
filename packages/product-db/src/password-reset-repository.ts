import type { ProductDatabase } from './database.js';

export interface PasswordResetAccount {
  email: string;
  userId: string;
}

export interface CreatePasswordResetInput {
  createdAt: Date;
  expiresAt: Date;
  tokenHash: Buffer;
  userId: string;
}

export interface ConsumePasswordResetInput {
  consumedAt: Date;
  nextPasswordHash: string;
  tokenHash: Buffer;
}

export interface PasswordResetRepository {
  consumePasswordReset(input: ConsumePasswordResetInput): Promise<number>;
  createPasswordReset(input: CreatePasswordResetInput): Promise<string>;
  findActiveAccountByEmail(email: string): Promise<PasswordResetAccount | undefined>;
  markPasswordResetDeliveryFailed(requestId: string, failedAt: Date): Promise<void>;
}

export class PasswordResetUnavailableError extends Error {
  constructor() {
    super('Password reset is invalid or no longer available');
    this.name = 'PasswordResetUnavailableError';
  }
}

interface ResetCandidateRow {
  consumed_at: Date | null;
  delivery_failed_at: Date | null;
  expires_at: Date;
  id: string;
  revoked_at: Date | null;
  user_id: string;
}

export class PostgresPasswordResetRepository implements PasswordResetRepository {
  constructor(private readonly database: ProductDatabase) {}

  async findActiveAccountByEmail(email: string): Promise<PasswordResetAccount | undefined> {
    const result = await this.database.query<{ email: string; id: string }>(
      `SELECT id, email
       FROM users
       WHERE email = $1 AND status = 'active' AND deleted_at IS NULL
       LIMIT 1`,
      [email],
    );
    const row = result.rows[0];
    return row ? { email: row.email, userId: row.id } : undefined;
  }

  async createPasswordReset(input: CreatePasswordResetInput): Promise<string> {
    return this.database.transaction(async (client) => {
      const account = await client.query(
        `SELECT id FROM users
         WHERE id = $1 AND status = 'active' AND deleted_at IS NULL
         FOR UPDATE`,
        [input.userId],
      );
      if ((account.rowCount ?? 0) !== 1) throw new PasswordResetUnavailableError();
      await client.query(
        `UPDATE password_reset_requests
         SET revoked_at = $2
         WHERE user_id = $1 AND consumed_at IS NULL AND revoked_at IS NULL`,
        [input.userId, input.createdAt],
      );
      const created = await client.query<{ id: string }>(
        `INSERT INTO password_reset_requests
           (user_id, token_hash, expires_at, created_at)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [input.userId, input.tokenHash, input.expiresAt, input.createdAt],
      );
      await client.query(
        `INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, details, created_at)
         VALUES ($1, 'password_reset_requested', 'account', $2, '{}'::jsonb, $3)`,
        [input.userId, input.userId, input.createdAt],
      );
      return created.rows[0].id;
    });
  }

  async markPasswordResetDeliveryFailed(requestId: string, failedAt: Date): Promise<void> {
    await this.database.transaction(async (client) => {
      const request = await client.query<{ user_id: string }>(
        `SELECT user_id FROM password_reset_requests WHERE id = $1 FOR UPDATE`,
        [requestId],
      );
      const row = request.rows[0];
      if (!row) return;
      const updated = await client.query(
        `UPDATE password_reset_requests
         SET delivery_failed_at = $2, revoked_at = $2
         WHERE id = $1 AND consumed_at IS NULL AND revoked_at IS NULL`,
        [requestId, failedAt],
      );
      if ((updated.rowCount ?? 0) > 0) {
        await client.query(
          `INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, details, created_at)
           VALUES ($1, 'password_reset_delivery_failed', 'account', $2, '{}'::jsonb, $3)`,
          [row.user_id, row.user_id, failedAt],
        );
      }
    });
  }

  async consumePasswordReset(input: ConsumePasswordResetInput): Promise<number> {
    return this.database.transaction(async (client) => {
      const candidate = await client.query<{ user_id: string }>(
        `SELECT user_id FROM password_reset_requests WHERE token_hash = $1 LIMIT 1`,
        [input.tokenHash],
      );
      const userId = candidate.rows[0]?.user_id;
      if (!userId) throw new PasswordResetUnavailableError();
      const account = await client.query(
        `SELECT id FROM users
         WHERE id = $1 AND status = 'active' AND deleted_at IS NULL
         FOR UPDATE`,
        [userId],
      );
      if ((account.rowCount ?? 0) !== 1) throw new PasswordResetUnavailableError();
      const reset = await client.query<ResetCandidateRow>(
        `SELECT id, user_id, expires_at, consumed_at, revoked_at, delivery_failed_at
         FROM password_reset_requests
         WHERE token_hash = $1 AND user_id = $2
         FOR UPDATE`,
        [input.tokenHash, userId],
      );
      const row = reset.rows[0];
      if (
        !row
        || row.consumed_at
        || row.revoked_at
        || row.delivery_failed_at
        || row.expires_at.getTime() <= input.consumedAt.getTime()
      ) throw new PasswordResetUnavailableError();
      const credential = await client.query(
        `UPDATE password_credentials
         SET password_hash = $2, updated_at = $3
         WHERE user_id = $1`,
        [userId, input.nextPasswordHash, input.consumedAt],
      );
      if ((credential.rowCount ?? 0) !== 1) throw new PasswordResetUnavailableError();
      await client.query(
        `UPDATE password_reset_requests SET consumed_at = $2 WHERE id = $1`,
        [row.id, input.consumedAt],
      );
      await client.query(
        `UPDATE password_reset_requests
         SET revoked_at = $2
         WHERE user_id = $1 AND id <> $3 AND consumed_at IS NULL AND revoked_at IS NULL`,
        [userId, input.consumedAt, row.id],
      );
      const revoked = await client.query(
        `UPDATE auth_sessions
         SET revoked_at = COALESCE(revoked_at, $2)
         WHERE user_id = $1 AND revoked_at IS NULL`,
        [userId, input.consumedAt],
      );
      await client.query(
        `INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, details, created_at)
         VALUES ($1, 'password_reset_completed', 'account', $2, $3::jsonb, $4)`,
        [userId, userId, JSON.stringify({ revokedSessionCount: revoked.rowCount ?? 0 }), input.consumedAt],
      );
      return revoked.rowCount ?? 0;
    });
  }
}
