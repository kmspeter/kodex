import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadMigrations,
  requireProductDatabaseFromEnv,
} from '@kodex/product-db';
import dotenv from 'dotenv';
import {
  createEncryptedOfflineBackup,
  OfflineBackupEnvelopeError,
  restoreEncryptedOfflineBackup,
  verifyEncryptedOfflineBackup,
} from './lib/offline-backup-envelope.mjs';
import {
  assertRestrictedDirectory,
  normalizeBackupPassphrase,
  readRestrictedSecretFile,
  readSecretPipe,
} from './lib/secret-input.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..');
const packagedRuntime = path.basename(scriptDirectory).toLowerCase() === 'operations';
const protectedRuntimeRoot = packagedRuntime ? path.resolve(repositoryRoot, '..', '..') : repositoryRoot;
const USAGE = 'Usage: kodex-backup <create|restore|verify> with strict encrypted-backup options';
const EXIT_CODES = {
  backup_operation_failed: 1,
  backup_usage_invalid: 2,
  backup_secret_rejected: 3,
  backup_authenticity_rejected: 4,
  backup_integrity_rejected: 5,
  backup_provenance_rejected: 6,
  backup_target_rejected: 7,
};

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

function parseFlags(values, booleanFlags = []) {
  const flags = new Map();
  for (let index = 0; index < values.length; index += 1) {
    const flag = values[index];
    if (!/^--[a-z-]+$/u.test(flag) || flags.has(flag)) throw new OfflineBackupEnvelopeError('backup_usage_invalid', USAGE);
    if (booleanFlags.includes(flag)) {
      flags.set(flag, true);
      continue;
    }
    const value = values[index + 1];
    if (typeof value !== 'string' || !value || value.startsWith('--')) {
      throw new OfflineBackupEnvelopeError('backup_usage_invalid', USAGE);
    }
    flags.set(flag, value);
    index += 1;
  }
  return flags;
}

function exactFlags(flags, required, optional = []) {
  const allowed = new Set([...required, ...optional]);
  return required.every((flag) => flags.has(flag))
    && [...flags.keys()].every((flag) => allowed.has(flag));
}

function secretSource(flags, prefix) {
  const fileFlag = `--${prefix}-file`;
  const stdinFlag = `--${prefix}-stdin`;
  if (flags.has(fileFlag) === flags.has(stdinFlag)) {
    throw new OfflineBackupEnvelopeError('backup_usage_invalid', USAGE);
  }
  return flags.has(fileFlag)
    ? { filename: path.resolve(flags.get(fileFlag)), stdin: false }
    : { stdin: true };
}

function parseArguments(values) {
  const [command, ...rest] = values;
  if (command === 'create') {
    const flags = parseFlags(rest, ['--passphrase-stdin', '--signing-key-stdin']);
    if (!exactFlags(
      flags,
      ['--path', '--key-id'],
      ['--database-container', '--passphrase-file', '--passphrase-stdin', '--signing-key-file', '--signing-key-stdin'],
    )) throw new OfflineBackupEnvelopeError('backup_usage_invalid', USAGE);
    const passphrase = secretSource(flags, 'passphrase');
    const signingKey = secretSource(flags, 'signing-key');
    if (passphrase.stdin && signingKey.stdin) throw new OfflineBackupEnvelopeError('backup_usage_invalid', USAGE);
    return {
      command,
      container: flags.get('--database-container'),
      keyId: flags.get('--key-id'),
      passphrase,
      signingKey,
      targetPath: path.resolve(flags.get('--path')),
    };
  }
  if (command === 'verify' || command === 'restore') {
    const flags = parseFlags(rest, ['--passphrase-stdin']);
    const optional = ['--passphrase-file', '--passphrase-stdin', '--work-directory'];
    if (command === 'restore') optional.push('--database-container');
    if (!exactFlags(flags, ['--path', '--trust-store'], optional)) {
      throw new OfflineBackupEnvelopeError('backup_usage_invalid', USAGE);
    }
    return {
      command,
      container: flags.get('--database-container'),
      passphrase: secretSource(flags, 'passphrase'),
      targetPath: path.resolve(flags.get('--path')),
      trustStorePath: path.resolve(flags.get('--trust-store')),
      workDirectory: flags.has('--work-directory')
        ? path.resolve(flags.get('--work-directory'))
        : path.dirname(path.resolve(flags.get('--path'))),
    };
  }
  throw new OfflineBackupEnvelopeError('backup_usage_invalid', USAGE);
}

