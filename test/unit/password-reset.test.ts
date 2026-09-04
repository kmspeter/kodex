import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { ProductApiConfig } from '../../apps/api/src/config';
import {
  passwordResetDeliveryConfigFromEnv,
  WebhookPasswordResetDelivery,
} from '../../apps/api/src/password-reset-delivery';
import { ProductApiServer } from '../../apps/api/src/server';
import { recoverPasswordResetTokenFromLocation } from '../../apps/ui/src/auth/password-reset-fragment';
import type { AbuseRateLimiter } from '../../packages/product-db/src/abuse-rate-limiter';
import type { PasswordHasher } from '../../packages/product-db/src/password';
import type { PasswordResetRepository } from '../../packages/product-db/src/password-reset-repository';
import {
  hashPasswordResetToken,
  PasswordResetService,
} from '../../packages/product-db/src/password-reset-service';

const now = new Date('2026-09-04T00:00:00.000Z');
const token = Buffer.alloc(32, 19).toString('base64url');

function repository(overrides: Partial<PasswordResetRepository> = {}): PasswordResetRepository {
  return {
    consumePasswordReset: vi.fn(async () => 2),
    createPasswordReset: vi.fn(async () => '10000000-0000-4000-8000-000000000001'),
    findActiveAccountByEmail: vi.fn(async () => ({
      email: 'person@example.com',
      userId: '20000000-0000-4000-8000-000000000001',
    })),
    markPasswordResetDeliveryFailed: vi.fn(async () => undefined),
    ...overrides,
  };
}

function limiter(allowed = true): AbuseRateLimiter {
  return { consume: vi.fn(async () => allowed ? { allowed: true } : { allowed: false, retryAfterSeconds: 60 }) };
}

const passwordHasher: PasswordHasher = {
  hash: vi.fn(async (value) => `encoded:${value}`),
  needsRehash: vi.fn(() => false),
  verify: vi.fn(async () => false),
};

describe('password reset service', () => {
  it('stores only a domain-separated token hash and delivers the raw token once', async () => {
    const repo = repository();
    const delivery = { send: vi.fn(async () => undefined) };
    const service = new PasswordResetService(repo, passwordHasher, delivery, limiter(), {
      clock: () => now,
      minimumRequestDurationMs: 0,
      randomToken: () => Buffer.alloc(32, 19),
      ttlMs: 60 * 60_000,
    });
    await expect(service.request({ email: ' PERSON@EXAMPLE.COM ' }, { directAddress: '127.0.0.1' }))
      .resolves.toEqual({ deliveryFailed: false });
    expect(repo.createPasswordReset).toHaveBeenCalledWith({
      userId: '20000000-0000-4000-8000-000000000001',
      tokenHash: hashPasswordResetToken(token),
      createdAt: now,
      expiresAt: new Date('2026-09-04T01:00:00.000Z'),
    });
    expect(delivery.send).toHaveBeenCalledWith({
      email: 'person@example.com',
      expiresAt: new Date('2026-09-04T01:00:00.000Z'),
      token,
    });
    expect(hashPasswordResetToken(token)).not.toEqual(createHash('sha256').update(token).digest());
    expect(JSON.stringify(vi.mocked(repo.createPasswordReset).mock.calls)).not.toContain(token);
  });

  it('returns the same result for an unknown account and revokes a failed delivery', async () => {
    const unknown = repository({ findActiveAccountByEmail: vi.fn(async () => undefined) });
    const delivery = { send: vi.fn(async () => { throw new Error('provider token secret'); }) };
    const unknownService = new PasswordResetService(unknown, passwordHasher, delivery, limiter(), {
      clock: () => now,
      minimumRequestDurationMs: 0,
    });
    await expect(unknownService.request({ email: 'missing@example.com' }, { directAddress: '127.0.0.1' }))
      .resolves.toEqual({ deliveryFailed: false });
    expect(delivery.send).not.toHaveBeenCalled();

    const known = repository();
    const knownService = new PasswordResetService(known, passwordHasher, delivery, limiter(), {
      clock: () => now,
      minimumRequestDurationMs: 0,
      randomToken: () => Buffer.alloc(32, 19),
    });
    await expect(knownService.request({ email: 'person@example.com' }, { directAddress: '127.0.0.1' }))
      .resolves.toEqual({ deliveryFailed: true });
    expect(known.markPasswordResetDeliveryFailed).toHaveBeenCalledWith(
      '10000000-0000-4000-8000-000000000001',
      now,
    );
  });

  it('hashes the replacement password before atomically consuming a bounded token', async () => {
    const repo = repository();
    const service = new PasswordResetService(repo, passwordHasher, { send: vi.fn() }, limiter(), {
      clock: () => now,
      minimumRequestDurationMs: 0,
    });
    await expect(service.complete({ token, newPassword: 'a new password long enough' }, { directAddress: '::ffff:127.0.0.1' }))
      .resolves.toBe(2);
    expect(repo.consumePasswordReset).toHaveBeenCalledWith({
      consumedAt: now,
      nextPasswordHash: 'encoded:a new password long enough',
      tokenHash: hashPasswordResetToken(token),
    });
  });

  it('pads accepted request paths to reduce account-enumeration timing differences', async () => {
    const delay = vi.fn(async () => undefined);
    const service = new PasswordResetService(
      repository({ findActiveAccountByEmail: vi.fn(async () => undefined) }),
      passwordHasher,
      { send: vi.fn() },
      limiter(),
      { clock: () => now, delay, minimumRequestDurationMs: 750, monotonicClock: () => 10 },
    );
    await service.request({ email: 'missing@example.com' }, { directAddress: '127.0.0.1' });
    expect(delay).toHaveBeenCalledWith(750);
  });
});

