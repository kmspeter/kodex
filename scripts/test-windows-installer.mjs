import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createReleaseArtifact } from './lib/release-artifact.mjs';
import { signReleaseArtifact } from './lib/release-signature.mjs';
import {
  activateWindowsInstallerRelease,
  confirmWindowsInstallerRelease,
  holdWindowsInstallerLockForTest,
  planWindowsInstallerUpdate,
  recoverWindowsInstaller,
  rollbackWindowsInstallerRelease,
  stageWindowsInstallerCandidate,
  WindowsInstallerError,
  windowsInstallerStatus,
} from './lib/windows-installer.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const layoutPath = path.join(repositoryRoot, 'config', 'windows-installer-layout.json');

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function releaseId(version, commit) {
  return `Kodex-${version}-windows-x64-${commit.slice(0, 12)}`;
}

async function createSignedRelease(root, key, version, marker, schemaVersion = 1) {
  const commit = marker.repeat(40);
  const runtime = path.join(root, `runtime-${marker}`);
  const output = path.join(root, 'candidates', releaseId(version, commit));
  await mkdir(path.join(runtime, 'resources', 'app', 'metadata'), { recursive: true });
  await writeFile(path.join(runtime, 'Kodex.exe'), `portable-${marker}`, 'utf8');
  await writeFile(path.join(runtime, 'resources', 'app', 'package.json'), `${JSON.stringify({ version })}\n`, 'utf8');
  await writeFile(
    path.join(runtime, 'resources', 'app', 'metadata', 'installer-compatibility.json'),
    `${JSON.stringify({
      format: 'kodex-windows-release-compatibility',
      formatVersion: 1,
      database: {
        migrationStrategy: 'forward-only',
        latestSchemaVersion: schemaVersion,
        minimumReadableSchemaVersion: schemaVersion,
        maximumReadableSchemaVersion: schemaVersion,
      },
    }, null, 2)}\n`,
    'utf8',
  );
  await createReleaseArtifact({
    runtimeRoot: runtime,
    output,
    version,
    commit,
    migrations: Array.from({ length: schemaVersion }, (_, index) => ({
      version: index + 1,
      name: `migration-${index + 1}`,
      checksum: digest(`migration-${index + 1}`),
    })),
    codexUpstreamCommit: 'f'.repeat(40),
    vendorManifestSha256: digest('vendor'),
  });
  await signReleaseArtifact({
    directory: output,
    keyId: 'fixture-primary',
    privateKeyBytes: Buffer.from(key.privateKey),
  });
  return { commit, id: releaseId(version, commit), root: output, schemaVersion };
}

async function writeTrustStore(filename, keyId, publicKey, storeVersion = 1) {
  await writeFile(filename, `${JSON.stringify({
    format: 'kodex-release-trust-store',
    formatVersion: 1,
    storeVersion,
    keys: [{ keyId, algorithm: 'Ed25519', status: 'trusted', publicKey }],
  }, null, 2)}\n`, 'utf8');
}

async function expectCode(action, code) {
  await assert.rejects(action, (error) => error instanceof WindowsInstallerError && error.code === code);
}

