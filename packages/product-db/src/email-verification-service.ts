import { normalizeDirectAddress, ProductAbuseRateLimitError, type AbuseRateLimiter } from './abuse-rate-limiter.js';
import { AuthServiceError, hashSessionToken } from './auth-service.js';
import {
  EmailVerificationUnavailableError,
  hashEmailVerificationToken,
  type EmailVerificationRepository,
} from './email-verification-repository.js';

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{42}[AQgw]$/u;

export class EmailVerificationServiceError extends Error {
  constructor(readonly code: 'invalid_request' | 'verification_unavailable') {
    super(code);
    this.name = 'EmailVerificationServiceError';
  }
}

export interface EmailVerificationStatus {
  email: string;
  status: 'pending' | 'verified';
}

function verificationToken(value: unknown): string {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.keys(value).length !== 1
    || !Object.hasOwn(value, 'token')
    || typeof (value as { token?: unknown }).token !== 'string'
    || !TOKEN_PATTERN.test((value as { token: string }).token)
  ) throw new EmailVerificationServiceError('invalid_request');
  return (value as { token: string }).token;
}

export class EmailVerificationService {
  readonly #clock: () => Date;

  constructor(
    private readonly repository: EmailVerificationRepository,
    private readonly abuseRateLimiter: AbuseRateLimiter,
    options: { clock?: () => Date } = {},
  ) {
    this.#clock = options.clock ?? (() => new Date());
  }

  async status(sessionToken: string | undefined): Promise<EmailVerificationStatus> {
    if (!sessionToken) throw new AuthServiceError('unauthenticated');
    const session = await this.repository.findSession(hashSessionToken(sessionToken));
    if (!session) throw new AuthServiceError('unauthenticated');
    return { email: session.email, status: session.verified ? 'verified' : 'pending' };
  }

  async resend(
    sessionToken: string | undefined,
    request: { directAddress: string },
  ): Promise<void> {
    if (!sessionToken) throw new AuthServiceError('unauthenticated');
    const session = await this.repository.findSession(hashSessionToken(sessionToken));
    if (!session) throw new AuthServiceError('unauthenticated');
    const now = this.#clock();
    const limited = await this.abuseRateLimiter.consume('email_verification_resend', [
      { kind: 'account', value: session.userId },
      { kind: 'address', value: normalizeDirectAddress(request.directAddress) },
    ], now);
    if (!limited.allowed) throw new ProductAbuseRateLimitError(limited.retryAfterSeconds ?? 1);
    if (!session.verified) await this.repository.enqueue(session.userId, now);
  }

  async complete(value: unknown, request: { directAddress: string }): Promise<void> {
    const token = verificationToken(value);
    const now = this.#clock();
    const limited = await this.abuseRateLimiter.consume('email_verification_complete', [
      { kind: 'address', value: normalizeDirectAddress(request.directAddress) },
      { kind: 'token', value: token },
    ], now);
    if (!limited.allowed) throw new ProductAbuseRateLimitError(limited.retryAfterSeconds ?? 1);
    try {
      await this.repository.consume(hashEmailVerificationToken(token), now);
    } catch (error) {
      if (error instanceof EmailVerificationUnavailableError) {
        throw new EmailVerificationServiceError('verification_unavailable');
      }
      throw error;
    }
  }
}
