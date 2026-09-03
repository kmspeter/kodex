export interface ProductApiConfig {
  allowedHosts: Set<string>;
  allowedOrigins: Set<string>;
  cookieSecret: Buffer;
  host: string;
  loginRateLimitBlockMs: number;
  loginRateLimitMaxAttempts: number;
  loginRateLimitWindowMs: number;
  maxBodyBytes: number;
  port: number;
  secureCookies: boolean;
  sessionTtlMs: number;
  workspaceInvitationPendingLimit?: number;
  workspaceInvitationTtlMs?: number;
}

export class ProductApiConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProductApiConfigurationError';
  }
}

const KNOWLEDGE_JSON_OVERHEAD_BYTES = 8_192;

function configurationError(message: string): never {
  throw new ProductApiConfigurationError(message);
}

function positiveInteger(
  value: string | undefined,
  name: string,
  fallback: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (value === undefined || value.trim() === '') {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum) {
    return configurationError(`${name} must be a positive integer no greater than ${maximum}`);
  }
  return parsed;
}

function boundedInteger(
  value: string | undefined,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = positiveInteger(value, name, fallback, maximum);
  if (parsed < minimum) {
    return configurationError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function booleanValue(value: string | undefined, name: string, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') {
    return fallback;
  }
  if (value === 'true' || value === '1') {
    return true;
  }
  if (value === 'false' || value === '0') {
    return false;
  }
  return configurationError(`${name} must be true or false`);
}

function commaSeparated(value: string, name: string): string[] {
  const entries = value.split(',').map((entry) => entry.trim()).filter(Boolean);
  if (entries.length === 0 || new Set(entries).size !== entries.length) {
    return configurationError(`${name} must contain one or more unique comma-separated values`);
  }
  return entries;
}

function parseAllowedOrigins(value: string, production: boolean): Set<string> {
  const origins = commaSeparated(value, 'AUTH_ALLOWED_ORIGINS');
  for (const origin of origins) {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      return configurationError('AUTH_ALLOWED_ORIGINS entries must be absolute HTTP(S) origins');
    }
    if (
      !['http:', 'https:'].includes(url.protocol)
      || url.origin !== origin
      || url.username
      || url.password
    ) {
      return configurationError('AUTH_ALLOWED_ORIGINS entries must be exact HTTP(S) origins');
    }
    if (production && url.protocol !== 'https:') {
      return configurationError('AUTH_ALLOWED_ORIGINS must use HTTPS in production');
    }
  }
  return new Set(origins);
}

function parseAllowedHosts(value: string): Set<string> {
  const hosts = commaSeparated(value.toLowerCase(), 'PRODUCT_API_ALLOWED_HOSTS');
  if (hosts.some((host) => host.includes('/') || host.includes('://') || /\s/u.test(host))) {
    return configurationError('PRODUCT_API_ALLOWED_HOSTS entries must be exact Host header values');
  }
  return new Set(hosts);
}

function parseCookieSecret(value: string | undefined): Buffer {
  if (!value || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    return configurationError('AUTH_COOKIE_SECRET must be an unpadded base64url value');
  }
  const secret = Buffer.from(value, 'base64url');
  if (secret.length < 32 || secret.toString('base64url') !== value) {
    return configurationError('AUTH_COOKIE_SECRET must contain at least 32 random bytes');
  }
  return secret;
}

