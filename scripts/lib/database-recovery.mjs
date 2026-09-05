import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';

export const DATABASE_RECOVERY_POLICY_FORMAT_VERSION = 1;
export const DATABASE_RECOVERY_RECEIPT_FORMAT_VERSION = 1;

const POLICY_FORMAT = 'kodex-database-recovery-policy';
const RECEIPT_FORMAT = 'kodex-database-recovery-drill-receipt';
const MAX_POLICY_BYTES = 64 * 1024;
const MAX_RECEIPT_BYTES = 32 * 1024;
const SHA256 = /^[a-f0-9]{64}$/u;
const REFERENCE = /^(?:keyref|opsref|trustref):[a-z0-9][a-z0-9.-]{2,63}$/u;
const FORBIDDEN_REFERENCE_TEXT = /(?:access[-.]?key|api[-.]?key|credential|password|private[-.]?key|secret|sk-|token)/u;
const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const PROFILES = ['acceptance', 'development', 'production'];
const REPLICA_TOPOLOGIES = ['cross-region-hot-standby', 'regional-standby', 'single'];
const TLS_MODES = ['disable', 'require', 'verify-ca', 'verify-full'];
const RESULT_CODES = ['control-failed', 'failed', 'passed', 'rpo-missed', 'rto-missed'];

export class DatabaseRecoveryError extends Error {
  constructor(code) {
    super(code);
    this.name = 'DatabaseRecoveryError';
    this.code = code;
  }
}

function fail(code) {
  throw new DatabaseRecoveryError(code);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, expected) {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function integer(value, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function reference(value, prefix) {
  return typeof value === 'string'
    && REFERENCE.test(value)
    && value.startsWith(`${prefix}:`)
    && !FORBIDDEN_REFERENCE_TEXT.test(value.slice(value.indexOf(':') + 1));
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
}

export function canonicalDatabaseRecoveryJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function digest(value) {
  return createHash('sha256').update(canonicalDatabaseRecoveryJson(value)).digest('hex');
}

function parseCanonicalTimestamp(value, code) {
  if (typeof value !== 'string' || !CANONICAL_TIMESTAMP.test(value)) fail(code);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) fail(code);
  return milliseconds;
}

async function readBoundedJson(filename, maximumBytes, code) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename)) fail(code);
  let metadata;
  try {
    metadata = await lstat(filename);
  } catch {
    fail(code);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 2 || metadata.size > maximumBytes) fail(code);
  let bytes;
  try {
    bytes = await readFile(filename);
  } catch {
    fail(code);
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (text.charCodeAt(0) === 0xfeff) fail(code);
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof DatabaseRecoveryError) throw error;
    fail(code);
  }
}

