import { randomBytes } from 'node:crypto';
import { AuthServiceError as RuntimeAuthServiceError } from '@kodex/product-db';
import { describe, expect, it, vi } from 'vitest';
import {
  ProductApiConfigurationError,
  productApiConfigFromEnv,
  validateKnowledgeBodyCapacity,
  type ProductApiConfig,
} from '../../apps/api/src/config.js';
import {
  createCsrfToken,
  createSessionCookies,
  csrfCookieName,
  parseCookies,
  sessionCookieName,
  verifyCsrfToken,
} from '../../apps/api/src/cookies.js';
import { ProductApiServer } from '../../apps/api/src/server.js';
import {
  AuthService,
  hashSessionToken,
  loginRateLimitBucket,
} from '../../packages/product-db/src/auth-service.js';
import type {
  AuthRepository,
  RegisterAccountInput,
} from '../../packages/product-db/src/auth-repository.js';
import type { LoginRateLimiter } from '../../packages/product-db/src/login-rate-limiter.js';
import {
  requireWorkspaceRole,
  WorkspaceAuthorizationError,
  type AuthContext,
} from '../../packages/product-db/src/auth-types.js';
import {
  Argon2idPasswordHasher,
  type PasswordHasher,
} from '../../packages/product-db/src/password.js';

const now = new Date('2026-08-31T00:00:00.000Z');

function context(): AuthContext {
  return {
    sessionId: 'session-1',
    expiresAt: new Date(now.getTime() + 60_000),
    user: {
      id: 'user-1',
      email: 'person@example.com',
      displayName: 'Person',
      createdAt: now,
    },
    memberships: [{ id: 'workspace-1', slug: 'personal-1', name: 'Personal', role: 'owner' }],
  };
}

function fakePasswordHasher(): PasswordHasher {
  return {
    hash: vi.fn(async (password: string) => `encoded:${password}`),
    verify: vi.fn(async (encoded: string, password: string) => encoded === `encoded:${password}`),
    needsRehash: vi.fn(() => false),
  };
}

function fakeRepository(overrides: Partial<AuthRepository> = {}): AuthRepository {
  return {
    changePassword: vi.fn(async () => 0),
    registerAccount: vi.fn(async () => ({
      context: context(),
      defaultWorkspace: context().memberships[0],
    })),
    findLoginCredential: vi.fn(async () => undefined),
    createSession: vi.fn(async () => context()),
    findAuthContext: vi.fn(async () => undefined),
    listSessions: vi.fn(async () => []),
    revokeAllSessions: vi.fn(async () => 0),
    revokeOtherSessions: vi.fn(async () => 0),
    revokeSession: vi.fn(async () => false),
    revokeSessionById: vi.fn(async () => false),
    updatePasswordHash: vi.fn(async () => undefined),
    ...overrides,
  };
}

function allowingRateLimiter(): LoginRateLimiter {
  return {
    run: vi.fn(async (_buckets, _reset, _now, attempt) => ({
      allowed: true,
      succeeded: await attempt(),
    })),
  };
}

function rateLimitOptions(): Pick<
  Parameters<typeof AuthService.create>[2],
  'loginRateLimiter' | 'loginRateLimitSecret'
> {
  return {
    loginRateLimiter: allowingRateLimiter(),
    loginRateLimitSecret: Buffer.alloc(32, 17),
  };
}

