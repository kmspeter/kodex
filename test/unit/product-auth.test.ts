import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
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
} from '../../packages/product-db/src/auth-service.js';
import type {
  AuthRepository,
  RegisterAccountInput,
} from '../../packages/product-db/src/auth-repository.js';
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
    registerAccount: vi.fn(async () => ({
      context: context(),
      defaultWorkspace: context().memberships[0],
    })),
    findLoginCredential: vi.fn(async () => undefined),
    createSession: vi.fn(async () => context()),
    findAuthContext: vi.fn(async () => undefined),
    revokeSession: vi.fn(async () => false),
    updatePasswordHash: vi.fn(async () => undefined),
    ...overrides,
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
    });
    const existing = await AuthService.create(fakeRepository({
      findLoginCredential: vi.fn(async () => ({
        user: context().user,
        passwordHash: 'encoded:real-password',
      })),
    }), hasher, { dummyPasswordHash: 'encoded:dummy' });

    const request = { email: 'person@example.com', password: 'wrong-password' };
    await expect(absent.login(request)).rejects.toMatchObject({
      code: 'invalid_credentials',
    });
    await expect(existing.login(request)).rejects.toMatchObject({
      code: 'invalid_credentials',
    });
    expect(hasher.verify).toHaveBeenCalledWith('encoded:dummy', 'wrong-password');
    expect(hasher.verify).toHaveBeenCalledWith('encoded:real-password', 'wrong-password');
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
      NODE_ENV: 'production',
      AUTH_COOKIE_SECRET: 'A'.repeat(43),
      AUTH_ALLOWED_ORIGINS: 'http://app.example.com',
      PRODUCT_API_ALLOWED_HOSTS: 'api.example.com',
    })).toThrow('must use HTTPS');
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