function parsePolicyContract(value) {
  if (
    !exactKeys(value, [
      'baseBackup', 'format', 'formatVersion', 'isolation', 'legalHold', 'objectives', 'physicalDeletion',
      'profile', 'replica', 'responsibility', 'restoreDrill', 'rotation', 'snapshots', 'transport', 'walArchive',
    ])
    || value.format !== POLICY_FORMAT
    || value.formatVersion !== DATABASE_RECOVERY_POLICY_FORMAT_VERSION
    || !PROFILES.includes(value.profile)
  ) fail('policy_contract_invalid');

  if (
    !exactKeys(value.responsibility, ['controlMode', 'databaseOperator', 'kodexRole', 'providerAttestationRef'])
    || value.responsibility.controlMode !== 'validate-only'
    || value.responsibility.databaseOperator !== 'external-managed-provider'
    || value.responsibility.kodexRole !== 'policy-and-readiness-gate'
    || !reference(value.responsibility.providerAttestationRef, 'opsref')
  ) fail('policy_reference_invalid');

  if (
    !exactKeys(value.objectives, ['pitrWindowHours', 'rpoMinutes', 'rtoMinutes'])
    || !integer(value.objectives.rpoMinutes, 1, 1_440)
    || !integer(value.objectives.rtoMinutes, 5, 10_080)
    || !integer(value.objectives.pitrWindowHours, 1, 8_760)
  ) fail('policy_contract_invalid');

  if (
    !exactKeys(value.walArchive, [
      'archiveMaximumDelayMinutes', 'continuous', 'enabled', 'encrypted', 'retentionHours', 'worm',
    ])
    || typeof value.walArchive.enabled !== 'boolean'
    || typeof value.walArchive.continuous !== 'boolean'
    || !integer(value.walArchive.archiveMaximumDelayMinutes, 1, 1_440)
    || !integer(value.walArchive.retentionHours, 1, 17_520)
    || typeof value.walArchive.encrypted !== 'boolean'
    || typeof value.walArchive.worm !== 'boolean'
  ) fail('policy_contract_invalid');

  if (
    !exactKeys(value.baseBackup, ['cadenceHours', 'enabled', 'encrypted', 'retentionDays', 'worm'])
    || typeof value.baseBackup.enabled !== 'boolean'
    || !integer(value.baseBackup.cadenceHours, 1, 744)
    || !integer(value.baseBackup.retentionDays, 1, 730)
    || typeof value.baseBackup.encrypted !== 'boolean'
    || typeof value.baseBackup.worm !== 'boolean'
  ) fail('policy_contract_invalid');

  if (!exactKeys(value.transport, ['tlsMode']) || !TLS_MODES.includes(value.transport.tlsMode)) {
    fail('policy_contract_invalid');
  }

  if (
    !exactKeys(value.isolation, ['accountCount', 'failureDomainCount', 'regionCount', 'separateCredentials'])
    || !integer(value.isolation.failureDomainCount, 1, 32)
    || !integer(value.isolation.regionCount, 1, 32)
    || !integer(value.isolation.accountCount, 1, 32)
    || typeof value.isolation.separateCredentials !== 'boolean'
  ) fail('policy_contract_invalid');

  if (
    !exactKeys(value.replica, [
      'enabled', 'fencingEnabled', 'fencingRunbookRef', 'maximumLagSeconds', 'promotionRunbookRef',
      'promotionTargetMinutes', 'slotMaximumWalRetentionBytes', 'slotMonitoringEnabled', 'topology',
    ])
    || typeof value.replica.enabled !== 'boolean'
    || !REPLICA_TOPOLOGIES.includes(value.replica.topology)
    || !integer(value.replica.maximumLagSeconds, 1, 86_400)
    || typeof value.replica.slotMonitoringEnabled !== 'boolean'
    || !integer(value.replica.slotMaximumWalRetentionBytes, 1_048_576, 1_125_899_906_842_624)
    || !integer(value.replica.promotionTargetMinutes, 1, 10_080)
    || !reference(value.replica.promotionRunbookRef, 'opsref')
    || typeof value.replica.fencingEnabled !== 'boolean'
    || !reference(value.replica.fencingRunbookRef, 'opsref')
  ) fail('policy_contract_invalid');

  if (
    !exactKeys(value.snapshots, [
      'cadenceHours', 'deletionProtectionEnabled', 'enabled', 'encrypted', 'retentionDays', 'worm',
    ])
    || typeof value.snapshots.enabled !== 'boolean'
    || !integer(value.snapshots.cadenceHours, 1, 744)
    || !integer(value.snapshots.retentionDays, 1, 730)
    || typeof value.snapshots.deletionProtectionEnabled !== 'boolean'
    || typeof value.snapshots.encrypted !== 'boolean'
    || typeof value.snapshots.worm !== 'boolean'
  ) fail('policy_contract_invalid');

  if (
    !exactKeys(value.rotation, [
      'artifactTrustRef', 'artifactTrustRotationDays', 'encryptionKeyRef', 'encryptionKeyRotationDays',
    ])
    || !reference(value.rotation.encryptionKeyRef, 'keyref')
    || !integer(value.rotation.encryptionKeyRotationDays, 1, 730)
    || !reference(value.rotation.artifactTrustRef, 'trustref')
    || !integer(value.rotation.artifactTrustRotationDays, 1, 730)
  ) fail('policy_reference_invalid');

  if (
    !exactKeys(value.legalHold, [
      'baseBackupsIncluded', 'procedureRef', 'propagationEnabled', 'replicasIncluded', 'snapshotsIncluded', 'walIncluded',
    ])
    || typeof value.legalHold.propagationEnabled !== 'boolean'
    || typeof value.legalHold.walIncluded !== 'boolean'
    || typeof value.legalHold.baseBackupsIncluded !== 'boolean'
    || typeof value.legalHold.snapshotsIncluded !== 'boolean'
    || typeof value.legalHold.replicasIncluded !== 'boolean'
    || !reference(value.legalHold.procedureRef, 'opsref')
  ) fail('policy_contract_invalid');

  if (
    !exactKeys(value.restoreDrill, [
      'artifactSignatureRequired', 'cadenceDays', 'evidenceMaxAgeDays', 'trustVersionMinimum',
    ])
    || !integer(value.restoreDrill.cadenceDays, 1, 365)
    || !integer(value.restoreDrill.evidenceMaxAgeDays, 1, 730)
    || typeof value.restoreDrill.artifactSignatureRequired !== 'boolean'
    || !integer(value.restoreDrill.trustVersionMinimum, 1, 2_147_483_647)
  ) fail('policy_contract_invalid');

  if (
    !exactKeys(value.physicalDeletion, [
      'baseBackupsIncluded', 'exceptionRequiresLegalHold', 'maximumResidualDays', 'replicasIncluded',
      'snapshotsIncluded', 'walIncluded',
    ])
    || !integer(value.physicalDeletion.maximumResidualDays, 1, 730)
    || typeof value.physicalDeletion.exceptionRequiresLegalHold !== 'boolean'
    || typeof value.physicalDeletion.walIncluded !== 'boolean'
    || typeof value.physicalDeletion.baseBackupsIncluded !== 'boolean'
    || typeof value.physicalDeletion.snapshotsIncluded !== 'boolean'
    || typeof value.physicalDeletion.replicasIncluded !== 'boolean'
  ) fail('policy_contract_invalid');
}

