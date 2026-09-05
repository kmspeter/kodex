import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLongRunReceipt } from './lib/long-run-acceptance.mjs';
import {
  canonicalReleaseAcceptanceJson,
  evaluateReleaseReadiness,
  parseReleaseAcceptanceEvidence,
  readReleaseAcceptanceCatalog,
  ReleaseAcceptanceError,
  signReleaseAcceptanceEvidence,
} from './lib/release-acceptance.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = await mkdtemp(path.join(os.tmpdir(), 'kodex-release-acceptance-fixture-'));
const catalog = await readReleaseAcceptanceCatalog(path.join(repositoryRoot, 'config', 'release-acceptance-catalog.json'));
const fixtureLedger = Array.from({ length: 13 }, (_value, index) => ({
  version: index + 1,
  name: `fixture_${index + 1}`,
  checksum: String(index + 1).padStart(64, '0'),
}));
const stableValue = (value) => Array.isArray(value)
  ? value.map(stableValue)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]))
    : value;
const hashes = {
  catalogDigest: catalog.catalogDigest,
  migrationLedgerDigest: createHash('sha256').update(`${JSON.stringify(stableValue(fixtureLedger), null, 2)}\n`).digest('hex'),
  policyDigest: 'b'.repeat(64),
  vendorManifestSha256: 'c'.repeat(64),
};
const repositoryIdentity = {
  codexUpstreamCommit: 'd'.repeat(40),
  commit: 'e'.repeat(40),
  dirty: false,
  migrationLedger: fixtureLedger,
  migrationLedgerDigest: hashes.migrationLedgerDigest,
  policyDigest: hashes.policyDigest,
  vendorManifestSha256: hashes.vendorManifestSha256,
  version: '0.2.0',
};

const soakReceipt = {
  format: 'kodex-long-run-acceptance-receipt',
  formatVersion: 1,
  runId: '77777777-7777-4777-8777-777777777777',
  planDigest: '6'.repeat(64),
  scenarioId: 'full-system-soak',
  startedAt: '2026-09-01T00:00:00.000Z',
  completedAt: '2026-09-01T12:00:00.000Z',
  resultCode: 'completed',
  iterationsCompleted: 10,
  stepsCompleted: 130,
  counters: { passedSteps: 130, failedAttempts: 0, retries: 0, duplicateResults: 0 },
  metrics: {
    sampleCount: 130,
    processSampleCount: 0,
    operationalSampleCount: 130,
    fixtureSampleCount: 0,
    ...Object.fromEntries([
      'heapBytes', 'handleCount', 'socketCount', 'databasePoolCount', 'outboxItemCount',
      'leaseCount', 'temporaryBytes', 'diskBytes',
    ].map((name) => [name, { observedSampleCount: 130, baseline: 1, peak: 2, last: 1 }])),
  },
  recoveryEvidence: {
    reconnect: { requiredActions: 10, observedActions: 10, recoveryCount: 10 },
    restart: { requiredActions: 30, observedActions: 30, recoveryCount: 30 },
  },
};
const soakReceiptDigest = parseLongRunReceipt(soakReceipt).receiptDigest;

function artifactFor(requirement) {
  const common = {
    manifestDigest: '1'.repeat(64),
    signatureDigest: '2'.repeat(64),
    signatureKeyId: 'fixture-key',
    trustStoreVersion: 7,
  };
  if (requirement.category === 'backup-restore') return { kind: 'offline-backup', ...common };
  if (['build', 'signing'].includes(requirement.category)) return { kind: 'release-bundle', ...common };
  if (requirement.category === 'installer') return { kind: 'windows-installer', ...common };
  if (requirement.category === 'provider-drill') return { kind: 'database-recovery-receipt', ...common };
  if (requirement.category === 'long-run-soak') {
    return {
      kind: 'long-run-receipt',
      manifestDigest: soakReceiptDigest,
      signatureDigest: null,
      signatureKeyId: null,
      trustStoreVersion: null,
    };
  }
  return null;
}

function unsignedEvidence(requirement, overrides = {}) {
  return {
    format: 'kodex-release-acceptance-evidence',
    formatVersion: 1,
    requirementId: requirement.id,
    commandId: requirement.commandIds[0],
    evidenceType: requirement.evidenceTypes[0],
    resultCode: 'passed',
    startedAt: '2026-09-05T00:00:00.000Z',
    completedAt: '2026-09-05T00:01:00.000Z',
    release: {
      catalogDigest: hashes.catalogDigest,
      codexUpstreamCommit: repositoryIdentity.codexUpstreamCommit,
      commit: repositoryIdentity.commit,
      migrationLedgerDigest: hashes.migrationLedgerDigest,
      policyDigest: hashes.policyDigest,
      vendorManifestSha256: hashes.vendorManifestSha256,
      version: repositoryIdentity.version,
    },
    testCounts: { failed: 0, passed: 1, skipped: 0, total: 1 },
    artifactEvidence: artifactFor(requirement),
    attestation: {
      algorithm: 'Ed25519',
      keyId: 'fixture-key',
      trustRef: catalog.catalog.trust.reference,
      trustVersion: 7,
    },
    ...overrides,
  };
}

