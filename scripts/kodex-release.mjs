import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';
import { createReleaseArtifact } from './lib/release-artifact.mjs';
import {
  signReleaseArtifact,
  validateReleaseTrustStore,
  verifyReleaseArtifact,
} from './lib/release-signature.mjs';
import {
  scanReleaseInputSecrets,
  scanTrackedSecrets,
  verifyPackagedRuntimeProvenance,
  verifyRepositoryProvenance,
} from './lib/security-validation.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.versions.electron) process.noAsar = true;

const USAGE = 'Usage: kodex-release <create|sign|verify|trust-store-validate> [strict command options]';
const MAX_STDIN_KEY_BYTES = 64 * 1024;

function parseFlags(values, booleanFlags = []) {
  const flags = new Map();
  for (let index = 0; index < values.length; index += 1) {
    const flag = values[index];
    if (!/^--[a-z-]+$/u.test(flag) || flags.has(flag)) throw new Error(USAGE);
    if (booleanFlags.includes(flag)) {
      flags.set(flag, true);
      continue;
    }
    const value = values[index + 1];
    if (typeof value !== 'string' || !value || value.startsWith('--')) throw new Error(USAGE);
    flags.set(flag, value);
    index += 1;
  }
  return flags;
}

function exactFlagSet(flags, required, optional = []) {
  const allowed = new Set([...required, ...optional]);
  return required.every((flag) => flags.has(flag))
    && [...flags.keys()].every((flag) => allowed.has(flag));
}

function argumentsFor(values) {
  const [command, ...rest] = values;
  if (command === 'create') {
    const flags = parseFlags(rest);
    if (!exactFlagSet(flags, ['--path']) || flags.size !== 1) throw new Error(USAGE);
    return { command, output: path.resolve(flags.get('--path')) };
  }
  if (command === 'sign') {
    const flags = parseFlags(rest, ['--key-stdin']);
    if (!exactFlagSet(flags, ['--path', '--key-id'], ['--key-file', '--key-stdin'])) throw new Error(USAGE);
    const hasKeyFile = flags.has('--key-file');
    const hasKeyStdin = flags.has('--key-stdin');
    if (hasKeyFile === hasKeyStdin || flags.size !== 3) throw new Error(USAGE);
    return {
      command,
      keyFile: hasKeyFile ? path.resolve(flags.get('--key-file')) : undefined,
      keyId: flags.get('--key-id'),
      keyStdin: hasKeyStdin,
      output: path.resolve(flags.get('--path')),
    };
  }
  if (command === 'verify') {
    const flags = parseFlags(rest);
    if (!exactFlagSet(flags, ['--path', '--trust-store']) || flags.size !== 2) throw new Error(USAGE);
    return {
      command,
      output: path.resolve(flags.get('--path')),
      trustStorePath: path.resolve(flags.get('--trust-store')),
    };
  }
  if (command === 'trust-store-validate') {
    const flags = parseFlags(rest);
    if (!exactFlagSet(flags, ['--trust-store']) || flags.size !== 1) throw new Error(USAGE);
    return { command, trustStorePath: path.resolve(flags.get('--trust-store')) };
  }
  throw new Error(USAGE);
}

async function readSigningKeyFromStdin() {
  if (process.stdin.isTTY) throw new Error('Signing key stdin must be a non-interactive pipe.');
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > MAX_STDIN_KEY_BYTES) throw new Error('Signing key stdin exceeds the byte limit.');
    chunks.push(bytes);
  }
  if (total < 1) throw new Error('Signing key stdin is empty.');
  return Buffer.concat(chunks, total);
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
  const verified = await verifyReleaseArtifact(parsed.output, { trustStorePath: parsed.trustStorePath });
  process.stdout.write(`${JSON.stringify({
    kind: 'kodex_release_verified',
    commit: verified.manifest.release.commit,
    fileCount: verified.manifest.files.length,
    formatVersion: verified.manifest.formatVersion,
    keyId: verified.keyId,
    manifestSha256: verified.manifestSha256,
    trustStoreVersion: verified.trustStoreVersion,
    version: verified.manifest.release.version,
  })}\n`);
} else if (parsed.command === 'sign') {
  await scanReleaseInputSecrets(parsed.output);
  const stdinKey = parsed.keyStdin ? await readSigningKeyFromStdin() : undefined;
  let envelope;
  try {
    envelope = await signReleaseArtifact({
      directory: parsed.output,
      forbiddenKeyRoots: [repositoryRoot],
      keyFile: parsed.keyFile,
      keyId: parsed.keyId,
      privateKeyBytes: stdinKey,
    });
  } finally {
    stdinKey?.fill(0);
  }
  process.stdout.write(`${JSON.stringify({
    kind: 'kodex_release_signed',
    algorithm: envelope.algorithm,
    keyId: envelope.keyId,
    manifestSha256: envelope.manifestSha256,
    signatureFormatVersion: envelope.formatVersion,
  })}\n`);
} else if (parsed.command === 'trust-store-validate') {
  const trustStore = await validateReleaseTrustStore(parsed.trustStorePath);
  process.stdout.write(`${JSON.stringify({ kind: 'kodex_release_trust_store_validated', ...trustStore })}\n`);
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
  const provenance = await verifyRepositoryProvenance(repositoryRoot, { requireBinary: true });
  await scanTrackedSecrets(repositoryRoot);
  await scanReleaseInputSecrets(runtimeRoot);
  await verifyPackagedRuntimeProvenance(appRoot, provenance);
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
    kind: 'kodex_release_sealed_unsigned',
    commit: result.manifest.release.commit,
    fileCount: result.manifest.files.length,
    formatVersion: result.manifest.formatVersion,
    releaseId: result.releaseId,
    signed: false,
    version: result.manifest.release.version,
  })}\n`);
}