function enforceProductionPolicy(value) {
  const requiredTrue = [
    value.walArchive.enabled,
    value.walArchive.continuous,
    value.walArchive.encrypted,
    value.walArchive.worm,
    value.baseBackup.enabled,
    value.baseBackup.encrypted,
    value.baseBackup.worm,
    value.isolation.separateCredentials,
    value.replica.enabled,
    value.replica.slotMonitoringEnabled,
    value.replica.fencingEnabled,
    value.snapshots.enabled,
    value.snapshots.deletionProtectionEnabled,
    value.snapshots.encrypted,
    value.snapshots.worm,
    value.legalHold.propagationEnabled,
    value.legalHold.walIncluded,
    value.legalHold.baseBackupsIncluded,
    value.legalHold.snapshotsIncluded,
    value.legalHold.replicasIncluded,
    value.restoreDrill.artifactSignatureRequired,
    value.physicalDeletion.exceptionRequiresLegalHold,
    value.physicalDeletion.walIncluded,
    value.physicalDeletion.baseBackupsIncluded,
    value.physicalDeletion.snapshotsIncluded,
    value.physicalDeletion.replicasIncluded,
  ];
  if (requiredTrue.some((entry) => entry !== true)) fail('policy_weak');
  if (
    value.transport.tlsMode !== 'verify-full'
    || value.isolation.failureDomainCount < 2
    || value.isolation.regionCount < 2
    || value.isolation.accountCount < 2
    || value.replica.topology !== 'cross-region-hot-standby'
  ) fail('policy_weak');

  const pitrHours = value.objectives.pitrWindowHours;
  const residualHours = value.physicalDeletion.maximumResidualDays * 24;
  if (
    value.walArchive.retentionHours < pitrHours
    || value.baseBackup.retentionDays * 24 < pitrHours
    || value.snapshots.retentionDays * 24 < pitrHours
    || value.walArchive.retentionHours > residualHours
    || value.baseBackup.retentionDays > value.physicalDeletion.maximumResidualDays
    || value.snapshots.retentionDays > value.physicalDeletion.maximumResidualDays
    || value.walArchive.archiveMaximumDelayMinutes > value.objectives.rpoMinutes
    || value.replica.maximumLagSeconds > value.objectives.rpoMinutes * 60
    || value.replica.promotionTargetMinutes > value.objectives.rtoMinutes
    || value.baseBackup.cadenceHours > value.baseBackup.retentionDays * 24
    || value.snapshots.cadenceHours > value.snapshots.retentionDays * 24
    || value.restoreDrill.evidenceMaxAgeDays < value.restoreDrill.cadenceDays
    || value.restoreDrill.evidenceMaxAgeDays > value.restoreDrill.cadenceDays * 2
  ) fail('policy_inconsistent');
}

