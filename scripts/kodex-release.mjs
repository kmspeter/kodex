import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';
import { createReleaseArtifact, verifyReleaseArtifact } from './lib/release-artifact.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.versions.electron) process.noAsar = true;

function argumentsFor(values) {
  const [command, ...rest] = values;
  if (!['create', 'verify'].includes(command)) {
    throw new Error('Usage: kodex-release <create|verify> --path <directory>');
  }
  if (rest.length !== 2 || rest[0] !== '--path' || !rest[1]) {
    throw new Error('Release arguments must be exactly --path <directory>.');
  }
  return { command, output: path.resolve(rest[1]) };
}

function gitOutput(args) {
  const result = spawnSync('git', args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error('Git release provenance could not be verified.');
  return result.stdout.trim();
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

const parsed = argumentsFor(process.argv.slice(2));
if (parsed.command === 'verify') {
  const manifest = await verifyReleaseArtifact(parsed.output);
  process.stdout.write(`${JSON.stringify({
    kind: 'kodex_release_verified',
    commit: manifest.release.commit,
    fileCount: manifest.files.length,
    formatVersion: manifest.formatVersion,
    version: manifest.release.version,
  })}\n`);
} else {
  if (gitOutput(['status', '--porcelain', '--untracked-files=normal'])) {
    throw new Error('Release creation requires a clean Git working tree.');
  }
  const commit = gitOutput(['rev-parse', 'HEAD']);
  const configuredCommit = process.env.KODEX_RELEASE_COMMIT?.trim();
  if (configuredCommit && configuredCommit !== commit) {
    throw new Error('KODEX_RELEASE_COMMIT does not match Git HEAD.');
  }
  const runtimeRoot = path.join(repositoryRoot, 'runtime', 'Kodex-win32-x64');
  const appRoot = path.join(runtimeRoot, 'resources', 'app');
  const application = JSON.parse(await readFile(path.join(repositoryRoot, 'package.json'), 'utf8'));
  const packaged = JSON.parse(await readFile(path.join(appRoot, 'package.json'), 'utf8'));
  if (application.version !== packaged.version) throw new Error('Runtime version does not match the source release.');
  const migrationsModule = await import(pathToFileURL(path.join(
    appRoot,
    'node_modules',
    '@kodex',
    'product-db',
    'dist',
    'migrations.js',
  )).href);
  const migrations = await migrationsModule.loadMigrations();
  const result = await createReleaseArtifact({
    runtimeRoot,
    output: parsed.output,
    version: application.version,
    commit,
    migrations: migrations.map((migration) => ({
      version: migration.version,
      name: migration.name,
      checksum: migration.checksum,
    })),
    codexUpstreamCommit: (await readFile(path.join(appRoot, 'metadata', 'CODEX_UPSTREAM_COMMIT'), 'utf8')).trim(),
    vendorManifestSha256: await sha256File(path.join(appRoot, 'metadata', 'VENDOR_SOURCE_SHA256.json')),
  });
  process.stdout.write(`${JSON.stringify({
    kind: 'kodex_release_created',
    commit: result.manifest.release.commit,
    fileCount: result.manifest.files.length,
    formatVersion: result.manifest.formatVersion,
    releaseId: result.releaseId,
    version: result.manifest.release.version,
  })}\n`);
}
