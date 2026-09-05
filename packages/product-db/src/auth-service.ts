import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import {
  PasswordChangeRejectedError,
  LoginCredentialChangedError,
  RegistrationConflictError,
  SessionNotFoundError,
  type AuthRepository,
} from './auth-repository.js';
import type { AuthContext, AuthSession, WorkspaceMembership } from './auth-types.js';
import type { LoginRateLimiter } from './login-rate-limiter.js';
import {
  normalizeDirectAddress,
  ProductAbuseRateLimitError,
  type AbuseRateLimiter,
} from './abuse-rate-limiter.js';
import type { PasswordHasher } from './password.js';

export type AuthErrorCode =
  | 'invalid_request'
  | 'invalid_credentials'
  | 'not_found'
  | 'password_change_failed'
  | 'rate_limited'
  | 'registration_failed'
  | 'unauthenticated';

export class AuthServiceError extends Error {
  constructor(readonly code: AuthErrorCode, readonly retryAfterSeconds?: number) {
    super(code);
    this.name = 'AuthServiceError';
  }
}

export interface AuthSessionResult {
  context: AuthContext;
  defaultWorkspace?: WorkspaceMembership;
  token: string;
  verificationPending?: true;
}

export interface AuthServiceOptions {
  abuseRateLimiter?: AbuseRateLimiter;
  clock?: () => Date;
  dummyPasswordHash?: string;
  loginRateLimiter: LoginRateLimiter;
  loginRateLimitSecret: Buffer;
  requireEmailVerification?: boolean;
  randomToken?: () => Buffer;
  sessionTtlMs?: number;
}

interface ResolvedAuthServiceOptions extends Omit<Required<AuthServiceOptions>, 'abuseRateLimiter'> {
  abuseRateLimiter?: AbuseRateLimiter;
}

interface RegistrationInput {
  displayName: string | null;
  email: string;
  password: string;
}

interface LoginInput {
  email: string;
  password: string;
}

interface ChangePasswordInput {
  currentPassword: string;
  newPassword: string;
}

export interface LoginRequestContext {
  directAddress: string;
}

const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1_000;
const MAX_PASSWORD_BYTES = 1_024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function isValidEmail(email: string): boolean {
  return email.length >= 3
    && email.length <= 320
    && /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u.test(email);
}

function parseRegistrationInput(value: unknown): RegistrationInput {
  if (!isRecord(value) || !hasExactKeys(value, ['email', 'password', 'displayName'])) {
    throw new AuthServiceError('invalid_request');
  }
  if (typeof value.email !== 'string' || typeof value.password !== 'string') {
    throw new AuthServiceError('invalid_request');
  }
  const email = normalizeEmail(value.email);
  const passwordBytes = Buffer.byteLength(value.password, 'utf8');
  if (!isValidEmail(email) || passwordBytes < 12 || passwordBytes > MAX_PASSWORD_BYTES) {
    throw new AuthServiceError('invalid_request');
  }
  let displayName: string | null = null;
  if (value.displayName !== undefined && value.displayName !== null) {
    if (typeof value.displayName !== 'string') {
      throw new AuthServiceError('invalid_request');
    }
    displayName = value.displayName.trim();
    if (!displayName || displayName.length > 100) {
      throw new AuthServiceError('invalid_request');
    }
  }
  return { email, password: value.password, displayName };
}

function parseLoginInput(value: unknown): LoginInput {
  if (!isRecord(value) || !hasExactKeys(value, ['email', 'password'])) {
    throw new AuthServiceError('invalid_request');
  }
  if (typeof value.email !== 'string' || typeof value.password !== 'string') {
    throw new AuthServiceError('invalid_request');
  }
  const email = normalizeEmail(value.email);
  const passwordBytes = Buffer.byteLength(value.password, 'utf8');
  if (!isValidEmail(email) || passwordBytes < 1 || passwordBytes > MAX_PASSWORD_BYTES) {
    throw new AuthServiceError('invalid_credentials');
  }
  return { email, password: value.password };
}

function parseChangePasswordInput(value: unknown): ChangePasswordInput {
  if (!isRecord(value) || !hasExactKeys(value, ['currentPassword', 'newPassword'])) {
    throw new AuthServiceError('invalid_request');
  }
  if (typeof value.currentPassword !== 'string' || typeof value.newPassword !== 'string') {
    throw new AuthServiceError('invalid_request');
  }
  const currentBytes = Buffer.byteLength(value.currentPassword, 'utf8');
  const newBytes = Buffer.byteLength(value.newPassword, 'utf8');
  if (
    currentBytes < 1
    || currentBytes > MAX_PASSWORD_BYTES
    || newBytes < 12
    || newBytes > MAX_PASSWORD_BYTES
    || value.currentPassword === value.newPassword
  ) {
    throw new AuthServiceError('invalid_request');
  }
  return { currentPassword: value.currentPassword, newPassword: value.newPassword };
}