export function productApiConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ProductApiConfig {
  const nodeEnvironment = env.PRODUCT_API_NODE_ENV ?? env.NODE_ENV;
  const production = nodeEnvironment === 'production';
  if (nodeEnvironment && !['development', 'test', 'production'].includes(nodeEnvironment)) {
    return configurationError('PRODUCT_API_NODE_ENV must be development, test, or production');
  }

  const host = env.PRODUCT_API_HOST?.trim() || '127.0.0.1';
  if (!host || host.includes('://') || /[\s/]/u.test(host)) {
    return configurationError('PRODUCT_API_HOST must be a bind hostname or address');
  }
  const port = positiveInteger(env.PRODUCT_API_PORT, 'PRODUCT_API_PORT', 47_832, 65_535);
  const originsValue = env.AUTH_ALLOWED_ORIGINS?.trim()
    || (production
      ? configurationError('AUTH_ALLOWED_ORIGINS is required in production')
      : 'http://127.0.0.1:5173,http://localhost:5173,http://127.0.0.1:47831,http://localhost:47831');
  const hostsValue = env.PRODUCT_API_ALLOWED_HOSTS?.trim()
    || (production
      ? configurationError('PRODUCT_API_ALLOWED_HOSTS is required in production')
      : `127.0.0.1:${port},localhost:${port}`);
  const secureCookies = booleanValue(
    env.AUTH_COOKIE_SECURE,
    'AUTH_COOKIE_SECURE',
    production,
  );
  if (production && !secureCookies) {
    return configurationError('AUTH_COOKIE_SECURE cannot be disabled in production');
  }

  const sessionTtlSeconds = positiveInteger(
    env.AUTH_SESSION_TTL_SECONDS,
    'AUTH_SESSION_TTL_SECONDS',
    43_200,
    2_592_000,
  );
  if (sessionTtlSeconds < 300) {
    return configurationError('AUTH_SESSION_TTL_SECONDS must be at least 300');
  }

  return {
    host,
    port,
    allowedOrigins: parseAllowedOrigins(originsValue, production),
    allowedHosts: parseAllowedHosts(hostsValue),
    cookieSecret: parseCookieSecret(env.AUTH_COOKIE_SECRET),
    secureCookies,
    sessionTtlMs: sessionTtlSeconds * 1_000,
    loginRateLimitMaxAttempts: boundedInteger(
      env.AUTH_LOGIN_RATE_LIMIT_ATTEMPTS,
      'AUTH_LOGIN_RATE_LIMIT_ATTEMPTS',
      5,
      2,
      20,
    ),
    loginRateLimitWindowMs: boundedInteger(
      env.AUTH_LOGIN_RATE_LIMIT_WINDOW_SECONDS,
      'AUTH_LOGIN_RATE_LIMIT_WINDOW_SECONDS',
      900,
      60,
      3_600,
    ) * 1_000,
    loginRateLimitBlockMs: boundedInteger(
      env.AUTH_LOGIN_RATE_LIMIT_BLOCK_SECONDS,
      'AUTH_LOGIN_RATE_LIMIT_BLOCK_SECONDS',
      900,
      30,
      86_400,
    ) * 1_000,
    maxBodyBytes: positiveInteger(
      env.PRODUCT_API_MAX_BODY_BYTES,
      'PRODUCT_API_MAX_BODY_BYTES',
      262_144,
      1_048_576,
    ),
    workspaceInvitationPendingLimit: boundedInteger(
      env.WORKSPACE_INVITATION_PENDING_LIMIT,
      'WORKSPACE_INVITATION_PENDING_LIMIT',
      100,
      1,
      500,
    ),
    workspaceInvitationTtlMs: boundedInteger(
      env.WORKSPACE_INVITATION_TTL_HOURS,
      'WORKSPACE_INVITATION_TTL_HOURS',
      168,
      1,
      720,
    ) * 60 * 60 * 1_000,
  };
}

export function validateKnowledgeBodyCapacity(
  config: Pick<ProductApiConfig, 'maxBodyBytes'>,
  ragConfig: { enabled: boolean; maxDocumentCharacters: number },
): void {
  if (!ragConfig.enabled) return;
  const requiredBytes = ragConfig.maxDocumentCharacters * 4 + KNOWLEDGE_JSON_OVERHEAD_BYTES;
  if (!Number.isSafeInteger(requiredBytes) || config.maxBodyBytes < requiredBytes) {
    return configurationError(
      `PRODUCT_API_MAX_BODY_BYTES must be at least ${requiredBytes} when KODEX_RAG_DOCUMENT_MAX_CHARACTERS is ${ragConfig.maxDocumentCharacters}`,
    );
  }
}
