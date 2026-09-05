import { isUuid } from '@kodex/product-contract';
import type { PoolClient } from 'pg';
import type { ProductDatabase } from './database.js';
import { buildBoundedUserExport } from './data-export.js';
import {
  DataLifecycleError,
  type CredentialConfirmation,
  type DataExportArtifact,
  type DataLifecycleJob,
  type DataLifecycleJobKind,
  type DataLifecycleJobStatus,
  type DataLifecycleWorkerConfig,
  type LegalHold,
  type LocalLifecycleTarget,
  type LocalLifecycleCleanupResult,
  type LocalLifecycleExecutionResult,
  type LocalTenantScope,
} from './data-lifecycle-types.js';

interface JobRow {
  attempt_count: number;
  completed_at: Date | null;
  created_at: Date;
  id: string;
  kind: DataLifecycleJobKind;
  last_error_code: string | null;
  status: DataLifecycleJobStatus;
  target_user_id: string | null;
  target_workspace_id: string | null;
  updated_at: Date;
}

interface ExportRow {
  created_at: Date;
  document: unknown;
  expires_at: Date;
  job_id: string;
  size_bytes: number;
  user_id: string;
}

interface HoldRow {
  created_at: Date;
  id: string;
  reason_code: string;
  target_type: 'user' | 'workspace';
  target_user_id: string | null;
  target_workspace_id: string | null;
}

interface LocalTargetRow {
  attempt_count: number;
  id: string;
  job_id: string;
  job_kind: 'account_delete' | 'workspace_delete';
  user_id: string;
  workspace_id: string;
}

const JOB_COLUMNS = `id, kind, status, target_user_id, target_workspace_id,
  attempt_count, last_error_code, created_at, updated_at, completed_at`;

