import { randomBytes } from 'node:crypto';
import type { AuthContext, WorkspaceApplication } from '@kodex/product-db';
import { describe, expect, it, vi } from 'vitest';
import type { ProductApiConfig } from '../../apps/api/src/config.js';
import { createCsrfToken, csrfCookieName, sessionCookieName } from '../../apps/api/src/cookies.js';
import { ProductApiServer } from '../../apps/api/src/server.js';
import {
  abuseRateLimitSubjectHash,
  normalizeDirectAddress,
  type AbuseRateLimiter,
} from '../../packages/product-db/src/abuse-rate-limiter.js';
import { AuthService } from '../../packages/product-db/src/auth-service.js';
import type { AuthRepository } from '../../packages/product-db/src/auth-repository.js';
import type { LoginRateLimiter } from '../../packages/product-db/src/login-rate-limiter.js';
import type { PasswordHasher } from '../../packages/product-db/src/password.js';

const origin = 'http://127.0.0.1:5173';
const secret = Buffer.alloc(32, 29);
const sessionToken = 'session-token';
const csrf = createCsrfToken(sessionToken, secret);
const userId = '10000000-0000-4000-8000-000000000001';
const workspaceId = '20000000-0000-4000-8000-000000000001';
const invitationToken = 'T'.repeat(43);

function context(): AuthContext {
  return {
    sessionId: '30000000-0000-4000-8000-000000000001',
    expiresAt: new Date('2026-09-04T00:00:00.000Z'),
    user: { id: userId, email: 'person@example.invalid', displayName: null, createdAt: new Date() },
    memberships: [{ id: workspaceId, name: 'Shared', role: 'owner', slug: 'shared' }],
  };
}

function config(): ProductApiConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    allowedHosts: new Set(),
    allowedOrigins: new Set([origin]),
    cookieSecret: secret,
    secureCookies: false,
    sessionTtlMs: 60_000,
    maxBodyBytes: 4_096,
    loginRateLimitMaxAttempts: 5,
    loginRateLimitWindowMs: 900_000,
    loginRateLimitBlockMs: 900_000,
  };
}

function workspaceApplication(): WorkspaceApplication {
  return {
    acceptInvitation: vi.fn(async () => ({
      id: workspaceId, name: 'Shared', role: 'member' as const, slug: 'shared',
    })),
    addMember: vi.fn(),
    createInvitation: vi.fn(),
    createWorkspace: vi.fn(),
    listInvitations: vi.fn(),
    listMembers: vi.fn(),
    previewInvitation: vi.fn(async () => ({
      expiresAt: new Date('2026-09-04T00:00:00.000Z'),
      role: 'member' as const,
      targetEmailHint: 'p***@example.invalid',
      workspaceName: 'Shared',
    })),
    removeMember: vi.fn(),
    revokeInvitation: vi.fn(),
    updateMemberRole: vi.fn(),
  };
}

function authRepository(): AuthRepository {
  return {
    changePassword: vi.fn(),
    createSession: vi.fn(),
    findAuthContext: vi.fn(),
    findLoginCredential: vi.fn(),
    listSessions: vi.fn(),
    registerAccount: vi.fn(async () => ({ context: context(), defaultWorkspace: context().memberships[0] })),
    revokeAllSessions: vi.fn(),
    revokeOtherSessions: vi.fn(),
    revokeSession: vi.fn(),
    revokeSessionById: vi.fn(),
    updatePasswordHash: vi.fn(),
  };
}

const loginRateLimiter: LoginRateLimiter = {
  run: vi.fn(async (_buckets, _reset, _now, attempt) => ({ allowed: true, succeeded: await attempt() })),
};