describe('password reset browser fragment', () => {
  it('recovers a canonical token once and removes the secret before application startup', () => {
    const history = { state: { safe: true }, replaceState: vi.fn() };
    expect(recoverPasswordResetTokenFromLocation({
      hash: `#password-reset=${token}`,
      pathname: '/desktop',
      search: '?runtime=local',
    }, history)).toBe(token);
    expect(history.replaceState).toHaveBeenCalledWith({ safe: true }, '', '/desktop?runtime=local');
  });

  it('removes malformed reset fragments without accepting them', () => {
    const history = { state: null, replaceState: vi.fn() };
    expect(recoverPasswordResetTokenFromLocation({
      hash: '#password-reset=too-short', pathname: '/', search: '',
    }, history)).toBeNull();
    expect(history.replaceState).toHaveBeenCalledOnce();
  });
});

describe('password reset delivery boundary', () => {
  it('validates production delivery configuration and sends only the bounded provider contract', async () => {
    const config = passwordResetDeliveryConfigFromEnv({
      PRODUCT_API_NODE_ENV: 'production',
      AUTH_PASSWORD_RESET_ENABLED: 'true',
      AUTH_PASSWORD_RESET_DELIVERY_URL: 'https://mail.example.test/v1/reset',
      AUTH_PASSWORD_RESET_PUBLIC_ORIGIN: 'https://kodex.example.test',
      AUTH_PASSWORD_RESET_DELIVERY_BEARER_TOKEN: 's'.repeat(32),
    });
    expect(config).toBeDefined();
    const fetch = vi.fn(async () => new Response(null, { status: 202 }));
    await new WebhookPasswordResetDelivery(config!, fetch).send({
      email: 'person@example.com',
      expiresAt: now,
      token,
    });
    expect(fetch).toHaveBeenCalledWith('https://mail.example.test/v1/reset', expect.objectContaining({
      method: 'POST',
      redirect: 'error',
      body: JSON.stringify({
        kind: 'password_reset',
        email: 'person@example.com',
        expiresAt: now.toISOString(),
        resetUrl: `https://kodex.example.test/#password-reset=${token}`,
      }),
    }));
    expect(passwordResetDeliveryConfigFromEnv({ AUTH_PASSWORD_RESET_ENABLED: 'false' })).toBeUndefined();
    expect(() => passwordResetDeliveryConfigFromEnv({
      PRODUCT_API_NODE_ENV: 'production',
      AUTH_PASSWORD_RESET_ENABLED: 'true',
      AUTH_PASSWORD_RESET_DELIVERY_URL: 'http://mail.example.test/reset',
      AUTH_PASSWORD_RESET_PUBLIC_ORIGIN: 'https://kodex.example.test',
      AUTH_PASSWORD_RESET_DELIVERY_BEARER_TOKEN: 's'.repeat(32),
    })).toThrow('secure absolute URL');
  });
});

describe('password reset HTTP boundary', () => {
  it('keeps request responses generic and clears session cookies after completion', async () => {
    const config: ProductApiConfig = {
      host: '127.0.0.1', port: 0, allowedHosts: new Set(),
      allowedOrigins: new Set(['http://127.0.0.1:5173']), cookieSecret: Buffer.alloc(32, 7),
      secureCookies: false, sessionTtlMs: 60_000, maxBodyBytes: 65_536,
      loginRateLimitMaxAttempts: 5, loginRateLimitWindowMs: 900_000, loginRateLimitBlockMs: 900_000,
    };
    const reset = {
      request: vi.fn(async () => ({ deliveryFailed: false })),
      complete: vi.fn(async () => 3),
    };
    const server = new ProductApiServer({
      authenticate: vi.fn(), login: vi.fn(), logout: vi.fn(), register: vi.fn(),
    }, config, undefined, undefined, undefined, undefined, undefined, undefined, reset);
    const port = await server.listen();
    try {
      const request = await fetch(`http://127.0.0.1:${port}/api/auth/password-reset/request`, {
        method: 'POST', headers: { Origin: 'http://127.0.0.1:5173', 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'person@example.com' }),
      });
      expect(request.status).toBe(202);
      expect(await request.json()).toEqual({ ok: true });
      const completed = await fetch(`http://127.0.0.1:${port}/api/auth/password-reset/complete`, {
        method: 'POST', headers: { Origin: 'http://127.0.0.1:5173', 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, newPassword: 'a new password long enough' }),
      });
      expect(completed.status).toBe(204);
      expect(completed.headers.get('set-cookie')).toContain('Max-Age=0');
    } finally {
      await server.close();
    }
  });
});
