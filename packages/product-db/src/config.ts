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

function parseCaCertificate(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const certificate = value.replaceAll('\\n', '\n').trim();
  if (
    Buffer.byteLength(certificate, 'utf8') > 256 * 1024
    || !certificate.startsWith('-----BEGIN CERTIFICATE-----')
    || !certificate.endsWith('-----END CERTIFICATE-----')
    || certificate.includes('\0')
  ) return configurationError('PRODUCT_DB_CA_CERT must contain a bounded PEM certificate chain');
  return `${certificate}\n`;
}

function parseSslMode(
  value: string | undefined,
  caCertificate: string | undefined,
): ProductDatabaseConfig['ssl'] | undefined {
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
    const ca = parseCaCertificate(caCertificate);
    return { rejectUnauthorized: true, ...(ca ? { ca } : {}) };
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

function databaseConfigForUrl(
  databaseUrl: string | undefined,
  applicationName: string,
  env: NodeJS.ProcessEnv,
): ProductDatabaseConfig | undefined {
  const trimmed = databaseUrl?.trim();
  if (!trimmed) return undefined;
  const connectionString = validateDatabaseUrl(trimmed);
  const config: ProductDatabaseConfig = {
    connectionString,
    application_name: applicationName,
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
  const ssl = parseSslMode(env.PRODUCT_DB_SSL, env.PRODUCT_DB_CA_CERT);
  if (ssl !== undefined) config.ssl = ssl;
  return config;
}

/** Returns undefined when the product database is intentionally not configured. */
export function productDatabaseConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ProductDatabaseConfig | undefined {
  return databaseConfigForUrl(
    env.DATABASE_URL,
    env.PRODUCT_DB_APPLICATION_NAME?.trim() || 'kodex-product',
    env,
  );
}

export function productMigrationDatabaseConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ProductDatabaseConfig | undefined {
  return databaseConfigForUrl(env.PRODUCT_DB_MIGRATION_URL, 'kodex-product-migration', env);
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

export function requireProductMigrationDatabaseConfig(
  env: NodeJS.ProcessEnv = process.env,
): ProductDatabaseConfig {
  const config = productMigrationDatabaseConfigFromEnv(env);
  if (!config) return configurationError('PRODUCT_DB_MIGRATION_URL is required for production migrations');
  return config;
}