describe('password and auth service', () => {
  it('hashes passwords with the pinned Argon2id parameters', async () => {
    const hasher = new Argon2idPasswordHasher();
    const encoded = await hasher.hash('correct horse battery staple');

    expect(encoded).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/u);
    expect(encoded).not.toContain('correct horse battery staple');
    await expect(hasher.verify(encoded, 'correct horse battery staple')).resolves.toBe(true);
    await expect(hasher.verify(encoded, 'incorrect password')).resolves.toBe(false);
  });

  it('normalizes registration email and passes only hashes into the repository', async () => {
    let registration: RegisterAccountInput | undefined;
    const repository = fakeRepository({
      registerAccount: vi.fn(async (input) => {
        registration = input;
        return { context: context(), defaultWorkspace: context().memberships[0] };
      }),
    });
    const service = await AuthService.create(repository, fakePasswordHasher(), {
      clock: () => now,
      dummyPasswordHash: 'encoded:dummy',
      randomToken: () => Buffer.alloc(32, 7),
      sessionTtlMs: 60_000,
      ...rateLimitOptions(),
    });

    const result = await service.register({
      email: '  PERSON@Example.COM ',
      password: 'a sufficiently long password',
      displayName: ' Person ',
    });

    expect(registration).toMatchObject({
      email: 'person@example.com',
      displayName: 'Person',
      passwordHash: 'encoded:a sufficiently long password',
      workspaceName: 'Personal Workspace',
      sessionExpiresAt: new Date('2026-08-31T00:01:00.000Z'),
    });
    expect(registration?.sessionTokenHash).toHaveLength(32);
    expect(JSON.stringify(registration)).not.toContain('"password":"');
    expect(Buffer.from(result.token, 'base64url')).toHaveLength(32);
    expect(registration?.sessionTokenHash).toEqual(hashSessionToken(result.token));
  });

  it('uses the same verifier and response for absent and wrong login credentials', async () => {
    const hasher = fakePasswordHasher();
    const absent = await AuthService.create(fakeRepository(), hasher, {
      dummyPasswordHash: 'encoded:dummy',
      ...rateLimitOptions(),
    });
    const existing = await AuthService.create(fakeRepository({
      findLoginCredential: vi.fn(async () => ({
        user: context().user,
        passwordHash: 'encoded:real-password',
      })),
    }), hasher, { dummyPasswordHash: 'encoded:dummy', ...rateLimitOptions() });

    const request = { email: 'person@example.com', password: 'wrong-password' };
    await expect(absent.login(request, { directAddress: '127.0.0.1' })).rejects.toMatchObject({
      code: 'invalid_credentials',
    });
    await expect(existing.login(request, { directAddress: '127.0.0.1' })).rejects.toMatchObject({
      code: 'invalid_credentials',
    });
    expect(hasher.verify).toHaveBeenCalledWith('encoded:dummy', 'wrong-password');
    expect(hasher.verify).toHaveBeenCalledWith('encoded:real-password', 'wrong-password');
  });

  it('derives domain-separated HMAC buckets and passes the injected clock to the limiter', async () => {
    const secret = Buffer.alloc(32, 23);
    let captured: {
      buckets: readonly Buffer[];
      now: Date;
      reset: readonly Buffer[];
    } | undefined;
    const limiter: LoginRateLimiter = {
      run: vi.fn(async (buckets, reset, passedNow) => {
        captured = { buckets, reset, now: passedNow };
        return { allowed: false, retryAfterSeconds: 17 };
      }),
    };
    const service = await AuthService.create(fakeRepository(), fakePasswordHasher(), {
      clock: () => now,
      dummyPasswordHash: 'encoded:dummy',
      loginRateLimiter: limiter,
      loginRateLimitSecret: secret,
    });
    await expect(service.login(
      { email: ' PERSON@EXAMPLE.COM ', password: 'wrong-password' },
      { directAddress: '::FFFF:127.0.0.1' },
    )).rejects.toMatchObject({ code: 'rate_limited', retryAfterSeconds: 17 });

    const { buckets, reset, now: passedNow } = captured!;
    expect(passedNow).toEqual(now);
    expect(buckets).toEqual([
      loginRateLimitBucket(secret, 'email', 'person@example.com'),
      loginRateLimitBucket(secret, 'address', '::ffff:127.0.0.1'),
    ]);
    expect(reset).toEqual([buckets[0]]);
    expect(Buffer.concat(buckets).toString('utf8')).not.toContain('person@example.com');
    expect(buckets[0]).not.toEqual(buckets[1]);
  });

  it('provides a reusable workspace role guard', () => {
    expect(requireWorkspaceRole(context(), 'workspace-1', ['owner'])).toMatchObject({ role: 'owner' });
    expect(() => requireWorkspaceRole(context(), 'workspace-1', ['admin']))
      .toThrow(WorkspaceAuthorizationError);
    expect(() => requireWorkspaceRole(context(), 'another-workspace'))
      .toThrow(WorkspaceAuthorizationError);
  });
});