describe('product abuse rate-limit subjects', () => {
  it('normalizes only the direct peer address and domain-separates every action and kind', () => {
    expect(normalizeDirectAddress('::FFFF:127.0.0.1')).toBe('127.0.0.1');
    expect(normalizeDirectAddress('2001:DB8::1')).toBe('2001:db8::1');
    const values = [
      abuseRateLimitSubjectHash(secret, 'register', 'address', 'same'),
      abuseRateLimitSubjectHash(secret, 'register', 'email', 'same'),
      abuseRateLimitSubjectHash(secret, 'invitation_preview', 'address', 'same'),
      abuseRateLimitSubjectHash(secret, 'invitation_preview', 'token', 'same'),
      abuseRateLimitSubjectHash(secret, 'invitation_accept', 'account', 'same'),
      abuseRateLimitSubjectHash(secret, 'invitation_accept', 'address', 'same'),
      abuseRateLimitSubjectHash(secret, 'invitation_accept', 'token', 'same'),
    ];
    expect(new Set(values.map((value) => value.toString('hex')))).toHaveLength(values.length);
    expect(values.every((value) => value.length === 32)).toBe(true);
    expect(Buffer.concat(values).toString('utf8')).not.toContain('same');
  });

  it('consumes register buckets after validation but before password hashing and repository work', async () => {
    const order: string[] = [];
    const limiter: AbuseRateLimiter = {
      consume: vi.fn(async (_action, _subjects) => {
        order.push('limit');
        return { allowed: false, retryAfterSeconds: 37 };
      }),
    };
    const passwordHasher: PasswordHasher = {
      hash: vi.fn(async () => { order.push('hash'); return 'encoded'; }),
      verify: vi.fn(),
      needsRehash: vi.fn(() => false),
    };
    const repository = authRepository();
    const service = await AuthService.create(repository, passwordHasher, {
      abuseRateLimiter: limiter,
      dummyPasswordHash: 'dummy',
      loginRateLimiter,
      loginRateLimitSecret: secret,
      randomToken: () => randomBytes(32),
    });

    await expect(service.register({
      email: ' PERSON@EXAMPLE.INVALID ',
      password: 'a sufficiently long password',
    }, { directAddress: '::FFFF:127.0.0.1' })).rejects.toMatchObject({ retryAfterSeconds: 37 });
    expect(limiter.consume).toHaveBeenCalledWith('register', [
      { kind: 'address', value: '127.0.0.1' },
      { kind: 'email', value: 'person@example.invalid' },
    ], expect.any(Date));
    expect(order).toEqual(['limit']);
    expect(passwordHasher.hash).not.toHaveBeenCalled();
    expect(repository.registerAccount).not.toHaveBeenCalled();

    await expect(service.register({ email: 'bad', password: 'a sufficiently long password' }, {
      directAddress: '127.0.0.1',
    })).rejects.toMatchObject({ code: 'invalid_request' });
    expect(limiter.consume).toHaveBeenCalledTimes(1);
  });
});

