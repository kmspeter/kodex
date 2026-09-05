import type { Pool } from 'pg';
import {
  ProductDatabaseConfigurationError,
  requireProductDatabaseConfig,
  requireProductMigrationDatabaseConfig,
} from './config.js';
import { createProductDatabase, type ProductDatabase } from './database.js';

export type ProductDatabaseDeploymentProfile = 'acceptance' | 'development' | 'production' | 'test';

function configurationError(message: string): never {
  throw new ProductDatabaseConfigurationError(message);
}

function roleFromUrl(value: string | undefined, name: string): string {
  let url: URL;
  try { url = new URL(value ?? ''); } catch { return configurationError(`${name} must be a valid PostgreSQL URL`); }
  let role: string;
  try { role = decodeURIComponent(url.username); } catch { return configurationError(`${name} contains an invalid role`); }
  if (url.search || url.hash || !/^[a-z_][a-z0-9_]{0,62}$/u.test(role)) {
    return configurationError(`${name} must identify one simple lowercase PostgreSQL role without URL parameters`);
  }
  return role;
}

export function productDatabaseDeploymentProfileFromEnv(env: NodeJS.ProcessEnv = process.env): ProductDatabaseDeploymentProfile {
  const runtime = env.PRODUCT_API_NODE_ENV ?? env.NODE_ENV;
  const profile = env.KODEX_DEPLOYMENT_PROFILE?.trim() || runtime || 'development';
  if (!['acceptance', 'development', 'production', 'test'].includes(profile)) {
    return configurationError('KODEX_DEPLOYMENT_PROFILE must be acceptance, development, production, or test');
  }
  if (runtime === 'production' && !['production', 'acceptance'].includes(profile)) {
    return configurationError('A production process cannot use a development or test database profile');
  }
  if (profile === 'acceptance') {
    if (env.KODEX_ACCEPTANCE_ALLOW_SINGLE_DB !== '1') {
      return configurationError('Acceptance requires KODEX_ACCEPTANCE_ALLOW_SINGLE_DB=1');
    }
    let hostname: string;
    try { hostname = new URL(env.DATABASE_URL ?? '').hostname.toLowerCase(); } catch { return configurationError('Acceptance DATABASE_URL is invalid'); }
    if (!['127.0.0.1', '::1', 'localhost'].includes(hostname)) {
      return configurationError('Acceptance single-role PostgreSQL must be loopback-only');
    }
  }
  return profile as ProductDatabaseDeploymentProfile;
}