function job(row: JobRow): DataLifecycleJob {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    targetUserId: row.target_user_id,
    targetWorkspaceId: row.target_workspace_id,
    attemptCount: row.attempt_count,
    lastErrorCode: row.last_error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function artifact(row: ExportRow): DataExportArtifact {
  return {
    jobId: row.job_id,
    userId: row.user_id,
    document: row.document,
    sizeBytes: row.size_bytes,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

function hold(row: HoldRow): LegalHold {
  return {
    id: row.id,
    targetType: row.target_type,
    targetUserId: row.target_user_id,
    targetWorkspaceId: row.target_workspace_id,
    reasonCode: row.reason_code,
    createdAt: row.created_at,
  };
}

function requireUuid(value: string, name: string): void {
  if (!isUuid(value)) throw new Error(`${name} must be a UUID.`);
}

function safeWorkerId(value: string): void {
  const controlCharacter = [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  });
  if (!value || Buffer.byteLength(value, 'utf8') > 128 || controlCharacter) {
    throw new Error('Lifecycle worker ID is invalid.');
  }
}

function safeErrorCode(value: string): void {
  if (!/^[a-z][a-z0-9_]{0,63}$/u.test(value)) throw new Error('Lifecycle error code is invalid.');
}

async function verifyCredential(client: PoolClient, input: CredentialConfirmation): Promise<void> {
  const result = await client.query<{ password_hash: string }>(
    `SELECT credential.password_hash
     FROM users account
     JOIN password_credentials credential ON credential.user_id = account.id
     JOIN auth_sessions session_record ON session_record.user_id = account.id
     WHERE account.id = $1
       AND account.status = 'active'
       AND account.deleted_at IS NULL
       AND session_record.id = $2
       AND session_record.revoked_at IS NULL
       AND session_record.expires_at > now()
     FOR UPDATE OF account, credential, session_record`,
    [input.userId, input.currentSessionId],
  );
  const encoded = result.rows[0]?.password_hash;
  if (!encoded || !await input.verifyCurrentPassword(encoded)) {
    throw new DataLifecycleError('credential_rejected');
  }
}

async function insertKnownLocalTargets(client: PoolClient, jobId: string): Promise<void> {
  await client.query(
    `INSERT INTO data_lifecycle_local_targets
       (job_id, installation_id, user_id, workspace_id)
     SELECT lifecycle_job.id, tenant.installation_id, tenant.user_id, tenant.workspace_id
     FROM data_lifecycle_jobs lifecycle_job
     JOIN data_lifecycle_local_tenants tenant ON (
       (lifecycle_job.kind = 'workspace_delete' AND tenant.workspace_id = lifecycle_job.target_workspace_id)
       OR
       (lifecycle_job.kind = 'account_delete' AND (
         tenant.user_id = lifecycle_job.target_user_id
         OR EXISTS (
           SELECT 1 FROM data_lifecycle_job_workspaces job_workspace
           WHERE job_workspace.job_id = lifecycle_job.id
             AND job_workspace.workspace_id = tenant.workspace_id
         )
       ))
     )
     WHERE lifecycle_job.id = $1
     ON CONFLICT (job_id, installation_id, user_id, workspace_id) DO NOTHING`,
    [jobId],
  );
}

async function activeUserHold(client: PoolClient, userId: string): Promise<boolean> {
  const result = await client.query(
    `SELECT 1 FROM data_legal_holds
     WHERE target_type = 'user' AND target_user_id = $1 AND released_at IS NULL LIMIT 1`,
    [userId],
  );
  return Boolean(result.rowCount);
}

async function activeAccountScopeHold(client: PoolClient, userId: string): Promise<boolean> {
  const result = await client.query(
    `SELECT 1 FROM data_legal_holds hold_record
     WHERE hold_record.released_at IS NULL AND (
       (hold_record.target_type = 'user' AND hold_record.target_user_id = $1)
       OR
       (hold_record.target_type = 'workspace' AND EXISTS (
         SELECT 1 FROM workspaces workspace
         WHERE workspace.id = hold_record.target_workspace_id
           AND workspace.owner_user_id = $1
       ))
       OR
       (hold_record.target_type = 'user' AND EXISTS (
         SELECT 1 FROM workspaces workspace
         WHERE workspace.owner_user_id = $1 AND (
           EXISTS (SELECT 1 FROM workspace_members member
             WHERE member.workspace_id = workspace.id AND member.user_id = hold_record.target_user_id)
           OR EXISTS (SELECT 1 FROM projects project
             WHERE project.workspace_id = workspace.id AND project.created_by_user_id = hold_record.target_user_id)
           OR EXISTS (SELECT 1 FROM agent_threads thread_record
             WHERE thread_record.workspace_id = workspace.id AND thread_record.created_by_user_id = hold_record.target_user_id)
           OR EXISTS (SELECT 1 FROM knowledge_sources source
             WHERE source.workspace_id = workspace.id AND source.created_by_user_id = hold_record.target_user_id)
         )
       ))
     ) LIMIT 1`,
    [userId],
  );
  return Boolean(result.rowCount);
}

async function accountProjectScopeConflict(client: PoolClient, userId: string): Promise<boolean> {
  const result = await client.query(
    `SELECT 1 FROM projects project
     JOIN agent_threads thread_record
       ON thread_record.project_id = project.id
      AND thread_record.workspace_id = project.workspace_id
     WHERE project.created_by_user_id = $1
       AND thread_record.created_by_user_id IS DISTINCT FROM $1::uuid
     LIMIT 1`,
    [userId],
  );
  return Boolean(result.rowCount);
}

async function lockWorkspaceScope(client: PoolClient, workspaceId: string): Promise<void> {
  await client.query('SELECT id FROM workspaces WHERE id = $1 FOR UPDATE', [workspaceId]);
  await client.query(
    `SELECT account.id FROM users account
     JOIN (
       SELECT member.user_id FROM workspace_members member WHERE member.workspace_id = $1
       UNION SELECT project.created_by_user_id FROM projects project
         WHERE project.workspace_id = $1 AND project.created_by_user_id IS NOT NULL
       UNION SELECT thread_record.created_by_user_id FROM agent_threads thread_record
         WHERE thread_record.workspace_id = $1 AND thread_record.created_by_user_id IS NOT NULL
       UNION SELECT source.created_by_user_id FROM knowledge_sources source
         WHERE source.workspace_id = $1
     ) scoped_user ON scoped_user.user_id = account.id
     ORDER BY account.id FOR UPDATE OF account`,
    [workspaceId],
  );
}

async function lockAccountScopeForUser(client: PoolClient, userId: string): Promise<void> {
  await client.query(
    'SELECT id FROM workspaces WHERE owner_user_id = $1 ORDER BY id FOR UPDATE',
    [userId],
  );
  await client.query(
    `SELECT account.id FROM users account
     WHERE account.id = $1 OR EXISTS (
       SELECT 1 FROM workspaces workspace WHERE workspace.owner_user_id = $1 AND (
         EXISTS (SELECT 1 FROM workspace_members member
           WHERE member.workspace_id = workspace.id AND member.user_id = account.id)
         OR EXISTS (SELECT 1 FROM projects project
           WHERE project.workspace_id = workspace.id AND project.created_by_user_id = account.id)
         OR EXISTS (SELECT 1 FROM agent_threads thread_record
           WHERE thread_record.workspace_id = workspace.id AND thread_record.created_by_user_id = account.id)
         OR EXISTS (SELECT 1 FROM knowledge_sources source
           WHERE source.workspace_id = workspace.id AND source.created_by_user_id = account.id)
       )
     ) ORDER BY account.id FOR UPDATE`,
    [userId],
  );
}

async function lockAccountScopeForJob(client: PoolClient, jobId: string): Promise<void> {
  await client.query(
    `SELECT workspace.id FROM workspaces workspace
     JOIN data_lifecycle_job_workspaces job_workspace ON job_workspace.workspace_id = workspace.id
     WHERE job_workspace.job_id = $1 ORDER BY workspace.id FOR UPDATE OF workspace`,
    [jobId],
  );
  await client.query(
    `SELECT account.id FROM users account
     WHERE account.id = (SELECT target_user_id FROM data_lifecycle_jobs WHERE id = $1)
       OR EXISTS (
         SELECT 1 FROM data_lifecycle_job_workspaces job_workspace WHERE job_workspace.job_id = $1 AND (
           EXISTS (SELECT 1 FROM workspace_members member
             WHERE member.workspace_id = job_workspace.workspace_id AND member.user_id = account.id)
           OR EXISTS (SELECT 1 FROM projects project
             WHERE project.workspace_id = job_workspace.workspace_id AND project.created_by_user_id = account.id)
           OR EXISTS (SELECT 1 FROM agent_threads thread_record
             WHERE thread_record.workspace_id = job_workspace.workspace_id AND thread_record.created_by_user_id = account.id)
           OR EXISTS (SELECT 1 FROM knowledge_sources source
             WHERE source.workspace_id = job_workspace.workspace_id AND source.created_by_user_id = account.id)
         )
       ) ORDER BY account.id FOR UPDATE`,
    [jobId],
  );
}

async function activeWorkspaceScopeHold(client: PoolClient, workspaceId: string): Promise<boolean> {
  const result = await client.query(
    `SELECT 1 FROM data_legal_holds hold_record
     WHERE hold_record.released_at IS NULL AND (
       (hold_record.target_type = 'workspace' AND hold_record.target_workspace_id = $1)
       OR
       (hold_record.target_type = 'user' AND hold_record.target_user_id IN (
         SELECT member.user_id FROM workspace_members member WHERE member.workspace_id = $1
         UNION SELECT project.created_by_user_id FROM projects project
           WHERE project.workspace_id = $1 AND project.created_by_user_id IS NOT NULL
         UNION SELECT thread_record.created_by_user_id FROM agent_threads thread_record
           WHERE thread_record.workspace_id = $1 AND thread_record.created_by_user_id IS NOT NULL
         UNION SELECT source.created_by_user_id FROM knowledge_sources source
           WHERE source.workspace_id = $1
       ))
     ) LIMIT 1`,
    [workspaceId],
  );
  return Boolean(result.rowCount);
}

export class PostgresDataLifecycleRepository {
  constructor(private readonly database: ProductDatabase) {}

  async requestUserExport(input: CredentialConfirmation): Promise<DataLifecycleJob> {
    return this.database.transaction(async (client) => {
      await verifyCredential(client, input);
      const existing = await client.query<JobRow>(
        `SELECT ${JOB_COLUMNS} FROM data_lifecycle_jobs
         WHERE kind = 'user_export' AND target_user_id = $1
           AND status NOT IN ('completed', 'failed')
         ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
        [input.userId],
      );
      if (existing.rows[0]) return job(existing.rows[0]);
      const result = await client.query<JobRow>(
        `INSERT INTO data_lifecycle_jobs
           (kind, requested_by_user_id, target_user_id)
         VALUES ('user_export', $1, $1)
         RETURNING ${JOB_COLUMNS}`,
        [input.userId],
      );
      await client.query(
        `INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, details)
         VALUES ($1, 'data_export.requested', 'account', $1::uuid::text, '{"scope":"private"}'::jsonb)`,
        [input.userId],
      );
      return job(result.rows[0]);
    });
  }

  async requestAccountDeletion(input: CredentialConfirmation): Promise<DataLifecycleJob> {
    return this.database.transaction(async (client) => {
      await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [input.userId]);
      const existing = await client.query<JobRow>(
        `SELECT ${JOB_COLUMNS} FROM data_lifecycle_jobs
         WHERE kind = 'account_delete' AND target_user_id = $1
           AND status NOT IN ('completed', 'failed')
         ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
        [input.userId],
      );
      if (existing.rows[0]) return job(existing.rows[0]);
      await verifyCredential(client, input);
      const sharedOwned = await client.query(
        `SELECT 1 FROM workspaces workspace
         WHERE workspace.owner_user_id = $1
           AND EXISTS (
             SELECT 1 FROM workspace_members member
             WHERE member.workspace_id = workspace.id AND member.user_id <> $1
           ) LIMIT 1`,
        [input.userId],
      );
      if (sharedOwned.rowCount) throw new DataLifecycleError('owned_workspace_conflict');
      if (await accountProjectScopeConflict(client, input.userId)) {
        throw new DataLifecycleError('scope_conflict');
      }
      if (await activeAccountScopeHold(client, input.userId)) throw new DataLifecycleError('legal_hold');

      const result = await client.query<JobRow>(
        `INSERT INTO data_lifecycle_jobs
           (kind, requested_by_user_id, target_user_id)
         VALUES ('account_delete', $1, $1)
         RETURNING ${JOB_COLUMNS}`,
        [input.userId],
      );
      const created = result.rows[0];
      await client.query(
        `UPDATE data_lifecycle_jobs SET status = 'failed', last_error_code = 'account_deletion',
           completed_at = now(), lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
         WHERE kind = 'user_export' AND target_user_id = $1
           AND status NOT IN ('completed', 'failed')`,
        [input.userId],
      );
      await client.query('DELETE FROM data_export_artifacts WHERE user_id = $1', [input.userId]);
      await client.query(
        `INSERT INTO data_lifecycle_job_workspaces (job_id, workspace_id)
         SELECT $2, id FROM workspaces WHERE owner_user_id = $1`,
        [input.userId, created.id],
      );
      await insertKnownLocalTargets(client, created.id);
      await client.query(
        `UPDATE workspaces SET
           deleted_at = COALESCE(deleted_at, now()),
           purge_requested_at = COALESCE(purge_requested_at, now()),
           updated_at = now()
         WHERE owner_user_id = $1`,
        [input.userId],
      );
      await client.query(
        `UPDATE workspace_invitations SET revoked_at = COALESCE(revoked_at, now())
         WHERE accepted_at IS NULL AND revoked_at IS NULL AND workspace_id IN (
           SELECT workspace_id FROM data_lifecycle_job_workspaces WHERE job_id = $1
         )`,
        [created.id],
      );
      await client.query(
        `UPDATE password_reset_requests SET revoked_at = COALESCE(revoked_at, now())
         WHERE user_id = $1 AND consumed_at IS NULL`,
        [input.userId],
      );
      await client.query(
        `UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, now())
         WHERE user_id = $1 AND revoked_at IS NULL`,
        [input.userId],
      );
      await client.query(
        `UPDATE users SET status = 'pending_deletion', deletion_requested_at = now(), updated_at = now()
         WHERE id = $1`,
        [input.userId],
      );
      await client.query(
        `INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, details)
         VALUES ($1, 'account.deletion_requested', 'account', $1::uuid::text, '{"mode":"permanent"}'::jsonb)`,
        [input.userId],
      );
      return job(created);
    });
  }

  async requestWorkspaceDeletion(
    input: CredentialConfirmation,
    workspaceId: string,
    confirmationName: string,
  ): Promise<DataLifecycleJob> {
    requireUuid(workspaceId, 'Workspace ID');
    return this.database.transaction(async (client) => {
      const workspace = await client.query<{ name: string }>(
        'SELECT name FROM workspaces WHERE id = $1 FOR UPDATE',
        [workspaceId],
      );
      if (!workspace.rows[0]) throw new DataLifecycleError('not_found');
      const membership = await client.query<{ role: string }>(
        `SELECT role FROM workspace_members
         WHERE workspace_id = $1 AND user_id = $2 FOR UPDATE`,
        [workspaceId, input.userId],
      );
      if (membership.rows[0]?.role !== 'owner') throw new DataLifecycleError('forbidden');
      if (workspace.rows[0].name !== confirmationName) throw new DataLifecycleError('confirmation_mismatch');
      await verifyCredential(client, input);
      const existing = await client.query<JobRow>(
        `SELECT ${JOB_COLUMNS} FROM data_lifecycle_jobs
         WHERE kind = 'workspace_delete' AND target_workspace_id = $1
           AND status NOT IN ('completed', 'failed')
         ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
        [workspaceId],
      );
      if (existing.rows[0]) return job(existing.rows[0]);
      if (await activeWorkspaceScopeHold(client, workspaceId)) throw new DataLifecycleError('legal_hold');
      const result = await client.query<JobRow>(
        `INSERT INTO data_lifecycle_jobs
           (kind, requested_by_user_id, target_workspace_id)
         VALUES ('workspace_delete', $1, $2)
         RETURNING ${JOB_COLUMNS}`,
        [input.userId, workspaceId],
      );
      await insertKnownLocalTargets(client, result.rows[0].id);
      await client.query(
        `UPDATE workspace_invitations SET revoked_at = COALESCE(revoked_at, now())
         WHERE workspace_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL`,
        [workspaceId],
      );
      await client.query(
        `UPDATE workspaces SET
           deleted_at = COALESCE(deleted_at, now()),
           purge_requested_at = now(),
           updated_at = now()
         WHERE id = $1`,
        [workspaceId],
      );
      await client.query(
        `INSERT INTO audit_logs (workspace_id, actor_user_id, action, target_type, target_id, details)
         VALUES ($1, $2, 'workspace.deletion_requested', 'workspace', $1::uuid::text, '{"mode":"permanent"}'::jsonb)`,
        [workspaceId, input.userId],
      );
      return job(result.rows[0]);
    });
  }

  async getJobForUser(userId: string, jobId: string): Promise<DataLifecycleJob | undefined> {
    requireUuid(jobId, 'Lifecycle job ID');
    const result = await this.database.query<JobRow>(
      `SELECT ${JOB_COLUMNS} FROM data_lifecycle_jobs
       WHERE id = $1 AND requested_by_user_id = $2`,
      [jobId, userId],
    );
    return result.rows[0] ? job(result.rows[0]) : undefined;
  }

  async getExportForUser(userId: string, jobId: string): Promise<DataExportArtifact | undefined> {
    requireUuid(jobId, 'Export job ID');
    const result = await this.database.query<ExportRow>(
      `SELECT artifact.job_id, artifact.user_id, artifact.document, artifact.size_bytes,
              artifact.created_at, artifact.expires_at
       FROM data_export_artifacts artifact
       JOIN data_lifecycle_jobs lifecycle_job ON lifecycle_job.id = artifact.job_id
       WHERE artifact.job_id = $1 AND artifact.user_id = $2
         AND lifecycle_job.kind = 'user_export' AND artifact.expires_at > now()`,
      [jobId, userId],
    );
    return result.rows[0] ? artifact(result.rows[0]) : undefined;
  }

  async createLegalHold(
    target: { targetType: 'user'; targetUserId: string } | { targetType: 'workspace'; targetWorkspaceId: string },
    reasonCode: string,
  ): Promise<LegalHold> {
    if (!/^[a-z][a-z0-9_]{0,63}$/u.test(reasonCode)) throw new DataLifecycleError('invalid');
    const targetId = target.targetType === 'user' ? target.targetUserId : target.targetWorkspaceId;
    requireUuid(targetId, 'Legal hold target');
    return this.database.transaction(async (client) => {
      const table = target.targetType === 'user' ? 'users' : 'workspaces';
      const exists = await client.query(`SELECT id FROM ${table} WHERE id = $1 FOR UPDATE`, [targetId]);
      if (!exists.rowCount) throw new DataLifecycleError('not_found');
      const existing = await client.query<HoldRow>(
        `SELECT id, target_type, target_user_id, target_workspace_id, reason_code, created_at
         FROM data_legal_holds WHERE target_type = $1
           AND ${target.targetType === 'user' ? 'target_user_id' : 'target_workspace_id'} = $2
           AND released_at IS NULL FOR UPDATE`,
        [target.targetType, targetId],
      );
      if (existing.rows[0]) return hold(existing.rows[0]);
      const result = await client.query<HoldRow>(
        `INSERT INTO data_legal_holds
           (target_type, target_user_id, target_workspace_id, reason_code)
         VALUES ($1, $2, $3, $4)
         RETURNING id, target_type, target_user_id, target_workspace_id, reason_code, created_at`,
        [
          target.targetType,
          target.targetType === 'user' ? targetId : null,
          target.targetType === 'workspace' ? targetId : null,
          reasonCode,
        ],
      );
      await client.query(
        `INSERT INTO audit_logs (workspace_id, action, target_type, target_id, details)
         VALUES ($1, 'legal_hold.created', $2, $3, $4::jsonb)`,
        [target.targetType === 'workspace' ? targetId : null, target.targetType, targetId, JSON.stringify({ reasonCode })],
      );
      return hold(result.rows[0]);
    });
  }

  async releaseLegalHold(holdId: string): Promise<boolean> {
    requireUuid(holdId, 'Legal hold ID');
    return this.database.transaction(async (client) => {
      const result = await client.query<HoldRow>(
        `UPDATE data_legal_holds SET released_at = now()
         WHERE id = $1 AND released_at IS NULL
         RETURNING id, target_type, target_user_id, target_workspace_id, reason_code, created_at`,
        [holdId],
      );
      const released = result.rows[0];
      if (!released) return false;
      await client.query(
        `UPDATE data_lifecycle_jobs SET status = 'pending', available_at = now(),
           lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
         WHERE status = 'blocked_legal_hold'`,
      );
      await client.query(
        `UPDATE data_lifecycle_local_targets SET status = 'pending', available_at = now(),
           lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
         WHERE status = 'blocked_legal_hold'`,
      );
      await client.query(
        `INSERT INTO audit_logs (workspace_id, action, target_type, target_id, details)
         VALUES ($1, 'legal_hold.released', $2, $3, $4::jsonb)`,
        [released.target_workspace_id, released.target_type, released.target_user_id ?? released.target_workspace_id, JSON.stringify({ reasonCode: released.reason_code })],
      );
      return true;
    });
  }

  async retryLifecycleJob(jobId: string): Promise<boolean> {
    requireUuid(jobId, 'Lifecycle job ID');
    return this.database.transaction(async (client) => {
      const jobResult = await client.query<{
        kind: DataLifecycleJobKind;
        status: DataLifecycleJobStatus;
        target_user_id: string | null;
        target_workspace_id: string | null;
      }>(
        `SELECT kind, status, target_user_id, target_workspace_id
         FROM data_lifecycle_jobs WHERE id = $1 FOR UPDATE`,
        [jobId],
      );
      const current = jobResult.rows[0];
      if (!current || current.status === 'completed') return false;
      const competing = await client.query(
        `SELECT 1 FROM data_lifecycle_jobs
         WHERE id <> $1 AND kind = $2 AND status NOT IN ('completed', 'failed')
           AND target_user_id IS NOT DISTINCT FROM $3::uuid
           AND target_workspace_id IS NOT DISTINCT FROM $4::uuid
         LIMIT 1 FOR UPDATE`,
        [jobId, current.kind, current.target_user_id, current.target_workspace_id],
      );
      if (competing.rowCount) return false;
      const targets = await client.query(
        `UPDATE data_lifecycle_local_targets SET status = 'pending', completed_at = NULL,
           last_error_code = NULL, available_at = now(), lease_owner = NULL,
           lease_expires_at = NULL, updated_at = now()
         WHERE job_id = $1 AND status = 'failed'`,
        [jobId],
      );
      if (current.status !== 'failed' && (targets.rowCount ?? 0) === 0) return false;
      await client.query(
        `UPDATE data_lifecycle_jobs SET status = 'pending', completed_at = NULL,
           last_error_code = NULL, available_at = now(), lease_owner = NULL,
           lease_expires_at = NULL, updated_at = now()
         WHERE id = $1`,
        [jobId],
      );
      return true;
    });
  }

  async claimProductJob(workerId: string, leaseMs: number): Promise<DataLifecycleJob | undefined> {
    safeWorkerId(workerId);
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1_000) throw new Error('Lifecycle lease must be at least one second.');
    return this.database.transaction(async (client) => {
      const result = await client.query<JobRow>(
        `WITH candidate AS (
         SELECT id FROM data_lifecycle_jobs
         WHERE kind IN ('user_export', 'account_delete', 'workspace_delete')
             AND status IN ('pending', 'running')
             AND available_at <= now()
             AND (lease_expires_at IS NULL OR lease_expires_at <= now())
           ORDER BY available_at, created_at, id
           FOR UPDATE SKIP LOCKED LIMIT 1
         )
         UPDATE data_lifecycle_jobs lifecycle_job SET
           status = 'running', attempt_count = lifecycle_job.attempt_count + 1,
           lease_owner = $1, lease_expires_at = now() + ($2::bigint * interval '1 millisecond'),
           updated_at = now()
         FROM candidate WHERE lifecycle_job.id = candidate.id
         RETURNING lifecycle_job.${JOB_COLUMNS.replaceAll(', ', ', lifecycle_job.')}`,
        [workerId, leaseMs],
      );
      return result.rows[0] ? job(result.rows[0]) : undefined;
    });
  }

  async processExportJob(
    claimed: DataLifecycleJob,
    workerId: string,
    config: Pick<DataLifecycleWorkerConfig, 'exportMaxBytes' | 'exportMaxRowsPerCategory' | 'exportRetentionMs'>,
  ): Promise<void> {
    if (claimed.kind !== 'user_export' || !claimed.targetUserId) throw new Error('Expected a user export job.');
    const built = await buildBoundedUserExport(
      this.database,
      claimed.targetUserId,
      config.exportMaxRowsPerCategory,
      config.exportMaxBytes,
    );
    await this.database.transaction(async (client) => {
      const locked = await client.query(
        `SELECT 1 FROM data_lifecycle_jobs
         WHERE id = $1 AND kind = 'user_export' AND status = 'running'
           AND lease_owner = $2 AND lease_expires_at > now() FOR UPDATE`,
        [claimed.id, workerId],
      );
      if (!locked.rowCount) throw new Error('Lifecycle export lease was lost.');
      await client.query(
        `INSERT INTO data_export_artifacts
           (job_id, user_id, document, size_bytes, expires_at)
         VALUES ($1, $2, $3::jsonb, $4, now() + ($5::bigint * interval '1 millisecond'))
         ON CONFLICT (job_id) DO UPDATE SET
           document = EXCLUDED.document, size_bytes = EXCLUDED.size_bytes,
           created_at = now(), expires_at = EXCLUDED.expires_at`,
        [claimed.id, claimed.targetUserId, JSON.stringify(built.document), built.sizeBytes, config.exportRetentionMs],
      );
      await client.query(
        `UPDATE data_lifecycle_jobs SET status = 'completed', completed_at = now(),
           last_error_code = NULL, lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
         WHERE id = $1`,
        [claimed.id],
      );
    });
  }

  async finalizeDeletionJob(
    claimed: DataLifecycleJob,
    workerId: string,
    retryMs: number,
  ): Promise<'blocked_legal_hold' | 'completed' | 'waiting_local'> {
    if (!['account_delete', 'workspace_delete'].includes(claimed.kind)) throw new Error('Expected a deletion job.');
    return this.database.transaction(async (client) => {
      const locked = await client.query<JobRow>(
        `SELECT ${JOB_COLUMNS} FROM data_lifecycle_jobs
         WHERE id = $1 AND status = 'running' AND lease_owner = $2
           AND lease_expires_at > now() FOR UPDATE`,
        [claimed.id, workerId],
      );
      const current = locked.rows[0];
      if (!current) throw new Error('Lifecycle deletion lease was lost.');
      if (current.kind === 'account_delete' && current.target_user_id) {
        await lockAccountScopeForUser(client, current.target_user_id);
      } else if (current.target_workspace_id) {
        await lockWorkspaceScope(client, current.target_workspace_id);
      }
      const held = current.kind === 'account_delete' && current.target_user_id
        ? await activeAccountScopeHold(client, current.target_user_id)
        : current.target_workspace_id
          ? await activeWorkspaceScopeHold(client, current.target_workspace_id)
          : false;
      if (held) {
        await this.#releaseProductJob(client, current.id, 'blocked_legal_hold', 'legal_hold', retryMs);
        return 'blocked_legal_hold';
      }
      const targets = await client.query(
        `SELECT 1 FROM data_lifecycle_local_targets
         WHERE job_id = $1 AND status <> 'completed' LIMIT 1`,
        [current.id],
      );
      if (targets.rowCount) {
        await this.#releaseProductJob(client, current.id, 'waiting_local', null, retryMs);
        return 'waiting_local';
      }
      if (current.kind === 'workspace_delete' && current.target_workspace_id) {
        await client.query(
          `DELETE FROM data_legal_holds
           WHERE target_type = 'workspace' AND target_workspace_id = $1 AND released_at IS NOT NULL`,
          [current.target_workspace_id],
        );
        await client.query('DELETE FROM workspaces WHERE id = $1', [current.target_workspace_id]);
      } else if (current.kind === 'account_delete' && current.target_user_id) {
        const conflict = await client.query(
          `SELECT 1 FROM workspaces workspace
           WHERE workspace.owner_user_id = $1 AND EXISTS (
             SELECT 1 FROM workspace_members member
             WHERE member.workspace_id = workspace.id AND member.user_id <> $1
           ) LIMIT 1`,
          [current.target_user_id],
        );
        if (conflict.rowCount) throw new DataLifecycleError('owned_workspace_conflict');
        if (await accountProjectScopeConflict(client, current.target_user_id)) {
          throw new DataLifecycleError('scope_conflict');
        }
        const account = await client.query<{ email: string }>(
          'SELECT email FROM users WHERE id = $1 FOR UPDATE',
          [current.target_user_id],
        );
        if (account.rows[0]) {
          await client.query('DELETE FROM agent_threads WHERE created_by_user_id = $1', [current.target_user_id]);
          await client.query('DELETE FROM projects WHERE created_by_user_id = $1', [current.target_user_id]);
          await client.query('DELETE FROM knowledge_sources WHERE created_by_user_id = $1', [current.target_user_id]);
          await client.query(
            `DELETE FROM audit_logs WHERE actor_user_id = $1
               OR (target_type IN ('account', 'user', 'workspace_member') AND target_id = $1::text)`,
            [current.target_user_id],
          );
          await client.query(
            `DELETE FROM data_legal_holds WHERE released_at IS NOT NULL AND (
               (target_type = 'user' AND target_user_id = $1)
               OR (target_type = 'workspace' AND target_workspace_id IN (
                 SELECT workspace_id FROM data_lifecycle_job_workspaces WHERE job_id = $2
               ))
             )`,
            [current.target_user_id, current.id],
          );
          await client.query(
            `DELETE FROM workspace_invitations
             WHERE target_email = $1 OR created_by_user_id = $2`,
            [account.rows[0].email, current.target_user_id],
          );
          await client.query('DELETE FROM data_export_artifacts WHERE user_id = $1', [current.target_user_id]);
          await client.query('DELETE FROM workspaces WHERE owner_user_id = $1', [current.target_user_id]);
          await client.query('DELETE FROM workspace_members WHERE user_id = $1', [current.target_user_id]);
          await client.query('DELETE FROM users WHERE id = $1', [current.target_user_id]);
        }
      }
      await client.query(
        `UPDATE data_lifecycle_jobs SET status = 'completed', completed_at = now(),
           last_error_code = NULL, lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
         WHERE id = $1`,
        [current.id],
      );
      return 'completed';
    });
  }

  async retryProductJob(jobId: string, workerId: string, errorCode: string, retryMs: number): Promise<void> {
    safeErrorCode(errorCode);
    await this.database.query(
      `UPDATE data_lifecycle_jobs SET status = 'pending', last_error_code = $3,
         available_at = now() + ($4::bigint * interval '1 millisecond'),
         lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
       WHERE id = $1 AND lease_owner = $2`,
      [jobId, workerId, errorCode, retryMs],
    );
  }

  async failProductJob(jobId: string, workerId: string, errorCode: string): Promise<void> {
    safeErrorCode(errorCode);
    await this.database.query(
      `UPDATE data_lifecycle_jobs SET status = 'failed', last_error_code = $3,
         completed_at = now(), lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
       WHERE id = $1 AND lease_owner = $2`,
      [jobId, workerId, errorCode],
    );
  }

  async purgeExpiredExports(batchSize = 100): Promise<number> {
    const result = await this.database.query(
      `WITH candidates AS (
         SELECT job_id FROM data_export_artifacts WHERE expires_at <= now()
         ORDER BY expires_at, job_id FOR UPDATE SKIP LOCKED LIMIT $1
       )
       DELETE FROM data_export_artifacts artifact USING candidates
       WHERE artifact.job_id = candidates.job_id`,
      [batchSize],
    );
    return result.rowCount ?? 0;
  }

  async registerLocalTenants(
    installationId: string,
    scopes: readonly LocalTenantScope[],
    reopenCompletedTargets = false,
  ): Promise<number> {
    requireUuid(installationId, 'Installation ID');
    const unique = [...new Map(scopes.map((scope) => [`${scope.userId}:${scope.workspaceId}`, scope])).values()];
    for (const scope of unique) {
      requireUuid(scope.userId, 'Tenant user ID');
      requireUuid(scope.workspaceId, 'Tenant workspace ID');
    }
    if (unique.length === 0) return 0;
    if (unique.length > 100_000) throw new Error('Too many local tenant scopes were discovered.');
    return this.database.transaction(async (client) => {
      await client.query(
        `INSERT INTO data_lifecycle_local_tenants
           (installation_id, user_id, workspace_id)
         SELECT $1, discovered.user_id, discovered.workspace_id
         FROM unnest($2::uuid[], $3::uuid[]) AS discovered(user_id, workspace_id)
         ON CONFLICT (installation_id, user_id, workspace_id)
         DO UPDATE SET last_seen_at = now()`,
        [installationId, unique.map((scope) => scope.userId), unique.map((scope) => scope.workspaceId)],
      );
      const targets = await client.query(
        `INSERT INTO data_lifecycle_local_targets AS existing_target
           (job_id, installation_id, user_id, workspace_id)
         SELECT lifecycle_job.id, $1, discovered.user_id, discovered.workspace_id
         FROM unnest($2::uuid[], $3::uuid[]) AS discovered(user_id, workspace_id)
         JOIN data_lifecycle_jobs lifecycle_job ON (
           (lifecycle_job.kind = 'workspace_delete'
             AND lifecycle_job.target_workspace_id = discovered.workspace_id)
           OR
           (lifecycle_job.kind = 'account_delete' AND (
             lifecycle_job.target_user_id = discovered.user_id
             OR EXISTS (
               SELECT 1 FROM data_lifecycle_job_workspaces job_workspace
               WHERE job_workspace.job_id = lifecycle_job.id
                 AND job_workspace.workspace_id = discovered.workspace_id
             )
           ))
         )
         WHERE lifecycle_job.status <> 'failed'
         ON CONFLICT (job_id, installation_id, user_id, workspace_id) DO UPDATE SET
           status = 'pending', completed_at = NULL, last_error_code = NULL,
           available_at = now(), lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
         WHERE $4 AND existing_target.status = 'completed'`,
        [
          installationId,
          unique.map((scope) => scope.userId),
          unique.map((scope) => scope.workspaceId),
          reopenCompletedTargets,
        ],
      );
      if ((targets.rowCount ?? 0) > 0) {
        await client.query(
          `UPDATE data_lifecycle_jobs SET status = 'waiting_local', completed_at = NULL,
             available_at = now(), lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
           WHERE id IN (
             SELECT DISTINCT target.job_id FROM data_lifecycle_local_targets target
             WHERE target.installation_id = $1 AND target.status <> 'completed'
           ) AND status = 'completed'`,
          [installationId],
        );
      }
      return targets.rowCount ?? 0;
    });
  }

  async localTenantDeletionRequired(scope: LocalTenantScope): Promise<boolean> {
    requireUuid(scope.userId, 'Tenant user ID');
    requireUuid(scope.workspaceId, 'Tenant workspace ID');
    const result = await this.database.query(
      `SELECT 1 FROM data_lifecycle_jobs lifecycle_job
       WHERE lifecycle_job.kind IN ('account_delete', 'workspace_delete')
         AND lifecycle_job.status <> 'failed'
         AND (
           lifecycle_job.target_workspace_id = $2
           OR lifecycle_job.target_user_id = $1
           OR EXISTS (
             SELECT 1 FROM data_lifecycle_job_workspaces job_workspace
             WHERE job_workspace.job_id = lifecycle_job.id
               AND job_workspace.workspace_id = $2
           )
         ) LIMIT 1`,
      [scope.userId, scope.workspaceId],
    );
    return Boolean(result.rowCount);
  }

  async claimLocalTarget(installationId: string, workerId: string, leaseMs: number): Promise<LocalLifecycleTarget | undefined> {
    requireUuid(installationId, 'Installation ID');
    safeWorkerId(workerId);
    return this.database.transaction(async (client) => {
      const result = await client.query<LocalTargetRow>(
        `WITH candidate AS (
           SELECT target.id
           FROM data_lifecycle_local_targets target
           WHERE target.installation_id = $1
             AND target.status IN ('pending', 'running')
             AND target.available_at <= now()
             AND (target.lease_expires_at IS NULL OR target.lease_expires_at <= now())
           ORDER BY target.available_at, target.created_at, target.id
           FOR UPDATE SKIP LOCKED LIMIT 1
         )
         UPDATE data_lifecycle_local_targets target SET
           status = 'running', attempt_count = target.attempt_count + 1,
           lease_owner = $2, lease_expires_at = now() + ($3::bigint * interval '1 millisecond'),
           updated_at = now()
         FROM candidate, data_lifecycle_jobs lifecycle_job
         WHERE target.id = candidate.id AND lifecycle_job.id = target.job_id
         RETURNING target.id, target.job_id, target.user_id, target.workspace_id,
           target.attempt_count, lifecycle_job.kind AS job_kind`,
        [installationId, workerId, leaseMs],
      );
      const row = result.rows[0];
      return row ? {
        id: row.id,
        jobId: row.job_id,
        jobKind: row.job_kind,
        userId: row.user_id,
        workspaceId: row.workspace_id,
        attemptCount: row.attempt_count,
      } : undefined;
    });
  }

  async executeLocalTarget(
    target: LocalLifecycleTarget,
    workerId: string,
    retryMs: number,
    cleanup: () => Promise<LocalLifecycleCleanupResult>,
  ): Promise<LocalLifecycleExecutionResult> {
    safeWorkerId(workerId);
    return this.database.transaction(async (client) => {
      const locked = await client.query(
        `SELECT 1 FROM data_lifecycle_local_targets
         WHERE id = $1 AND job_id = $2 AND user_id = $3 AND workspace_id = $4
           AND status = 'running' AND lease_owner = $5 FOR UPDATE`,
        [target.id, target.jobId, target.userId, target.workspaceId, workerId],
      );
      if (!locked.rowCount) throw new Error('Local lifecycle lease was lost.');
      const lockedJob = await client.query<{ kind: DataLifecycleJobKind }>(
        'SELECT kind FROM data_lifecycle_jobs WHERE id = $1 FOR UPDATE',
        [target.jobId],
      );
      if (lockedJob.rows[0]?.kind !== target.jobKind) throw new Error('Local lifecycle job scope changed.');
      if (target.jobKind === 'account_delete') {
        await lockAccountScopeForJob(client, target.jobId);
      } else {
        await lockWorkspaceScope(client, target.workspaceId);
      }
      const held = target.jobKind === 'account_delete'
        ? await activeUserHold(client, target.userId)
          || await activeAccountScopeHoldForJob(client, target.jobId)
        : await activeWorkspaceScopeHold(client, target.workspaceId);
      if (held) {
        await client.query(
          `UPDATE data_lifecycle_local_targets SET status = 'blocked_legal_hold',
             last_error_code = 'legal_hold', available_at = now() + ($3::bigint * interval '1 millisecond'),
             lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
           WHERE id = $1 AND lease_owner = $2`,
          [target.id, workerId, retryMs],
        );
        return 'blocked_legal_hold';
      }
      const result = await cleanup();
      if (result === 'deleted' || result === 'missing') {
        await client.query(
          `UPDATE data_lifecycle_local_targets SET status = 'completed', completed_at = now(),
             last_error_code = NULL, lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
           WHERE id = $1 AND lease_owner = $2`,
          [target.id, workerId],
        );
        await client.query(
          `UPDATE data_lifecycle_jobs SET status = 'pending', available_at = now(), updated_at = now()
           WHERE id = $1 AND status IN ('waiting_local', 'completed')`,
          [target.jobId],
        );
        return 'completed';
      }
      const errorCode = result === 'busy' ? 'runtime_busy' : 'partial_cleanup';
      await client.query(
        `UPDATE data_lifecycle_local_targets SET status = 'pending', last_error_code = $3,
           available_at = now() + ($4::bigint * interval '1 millisecond'),
           lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
         WHERE id = $1 AND lease_owner = $2`,
        [target.id, workerId, errorCode, retryMs],
      );
      return 'retry';
    });
  }

  async retryLocalTarget(targetId: string, workerId: string, errorCode: string, retryMs: number): Promise<void> {
    safeErrorCode(errorCode);
    await this.database.query(
      `UPDATE data_lifecycle_local_targets SET status = 'pending', last_error_code = $3,
         available_at = now() + ($4::bigint * interval '1 millisecond'),
         lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
       WHERE id = $1 AND lease_owner = $2`,
      [targetId, workerId, errorCode, retryMs],
    );
  }

  async failLocalTarget(targetId: string, workerId: string, errorCode: string): Promise<void> {
    safeErrorCode(errorCode);
    await this.database.query(
      `UPDATE data_lifecycle_local_targets SET status = 'failed', last_error_code = $3,
         completed_at = now(), lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
       WHERE id = $1 AND lease_owner = $2`,
      [targetId, workerId, errorCode],
    );
  }

  async #releaseProductJob(
    client: PoolClient,
    jobId: string,
    status: 'blocked_legal_hold' | 'waiting_local',
    errorCode: string | null,
    retryMs: number,
  ): Promise<void> {
    await client.query(
      `UPDATE data_lifecycle_jobs SET status = $2, last_error_code = $3,
         available_at = now() + ($4::bigint * interval '1 millisecond'),
         lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
       WHERE id = $1`,
      [jobId, status, errorCode, retryMs],
    );
  }
}

async function activeAccountScopeHoldForJob(client: PoolClient, jobId: string): Promise<boolean> {
  const result = await client.query(
    `SELECT 1 FROM data_legal_holds hold_record
     JOIN data_lifecycle_jobs lifecycle_job ON lifecycle_job.id = $1
     WHERE hold_record.released_at IS NULL AND (
       (hold_record.target_type = 'user' AND hold_record.target_user_id = lifecycle_job.target_user_id)
       OR
       (hold_record.target_type = 'workspace' AND EXISTS (
         SELECT 1 FROM data_lifecycle_job_workspaces job_workspace
         WHERE job_workspace.job_id = lifecycle_job.id
           AND job_workspace.workspace_id = hold_record.target_workspace_id
       ))
       OR
       (hold_record.target_type = 'user' AND EXISTS (
         SELECT 1 FROM data_lifecycle_job_workspaces job_workspace
         WHERE job_workspace.job_id = lifecycle_job.id AND (
           EXISTS (SELECT 1 FROM workspace_members member
             WHERE member.workspace_id = job_workspace.workspace_id
               AND member.user_id = hold_record.target_user_id)
           OR EXISTS (SELECT 1 FROM projects project
             WHERE project.workspace_id = job_workspace.workspace_id
               AND project.created_by_user_id = hold_record.target_user_id)
           OR EXISTS (SELECT 1 FROM agent_threads thread_record
             WHERE thread_record.workspace_id = job_workspace.workspace_id
               AND thread_record.created_by_user_id = hold_record.target_user_id)
           OR EXISTS (SELECT 1 FROM knowledge_sources source
             WHERE source.workspace_id = job_workspace.workspace_id
               AND source.created_by_user_id = hold_record.target_user_id)
         )
       ))
     ) LIMIT 1`,
    [jobId],
  );
  return Boolean(result.rowCount);
}