describe('invitation abuse rate-limit HTTP boundary', () => {
  it('uses only the socket peer, validates first, and returns one redacted no-store 429 contract', async () => {
    const limiter: AbuseRateLimiter = {
      consume: vi.fn(async () => ({ allowed: false, retryAfterSeconds: 17 })),
    };
    const workspaces = workspaceApplication();
    const server = new ProductApiServer({
      authenticate: vi.fn(async () => context()), login: vi.fn(), logout: vi.fn(), register: vi.fn(),
    }, config(), undefined, undefined, undefined, workspaces, limiter);
    const port = await server.listen();
    try {
      const invalid = await fetch(`http://127.0.0.1:${port}/api/invitations/preview`, {
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'malformed' }),
      });
      expect(invalid.status).toBe(422);
      expect(limiter.consume).not.toHaveBeenCalled();

      const blocked = await fetch(`http://127.0.0.1:${port}/api/invitations/preview`, {
        method: 'POST',
        headers: {
          Origin: origin,
          'Content-Type': 'application/json',
          Forwarded: 'for=203.0.113.8',
          'X-Forwarded-For': '198.51.100.9',
        },
        body: JSON.stringify({ token: invitationToken }),
      });
      expect(blocked.status).toBe(429);
      expect(blocked.headers.get('cache-control')).toBe('no-store, max-age=0');
      expect(blocked.headers.get('retry-after')).toBe('17');
      const blockedBody = await blocked.json();
      expect(blockedBody).toEqual({
        ok: false,
        error: { code: 'rate_limited', message: 'Too many requests. Try again later.' },
      });
      expect(JSON.stringify(blockedBody)).not.toContain(invitationToken);
      expect(limiter.consume).toHaveBeenCalledWith('invitation_preview', [
        { kind: 'address', value: '127.0.0.1' },
        { kind: 'token', value: invitationToken },
      ], expect.any(Date));
      expect(JSON.stringify(vi.mocked(limiter.consume).mock.calls)).not.toContain('203.0.113.8');
      expect(JSON.stringify(vi.mocked(limiter.consume).mock.calls)).not.toContain('198.51.100.9');
      expect(workspaces.previewInvitation).not.toHaveBeenCalled();

      vi.mocked(limiter.consume).mockResolvedValueOnce({
        allowed: false,
        retryAfterSeconds: Number.NaN,
      });
      const invalidInternalRetry = await fetch(`http://127.0.0.1:${port}/api/invitations/preview`, {
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: invitationToken }),
      });
      expect(invalidInternalRetry.status).toBe(429);
      expect(invalidInternalRetry.headers.get('retry-after')).toBe('1');
      expect(workspaces.previewInvitation).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it('consumes accept buckets only after authentication, Origin, CSRF, and token validation', async () => {
    const order: string[] = [];
    const limiter: AbuseRateLimiter = {
      consume: vi.fn(async () => { order.push('limit'); return { allowed: true }; }),
    };
    const workspaces = workspaceApplication();
    vi.mocked(workspaces.acceptInvitation).mockImplementation(async () => {
      order.push('accept');
      return { id: workspaceId, name: 'Shared', role: 'member', slug: 'shared' };
    });
    const authenticate = vi.fn(async () => { order.push('authenticate'); return context(); });
    const server = new ProductApiServer({
      authenticate, login: vi.fn(), logout: vi.fn(), register: vi.fn(),
    }, config(), undefined, undefined, undefined, workspaces, limiter);
    const port = await server.listen();
    const endpoint = `http://127.0.0.1:${port}/api/invitations/accept`;
    try {
      const withoutSession = await fetch(endpoint, {
        method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: invitationToken }),
      });
      expect(withoutSession.status).toBe(401);
      expect(limiter.consume).not.toHaveBeenCalled();

      const invalidCsrf = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Origin: origin, 'Content-Type': 'application/json',
          Cookie: `${sessionCookieName}=${sessionToken}; ${csrfCookieName}=${csrf}`,
          'X-CSRF-Token': 'invalid-csrf',
        },
        body: JSON.stringify({ token: invitationToken }),
      });
      expect(invalidCsrf.status).toBe(403);
      expect(limiter.consume).not.toHaveBeenCalled();

      const malformed = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Origin: origin, 'Content-Type': 'application/json',
          Cookie: `${sessionCookieName}=${sessionToken}; ${csrfCookieName}=${csrf}`,
          'X-CSRF-Token': csrf,
        },
        body: JSON.stringify({ token: 'bad' }),
      });
      expect(malformed.status).toBe(422);
      expect(limiter.consume).not.toHaveBeenCalled();

      const accepted = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Origin: origin, 'Content-Type': 'application/json',
          Cookie: `${sessionCookieName}=${sessionToken}; ${csrfCookieName}=${csrf}`,
          'X-CSRF-Token': csrf,
        },
        body: JSON.stringify({ token: invitationToken }),
      });
      expect(accepted.status).toBe(200);
      expect(order).toEqual(['authenticate', 'authenticate', 'limit', 'accept']);
      expect(limiter.consume).toHaveBeenCalledWith('invitation_accept', [
        { kind: 'account', value: userId },
        { kind: 'address', value: '127.0.0.1' },
        { kind: 'token', value: invitationToken },
      ], expect.any(Date));
    } finally {
      await server.close();
    }
  });
});
