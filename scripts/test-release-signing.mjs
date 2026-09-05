import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createReleaseArtifact } from './lib/release-artifact.mjs';
import {
  signReleaseArtifact,
  validateReleaseTrustStore,
  verifyReleaseArtifact,
} from './lib/release-signature.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const commit = 'a'.repeat(40);

async function createFixture(root) {
  const runtimeRoot = path.join(root, 'runtime');
  const releaseRoot = path.join(root, 'release', 'Kodex-0.2.0-windows-x64-aaaaaaaaaaaa');
  await mkdir(path.join(runtimeRoot, 'resources', 'app', 'metadata'), { recursive: true });
  await writeFile(path.join(runtimeRoot, 'Kodex.exe'), 'portable-binary', 'utf8');
  await writeFile(path.join(runtimeRoot, 'resources', 'app', 'package.json'), '{"version":"0.2.0"}\n', 'utf8');
  await createReleaseArtifact({
    runtimeRoot,
    output: releaseRoot,
    version: '0.2.0',
    commit,
    migrations: [{ version: 1, name: 'initial', checksum: 'd'.repeat(64) }],
    codexUpstreamCommit: 'b'.repeat(40),
    vendorManifestSha256: 'c'.repeat(64),
  });
  return releaseRoot;
}

async function writeTrustStore(filename, publicKey, status, storeVersion) {
  await writeFile(filename, `${JSON.stringify({
    format: 'kodex-release-trust-store',
    formatVersion: 1,
    storeVersion,
    keys: [{
      keyId: 'fixture-key',
      algorithm: 'Ed25519',
      status,
      publicKey,
    }],
  }, null, 2)}\n`, 'utf8');
}

const bootstrapTrustStorePath = path.join(repositoryRoot, 'config', 'release-trust-store.json');
const bootstrapTrustStoreBytes = await readFile(bootstrapTrustStorePath);
assert.equal(
  bootstrapTrustStoreBytes.includes(0x0d),
  false,
  'Repository bootstrap trust store must remain LF-only in every Git checkout.',
);
assert.deepEqual(await validateReleaseTrustStore(bootstrapTrustStorePath), {
  keyCount: 0,
  revokedKeyCount: 0,
  storeVersion: 2,
  trustedKeyCount: 0,
});

const root = await mkdtemp(path.join(os.tmpdir(), 'kodex-phase30-signing-'));
try {
  const releaseRoot = await createFixture(root);
  const keys = generateKeyPairSync('ed25519');
  const privateKey = keys.privateKey.export({ format: 'pem', type: 'pkcs8' });
  const publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const trustStorePath = path.join(root, 'release-trust-store.json');
  await writeTrustStore(trustStorePath, publicKey, 'trusted', 1);
  assert.deepEqual(await validateReleaseTrustStore(trustStorePath), {
    keyCount: 1,
    revokedKeyCount: 0,
    storeVersion: 1,
    trustedKeyCount: 1,
  });
  await assert.rejects(
    verifyReleaseArtifact(releaseRoot, { trustStorePath }),
    /signature envelope/u,
  );

  const signed = await signReleaseArtifact({
    directory: releaseRoot,
    keyId: 'fixture-key',
    privateKeyBytes: Buffer.from(privateKey),
  });
  assert.equal(signed.algorithm, 'Ed25519');
  assert.equal(signed.keyId, 'fixture-key');
  const verified = await verifyReleaseArtifact(releaseRoot, { trustStorePath });
  assert.deepEqual(
    (({ keyId, trustStoreVersion }) => ({ keyId, trustStoreVersion }))(verified),
    { keyId: 'fixture-key', trustStoreVersion: 1 },
  );

  await writeTrustStore(trustStorePath, publicKey, 'revoked', 2);
  await assert.rejects(
    verifyReleaseArtifact(releaseRoot, { trustStorePath }),
    /key is revoked/u,
  );
  await writeTrustStore(trustStorePath, publicKey, 'trusted', 3);

  const signaturePath = path.join(releaseRoot, 'release-signature.json');
  const originalSignature = await readFile(signaturePath, 'utf8');
  const envelope = JSON.parse(originalSignature);
  envelope.signature = envelope.signature.replace(/=+$/u, '');
  await writeFile(signaturePath, `${JSON.stringify(envelope, null, 2)}\n`, 'utf8');
  await assert.rejects(
    verifyReleaseArtifact(releaseRoot, { trustStorePath }),
    /not canonical base64/u,
  );
  await writeFile(signaturePath, originalSignature, 'utf8');

  const manifestPath = path.join(releaseRoot, 'release-manifest.json');
  const originalManifest = await readFile(manifestPath, 'utf8');
  const manifest = JSON.parse(originalManifest);
  manifest.createdAt = new Date(Date.parse(manifest.createdAt) + 1_000).toISOString();
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await assert.rejects(
    verifyReleaseArtifact(releaseRoot, { trustStorePath }),
    /digest does not match/u,
  );
  await writeFile(manifestPath, originalManifest, 'utf8');

  const executablePath = path.join(releaseRoot, 'Kodex.exe');
  await writeFile(executablePath, 'portable-tamper', 'utf8');
  await assert.rejects(
    verifyReleaseArtifact(releaseRoot, { trustStorePath }),
    /checksum verification failed/u,
  );
  await writeFile(executablePath, 'portable-binary', 'utf8');
  const unlistedPath = path.join(releaseRoot, 'unlisted.txt');
  await writeFile(unlistedPath, 'unlisted', 'utf8');
  await assert.rejects(
    verifyReleaseArtifact(releaseRoot, { trustStorePath }),
    /unlisted or missing/u,
  );
  await rm(unlistedPath);

  await writeFile(manifestPath, JSON.stringify(JSON.parse(originalManifest)), 'utf8');
  await assert.rejects(
    verifyReleaseArtifact(releaseRoot, { trustStorePath }),
    /canonical JSON/u,
  );

  process.stdout.write(`${JSON.stringify({
    kind: 'kodex_release_signing_fixture_passed',
    algorithm: 'Ed25519',
    bootstrapTrustStoreVersion: 2,
    trustStoreVersionsChecked: [1, 2, 3],
  })}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}
