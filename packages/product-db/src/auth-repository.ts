import type { ProductDatabase } from './database.js';
import type {
  AuthContext,
  AuthUser,
  WorkspaceMembership,
  WorkspaceRole,
} from './auth-types.js';

export interface RegistrationRecord {
  context: AuthContext;
  defaultWorkspace: WorkspaceMembership;
}

export interface RegisterAccountInput {
  displayName: string | null;
  email: string;
  passwordHash: string;
  sessionExpiresAt: Date;
  sessionTokenHash: Buffer;
  workspaceName: string;
  workspaceSlug: string;
}

export interface LoginCredential {
  passwordHash: string;
  user: AuthUser;
}

export interface CreateSessionInput {
  expiresAt: Date;
  tokenHash: Buffer;
  userId: string;
}

export interface AuthRepository {
  createSession(input: CreateSessionInput): Promise<AuthContext>;
  findAuthContext(tokenHash: Buffer): Promise<AuthContext | undefined>;
  findLoginCredential(email: string): Promise<LoginCredential | undefined>;
  registerAccount(input: RegisterAccountInput): Promise<RegistrationRecord>;
  revokeSession(tokenHash: Buffer): Promise<boolean>;
  updatePasswordHash(userId: string, previousHash: string, nextHash: string): Promise<void>;
}

export class RegistrationConflictError extends Error {
  constructor() {
    super('Registration could not be completed');
    this.name = 'RegistrationConflictError';
  }
}

interface UserRow {
  created_at: Date;
  display_name: string | null;
  email: string;
  id: string;
}

interface WorkspaceRow {
  id: string;
  name: string;
  role: WorkspaceRole;
  slug: string;
}

interface SessionContextRow extends UserRow {
  expires_at: Date;
  role: WorkspaceRole | null;
  session_id: string;
  workspace_id: string | null;
  workspace_name: string | null;
  workspace_slug: string | null;
}

interface CredentialRow extends UserRow {
  password_hash: string;
}

function userFromRow(row: UserRow): AuthUser {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    createdAt: row.created_at,
  };
}

function contextFromRows(rows: SessionContextRow[]): AuthContext | undefined {
  const first = rows[0];
  if (!first) {
    return undefined;
  }
  const memberships: WorkspaceMembership[] = [];
  for (const row of rows) {
    if (
      row.workspace_id
      && row.workspace_slug
      && row.workspace_name
      && row.role
    ) {
      memberships.push({
        id: row.workspace_id,
        slug: row.workspace_slug,
        name: row.workspace_name,
        role: row.role,
      });
    }
  }
  return {
    sessionId: first.session_id,
    expiresAt: first.expires_at,
    user: userFromRow(first),
    memberships,
  };
}

function postgresErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

export class PostgresAuthRepository implements AuthRepository {
  constructor(private readonly database: ProductDatabase) {}

  async registerAccount(input: RegisterAccountInput): Promise<RegistrationRecord> {
    try {
      return await this.database.transaction(async (client) => {
        const userResult = await client.query<UserRow>(
          `INSERT INTO users (email, display_name)
           VALUES ($1, $2)
           RETURNING id, email, display_name, created_at`,
          [input.email, input.displayName],
        );
        const user = userFromRow(userResult.rows[0]);

        await client.query(
          `INSERT INTO password_credentials (user_id, password_hash)
           VALUES ($1, $2)`,
          [user.id, input.passwordHash],
        );

        const workspaceResult = await client.query<WorkspaceRow>(
          `INSERT INTO workspaces (slug, name, owner_user_id)
           VALUES ($1, $2, $3)
           RETURNING id, slug, name, 'owner'::text AS role`,
          [input.workspaceSlug, input.workspaceName, user.id],
        );
        const defaultWorkspace = workspaceResult.rows[0];

        await client.query(
          `INSERT INTO workspace_members (workspace_id, user_id, role)
           VALUES ($1, $2, 'owner')`,
          [defaultWorkspace.id, user.id],
        );

        const sessionResult = await client.query<{ expires_at: Date; id: string }>(
          `INSERT INTO auth_sessions (user_id, token_hash, expires_at)
           VALUES ($1, $2, $3)
           RETURNING id, expires_at`,
          [user.id, input.sessionTokenHash, input.sessionExpiresAt],
        );

        return {
          defaultWorkspace,
          context: {
            user,
            memberships: [defaultWorkspace],
            sessionId: sessionResult.rows[0].id,
            expiresAt: sessionResult.rows[0].expires_at,
          },
        };
      });
    } catch (error) {
      if (postgresErrorCode(error) === '23505') {
        throw new RegistrationConflictError();
      }
      throw error;
    }
  }

  async findLoginCredential(email: string): Promise<LoginCredential | undefined> {
    const result = await this.database.query<CredentialRow>(
      `SELECT u.id, u.email, u.display_name, u.created_at, c.password_hash
       FROM users u
       JOIN password_credentials c ON c.user_id = u.id
       WHERE u.email = $1
         AND u.status = 'active'
         AND u.deleted_at IS NULL
       LIMIT 1`,
      [email],
    );
    const row = result.rows[0];
    return row ? { user: userFromRow(row), passwordHash: row.password_hash } : undefined;
  }

  async createSession(input: CreateSessionInput): Promise<AuthContext> {
    const sessionResult = await this.database.query<{ expires_at: Date; id: string }>(
      `INSERT INTO auth_sessions (user_id, token_hash, expires_at)
       VALUES ($1, $2, $3)
       RETURNING id, expires_at`,
      [input.userId, input.tokenHash, input.expiresAt],
    );
    const context = await this.findAuthContext(input.tokenHash);
    if (!context) {
      throw new Error(`New session ${sessionResult.rows[0].id} could not be read`);
    }
    return context;
  }

  async findAuthContext(tokenHash: Buffer): Promise<AuthContext | undefined> {
    const result = await this.database.query<SessionContextRow>(
      `SELECT
         s.id AS session_id,
         s.expires_at,
         u.id,
         u.email,
         u.display_name,
         u.created_at,
         w.id AS workspace_id,
         w.slug AS workspace_slug,
         w.name AS workspace_name,
         wm.role
       FROM auth_sessions s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN workspace_members wm ON wm.user_id = u.id
       LEFT JOIN workspaces w
         ON w.id = wm.workspace_id
        AND w.deleted_at IS NULL
       WHERE s.token_hash = $1
         AND s.revoked_at IS NULL
         AND s.expires_at > now()
         AND u.status = 'active'
         AND u.deleted_at IS NULL
       ORDER BY w.created_at, w.id`,
      [tokenHash],
    );
    const context = contextFromRows(result.rows);
    if (context) {
      await this.database.query(
        `UPDATE auth_sessions
         SET last_seen_at = now()
         WHERE id = $1
           AND revoked_at IS NULL
           AND expires_at > now()`,
        [context.sessionId],
      );
    }
    return context;
  }

  async revokeSession(tokenHash: Buffer): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE auth_sessions
       SET revoked_at = COALESCE(revoked_at, now())
       WHERE token_hash = $1
         AND revoked_at IS NULL`,
      [tokenHash],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async updatePasswordHash(
    userId: string,
    previousHash: string,
    nextHash: string,
  ): Promise<void> {
    await this.database.query(
      `UPDATE password_credentials
       SET password_hash = $3, updated_at = now()
       WHERE user_id = $1 AND password_hash = $2`,
      [userId, previousHash, nextHash],
    );
  }
}
