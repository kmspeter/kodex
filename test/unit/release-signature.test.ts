import { generateKeyPairSync } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createReleaseArtifact } from '../../scripts/lib/release-artifact.mjs';
import {
  signReleaseArtifact,
  validateReleaseTrustStore,
  verifyReleaseArtifact,
} from '../../scripts/lib/release-signature.mjs';

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');
const cliPath = path.join(repositoryRoot, 'scripts', 'kodex-release.mjs');
const roots: string[] = [];
const commit = 'a'.repeat(40);
const codexCommit = 'b'.repeat(40);
const vendorHash = 'c'.repeat(64);
const migrations = [{ version: 1, name: 'initial', checksum: 'd'.repeat(64) }];

interface TrustKey {
  algorithm: 'Ed25519';
  keyId: string;
  publicKey: string;
  status: 'trusted' | 'revoked';
}

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodex-release-signature-'));
  roots.push(root);
  return root;
}

async function sealedRelease(root: string, suffix = ''): Promise<string> {
  const runtime = path.join(root, `runtime${suffix}`);
  await mkdir(path.join(runtime, 'resources', 'app', 'metadata'), { recursive: true });
  await writeFile(path.join(runtime, 'Kodex.exe'), 'portable-binary', 'utf8');
  await writeFile(path.join(runtime, 'resources', 'app', 'package.json'), '{"version":"0.2.0"}\n', 'utf8');
  const output = path.join(root, `releases${suffix}`, 'Kodex-0.2.0-windows-x64-aaaaaaaaaaaa');
  await createReleaseArtifact({
    runtimeRoot: runtime,
    output,
    version: '0.2.0',
    commit,
    migrations,
    codexUpstreamCommit: codexCommit,
    vendorManifestSha256: vendorHash,
  });
  return output;
}

function ephemeralKey() {
  const pair = generateKeyPairSync('ed25519');
  return {
    privateKey: pair.privateKey.export({ format: 'pem', type: 'pkcs8' }),
    publicKey: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
  };
}

async function writeTrustStore(
  root: string,
  keys: TrustKey[],
  storeVersion = 1,
  filename = 'release-trust-store.json',
): Promise<string> {
  const trustStorePath = path.join(root, filename);
  await writeFile(trustStorePath, `${JSON.stringify({
    format: 'kodex-release-trust-store',
    formatVersion: 1,
    storeVersion,
    keys,
  }, null, 2)}\n`, 'utf8');
  return trustStorePath;
}

function runCli(args: string[], input?: string | Buffer): Promise<{ code: number | null; stderr: string; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: repositoryRoot,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', reject);
    child.once('exit', (code) => resolve({
      code,
      stderr: Buffer.concat(stderr).toString('utf8'),
      stdout: Buffer.concat(stdout).toString('utf8'),
    }));
    child.stdin.end(input);
  });
}

