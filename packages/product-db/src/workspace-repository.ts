import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import {
  isUuid,
  PRODUCT_WORKSPACE_CURSOR_MAX_CHARACTERS,
  PRODUCT_WORKSPACE_PAGE_MAX_LIMIT,
} from '@kodex/product-contract';
import type { PoolClient } from 'pg';
import type { ProductDatabase } from './database.js';
import { normalizeEmail } from './auth-service.js';
import type { WorkspaceRole } from './auth-types.js';
import {
  WorkspaceInvitationError,
  WorkspaceCursorError,
  WorkspaceOperationError,
  type ArchivedWorkspacePage,
  type ArchivedWorkspaceRecord,
  type CreatedWorkspaceInvitation,
  type WorkspaceApplication,
  type WorkspaceInvitation,
  type WorkspaceInvitationPage,
  type WorkspaceInvitationPreview,
  type WorkspaceInvitationRole,
  type WorkspaceMember,
  type WorkspaceMemberPage,
  type WorkspacePageOptions,
  type WorkspaceRecord,
} from './workspace-types.js';

interface MemberRow {
  cursor_joined_at: string;
  display_name: string | null;
  email: string;
  joined_at: Date;
  role: WorkspaceRole;
  user_id: string;
}

interface InvitationRow {
  cursor_created_at?: string;
  created_at: Date;
  created_by_user_id: string | null;
  expires_at: Date;
  id: string;
  requested_role: WorkspaceInvitationRole;
  target_email: string;
  workspace_id: string;
}

interface ArchivedWorkspaceRow {
  cursor_archived_at: string;
  deleted_at: Date;
  id: string;
  name: string;
  slug: string;
}

export const WORKSPACE_INVITATION_TOKEN_BYTES = 32;
export const WORKSPACE_INVITATION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const INVITATION_HASH_DOMAIN = Buffer.from('kodex-workspace-invitation-v1\0', 'utf8');
const CURSOR_KEY_DOMAIN = Buffer.from('kodex-workspace-pagination-key-v1\0', 'utf8');
const CURSOR_AAD = Buffer.from('kodex-workspace-pagination-v1', 'utf8');
const CURSOR_NONCE_BYTES = 12;
const CURSOR_TAG_BYTES = 16;
const INVITATION_TOKEN_ATTEMPTS = 3;

export interface WorkspaceInvitationOptions {
  cursorSecret: Buffer;
  emailDeliveryEnabled?: boolean;
  pendingLimit?: number;
  ttlMs?: number;
}

interface MemberCursorPayload {
  id: string;
  joinedAt: string;
  kind: 'members';
  version: 1;
  workspaceId: string;
}

interface InvitationCursorPayload {
  createdAt: string;
  id: string;
  kind: 'invitations';
  version: 1;
  workspaceId: string;
}

interface ArchivedWorkspaceCursorPayload {
  archivedAt: string;
  id: string;
  kind: 'archived_workspaces';
  userId: string;
  version: 1;
}

type WorkspaceCursorPayload = ArchivedWorkspaceCursorPayload | InvitationCursorPayload | MemberCursorPayload;

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 20 && value.length <= 40 && Number.isFinite(Date.parse(value));
}

function assertPageOptions(options: WorkspacePageOptions): void {
  if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > PRODUCT_WORKSPACE_PAGE_MAX_LIMIT) {
    throw new Error('Workspace page limit is out of bounds.');
  }
}

class WorkspaceCursorCodec {
  readonly #key: Buffer;

  constructor(secret: Buffer) {
    if (secret.length < 32) throw new Error('Workspace cursor secret must contain at least 32 bytes.');
    this.#key = createHmac('sha256', secret).update(CURSOR_KEY_DOMAIN).digest();
  }

