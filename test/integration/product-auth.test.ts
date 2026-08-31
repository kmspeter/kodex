import { randomBytes, randomUUID } from 'node:crypto';
import {
  Argon2idPasswordHasher,
  AuthService,
  hashSessionToken,
  PostgresAuthRepository,
  RegistrationConflictError,
  requireProductDatabaseFromEnv,
  type ProductDatabase,
} from '@kodex/product-db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ProductApiConfig } from '../../apps/api/src/config.js';
import {
  csrfCookieName,
  sessionCookieName,
} from '../../apps/api/src/cookies.js';
import { ProductApiServer } from '../../apps/api/src/server.js';

const allowedOrigin = 'http://127.0.0.1:5173';
const validPassword = 'correct horse battery staple';
const runPrefix = `auth-it-${randomUUID()}`;
let accountSequence = 0;

interface CookieSession {
  cookieHeader: string;
  csrfToken: string;
  sessionToken: string;
  setCookies: string[];
}

interface RegistrationResponse {
  body: {
    csrfToken: string;
    defaultWorkspace: { id: string; role: string; slug: string };
    user: { email: string; id: string };
  };
  cookies: CookieSession;
  response: Response;
}

function nextEmail(label: string): string {
  accountSequence += 1;
  return `${runPrefix}-${label}-${accountSequence}@example.invalid`;
}

function getSetCookies(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  return headers.getSetCookie?.() ?? [response.headers.get('set-cookie') ?? ''].filter(Boolean);
}

function cookieSession(response: Response): CookieSession {
  const setCookies = getSetCookies(response);
  const pairs = setCookies.map((entry) => entry.split(';', 1)[0]);
  const values = new Map(pairs.map((pair) => {
    const separator = pair.indexOf('=');
    return [pair.slice(0, separator), decodeURIComponent(pair.slice(separator + 1))];
  }));
  const sessionToken = values.get(sessionCookieName);
  const csrfToken = values.get(csrfCookieName);
  if (!sessionToken || !csrfToken) {
    throw new Error('Authentication response did not set both required cookies');
  }
  return {
    setCookies,
    sessionToken,
    csrfToken,
    cookieHeader: pairs.join('; '),
  };
}