async function writeTrustStore(filename, publicKey, status = 'trusted') {
  await writeFile(filename, `${JSON.stringify({
    format: 'kodex-release-trust-store',
    formatVersion: 1,
    storeVersion: 7,
    keys: [{ keyId: 'fixture-key', algorithm: 'Ed25519', status, publicKey }],
  }, null, 2)}\n`, 'utf8');
}

try {
  const keys = generateKeyPairSync('ed25519');
  const privateKey = Buffer.from(keys.privateKey.export({ format: 'pem', type: 'pkcs8' }));
  const publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const trustStorePath = path.join(root, 'trust-store.json');
  await writeTrustStore(trustStorePath, publicKey);
  const receipts = [...catalog.requirements.values()].map((requirement) => (
    parseReleaseAcceptanceEvidence(signReleaseAcceptanceEvidence(unsignedEvidence(requirement), privateKey))
  ));
  const deterministic = signReleaseAcceptanceEvidence(unsignedEvidence(catalog.requirements.get('REL-001')), privateKey);
  assert.equal(
    canonicalReleaseAcceptanceJson(deterministic),
    canonicalReleaseAcceptanceJson(signReleaseAcceptanceEvidence(unsignedEvidence(catalog.requirements.get('REL-001')), privateKey)),
  );

  const sourceEvidence = {
    releaseArtifact: {
      keyId: 'fixture-key', manifestSha256: '1'.repeat(64), signatureDigest: '2'.repeat(64), trustStoreVersion: 7,
    },
    installer: {
      activeReleaseId: `Kodex-${repositoryIdentity.version}-windows-x64-${repositoryIdentity.commit.slice(0, 12)}`,
      confirmedReleaseId: `Kodex-${repositoryIdentity.version}-windows-x64-${repositoryIdentity.commit.slice(0, 12)}`,
      expectedReleaseId: `Kodex-${repositoryIdentity.version}-windows-x64-${repositoryIdentity.commit.slice(0, 12)}`,
      transactionPhase: null,
      operatorRecoveryRequired: false,
      stagingCount: 0,
      installerTrustStoreVersion: 7,
      keyId: 'fixture-key',
      manifestSha256: '1'.repeat(64),
      releaseTrustStoreVersion: 7,
      signatureDigest: '2'.repeat(64),
    },
    providerRecovery: {
      keyId: 'fixture-key', receiptDigest: '1'.repeat(64), signatureDigest: '2'.repeat(64), trustStoreVersion: 7,
    },
    soak: {
      receiptDigest: soakReceiptDigest,
      receipt: soakReceipt,
    },
  };
  const common = {
    catalog,
    evaluatedAt: '2026-09-05T01:00:00.000Z',
    repositoryIdentity,
    sourceEvidence,
    trustStorePath,
  };
  const ready = await evaluateReleaseReadiness({ ...common, evidenceReceipts: receipts });
  assert.equal(ready.code, 'release_ready');
  assert.equal(ready.evidenceReceiptCount, 18);

  const missing = await evaluateReleaseReadiness({ ...common, evidenceReceipts: [] });
  assert.equal(missing.code, 'release_evidence_pending');
  assert.equal(missing.pendingRequirementCount, 18);
  assert(missing.pendingCategories.includes('build'));
  assert(missing.pendingCategories.includes('electron'));
  assert(missing.pendingCategories.includes('postgresql'));
  assert(missing.pendingCategories.includes('provider-drill'));
  assert(missing.pendingCategories.includes('long-run-soak'));

  const dirty = await evaluateReleaseReadiness({
    ...common, evidenceReceipts: receipts, repositoryIdentity: { ...repositoryIdentity, dirty: true },
  });
  assert.equal(dirty.code, 'repository_dirty');

  const target = catalog.requirements.get('REL-001');
  const replaceFirst = (value) => [parseReleaseAcceptanceEvidence(signReleaseAcceptanceEvidence(value, privateKey)), ...receipts.slice(1)];
  const stale = await evaluateReleaseReadiness({
    ...common,
    evidenceReceipts: replaceFirst(unsignedEvidence(target, {
      startedAt: '2026-09-01T00:00:00.000Z',
      completedAt: '2026-09-01T00:01:00.000Z',
    })),
  });
  assert.equal(stale.code, 'evidence_stale');
  const failed = await evaluateReleaseReadiness({
    ...common,
    evidenceReceipts: replaceFirst(unsignedEvidence(target, {
      resultCode: 'failed', testCounts: { failed: 1, passed: 0, skipped: 0, total: 1 },
    })),
  });
  assert.equal(failed.code, 'evidence_failed');
  const mismatched = unsignedEvidence(target);
  mismatched.release = { ...mismatched.release, commit: 'f'.repeat(40) };
  assert.equal((await evaluateReleaseReadiness({
    ...common, evidenceReceipts: replaceFirst(mismatched),
  })).code, 'evidence_mismatch');

  assert.throws(() => parseReleaseAcceptanceEvidence(unsignedEvidence(target)), (error) => (
    error instanceof ReleaseAcceptanceError && error.code === 'evidence_unsigned'
  ));
  const tampered = structuredClone(receipts[0]);
  tampered.evidence.attestation.signature = tampered.evidence.attestation.signature.replace(/^./u, (value) => value === 'A' ? 'B' : 'A');
  assert.equal((await evaluateReleaseReadiness({
    ...common, evidenceReceipts: [tampered, ...receipts.slice(1)],
  })).code, 'evidence_signature_invalid');

  const alternateKeys = generateKeyPairSync('ed25519');
  const alternatePrivate = Buffer.from(alternateKeys.privateKey.export({ format: 'pem', type: 'pkcs8' }));
  const unknown = unsignedEvidence(target);
  unknown.attestation = { ...unknown.attestation, keyId: 'unknown-key' };
  assert.equal((await evaluateReleaseReadiness({
    ...common,
    evidenceReceipts: [
      parseReleaseAcceptanceEvidence(signReleaseAcceptanceEvidence(unknown, alternatePrivate)),
      ...receipts.slice(1),
    ],
  })).code, 'evidence_key_unknown');
  await writeTrustStore(trustStorePath, publicKey, 'revoked');
  assert.equal((await evaluateReleaseReadiness({ ...common, evidenceReceipts: receipts })).code, 'evidence_key_revoked');
  await writeTrustStore(trustStorePath, publicKey);

  const noSource = await evaluateReleaseReadiness({ ...common, evidenceReceipts: receipts, sourceEvidence: {} });
  assert.equal(noSource.code, 'evidence_source_unverified');

  const longRunRequirement = catalog.requirements.get('REL-018');
  const expectSoakSourceRejected = async (receipt) => {
    const parsed = parseLongRunReceipt(receipt);
    const replacement = parseReleaseAcceptanceEvidence(signReleaseAcceptanceEvidence(unsignedEvidence(
      longRunRequirement,
      { artifactEvidence: { ...artifactFor(longRunRequirement), manifestDigest: parsed.receiptDigest } },
    ), privateKey));
    const evidenceReceipts = receipts.map((entry) => (
      entry.evidence.requirementId === longRunRequirement.id ? replacement : entry
    ));
    const result = await evaluateReleaseReadiness({
      ...common,
      evidenceReceipts,
      sourceEvidence: { ...sourceEvidence, soak: parsed },
    });
    assert.equal(result.code, 'evidence_source_unverified');
  };
  const incompleteMetrics = structuredClone(soakReceipt);
  incompleteMetrics.metrics.databasePoolCount = {
    observedSampleCount: 129,
    baseline: 1,
    peak: 2,
    last: 1,
  };
  await expectSoakSourceRejected(incompleteMetrics);
  const incompleteRecovery = structuredClone(soakReceipt);
  incompleteRecovery.recoveryEvidence.reconnect = {
    requiredActions: 10,
    observedActions: 9,
    recoveryCount: 9,
  };
  await expectSoakSourceRejected(incompleteRecovery);
  const processOnly = structuredClone(soakReceipt);
  processOnly.metrics.processSampleCount = 130;
  processOnly.metrics.operationalSampleCount = 0;
  processOnly.metrics.databasePoolCount = {
    observedSampleCount: 0,
    baseline: null,
    peak: null,
    last: null,
  };
  processOnly.recoveryEvidence.reconnect = { requiredActions: 10, observedActions: 0, recoveryCount: 0 };
  processOnly.recoveryEvidence.restart = { requiredActions: 30, observedActions: 0, recoveryCount: 0 };
  await expectSoakSourceRejected(processOnly);

  const unknownRequirement = structuredClone(receipts[0]);
  unknownRequirement.evidence.requirementId = 'REL-999';
  await assert.rejects(
    evaluateReleaseReadiness({ ...common, evidenceReceipts: [unknownRequirement] }),
    (error) => error instanceof ReleaseAcceptanceError && error.code === 'evidence_unknown',
  );

  process.stdout.write(`${JSON.stringify({
    code: 'release_acceptance_fixture_passed',
    fixtureCount: 15,
    formatVersion: 1,
    kind: 'kodex_release_acceptance_fixture',
    ok: true,
    productionEvidenceCreated: false,
  })}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}
