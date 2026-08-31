import type { PoolConfig } from 'pg';

export type ProductDatabaseSslMode = 'disable' | 'require' | 'verify-full';

export interface ProductDatabaseConfig extends PoolConfig {
  application_name: string;
  connectionString: string;
}

function parsePositiveInteger(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined || value.trim() === '') {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
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
  throw new Error('PRODUCT_DB_SSL must be disable, require, or verify-full');
}

/** Returns undefined when the product database is intentionally not configured. */
export function productDatabaseConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ProductDatabaseConfig | undefined {
  const connectionString = env.DATABASE_URL?.trim();
  if (!connectionString) {
    return undefined;
  }

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
    throw new Error('DATABASE_URL is required for product database operations');
  }
  return config;
}