export function hashSessionToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

export function loginRateLimitBucket(
  secret: Buffer,
  dimension: 'address' | 'email',
  identifier: string,
): Buffer {
  if (secret.length < 32) throw new Error('Login rate limit secret must contain at least 32 bytes');
  return createHmac('sha256', secret)
    .update(`kodex-login-${dimension}\0`, 'utf8')
    .update(identifier, 'utf8')
    .digest();
}

export class AuthService {
  readonly #abuseRateLimiter: AbuseRateLimiter | undefined;
  readonly #clock: () => Date;
  readonly #dummyPasswordHash: string;
  readonly #loginRateLimiter: LoginRateLimiter;
  readonly #loginRateLimitSecret: Buffer;
  readonly #randomToken: () => Buffer;
  readonly #requireEmailVerification: boolean;
  readonly #sessionTtlMs: number;

  private constructor(
    private readonly repository: AuthRepository,
    private readonly passwordHasher: PasswordHasher,
    options: ResolvedAuthServiceOptions,
  ) {
    this.#abuseRateLimiter = options.abuseRateLimiter;
    this.#clock = options.clock;
    this.#dummyPasswordHash = options.dummyPasswordHash;
    this.#loginRateLimiter = options.loginRateLimiter;
    this.#loginRateLimitSecret = options.loginRateLimitSecret;
    this.#randomToken = options.randomToken;
    this.#requireEmailVerification = options.requireEmailVerification;
    this.#sessionTtlMs = options.sessionTtlMs;
  }

  static async create(
    repository: AuthRepository,
    passwordHasher: PasswordHasher,
    options: AuthServiceOptions,
  ): Promise<AuthService> {
    if (!Buffer.isBuffer(options.loginRateLimitSecret) || options.loginRateLimitSecret.length < 32) {
      throw new Error('Login rate limit secret must contain at least 32 bytes');
    }
    const randomToken = options.randomToken ?? (() => randomBytes(32));
    const dummyPasswordHash = options.dummyPasswordHash
      ?? await passwordHasher.hash(randomBytes(32).toString('base64url'));
    return new AuthService(repository, passwordHasher, {
      abuseRateLimiter: options.abuseRateLimiter,
      clock: options.clock ?? (() => new Date()),
      dummyPasswordHash,
      loginRateLimiter: options.loginRateLimiter,
      loginRateLimitSecret: Buffer.from(options.loginRateLimitSecret),
      randomToken,
      requireEmailVerification: options.requireEmailVerification ?? false,
      sessionTtlMs: options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS,
    });
  }

  async register(value: unknown, request?: LoginRequestContext): Promise<AuthSessionResult> {
    const input = parseRegistrationInput(value);
    if (this.#abuseRateLimiter) {
      if (!request) throw new AuthServiceError('invalid_request');
      let directAddress: string;
      try {
        directAddress = normalizeDirectAddress(request.directAddress);
      } catch {
        throw new AuthServiceError('invalid_request');
      }
      const limited = await this.#abuseRateLimiter.consume('register', [
        { kind: 'address', value: directAddress },
        { kind: 'email', value: input.email },
      ], this.#clock());
      if (!limited.allowed) {
        throw new ProductAbuseRateLimitError(limited.retryAfterSeconds ?? 1);
      }
    }
    const passwordHash = await this.passwordHasher.hash(input.password);
    const { token, tokenHash, expiresAt } = this.#newSession();
    try {
      const record = await this.repository.registerAccount({
        email: input.email,
        displayName: input.displayName,
        passwordHash,
        workspaceName: 'Personal Workspace',
        workspaceSlug: `personal-${randomUUID()}`,
        sessionTokenHash: tokenHash,
        sessionExpiresAt: expiresAt,
        requireEmailVerification: this.#requireEmailVerification,
      });
      return {
        token,
        context: record.context,
        defaultWorkspace: record.defaultWorkspace,
        ...(this.#requireEmailVerification ? { verificationPending: true as const } : {}),
      };
    } catch (error) {
      if (error instanceof RegistrationConflictError) {
        throw new AuthServiceError('registration_failed');
      }
      throw error;
    }
  }

