import type { ProductDatabase } from './database.js';
import type {
  AuthContext,
  AuthSession,
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
  requireEmailVerification?: boolean;
  sessionExpiresAt: Date;
  sessionTokenHash: Buffer;
  workspaceName: string;
  workspaceSlug: string;
}

export interface LoginCredential {
  emailVerified?: boolean;
  passwordHash: string;
  user: AuthUser;
}

export interface CreateSessionInput {
  credentialHash: string;
  expiresAt: Date;
  tokenHash: Buffer;
  userId: string;
}

export interface AuthRepository {
  changePassword(input: ChangePasswordInput): Promise<number>;
  createSession(input: CreateSessionInput): Promise<AuthContext>;
  findAuthContext(tokenHash: Buffer): Promise<AuthContext | undefined>;
  findLoginCredential(email: string): Promise<LoginCredential | undefined>;
  listSessions(userId: string, currentSessionId: string): Promise<AuthSession[]>;
  registerAccount(input: RegisterAccountInput): Promise<RegistrationRecord>;
  revokeAllSessions(userId: string, currentSessionId: string): Promise<number>;
  revokeOtherSessions(userId: string, currentSessionId: string): Promise<number>;
  revokeSession(tokenHash: Buffer): Promise<boolean>;
  revokeSessionById(userId: string, sessionId: string, currentSessionId: string): Promise<boolean>;
  updatePasswordHash(userId: string, previousHash: string, nextHash: string): Promise<void>;
}

export interface ChangePasswordInput {
  currentSessionId: string;
  nextPasswordHash: string;
  userId: string;
  verifyCurrentPassword(passwordHash: string): Promise<boolean>;
}

export class RegistrationConflictError extends Error {
  constructor() {
    super('Registration could not be completed');
    this.name = 'RegistrationConflictError';
  }
}

export class PasswordChangeRejectedError extends Error {
  constructor() {
    super('Password could not be changed');
    this.name = 'PasswordChangeRejectedError';
  }
}

export class SessionNotFoundError extends Error {
  constructor() {
    super('Session was not found');
    this.name = 'SessionNotFoundError';
  }
}

export class LoginCredentialChangedError extends Error {
  constructor() {
    super('Login credential changed during authentication');
    this.name = 'LoginCredentialChangedError';
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
  email_verified_at: Date | null;
  password_hash: string;
}

interface SessionRow {
  created_at: Date;
  expires_at: Date;
  id: string;
  last_seen_at: Date | null;
  revoked_at: Date | null;
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
          `INSERT INTO users (email, display_name, email_verified_at)
           VALUES ($1, $2, CASE WHEN $3::boolean THEN NULL ELSE now() END)
           RETURNING id, email, display_name, created_at`,
          [input.email, input.displayName, Boolean(input.requireEmailVerification)],
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

