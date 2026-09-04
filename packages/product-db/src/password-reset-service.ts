import { createHash, randomBytes } from 'node:crypto';
import { normalizeDirectAddress, ProductAbuseRateLimitError, type AbuseRateLimiter } from './abuse-rate-limiter.js';
import { normalizeEmail } from './auth-service.js';
import type { PasswordHasher } from './password.js';
import {
  PasswordResetUnavailableError,
  type PasswordResetRepository,
} from './password-reset-repository.js';

export interface PasswordResetDelivery {
  send(input: { email: string; expiresAt: Date; token: string }): Promise<void>;
}

export interface PasswordResetServiceOptions {
  clock?: () => Date;
  delay?: (milliseconds: number) => Promise<void>;
  minimumRequestDurationMs?: number;
  monotonicClock?: () => number;
  randomToken?: () => Buffer;
  ttlMs?: number;
}

export class PasswordResetServiceError extends Error {
  constructor(readonly code: 'invalid_request' | 'reset_unavailable') {
    super(code);
    this.name = 'PasswordResetServiceError';
  }
}

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const EMAIL_PATTERN = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u;
const MAX_PASSWORD_BYTES = 1_024;
const DEFAULT_TTL_MS = 60 * 60 * 1_000;
const DEFAULT_MINIMUM_REQUEST_DURATION_MS = 750;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === [...expected].sort()[index]);
}

function requestEmail(value: unknown): string {
  if (!isRecord(value) || !exactKeys(value, ['email']) || typeof value.email !== 'string') {
    throw new PasswordResetServiceError('invalid_request');
  }
  const email = normalizeEmail(value.email);
  if (email.length < 3 || email.length > 320 || !EMAIL_PATTERN.test(email)) {
    throw new PasswordResetServiceError('invalid_request');
  }
  return email;
}

function completion(value: unknown): { newPassword: string; token: string } {
  if (
    !isRecord(value)
    || !exactKeys(value, ['newPassword', 'token'])
    || typeof value.newPassword !== 'string'
    || typeof value.token !== 'string'
  ) throw new PasswordResetServiceError('invalid_request');
  const passwordBytes = Buffer.byteLength(value.newPassword, 'utf8');
  if (!TOKEN_PATTERN.test(value.token) || passwordBytes < 12 || passwordBytes > MAX_PASSWORD_BYTES) {
    throw new PasswordResetServiceError('invalid_request');
  }
  return { newPassword: value.newPassword, token: value.token };
}

export function hashPasswordResetToken(token: string): Buffer {
  return createHash('sha256')
    .update('kodex-password-reset-v1\0', 'utf8')
    .update(token, 'utf8')
    .digest();
}

export class PasswordResetService {
  readonly #clock: () => Date;
  readonly #delay: (milliseconds: number) => Promise<void>;
  readonly #minimumRequestDurationMs: number;
  readonly #monotonicClock: () => number;
  readonly #randomToken: () => Buffer;
  readonly #ttlMs: number;

  constructor(
    private readonly repository: PasswordResetRepository,
    private readonly passwordHasher: PasswordHasher,
    private readonly delivery: PasswordResetDelivery,
    private readonly abuseRateLimiter: AbuseRateLimiter,
    options: PasswordResetServiceOptions = {},
  ) {
    this.#clock = options.clock ?? (() => new Date());
    this.#delay = options.delay ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.#minimumRequestDurationMs = options.minimumRequestDurationMs ?? DEFAULT_MINIMUM_REQUEST_DURATION_MS;
    this.#monotonicClock = options.monotonicClock ?? (() => performance.now());
    this.#randomToken = options.randomToken ?? (() => randomBytes(32));
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    if (!Number.isSafeInteger(this.#ttlMs) || this.#ttlMs < 15 * 60_000 || this.#ttlMs > 24 * 60 * 60_000) {
      throw new Error('Password reset TTL must be between 15 minutes and 24 hours');
    }
    if (
      !Number.isSafeInteger(this.#minimumRequestDurationMs)
      || this.#minimumRequestDurationMs < 0
      || this.#minimumRequestDurationMs > 5_000
    ) throw new Error('Password reset minimum request duration must be between 0 and 5000 milliseconds');
  }

  async request(value: unknown, request: { directAddress: string }): Promise<{ deliveryFailed: boolean }> {
    const email = requestEmail(value);
    const startedAt = this.#monotonicClock();
    try {
      const now = this.#clock();
      const limited = await this.abuseRateLimiter.consume('password_reset_request', [
        { kind: 'address', value: normalizeDirectAddress(request.directAddress) },
        { kind: 'email', value: email },
      ], now);
      if (!limited.allowed) throw new ProductAbuseRateLimitError(limited.retryAfterSeconds ?? 1);
      const account = await this.repository.findActiveAccountByEmail(email);
      if (!account) return { deliveryFailed: false };
      const bytes = this.#randomToken();
      if (bytes.length < 32) throw new Error('Password reset token generator returned fewer than 32 bytes');
      const token = bytes.toString('base64url');
      const expiresAt = new Date(now.getTime() + this.#ttlMs);
      const requestId = await this.repository.createPasswordReset({
        userId: account.userId,
        tokenHash: hashPasswordResetToken(token),
        createdAt: now,
        expiresAt,
      });
      try {
        await this.delivery.send({ email: account.email, expiresAt, token });
        return { deliveryFailed: false };
      } catch {
        await this.repository.markPasswordResetDeliveryFailed(requestId, this.#clock());
        return { deliveryFailed: true };
      }
    } finally {
      const remaining = this.#minimumRequestDurationMs - (this.#monotonicClock() - startedAt);
      if (remaining > 0) await this.#delay(remaining);
    }
  }

  async complete(value: unknown, request: { directAddress: string }): Promise<number> {
    const input = completion(value);
    const now = this.#clock();
    const limited = await this.abuseRateLimiter.consume('password_reset_complete', [
      { kind: 'address', value: normalizeDirectAddress(request.directAddress) },
      { kind: 'token', value: input.token },
    ], now);
    if (!limited.allowed) throw new ProductAbuseRateLimitError(limited.retryAfterSeconds ?? 1);
    const nextPasswordHash = await this.passwordHasher.hash(input.newPassword);
    try {
      return await this.repository.consumePasswordReset({
        consumedAt: now,
        nextPasswordHash,
        tokenHash: hashPasswordResetToken(input.token),
      });
    } catch (error) {
      if (error instanceof PasswordResetUnavailableError) {
        throw new PasswordResetServiceError('reset_unavailable');
      }
      throw error;
    }
  }
}
