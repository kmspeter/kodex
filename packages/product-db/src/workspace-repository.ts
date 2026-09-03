import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { ProductDatabase } from './database.js';
import { normalizeEmail } from './auth-service.js';
import type { WorkspaceRole } from './auth-types.js';
import {
  WorkspaceInvitationError,
  WorkspaceOperationError,
  type CreatedWorkspaceInvitation,
  type WorkspaceApplication,
  type WorkspaceInvitation,
  type WorkspaceInvitationPreview,
  type WorkspaceInvitationRole,
  type WorkspaceMember,
  type WorkspaceRecord,
} from './workspace-types.js';

interface MemberRow {
  display_name: string | null;
  email: string;
  joined_at: Date;
  role: WorkspaceRole;
  user_id: string;
}

interface InvitationRow {
  created_at: Date;
  created_by_user_id: string | null;
  expires_at: Date;
  id: string;
  requested_role: WorkspaceInvitationRole;
  target_email: string;
  workspace_id: string;
}

export const WORKSPACE_INVITATION_TOKEN_BYTES = 32;
export const WORKSPACE_INVITATION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const INVITATION_HASH_DOMAIN = Buffer.from('kodex-workspace-invitation-v1\0', 'utf8');
const INVITATION_TOKEN_ATTEMPTS = 3;

export interface WorkspaceInvitationOptions {
  pendingLimit?: number;
  ttlMs?: number;
}