describe('Ed25519 release authenticity', () => {
  it('does not trust unsigned artifacts and enforces rotation and revocation state', async () => {
    const root = await temporaryRoot();
    const release = await sealedRelease(root);
    const oldKey = ephemeralKey();
    const activeKey = ephemeralKey();
    const privateKeyPath = path.join(root, 'offline-signing-key.pem');
    await writeFile(privateKeyPath, activeKey.privateKey, { mode: 0o600 });
    const trustStorePath = await writeTrustStore(root, [
      { keyId: 'release-2026-q2', algorithm: 'Ed25519', status: 'revoked', publicKey: oldKey.publicKey },
      { keyId: 'release-2026-q3', algorithm: 'Ed25519', status: 'trusted', publicKey: activeKey.publicKey },
    ], 7);

    await expect(verifyReleaseArtifact(release, { trustStorePath })).rejects.toThrow('signature envelope');
    const signed = await signReleaseArtifact({
      directory: release,
      keyFile: privateKeyPath,
      keyId: 'release-2026-q3',
    });
    expect(signed).toMatchObject({ algorithm: 'Ed25519', keyId: 'release-2026-q3' });
    await expect(verifyReleaseArtifact(release, { trustStorePath })).resolves.toMatchObject({
      keyId: 'release-2026-q3',
      trustStoreVersion: 7,
    });
    await expect(signReleaseArtifact({
      directory: release,
      keyFile: privateKeyPath,
      keyId: 'release-2026-q3',
    })).rejects.toThrow('not re-signed in place');

    await writeTrustStore(root, [
      { keyId: 'release-2026-q2', algorithm: 'Ed25519', status: 'revoked', publicKey: oldKey.publicKey },
      { keyId: 'release-2026-q3', algorithm: 'Ed25519', status: 'revoked', publicKey: activeKey.publicKey },
    ], 8);
    await expect(verifyReleaseArtifact(release, { trustStorePath })).rejects.toThrow('key is revoked');
  });

  it('rejects unknown keys and non-canonical base64 signature encodings', async () => {
    const root = await temporaryRoot();
    const release = await sealedRelease(root);
    const signingKey = ephemeralKey();
    await signReleaseArtifact({
      directory: release,
      keyId: 'release-primary',
      privateKeyBytes: Buffer.from(signingKey.privateKey),
    });
    const differentKey = ephemeralKey();
    const unknownTrustStore = await writeTrustStore(root, [
      { keyId: 'release-other', algorithm: 'Ed25519', status: 'trusted', publicKey: differentKey.publicKey },
    ]);
    await expect(verifyReleaseArtifact(release, { trustStorePath: unknownTrustStore }))
      .rejects.toThrow('not present in the trust store');

    const validTrustStore = await writeTrustStore(root, [
      { keyId: 'release-primary', algorithm: 'Ed25519', status: 'trusted', publicKey: signingKey.publicKey },
    ], 2, 'valid-trust-store.json');
    const signaturePath = path.join(release, 'release-signature.json');
    const envelope = JSON.parse(await readFile(signaturePath, 'utf8')) as Record<string, unknown>;
    envelope.signature = String(envelope.signature).replace(/=+$/u, '');
    await writeFile(signaturePath, `${JSON.stringify(envelope, null, 2)}\n`, 'utf8');
    await expect(verifyReleaseArtifact(release, { trustStorePath: validTrustStore }))
      .rejects.toThrow('not canonical base64');
  });

  it('rejects non-canonical manifests, canonical manifest tamper, artifact tamper, and unlisted files', async () => {
    const root = await temporaryRoot();
    const key = ephemeralKey();
    const trustStorePath = await writeTrustStore(root, [
      { keyId: 'release-primary', algorithm: 'Ed25519', status: 'trusted', publicKey: key.publicKey },
    ]);

    const nonCanonical = await sealedRelease(root, '-noncanonical');
    const nonCanonicalPath = path.join(nonCanonical, 'release-manifest.json');
    const nonCanonicalManifest = JSON.parse(await readFile(nonCanonicalPath, 'utf8')) as Record<string, unknown>;
    await writeFile(nonCanonicalPath, JSON.stringify(nonCanonicalManifest), 'utf8');
    await expect(signReleaseArtifact({
      directory: nonCanonical,
      keyId: 'release-primary',
      privateKeyBytes: Buffer.from(key.privateKey),
    })).rejects.toThrow('canonical JSON');

    const release = await sealedRelease(root, '-tamper');
    await signReleaseArtifact({
      directory: release,
      keyId: 'release-primary',
      privateKeyBytes: Buffer.from(key.privateKey),
    });
    const manifestPath = path.join(release, 'release-manifest.json');
    const originalManifest = await readFile(manifestPath, 'utf8');
    const manifest = JSON.parse(originalManifest) as { createdAt: string };
    manifest.createdAt = new Date(Date.parse(manifest.createdAt) + 1_000).toISOString();
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    await expect(verifyReleaseArtifact(release, { trustStorePath })).rejects.toThrow('digest does not match');

    await writeFile(manifestPath, originalManifest, 'utf8');
    const executablePath = path.join(release, 'Kodex.exe');
    await writeFile(executablePath, 'portable-tamper', 'utf8');
    await expect(verifyReleaseArtifact(release, { trustStorePath })).rejects.toThrow('checksum verification failed');

    await writeFile(executablePath, 'portable-binary', 'utf8');
    await writeFile(path.join(release, 'unlisted.txt'), 'unlisted', 'utf8');
    await expect(verifyReleaseArtifact(release, { trustStorePath })).rejects.toThrow('unlisted or missing');
  });

  it('strictly validates bounded canonical trust stores', async () => {
    const root = await temporaryRoot();
    const key = ephemeralKey();
    const trustStorePath = await writeTrustStore(root, [
      { keyId: 'release-primary', algorithm: 'Ed25519', status: 'trusted', publicKey: key.publicKey },
    ], 3);
    await expect(validateReleaseTrustStore(trustStorePath)).resolves.toEqual({
      keyCount: 1,
      revokedKeyCount: 0,
      storeVersion: 3,
      trustedKeyCount: 1,
    });
    const value = JSON.parse(await readFile(trustStorePath, 'utf8')) as Record<string, unknown>;
    await writeFile(trustStorePath, JSON.stringify(value), 'utf8');
    await expect(validateReleaseTrustStore(trustStorePath)).rejects.toThrow('not canonical JSON');
  });

  it('signs and verifies through the CLI stdin boundary without disclosing rejected key input', async () => {
    const root = await temporaryRoot();
    const release = await sealedRelease(root);
    const key = ephemeralKey();
    const trustStorePath = await writeTrustStore(root, [
      { keyId: 'release-cli', algorithm: 'Ed25519', status: 'trusted', publicKey: key.publicKey },
    ], 4);
    const signed = await runCli([
      'sign', '--path', release, '--key-id', 'release-cli', '--key-stdin',
    ], key.privateKey);
    expect(signed.code).toBe(0);
    expect(JSON.parse(signed.stdout)).toMatchObject({
      algorithm: 'Ed25519',
      keyId: 'release-cli',
      kind: 'kodex_release_signed',
    });
    const verified = await runCli([
      'verify', '--path', release, '--trust-store', trustStorePath,
    ]);
    expect(verified.code).toBe(0);
    expect(JSON.parse(verified.stdout)).toMatchObject({
      keyId: 'release-cli',
      kind: 'kodex_release_verified',
      trustStoreVersion: 4,
    });
    const missingTrustStore = await runCli(['verify', '--path', release]);
    expect(missingTrustStore.code).not.toBe(0);
    expect(missingTrustStore.stderr).toContain('strict command options');

    const invalidRelease = await sealedRelease(root, '-invalid-key');
    const secretMarker = `not-a-private-key-${'z'.repeat(32)}`;
    const rejected = await runCli([
      'sign', '--path', invalidRelease, '--key-id', 'release-cli', '--key-stdin',
    ], secretMarker);
    expect(rejected.code).not.toBe(0);
    expect(rejected.stderr).not.toContain(secretMarker);
    expect(rejected.stderr).toContain('not a valid Ed25519 private key');
  });
});
