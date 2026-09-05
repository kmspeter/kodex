import { spawn } from 'node:child_process';
import { createHash, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createReleaseArtifact } from '../../scripts/lib/release-artifact.mjs';
import { signReleaseArtifact } from '../../scripts/lib/release-signature.mjs';
import {
  activateWindowsInstallerRelease,
  confirmWindowsInstallerRelease,
  planWindowsInstallerUpdate,
  stageWindowsInstallerCandidate,
  WindowsInstallerError,
  windowsInstallerStatus,
} from '../../scripts/lib/windows-installer.mjs';

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');
const layoutPath = path.join(repositoryRoot, 'config', 'windows-installer-layout.json');
const cliPath = path.join(repositoryRoot, 'scripts', 'kodex-installer.mjs');
const roots: string[] = [];

interface FixtureKey {
  privateKey: KeyObject;
  publicKey: string;
}

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodex-windows-installer-unit-'));
  roots.push(root);
  return root;
}

function fixtureKey(): FixtureKey {
  const pair = generateKeyPairSync('ed25519');
  return {
    privateKey: pair.privateKey,
    publicKey: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
  };
}

async function trustStore(root: string, key: FixtureKey, storeVersion = 1, name = 'trust.json'): Promise<string> {
  const filename = path.join(root, name);
  await writeFile(filename, `${JSON.stringify({
    format: 'kodex-release-trust-store',
    formatVersion: 1,
    storeVersion,
    keys: [{ keyId: 'unit-key', algorithm: 'Ed25519', status: 'trusted', publicKey: key.publicKey }],
  }, null, 2)}\n`, 'utf8');
  return filename;
}

async function release(root: string, key: FixtureKey, version: string, marker: string): Promise<{ id: string; root: string }> {
  const commit = marker.repeat(40);
  const id = `Kodex-${version}-windows-x64-${commit.slice(0, 12)}`;
  const runtime = path.join(root, `runtime-${marker}`);
  const output = path.join(root, 'candidates', id);
  await mkdir(path.join(runtime, 'resources', 'app', 'metadata'), { recursive: true });
  await writeFile(path.join(runtime, 'Kodex.exe'), marker, 'utf8');
  await writeFile(path.join(runtime, 'resources', 'app', 'metadata', 'installer-compatibility.json'), `${JSON.stringify({
    format: 'kodex-windows-release-compatibility',
    formatVersion: 1,
    database: {
      migrationStrategy: 'forward-only',
      latestSchemaVersion: 1,
      minimumReadableSchemaVersion: 1,
      maximumReadableSchemaVersion: 1,
    },
  }, null, 2)}\n`, 'utf8');
  await createReleaseArtifact({
    runtimeRoot: runtime,
    output,
    version,
    commit,
    migrations: [{ version: 1, name: 'initial', checksum: digest('initial') }],
    codexUpstreamCommit: 'f'.repeat(40),
    vendorManifestSha256: digest('vendor'),
  });
  await signReleaseArtifact({
    directory: output,
    keyId: 'unit-key',
    privateKeyBytes: Buffer.from(key.privateKey.export({ format: 'pem', type: 'pkcs8' })),
  });
  return { id, root: output };
}

function options(root: string, trustStorePath: string) {
  return {
    aclAdapter: { async assertSafeTree() { return true; } },
    installRoot: path.join(root, 'install'),
    layoutPath,
    trustStorePath,
  };
}

function runCli(args: string[]): Promise<{ code: number | null; stderr: string; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: repositoryRoot,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
      shell: false,
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
  });
}

describe('Windows installer/update state machine', () => {
  it('stages a signed side-by-side release and confirms an atomic active pointer', async () => {
    const root = await temporaryRoot();
    const key = fixtureKey();
    const store = await trustStore(root, key);
    const candidate = await release(root, key, '1.0.0', 'a');
    const common = options(root, store);
    await expect(planWindowsInstallerUpdate({ ...common, candidate: candidate.root })).resolves.toMatchObject({
      operation: 'install',
      releaseId: candidate.id,
    });
    await stageWindowsInstallerCandidate({ ...common, candidate: candidate.root });
    await activateWindowsInstallerRelease({ ...common, releaseId: candidate.id });
    await confirmWindowsInstallerRelease({ ...common, releaseId: candidate.id, databaseSchemaVersion: 1 });
    await expect(windowsInstallerStatus(common)).resolves.toMatchObject({
      activeReleaseId: candidate.id,
      confirmedReleaseId: candidate.id,
      releaseCount: 1,
      transactionPhase: null,
    });
  });

  it('rejects non-canonical state, unsafe ACL preconditions, and trust-store rollback', async () => {
    const root = await temporaryRoot();
    const key = fixtureKey();
    const store = await trustStore(root, key);
    const first = await release(root, key, '1.0.0', 'a');
    const common = options(root, store);
    await stageWindowsInstallerCandidate({ ...common, candidate: first.root });

    const stateRoot = path.join(root, 'install', '.installer-state');
    await writeFile(path.join(stateRoot, 'current.json'), '{}', 'utf8');
    await expect(windowsInstallerStatus(common)).rejects.toBeInstanceOf(WindowsInstallerError);
    await rm(path.join(stateRoot, 'current.json'));

    const denied = { ...common, aclAdapter: { async assertSafeTree() { return false; } } };
    await expect(stageWindowsInstallerCandidate({ ...denied, candidate: first.root }))
      .rejects.toMatchObject({ code: 'unsafe_acl_or_acl_unavailable' });

    const secondKey = fixtureKey();
    const secondStore = await trustStore(root, secondKey, 1, 'different-trust.json');
    const second = await release(root, secondKey, '1.1.0', 'b');
    await expect(stageWindowsInstallerCandidate({
      ...common,
      candidate: second.root,
      trustStorePath: secondStore,
    })).rejects.toMatchObject({ code: 'trust_store_rollback_rejected' });
  });

  it('keeps CLI errors payload-free under strict parsing', async () => {
    const marker = `secret-${'z'.repeat(48)}`;
    const result = await runCli(['status', '--install-root', path.join(os.tmpdir(), marker), '--unexpected', marker]);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).not.toContain(marker);
    expect(JSON.parse(result.stderr)).toEqual({
      kind: 'kodex_windows_installer_error',
      code: 'invalid_arguments',
    });
  });
});