describe('product API configuration and cookies', () => {
  it('defaults to loopback and rejects weak or insecure production configuration', () => {
    const config = productApiConfigFromEnv({ AUTH_COOKIE_SECRET: 'A'.repeat(43) });
    expect(config).toMatchObject({
      host: '127.0.0.1',
      port: 47_832,
      secureCookies: false,
      sessionTtlMs: 43_200_000,
      maxBodyBytes: 262_144,
      loginRateLimitMaxAttempts: 5,
      loginRateLimitWindowMs: 900_000,
      loginRateLimitBlockMs: 900_000,
      abuseRateLimitPolicies: {
        register: { maxAttempts: 5, windowMs: 3_600_000, blockMs: 3_600_000 },
        invitation_preview: { maxAttempts: 10, windowMs: 900_000, blockMs: 900_000 },
        invitation_accept: { maxAttempts: 5, windowMs: 900_000, blockMs: 900_000 },
      },
      workspaceInvitationPendingLimit: 100,
      workspaceInvitationTtlMs: 604_800_000,
    });
    expect(config.allowedOrigins).toEqual(new Set([
      'http://127.0.0.1:5173',
      'http://localhost:5173',
      'http://127.0.0.1:47831',
      'http://localhost:47831',
    ]));
    expect(() => productApiConfigFromEnv({ AUTH_COOKIE_SECRET: 'short' }))
      .toThrow('at least 32 random bytes');
    expect(() => productApiConfigFromEnv({
      AUTH_COOKIE_SECRET: 'A'.repeat(43),
      AUTH_LOGIN_RATE_LIMIT_ATTEMPTS: '1',
    })).toThrow('between 2 and 20');
    expect(() => productApiConfigFromEnv({
      AUTH_COOKIE_SECRET: 'A'.repeat(43),
      AUTH_LOGIN_RATE_LIMIT_WINDOW_SECONDS: '3601',
    })).toThrow('no greater than 3600');
    expect(() => productApiConfigFromEnv({
      AUTH_COOKIE_SECRET: 'A'.repeat(43),
      AUTH_LOGIN_RATE_LIMIT_BLOCK_SECONDS: '29',
    })).toThrow('between 30 and 86400');
    expect(() => productApiConfigFromEnv({
      AUTH_COOKIE_SECRET: 'A'.repeat(43),
      AUTH_REGISTER_RATE_LIMIT_ATTEMPTS: '101',
    })).toThrow('no greater than 100');
    expect(() => productApiConfigFromEnv({
      AUTH_COOKIE_SECRET: 'A'.repeat(43),
      AUTH_INVITATION_PREVIEW_RATE_LIMIT_WINDOW_SECONDS: '59',
    })).toThrow('between 60 and 86400');
    expect(() => productApiConfigFromEnv({
      AUTH_COOKIE_SECRET: 'A'.repeat(43),
      AUTH_INVITATION_ACCEPT_RATE_LIMIT_BLOCK_SECONDS: '86401',
    })).toThrow('no greater than 86400');
    expect(() => productApiConfigFromEnv({
      AUTH_COOKIE_SECRET: 'A'.repeat(43),
      WORKSPACE_INVITATION_TTL_HOURS: '721',
    })).toThrow('no greater than 720');
    expect(() => productApiConfigFromEnv({
      AUTH_COOKIE_SECRET: 'A'.repeat(43),
      WORKSPACE_INVITATION_PENDING_LIMIT: '501',
    })).toThrow('no greater than 500');
    expect(() => productApiConfigFromEnv({
      NODE_ENV: 'production',
      AUTH_COOKIE_SECRET: 'A'.repeat(43),
      AUTH_ALLOWED_ORIGINS: 'http://app.example.com',
      PRODUCT_API_ALLOWED_HOSTS: 'api.example.com',
    })).toThrow('must use HTTPS');
  });

  it.each([
    ['AUTH_REGISTER_RATE_LIMIT_ATTEMPTS', '1'],
    ['AUTH_REGISTER_RATE_LIMIT_WINDOW_SECONDS', '59'],
    ['AUTH_REGISTER_RATE_LIMIT_BLOCK_SECONDS', '29'],
    ['AUTH_INVITATION_PREVIEW_RATE_LIMIT_ATTEMPTS', '101'],
    ['AUTH_INVITATION_PREVIEW_RATE_LIMIT_WINDOW_SECONDS', '86401'],
    ['AUTH_INVITATION_PREVIEW_RATE_LIMIT_BLOCK_SECONDS', '29'],
    ['AUTH_INVITATION_ACCEPT_RATE_LIMIT_ATTEMPTS', '1'],
    ['AUTH_INVITATION_ACCEPT_RATE_LIMIT_WINDOW_SECONDS', '59'],
    ['AUTH_INVITATION_ACCEPT_RATE_LIMIT_BLOCK_SECONDS', '86401'],
  ])('rejects out-of-range product abuse setting %s before listen', (name, value) => {
    expect(() => productApiConfigFromEnv({
      AUTH_COOKIE_SECRET: 'A'.repeat(43),
      [name]: value,
    })).toThrow(ProductApiConfigurationError);
  });

  it('reserves UTF-8 JSON capacity for the configured RAG document limit', () => {
    const config = productApiConfigFromEnv({ AUTH_COOKIE_SECRET: 'A'.repeat(43) });
    expect(() => validateKnowledgeBodyCapacity(config, {
      enabled: true,
      maxDocumentCharacters: 60_000,
    })).not.toThrow();
    expect(() => validateKnowledgeBodyCapacity(config, {
      enabled: true,
      maxDocumentCharacters: 100_000,
    })).toThrow('PRODUCT_API_MAX_BODY_BYTES must be at least 408192');
    expect(() => validateKnowledgeBodyCapacity({ maxBodyBytes: 1 }, {
      enabled: false,
      maxDocumentCharacters: 1_000_000,
    })).not.toThrow();
  });

  it('exposes minimal unauthenticated liveness and DB-backed readiness without internal errors', async () => {
    const config: ProductApiConfig = {
      host: '127.0.0.1',
      port: 0,
      allowedHosts: new Set(),
      allowedOrigins: new Set(['http://127.0.0.1:5173']),
      cookieSecret: Buffer.alloc(32, 7),
      secureCookies: false,
      sessionTtlMs: 60_000,
      maxBodyBytes: 65_536,
      loginRateLimitMaxAttempts: 5,
      loginRateLimitWindowMs: 900_000,
      loginRateLimitBlockMs: 900_000,
    };
    const check = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('postgresql://user:secret@database/private-schema'));
    const server = new ProductApiServer({
      authenticate: vi.fn(), login: vi.fn(), logout: vi.fn(), register: vi.fn(),
    }, config, undefined, undefined, { check }, undefined, undefined, {
      version: '0.2.0',
      commit: 'a'.repeat(40),
    });
    const port = await server.listen();
    const base = `http://127.0.0.1:${port}`;
    try {
      const live = await fetch(`${base}/api/health/live`);
      expect(live.status).toBe(200);
      expect(live.headers.get('cache-control')).toContain('no-store');
      expect(await live.json()).toEqual({ ok: true });

      const ready = await fetch(`${base}/api/health/ready`);
      expect(ready.status).toBe(200);
      expect(await ready.json()).toEqual({ ok: true });
      const unavailable = await fetch(`${base}/api/health/ready`);
      expect(unavailable.status).toBe(503);
      expect(JSON.stringify(await unavailable.json())).toBe('{"ok":false}');
      expect(check).toHaveBeenCalledTimes(2);
      const version = await fetch(`${base}/api/version`);
      expect(version.status).toBe(200);
      expect(await version.json()).toEqual({ version: '0.2.0', commit: 'a'.repeat(40) });
    } finally {
      await server.close();
    }
  });

  it('returns bounded Retry-After and no-store for a database-backed login block', async () => {
    const config: ProductApiConfig = {
      host: '127.0.0.1', port: 0, allowedHosts: new Set(),
      allowedOrigins: new Set(['http://127.0.0.1:5173']),
      cookieSecret: Buffer.alloc(32, 7), secureCookies: false,
      sessionTtlMs: 60_000, maxBodyBytes: 65_536,
      loginRateLimitMaxAttempts: 5, loginRateLimitWindowMs: 900_000,
      loginRateLimitBlockMs: 900_000,
    };
    const server = new ProductApiServer({
      authenticate: vi.fn(),
      login: vi.fn(async () => { throw new RuntimeAuthServiceError('rate_limited', 999_999); }),
      logout: vi.fn(), register: vi.fn(),
    }, config);
    const port = await server.listen();
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
        method: 'POST',
        headers: { Origin: 'http://127.0.0.1:5173', 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'person@example.com', password: 'wrong' }),
      });
      expect(response.status).toBe(429);
      expect(response.headers.get('retry-after')).toBe('86400');
      expect(response.headers.get('cache-control')).toContain('no-store');
      expect(await response.json()).toEqual({
        ok: false,
        error: { code: 'rate_limited', message: 'Too many login attempts. Try again later.' },
      });
    } finally {
      await server.close();
    }
  });

  it('sets bounded session/CSRF cookies and validates an HMAC double submit token', () => {
    const secret = randomBytes(32);
    const expiresAt = new Date(Date.now() + 60_000);
    const cookies = createSessionCookies('opaque-session', expiresAt, secret, true);

    expect(cookies[0]).toContain(`${sessionCookieName}=opaque-session`);
    expect(cookies[0]).toContain('HttpOnly');
    expect(cookies[0]).toContain('SameSite=Strict');
    expect(cookies[0]).toContain('Path=/');
    expect(cookies[0]).toContain('Max-Age=');
    expect(cookies[0]).toContain('Expires=');
    expect(cookies[0]).toContain('Secure');
    expect(cookies[1]).toContain(`${csrfCookieName}=`);
    expect(cookies[1]).not.toContain('HttpOnly');

    const parsed = parseCookies(cookies.map((entry) => entry.split(';', 1)[0]).join('; '));
    const csrf = parsed.get(csrfCookieName);
    expect(verifyCsrfToken('opaque-session', csrf, csrf, secret)).toBe(true);
    expect(verifyCsrfToken('opaque-session', csrf, 'forged', secret)).toBe(false);
  });

  it('returns the non-session CSRF contract on register and me while retaining double-submit verification', async () => {
    const secret = Buffer.alloc(32, 23);
    const authContext = context();
    const logout = vi.fn(async () => undefined);
    const config: ProductApiConfig = {
      host: '127.0.0.1',
      port: 0,
      allowedHosts: new Set(),
      allowedOrigins: new Set(['http://127.0.0.1:5173']),
      cookieSecret: secret,
      secureCookies: false,
      sessionTtlMs: 60_000,
      maxBodyBytes: 65_536,
      loginRateLimitMaxAttempts: 5,
      loginRateLimitWindowMs: 900_000,
      loginRateLimitBlockMs: 900_000,
    };
    const server = new ProductApiServer({
      authenticate: vi.fn(async () => authContext),
      login: vi.fn(async () => ({ token: 'opaque-session', context: authContext })),
      logout,
      register: vi.fn(async () => ({
        token: 'opaque-session',
        context: authContext,
        defaultWorkspace: authContext.memberships[0],
      })),
    }, config);
    const port = await server.listen();
    const base = `http://127.0.0.1:${port}`;
    const expectedCsrf = createCsrfToken('opaque-session', secret);
    try {
      const registration = await fetch(`${base}/api/auth/register`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'http://127.0.0.1:5173',
        },
        body: JSON.stringify({ email: 'person@example.com', password: 'long enough password' }),
      });
      expect(registration.status).toBe(201);
      expect(await registration.json()).toMatchObject({ csrfToken: expectedCsrf });

      const cookie = `${sessionCookieName}=opaque-session; ${csrfCookieName}=${expectedCsrf}`;
      const me = await fetch(`${base}/api/auth/me`, { headers: { Cookie: cookie } });
      expect(await me.json()).toMatchObject({ csrfToken: expectedCsrf });

      const loggedOut = await fetch(`${base}/api/auth/logout`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
          Origin: 'http://127.0.0.1:5173',
          'X-CSRF-Token': expectedCsrf,
        },
        body: '{}',
      });
      expect(loggedOut.status).toBe(204);
      expect(logout).toHaveBeenCalledWith('opaque-session');
    } finally {
      await server.close();
    }
  });
});
