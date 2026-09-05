import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const defaultSourceRoot = path.join(repositoryRoot, 'vendor', 'openai-codex');
export const defaultManifestPath = path.join(repositoryRoot, 'VENDOR_SOURCE_SHA256.json');
const EXPECTED_UPSTREAM = 'https://github.com/openai/codex';
const COMMIT = /^[a-f0-9]{40}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_VENDOR_FILES = 20_000;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, expected) {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function safeRelativePath(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 1_024
    && !value.includes('\\')
    && !value.includes('\0')
    && !path.posix.isAbsolute(value)
    && path.posix.normalize(value) === value
    && value !== '..'
    && !value.startsWith('../');
}

async function readPinnedCommit() {
  const value = await readFile(path.join(repositoryRoot, 'CODEX_UPSTREAM_COMMIT'), 'utf8');
  if (!/^([a-f0-9]{40})\r?\n$/u.test(value)) {
    throw new Error('CODEX_UPSTREAM_COMMIT must contain one exact lowercase 40-hex commit.');
  }
  return value.trim();
}

async function filesUnder(root, current = root) {
  const output = [];
  if (current === root) {
    const metadata = await lstat(root);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('Vendored source root must be a real directory.');
  }
  const entries = await readdir(current, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
  for (const entry of entries) {
    if (entry.name === '.git') continue;
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) output.push(...await filesUnder(root, absolute));
    else if (entry.isFile()) {
      output.push(path.relative(root, absolute).split(path.sep).join('/'));
      if (output.length > MAX_VENDOR_FILES) throw new Error('Vendored source exceeds the manifest file bound.');
    }
    else throw new Error(`Unsupported vendored source entry: ${path.relative(root, absolute)}`);
  }
  return output;
}

async function sha256(filename) {
  return createHash('sha256').update(await readFile(filename)).digest('hex');
}

export async function createVendorManifest(sourceRoot = defaultSourceRoot, commit = undefined) {
  const resolvedCommit = commit ?? await readPinnedCommit();
  if (!COMMIT.test(resolvedCommit)) throw new Error('Vendored source commit must be lowercase 40-hex.');
  const files = {};
  for (const relative of await filesUnder(sourceRoot)) files[relative] = await sha256(path.join(sourceRoot, ...relative.split('/')));
  return { algorithm: 'sha256', upstream: EXPECTED_UPSTREAM, commit: resolvedCommit, files };
}

export async function verifyVendorManifest(sourceRoot = defaultSourceRoot, manifestPath = defaultManifestPath) {
  const manifestMetadata = await lstat(manifestPath);
  if (!manifestMetadata.isFile() || manifestMetadata.isSymbolicLink() || manifestMetadata.size > MAX_MANIFEST_BYTES) {
    throw new Error('Vendored source manifest is missing, linked, or too large.');
  }
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (
    !exactKeys(manifest, ['algorithm', 'commit', 'files', 'upstream'])
    || manifest.algorithm !== 'sha256'
    || manifest.upstream !== EXPECTED_UPSTREAM
    || !COMMIT.test(manifest.commit)
    || !isRecord(manifest.files)
    || Object.keys(manifest.files).length < 1
    || Object.keys(manifest.files).length > MAX_VENDOR_FILES
  ) {
    throw new Error('Vendored source manifest has an invalid format.');
  }
  const expectedCommit = await readPinnedCommit();
  if (manifest.commit !== expectedCommit) {
    throw new Error(`Vendored source manifest commit mismatch. CODEX_UPSTREAM_COMMIT is ${expectedCommit}, manifest is ${manifest.commit}.`);
  }
  for (const [relative, digest] of Object.entries(manifest.files)) {
    if (!safeRelativePath(relative) || typeof digest !== 'string' || !SHA256.test(digest)) {
      throw new Error(`Vendored source manifest has an invalid SHA-256 entry for ${relative || '<empty>'}.`);
    }
  }
  const actualFiles = await filesUnder(sourceRoot);
  const expectedFiles = Object.keys(manifest.files).sort((left, right) => left.localeCompare(right, 'en'));
  const added = actualFiles.filter((file) => !Object.hasOwn(manifest.files, file));
  const deleted = expectedFiles.filter((file) => !actualFiles.includes(file));
  const changed = [];
  for (const relative of actualFiles) {
    const expected = manifest.files[relative];
    if (typeof expected === 'string' && await sha256(path.join(sourceRoot, ...relative.split('/'))) !== expected) changed.push(relative);
  }
  if (added.length || deleted.length || changed.length) {
    const details = [
      ...added.slice(0, 20).map((file) => `added: ${file}`),
      ...deleted.slice(0, 20).map((file) => `deleted: ${file}`),
      ...changed.slice(0, 20).map((file) => `changed: ${file}`),
    ];
    const omitted = added.length + deleted.length + changed.length - details.length;
    throw new Error(`Vendored Codex source integrity check failed.\n${details.join('\n')}${omitted > 0 ? `\n...and ${omitted} more` : ''}`);
  }
  return { commit: manifest.commit, fileCount: actualFiles.length };
}

async function main() {
  if (process.argv.includes('--write')) {
    const manifest = await createVendorManifest();
    await writeFile(defaultManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    process.stdout.write(`Wrote SHA-256 manifest for ${Object.keys(manifest.files).length} vendored files.\n`);
    return;
  }
  const result = await verifyVendorManifest();
  process.stdout.write(`Verified ${result.fileCount} vendored Codex files at ${result.commit}.\n`);
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
