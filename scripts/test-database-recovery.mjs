import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createDatabaseRecoveryDrillPlan,
  DatabaseRecoveryError,
  databaseRecoveryPolicyValidationResult,
  databaseRecoveryReceiptValidationResult,
  databaseRecoveryStatusResult,
  parseDatabaseRecoveryPolicy,
  parseDatabaseRecoveryReceipt,
  readDatabaseRecoveryPolicy,
  validateDatabaseRecoveryReceipt,
} from './lib/database-recovery.mjs';
import {
  databaseRecoveryErrorOutput,
  runDatabaseRecoveryCommand,
} from './kodex-database-recovery.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(repositoryRoot, 'scripts', 'kodex-database-recovery.mjs');
const sourcePolicy = JSON.parse(await readFile(
  path.join(repositoryRoot, 'config', 'database-recovery-policy.json'),
  'utf8',
));

function clone(value) {
  return structuredClone(value);
}

function expectCode(action, code) {
  assert.throws(action, (error) => error instanceof DatabaseRecoveryError && error.code === code);
}

async function expectAsyncCode(action, code) {
  await assert.rejects(action, (error) => error instanceof DatabaseRecoveryError && error.code === code);
}

function validReceipt(policy, overrides = {}) {
  return {
    format: 'kodex-database-recovery-drill-receipt',
    formatVersion: 1,
    performedAt: '2026-09-01T00:00:00.000Z',
    resultCode: 'passed',
    policyDigest: policy.policyDigest,
    artifactSignature: {
      algorithm: 'Ed25519',
      trustRef: sourcePolicy.rotation.artifactTrustRef,
      trustVersion: 1,
      verified: true,
    },
    objectives: {
      rpoMet: true,
      rtoMet: true,
      observedRecoveryPointAgeMinutes: 10,
      observedRecoveryTimeMinutes: 45,
    },
    protections: {
      walArchiveVerified: true,
      baseBackupVerified: true,
      replicaVerified: true,
      snapshotVerified: true,
      legalHoldPropagationVerified: true,
      physicalDeletionBoundVerified: true,
    },
    ...overrides,
  };
}

