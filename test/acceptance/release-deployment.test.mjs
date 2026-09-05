import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createProductDatabase } from '@kodex/product-db';
import { afterAll, expect, it } from 'vitest';
import {
  startRuntimeChild,
  stopRuntimeChildren,
  unusedLoopbackPort,
  waitForReady,
} from '../../apps/desktop/runtime-processes.mjs';
import { createReleaseArtifact } from '../../scripts/lib/release-artifact.mjs';
import { signReleaseArtifact, verifyReleaseArtifact } from '../../scripts/lib/release-signature.mjs';

const repositoryRoot = process.cwd();
const databaseUrl = process.env.KODEX_RELEASE_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('Release deployment acceptance requires an isolated PostgreSQL URL.');
const runtimeRoot = path.join(repositoryRoot, 'runtime', 'Kodex-win32-x64');
const database = createProductDatabase({ connectionString: databaseUrl, ssl: false });
const releaseCommit = randomBytes(20).toString('hex');
const applicationVersion = JSON.parse(
  await readFile(path.join(repositoryRoot, 'package.json'), 'utf8'),
).version;
const releaseRoot = path.join(
  repositoryRoot,
  'runtime',
  `Kodex-${applicationVersion}-windows-x64-${releaseCommit.slice(0, 12)}`,
);
const children = [];
let signingRoot;

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

function waitForExit(child, timeoutMs = 20_000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return Promise.race([
    new Promise((resolve) => child.once('exit', () => resolve(true))),
    new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}

function runPackagedVerifier(trustStorePath) {
  return new Promise((resolve, reject) => {
    const appRoot = path.join(releaseRoot, 'resources', 'app');
    const child = spawn(
      path.join(releaseRoot, 'electron.exe'),
      [
        path.join(appRoot, 'operations', 'kodex-release.mjs'),
        'verify', '--path', releaseRoot, '--trust-store', trustStorePath,
      ],
      {
        cwd: releaseRoot,
        env: {
          ELECTRON_RUN_AS_NODE: '1',
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          TEMP: process.env.TEMP,
          TMP: process.env.TMP,
        },
        shell: false,
        windowsHide: true,
        stdio: 'ignore',
      },
    );
    child.once('error', reject);
    child.once('exit', (code) => code === 0
      ? resolve()
      : reject(new Error(`Packaged release verifier exited with ${code ?? 'unknown'}.`)));
  });
}

async function startReleasedApi(port) {
  const appRoot = path.join(releaseRoot, 'resources', 'app');
  const child = startRuntimeChild(
    'Released Product API',
    path.join(releaseRoot, 'electron.exe'),
    path.join(appRoot, 'product-api', 'main.js'),
    {
      cwd: appRoot,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
        KODEX_RUNTIME_ROOT: appRoot,
        KODEX_DISABLE_ENV_FILE: '1',
        KODEX_DEPLOYMENT_PROFILE: 'acceptance',
        KODEX_ACCEPTANCE_ALLOW_SINGLE_DB: '1',
        DATABASE_URL: databaseUrl,
        PRODUCT_DB_SSL: 'disable',
        PRODUCT_API_NODE_ENV: 'production',
        PRODUCT_API_HOST: '127.0.0.1',
        PRODUCT_API_PORT: String(port),
        PRODUCT_API_ALLOWED_HOSTS: `127.0.0.1:${port}`,
        AUTH_ALLOWED_ORIGINS: 'https://kodex.example',
        AUTH_COOKIE_SECRET: Buffer.alloc(32, 23).toString('base64url'),
        AUTH_COOKIE_SECURE: 'true',
        KODEX_RAG_ENABLED: 'false',
      },
    },
  );
  children.push(child);
  return child;
}

afterAll(async () => {
  await stopRuntimeChildren(children);
  await database.close();
  await rm(releaseRoot, { recursive: true, force: true });
  if (signingRoot) await rm(signingRoot, { recursive: true, force: true });
});

it('installs, migrates before listen, reports exact version, and recovers from an incompatible ledger', async () => {
  const appRoot = path.join(runtimeRoot, 'resources', 'app');
  const application = JSON.parse(await readFile(path.join(appRoot, 'package.json'), 'utf8'));
  const migrationsModule = await import(pathToFileURL(path.join(
    appRoot,
    'node_modules',
    '@kodex',
    'product-db',
    'dist',
    'migrations.js',
  )).href);
  const migrations = await migrationsModule.loadMigrations();
  await createReleaseArtifact({
    runtimeRoot,
    output: releaseRoot,
    version: application.version,
    commit: releaseCommit,
    migrations: migrations.map((migration) => ({
      version: migration.version,
      name: migration.name,
      checksum: migration.checksum,
    })),
    codexUpstreamCommit: (await readFile(path.join(appRoot, 'metadata', 'CODEX_UPSTREAM_COMMIT'), 'utf8')).trim(),
    vendorManifestSha256: await sha256File(path.join(appRoot, 'metadata', 'VENDOR_SOURCE_SHA256.json')),
  });
  signingRoot = await mkdtemp(path.join(os.tmpdir(), 'kodex-release-acceptance-signing-'));
  const keys = generateKeyPairSync('ed25519');
  const keyId = 'acceptance-ephemeral';
  const privateKeyPath = path.join(signingRoot, 'private-key.pem');
  const trustStorePath = path.join(signingRoot, 'release-trust-store.json');
  await writeFile(privateKeyPath, keys.privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
  await writeFile(trustStorePath, `${JSON.stringify({
    format: 'kodex-release-trust-store',
    formatVersion: 1,
    storeVersion: 1,
    keys: [{
      keyId,
      algorithm: 'Ed25519',
      status: 'trusted',
      publicKey: keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    }],
  }, null, 2)}\n`, 'utf8');
  await signReleaseArtifact({ directory: releaseRoot, keyFile: privateKeyPath, keyId });
  const verifiedRelease = await verifyReleaseArtifact(releaseRoot, { trustStorePath });
  expect(verifiedRelease.manifest.database.migrations.at(-1)?.version).toBe(13);
  await runPackagedVerifier(trustStorePath);

  const firstPort = await unusedLoopbackPort();
  const first = await startReleasedApi(firstPort);
  await waitForReady(first, `http://127.0.0.1:${firstPort}/api/health/ready`, 'Released Product API', 30_000);
  const version = await fetch(`http://127.0.0.1:${firstPort}/api/version`);
  expect(await version.json()).toEqual({ version: application.version, commit: releaseCommit });
  const ledger = await database.query('SELECT count(*)::integer AS count, max(version)::integer AS latest FROM schema_migrations');
  expect(ledger.rows[0]).toEqual({ count: 12, latest: 12 });
  await stopRuntimeChildren([first]);

  await database.query(
    'INSERT INTO schema_migrations (version, name, checksum) VALUES (13, $1, $2)',
    ['future_release_only', '0'.repeat(64)],
  );
  const rejectedPort = await unusedLoopbackPort();
  const rejected = await startReleasedApi(rejectedPort);
  expect(await waitForExit(rejected)).toBe(true);
  await expect(fetch(`http://127.0.0.1:${rejectedPort}/api/health/live`)).rejects.toThrow();

  await database.query('DELETE FROM schema_migrations WHERE version = 13');
  const recoveredPort = await unusedLoopbackPort();
  const recovered = await startReleasedApi(recoveredPort);
  await waitForReady(recovered, `http://127.0.0.1:${recoveredPort}/api/health/ready`, 'Recovered Product API', 30_000);
  expect(await (await fetch(`http://127.0.0.1:${recoveredPort}/api/version`)).json())
    .toEqual({ version: application.version, commit: releaseCommit });
});