export function parseDatabaseRecoveryPolicy(value) {
  parsePolicyContract(value);
  if (value.profile === 'production') enforceProductionPolicy(value);
  return {
    policy: value,
    policyDigest: digest(value),
    profile: value.profile,
    promotionEligible: value.profile === 'production',
  };
}

export async function readDatabaseRecoveryPolicy(filename) {
  if (typeof filename !== 'string') fail('policy_input_invalid');
  return parseDatabaseRecoveryPolicy(await readBoundedJson(path.resolve(filename), MAX_POLICY_BYTES, 'policy_input_invalid'));
}

function parseReceiptContract(value) {
  if (
    !exactKeys(value, [
      'artifactSignature', 'format', 'formatVersion', 'objectives', 'performedAt', 'policyDigest', 'protections', 'resultCode',
    ])
    || value.format !== RECEIPT_FORMAT
    || value.formatVersion !== DATABASE_RECOVERY_RECEIPT_FORMAT_VERSION
    || !SHA256.test(value.policyDigest)
    || !RESULT_CODES.includes(value.resultCode)
  ) fail('receipt_contract_invalid');
  parseCanonicalTimestamp(value.performedAt, 'receipt_contract_invalid');
  if (
    !exactKeys(value.artifactSignature, ['algorithm', 'trustRef', 'trustVersion', 'verified'])
    || value.artifactSignature.algorithm !== 'Ed25519'
    || !reference(value.artifactSignature.trustRef, 'trustref')
    || !integer(value.artifactSignature.trustVersion, 1, 2_147_483_647)
    || typeof value.artifactSignature.verified !== 'boolean'
  ) fail('receipt_contract_invalid');
  if (
    !exactKeys(value.objectives, ['observedRecoveryPointAgeMinutes', 'observedRecoveryTimeMinutes', 'rpoMet', 'rtoMet'])
    || !integer(value.objectives.observedRecoveryPointAgeMinutes, 0, 10_080)
    || !integer(value.objectives.observedRecoveryTimeMinutes, 0, 10_080)
    || typeof value.objectives.rpoMet !== 'boolean'
    || typeof value.objectives.rtoMet !== 'boolean'
  ) fail('receipt_contract_invalid');
  if (
    !exactKeys(value.protections, [
      'baseBackupVerified', 'legalHoldPropagationVerified', 'physicalDeletionBoundVerified', 'replicaVerified',
      'snapshotVerified', 'walArchiveVerified',
    ])
    || Object.values(value.protections).some((entry) => typeof entry !== 'boolean')
  ) fail('receipt_contract_invalid');
  return value;
}

export function parseDatabaseRecoveryReceipt(value) {
  const receipt = parseReceiptContract(value);
  return { receipt, receiptDigest: digest(receipt) };
}

export async function readDatabaseRecoveryReceipt(filename) {
  if (typeof filename !== 'string') fail('receipt_input_invalid');
  return parseDatabaseRecoveryReceipt(await readBoundedJson(path.resolve(filename), MAX_RECEIPT_BYTES, 'receipt_input_invalid'));
}

function assertPromotionPolicy(parsedPolicy) {
  if (!isRecord(parsedPolicy) || !exactKeys(parsedPolicy, ['policy', 'policyDigest', 'profile', 'promotionEligible'])) {
    fail('policy_contract_invalid');
  }
  const verified = parseDatabaseRecoveryPolicy(parsedPolicy.policy);
  if (
    parsedPolicy.policyDigest !== verified.policyDigest
    || parsedPolicy.profile !== verified.profile
    || parsedPolicy.promotionEligible !== verified.promotionEligible
  ) fail('policy_contract_invalid');
  if (!parsedPolicy.promotionEligible || parsedPolicy.profile !== 'production') fail('policy_profile_not_promotable');
}

