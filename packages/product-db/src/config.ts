import type { PoolConfig } from 'pg';

export type ProductDatabaseSslMode = 'disable' | 'require' | 'verify-full';

export interface ProductDatabaseConfig extends PoolConfig {
  application_name: string;
  connectionString: string;
}

export class ProductDatabaseConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProductDatabaseConfigurationError';
  }
}

function configurationError(message: string): never {
  throw new ProductDatabaseConfigurationError(message);
}

function parsePositiveInteger(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined || value.trim() === '') {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return configurationError(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseSslMode(value: string | undefined): ProductDatabaseConfig['ssl'] | undefined {
  if (value === undefined || value.trim() === '') {
    return undefined;
  }

  const mode = value.trim() as ProductDatabaseSslMode;
  if (mode === 'disable') {
    return false;
  }
  if (mode === 'require') {
    return { rejectUnauthorized: false };
  }
  if (mode === 'verify-full') {
    return { rejectUnauthorized: true };
  }
  return configurationError('PRODUCT_DB_SSL must be disable, require, or verify-full');
}

function validateDatabaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return configurationError('DATABASE_URL must be a valid PostgreSQL URL');
  }
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol)
    || !url.hostname
    || url.pathname === '/'
    || !url.pathname
    || url.hash
  ) {
    return configurationError('DATABASE_URL must be a valid PostgreSQL URL');
  }
  return value;
}

/** Returns undefined when the product database is intentionally not configured. */
export function productDatabaseConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ProductDatabaseConfig | undefined {
  const databaseUrl = env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    return undefined;
  }
  const connectionString = validateDatabaseUrl(databaseUrl);

  const config: ProductDatabaseConfig = {
    connectionString,
    application_name: env.PRODUCT_DB_APPLICATION_NAME?.trim() || 'kodex-product',
    max: parsePositiveInteger(env.PRODUCT_DB_POOL_MAX, 'PRODUCT_DB_POOL_MAX', 10),
    idleTimeoutMillis: parsePositiveInteger(
      env.PRODUCT_DB_IDLE_TIMEOUT_MS,
      'PRODUCT_DB_IDLE_TIMEOUT_MS',
      30_000,
    ),
    connectionTimeoutMillis: parsePositiveInteger(
      env.PRODUCT_DB_CONNECT_TIMEOUT_MS,
      'PRODUCT_DB_CONNECT_TIMEOUT_MS',
      5_000,
    ),
  };

  const ssl = parseSslMode(env.PRODUCT_DB_SSL);
  if (ssl !== undefined) {
    config.ssl = ssl;
  }
  return config;
}

export function requireProductDatabaseConfig(
  env: NodeJS.ProcessEnv = process.env,
): ProductDatabaseConfig {
  const config = productDatabaseConfigFromEnv(env);
  if (!config) {
    return configurationError('DATABASE_URL is required for product database operations');
  }
  return config;
}