  encode(payload: WorkspaceCursorPayload): string {
    const nonce = randomBytes(CURSOR_NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.#key, nonce);
    cipher.setAAD(CURSOR_AAD);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
    return Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]).toString('base64url');
  }

  decode(
    value: string | undefined,
    kind: InvitationCursorPayload['kind'] | MemberCursorPayload['kind'],
    workspaceId: string,
  ): InvitationCursorPayload | MemberCursorPayload | undefined {
    if (!value) return undefined;
    if (value.length > PRODUCT_WORKSPACE_CURSOR_MAX_CHARACTERS || !/^[A-Za-z0-9_-]+$/u.test(value)) {
      throw new WorkspaceCursorError();
    }
    try {
      const packed = Buffer.from(value, 'base64url');
      if (
        packed.toString('base64url') !== value
        || packed.length <= CURSOR_NONCE_BYTES + CURSOR_TAG_BYTES
      ) throw new WorkspaceCursorError();
      const nonce = packed.subarray(0, CURSOR_NONCE_BYTES);
      const tag = packed.subarray(packed.length - CURSOR_TAG_BYTES);
      const decipher = createDecipheriv('aes-256-gcm', this.#key, nonce);
      decipher.setAAD(CURSOR_AAD);
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([
        decipher.update(packed.subarray(CURSOR_NONCE_BYTES, -CURSOR_TAG_BYTES)),
        decipher.final(),
      ]).toString('utf8');
      const parsed = JSON.parse(plaintext) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new WorkspaceCursorError();
      const record = parsed as Record<string, unknown>;
      const timestampKey = kind === 'members' ? 'joinedAt' : 'createdAt';
      if (
        !exactKeys(record, [timestampKey, 'id', 'kind', 'version', 'workspaceId'])
        || record.version !== 1
        || record.kind !== kind
        || record.workspaceId !== workspaceId
        || !isUuid(record.workspaceId)
        || !isUuid(record.id)
        || !validTimestamp(record[timestampKey])
      ) throw new WorkspaceCursorError();
      return record as unknown as InvitationCursorPayload | MemberCursorPayload;
    } catch (error) {
      if (error instanceof WorkspaceCursorError) throw error;
      throw new WorkspaceCursorError();
    }
  }

  decodeArchived(value: string | undefined, userId: string): ArchivedWorkspaceCursorPayload | undefined {
    if (!value) return undefined;
    if (value.length > PRODUCT_WORKSPACE_CURSOR_MAX_CHARACTERS || !/^[A-Za-z0-9_-]+$/u.test(value)) {
      throw new WorkspaceCursorError();
    }
    try {
      const packed = Buffer.from(value, 'base64url');
      if (
        packed.toString('base64url') !== value
        || packed.length <= CURSOR_NONCE_BYTES + CURSOR_TAG_BYTES
      ) throw new WorkspaceCursorError();
      const nonce = packed.subarray(0, CURSOR_NONCE_BYTES);
      const tag = packed.subarray(packed.length - CURSOR_TAG_BYTES);
      const decipher = createDecipheriv('aes-256-gcm', this.#key, nonce);
      decipher.setAAD(CURSOR_AAD);
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([
        decipher.update(packed.subarray(CURSOR_NONCE_BYTES, -CURSOR_TAG_BYTES)),
        decipher.final(),
      ]).toString('utf8');
      const parsed = JSON.parse(plaintext) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new WorkspaceCursorError();
      const record = parsed as Record<string, unknown>;
      if (
        !exactKeys(record, ['archivedAt', 'id', 'kind', 'userId', 'version'])
        || record.version !== 1
        || record.kind !== 'archived_workspaces'
        || record.userId !== userId
        || !isUuid(record.userId)
        || !isUuid(record.id)
        || !validTimestamp(record.archivedAt)
      ) throw new WorkspaceCursorError();
      return record as unknown as ArchivedWorkspaceCursorPayload;
    } catch (error) {
      if (error instanceof WorkspaceCursorError) throw error;
      throw new WorkspaceCursorError();
    }
  }
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

function archivedWorkspace(row: ArchivedWorkspaceRow): ArchivedWorkspaceRecord {
  return {
    archivedAt: row.deleted_at,
    id: row.id,
    name: row.name,
    slug: row.slug,
  };
}

function postgresCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

async function lockWorkspace(client: PoolClient, workspaceId: string): Promise<{ id: string; name: string; slug: string }> {
  const result = await client.query<{ id: string; name: string; slug: string }>(
    'SELECT id, name, slug FROM workspaces WHERE id = $1 AND deleted_at IS NULL FOR UPDATE',
    [workspaceId],
  );
  if (!result.rowCount) throw new WorkspaceOperationError('forbidden');
  return result.rows[0];
}

async function roleFor(client: PoolClient, workspaceId: string, userId: string): Promise<WorkspaceRole> {
  const result = await client.query<{ role: WorkspaceRole }>(
    'SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2 FOR UPDATE',
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
  readonly #cursorCodec: WorkspaceCursorCodec;
  readonly #emailDeliveryEnabled: boolean;

  constructor(private readonly database: ProductDatabase, options: WorkspaceInvitationOptions) {
    this.#cursorCodec = new WorkspaceCursorCodec(options.cursorSecret);
    this.#pendingInvitationLimit = options.pendingLimit ?? 100;
    this.#invitationTtlMs = options.ttlMs ?? 7 * 24 * 60 * 60 * 1_000;
    this.#emailDeliveryEnabled = options.emailDeliveryEnabled ?? false;
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

  async renameWorkspace(actorUserId: string, workspaceId: string, name: string): Promise<WorkspaceRecord> {
    return this.database.transaction(async (client) => {
      const workspace = await lockWorkspace(client, workspaceId);
      const actorRole = await roleFor(client, workspaceId, actorUserId);
      requireManager(actorRole);
      const result = await client.query<{ id: string; name: string; slug: string }>(
        `UPDATE workspaces SET name = $2, updated_at = now()
         WHERE id = $1 AND deleted_at IS NULL
         RETURNING id, name, slug`,
        [workspace.id, name],
      );
      if (!result.rowCount) throw new WorkspaceOperationError('forbidden');
      await audit(
        client,
        workspaceId,
        actorUserId,
        'workspace.renamed',
        workspaceId,
        { operation: 'rename' },
        'workspace',
      );
      return { ...result.rows[0], role: actorRole };
    });
  }

  async archiveWorkspace(actorUserId: string, workspaceId: string, confirmationName: string): Promise<void> {
    await this.database.transaction(async (client) => {
      const workspace = await lockWorkspace(client, workspaceId);
      const actorRole = await roleFor(client, workspaceId, actorUserId);
      if (actorRole !== 'owner') throw new WorkspaceOperationError('forbidden');
      if (workspace.name !== confirmationName) throw new WorkspaceOperationError('confirmation_mismatch');
      await client.query(
        `UPDATE workspace_invitations SET revoked_at = now()
         WHERE workspace_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL`,
        [workspaceId],
      );
      const archived = await client.query(
        `UPDATE workspaces SET deleted_at = now(), updated_at = now()
         WHERE id = $1 AND deleted_at IS NULL`,
        [workspaceId],
      );
      if (archived.rowCount !== 1) throw new WorkspaceOperationError('forbidden');
      await audit(
        client,
        workspaceId,
        actorUserId,
        'workspace.archived',
        workspaceId,
        { operation: 'archive' },
        'workspace',
      );
    });
  }

  async listArchivedWorkspaces(
    actorUserId: string,
    options: WorkspacePageOptions,
  ): Promise<ArchivedWorkspacePage> {
    assertPageOptions(options);
    const cursor = this.#cursorCodec.decodeArchived(options.cursor, actorUserId);
    const result = await this.database.query<ArchivedWorkspaceRow>(
      `SELECT workspace.id, workspace.name, workspace.slug, workspace.deleted_at,
              workspace.deleted_at::text AS cursor_archived_at
       FROM workspaces workspace
       JOIN workspace_members actor
         ON actor.workspace_id = workspace.id
        AND actor.user_id = $1
        AND actor.role = 'owner'
       WHERE workspace.deleted_at IS NOT NULL
         AND workspace.purge_requested_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM data_lifecycle_jobs lifecycle_job
           WHERE lifecycle_job.target_workspace_id = workspace.id
              OR EXISTS (
                SELECT 1 FROM data_lifecycle_job_workspaces job_workspace
                WHERE job_workspace.job_id = lifecycle_job.id
                  AND job_workspace.workspace_id = workspace.id
              )
         )
         AND NOT EXISTS (
           SELECT 1 FROM data_lifecycle_local_targets local_target
           WHERE local_target.workspace_id = workspace.id
         )
         AND NOT EXISTS (
           SELECT 1 FROM data_legal_holds hold_record
           WHERE hold_record.released_at IS NULL AND (
             (hold_record.target_type = 'workspace' AND hold_record.target_workspace_id = workspace.id)
             OR
             (hold_record.target_type = 'user' AND hold_record.target_user_id IN (
               SELECT member.user_id FROM workspace_members member WHERE member.workspace_id = workspace.id
               UNION SELECT project.created_by_user_id FROM projects project
                 WHERE project.workspace_id = workspace.id AND project.created_by_user_id IS NOT NULL
               UNION SELECT thread_record.created_by_user_id FROM agent_threads thread_record
                 WHERE thread_record.workspace_id = workspace.id AND thread_record.created_by_user_id IS NOT NULL
               UNION SELECT source.created_by_user_id FROM knowledge_sources source
                 WHERE source.workspace_id = workspace.id
             ))
           )
         )
         AND ($2::timestamptz IS NULL
           OR (workspace.deleted_at, workspace.id) < ($2::timestamptz, $3::uuid))
       ORDER BY workspace.deleted_at DESC, workspace.id DESC
       LIMIT $4`,
      [actorUserId, cursor?.archivedAt ?? null, cursor?.id ?? null, options.limit + 1],
    );
    const hasMore = result.rows.length > options.limit;
    const rows = result.rows.slice(0, options.limit);
    const last = rows.at(-1);
    return {
      workspaces: rows.map(archivedWorkspace),
      ...(hasMore && last ? {
        nextCursor: this.#cursorCodec.encode({
          archivedAt: last.cursor_archived_at,
          id: last.id,
          kind: 'archived_workspaces',
          userId: actorUserId,
          version: 1,
        }),
      } : {}),
    };
  }

  async listMembers(
    actorUserId: string,
    workspaceId: string,
    options: WorkspacePageOptions,
  ): Promise<WorkspaceMemberPage> {
    assertPageOptions(options);
    const cursor = this.#cursorCodec.decode(options.cursor, 'members', workspaceId) as MemberCursorPayload | undefined;
    return this.database.transaction(async (client) => {
      const access = await client.query(
        `SELECT actor.role FROM workspace_members actor
         JOIN workspaces workspace ON workspace.id = actor.workspace_id AND workspace.deleted_at IS NULL
         WHERE actor.workspace_id = $1 AND actor.user_id = $2
         FOR SHARE OF actor, workspace`,
        [workspaceId, actorUserId],
      );
      if (!access.rowCount) throw new WorkspaceOperationError('forbidden');
      const result = await client.query<MemberRow>(
        `SELECT wm.user_id, u.email, u.display_name, wm.role, wm.joined_at,
                wm.joined_at::text AS cursor_joined_at
         FROM workspace_members wm
         JOIN users u ON u.id = wm.user_id AND u.status = 'active' AND u.deleted_at IS NULL
         WHERE wm.workspace_id = $1
           AND ($2::timestamptz IS NULL OR (wm.joined_at, wm.user_id) > ($2::timestamptz, $3::uuid))
         ORDER BY wm.joined_at, wm.user_id
         LIMIT $4`,
        [workspaceId, cursor?.joinedAt ?? null, cursor?.id ?? null, options.limit + 1],
      );
      const hasMore = result.rows.length > options.limit;
      const rows = result.rows.slice(0, options.limit);
      const last = rows.at(-1);
      return {
        members: rows.map(member),
        ...(hasMore && last ? {
          nextCursor: this.#cursorCodec.encode({
            version: 1,
            kind: 'members',
            workspaceId,
            joinedAt: last.cursor_joined_at,
            id: last.user_id,
          }),
        } : {}),
      };
    });
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
      // Delivery-enabled invitations do not mint a usable raw token here. The
      // worker replaces this collision-resistant placeholder with the hash of
      // the transient token immediately before calling the provider.
      const token = this.#emailDeliveryEnabled
        ? undefined
        : randomBytes(WORKSPACE_INVITATION_TOKEN_BYTES).toString('base64url');
      const tokenHash = token
        ? hashWorkspaceInvitationToken(token)
        : randomBytes(WORKSPACE_INVITATION_TOKEN_BYTES);
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
          if (this.#emailDeliveryEnabled) {
            await client.query(
              `INSERT INTO email_delivery_jobs (kind, invitation_id)
               VALUES ('workspace_invitation', $1)`,
              [created.id],
            );
          }
          await audit(client, workspaceId, actorUserId, 'workspace.invitation_created', created.id, { role }, 'workspace_invitation');
          return this.#emailDeliveryEnabled
            ? { invitation: created, deliveryStatus: 'pending' as const }
            : { invitation: created, token: token! };
        });
      } catch (error) {
        if (postgresCode(error) === '23505' && attempt + 1 < INVITATION_TOKEN_ATTEMPTS) continue;
        throw error;
      }
    }
    throw new Error('Workspace invitation token generation failed.');
  }

  async listInvitations(
    actorUserId: string,
    workspaceId: string,
    options: WorkspacePageOptions,
  ): Promise<WorkspaceInvitationPage> {
    assertPageOptions(options);
    const cursor = this.#cursorCodec.decode(options.cursor, 'invitations', workspaceId) as InvitationCursorPayload | undefined;
    return this.database.transaction(async (client) => {
      const access = await client.query<{ role: WorkspaceRole }>(
        `SELECT actor.role FROM workspace_members actor
         JOIN workspaces workspace ON workspace.id = actor.workspace_id AND workspace.deleted_at IS NULL
         WHERE actor.workspace_id = $1 AND actor.user_id = $2
         FOR SHARE OF actor, workspace`,
        [workspaceId, actorUserId],
      );
      const actorRole = access.rows[0]?.role;
      if (!actorRole) throw new WorkspaceOperationError('forbidden');
      requireManager(actorRole);
      const result = await client.query<InvitationRow>(
        `SELECT id, workspace_id, target_email, requested_role, created_by_user_id, expires_at, created_at,
                created_at::text AS cursor_created_at
         FROM workspace_invitations
         WHERE workspace_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()
           AND ($2::timestamptz IS NULL OR (created_at, id) > ($2::timestamptz, $3::uuid))
         ORDER BY created_at, id
         LIMIT $4`,
        [workspaceId, cursor?.createdAt ?? null, cursor?.id ?? null, options.limit + 1],
      );
      const hasMore = result.rows.length > options.limit;
      const rows = result.rows.slice(0, options.limit);
      const last = rows.at(-1);
      return {
        invitations: rows.map(invitation),
        ...(hasMore && last?.cursor_created_at ? {
          nextCursor: this.#cursorCodec.encode({
            version: 1,
            kind: 'invitations',
            workspaceId,
            createdAt: last.cursor_created_at,
            id: last.id,
          }),
        } : {}),
      };
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
      try {
        await lockWorkspace(client, workspaceId);
      } catch (error) {
        if (error instanceof WorkspaceOperationError) throw new WorkspaceInvitationError('invalid');
        throw error;
      }
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