const root = await mkdtemp(path.join(os.tmpdir(), 'kodex-database-recovery-'));
try {
  const parsedPolicy = parseDatabaseRecoveryPolicy(sourcePolicy);
  assert.equal(parsedPolicy.promotionEligible, true);
  assert.match(parsedPolicy.policyDigest, /^[a-f0-9]{64}$/u);
  assert.deepEqual(Object.keys(databaseRecoveryPolicyValidationResult(parsedPolicy)).sort(), [
    'code', 'formatVersion', 'kind', 'ok', 'policyDigest', 'profile', 'promotionEligible',
  ]);

  const deterministicA = databaseRecoveryPolicyValidationResult(parseDatabaseRecoveryPolicy(clone(sourcePolicy)));
  const deterministicB = databaseRecoveryPolicyValidationResult(parseDatabaseRecoveryPolicy(clone(sourcePolicy)));
  assert.equal(JSON.stringify(deterministicA), JSON.stringify(deterministicB));

  const nonProduction = clone(sourcePolicy);
  nonProduction.profile = 'acceptance';
  nonProduction.walArchive.enabled = false;
  nonProduction.replica.enabled = false;
  nonProduction.snapshots.enabled = false;
  const parsedNonProduction = parseDatabaseRecoveryPolicy(nonProduction);
  assert.equal(parsedNonProduction.promotionEligible, false);
  assert.equal(databaseRecoveryPolicyValidationResult(parsedNonProduction).code, 'policy_valid_nonproduction');
  expectCode(() => createDatabaseRecoveryDrillPlan(parsedNonProduction), 'policy_profile_not_promotable');

  const weakMutations = [
    (policy) => { policy.walArchive.enabled = false; },
    (policy) => { policy.transport.tlsMode = 'verify-ca'; },
    (policy) => { policy.isolation.failureDomainCount = 1; },
    (policy) => { policy.snapshots.deletionProtectionEnabled = false; },
    (policy) => { policy.legalHold.propagationEnabled = false; },
  ];
  for (const mutate of weakMutations) {
    const policy = clone(sourcePolicy);
    mutate(policy);
    expectCode(() => parseDatabaseRecoveryPolicy(policy), 'policy_weak');
  }

  const inconsistentMutations = [
    (policy) => { policy.walArchive.retentionHours = policy.objectives.pitrWindowHours - 1; },
    (policy) => { policy.walArchive.archiveMaximumDelayMinutes = policy.objectives.rpoMinutes + 1; },
    (policy) => { policy.replica.promotionTargetMinutes = policy.objectives.rtoMinutes + 1; },
    (policy) => { policy.physicalDeletion.maximumResidualDays = policy.baseBackup.retentionDays - 1; },
  ];
  for (const mutate of inconsistentMutations) {
    const policy = clone(sourcePolicy);
    mutate(policy);
    expectCode(() => parseDatabaseRecoveryPolicy(policy), 'policy_inconsistent');
  }

  const extraKey = clone(sourcePolicy);
  extraKey.databaseUrl = 'forbidden';
  expectCode(() => parseDatabaseRecoveryPolicy(extraKey), 'policy_contract_invalid');
  const inlineReference = clone(sourcePolicy);
  inlineReference.responsibility.providerAttestationRef = 'https://db.example/recovery?token=secret-value';
  expectCode(() => parseDatabaseRecoveryPolicy(inlineReference), 'policy_reference_invalid');
  const pathReference = clone(sourcePolicy);
  pathReference.rotation.encryptionKeyRef = 'C:\\recovery\\key.txt';
  expectCode(() => parseDatabaseRecoveryPolicy(pathReference), 'policy_reference_invalid');

  const receipt = parseDatabaseRecoveryReceipt(validReceipt(parsedPolicy));
  const validation = validateDatabaseRecoveryReceipt(parsedPolicy, receipt, '2026-09-05T00:00:00.000Z');
  assert.equal(validation.evidenceAgeBucket, '1-6d');
  assert.deepEqual(Object.keys(databaseRecoveryReceiptValidationResult(parsedPolicy, validation)).sort(), [
    'code', 'evidenceAgeBucket', 'formatVersion', 'kind', 'ok', 'policyDigest', 'readiness',
  ]);
  assert.deepEqual(Object.keys(databaseRecoveryStatusResult(parsedPolicy, validation)).sort(), [
    'code', 'evidenceAgeBucket', 'formatVersion', 'kind', 'ok', 'policyDigest', 'profile',
    'promotionEligible', 'readiness',
  ]);

  expectCode(() => validateDatabaseRecoveryReceipt(
    parsedPolicy,
    parseDatabaseRecoveryReceipt(validReceipt(parsedPolicy, { resultCode: 'failed' })),
    '2026-09-05T00:00:00.000Z',
  ), 'receipt_failed');
  expectCode(() => validateDatabaseRecoveryReceipt(
    parsedPolicy,
    parseDatabaseRecoveryReceipt(validReceipt(parsedPolicy)),
    '2026-10-10T00:00:00.001Z',
  ), 'receipt_stale');
  expectCode(() => validateDatabaseRecoveryReceipt(
    parsedPolicy,
    parseDatabaseRecoveryReceipt(validReceipt(parsedPolicy, { policyDigest: '0'.repeat(64) })),
    '2026-09-05T00:00:00.000Z',
  ), 'receipt_policy_mismatch');
  expectCode(() => validateDatabaseRecoveryReceipt(
    parsedPolicy,
    parseDatabaseRecoveryReceipt(validReceipt(parsedPolicy, {
      artifactSignature: { algorithm: 'Ed25519', trustRef: sourcePolicy.rotation.artifactTrustRef, trustVersion: 1, verified: false },
    })),
    '2026-09-05T00:00:00.000Z',
  ), 'receipt_trust_rejected');
  expectCode(() => validateDatabaseRecoveryReceipt(
    parsedPolicy,
    parseDatabaseRecoveryReceipt(validReceipt(parsedPolicy, {
      protections: {
        ...validReceipt(parsedPolicy).protections,
        legalHoldPropagationVerified: false,
      },
    })),
    '2026-09-05T00:00:00.000Z',
  ), 'receipt_protection_failed');

  const identifyingReceipt = validReceipt(parsedPolicy);
  identifyingReceipt.tenantId = '11111111-1111-4111-8111-111111111111';
  expectCode(() => parseDatabaseRecoveryReceipt(identifyingReceipt), 'receipt_contract_invalid');
  const tokenReceipt = validReceipt(parsedPolicy);
  tokenReceipt.artifactSignature.token = 'secret-token-value';
  expectCode(() => parseDatabaseRecoveryReceipt(tokenReceipt), 'receipt_contract_invalid');

  const policyFile = path.join(root, 'policy.json');
  const receiptFile = path.join(root, 'receipt.json');
  await writeFile(policyFile, `${JSON.stringify(sourcePolicy, null, 2)}\n`, 'utf8');
  await writeFile(receiptFile, `${JSON.stringify(validReceipt(parsedPolicy), null, 2)}\n`, 'utf8');
  await expectAsyncCode(() => readDatabaseRecoveryPolicy(path.join(root, 'missing.json')), 'policy_input_invalid');
  const oversized = path.join(root, 'oversized.json');
  await writeFile(oversized, ' '.repeat(65 * 1024), 'utf8');
  await expectAsyncCode(() => readDatabaseRecoveryPolicy(oversized), 'policy_input_invalid');
  const specialDirectory = path.join(root, 'special-directory');
  await mkdir(specialDirectory);
  await expectAsyncCode(() => readDatabaseRecoveryPolicy(specialDirectory), 'policy_input_invalid');

  const linkPath = path.join(root, 'policy-link.json');
  try {
    await symlink(policyFile, linkPath, 'file');
  } catch (error) {
    if (error?.code !== 'EPERM') throw error;
    const linkTarget = path.join(root, 'link-target');
    await mkdir(linkTarget);
    await symlink(linkTarget, linkPath, 'junction');
  }
  await expectAsyncCode(() => readDatabaseRecoveryPolicy(linkPath), 'policy_input_invalid');

  const cliArguments = ['validate', '--policy', policyFile];
  const first = spawnSync(process.execPath, [cliPath, ...cliArguments], { encoding: 'utf8', windowsHide: true });
  const second = spawnSync(process.execPath, [cliPath, ...cliArguments], { encoding: 'utf8', windowsHide: true });
  if (first.error?.code === 'EPERM' && second.error?.code === 'EPERM') {
    const directFirst = await runDatabaseRecoveryCommand(cliArguments);
    const directSecond = await runDatabaseRecoveryCommand(cliArguments);
    assert.equal(JSON.stringify(directFirst), JSON.stringify(directSecond));
  } else {
    assert.equal(first.status, 0);
    assert.equal(first.stdout, second.stdout);
    assert.equal(first.stderr, '');
  }

  const statusArguments = [
    'status', '--policy', policyFile, '--receipt', receiptFile, '--at', '2026-09-05T00:00:00.000Z',
  ];
  const status = spawnSync(process.execPath, [cliPath, ...statusArguments], { encoding: 'utf8', windowsHide: true });
  if (status.error?.code === 'EPERM') {
    assert.equal((await runDatabaseRecoveryCommand(statusArguments)).readiness, 'ready');
  } else {
    assert.equal(status.status, 0);
    assert.equal(JSON.parse(status.stdout).readiness, 'ready');
  }

  const secretValue = 'secret-token-value-should-never-appear';
  const unsafe = clone(sourcePolicy);
  unsafe.responsibility.providerAttestationRef = `https://db.example/recovery?token=${secretValue}`;
  const unsafeFile = path.join(root, 'unsafe-policy.json');
  await writeFile(unsafeFile, `${JSON.stringify(unsafe)}\n`, 'utf8');
  const rejected = spawnSync(process.execPath, [cliPath, 'validate', '--policy', unsafeFile], {
    encoding: 'utf8', windowsHide: true,
  });
  let rejectedOutput;
  if (rejected.error?.code === 'EPERM') {
    try {
      await runDatabaseRecoveryCommand(['validate', '--policy', unsafeFile]);
      assert.fail('Expected unsafe policy rejection');
    } catch (error) {
      rejectedOutput = JSON.stringify(databaseRecoveryErrorOutput(error));
    }
  } else {
    assert.equal(rejected.status, 1);
    assert.equal(rejected.stdout, '');
    rejectedOutput = rejected.stderr;
  }
  assert.deepEqual(Object.keys(JSON.parse(rejectedOutput)).sort(), ['code', 'kind', 'ok']);
  assert.equal(rejectedOutput.includes(secretValue), false);
  assert.equal(rejectedOutput.includes('https://'), false);
  assert.equal(rejectedOutput.includes(unsafeFile), false);

  process.stdout.write(`${JSON.stringify({
    code: 'database_recovery_fixture_passed',
    fixtureCount: 33,
    formatVersion: 1,
    kind: 'kodex_database_recovery_fixture',
    ok: true,
  })}\n`);
} finally {
  await rm(root, { force: true, recursive: true });
}
