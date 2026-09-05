import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, rename, rm, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

export const RELEASE_ARTIFACT_FORMAT_VERSION = 1;
export const RELEASE_MANIFEST_FILENAME = 'release-manifest.json';
export const RELEASE_SIGNATURE_FILENAME = 'release-signature.json';

const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_FILES = 50_000;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, expected) {
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return keys.length === wanted.length && keys.every((key, index) => key === wanted[index]);
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

async function writePrivateFile(filename, value) {
  const handle = await open(filename, 'wx', 0o600);
  try {
    await handle.writeFile(value, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function forbiddenArtifactPath(relative) {
  const normalized = `/${relative.toLowerCase()}`;
  return /\/(?:\.env(?:\.|$)|kodex\.env$|instance\.lock$)/u.test(normalized)
    || /\/(?:release-trust-store\.json)$/u.test(normalized)
    || normalized.includes('/.kodex-data/')
    || normalized.includes('/tenants/users/')
    || normalized.includes('/product-history-outbox/');
}

async function inspectFiles(root, relative = '', files = []) {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
    const child = path.join(relative, entry.name);
    const portable = child.split(path.sep).join('/');
    if (
      !relative
      && (entry.name === RELEASE_MANIFEST_FILENAME || entry.name === RELEASE_SIGNATURE_FILENAME)
    ) continue;
    const absolute = path.join(root, child);
    const metadata = await lstat(absolute);
    if (metadata.isSymbolicLink()) throw new Error('Release artifact contains a symbolic link.');
    if (metadata.isDirectory()) {
      await inspectFiles(root, child, files);
      continue;
    }
    if (!metadata.isFile()) throw new Error('Release artifact contains an unsupported filesystem entry.');
    if (files.length >= MAX_FILES) throw new Error('Release artifact file limit exceeded.');
    if (forbiddenArtifactPath(portable)) {
      throw new Error('Release artifact contains forbidden local configuration, trust metadata, or tenant data.');
    }
    files.push({ path: portable, sha256: await sha256File(absolute), sizeBytes: metadata.size });
  }
  if (!relative) files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return files;
}

function parseMigrations(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 10_000) {
    throw new Error('Release migration ledger is invalid.');
  }
  let expectedVersion = 1;
  return value.map((migration) => {
    if (
      !isRecord(migration)
      || !exactKeys(migration, ['checksum', 'name', 'version'])
      || migration.version !== expectedVersion
      || typeof migration.name !== 'string'
      || migration.name.length < 1
      || migration.name.length > 128
      || typeof migration.checksum !== 'string'
      || !SHA256.test(migration.checksum)
    ) throw new Error(`Release migration ledger entry ${expectedVersion} is invalid.`);
    expectedVersion += 1;
    return migration;
  });
}

function parseManifest(value) {
  if (!isRecord(value) || !exactKeys(value, ['codex', 'createdAt', 'database', 'files', 'formatVersion', 'release'])) {
    throw new Error('Release manifest has an invalid top-level contract.');
  }
  if (
    value.formatVersion !== RELEASE_ARTIFACT_FORMAT_VERSION
    || typeof value.createdAt !== 'string'
    || value.createdAt.length > 64
    || !Number.isFinite(new Date(value.createdAt).getTime())
    || new Date(value.createdAt).toISOString() !== value.createdAt
  ) {
    throw new Error('Release manifest version or timestamp is invalid.');
  }
  if (
    !isRecord(value.release)
    || !exactKeys(value.release, ['arch', 'commit', 'platform', 'version'])
    || !VERSION.test(value.release.version)
    || !COMMIT.test(value.release.commit)
    || value.release.platform !== 'win32'
    || value.release.arch !== 'x64'
  ) throw new Error('Release identity is invalid.');
  if (
    !isRecord(value.codex)
    || !exactKeys(value.codex, ['upstreamCommit', 'vendorManifestSha256'])
    || !COMMIT.test(value.codex.upstreamCommit)
    || !SHA256.test(value.codex.vendorManifestSha256)
  ) throw new Error('Release Codex provenance is invalid.');
  if (!isRecord(value.database) || !exactKeys(value.database, ['migrations'])) {
    throw new Error('Release database metadata is invalid.');
  }
  parseMigrations(value.database.migrations);
  if (!Array.isArray(value.files) || value.files.length < 1 || value.files.length > MAX_FILES) {
    throw new Error('Release file manifest is invalid.');
  }
  const seen = new Set();
  let previous = '';
  for (const file of value.files) {
    if (
      !isRecord(file)
      || !exactKeys(file, ['path', 'sha256', 'sizeBytes'])
      || !safeRelativePath(file.path)
      || file.path <= previous
      || seen.has(file.path)
      || forbiddenArtifactPath(file.path)
      || !SHA256.test(file.sha256)
      || !Number.isSafeInteger(file.sizeBytes)
      || file.sizeBytes < 0
    ) throw new Error('Release file metadata is invalid.');
    seen.add(file.path);
    previous = file.path;
  }
  return value;
}

function canonicalManifestBytes(value) {
  return Buffer.from(`${JSON.stringify({
    formatVersion: value.formatVersion,
    createdAt: value.createdAt,
    release: {
      version: value.release.version,
      commit: value.release.commit,
      platform: value.release.platform,
      arch: value.release.arch,
    },
    database: {
      migrations: value.database.migrations.map((migration) => ({
        version: migration.version,
        name: migration.name,
        checksum: migration.checksum,
      })),
    },
    codex: {
      upstreamCommit: value.codex.upstreamCommit,
      vendorManifestSha256: value.codex.vendorManifestSha256,
    },
    files: value.files.map((file) => ({
      path: file.path,
      sha256: file.sha256,
      sizeBytes: file.sizeBytes,
    })),
  }, null, 2)}\n`, 'utf8');
}

async function readCanonicalManifest(root) {
  const manifestPath = path.join(root, RELEASE_MANIFEST_FILENAME);
  const manifestStat = await lstat(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > MAX_MANIFEST_BYTES) {
    throw new Error('Release manifest is missing, linked, or too large.');
  }
  const bytes = await readFile(manifestPath);
  let text;
  let manifest;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    manifest = parseManifest(JSON.parse(text));
  } catch {
    throw new Error('Release manifest is not valid canonical JSON.');
  }
  if (!bytes.equals(canonicalManifestBytes(manifest))) {
    throw new Error('Release manifest is not valid canonical JSON.');
  }
  return { bytes, manifest };
}

export async function readCanonicalReleaseManifest(directory) {
  const root = normalizedRoot(directory, 'Release directory');
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Release path must be a real directory.');
  return readCanonicalManifest(root);
}

export async function verifyReleaseArtifactIntegrity(directory) {
  const root = normalizedRoot(directory, 'Release directory');
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Release path must be a real directory.');
  const { manifest } = await readCanonicalManifest(root);
  const actual = await inspectFiles(root);
  if (actual.length !== manifest.files.length) throw new Error('Release artifact contains unlisted or missing files.');
  for (let index = 0; index < actual.length; index += 1) {
    const file = actual[index];
    const expected = manifest.files[index];
    if (file.path !== expected.path || file.sizeBytes !== expected.sizeBytes || file.sha256 !== expected.sha256) {
      throw new Error('Release artifact checksum verification failed.');
    }
  }
  const identity = JSON.parse(await readFile(path.join(root, 'resources', 'app', 'metadata', 'release.json'), 'utf8'));
  if (
    !isRecord(identity)
    || !exactKeys(identity, ['commit', 'version'])
    || identity.version !== manifest.release.version
    || identity.commit !== manifest.release.commit
  ) throw new Error('Packaged release identity does not match the release manifest.');
  return manifest;
}

export async function createReleaseArtifact(options) {
  const runtimeRoot = normalizedRoot(options.runtimeRoot, 'Runtime directory');
  const output = normalizedRoot(options.output, 'Release output');
  if (isWithin(runtimeRoot, output) || isWithin(output, runtimeRoot)) {
    throw new Error('Runtime directory and release output must not contain each other.');
  }
  const runtimeStat = await lstat(runtimeRoot);
  if (!runtimeStat.isDirectory() || runtimeStat.isSymbolicLink()) throw new Error('Runtime path must be a real directory.');
  try {
    await stat(output);
    throw new Error('Release output already exists.');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (!VERSION.test(options.version) || !COMMIT.test(options.commit)) throw new Error('Release version or commit is invalid.');
  const releaseId = `Kodex-${options.version}-windows-x64-${options.commit.slice(0, 12)}`;
  if (path.basename(output) !== releaseId) {
    throw new Error(`Release output directory must be named ${releaseId}.`);
  }
  if (!COMMIT.test(options.codexUpstreamCommit) || !SHA256.test(options.vendorManifestSha256)) {
    throw new Error('Release Codex provenance is invalid.');
  }
  const migrations = parseMigrations(options.migrations);
  const metadataRoot = path.join(runtimeRoot, 'resources', 'app', 'metadata');
  await mkdir(metadataRoot, { recursive: true, mode: 0o700 });
  const identityPath = path.join(metadataRoot, 'release.json');
  const manifestPath = path.join(runtimeRoot, RELEASE_MANIFEST_FILENAME);
  const signaturePath = path.join(runtimeRoot, RELEASE_SIGNATURE_FILENAME);
  let moved = false;
  try {
    try {
      await lstat(signaturePath);
      throw new Error('Runtime directory already contains release signature metadata.');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await writePrivateFile(identityPath, `${JSON.stringify({ version: options.version, commit: options.commit }, null, 2)}\n`);
    const files = await inspectFiles(runtimeRoot);
    const manifest = {
      formatVersion: RELEASE_ARTIFACT_FORMAT_VERSION,
      createdAt: new Date().toISOString(),
      release: { version: options.version, commit: options.commit, platform: 'win32', arch: 'x64' },
      database: { migrations },
      codex: {
        upstreamCommit: options.codexUpstreamCommit,
        vendorManifestSha256: options.vendorManifestSha256,
      },
      files,
    };
    parseManifest(manifest);
    await writePrivateFile(manifestPath, canonicalManifestBytes(manifest));
    await verifyReleaseArtifactIntegrity(runtimeRoot);
    await mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
    await rename(runtimeRoot, output);
    moved = true;
    return { manifest, releaseId };
  } finally {
    if (!moved) {
      await rm(manifestPath, { force: true });
      await unlink(identityPath).catch(() => undefined);
    }
  }
}
