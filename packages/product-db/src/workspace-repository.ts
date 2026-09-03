import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { ProductDatabase } from './database.js';
import { normalizeEmail } from './auth-service.js';
import type { WorkspaceRole } from './auth-types.js';
import {
  WorkspaceOperationError,
  type WorkspaceApplication,
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
  constructor(private readonly database: ProductDatabase) {}

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