function invitation(row: InvitationRow): WorkspaceInvitation {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    targetEmail: row.target_email,
    role: row.requested_role,
    createdByUserId: row.created_by_user_id,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

export function hashWorkspaceInvitationToken(token: string): Buffer {
  if (!WORKSPACE_INVITATION_TOKEN_PATTERN.test(token)) throw new WorkspaceInvitationError('invalid');
  const decoded = Buffer.from(token, 'base64url');
  if (decoded.length !== WORKSPACE_INVITATION_TOKEN_BYTES || decoded.toString('base64url') !== token) {
    throw new WorkspaceInvitationError('invalid');
  }
  return createHash('sha256').update(INVITATION_HASH_DOMAIN).update(decoded).digest();
}

function maskedEmail(email: string): string {
  const separator = email.lastIndexOf('@');
  const local = email.slice(0, separator);
  const domain = email.slice(separator + 1);
  return `${local.slice(0, 1)}${'*'.repeat(Math.min(3, Math.max(1, local.length - 1)))}@${domain}`;
}

function member(row: MemberRow): WorkspaceMember {
  return {
    userId: row.user_id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    joinedAt: row.joined_at,
  };
}

function postgresCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

async function lockWorkspace(client: PoolClient, workspaceId: string): Promise<void> {
  const result = await client.query('SELECT id FROM workspaces WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [workspaceId]);
  if (!result.rowCount) throw new WorkspaceOperationError('forbidden');
}

async function roleFor(client: PoolClient, workspaceId: string, userId: string): Promise<WorkspaceRole> {
  const result = await client.query<{ role: WorkspaceRole }>(
    'SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
    [workspaceId, userId],
  );
  const role = result.rows[0]?.role;
  if (!role) throw new WorkspaceOperationError('forbidden');
  return role;
}

function requireManager(actorRole: WorkspaceRole): void {
  if (actorRole !== 'owner' && actorRole !== 'admin') throw new WorkspaceOperationError('forbidden');
}

function adminMayManage(actorRole: WorkspaceRole, targetRole: WorkspaceRole | undefined, nextRole?: WorkspaceRole): boolean {
  if (actorRole === 'owner') return true;
  if (targetRole === 'owner' || targetRole === 'admin') return false;
  return nextRole !== 'owner' && nextRole !== 'admin';
}

function mayManageInvitation(actorRole: WorkspaceRole, role: WorkspaceInvitationRole): boolean {
  return actorRole === 'owner' || (actorRole === 'admin' && (role === 'member' || role === 'viewer'));
}

async function audit(
  client: PoolClient,
  workspaceId: string,
  actorUserId: string,
  action: string,
  targetId: string,
  details: Record<string, string>,
  targetType = 'workspace_member',
): Promise<void> {
  await client.query(
    `INSERT INTO audit_logs (workspace_id, actor_user_id, action, target_type, target_id, details)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [workspaceId, actorUserId, action.slice(0, 80), targetType.slice(0, 40), targetId.slice(0, 128), JSON.stringify(details)],
  );
}

export class PostgresWorkspaceRepository implements WorkspaceApplication {
  readonly #pendingInvitationLimit: number;
  readonly #invitationTtlMs: number;

  constructor(private readonly database: ProductDatabase, options: WorkspaceInvitationOptions = {}) {
    this.#pendingInvitationLimit = options.pendingLimit ?? 100;
    this.#invitationTtlMs = options.ttlMs ?? 7 * 24 * 60 * 60 * 1_000;
    if (!Number.isSafeInteger(this.#pendingInvitationLimit) || this.#pendingInvitationLimit < 1 || this.#pendingInvitationLimit > 500) {
      throw new Error('Workspace invitation pending limit must be between 1 and 500.');
    }
    if (!Number.isSafeInteger(this.#invitationTtlMs) || this.#invitationTtlMs < 60 * 60 * 1_000 || this.#invitationTtlMs > 30 * 24 * 60 * 60 * 1_000) {
      throw new Error('Workspace invitation TTL must be between one hour and 30 days.');
    }
  }

  async createWorkspace(actorUserId: string, name: string): Promise<WorkspaceRecord> {
    return this.database.transaction(async (client) => {
      const slug = `workspace-${randomUUID()}`;
      const result = await client.query<{ id: string; name: string; slug: string }>(
        `INSERT INTO workspaces (slug, name, owner_user_id)
         VALUES ($1, $2, $3)
         RETURNING id, name, slug`,
        [slug, name, actorUserId],
      );
      const workspace = result.rows[0];
      await client.query(
        `INSERT INTO workspace_members (workspace_id, user_id, role)
         VALUES ($1, $2, 'owner')`,
        [workspace.id, actorUserId],
      );
      await audit(client, workspace.id, actorUserId, 'workspace.created', workspace.id, { role: 'owner' }, 'workspace');
      return { ...workspace, role: 'owner' };
    });
  }

  async listMembers(actorUserId: string, workspaceId: string): Promise<WorkspaceMember[]> {
    const result = await this.database.query<MemberRow>(
      `SELECT wm.user_id, u.email, u.display_name, wm.role, wm.joined_at
       FROM workspace_members actor
       JOIN workspace_members wm ON wm.workspace_id = actor.workspace_id
       JOIN users u ON u.id = wm.user_id AND u.status = 'active' AND u.deleted_at IS NULL
       JOIN workspaces w ON w.id = wm.workspace_id AND w.deleted_at IS NULL
       WHERE actor.workspace_id = $1 AND actor.user_id = $2
       ORDER BY CASE wm.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'member' THEN 2 ELSE 3 END,
                lower(u.email), wm.user_id`,
      [workspaceId, actorUserId],
    );
    if (!result.rowCount) throw new WorkspaceOperationError('forbidden');
    return result.rows.map(member);
  }

  async addMember(actorUserId: string, workspaceId: string, email: string, nextRole: WorkspaceRole): Promise<WorkspaceMember> {
    try {
      return await this.database.transaction(async (client) => {
        await lockWorkspace(client, workspaceId);
        const actorRole = await roleFor(client, workspaceId, actorUserId);
        requireManager(actorRole);
        if (!adminMayManage(actorRole, undefined, nextRole)) throw new WorkspaceOperationError('forbidden');
        const user = await client.query<{ display_name: string | null; email: string; id: string }>(
          `SELECT id, email, display_name FROM users
           WHERE email = $1 AND status = 'active' AND deleted_at IS NULL LIMIT 1`,
          [normalizeEmail(email)],
        );
        const target = user.rows[0];
        if (!target) throw new WorkspaceOperationError('not_found');
        const result = await client.query<MemberRow>(
          `INSERT INTO workspace_members (workspace_id, user_id, role)
           VALUES ($1, $2, $3)
           RETURNING user_id, $4::text AS email, $5::text AS display_name, role, joined_at`,
          [workspaceId, target.id, nextRole, target.email, target.display_name],
        );
        if (nextRole === 'owner') {
          await client.query('UPDATE workspaces SET owner_user_id = $2, updated_at = now() WHERE id = $1', [workspaceId, target.id]);
        }
        await audit(client, workspaceId, actorUserId, 'workspace.member_added', target.id, { role: nextRole });
        return member(result.rows[0]);
      });
    } catch (error) {
      if (postgresCode(error) === '23505') throw new WorkspaceOperationError('conflict');
      throw error;
    }
  }

  async createInvitation(
    actorUserId: string,
    workspaceId: string,
    email: string,
    role: WorkspaceInvitationRole,
  ): Promise<CreatedWorkspaceInvitation> {
    const targetEmail = normalizeEmail(email);
    for (let attempt = 0; attempt < INVITATION_TOKEN_ATTEMPTS; attempt += 1) {
      const token = randomBytes(WORKSPACE_INVITATION_TOKEN_BYTES).toString('base64url');
      const tokenHash = hashWorkspaceInvitationToken(token);
      try {
        return await this.database.transaction(async (client) => {
          await lockWorkspace(client, workspaceId);
          const actorRole = await roleFor(client, workspaceId, actorUserId);
          requireManager(actorRole);
          if (!mayManageInvitation(actorRole, role)) throw new WorkspaceInvitationError('forbidden');
          await client.query(
            `UPDATE workspace_invitations SET revoked_at = now()
             WHERE workspace_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at <= now()`,
            [workspaceId],
          );

          const existingMember = await client.query(
            `SELECT 1 FROM workspace_members wm
             JOIN users u ON u.id = wm.user_id AND u.status = 'active' AND u.deleted_at IS NULL
             WHERE wm.workspace_id = $1 AND u.email = $2 LIMIT 1`,
            [workspaceId, targetEmail],
          );
          if (existingMember.rowCount) throw new WorkspaceInvitationError('conflict');

          const active = await client.query<{ target_email: string }>(
            `SELECT target_email FROM workspace_invitations
             WHERE workspace_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()
             ORDER BY id FOR UPDATE`,
            [workspaceId],
          );
          if (active.rows.some((entry) => entry.target_email === targetEmail)) {
            throw new WorkspaceInvitationError('conflict');
          }
          if (active.rows.length >= this.#pendingInvitationLimit) throw new WorkspaceInvitationError('limit');

          const result = await client.query<InvitationRow>(
            `INSERT INTO workspace_invitations
               (workspace_id, target_email, requested_role, created_by_user_id, token_hash, expires_at)
             VALUES ($1, $2, $3, $4, $5, now() + ($6 * interval '1 millisecond'))
             RETURNING id, workspace_id, target_email, requested_role, created_by_user_id, expires_at, created_at`,
            [workspaceId, targetEmail, role, actorUserId, tokenHash, this.#invitationTtlMs],
          );
          const created = invitation(result.rows[0]);
          await audit(client, workspaceId, actorUserId, 'workspace.invitation_created', created.id, { role }, 'workspace_invitation');
          return { invitation: created, token };
        });
      } catch (error) {
        if (postgresCode(error) === '23505' && attempt + 1 < INVITATION_TOKEN_ATTEMPTS) continue;
        throw error;
      }
    }
    throw new Error('Workspace invitation token generation failed.');
  }

  async listInvitations(actorUserId: string, workspaceId: string): Promise<WorkspaceInvitation[]> {
    return this.database.transaction(async (client) => {
      await lockWorkspace(client, workspaceId);
      requireManager(await roleFor(client, workspaceId, actorUserId));
      const result = await client.query<InvitationRow>(
        `SELECT id, workspace_id, target_email, requested_role, created_by_user_id, expires_at, created_at
         FROM workspace_invitations
         WHERE workspace_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()
         ORDER BY created_at, id`,
        [workspaceId],
      );
      return result.rows.map(invitation);
    });
  }

  async revokeInvitation(actorUserId: string, workspaceId: string, invitationId: string): Promise<void> {
    await this.database.transaction(async (client) => {
      await lockWorkspace(client, workspaceId);
      const actorRole = await roleFor(client, workspaceId, actorUserId);
      requireManager(actorRole);
      const current = await client.query<{ requested_role: WorkspaceInvitationRole }>(
        `SELECT requested_role FROM workspace_invitations
         WHERE id = $1 AND workspace_id = $2 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()
         FOR UPDATE`,
        [invitationId, workspaceId],
      );
      const role = current.rows[0]?.requested_role;
      if (!role) throw new WorkspaceInvitationError('not_found');
      if (!mayManageInvitation(actorRole, role)) throw new WorkspaceInvitationError('forbidden');
      await client.query('UPDATE workspace_invitations SET revoked_at = now() WHERE id = $1', [invitationId]);
      await audit(client, workspaceId, actorUserId, 'workspace.invitation_revoked', invitationId, { role }, 'workspace_invitation');
    });
  }

  async previewInvitation(token: string): Promise<WorkspaceInvitationPreview> {
    const tokenHash = hashWorkspaceInvitationToken(token);
    const result = await this.database.query<{
      expires_at: Date;
      requested_role: WorkspaceInvitationRole;
      target_email: string;
      workspace_name: string;
    }>(
      `SELECT invitation.expires_at, invitation.requested_role, invitation.target_email, workspace.name AS workspace_name
       FROM workspace_invitations invitation
       JOIN workspaces workspace ON workspace.id = invitation.workspace_id AND workspace.deleted_at IS NULL
       WHERE invitation.token_hash = $1 AND invitation.accepted_at IS NULL AND invitation.revoked_at IS NULL
         AND invitation.expires_at > now()
       LIMIT 1`,
      [tokenHash],
    );
    const current = result.rows[0];
    if (!current) throw new WorkspaceInvitationError('invalid');
    return {
      workspaceName: current.workspace_name,
      targetEmailHint: maskedEmail(current.target_email),
      role: current.requested_role,
      expiresAt: current.expires_at,
    };
  }

  async acceptInvitation(actorUserId: string, token: string): Promise<WorkspaceRecord> {
    const tokenHash = hashWorkspaceInvitationToken(token);
    return this.database.transaction(async (client) => {
      const located = await client.query<{ workspace_id: string }>(
        'SELECT workspace_id FROM workspace_invitations WHERE token_hash = $1',
        [tokenHash],
      );
      const workspaceId = located.rows[0]?.workspace_id;
      if (!workspaceId) throw new WorkspaceInvitationError('invalid');
      await lockWorkspace(client, workspaceId);
      const selected = await client.query<InvitationRow & { accepted_at: Date | null; active: boolean; revoked_at: Date | null }>(
        `SELECT id, workspace_id, target_email, requested_role, created_by_user_id, expires_at, created_at,
                accepted_at, revoked_at, expires_at > now() AS active
         FROM workspace_invitations WHERE token_hash = $1 FOR UPDATE`,
        [tokenHash],
      );
      const current = selected.rows[0];
      if (!current || !current.active || current.accepted_at || current.revoked_at) {
        throw new WorkspaceInvitationError('invalid');
      }
      const user = await client.query<{ email: string }>(
        `SELECT email FROM users WHERE id = $1 AND status = 'active' AND deleted_at IS NULL FOR UPDATE`,
        [actorUserId],
      );
      if (user.rows[0]?.email !== current.target_email) throw new WorkspaceInvitationError('forbidden');
      const membership = await client.query<{ role: WorkspaceRole }>(
        'SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2 FOR UPDATE',
        [current.workspace_id, actorUserId],
      );
      if (membership.rowCount) throw new WorkspaceInvitationError('conflict');
      await client.query(
        'INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3)',
        [current.workspace_id, actorUserId, current.requested_role],
      );
      await client.query(
        'UPDATE workspace_invitations SET accepted_at = now(), accepted_by_user_id = $2 WHERE id = $1',
        [current.id, actorUserId],
      );
      await audit(
        client,
        current.workspace_id,
        actorUserId,
        'workspace.invitation_accepted',
        current.id,
        { role: current.requested_role },
        'workspace_invitation',
      );
      const workspace = await client.query<{ id: string; name: string; slug: string }>(
        'SELECT id, name, slug FROM workspaces WHERE id = $1',
        [current.workspace_id],
      );
      return { ...workspace.rows[0], role: current.requested_role };
    });
  }

  async updateMemberRole(actorUserId: string, workspaceId: string, targetUserId: string, nextRole: WorkspaceRole): Promise<WorkspaceMember> {
    return this.database.transaction(async (client) => {
      await lockWorkspace(client, workspaceId);
      const actorRole = await roleFor(client, workspaceId, actorUserId);
      requireManager(actorRole);
      const currentResult = await client.query<MemberRow>(
        `SELECT wm.user_id, u.email, u.display_name, wm.role, wm.joined_at
         FROM workspace_members wm JOIN users u ON u.id = wm.user_id
         WHERE wm.workspace_id = $1 AND wm.user_id = $2 FOR UPDATE OF wm`,
        [workspaceId, targetUserId],
      );
      const current = currentResult.rows[0];
      if (!current) throw new WorkspaceOperationError('not_found');
      if (!adminMayManage(actorRole, current.role, nextRole)) throw new WorkspaceOperationError('forbidden');
      if (current.role === 'owner' && nextRole !== 'owner') await this.#requireAnotherOwner(client, workspaceId, targetUserId);
      const result = await client.query<MemberRow>(
        `UPDATE workspace_members SET role = $3, updated_at = now()
         WHERE workspace_id = $1 AND user_id = $2
         RETURNING user_id, $4::text AS email, $5::text AS display_name, role, joined_at`,
        [workspaceId, targetUserId, nextRole, current.email, current.display_name],
      );
      if (nextRole === 'owner') {
        await client.query('UPDATE workspaces SET owner_user_id = $2, updated_at = now() WHERE id = $1', [workspaceId, targetUserId]);
      } else {
        await client.query(
          `UPDATE workspaces w SET owner_user_id = replacement.user_id, updated_at = now()
           FROM LATERAL (SELECT user_id FROM workspace_members WHERE workspace_id = $1 AND role = 'owner' ORDER BY joined_at, user_id LIMIT 1) replacement
           WHERE w.id = $1 AND w.owner_user_id = $2`,
          [workspaceId, targetUserId],
        );
      }
      await audit(client, workspaceId, actorUserId, 'workspace.member_role_changed', targetUserId, { from: current.role, to: nextRole });
      return member(result.rows[0]);
    });
  }

  async removeMember(actorUserId: string, workspaceId: string, targetUserId: string): Promise<void> {
    await this.database.transaction(async (client) => {
      await lockWorkspace(client, workspaceId);
      const actorRole = await roleFor(client, workspaceId, actorUserId);
      requireManager(actorRole);
      const target = await client.query<{ role: WorkspaceRole }>(
        'SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2 FOR UPDATE',
        [workspaceId, targetUserId],
      );
      const targetRole = target.rows[0]?.role;
      if (!targetRole) throw new WorkspaceOperationError('not_found');
      const adminSelfRemoval = actorRole === 'admin' && actorUserId === targetUserId;
      if (!adminSelfRemoval && !adminMayManage(actorRole, targetRole)) throw new WorkspaceOperationError('forbidden');
      if (targetRole === 'owner') await this.#requireAnotherOwner(client, workspaceId, targetUserId);
      await client.query('DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [workspaceId, targetUserId]);
      await client.query(
        `UPDATE workspaces w SET owner_user_id = replacement.user_id, updated_at = now()
         FROM LATERAL (SELECT user_id FROM workspace_members WHERE workspace_id = $1 AND role = 'owner' ORDER BY joined_at, user_id LIMIT 1) replacement
         WHERE w.id = $1 AND w.owner_user_id = $2`,
        [workspaceId, targetUserId],
      );
      await audit(client, workspaceId, actorUserId, 'workspace.member_removed', targetUserId, { role: targetRole });
    });
  }

  async #requireAnotherOwner(client: PoolClient, workspaceId: string, targetUserId: string): Promise<void> {
    const owners = await client.query<{ user_id: string }>(
      `SELECT user_id FROM workspace_members
       WHERE workspace_id = $1 AND role = 'owner'
       ORDER BY user_id FOR UPDATE`,
      [workspaceId],
    );
    if (!owners.rows.some((row) => row.user_id !== targetUserId)) throw new WorkspaceOperationError('last_owner');
  }
}