function gitOutput(args) {
  const result = spawnSync('git', args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
  });
  if (result.status !== 0) throw new OfflineBackupEnvelopeError('backup_provenance_rejected', 'Git provenance is unavailable.');
  return result.stdout.trim();
}

async function operationalProvenance() {
  try {
    const application = JSON.parse(await readFile(path.join(repositoryRoot, 'package.json'), 'utf8'));
    let commit;
    if (packagedRuntime) {
      const release = JSON.parse(await readFile(path.join(repositoryRoot, 'metadata', 'release.json'), 'utf8'));
      if (release.version !== application.version) {
        throw new OfflineBackupEnvelopeError('backup_provenance_rejected', 'Packaged release identity is invalid.');
      }
      commit = release.commit;
    } else {
      if (gitOutput(['status', '--porcelain', '--untracked-files=no'])) {
        throw new OfflineBackupEnvelopeError('backup_provenance_rejected', 'Source backup operations require a clean tracked worktree.');
      }
      commit = gitOutput(['rev-parse', 'HEAD']);
    }
    const configuredCommit = process.env.KODEX_RELEASE_COMMIT?.trim();
    if (configuredCommit && configuredCommit !== commit) {
      throw new OfflineBackupEnvelopeError('backup_provenance_rejected', 'Configured release commit does not match the runtime.');
    }
    const migrations = await loadMigrations();
    const metadataRoot = packagedRuntime ? path.join(repositoryRoot, 'metadata') : repositoryRoot;
    const vendorManifest = await readFile(path.join(metadataRoot, 'VENDOR_SOURCE_SHA256.json'));
    return {
      application: { version: application.version, commit },
      codex: {
        upstreamCommit: (await readFile(path.join(metadataRoot, 'CODEX_UPSTREAM_COMMIT'), 'utf8')).trim(),
        vendorManifestSha256: createHash('sha256').update(vendorManifest).digest('hex'),
      },
      database: {
        migrations: migrations.map((migration) => ({
          version: migration.version,
          name: migration.name,
          checksum: migration.checksum,
        })),
      },
    };
  } catch (error) {
    if (error instanceof OfflineBackupEnvelopeError) throw error;
    throw new OfflineBackupEnvelopeError('backup_provenance_rejected', 'Runtime provenance is unavailable.', { cause: error });
  }
}

async function readSecret(source, options) {
  try {
    return source.stdin
      ? await readSecretPipe(process.stdin, options)
      : await readRestrictedSecretFile(source.filename, options);
  } catch (error) {
    throw new OfflineBackupEnvelopeError('backup_secret_rejected', `${options.name} input was rejected.`, { cause: error });
  }
}

async function readPassphrase(source, forbiddenRoots) {
  const raw = await readSecret(source, {
    forbiddenRoots,
    maximumBytes: 4_098,
    minimumBytes: 1,
    name: 'Backup passphrase',
  });
  try {
    try {
      return normalizeBackupPassphrase(raw);
    } catch (error) {
      throw new OfflineBackupEnvelopeError('backup_secret_rejected', 'Backup passphrase input was rejected.', { cause: error });
    }
  } finally {
    raw.fill(0);
  }
}