function ageBucket(ageMilliseconds) {
  const hours = Math.floor(ageMilliseconds / (60 * 60 * 1_000));
  if (hours < 24) return 'under-24h';
  if (hours < 7 * 24) return '1-6d';
  if (hours < 30 * 24) return '7-29d';
  if (hours < 90 * 24) return '30-89d';
  return '90d-or-more';
}

export function validateDatabaseRecoveryReceipt(parsedPolicy, parsedReceipt, evaluatedAt) {
  assertPromotionPolicy(parsedPolicy);
  if (!isRecord(parsedReceipt) || !exactKeys(parsedReceipt, ['receipt', 'receiptDigest'])) fail('receipt_contract_invalid');
  const verifiedReceipt = parseDatabaseRecoveryReceipt(parsedReceipt.receipt);
  if (parsedReceipt.receiptDigest !== verifiedReceipt.receiptDigest) fail('receipt_contract_invalid');
  const atMilliseconds = parseCanonicalTimestamp(evaluatedAt, 'evaluation_time_invalid');
  const receipt = parsedReceipt.receipt;
  const performedMilliseconds = parseCanonicalTimestamp(receipt.performedAt, 'receipt_contract_invalid');
  if (receipt.policyDigest !== parsedPolicy.policyDigest) fail('receipt_policy_mismatch');
  if (receipt.resultCode !== 'passed') fail('receipt_failed');
  if (
    receipt.artifactSignature.verified !== true
    || receipt.artifactSignature.trustRef !== parsedPolicy.policy.rotation.artifactTrustRef
    || receipt.artifactSignature.trustVersion < parsedPolicy.policy.restoreDrill.trustVersionMinimum
  ) fail('receipt_trust_rejected');
  if (
    receipt.objectives.rpoMet !== true
    || receipt.objectives.rtoMet !== true
    || receipt.objectives.observedRecoveryPointAgeMinutes > parsedPolicy.policy.objectives.rpoMinutes
    || receipt.objectives.observedRecoveryTimeMinutes > parsedPolicy.policy.objectives.rtoMinutes
  ) fail('receipt_objectives_missed');
  if (Object.values(receipt.protections).some((entry) => entry !== true)) fail('receipt_protection_failed');
  const ageMilliseconds = atMilliseconds - performedMilliseconds;
  if (ageMilliseconds < 0) fail('receipt_from_future');
  if (ageMilliseconds > parsedPolicy.policy.restoreDrill.evidenceMaxAgeDays * 24 * 60 * 60 * 1_000) {
    fail('receipt_stale');
  }
  return {
    evidenceAgeBucket: ageBucket(ageMilliseconds),
    policyDigest: parsedPolicy.policyDigest,
    receiptDigest: parsedReceipt.receiptDigest,
  };
}

export function databaseRecoveryPolicyValidationResult(parsedPolicy) {
  if (!isRecord(parsedPolicy) || !SHA256.test(parsedPolicy.policyDigest)) fail('policy_contract_invalid');
  return {
    code: parsedPolicy.promotionEligible ? 'policy_valid' : 'policy_valid_nonproduction',
    formatVersion: DATABASE_RECOVERY_POLICY_FORMAT_VERSION,
    kind: 'kodex_database_recovery_policy_validation',
    ok: true,
    policyDigest: parsedPolicy.policyDigest,
    profile: parsedPolicy.profile,
    promotionEligible: parsedPolicy.promotionEligible,
  };
}

export function createDatabaseRecoveryDrillPlan(parsedPolicy) {
  assertPromotionPolicy(parsedPolicy);
  const stepCodes = [
    'verify-policy-digest',
    'verify-provider-control-attestation',
    'provision-isolated-restore-target',
    'restore-base-backup',
    'replay-wal-to-bounded-target',
    'measure-rpo-rto',
    'exercise-replica-promotion-fencing',
    'verify-snapshot-recovery',
    'verify-legal-hold-propagation',
    'verify-physical-copy-expiry',
    'sign-payload-free-receipt',
    'destroy-isolated-restore-target',
  ];
  return {
    code: 'drill_plan_created',
    formatVersion: DATABASE_RECOVERY_POLICY_FORMAT_VERSION,
    kind: 'kodex_database_recovery_drill_plan',
    ok: true,
    policyDigest: parsedPolicy.policyDigest,
    profile: parsedPolicy.profile,
    stepCodes,
    stepCount: stepCodes.length,
  };
}

