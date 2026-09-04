import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const OFFLINE_BACKUP_FORMAT_VERSION = 1;
export const OFFLINE_MAINTENANCE_LOCK = '.kodex-offline-maintenance.lock';

const DATABASE_DUMP_FILENAME = 'database.dump';
const MANIFEST_FILENAME = 'manifest.json';
const TENANT_DIRECTORY = 'tenant-data';
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_MANIFEST_FILES = 200_000;
const CONTAINER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;
const COMMIT_HASH = /^[a-f0-9]{40}$/u;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, keys) {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index]);
}

function normalizedRoot(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required.`);
  const root = path.resolve(value);
  if (root === path.parse(root).root) throw new Error(`${name} cannot be a filesystem root.`);
  return root;
}

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function safeRelativePath(value) {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > 1_024
    || value.includes('\\')
    || value.includes('\0')
    || path.posix.isAbsolute(value)
  ) return false;
  const normalized = path.posix.normalize(value);
  return normalized === value && normalized !== '..' && !normalized.startsWith('../');
}

function databaseTarget(databaseUrl) {
  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error('DATABASE_URL must be a valid PostgreSQL URL.');
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error('DATABASE_URL must use the PostgreSQL protocol.');
  }
  const username = decodeURIComponent(parsed.username);
  const password = decodeURIComponent(parsed.password);
  const database = decodeURIComponent(parsed.pathname.replace(/^\//u, ''));
  if (!parsed.hostname || !username || !database || database.includes('/')) {
    throw new Error('DATABASE_URL must include one host, user, and database name.');
  }
  return {
    database,
    host: parsed.hostname,
    password,
    port: parsed.port || '5432',
    username,
  };
}

async function sha256File(filename) {
  const handle = await open(filename, 'r');
  const digest = createHash('sha256');
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      digest.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return digest.digest('hex');
}

async function writePrivateFile(filename, content) {
  const handle = await open(filename, 'wx', 0o600);
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function acquireMaintenanceLock(dataRoot, createRoot) {
  if (createRoot) await mkdir(dataRoot, { recursive: false, mode: 0o700 });
  else {
    const metadata = await lstat(dataRoot);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('KODEX_DATA_ROOT must be a real directory.');
  }
  const lockPath = path.join(dataRoot, OFFLINE_MAINTENANCE_LOCK);
  const lockId = randomUUID();
  await writePrivateFile(lockPath, `${JSON.stringify({ lockId, pid: process.pid, startedAt: new Date().toISOString() })}\n`);
  return async () => {
    try {
      const current = JSON.parse(await readFile(lockPath, 'utf8'));
      if (current.lockId === lockId) await unlink(lockPath);
    } catch { /* Preserve a lock replaced by another process. */ }
  };
}

async function assertNoRuntimeLocks(root, relative = '') {
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const child = path.join(relative, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Tenant data contains a symbolic link; offline backup refused.');
    if (entry.isDirectory()) await assertNoRuntimeLocks(root, child);
    else if (entry.name === 'instance.lock' || entry.name.startsWith('.kodex-runtime-start.')) {
      throw new Error('A tenant runtime instance lock exists; stop every Local Server before backup or restore.');
    }
  }
}

async function copyTenantTree(sourceRoot, targetRoot, relative = '', files = []) {
  const entries = await readdir(path.join(sourceRoot, relative), { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
    if (!relative && entry.name === OFFLINE_MAINTENANCE_LOCK) continue;
    const sourceRelative = path.join(relative, entry.name);
    const portableRelative = sourceRelative.split(path.sep).join('/');
    const source = path.join(sourceRoot, sourceRelative);
    const target = path.join(targetRoot, sourceRelative);
    const metadata = await lstat(source);
    if (metadata.isSymbolicLink()) throw new Error('Tenant data contains a symbolic link; offline backup refused.');
    if (metadata.isDirectory()) {
      await mkdir(target, { recursive: false, mode: 0o700 });
      await copyTenantTree(sourceRoot, targetRoot, sourceRelative, files);
      continue;
    }
    if (!metadata.isFile()) throw new Error('Tenant data contains an unsupported filesystem entry.');
    if (files.length >= MAX_MANIFEST_FILES) throw new Error('Tenant backup file limit exceeded.');
    await copyFile(source, target, 1);
    const copied = await stat(target);
    files.push({ path: portableRelative, sha256: await sha256File(target), sizeBytes: copied.size });
  }
  return files;
}

async function inspectTenantTree(root, relative = '', files = []) {
  for (const entry of (await readdir(path.join(root, relative), { withFileTypes: true }))
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
    const child = path.join(relative, entry.name);
    const portable = child.split(path.sep).join('/');
    const absolute = path.join(root, child);
    const metadata = await lstat(absolute);
    if (metadata.isSymbolicLink()) throw new Error('Backup tenant data contains a symbolic link.');
    if (metadata.isDirectory()) {
      await inspectTenantTree(root, child, files);
      continue;
    }
    if (!metadata.isFile()) throw new Error('Backup tenant data contains an unsupported filesystem entry.');
    if (files.length >= MAX_MANIFEST_FILES) throw new Error('Backup tenant file limit exceeded.');
    files.push({ path: portable, sha256: await sha256File(absolute), sizeBytes: metadata.size });
  }
  return files;
}

async function schemaMigrations(database) {
  const exists = await database.query("SELECT to_regclass('public.schema_migrations')::text AS name");
  if (!exists.rows[0]?.name) throw new Error('Product database migrations have not been applied.');
  const result = await database.query(
    'SELECT version::text, name, checksum FROM public.schema_migrations ORDER BY schema_migrations.version',
  );
  if (result.rows.length === 0) throw new Error('Product database migration ledger is empty.');
  return result.rows.map((row) => ({
    checksum: String(row.checksum),
    name: String(row.name),
    version: Number(row.version),
  }));
}

async function assertEmptyDatabase(database) {
  const result = await database.query(
    `SELECT count(*)::text AS count
     FROM pg_class AS relation
     JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
     WHERE namespace.nspname = 'public' AND relation.relkind IN ('r', 'p')`,
  );
  if (Number(result.rows[0]?.count ?? 0) !== 0) {
    throw new Error('Restore requires an empty target PostgreSQL database.');
  }
}

async function withPostgresEnvironment(options, operation) {
  const target = databaseTarget(options.databaseUrl);
  const inherited = Object.fromEntries([
    'ComSpec', 'PATH', 'PATHEXT', 'SystemDrive', 'SystemRoot', 'TEMP', 'TMP', 'WINDIR',
  ].flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
  const env = { ...inherited, PGPASSWORD: target.password };
  const sslMode = options.sslMode ?? 'disable';
  if (!['disable', 'require', 'verify-full'].includes(sslMode)) throw new Error('Invalid PostgreSQL SSL mode.');
  env.PGSSLMODE = sslMode;
  let certificatePath;
  try {
    if (sslMode === 'verify-full') {
      if (typeof options.caCertificate === 'string' && options.caCertificate.trim()) {
        const certificate = options.caCertificate.replaceAll('\\n', '\n').trim();
        if (
          Buffer.byteLength(certificate, 'utf8') > 256 * 1024
          || !certificate.startsWith('-----BEGIN CERTIFICATE-----')
          || !certificate.endsWith('-----END CERTIFICATE-----')
          || certificate.includes('\0')
        ) throw new Error('PRODUCT_DB_CA_CERT must contain a bounded PEM certificate chain.');
        certificatePath = path.join(os.tmpdir(), `kodex-postgres-ca-${randomUUID()}.pem`);
        await writePrivateFile(certificatePath, `${certificate}\n`);
        env.PGSSLROOTCERT = certificatePath;
      }
    }
    return await operation(target, env);
  } finally {
    if (certificatePath) await rm(certificatePath, { force: true });
  }
}

function databaseCommand(mode, options, target) {
  if (options.databaseContainer !== undefined) {
    if (!CONTAINER_NAME.test(options.databaseContainer)) throw new Error('Invalid database container name.');
    const tool = mode === 'dump' ? 'pg_dump' : 'pg_restore';
    return {
      command: 'docker',
      args: [
        'exec', ...(mode === 'restore' ? ['-i'] : []), options.databaseContainer,
        tool, '-U', target.username, '-d', target.database,
        ...(mode === 'dump'
          ? ['--format=custom', '--no-owner', '--no-privileges']
          : ['--exit-on-error', '--no-owner', '--no-privileges']),
      ],
      usePassword: false,
    };
  }
  const configured = mode === 'dump' ? options.pgDumpBinary : options.pgRestoreBinary;
  const command = configured || (mode === 'dump' ? 'pg_dump' : 'pg_restore');
  if (typeof command !== 'string' || !command.trim() || /[\r\n]/u.test(command)) {
    throw new Error('Invalid PostgreSQL tool path.');
  }
  return {
    command,
    args: [
      '-h', target.host, '-p', target.port, '-U', target.username, '-d', target.database,
      ...(mode === 'dump'
        ? ['--format=custom', '--no-owner', '--no-privileges']
        : ['--exit-on-error', '--no-owner', '--no-privileges']),
    ],
    usePassword: true,
  };
}

async function runDatabaseTool(mode, filename, options) {
  await withPostgresEnvironment(options, async (target, postgresEnv) => {
    const spec = databaseCommand(mode, options, target);
    const file = await open(filename, mode === 'dump' ? 'wx' : 'r', 0o600);
    try {
      await new Promise((resolve, reject) => {
        const child = spawn(spec.command, spec.args, {
          env: spec.usePassword
            ? postgresEnv
            : Object.fromEntries(Object.entries(postgresEnv).filter(([key]) => !key.startsWith('PG'))),
          shell: false,
          windowsHide: true,
          stdio: mode === 'dump' ? ['ignore', file.fd, 'pipe'] : [file.fd, 'ignore', 'pipe'],
        });
        let stderrBytes = 0;
        child.stderr.on('data', (chunk) => { stderrBytes += chunk.length; });
        child.once('error', () => reject(new Error(`PostgreSQL ${mode} tool could not be started.`)));
        child.once('exit', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`PostgreSQL ${mode} failed (exit ${code ?? 'unknown'}, diagnosticBytes ${stderrBytes}).`));
        });
      });
    } finally {
      await file.close();
    }
  });
}

function parseManifest(value) {
  if (!isRecord(value) || !exactKeys(value, ['application', 'createdAt', 'database', 'formatVersion', 'tenantData'])) {
    throw new Error('Backup manifest has an invalid top-level contract.');
  }
  if (value.formatVersion !== OFFLINE_BACKUP_FORMAT_VERSION || !Number.isFinite(new Date(value.createdAt).getTime())) {
    throw new Error('Backup manifest version or timestamp is invalid.');
  }
  if (!isRecord(value.application) || !exactKeys(value.application, ['commit', 'version'])) {
    throw new Error('Backup application metadata is invalid.');
  }
  if (
    typeof value.application.version !== 'string'
    || value.application.version.length < 1
    || value.application.version.length > 64
    || (value.application.commit !== null && !COMMIT_HASH.test(value.application.commit))
  ) throw new Error('Backup application version is invalid.');
  if (!isRecord(value.database) || !exactKeys(value.database, ['file', 'format', 'migrations', 'sha256', 'sizeBytes'])) {
    throw new Error('Backup database metadata is invalid.');
  }
  if (
    value.database.file !== DATABASE_DUMP_FILENAME
    || value.database.format !== 'postgres-custom'
    || !/^[a-f0-9]{64}$/u.test(value.database.sha256)
    || !Number.isSafeInteger(value.database.sizeBytes)
    || value.database.sizeBytes <= 0
    || !Array.isArray(value.database.migrations)
    || value.database.migrations.length < 1
    || value.database.migrations.length > 10_000
  ) throw new Error('Backup database dump metadata is invalid.');
  let expectedVersion = 1;
  for (const migration of value.database.migrations) {
    if (!isRecord(migration) || !exactKeys(migration, ['checksum', 'name', 'version'])) {
      throw new Error(`Backup migration ledger entry ${expectedVersion} has invalid keys.`);
    }
    if (migration.version !== expectedVersion) {
      throw new Error(`Backup migration ledger expected version ${expectedVersion}.`);
    }
    if (typeof migration.name !== 'string' || migration.name.length < 1 || migration.name.length > 128) {
      throw new Error(`Backup migration ledger entry ${expectedVersion} has an invalid name.`);
    }
    if (typeof migration.checksum !== 'string' || !/^[a-f0-9]{64}$/u.test(migration.checksum)) {
      throw new Error(`Backup migration ledger entry ${expectedVersion} has an invalid checksum.`);
    }
    expectedVersion += 1;
  }
  if (!isRecord(value.tenantData) || !exactKeys(value.tenantData, ['directory', 'fileCount', 'files', 'totalBytes'])) {
    throw new Error('Backup tenant metadata is invalid.');
  }
  if (
    value.tenantData.directory !== TENANT_DIRECTORY
    || !Array.isArray(value.tenantData.files)
    || value.tenantData.files.length !== value.tenantData.fileCount
    || value.tenantData.files.length > MAX_MANIFEST_FILES
    || !Number.isSafeInteger(value.tenantData.totalBytes)
    || value.tenantData.totalBytes < 0
  ) throw new Error('Backup tenant file count is invalid.');
  const seen = new Set();
  let totalBytes = 0;
  for (const file of value.tenantData.files) {
    if (
      !isRecord(file)
      || !exactKeys(file, ['path', 'sha256', 'sizeBytes'])
      || !safeRelativePath(file.path)
      || seen.has(file.path)
      || !/^[a-f0-9]{64}$/u.test(file.sha256)
      || !Number.isSafeInteger(file.sizeBytes)
      || file.sizeBytes < 0
    ) throw new Error('Backup tenant file metadata is invalid.');
    seen.add(file.path);
    totalBytes += file.sizeBytes;
  }
  if (!Number.isSafeInteger(totalBytes) || totalBytes !== value.tenantData.totalBytes) {
    throw new Error('Backup tenant byte total is invalid.');
  }
  return value;
}

export async function verifyOfflineBackup(backupDirectory) {
  const root = normalizedRoot(backupDirectory, 'Backup directory');
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Backup path must be a real directory.');
  const manifestPath = path.join(root, MANIFEST_FILENAME);
  const manifestStat = await lstat(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > MAX_MANIFEST_BYTES) {
    throw new Error('Backup manifest is missing, linked, or too large.');
  }
  const manifest = parseManifest(JSON.parse(await readFile(manifestPath, 'utf8')));
  const dumpPath = path.join(root, manifest.database.file);
  const dumpStat = await lstat(dumpPath);
  if (!dumpStat.isFile() || dumpStat.isSymbolicLink() || dumpStat.size !== manifest.database.sizeBytes || await sha256File(dumpPath) !== manifest.database.sha256) {
    throw new Error('Backup database dump checksum verification failed.');
  }
  const tenantRoot = path.resolve(root, manifest.tenantData.directory);
  const tenantRootStat = await lstat(tenantRoot);
  if (!tenantRootStat.isDirectory() || tenantRootStat.isSymbolicLink()) {
    throw new Error('Backup tenant path must be a real directory.');
  }
  const actualFiles = await inspectTenantTree(tenantRoot);
  if (actualFiles.length !== manifest.tenantData.files.length) {
    throw new Error('Backup tenant tree contains unlisted or missing files.');
  }
  for (let index = 0; index < actualFiles.length; index += 1) {
    const actual = actualFiles[index];
    const expected = manifest.tenantData.files[index];
    if (
      actual.path !== expected.path
      || actual.sizeBytes !== expected.sizeBytes
      || actual.sha256 !== expected.sha256
    ) throw new Error('Backup tenant file checksum verification failed.');
  }
  return manifest;
}

export async function createOfflineBackup(options) {
  const startedAt = Date.now();
  const dataRoot = normalizedRoot(options.dataRoot, 'KODEX_DATA_ROOT');
  const output = normalizedRoot(options.output, 'Backup output');
  if (isWithin(dataRoot, output) || isWithin(output, dataRoot)) {
    throw new Error('Backup output and KODEX_DATA_ROOT must not contain each other.');
  }
  try {
    await stat(output);
    throw new Error('Backup output already exists.');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const partial = `${output}.partial-${randomUUID()}`;
  await mkdir(partial, { recursive: false, mode: 0o700 });
  let releaseLock;
  try {
    releaseLock = await acquireMaintenanceLock(dataRoot, false);
    await assertNoRuntimeLocks(dataRoot);
    const migrations = await schemaMigrations(options.database);
    const dumpPath = path.join(partial, DATABASE_DUMP_FILENAME);
    await runDatabaseTool('dump', dumpPath, options);
    const dumpStat = await stat(dumpPath);
    if (!dumpStat.isFile() || dumpStat.size <= 0) throw new Error('PostgreSQL dump is empty.');
    const tenantTarget = path.join(partial, TENANT_DIRECTORY);
    await mkdir(tenantTarget, { mode: 0o700 });
    const files = await copyTenantTree(dataRoot, tenantTarget);
    const totalBytes = files.reduce((total, file) => total + file.sizeBytes, 0);
    const commit = options.commit ?? null;
    if (commit !== null && !COMMIT_HASH.test(commit)) throw new Error('Backup commit must be a 40-character lowercase Git hash.');
    const manifest = {
      formatVersion: OFFLINE_BACKUP_FORMAT_VERSION,
      createdAt: new Date().toISOString(),
      application: { version: options.applicationVersion, commit },
      database: {
        file: DATABASE_DUMP_FILENAME,
        format: 'postgres-custom',
        migrations,
        sha256: await sha256File(dumpPath),
        sizeBytes: dumpStat.size,
      },
      tenantData: {
        directory: TENANT_DIRECTORY,
        fileCount: files.length,
        files,
        totalBytes,
      },
    };
    parseManifest(manifest);
    await writePrivateFile(path.join(partial, MANIFEST_FILENAME), `${JSON.stringify(manifest, null, 2)}\n`);
    await verifyOfflineBackup(partial);
    await rename(partial, output);
    return { durationMs: Date.now() - startedAt, manifest };
  } catch (error) {
    await rm(partial, { recursive: true, force: true });
    throw error;
  } finally {
    await releaseLock?.();
  }
}

export async function restoreOfflineBackup(options) {
  const startedAt = Date.now();
  const dataRoot = normalizedRoot(options.dataRoot, 'KODEX_DATA_ROOT');
  const backup = normalizedRoot(options.input, 'Backup input');
  if (isWithin(dataRoot, backup) || isWithin(backup, dataRoot)) {
    throw new Error('Backup input and KODEX_DATA_ROOT must not contain each other.');
  }
  try {
    await stat(dataRoot);
    throw new Error('Restore requires a new KODEX_DATA_ROOT path.');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const manifest = await verifyOfflineBackup(backup);
  await assertEmptyDatabase(options.database);
  let releaseLock;
  let restored = false;
  try {
    releaseLock = await acquireMaintenanceLock(dataRoot, true);
    await runDatabaseTool('restore', path.join(backup, manifest.database.file), options);
    const restoredMigrations = await schemaMigrations(options.database);
    if (JSON.stringify(restoredMigrations) !== JSON.stringify(manifest.database.migrations)) {
      throw new Error('Restored migration ledger does not match the backup manifest.');
    }
    const restoredFiles = await copyTenantTree(
      path.join(backup, manifest.tenantData.directory),
      dataRoot,
    );
    if (JSON.stringify(restoredFiles) !== JSON.stringify(manifest.tenantData.files)) {
      throw new Error('Restored tenant data does not match the backup manifest.');
    }
    const restoredManifest = await verifyOfflineBackup(backup);
    if (JSON.stringify(restoredManifest.tenantData) !== JSON.stringify(manifest.tenantData)) {
      throw new Error('Backup changed while restore was running.');
    }
    restored = true;
    return { durationMs: Date.now() - startedAt, manifest };
  } finally {
    await releaseLock?.();
    if (!restored) await rm(dataRoot, { recursive: true, force: true });
  }
}