async function databaseOptions(container) {
  const dataRootValue = process.env.KODEX_DATA_ROOT?.trim()
    || (packagedRuntime && process.env.APPDATA ? path.join(process.env.APPDATA, 'Kodex', 'data') : '');
  if (!dataRootValue) throw new OfflineBackupEnvelopeError('backup_usage_invalid', 'KODEX_DATA_ROOT is required.');
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new OfflineBackupEnvelopeError('backup_usage_invalid', 'DATABASE_URL is required.');
  const database = requireProductDatabaseFromEnv();
  return {
    common: {
      caCertificate: process.env.PRODUCT_DB_CA_CERT,
      database,
      databaseContainer: container,
      databaseUrl,
      dataRoot: path.resolve(dataRootValue),
      pgDumpBinary: process.env.KODEX_PG_DUMP_BIN,
      pgRestoreBinary: process.env.KODEX_PG_RESTORE_BIN,
      sslMode: process.env.PRODUCT_DB_SSL,
    },
    database,
  };
}

async function main() {
  if (process.versions.electron) process.noAsar = true;
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed.command !== 'verify') await loadEnvironmentFile();
  const provenance = await operationalProvenance();
  const workDirectory = await assertRestrictedDirectory(
    parsed.workDirectory ?? path.dirname(parsed.targetPath),
    parsed.command === 'create' ? 'Backup artifact directory' : 'Backup work directory',
  ).catch((error) => {
    throw new OfflineBackupEnvelopeError('backup_target_rejected', 'Backup artifact directory was rejected.', { cause: error });
  });
  const secretForbiddenRoots = [protectedRuntimeRoot, parsed.targetPath];
  const passphrase = await readPassphrase(parsed.passphrase, secretForbiddenRoots);
  let privateKey;
  let database;
  try {
    if (parsed.command === 'verify') {
      const verified = await verifyEncryptedOfflineBackup({
        expectedProvenance: provenance,
        input: parsed.targetPath,
        passphrase,
        trustStorePath: parsed.trustStorePath,
        workDirectory,
      });
      process.stdout.write(`${JSON.stringify({
        kind: 'kodex_backup_verified',
        databaseBytes: verified.manifest.database.sizeBytes,
        fileCount: verified.manifest.tenantData.fileCount,
        formatVersion: verified.header.formatVersion,
        keyId: verified.keyId,
        trustStoreVersion: verified.trustStoreVersion,
      })}\n`);
      return;
    }
    const configured = await databaseOptions(parsed.container);
    database = configured.database;
    if (parsed.command === 'create') {
      privateKey = await readSecret(parsed.signingKey, {
        forbiddenRoots: secretForbiddenRoots,
        maximumBytes: 64 * 1024,
        minimumBytes: 1,
        name: 'Backup signing key',
      });
      const created = await createEncryptedOfflineBackup({
        ...configured.common,
        applicationVersion: provenance.application.version,
        commit: provenance.application.commit,
        keyId: parsed.keyId,
        output: parsed.targetPath,
        passphrase,
        privateKeyBytes: privateKey,
        provenance,
      });
      process.stdout.write(`${JSON.stringify({
        kind: 'kodex_backup_created',
        databaseBytes: created.manifest.database.sizeBytes,
        durationMs: created.durationMs,
        fileCount: created.manifest.tenantData.fileCount,
        formatVersion: created.header.formatVersion,
        keyId: parsed.keyId,
      })}\n`);
      return;
    }
    const restored = await restoreEncryptedOfflineBackup({
      ...configured.common,
      expectedProvenance: provenance,
      input: parsed.targetPath,
      passphrase,
      trustStorePath: parsed.trustStorePath,
      workDirectory,
    });
    process.stdout.write(`${JSON.stringify({
      kind: 'kodex_backup_restored',
      databaseBytes: restored.manifest.database.sizeBytes,
      durationMs: restored.durationMs,
      fileCount: restored.manifest.tenantData.fileCount,
      formatVersion: restored.header.formatVersion,
      keyId: restored.keyId,
      trustStoreVersion: restored.trustStoreVersion,
    })}\n`);
  } finally {
    passphrase.fill(0);
    privateKey?.fill(0);
    await database?.close();
  }
}

try {
  await main();
} catch (error) {
  const code = error instanceof OfflineBackupEnvelopeError && EXIT_CODES[error.code]
    ? error.code
    : 'backup_operation_failed';
  process.stderr.write(`${JSON.stringify({ kind: 'kodex_backup_failed', code })}\n`);
  process.exitCode = EXIT_CODES[code];
}
