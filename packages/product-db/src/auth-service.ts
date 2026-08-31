import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  RegistrationConflictError,
  type AuthRepository,
} from './auth-repository.js';
import type { AuthContext, WorkspaceMembership } from './auth-types.js';
import type { PasswordHasher } from './password.js';

export type AuthErrorCode =
  | 'invalid_request'
  | 'invalid_credentials'
  | 'registration_failed'
  | 'unauthenticated';

export class AuthServiceError extends Error {
  constructor(readonly code: AuthErrorCode) {
    super(code);
    this.name = 'AuthServiceError';
  }
}

export interface AuthSessionResult {
  context: AuthContext;
  defaultWorkspace?: WorkspaceMembership;
  token: string;
}

export interface AuthServiceOptions {
  clock?: () => Date;
  dummyPasswordHash?: string;
  randomToken?: () => Buffer;
  sessionTtlMs?: number;
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

export function hashSessionToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

export class AuthService {
  readonly #clock: () => Date;
  readonly #dummyPasswordHash: string;
  readonly #randomToken: () => Buffer;
  readonly #sessionTtlMs: number;

  private constructor(
    private readonly repository: AuthRepository,
    private readonly passwordHasher: PasswordHasher,
    options: Required<AuthServiceOptions>,
  ) {
    this.#clock = options.clock;
    this.#dummyPasswordHash = options.dummyPasswordHash;
    this.#randomToken = options.randomToken;
    this.#sessionTtlMs = options.sessionTtlMs;
  }

  static async create(
    repository: AuthRepository,
    passwordHasher: PasswordHasher,
    options: AuthServiceOptions = {},
  ): Promise<AuthService> {
    const randomToken = options.randomToken ?? (() => randomBytes(32));
    const dummyPasswordHash = options.dummyPasswordHash
      ?? await passwordHasher.hash(randomBytes(32).toString('base64url'));
    return new AuthService(repository, passwordHasher, {
      clock: options.clock ?? (() => new Date()),
      dummyPasswordHash,
      randomToken,
      sessionTtlMs: options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS,
    });
  }

  async register(value: unknown): Promise<AuthSessionResult> {
    const input = parseRegistrationInput(value);
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
      });
      return {
        token,
        context: record.context,
        defaultWorkspace: record.defaultWorkspace,
      };
    } catch (error) {
      if (error instanceof RegistrationConflictError) {
        throw new AuthServiceError('registration_failed');
      }
      throw error;
    }
  }

  async login(value: unknown): Promise<AuthSessionResult> {
    const input = parseLoginInput(value);
    const credential = await this.repository.findLoginCredential(input.email);
    const verified = await this.passwordHasher.verify(
      credential?.passwordHash ?? this.#dummyPasswordHash,
      input.password,
    );
    if (!credential || !verified) {
      throw new AuthServiceError('invalid_credentials');
    }

    if (this.passwordHasher.needsRehash(credential.passwordHash)) {
      const nextHash = await this.passwordHasher.hash(input.password);
      await this.repository.updatePasswordHash(
        credential.user.id,
        credential.passwordHash,
        nextHash,
      );
    }
    const { token, tokenHash, expiresAt } = this.#newSession();
    const context = await this.repository.createSession({
      userId: credential.user.id,
      tokenHash,
      expiresAt,
    });
    return { token, context };
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