const root = await mkdtemp(path.join(os.tmpdir(), 'kodex-phase31-installer-'));
try {
  const pair = generateKeyPairSync('ed25519');
  const key = {
    privateKey: pair.privateKey.export({ format: 'pem', type: 'pkcs8' }),
    publicKey: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
  };
  const trustStorePath = path.join(root, 'trust', 'release-trust-store.json');
  await mkdir(path.dirname(trustStorePath), { recursive: true });
  await writeTrustStore(trustStorePath, 'fixture-primary', key.publicKey, 2);
  const installRoot = path.join(root, 'install');
  const aclAdapter = {
    async assertSafeTree(target) {
      const relative = path.relative(root, target);
      return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    },
  };
  const common = { aclAdapter, installRoot, layoutPath, trustStorePath };
  const first = await createSignedRelease(root, key, '0.2.0', 'a', 1);
  const second = await createSignedRelease(root, key, '0.3.0', 'b', 1);
  const forwardOnly = await createSignedRelease(root, key, '0.4.0', 'c', 2);

  const plan = await planWindowsInstallerUpdate({ ...common, candidate: first.root });
  assert.equal(plan.operation, 'install');
  assert.equal(plan.externalDataPreserved, true);
  const stagedFirst = await stageWindowsInstallerCandidate({ ...common, candidate: first.root });
  assert.equal(stagedFirst.alreadyStaged, false);
  const duplicateFirst = await stageWindowsInstallerCandidate({ ...common, candidate: first.root });
  assert.equal(duplicateFirst.alreadyStaged, true);
  const staleTrustStorePath = path.join(root, 'trust', 'stale.json');
  await writeTrustStore(staleTrustStorePath, 'fixture-primary', key.publicKey, 1);
  await expectCode(
    () => stageWindowsInstallerCandidate({ ...common, candidate: first.root, trustStorePath: staleTrustStorePath }),
    'trust_store_rollback_rejected',
  );
  await activateWindowsInstallerRelease({ ...common, releaseId: first.id });
  const duplicateActivation = await activateWindowsInstallerRelease({ ...common, releaseId: first.id });
  assert.equal(duplicateActivation.alreadyActive, true);
  await confirmWindowsInstallerRelease({ ...common, releaseId: first.id, databaseSchemaVersion: 1 });
  const duplicateConfirmation = await confirmWindowsInstallerRelease({ ...common, releaseId: first.id, databaseSchemaVersion: 1 });
  assert.equal(duplicateConfirmation.alreadyConfirmed, true);

  await stageWindowsInstallerCandidate({ ...common, candidate: second.root });
  const activation = await activateWindowsInstallerRelease({ ...common, releaseId: second.id });
  assert.equal(activation.automaticRollbackAllowed, true);
  const recovered = await recoverWindowsInstaller(common);
  assert.equal(recovered.result, 'rollback_completed');
  assert.equal(recovered.releaseId, first.id);

  await activateWindowsInstallerRelease({ ...common, releaseId: second.id });
  await confirmWindowsInstallerRelease({ ...common, releaseId: second.id, databaseSchemaVersion: 1 });
  const rollback = await rollbackWindowsInstallerRelease({ ...common, databaseSchemaVersion: 1 });
  assert.equal(rollback.releaseId, first.id);
  const duplicateRollback = await rollbackWindowsInstallerRelease({ ...common, databaseSchemaVersion: 1 });
  assert.equal(duplicateRollback.alreadyPending, true);
  await confirmWindowsInstallerRelease({ ...common, releaseId: first.id, databaseSchemaVersion: 1 });

  await stageWindowsInstallerCandidate({ ...common, candidate: forwardOnly.root });
  const unsafeActivation = await activateWindowsInstallerRelease({ ...common, releaseId: forwardOnly.id });
  assert.equal(unsafeActivation.automaticRollbackAllowed, false);
  await expectCode(() => recoverWindowsInstaller(common), 'operator_recovery_required');
  const unsafeStatus = await windowsInstallerStatus(common);
  assert.equal(unsafeStatus.operatorRecoveryRequired, true);

  await expectCode(
    () => holdWindowsInstallerLockForTest(common, () => stageWindowsInstallerCandidate({ ...common, candidate: first.root })),
    'installer_busy',
  );

  const tampered = await createSignedRelease(root, key, '0.5.0', 'd', 2);
  await writeFile(path.join(tampered.root, 'Kodex.exe'), 'tampered', 'utf8');
  await expectCode(
    () => stageWindowsInstallerCandidate({ ...common, candidate: tampered.root }),
    'release_authenticity_verification_failed',
  );

  const otherPair = generateKeyPairSync('ed25519');
  const unknownTrustStore = path.join(root, 'trust', 'unknown.json');
  await writeTrustStore(
    unknownTrustStore,
    'fixture-other',
    otherPair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
  );
  await expectCode(
    () => stageWindowsInstallerCandidate({ ...common, candidate: first.root, trustStorePath: unknownTrustStore }),
    'release_authenticity_verification_failed',
  );

  const linked = await createSignedRelease(root, key, '0.6.0', 'e', 2);
  const linkTarget = path.join(root, 'link-target');
  await mkdir(linkTarget);
  await writeFile(path.join(linkTarget, 'outside.txt'), 'outside', 'utf8');
  await symlink(linkTarget, path.join(linked.root, 'reparse-fixture'), process.platform === 'win32' ? 'junction' : 'dir');
  await expectCode(
    () => stageWindowsInstallerCandidate({ ...common, candidate: linked.root }),
    'release_authenticity_verification_failed',
  );

  const retentionInstallRoot = path.join(root, 'retention-install');
  const retentionCommon = { ...common, installRoot: retentionInstallRoot };
  const sentinel = path.join(root, 'must-survive.txt');
  await writeFile(sentinel, 'preserved', 'utf8');
  for (const [version, marker] of [['1.0.0', '1'], ['1.1.0', '2'], ['1.2.0', '3'], ['1.3.0', '4']]) {
    const candidate = await createSignedRelease(root, key, version, marker, 1);
    await stageWindowsInstallerCandidate({ ...retentionCommon, candidate: candidate.root });
  }
  const retentionStatus = await windowsInstallerStatus(retentionCommon);
  assert.equal(retentionStatus.releaseCount, 3);
  assert.equal(await readFile(sentinel, 'utf8'), 'preserved');

  process.stdout.write(`${JSON.stringify({
    kind: 'kodex_windows_installer_fixture_passed',
    duplicateStageChecked: true,
    interruptedRecoveryChecked: true,
    lockContentionChecked: true,
    forwardOnlyRollbackBlocked: true,
    exactRootRetentionChecked: true,
  })}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}