        if (input.requireEmailVerification) {
          await client.query(
            `INSERT INTO email_delivery_jobs (kind, user_id)
             VALUES ('email_verification', $1)`,
            [user.id],
          );
        }

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
      `SELECT u.id, u.email, u.display_name, u.created_at, u.email_verified_at, c.password_hash
       FROM users u
       JOIN password_credentials c ON c.user_id = u.id
       WHERE u.email = $1
         AND u.status = 'active'
         AND u.deleted_at IS NULL
       LIMIT 1`,
      [email],
    );
    const row = result.rows[0];
    return row ? {
      user: userFromRow(row),
      passwordHash: row.password_hash,
      emailVerified: row.email_verified_at !== null,
    } : undefined;
  }

  async changePassword(input: ChangePasswordInput): Promise<number> {
    return this.database.transaction(async (client) => {
      const account = await client.query(
        `SELECT id FROM users
         WHERE id = $1 AND status = 'active' AND deleted_at IS NULL
         FOR UPDATE`,
        [input.userId],
      );
      if ((account.rowCount ?? 0) !== 1) throw new PasswordChangeRejectedError();
      const currentSession = await client.query(
        `SELECT id FROM auth_sessions
         WHERE id = $1 AND user_id = $2
           AND revoked_at IS NULL AND expires_at > now()
         FOR UPDATE`,
        [input.currentSessionId, input.userId],
      );
      if ((currentSession.rowCount ?? 0) !== 1) throw new PasswordChangeRejectedError();
      const credential = await client.query<{ password_hash: string }>(
        `SELECT password_hash
         FROM password_credentials
         WHERE user_id = $1
         FOR UPDATE`,
        [input.userId],
      );
      const row = credential.rows[0];
      if (!row || !await input.verifyCurrentPassword(row.password_hash)) {
        throw new PasswordChangeRejectedError();
      }

      await client.query(
        `UPDATE password_credentials
         SET password_hash = $2, updated_at = now()
         WHERE user_id = $1`,
        [input.userId, input.nextPasswordHash],
      );
      const revoked = await client.query(
        `UPDATE auth_sessions
         SET revoked_at = COALESCE(revoked_at, now())
         WHERE user_id = $1
           AND id <> $2
           AND revoked_at IS NULL
           AND expires_at > now()`,
        [input.userId, input.currentSessionId],
      );
      await client.query(
        `INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, details)
         VALUES ($1, 'password_changed', 'account', $2, $3::jsonb)`,
        [
          input.userId,
          input.userId,
          JSON.stringify({ revokedSessionCount: revoked.rowCount ?? 0 }),
        ],
      );
      return revoked.rowCount ?? 0;
    });
  }

  async createSession(input: CreateSessionInput): Promise<AuthContext> {
    const sessionResult = await this.database.transaction(async (client) => {
      await client.query('SELECT id FROM users WHERE id = $1 FOR KEY SHARE', [input.userId]);
      const credential = await client.query(
        `SELECT user_id
         FROM password_credentials
         WHERE user_id = $1 AND password_hash = $2
         FOR SHARE`,
        [input.userId, input.credentialHash],
      );
      if ((credential.rowCount ?? 0) !== 1) throw new LoginCredentialChangedError();
      return client.query<{ expires_at: Date; id: string }>(
        `INSERT INTO auth_sessions (user_id, token_hash, expires_at)
         VALUES ($1, $2, $3)
         RETURNING id, expires_at`,
        [input.userId, input.tokenHash, input.expiresAt],
      );
    });
    const context = await this.#findAuthContext(input.tokenHash, false);
    if (!context) {
      throw new Error(`New session ${sessionResult.rows[0].id} could not be read`);
    }
    return context;
  }

  async findAuthContext(tokenHash: Buffer): Promise<AuthContext | undefined> {
    return this.#findAuthContext(tokenHash, true);
  }

  async #findAuthContext(tokenHash: Buffer, requireVerified: boolean): Promise<AuthContext | undefined> {
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
         AND ($2::boolean = false OR u.email_verified_at IS NOT NULL)
       ORDER BY w.created_at, w.id`,
      [tokenHash, requireVerified],
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

  async listSessions(userId: string, currentSessionId: string): Promise<AuthSession[]> {
    const result = await this.database.query<SessionRow>(
      `SELECT id, created_at, last_seen_at, expires_at, revoked_at
       FROM auth_sessions
       WHERE user_id = $1
       ORDER BY (id = $2) DESC, created_at DESC, id DESC
       LIMIT 100`,
      [userId, currentSessionId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      current: row.id === currentSessionId,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
    }));
  }

  async revokeSession(tokenHash: Buffer): Promise<boolean> {
    return this.database.transaction(async (client) => {
      const candidate = await client.query<{ user_id: string }>(
        'SELECT user_id FROM auth_sessions WHERE token_hash = $1',
        [tokenHash],
      );
      if (!candidate.rows[0]) return false;
      await client.query('SELECT id FROM users WHERE id = $1 FOR KEY SHARE', [candidate.rows[0].user_id]);
      const session = await client.query<{ id: string; user_id: string }>(
        `SELECT id, user_id FROM auth_sessions WHERE token_hash = $1 FOR UPDATE`,
        [tokenHash],
      );
      const row = session.rows[0];
      if (!row) return false;
      const result = await client.query(
        `UPDATE auth_sessions
         SET revoked_at = COALESCE(revoked_at, now())
         WHERE id = $1 AND revoked_at IS NULL`,
        [row.id],
      );
      if ((result.rowCount ?? 0) > 0) {
        await client.query(
          `INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, details)
           VALUES ($1, 'session_revoked', 'auth_session', $2, '{"reason":"logout"}'::jsonb)`,
          [row.user_id, row.id],
        );
      }
      return (result.rowCount ?? 0) > 0;
    });
  }

  async revokeSessionById(
    userId: string,
    sessionId: string,
    currentSessionId: string,
  ): Promise<boolean> {
    return this.database.transaction(async (client) => {
      await client.query('SELECT id FROM users WHERE id = $1 FOR KEY SHARE', [userId]);
      const session = await client.query<{ id: string; revoked_at: Date | null }>(
        `SELECT id, revoked_at
         FROM auth_sessions
         WHERE id = $1 AND user_id = $2
         FOR UPDATE`,
        [sessionId, userId],
      );
      const row = session.rows[0];
      if (!row) throw new SessionNotFoundError();
      if (row.revoked_at === null) {
        await client.query(
          'UPDATE auth_sessions SET revoked_at = now() WHERE id = $1',
          [sessionId],
        );
        await client.query(
          `INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, details)
           VALUES ($1, 'session_revoked', 'auth_session', $2, $3::jsonb)`,
          [userId, sessionId, JSON.stringify({ current: sessionId === currentSessionId })],
        );
      }
      return sessionId === currentSessionId;
    });
  }

  async revokeOtherSessions(userId: string, currentSessionId: string): Promise<number> {
    return this.#revokeSessions(userId, currentSessionId, false);
  }

  async revokeAllSessions(userId: string, currentSessionId: string): Promise<number> {
    return this.#revokeSessions(userId, currentSessionId, true);
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

  async #revokeSessions(
    userId: string,
    currentSessionId: string,
    includeCurrent: boolean,
  ): Promise<number> {
    return this.database.transaction(async (client) => {
      await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);
      const result = await client.query(
        `UPDATE auth_sessions
         SET revoked_at = COALESCE(revoked_at, now())
         WHERE user_id = $1
           AND ($3::boolean OR id <> $2)
           AND revoked_at IS NULL`,
        [userId, currentSessionId, includeCurrent],
      );
      await client.query(
        `INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, details)
         VALUES ($1, $2, 'account', $3, $4::jsonb)`,
        [
          userId,
          includeCurrent ? 'logout_all' : 'session_revoked',
          userId,
          JSON.stringify({
            scope: includeCurrent ? 'all' : 'other',
            revokedSessionCount: result.rowCount ?? 0,
          }),
        ],
      );
      return result.rowCount ?? 0;
    });
  }
}
