import { randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { ProductDatabase } from './database.js';
import { hashEmailVerificationToken } from './email-verification-repository.js';
import { hashWorkspaceInvitationToken } from './workspace-repository.js';
import type { WorkspaceInvitationRole } from './workspace-types.js';

export type EmailDeliveryKind = 'email_verification' | 'workspace_invitation';

export interface EmailDeliveryJob {
  attemptCount: number;
  id: string;
  kind: EmailDeliveryKind;
}

export type PreparedEmailDelivery = {
  email: string;
  expiresAt: Date;
  kind: 'email_verification';
  token: string;
} | {
  email: string;
  expiresAt: Date;
  kind: 'workspace_invitation';
  role: WorkspaceInvitationRole;
  token: string;
  workspaceName: string;
};

export interface EmailDeliveryRepository {
  claim(workerId: string, now: Date, leaseExpiresAt: Date): Promise<EmailDeliveryJob | undefined>;
  fail(job: EmailDeliveryJob, workerId: string, failedAt: Date, retryAt: Date, maxAttempts: number): Promise<boolean>;
  prepare(job: EmailDeliveryJob, workerId: string, now: Date, verificationExpiresAt: Date): Promise<PreparedEmailDelivery | undefined>;
  succeed(jobId: string, workerId: string, completedAt: Date): Promise<void>;
}

interface DeliveryJobRow {
  attempt_count: number;
  id: string;
  kind: EmailDeliveryKind;
}

export class PostgresEmailDeliveryRepository implements EmailDeliveryRepository {
  constructor(
    private readonly database: ProductDatabase,
    private readonly randomToken: () => Buffer = () => randomBytes(32),
  ) {}

  async claim(workerId: string, now: Date, leaseExpiresAt: Date): Promise<EmailDeliveryJob | undefined> {
    return this.database.transaction(async (client) => {
      const candidate = await client.query<DeliveryJobRow>(
        `SELECT id, kind, attempt_count
         FROM email_delivery_jobs
         WHERE (
           status IN ('pending', 'retry') AND available_at <= $1
         ) OR (
           status = 'running' AND lease_expires_at <= $1
         )
         ORDER BY available_at, created_at, id
         LIMIT 1
         FOR UPDATE SKIP LOCKED`,
        [now],
      );
      const row = candidate.rows[0];
      if (!row) return undefined;
      const attemptCount = row.attempt_count + 1;
      await client.query(
        `UPDATE email_delivery_jobs
         SET status = 'running', attempt_count = $2, lease_owner = $3,
             lease_expires_at = $4, updated_at = $5, last_error_code = NULL
         WHERE id = $1`,
        [row.id, attemptCount, workerId, leaseExpiresAt, now],
      );
      return { id: row.id, kind: row.kind, attemptCount };
    });
  }

  async prepare(
    job: EmailDeliveryJob,
    workerId: string,
    now: Date,
    verificationExpiresAt: Date,
  ): Promise<PreparedEmailDelivery | undefined> {
    const bytes = this.randomToken();
    if (bytes.length !== 32) throw new Error('Email delivery token generator must return exactly 32 bytes');
    const token = bytes.toString('base64url');
    return this.database.transaction(async (client) => {
      const current = await client.query<{ invitation_id: string | null; kind: EmailDeliveryKind; user_id: string | null }>(
        `SELECT kind, user_id, invitation_id
         FROM email_delivery_jobs
         WHERE id = $1 AND status = 'running' AND lease_owner = $2
         FOR UPDATE`,
        [job.id, workerId],
      );
      const row = current.rows[0];
      if (!row || row.kind !== job.kind) return undefined;
      if (row.kind === 'email_verification' && row.user_id) {
        const user = await client.query<{ email: string; email_verified_at: Date | null }>(
          `SELECT email, email_verified_at FROM users
           WHERE id = $1 AND status = 'active' AND deleted_at IS NULL
           FOR UPDATE`,
          [row.user_id],
        );
        const target = user.rows[0];
        if (!target || target.email_verified_at) {
          await this.#cancel(client, job.id, now);
          return undefined;
        }
        await client.query(
          `UPDATE email_verification_requests SET revoked_at = $2
           WHERE user_id = $1 AND consumed_at IS NULL AND revoked_at IS NULL`,
          [row.user_id, now],
        );
        await client.query(
          `INSERT INTO email_verification_requests
             (user_id, delivery_job_id, token_hash, expires_at, created_at)
           VALUES ($1, $2, $3, $4, $5)`,
          [row.user_id, job.id, hashEmailVerificationToken(token), verificationExpiresAt, now],
        );
        return { kind: row.kind, email: target.email, expiresAt: verificationExpiresAt, token };
      }
      if (row.kind === 'workspace_invitation' && row.invitation_id) {
        const invitation = await client.query<{
          accepted_at: Date | null;
          expires_at: Date;
          requested_role: WorkspaceInvitationRole;
          revoked_at: Date | null;
          target_email: string;
          workspace_name: string;
        }>(
          `SELECT invitation.target_email, invitation.requested_role, invitation.expires_at,
                  invitation.accepted_at, invitation.revoked_at, workspace.name AS workspace_name
           FROM workspace_invitations invitation
           JOIN workspaces workspace ON workspace.id = invitation.workspace_id AND workspace.deleted_at IS NULL
           WHERE invitation.id = $1
           FOR UPDATE OF invitation, workspace`,
          [row.invitation_id],
        );
        const target = invitation.rows[0];
        if (!target || target.accepted_at || target.revoked_at || target.expires_at.getTime() <= now.getTime()) {
          await this.#cancel(client, job.id, now);
          return undefined;
        }
        await client.query(
          'UPDATE workspace_invitations SET token_hash = $2 WHERE id = $1',
          [row.invitation_id, hashWorkspaceInvitationToken(token)],
        );
        return {
          kind: row.kind,
          email: target.target_email,
          expiresAt: target.expires_at,
          role: target.requested_role,
          token,
          workspaceName: target.workspace_name,
        };
      }
      await this.#cancel(client, job.id, now);
      return undefined;
    });
  }

  async succeed(jobId: string, workerId: string, completedAt: Date): Promise<void> {
    await this.database.query(
      `UPDATE email_delivery_jobs
       SET status = 'delivered', lease_owner = NULL, lease_expires_at = NULL,
           completed_at = $3, updated_at = $3
       WHERE id = $1 AND status = 'running' AND lease_owner = $2`,
      [jobId, workerId, completedAt],
    );
  }

  async fail(
    job: EmailDeliveryJob,
    workerId: string,
    failedAt: Date,
    retryAt: Date,
    maxAttempts: number,
  ): Promise<boolean> {
    return this.database.transaction(async (client) => {
      const current = await client.query<{ invitation_id: string | null; user_id: string | null }>(
        `SELECT user_id, invitation_id FROM email_delivery_jobs
         WHERE id = $1 AND status = 'running' AND lease_owner = $2
         FOR UPDATE`,
        [job.id, workerId],
      );
      const row = current.rows[0];
      if (!row) return false;
      const terminal = job.attemptCount >= maxAttempts;
      await client.query(
        `UPDATE email_delivery_jobs
         SET status = $3, available_at = $4, lease_owner = NULL, lease_expires_at = NULL,
             last_error_code = 'provider_failed', updated_at = $5,
             completed_at = CASE WHEN $6::boolean THEN $5 ELSE NULL END
         WHERE id = $1 AND lease_owner = $2`,
        [job.id, workerId, terminal ? 'failed' : 'retry', retryAt, failedAt, terminal],
      );
      if (terminal && row.user_id) {
        await client.query(
          `UPDATE email_verification_requests
           SET delivery_failed_at = $2, revoked_at = $2
           WHERE delivery_job_id = $1 AND consumed_at IS NULL AND revoked_at IS NULL`,
          [job.id, failedAt],
        );
      }
      if (terminal && row.invitation_id) {
        await client.query(
          `UPDATE workspace_invitations SET revoked_at = $2
           WHERE id = $1 AND accepted_at IS NULL AND revoked_at IS NULL`,
          [row.invitation_id, failedAt],
        );
      }
      return terminal;
    });
  }

  async #cancel(client: PoolClient, jobId: string, now: Date): Promise<void> {
    await client.query(
      `UPDATE email_delivery_jobs
       SET status = 'cancelled', lease_owner = NULL, lease_expires_at = NULL,
           completed_at = $2, updated_at = $2
       WHERE id = $1`,
      [jobId, now],
    );
  }
}