describe('PostgreSQL product authentication API', () => {
  let database: ProductDatabase;
  let repository: PostgresAuthRepository;
  let passwordHasher: Argon2idPasswordHasher;
  let server: ProductApiServer;
  let baseUrl: string;

  beforeAll(async () => {
    database = requireProductDatabaseFromEnv();
    await database.migrate();
    repository = new PostgresAuthRepository(database);
    passwordHasher = new Argon2idPasswordHasher();
    const config: ProductApiConfig = {
      host: '127.0.0.1',
      port: 0,
      allowedHosts: new Set(),
      allowedOrigins: new Set([allowedOrigin]),
      cookieSecret: Buffer.alloc(32, 19),
      secureCookies: false,
      sessionTtlMs: 60 * 60 * 1_000,
      maxBodyBytes: 65_536,
    };
    const auth = await AuthService.create(repository, passwordHasher, {
      sessionTtlMs: config.sessionTtlMs,
    });
    server = new ProductApiServer(auth, config);
    const port = await server.listen();
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await server?.close();
    if (database) {
      await database.query(
        `DELETE FROM workspaces
         WHERE owner_user_id IN (
           SELECT id FROM users WHERE email LIKE $1
         )`,
        [`${runPrefix}-%`],
      );
      await database.query('DELETE FROM users WHERE email LIKE $1', [`${runPrefix}-%`]);
      await database.close();
    }
  });

  async function postJson(
    path: string,
    body: unknown,
    options: { cookie?: string; csrf?: string; origin?: string | null } = {},
  ): Promise<Response> {
    const headers = new Headers({ 'Content-Type': 'application/json' });
    const origin = options.origin === undefined ? allowedOrigin : options.origin;
    if (origin) headers.set('Origin', origin);
    if (options.cookie) headers.set('Cookie', options.cookie);
    if (options.csrf) headers.set('X-CSRF-Token', options.csrf);
    return fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  }

  async function register(email: string, password = validPassword): Promise<RegistrationResponse> {
    const response = await postJson('/api/auth/register', {
      email,
      password,
      displayName: 'Integration User',
    });
    const body = await response.json() as RegistrationResponse['body'];
    return { response, body, cookies: cookieSession(response) };
  }

  it('atomically creates a user, Argon2id credential, default workspace, owner membership, and hash-only session', async () => {
    const email = nextEmail('success');
    const registration = await register(`  ${email.toUpperCase()}  `);

    expect(registration.response.status).toBe(201);
    expect(registration.body.user.email).toBe(email);
    expect(registration.body.csrfToken).toBe(registration.cookies.csrfToken);
    expect(registration.body.defaultWorkspace).toMatchObject({ role: 'owner' });
    expect(registration.body.defaultWorkspace.slug).toMatch(/^personal-[0-9a-f-]{36}$/u);

    const records = await database.query<{
      member_role: string;
      password_hash: string;
      session_hash: Buffer;
      workspace_id: string;
    }>(
      `SELECT
         c.password_hash,
         w.id AS workspace_id,
         wm.role AS member_role,
         s.token_hash AS session_hash
       FROM users u
       JOIN password_credentials c ON c.user_id = u.id
       JOIN workspaces w ON w.owner_user_id = u.id
       JOIN workspace_members wm ON wm.workspace_id = w.id AND wm.user_id = u.id
       JOIN auth_sessions s ON s.user_id = u.id
       WHERE u.email = $1`,
      [email],
    );
    expect(records.rows).toHaveLength(1);
    expect(records.rows[0]).toMatchObject({ member_role: 'owner' });
    expect(records.rows[0].password_hash).toMatch(/^\$argon2id\$/u);
    expect(records.rows[0].password_hash).not.toContain(validPassword);
    expect(records.rows[0].session_hash).toEqual(hashSessionToken(registration.cookies.sessionToken));
    expect(records.rows[0].session_hash).toHaveLength(32);

    const sessionCookie = registration.cookies.setCookies.find(
      (entry) => entry.startsWith(`${sessionCookieName}=`),
    );
    const csrfCookie = registration.cookies.setCookies.find(
      (entry) => entry.startsWith(`${csrfCookieName}=`),
    );
    expect(sessionCookie).toContain('HttpOnly');
    expect(sessionCookie).toContain('SameSite=Strict');
    expect(sessionCookie).toContain('Path=/');
    expect(sessionCookie).toContain('Max-Age=');
    expect(sessionCookie).toContain('Expires=');
    expect(csrfCookie).not.toContain('HttpOnly');
  });

  it('rolls back every registration row when a later workspace constraint fails', async () => {
    const workspaceSlug = `collision-${randomUUID()}`;
    const existingEmail = nextEmail('atomic-existing');
    const rolledBackEmail = nextEmail('atomic-rollback');
    const passwordHash = await passwordHasher.hash(validPassword);
    const expiresAt = new Date(Date.now() + 60 * 60 * 1_000);

    await repository.registerAccount({
      email: existingEmail,
      displayName: null,
      passwordHash,
      workspaceName: 'Existing workspace',
      workspaceSlug,
      sessionTokenHash: hashSessionToken(randomBytes(32).toString('base64url')),
      sessionExpiresAt: expiresAt,
    });
    await expect(repository.registerAccount({
      email: rolledBackEmail,
      displayName: null,
      passwordHash,
      workspaceName: 'Must roll back',
      workspaceSlug,
      sessionTokenHash: hashSessionToken(randomBytes(32).toString('base64url')),
      sessionExpiresAt: expiresAt,
    })).rejects.toBeInstanceOf(RegistrationConflictError);

    const rolledBack = await database.query<{ users: string }>(
      `SELECT count(*) AS users
       FROM users
       WHERE email = $1`,
      [rolledBackEmail],
    );
    expect(rolledBack.rows[0].users).toBe('0');
  });

  it('rejects normalized duplicate email without exposing a SQL constraint', async () => {
    const email = nextEmail('duplicate');
    expect((await register(email)).response.status).toBe(201);

    const duplicate = await postJson('/api/auth/register', {
      email: ` ${email.toUpperCase()} `,
      password: validPassword,
      displayName: 'Duplicate',
    });
    expect(duplicate.status).toBe(400);
    expect(await duplicate.json()).toEqual({
      ok: false,
      error: { code: 'registration_failed', message: 'Account could not be created.' },
    });
    const count = await database.query<{ count: string }>(
      'SELECT count(*) FROM users WHERE email = $1',
      [email],
    );
    expect(count.rows[0].count).toBe('1');
  });

  it('returns one generic response for a wrong password and an unknown email', async () => {
    const email = nextEmail('login');
    await register(email);
    const wrong = await postJson('/api/auth/login', { email, password: 'wrong-password' });
    const unknown = await postJson('/api/auth/login', {
      email: nextEmail('unknown'),
      password: 'wrong-password',
    });

    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(await wrong.json()).toEqual(await unknown.json());
  });

  it('logs in and resolves the current user from the opaque cookie', async () => {
    const email = nextEmail('me');
    await register(email);
    const login = await postJson('/api/auth/login', { email, password: validPassword });
    const cookies = cookieSession(login);
    const loginBody = await login.json() as { csrfToken: string };

    expect(login.status).toBe(200);
    expect(loginBody.csrfToken).toBe(cookies.csrfToken);
    const me = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Cookie: cookies.cookieHeader },
    });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({
      csrfToken: cookies.csrfToken,
      user: { email },
      workspaces: [{ role: 'owner' }],
    });
  });

  it('rejects expired and revoked sessions', async () => {
    const expired = await register(nextEmail('expired'));
    await database.query(
      `UPDATE auth_sessions
       SET created_at = now() - interval '2 hours',
           expires_at = now() - interval '1 hour'
       WHERE token_hash = $1`,
      [hashSessionToken(expired.cookies.sessionToken)],
    );
    const expiredMe = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Cookie: expired.cookies.cookieHeader },
    });
    expect(expiredMe.status).toBe(401);

    const revoked = await register(nextEmail('revoked'));
    await database.query(
      'UPDATE auth_sessions SET revoked_at = now() WHERE token_hash = $1',
      [hashSessionToken(revoked.cookies.sessionToken)],
    );
    const revokedMe = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Cookie: revoked.cookies.cookieHeader },
    });
    expect(revokedMe.status).toBe(401);
  });

  it('requires Origin and HMAC CSRF proof before revoking a session on logout', async () => {
    const registration = await register(nextEmail('logout'));
    const rejected = await postJson('/api/auth/logout', {}, {
      cookie: registration.cookies.cookieHeader,
    });
    expect(rejected.status).toBe(403);

    const missingOrigin = await postJson('/api/auth/logout', {}, {
      cookie: registration.cookies.cookieHeader,
      csrf: registration.cookies.csrfToken,
      origin: null,
    });
    expect(missingOrigin.status).toBe(403);

    const logout = await postJson('/api/auth/logout', {}, {
      cookie: registration.cookies.cookieHeader,
      csrf: registration.cookies.csrfToken,
    });
    expect(logout.status).toBe(204);
    expect(getSetCookies(logout).every((cookie) => cookie.includes('Max-Age=0'))).toBe(true);

    const session = await database.query<{ revoked: boolean }>(
      'SELECT revoked_at IS NOT NULL AS revoked FROM auth_sessions WHERE token_hash = $1',
      [hashSessionToken(registration.cookies.sessionToken)],
    );
    expect(session.rows[0].revoked).toBe(true);
    const me = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Cookie: registration.cookies.cookieHeader },
    });
    expect(me.status).toBe(401);
  });

  it('rejects missing and untrusted origins before registration changes the database', async () => {
    const missingEmail = nextEmail('origin-missing');
    const foreignEmail = nextEmail('origin-foreign');
    const missing = await postJson('/api/auth/register', {
      email: missingEmail,
      password: validPassword,
    }, { origin: null });
    const foreign = await postJson('/api/auth/register', {
      email: foreignEmail,
      password: validPassword,
    }, { origin: 'https://attacker.example' });
    expect(missing.status).toBe(403);
    expect(foreign.status).toBe(403);

    const result = await database.query<{ count: string }>(
      'SELECT count(*) FROM users WHERE email = ANY($1::text[])',
      [[missingEmail, foreignEmail]],
    );
    expect(result.rows[0].count).toBe('0');
  });
});
