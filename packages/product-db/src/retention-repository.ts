import type { ProductDatabase } from './database.js';

export interface RetentionBatchInput {
  batchSize: number;
  cutoff: Date;
}

export interface RateLimitRetentionBatchInput extends RetentionBatchInput {
  referenceTime: Date;
}

export interface RetentionRepository {
  deleteStaleLoginRateLimitsBatch(input: RateLimitRetentionBatchInput): Promise<number>;
  deleteTerminalInvitationsBatch(input: RetentionBatchInput): Promise<number>;
  deleteTerminalSessionsBatch(input: RetentionBatchInput): Promise<number>;
}

const MAXIMUM_BATCH_SIZE = 1_000;

function validateBatch(input: RetentionBatchInput): void {
  if (!Number.isSafeInteger(input.batchSize) || input.batchSize < 1 || input.batchSize > MAXIMUM_BATCH_SIZE) {
    throw new Error(`Retention batch size must be between 1 and ${MAXIMUM_BATCH_SIZE}`);
  }
  if (!Number.isFinite(input.cutoff.getTime())) {
    throw new Error('Retention cutoff must be a valid date');
  }
}

function deletedRows(rowCount: number | null): number {
  if (rowCount === null || !Number.isSafeInteger(rowCount) || rowCount < 0) {
    throw new Error('Retention delete did not return a valid aggregate count');
  }
  return rowCount;
}

export class PostgresRetentionRepository implements RetentionRepository {
  constructor(private readonly database: ProductDatabase) {}

  async deleteTerminalSessionsBatch(input: RetentionBatchInput): Promise<number> {
    validateBatch(input);
    const result = await this.database.query(
      `WITH candidates AS (
         SELECT id
         FROM auth_sessions
         WHERE COALESCE(revoked_at, expires_at) < $1
         ORDER BY COALESCE(revoked_at, expires_at), id
         LIMIT $2
         FOR UPDATE SKIP LOCKED
       )
       DELETE FROM auth_sessions AS session
       USING candidates
       WHERE session.id = candidates.id`,
      [input.cutoff, input.batchSize],
    );
    return deletedRows(result.rowCount);
  }

  async deleteTerminalInvitationsBatch(input: RetentionBatchInput): Promise<number> {
    validateBatch(input);
    const result = await this.database.query(
      `WITH candidates AS (
         SELECT id
         FROM workspace_invitations
         WHERE COALESCE(accepted_at, revoked_at, expires_at) < $1
         ORDER BY COALESCE(accepted_at, revoked_at, expires_at), id
         LIMIT $2
         FOR UPDATE SKIP LOCKED
       )
       DELETE FROM workspace_invitations AS invitation
       USING candidates
       WHERE invitation.id = candidates.id`,
      [input.cutoff, input.batchSize],
    );
    return deletedRows(result.rowCount);
  }

  async deleteStaleLoginRateLimitsBatch(input: RateLimitRetentionBatchInput): Promise<number> {
    validateBatch(input);
    if (!Number.isFinite(input.referenceTime.getTime())) {
      throw new Error('Retention reference time must be a valid date');
    }
    const result = await this.database.query(
      `WITH candidates AS (
         SELECT bucket_hash
         FROM auth_login_rate_limits
         WHERE updated_at < $1
           AND (blocked_until IS NULL OR blocked_until <= $2)
         ORDER BY updated_at, bucket_hash
         LIMIT $3
         FOR UPDATE SKIP LOCKED
       )
       DELETE FROM auth_login_rate_limits AS rate_limit
       USING candidates
       WHERE rate_limit.bucket_hash = candidates.bucket_hash`,
      [input.cutoff, input.referenceTime, input.batchSize],
    );
    return deletedRows(result.rowCount);
  }
}
