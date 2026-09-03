import { randomBytes, randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  Argon2idPasswordHasher,
  AuthService,
  hashSessionToken,
  loginRateLimitBucket,
  defaultMigrationsDirectory,
  migrateProductDatabase,
  PostgresAuthRepository,
  PostgresLoginRateLimiter,
  RegistrationConflictError,
  requireProductDatabaseFromEnv,
  type ProductDatabase,
} from '@kodex/product-db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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

interface SessionDto {
  createdAt: string;
  current: boolean;
  expiresAt: string;
  id: string;
  lastSeenAt: string | null;
  revoked: boolean;
  revokedAt: string | null;
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
  let upgradeDirectory: string | undefined;

  beforeAll(async () => {
    database = requireProductDatabaseFromEnv();
    const ledger = await database.query<{ present: boolean }>(
      "SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present",
    );
    if (!ledger.rows[0].present) {
      upgradeDirectory = await mkdtemp(path.join(os.tmpdir(), 'kodex-auth-upgrade-'));
      const firstFive = (await readdir(defaultMigrationsDirectory))
        .filter((name) => /^000[1-5]_.*\.sql$/u.test(name));
      for (const name of firstFive) {
        await copyFile(
          path.join(defaultMigrationsDirectory, name),
          path.join(upgradeDirectory, name),
        );
      }
      const legacy = await migrateProductDatabase(database.pool, upgradeDirectory);
      if (legacy.map((migration) => migration.version).join(',') !== '1,2,3,4,5') {
        throw new Error('Auth integration could not establish the 0001-0005 upgrade fixture');
      }
      const upgraded = await database.migrate();
      if (upgraded.map((migration) => migration.version).join(',') !== '6,7,8,9,10') {
        throw new Error('Auth integration did not apply migrations 0006-0010 during upgrade');
      }
    } else {
      await database.migrate();
    }
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
      loginRateLimitMaxAttempts: 20,
      loginRateLimitWindowMs: 900_000,
      loginRateLimitBlockMs: 900_000,
    };
    const auth = await AuthService.create(repository, passwordHasher, {
      sessionTtlMs: config.sessionTtlMs,
      loginRateLimitSecret: config.cookieSecret,
      loginRateLimiter: new PostgresLoginRateLimiter(database, {
        maxAttempts: config.loginRateLimitMaxAttempts,
        windowMs: config.loginRateLimitWindowMs,
        blockMs: config.loginRateLimitBlockMs,
      }),
    });
    server = new ProductApiServer(auth, config);
    const port = await server.listen();
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await server?.close();
    if (upgradeDirectory) await rm(upgradeDirectory, { recursive: true, force: true });
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

  async function securityRequest(
    path: string,
    method: 'DELETE' | 'PATCH' | 'POST',
    session: CookieSession,
    body?: unknown,
  ): Promise<Response> {
    const headers = new Headers({
      Origin: allowedOrigin,
      Cookie: session.cookieHeader,
      'X-CSRF-Token': session.csrfToken,
    });
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    return fetch(`${baseUrl}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }

  async function sessionList(session: CookieSession): Promise<SessionDto[]> {
    const response = await fetch(`${baseUrl}/api/auth/sessions`, {
      headers: { Cookie: session.cookieHeader },
    });
    expect(response.status).toBe(200);
    return (await response.json() as { sessions: SessionDto[] }).sessions;
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

  it('lists only safe session fields, revokes idempotently, hides cross-user IDs, and clears a current cookie', async () => {
    const email = nextEmail('sessions');
    const first = await register(email);
    const secondResponse = await postJson('/api/auth/login', { email, password: validPassword });
    const second = cookieSession(secondResponse);
    const sessions = await sessionList(second);
    expect(sessions).toHaveLength(2);
    expect(sessions.filter((session) => session.current)).toHaveLength(1);
    for (const session of sessions) {
      expect(Object.keys(session).sort()).toEqual([
        'createdAt', 'current', 'expiresAt', 'id', 'lastSeenAt', 'revoked', 'revokedAt',
      ]);
      expect(JSON.stringify(session)).not.toMatch(/token|cookie|csrf|password|ip|user.?agent/iu);
    }

    const firstId = sessions.find((session) => !session.current)!.id;
    const revoke = await securityRequest(`/api/auth/sessions/${firstId}`, 'DELETE', second);
    expect(revoke.status).toBe(204);
    expect((await securityRequest(`/api/auth/sessions/${firstId}`, 'DELETE', second)).status).toBe(204);
    expect((await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Cookie: first.cookies.cookieHeader },
    })).status).toBe(401);

    const foreign = await register(nextEmail('sessions-foreign'));
    const foreignId = (await sessionList(foreign.cookies)).find((session) => session.current)!.id;
    const hidden = await securityRequest(`/api/auth/sessions/${foreignId}`, 'DELETE', second);
    expect(hidden.status).toBe(404);
    expect(await hidden.json()).toEqual({
      ok: false,
      error: { code: 'not_found', message: 'Not found.' },
    });

    const currentId = (await sessionList(second)).find((session) => session.current)!.id;
    const currentRevoke = await securityRequest(`/api/auth/sessions/${currentId}`, 'DELETE', second);
    expect(currentRevoke.status).toBe(204);
    expect(getSetCookies(currentRevoke).every((cookie) => cookie.includes('Max-Age=0'))).toBe(true);
    expect((await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Cookie: second.cookieHeader },
    })).status).toBe(401);
  });

  it('changes a locked account password, keeps the current session, revokes others, and audits no secrets', async () => {
    const email = nextEmail('password-change');
    const original = await register(email);
    const currentResponse = await postJson('/api/auth/login', { email, password: validPassword });
    const current = cookieSession(currentResponse);
    const newPassword = 'a different secure password';

    const missingOrigin = await fetch(`${baseUrl}/api/auth/password`, {
      method: 'PATCH',
      headers: {
        Cookie: current.cookieHeader,
        'X-CSRF-Token': current.csrfToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ currentPassword: validPassword, newPassword }),
    });
    expect(missingOrigin.status).toBe(403);
    const wrong = await securityRequest('/api/auth/password', 'PATCH', current, {
      currentPassword: 'incorrect current password',
      newPassword,
    });
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toEqual({
      ok: false,
      error: { code: 'password_change_failed', message: 'Password could not be changed.' },
    });

    const changed = await securityRequest('/api/auth/password', 'PATCH', current, {
      currentPassword: validPassword,
      newPassword,
    });
    expect(changed.status).toBe(204);
    expect((await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Cookie: current.cookieHeader },
    })).status).toBe(200);
    expect((await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Cookie: original.cookies.cookieHeader },
    })).status).toBe(401);
    expect((await postJson('/api/auth/login', { email, password: validPassword })).status).toBe(401);
    expect((await postJson('/api/auth/login', { email, password: newPassword })).status).toBe(200);

    const audit = await database.query<{
      action: string; details: unknown; ip_address: string | null; serialized: string; user_agent: string | null;
    }>(
      `SELECT action, details, details::text AS serialized, ip_address, user_agent
       FROM audit_logs
       WHERE actor_user_id = $1 AND action = 'password_changed'`,
      [(await database.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [email])).rows[0].id],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].details).toEqual({ revokedSessionCount: 1 });
    expect(audit.rows[0].serialized).not.toContain(validPassword);
    expect(audit.rows[0].serialized).not.toContain(newPassword);
    expect(audit.rows[0].serialized).not.toMatch(/token|hash|password|ip|user.?agent/iu);
    expect(audit.rows[0].ip_address).toBeNull();
    expect(audit.rows[0].user_agent).toBeNull();
  });

  it('revokes other sessions separately and logout-all revokes current with exact cookie expiry', async () => {
    const email = nextEmail('logout-all');
    const first = await register(email);
    const currentResponse = await postJson('/api/auth/login', { email, password: validPassword });
    const current = cookieSession(currentResponse);
    expect((await securityRequest('/api/auth/sessions', 'DELETE', current)).status).toBe(204);
    expect((await fetch(`${baseUrl}/api/auth/me`, { headers: { Cookie: first.cookies.cookieHeader } })).status).toBe(401);
    expect((await fetch(`${baseUrl}/api/auth/me`, { headers: { Cookie: current.cookieHeader } })).status).toBe(200);

    const all = await securityRequest('/api/auth/logout-all', 'POST', current, {});
    expect(all.status).toBe(204);
    expect(getSetCookies(all).every((cookie) => cookie.includes('Max-Age=0'))).toBe(true);
    expect((await fetch(`${baseUrl}/api/auth/me`, { headers: { Cookie: current.cookieHeader } })).status).toBe(401);
    const actions = await database.query<{ action: string }>(
      `SELECT action FROM audit_logs
       WHERE actor_user_id = (SELECT id FROM users WHERE email = $1)
       ORDER BY id`,
      [email],
    );
    expect(actions.rows.map((row) => row.action)).toContain('logout_all');
  });

  it('serializes concurrent HMAC-only limiter failures and expires windows and blocks without sleep', async () => {
    const secret = Buffer.alloc(32, 43);
    const rawEmail = `${runPrefix}-limiter@example.invalid`;
    const rawAddress = '203.0.113.42';
    const emailBucket = loginRateLimitBucket(secret, 'email', rawEmail);
    const addressBucket = loginRateLimitBucket(secret, 'address', rawAddress);
    const limiter = new PostgresLoginRateLimiter(database, {
      maxAttempts: 3, windowMs: 60_000, blockMs: 30_000,
    });
    const start = new Date('2030-01-01T00:00:00.000Z');
    let verifications = 0;
    const results = await Promise.all(Array.from({ length: 6 }, () => limiter.run(
      [emailBucket, addressBucket], [emailBucket], start,
      async () => { verifications += 1; return false; },
    )));
    expect(verifications).toBe(3);
    expect(results.filter((result) => !result.allowed)).toHaveLength(4);
    expect(results.filter((result) => result.retryAfterSeconds === 30)).toHaveLength(4);

    const blockedAttempt = vi.fn(async () => true);
    await expect(limiter.run(
      [emailBucket, addressBucket], [emailBucket],
      new Date(start.getTime() + 29_000), blockedAttempt,
    )).resolves.toMatchObject({ allowed: false, retryAfterSeconds: 1 });
    expect(blockedAttempt).not.toHaveBeenCalled();
    await expect(limiter.run(
      [emailBucket, addressBucket], [emailBucket],
      new Date(start.getTime() + 31_000), async () => false,
    )).resolves.toMatchObject({ allowed: true, succeeded: false });

    const windowEmail = loginRateLimitBucket(secret, 'email', `${runPrefix}-window@example.invalid`);
    const windowAddress = loginRateLimitBucket(secret, 'address', '203.0.113.43');
    await limiter.run([windowEmail, windowAddress], [windowEmail], start, async () => false);
    await limiter.run([windowEmail, windowAddress], [windowEmail], start, async () => false);
    await expect(limiter.run(
      [windowEmail, windowAddress], [windowEmail],
      new Date(start.getTime() + 61_000), async () => false,
    )).resolves.toMatchObject({ allowed: true, succeeded: false });

    await database.query(
      `UPDATE auth_login_rate_limits
       SET window_started_at = $2, failed_attempts = 2,
           blocked_until = NULL, updated_at = $2
       WHERE bucket_hash = $1`,
      [windowEmail, new Date(start.getTime() + 600_000)],
    );
    await expect(limiter.run(
      [windowEmail, windowAddress], [windowEmail], start, async () => false,
    )).resolves.toMatchObject({ allowed: true, succeeded: false });

    const staleBucket = loginRateLimitBucket(secret, 'email', `${runPrefix}-stale@example.invalid`);
    await database.query(
      `INSERT INTO auth_login_rate_limits
         (bucket_hash, window_started_at, failed_attempts, blocked_until, updated_at)
       VALUES ($1, $2, 1, NULL, $2)`,
      [staleBucket, new Date(start.getTime() - 300_000)],
    );
    await limiter.run([windowEmail, windowAddress], [windowEmail], start, async () => true);
    const stale = await database.query(
      'SELECT 1 FROM auth_login_rate_limits WHERE bucket_hash = $1',
      [staleBucket],
    );
    expect(stale.rowCount).toBe(0);

    const persisted = await database.query<{ value: string }>(
      `SELECT to_jsonb(auth_login_rate_limits)::text AS value
       FROM auth_login_rate_limits
       WHERE bucket_hash = ANY($1::bytea[])`,
      [[emailBucket, addressBucket, windowEmail, windowAddress]],
    );
    expect(persisted.rows.length).toBeGreaterThan(0);
    expect(persisted.rows.map((row) => row.value).join('\n')).not.toContain(rawEmail);
    expect(persisted.rows.map((row) => row.value).join('\n')).not.toContain(rawAddress);
    await database.query(
      'DELETE FROM auth_login_rate_limits WHERE bucket_hash = ANY($1::bytea[])',
      [[emailBucket, addressBucket, windowEmail, windowAddress, staleBucket]],
    );
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
