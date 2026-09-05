import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createDatabaseRecoveryDrillPlan,
  DatabaseRecoveryError,
  databaseRecoveryPolicyValidationResult,
  databaseRecoveryReceiptSigningPayload,
  databaseRecoveryReceiptValidationResult,
  databaseRecoveryStatusResult,
  parseDatabaseRecoveryPolicy,
  parseDatabaseRecoveryReceipt,
  readDatabaseRecoveryPolicy,
  signDatabaseRecoveryReceipt,
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
const trustVersion = 7;
const keyId = 'recovery-fixture-key';

function clone(value) {
  return structuredClone(value);
}

function expectCode(action, code) {
  assert.throws(action, (error) => error instanceof DatabaseRecoveryError && error.code === code);
}

async function expectAsyncCode(action, code) {
  await assert.rejects(action, (error) => error instanceof DatabaseRecoveryError && error.code === code);
}

function unsignedReceipt(policy, overrides = {}) {
  return {
    format: 'kodex-database-recovery-drill-receipt',
    formatVersion: 1,
    performedAt: '2026-09-01T00:00:00.000Z',
    resultCode: 'passed',
    policyDigest: policy.policyDigest,
    artifactSignature: {
      algorithm: 'Ed25519',
      trustRef: sourcePolicy.rotation.artifactTrustRef,
      trustVersion,
      keyId,
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

function signedReceipt(policy, privateKeyBytes, overrides = {}) {
  return signDatabaseRecoveryReceipt(unsignedReceipt(policy, overrides), privateKeyBytes);
}

async function writeTrustStore(filename, options) {
  await writeFile(filename, `${JSON.stringify({
    format: 'kodex-release-trust-store',
    formatVersion: 1,
    storeVersion: options.storeVersion,
    keys: [{
      keyId: options.keyId,
      algorithm: 'Ed25519',
      status: options.status,
      publicKey: options.publicKey,
    }],
  }, null, 2)}\n`, 'utf8');
}

const primaryKeys = generateKeyPairSync('ed25519');
const alternateKeys = generateKeyPairSync('ed25519');
const primaryPrivateKey = Buffer.from(primaryKeys.privateKey.export({ format: 'pem', type: 'pkcs8' }));
const alternatePrivateKey = Buffer.from(alternateKeys.privateKey.export({ format: 'pem', type: 'pkcs8' }));
const primaryPublicKey = Buffer.from(primaryKeys.publicKey.export({ format: 'der', type: 'spki' })).toString('base64');
const alternatePublicKey = Buffer.from(alternateKeys.publicKey.export({ format: 'der', type: 'spki' })).toString('base64');
const root = await mkdtemp(path.join(os.tmpdir(), 'kodex-database-recovery-'));

try {
  const trustStorePath = path.join(root, 'trust-store.json');
  const revokedTrustStorePath = path.join(root, 'revoked-trust-store.json');
  const unknownTrustStorePath = path.join(root, 'unknown-trust-store.json');
  await writeTrustStore(trustStorePath, {
    keyId, publicKey: primaryPublicKey, status: 'trusted', storeVersion: trustVersion,
  });
  await writeTrustStore(revokedTrustStorePath, {
    keyId, publicKey: primaryPublicKey, status: 'revoked', storeVersion: trustVersion,
  });
  await writeTrustStore(unknownTrustStorePath, {
    keyId: 'other-recovery-key', publicKey: alternatePublicKey, status: 'trusted', storeVersion: trustVersion,
  });

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

  const signed = signedReceipt(parsedPolicy, primaryPrivateKey);
  assert.equal(Object.hasOwn(signed.artifactSignature, 'verified'), false);
  assert.match(signed.artifactSignature.signature, /^[A-Za-z0-9+/]{86}==$/u);
  const signingPayloadA = databaseRecoveryReceiptSigningPayload(signed);
  const signingPayloadB = databaseRecoveryReceiptSigningPayload(clone(signed));
  assert.equal(signingPayloadA.equals(signingPayloadB), true);
  assert.equal(signingPayloadA.includes(Buffer.from(signed.artifactSignature.signature)), false);
  const changedUnsigned = unsignedReceipt(parsedPolicy);
  changedUnsigned.objectives.observedRecoveryTimeMinutes += 1;
  assert.equal(signingPayloadA.equals(databaseRecoveryReceiptSigningPayload(changedUnsigned)), false);

  const receipt = parseDatabaseRecoveryReceipt(signed);
  const validation = await validateDatabaseRecoveryReceipt(
    parsedPolicy, receipt, '2026-09-05T00:00:00.000Z', trustStorePath,
  );
  assert.equal(validation.evidenceAgeBucket, '1-6d');
  assert.deepEqual(Object.keys(databaseRecoveryReceiptValidationResult(parsedPolicy, validation)).sort(), [
    'code', 'evidenceAgeBucket', 'formatVersion', 'kind', 'ok', 'policyDigest', 'readiness',
  ]);
  assert.deepEqual(Object.keys(databaseRecoveryStatusResult(parsedPolicy, validation)).sort(), [
    'code', 'evidenceAgeBucket', 'formatVersion', 'kind', 'ok', 'policyDigest', 'profile',
    'promotionEligible', 'readiness',
  ]);

  const forgedBoolean = unsignedReceipt(parsedPolicy);
  forgedBoolean.artifactSignature.verified = true;
  expectCode(() => parseDatabaseRecoveryReceipt(forgedBoolean), 'receipt_contract_invalid');
  const malformedSignature = clone(signed);
  malformedSignature.artifactSignature.signature = 'A'.repeat(88);
  expectCode(() => parseDatabaseRecoveryReceipt(malformedSignature), 'receipt_contract_invalid');

  const tamperedReceipts = [
    (() => { const value = clone(signed); value.performedAt = '2026-09-02T00:00:00.000Z'; return value; })(),
    (() => { const value = clone(signed); value.objectives.observedRecoveryTimeMinutes += 1; return value; })(),
    (() => { const value = clone(signed); value.protections.snapshotVerified = false; return value; })(),
    (() => { const value = clone(signed); value.policyDigest = '0'.repeat(64); return value; })(),
  ];
  for (const tampered of tamperedReceipts) {
    await expectAsyncCode(() => validateDatabaseRecoveryReceipt(
      parsedPolicy,
      parseDatabaseRecoveryReceipt(tampered),
      '2026-09-05T00:00:00.000Z',
      trustStorePath,
    ), 'receipt_signature_invalid');
  }

  await expectAsyncCode(() => validateDatabaseRecoveryReceipt(
    parsedPolicy,
    parseDatabaseRecoveryReceipt(signedReceipt(parsedPolicy, primaryPrivateKey, { resultCode: 'failed' })),
    '2026-09-05T00:00:00.000Z',
    trustStorePath,
  ), 'receipt_failed');
  await expectAsyncCode(() => validateDatabaseRecoveryReceipt(
    parsedPolicy, receipt, '2026-10-10T00:00:00.001Z', trustStorePath,
  ), 'receipt_stale');
  await expectAsyncCode(() => validateDatabaseRecoveryReceipt(
    parsedPolicy,
    parseDatabaseRecoveryReceipt(signedReceipt(parsedPolicy, primaryPrivateKey, { policyDigest: '0'.repeat(64) })),
    '2026-09-05T00:00:00.000Z',
    trustStorePath,
  ), 'receipt_policy_mismatch');
  await expectAsyncCode(() => validateDatabaseRecoveryReceipt(
    parsedPolicy,
    parseDatabaseRecoveryReceipt(signedReceipt(parsedPolicy, primaryPrivateKey, {
      protections: { ...unsignedReceipt(parsedPolicy).protections, legalHoldPropagationVerified: false },
    })),
    '2026-09-05T00:00:00.000Z',
    trustStorePath,
  ), 'receipt_protection_failed');
  await expectAsyncCode(() => validateDatabaseRecoveryReceipt(
    parsedPolicy,
    parseDatabaseRecoveryReceipt(signedReceipt(parsedPolicy, primaryPrivateKey, {
      objectives: { ...unsignedReceipt(parsedPolicy).objectives, rpoMet: false },
    })),
    '2026-09-05T00:00:00.000Z',
    trustStorePath,
  ), 'receipt_objectives_missed');

  await expectAsyncCode(() => validateDatabaseRecoveryReceipt(
    parsedPolicy, receipt, '2026-09-05T00:00:00.000Z', unknownTrustStorePath,
  ), 'receipt_key_untrusted');
  await expectAsyncCode(() => validateDatabaseRecoveryReceipt(
    parsedPolicy, receipt, '2026-09-05T00:00:00.000Z', revokedTrustStorePath,
  ), 'receipt_key_revoked');
  await expectAsyncCode(() => validateDatabaseRecoveryReceipt(
    parsedPolicy,
    parseDatabaseRecoveryReceipt(signedReceipt(parsedPolicy, alternatePrivateKey)),
    '2026-09-05T00:00:00.000Z',
    trustStorePath,
  ), 'receipt_signature_invalid');
  await expectAsyncCode(() => validateDatabaseRecoveryReceipt(
    parsedPolicy, receipt, '2026-09-05T00:00:00.000Z', path.join(root, 'missing-trust-store.json'),
  ), 'receipt_trust_store_invalid');

  const oldVersionUnsigned = unsignedReceipt(parsedPolicy);
  oldVersionUnsigned.artifactSignature.trustVersion = trustVersion - 1;
  await expectAsyncCode(() => validateDatabaseRecoveryReceipt(
    parsedPolicy,
    parseDatabaseRecoveryReceipt(signDatabaseRecoveryReceipt(oldVersionUnsigned, primaryPrivateKey)),
    '2026-09-05T00:00:00.000Z',
    trustStorePath,
  ), 'receipt_trust_version_mismatch');
  const strongerPolicyValue = clone(sourcePolicy);
  strongerPolicyValue.restoreDrill.trustVersionMinimum = trustVersion + 1;
  const strongerPolicy = parseDatabaseRecoveryPolicy(strongerPolicyValue);
  await expectAsyncCode(() => validateDatabaseRecoveryReceipt(
    strongerPolicy,
    parseDatabaseRecoveryReceipt(signedReceipt(strongerPolicy, primaryPrivateKey)),
    '2026-09-05T00:00:00.000Z',
    trustStorePath,
  ), 'receipt_trust_version_mismatch');
  const otherTrustUnsigned = unsignedReceipt(parsedPolicy);
  otherTrustUnsigned.artifactSignature.trustRef = 'trustref:other-recovery-evidence-v1';
  await expectAsyncCode(() => validateDatabaseRecoveryReceipt(
    parsedPolicy,
    parseDatabaseRecoveryReceipt(signDatabaseRecoveryReceipt(otherTrustUnsigned, primaryPrivateKey)),
    '2026-09-05T00:00:00.000Z',
    trustStorePath,
  ), 'receipt_trust_reference_mismatch');

  const identifyingReceipt = clone(signed);
  identifyingReceipt.tenantId = '11111111-1111-4111-8111-111111111111';
  expectCode(() => parseDatabaseRecoveryReceipt(identifyingReceipt), 'receipt_contract_invalid');
  const tokenReceipt = clone(signed);
  tokenReceipt.artifactSignature.token = 'secret-token-value';
  expectCode(() => parseDatabaseRecoveryReceipt(tokenReceipt), 'receipt_contract_invalid');

  const policyFile = path.join(root, 'policy.json');
  const receiptFile = path.join(root, 'receipt.json');
  await writeFile(policyFile, `${JSON.stringify(sourcePolicy, null, 2)}\n`, 'utf8');
  await writeFile(receiptFile, `${JSON.stringify(signed, null, 2)}\n`, 'utf8');
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
    assert.equal(
      JSON.stringify(await runDatabaseRecoveryCommand(cliArguments)),
      JSON.stringify(await runDatabaseRecoveryCommand(cliArguments)),
    );
  } else {
    assert.equal(first.status, 0);
    assert.equal(first.stdout, second.stdout);
    assert.equal(first.stderr, '');
  }

  const statusArguments = [
    'status', '--policy', policyFile, '--receipt', receiptFile, '--trust-store', trustStorePath,
    '--at', '2026-09-05T00:00:00.000Z',
  ];
  const status = spawnSync(process.execPath, [cliPath, ...statusArguments], { encoding: 'utf8', windowsHide: true });
  if (status.error?.code === 'EPERM') {
    assert.equal((await runDatabaseRecoveryCommand(statusArguments)).readiness, 'ready');
  } else {
    assert.equal(status.status, 0);
    assert.equal(JSON.parse(status.stdout).readiness, 'ready');
  }
  const safeStatusOutput = JSON.stringify(await runDatabaseRecoveryCommand(statusArguments));
  assert.equal(/keyId|signature|trustStore|recovery-fixture-key/iu.test(safeStatusOutput), false);
  await expectAsyncCode(() => runDatabaseRecoveryCommand([
    'status', '--policy', policyFile, '--receipt', receiptFile, '--at', '2026-09-05T00:00:00.000Z',
  ]), 'invalid_arguments');
  await expectAsyncCode(() => runDatabaseRecoveryCommand([
    'status', '--policy', policyFile, '--receipt', receiptFile, '--trust-store', 'relative-store.json',
    '--at', '2026-09-05T00:00:00.000Z',
  ]), 'invalid_arguments');

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
    fixtureCount: 51,
    formatVersion: 1,
    kind: 'kodex_database_recovery_fixture',
    ok: true,
  })}\n`);
} finally {
  primaryPrivateKey.fill(0);
  alternatePrivateKey.fill(0);
  await rm(root, { force: true, recursive: true });
}