export async function assertProductDatabaseRoleContract(
  pool: Pick<Pool, 'query'>,
  kind: 'application' | 'migration',
  expectedRole: string,
): Promise<void> {
  const result = await pool.query<{
    canCreateDatabase: boolean; canCreateRole: boolean; canCreateSchema: boolean;
    canReplicate: boolean; canSuperuser: boolean; canBypassRls: boolean;
    currentUser: string; memberOfOwner: boolean;
  }>(`
    SELECT current_user AS "currentUser", role.rolsuper AS "canSuperuser",
      role.rolcreaterole AS "canCreateRole", role.rolcreatedb AS "canCreateDatabase",
      role.rolreplication AS "canReplicate", role.rolbypassrls AS "canBypassRls",
      pg_has_role(current_user, database.datdba, 'MEMBER') AS "memberOfOwner",
      has_schema_privilege(current_user, 'public', 'CREATE') AS "canCreateSchema"
    FROM pg_catalog.pg_roles role
    JOIN pg_catalog.pg_database database ON database.datname = current_database()
    WHERE role.rolname = current_user
  `);
  const row = result.rows[0];
  const broad = !row || row.currentUser !== expectedRole || row.canSuperuser || row.canCreateRole
    || row.canCreateDatabase || row.canReplicate || row.canBypassRls;
  if (broad || (kind === 'application' ? row.memberOfOwner || row.canCreateSchema : !row.memberOfOwner || !row.canCreateSchema)) {
    throw new Error(`Database ${kind} role violates the production least-privilege contract`);
  }
  if (kind === 'application') {
    const access = (await pool.query<{
      forbidden: boolean; ledgerReadable: boolean; ledgerWritable: boolean; missingCrud: boolean; schemaUsage: boolean;
    }>(`
      SELECT has_schema_privilege(current_user, 'public', 'USAGE') AS "schemaUsage",
        has_table_privilege(current_user, 'public.schema_migrations', 'SELECT') AS "ledgerReadable",
        (has_table_privilege(current_user, 'public.schema_migrations', 'INSERT')
          OR has_table_privilege(current_user, 'public.schema_migrations', 'UPDATE')
          OR has_table_privilege(current_user, 'public.schema_migrations', 'DELETE')) AS "ledgerWritable",
        EXISTS (
          SELECT 1 FROM pg_catalog.pg_class entry
          JOIN pg_catalog.pg_namespace namespace ON namespace.oid = entry.relnamespace
          WHERE namespace.nspname = 'public' AND entry.relkind IN ('r', 'p')
            AND entry.relname <> 'schema_migrations'
            AND NOT (has_table_privilege(current_user, entry.oid, 'SELECT')
              AND has_table_privilege(current_user, entry.oid, 'INSERT')
              AND has_table_privilege(current_user, entry.oid, 'UPDATE')
              AND has_table_privilege(current_user, entry.oid, 'DELETE'))
        ) AS "missingCrud",
        EXISTS (
          SELECT 1 FROM pg_catalog.pg_class entry
          JOIN pg_catalog.pg_namespace namespace ON namespace.oid = entry.relnamespace
          WHERE namespace.nspname = 'public' AND entry.relkind IN ('r', 'p')
            AND (has_table_privilege(current_user, entry.oid, 'TRUNCATE')
              OR has_table_privilege(current_user, entry.oid, 'REFERENCES')
              OR has_table_privilege(current_user, entry.oid, 'TRIGGER'))
        ) AS "forbidden"
    `)).rows[0];
    if (!access?.schemaUsage || !access.ledgerReadable || access.ledgerWritable || access.missingCrud || access.forbidden) {
      throw new Error('Database application role violates the production table privilege contract');
    }
  }
}

async function grantApplicationPrivileges(pool: Pick<Pool, 'query'>, role: string): Promise<void> {
  const quoted = `"${role}"`;
  await pool.query(`GRANT USAGE ON SCHEMA public TO ${quoted}`);
  await pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${quoted}`);
  await pool.query(`GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${quoted}`);
  await pool.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${quoted}`);
  await pool.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${quoted}`);
  await pool.query(`REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.schema_migrations FROM ${quoted}`);
  await pool.query(`GRANT SELECT ON public.schema_migrations TO ${quoted}`);
}

export async function bootstrapProductDatabase(env: NodeJS.ProcessEnv = process.env): Promise<ProductDatabase> {
  const profile = productDatabaseDeploymentProfileFromEnv(env);
  const database = createProductDatabase(requireProductDatabaseConfig(env));
  try {
    if (profile === 'production') {
      await assertProductDatabaseRoleContract(database.pool, 'application', roleFromUrl(env.DATABASE_URL, 'DATABASE_URL'));
      await database.verifyMigrations();
    } else await database.migrate();
    return database;
  } catch (error) {
    await database.close().catch(() => undefined);
    throw error;
  }
}

export async function migrateProductDatabaseForDeployment(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const profile = productDatabaseDeploymentProfileFromEnv(env);
  const config = profile === 'production' ? requireProductMigrationDatabaseConfig(env) : requireProductDatabaseConfig(env);
  const database = createProductDatabase(config);
  try {
    if (profile === 'production') {
      const migrationRole = roleFromUrl(env.PRODUCT_DB_MIGRATION_URL, 'PRODUCT_DB_MIGRATION_URL');
      const applicationRole = env.PRODUCT_DB_APPLICATION_ROLE?.trim();
      if (!applicationRole || !/^[a-z_][a-z0-9_]{0,62}$/u.test(applicationRole) || applicationRole === migrationRole) {
        return configurationError('Production requires distinct migration and application PostgreSQL roles');
      }
      await assertProductDatabaseRoleContract(database.pool, 'migration', migrationRole);
      await database.migrate();
      await grantApplicationPrivileges(database.pool, applicationRole);
      return;
    }
    await database.migrate();
  } finally {
    await database.close();
  }
}
