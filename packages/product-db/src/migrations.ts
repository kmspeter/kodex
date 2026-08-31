import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';

const MIGRATION_FILE_PATTERN = /^(\d{4})_([a-z0-9][a-z0-9_-]*)\.sql$/;
const MIGRATION_LOCK_KEY = 1_264_490_044;

export interface Migration {
  checksum: string;
  name: string;
  sql: string;
  version: number;
}

export interface AppliedMigration {
  checksum: string;
  name: string;
  version: number;
}

interface AppliedMigrationRow {
  checksum: string;
  name: string;
  version: string;
}

export const defaultMigrationsDirectory = fileURLToPath(
  new URL('../migrations/', import.meta.url),
);

export async function loadMigrations(
  directory = defaultMigrationsDirectory,
): Promise<Migration[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const migrations: Migration[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.sql')) {
      continue;
    }

    const match = MIGRATION_FILE_PATTERN.exec(entry.name);
    if (!match) {
      throw new Error(`Invalid migration filename: ${entry.name}`);
    }

    const sql = await readFile(join(directory, entry.name), 'utf8');
    migrations.push({
      version: Number(match[1]),
      name: match[2],
      sql,
      checksum: createHash('sha256').update(sql).digest('hex'),
    });
  }

  migrations.sort((left, right) => left.version - right.version);
  if (migrations.length === 0) {
    throw new Error(`No SQL migrations found in ${directory}`);
  }

  for (let index = 0; index < migrations.length; index += 1) {
    const migration = migrations[index];
    const expectedVersion = index + 1;
    if (migration.version !== expectedVersion) {
      throw new Error(
        `Migration versions must be contiguous from 0001; expected ${expectedVersion}, found ${migration.version}`,
      );
    }
  }

  return migrations;
}

export async function migrateProductDatabase(
  pool: Pool,
  directory = defaultMigrationsDirectory,
): Promise<AppliedMigration[]> {
  const migrations = await loadMigrations(directory);
  const client = await pool.connect();
  let transactionStarted = false;

  try {
    await client.query('BEGIN');
    transactionStarted = true;
    await client.query('SET LOCAL search_path TO public, pg_catalog');
    await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.schema_migrations (
        version bigint PRIMARY KEY,
        name text NOT NULL,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const appliedResult = await client.query<AppliedMigrationRow>(
      'SELECT version, name, checksum FROM public.schema_migrations ORDER BY version',
    );
    const availableByVersion = new Map(
      migrations.map((migration) => [String(migration.version), migration]),
    );

    for (const applied of appliedResult.rows) {
      const available = availableByVersion.get(applied.version);
      if (!available) {
        throw new Error(
          `Database migration ${applied.version} is not present in this application version`,
        );
      }
      if (available.name !== applied.name || available.checksum !== applied.checksum) {
        throw new Error(`Migration ${applied.version} has changed after it was applied`);
      }
    }

    const alreadyApplied = new Set(appliedResult.rows.map((row) => row.version));
    const newlyApplied: AppliedMigration[] = [];
    for (const migration of migrations) {
      if (alreadyApplied.has(String(migration.version))) {
        continue;
      }
      await client.query(migration.sql);
      await client.query(
        'INSERT INTO public.schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
        [migration.version, migration.name, migration.checksum],
      );
      newlyApplied.push({
        version: migration.version,
        name: migration.name,
        checksum: migration.checksum,
      });
    }

    await client.query('COMMIT');
    transactionStarted = false;
    return newlyApplied;
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Preserve the migration error; a broken connection may also reject rollback.
      }
    }
    throw error;
  } finally {
    client.release();
  }
}
