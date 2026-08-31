import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const defaultSourceRoot = path.join(repositoryRoot, 'vendor', 'openai-codex');
export const defaultManifestPath = path.join(repositoryRoot, 'VENDOR_SOURCE_SHA256.json');

async function filesUnder(root, current = root) {
  const output = [];
  const entries = await readdir(current, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
  for (const entry of entries) {
    if (entry.name === '.git') continue;
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) output.push(...await filesUnder(root, absolute));
    else if (entry.isFile()) output.push(path.relative(root, absolute).split(path.sep).join('/'));
    else throw new Error(`Unsupported vendored source entry: ${path.relative(root, absolute)}`);
  }
  return output;
}

async function sha256(filename) {
  return createHash('sha256').update(await readFile(filename)).digest('hex');
}

export async function createVendorManifest(sourceRoot = defaultSourceRoot, commit = undefined) {
  const resolvedCommit = commit ?? (await readFile(path.join(repositoryRoot, 'CODEX_UPSTREAM_COMMIT'), 'utf8')).trim();
  const files = {};
  for (const relative of await filesUnder(sourceRoot)) files[relative] = await sha256(path.join(sourceRoot, ...relative.split('/')));
  return { algorithm: 'sha256', upstream: 'https://github.com/openai/codex', commit: resolvedCommit, files };
}

export async function verifyVendorManifest(sourceRoot = defaultSourceRoot, manifestPath = defaultManifestPath) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.algorithm !== 'sha256' || typeof manifest.commit !== 'string' || !manifest.files || typeof manifest.files !== 'object') {
    throw new Error('Vendored source manifest has an invalid format.');
  }
  const expectedCommit = (await readFile(path.join(repositoryRoot, 'CODEX_UPSTREAM_COMMIT'), 'utf8')).trim();
  if (manifest.commit !== expectedCommit) {
    throw new Error(`Vendored source manifest commit mismatch. CODEX_UPSTREAM_COMMIT is ${expectedCommit}, manifest is ${manifest.commit}.`);
  }
  for (const [relative, digest] of Object.entries(manifest.files)) {
    if (!relative || typeof digest !== 'string' || !/^[a-f0-9]{64}$/u.test(digest)) throw new Error(`Vendored source manifest has an invalid SHA-256 entry for ${relative || '<empty>'}.`);
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