export function databaseRecoveryReceiptValidationResult(parsedPolicy, validation) {
  return {
    code: 'receipt_valid',
    evidenceAgeBucket: validation.evidenceAgeBucket,
    formatVersion: DATABASE_RECOVERY_RECEIPT_FORMAT_VERSION,
    kind: 'kodex_database_recovery_receipt_validation',
    ok: true,
    policyDigest: parsedPolicy.policyDigest,
    readiness: 'ready',
  };
}

export function databaseRecoveryStatusResult(parsedPolicy, validation) {
  return {
    code: 'recovery_ready',
    evidenceAgeBucket: validation.evidenceAgeBucket,
    formatVersion: DATABASE_RECOVERY_RECEIPT_FORMAT_VERSION,
    kind: 'kodex_database_recovery_status',
    ok: true,
    policyDigest: parsedPolicy.policyDigest,
    profile: parsedPolicy.profile,
    promotionEligible: true,
    readiness: 'ready',
  };
}

export const DATABASE_RECOVERY_POLICY_SCHEMA_SHA256 = '30c3f2b59d7e3494cb7119b9d18d14a8c3b289e8634e75a96916baa1036f1b79';

const DOCUMENT_CONTRACTS = [
  ['README.md', ['database-recovery-policy.json', 'recovery:validate', 'database-recovery.md']],
  ['docs/HANDOFF.md', ['Phase 35', 'recovery:validate', 'provider drill']],
  ['docs/adr/0034-managed-postgresql-recovery-policy.md', ['Phase 35', 'validate-only', 'payload-free']],
  ['docs/operations/database-recovery.md', ['recovery:validate', 'receipt-validate', 'provider drill']],
  ['docs/operations/backup-restore.md', ['database-recovery.md']],
  ['docs/operations/data-lifecycle.md', ['database-recovery.md']],
  ['docs/operations/deployment-upgrade.md', ['recovery:validate']],
  ['docs/security/threat-model.md', ['database recovery policy', 'WAL/PITR/replica/provider snapshot']],
];

export async function verifyDatabaseRecoveryRepositoryContracts(root) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) fail('repository_contract_invalid');
  const policyPath = path.join(root, 'config', 'database-recovery-policy.json');
  const schemaPath = path.join(root, 'config', 'database-recovery-policy.schema.json');
  const parsedPolicy = await readDatabaseRecoveryPolicy(policyPath);
  let schemaBytes;
  try {
    schemaBytes = await readFile(schemaPath);
  } catch {
    fail('repository_contract_invalid');
  }
  if (schemaBytes.length < 2 || schemaBytes.length > 256 * 1024) fail('repository_contract_invalid');
  let schema;
  try {
    schema = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(schemaBytes));
  } catch {
    fail('repository_contract_invalid');
  }
  if (
    createHash('sha256').update(canonicalDatabaseRecoveryJson(schema)).digest('hex')
      !== DATABASE_RECOVERY_POLICY_SCHEMA_SHA256
  ) {
    fail('repository_contract_invalid');
  }
  let packageJson;
  try {
    packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  } catch {
    fail('repository_contract_invalid');
  }
  if (
    packageJson?.scripts?.['recovery:cli'] !== 'node scripts/kodex-database-recovery.mjs'
    || packageJson?.scripts?.['recovery:validate'] !== 'node scripts/recovery-validate.mjs'
    || packageJson?.scripts?.['test:recovery'] !== 'node scripts/test-database-recovery.mjs'
  ) fail('repository_contract_invalid');
  for (const [relative, required] of DOCUMENT_CONTRACTS) {
    let text;
    try {
      text = await readFile(path.join(root, ...relative.split('/')), 'utf8');
    } catch {
      fail('documentation_contract_invalid');
    }
    if (required.some((entry) => !text.includes(entry))) fail('documentation_contract_invalid');
  }
  return {
    documentContractCount: DOCUMENT_CONTRACTS.length,
    policyDigest: parsedPolicy.policyDigest,
    policyFormatVersion: DATABASE_RECOVERY_POLICY_FORMAT_VERSION,
  };
}
