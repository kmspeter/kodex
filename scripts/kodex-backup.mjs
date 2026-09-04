import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireProductDatabaseFromEnv } from '@kodex/product-db';
import dotenv from 'dotenv';
import {
  createOfflineBackup,
  restoreOfflineBackup,
  verifyOfflineBackup,
} from './lib/offline-backup.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..');
const packagedRuntime = path.basename(scriptDirectory).toLowerCase() === 'operations';

async function loadEnvironmentFile() {
  if (process.env.KODEX_DISABLE_ENV_FILE === '1') return;
  const configured = process.env.KODEX_ENV_FILE?.trim();
  const defaultPath = packagedRuntime && process.env.APPDATA
    ? path.join(process.env.APPDATA, 'Kodex', 'kodex.env')
    : path.join(repositoryRoot, '.env.local');
  const filename = configured ? path.resolve(configured) : defaultPath;
  try {
    const parsed = dotenv.parse(await readFile(filename, 'utf8'));
    for (const [key, value] of Object.entries(parsed)) {
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch (error) {
    if (error?.code !== 'ENOENT' || configured) throw error;
  }
}

function parseArguments(values) {
  const [command, ...rest] = values;
  if (!['create', 'restore', 'verify'].includes(command)) {
    throw new Error('Usage: kodex-backup <create|restore|verify> --path <directory> [--database-container <name>]');
  }
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!['--path', '--database-container'].includes(key) || typeof value !== 'string' || !value) {
      throw new Error('Backup arguments must be exact key/value pairs.');
    }
    if (options[key]) throw new Error(`Duplicate backup argument: ${key}`);
    options[key] = value;
  }
  if (!options['--path']) throw new Error('--path is required.');
  return { command, container: options['--database-container'], targetPath: path.resolve(options['--path']) };
}

await loadEnvironmentFile();
const parsed = parseArguments(process.argv.slice(2));

if (parsed.command === 'verify') {
  const manifest = await verifyOfflineBackup(parsed.targetPath);
  process.stdout.write(`${JSON.stringify({
    kind: 'kodex_backup_verified',
    databaseBytes: manifest.database.sizeBytes,
    fileCount: manifest.tenantData.fileCount,
    formatVersion: manifest.formatVersion,
  })}\n`);
} else {
  const dataRootValue = process.env.KODEX_DATA_ROOT?.trim()
    || (packagedRuntime && process.env.APPDATA ? path.join(process.env.APPDATA, 'Kodex', 'data') : '');
  if (!dataRootValue) throw new Error('KODEX_DATA_ROOT is required for backup create or restore.');
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error('DATABASE_URL is required for backup create or restore.');
  const database = requireProductDatabaseFromEnv();
  try {
    const common = {
      caCertificate: process.env.PRODUCT_DB_CA_CERT,
      database,
      databaseContainer: parsed.container,
      databaseUrl,
      dataRoot: path.resolve(dataRootValue),
      pgDumpBinary: process.env.KODEX_PG_DUMP_BIN,
      pgRestoreBinary: process.env.KODEX_PG_RESTORE_BIN,
      sslMode: process.env.PRODUCT_DB_SSL,
    };
    const result = parsed.command === 'create'
      ? await createOfflineBackup({
        ...common,
        applicationVersion: JSON.parse(await readFile(path.join(repositoryRoot, 'package.json'), 'utf8')).version,
        commit: process.env.KODEX_RELEASE_COMMIT?.trim() || null,
        output: parsed.targetPath,
      })
      : await restoreOfflineBackup({ ...common, input: parsed.targetPath });
    process.stdout.write(`${JSON.stringify({
      kind: parsed.command === 'create' ? 'kodex_backup_created' : 'kodex_backup_restored',
      databaseBytes: result.manifest.database.sizeBytes,
      durationMs: result.durationMs,
      fileCount: result.manifest.tenantData.fileCount,
      formatVersion: result.manifest.formatVersion,
    })}\n`);
  } finally {
    await database.close();
  }
}