  async login(value: unknown, request: LoginRequestContext): Promise<AuthSessionResult> {
    const input = parseLoginInput(value);
    if (
      typeof request.directAddress !== 'string'
      || request.directAddress.trim().length < 1
      || request.directAddress.length > 128
    ) {
      throw new AuthServiceError('invalid_request');
    }
    const credential = await this.repository.findLoginCredential(input.email);
    const emailBucket = loginRateLimitBucket(this.#loginRateLimitSecret, 'email', input.email);
    const addressBucket = loginRateLimitBucket(
      this.#loginRateLimitSecret,
      'address',
      request.directAddress.trim().toLowerCase(),
    );
    const limited = await this.#loginRateLimiter.run(
      [emailBucket, addressBucket],
      [emailBucket],
      this.#clock(),
      async () => {
        const verified = await this.passwordHasher.verify(
          credential?.passwordHash ?? this.#dummyPasswordHash,
          input.password,
        );
        return Boolean(credential) && verified;
      },
    );
    if (!limited.allowed) {
      throw new AuthServiceError('rate_limited', limited.retryAfterSeconds);
    }
    if (!credential || !limited.succeeded) {
      throw new AuthServiceError('invalid_credentials');
    }

    const { token, tokenHash, expiresAt } = this.#newSession();
    let context: AuthContext;
    try {
      context = await this.repository.createSession({
        userId: credential.user.id,
        credentialHash: credential.passwordHash,
        tokenHash,
        expiresAt,
      });
    } catch (error) {
      if (error instanceof LoginCredentialChangedError) {
        throw new AuthServiceError('invalid_credentials');
      }
      throw error;
    }
    if (this.passwordHasher.needsRehash(credential.passwordHash)) {
      const nextHash = await this.passwordHasher.hash(input.password);
      await this.repository.updatePasswordHash(
        credential.user.id,
        credential.passwordHash,
        nextHash,
      );
    }
    return {
      token,
      context,
      ...(credential.emailVerified === false ? { verificationPending: true as const } : {}),
    };
  }

  async authenticate(token: string | undefined): Promise<AuthContext> {
    if (!token) {
      throw new AuthServiceError('unauthenticated');
    }
    const context = await this.repository.findAuthContext(hashSessionToken(token));
    if (!context) {
      throw new AuthServiceError('unauthenticated');
    }
    return context;
  }

  async logout(token: string | undefined): Promise<void> {
    if (!token) {
      throw new AuthServiceError('unauthenticated');
    }
    await this.repository.revokeSession(hashSessionToken(token));
  }

  async changePassword(context: AuthContext, value: unknown): Promise<number> {
    const input = parseChangePasswordInput(value);
    const nextPasswordHash = await this.passwordHasher.hash(input.newPassword);
    try {
      return await this.repository.changePassword({
        userId: context.user.id,
        currentSessionId: context.sessionId,
        nextPasswordHash,
        verifyCurrentPassword: (storedHash) => this.passwordHasher.verify(
          storedHash,
          input.currentPassword,
        ),
      });
    } catch (error) {
      if (error instanceof PasswordChangeRejectedError) {
        throw new AuthServiceError('password_change_failed');
      }
      throw error;
    }
  }

  listSessions(context: AuthContext): Promise<AuthSession[]> {
    return this.repository.listSessions(context.user.id, context.sessionId);
  }

  async revokeSession(context: AuthContext, sessionId: string): Promise<boolean> {
    try {
      return await this.repository.revokeSessionById(
        context.user.id,
        sessionId,
        context.sessionId,
      );
    } catch (error) {
      if (error instanceof SessionNotFoundError) throw new AuthServiceError('not_found');
      throw error;
    }
  }

  revokeOtherSessions(context: AuthContext): Promise<number> {
    return this.repository.revokeOtherSessions(context.user.id, context.sessionId);
  }

  revokeAllSessions(context: AuthContext): Promise<number> {
    return this.repository.revokeAllSessions(context.user.id, context.sessionId);
  }

  #newSession(): { expiresAt: Date; token: string; tokenHash: Buffer } {
    const bytes = this.#randomToken();
    if (bytes.length < 32) {
      throw new Error('Session token generator returned fewer than 32 bytes');
    }
    const token = bytes.toString('base64url');
    return {
      token,
      tokenHash: hashSessionToken(token),
      expiresAt: new Date(this.#clock().getTime() + this.#sessionTtlMs),
    };
  }
}
