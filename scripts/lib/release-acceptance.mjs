import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  parseDatabaseRecoveryPolicy,
  readDatabaseRecoveryPolicy,
  readDatabaseRecoveryReceipt,
  validateDatabaseRecoveryReceipt,
} from './database-recovery.mjs';
import {
  parseLongRunScenarioCatalog,
  readLongRunReceipt,
} from './long-run-acceptance.mjs';
import { RELEASE_SIGNATURE_FILENAME, verifyReleaseArtifactIntegrity } from './release-artifact.mjs';
import { signEd25519Payload, verifyReleaseArtifact, verifyTrustedEd25519Payload } from './release-signature.mjs';
import { sha256File, verifyRepositoryProvenance } from './security-validation.mjs';
import { windowsInstallerStatus } from './windows-installer.mjs';

const execFileAsync = promisify(execFile);
export const RELEASE_ACCEPTANCE_FORMAT_VERSION = 1;
export const RELEASE_ACCEPTANCE_CATALOG_FORMAT = 'kodex-release-acceptance-catalog';
export const RELEASE_ACCEPTANCE_EVIDENCE_FORMAT = 'kodex-release-acceptance-evidence';
export const RELEASE_ACCEPTANCE_SIGNATURE_DOMAIN = 'kodex-release-acceptance-evidence-signature-v1';

const MAX_JSON_BYTES = 1024 * 1024;
const MAX_EVIDENCE_FILES = 128;
const SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const KEY_ID = /^[a-z0-9](?:[a-z0-9._-]{0,63})$/u;
const REQUIREMENT_ID = /^REL-[0-9]{3}$/u;
const COMMAND_ID = /^(?:acceptance|operations)\.[a-z0-9-]+$/u;
const CODE = /^[a-z][a-z0-9_]{0,95}$/u;
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const ENVIRONMENTS = new Set(['electron', 'filesystem', 'local', 'postgresql', 'product', 'provider', 'release', 'repository']);
const EVIDENCE_TYPES = new Set([
  'repository-receipt', 'test-receipt', 'build-receipt', 'artifact-receipt',
  'provider-drill-receipt', 'soak-receipt',
]);
const ARTIFACT_KINDS = new Set([
  'release-bundle', 'windows-installer', 'offline-backup', 'database-recovery-receipt', 'long-run-receipt',
]);
const SOURCE_REQUIRED = Object.freeze({
  build: 'releaseArtifact',
  signing: 'releaseArtifact',
  installer: 'installer',
  'provider-drill': 'providerRecovery',
  'long-run-soak': 'soak',
});

export const RELEASE_ACCEPTANCE_COMMAND_ALLOWLIST = Object.freeze({
  'acceptance.backup-restore': { executionClass: 'infrastructure', npmScript: 'test:backup-restore' },
  'acceptance.browserless-full-stack': { executionClass: 'full-stack', npmScript: 'test:full-stack' },
  'acceptance.database-migrations': { executionClass: 'infrastructure', npmScript: 'test:auth-lifecycle-postgres' },
  'acceptance.electron': { executionClass: 'full-stack', npmScript: 'test:desktop-full-stack' },
  'acceptance.email': { executionClass: 'infrastructure', npmScript: 'test:email-verification-postgres' },
  'acceptance.filesystem-lifecycle': { executionClass: 'full-stack', npmScript: 'test:desktop-data-lifecycle' },
  'acceptance.history-rag': { executionClass: 'full-stack', npmScript: 'test:desktop-repository-rag' },
  'acceptance.installer-fixture': { executionClass: 'short', npmScript: 'test:installer' },
  'acceptance.observability': { executionClass: 'targeted', npmScript: 'test:observability' },
  'acceptance.release-deployment': { executionClass: 'full-stack', npmScript: 'test:release-deployment' },
  'acceptance.release-signing': { executionClass: 'short', npmScript: 'test:release-signing' },
  'acceptance.repository-contracts': { executionClass: 'short', npmScript: 'acceptance:validate' },
  'acceptance.security': { executionClass: 'short', npmScript: 'security:validate' },
  'acceptance.workspace-recovery': { executionClass: 'full-stack', npmScript: 'test:desktop-workspace-lifecycle' },
  'operations.installer-artifact': { executionClass: 'external', npmScript: null },
  'operations.production-release-build': { executionClass: 'build', npmScript: 'release:build' },
  'operations.provider-recovery-drill': { executionClass: 'external', npmScript: null },
  'operations.soak': { executionClass: 'long-run', npmScript: 'acceptance:long-run' },
});

export class ReleaseAcceptanceError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ReleaseAcceptanceError';
    this.code = code;
  }
}

function fail(code) {
  throw new ReleaseAcceptanceError(code);
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

function boundedInteger(value, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function canonicalTimestamp(value) {
  if (typeof value !== 'string' || value.length > 64) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

export function canonicalReleaseAcceptanceJson(value) {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

function digest(value) {
  return createHash('sha256').update(canonicalReleaseAcceptanceJson(value)).digest('hex');
}

function sortedUnique(values, predicate) {
  return Array.isArray(values)
    && values.length > 0
    && values.every(predicate)
    && values.every((value, index) => index === 0 || value > values[index - 1]);
}

async function readBoundedJson(filename, code, canonical = false) {
  let metadata;
  try { metadata = await lstat(filename); } catch { fail(code); }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 2 || metadata.size > MAX_JSON_BYTES) fail(code);
  let bytes;
  let value;
  try {
    bytes = await readFile(filename);
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    fail(code);
  }
  if (canonical && !bytes.equals(Buffer.from(canonicalReleaseAcceptanceJson(value), 'utf8'))) fail(code);
  return value;
}

export function parseReleaseAcceptanceCatalog(value) {
  if (
    !exactKeys(value, [
      'commands', 'format', 'formatVersion', 'receiptFormatVersion', 'releaseProfile', 'requirements', 'trust',
    ])
    || value.format !== RELEASE_ACCEPTANCE_CATALOG_FORMAT
    || value.formatVersion !== RELEASE_ACCEPTANCE_FORMAT_VERSION
    || value.receiptFormatVersion !== RELEASE_ACCEPTANCE_FORMAT_VERSION
    || value.releaseProfile !== 'production'
    || !exactKeys(value.trust, ['algorithm', 'minimumStoreVersion', 'reference'])
    || value.trust.algorithm !== 'Ed25519'
    || !boundedInteger(value.trust.minimumStoreVersion, 1, 2_147_483_647)
    || typeof value.trust.reference !== 'string'
    || !/^trustref:[a-z0-9][a-z0-9._-]{0,95}$/u.test(value.trust.reference)
    || !Array.isArray(value.commands)
    || value.commands.length !== Object.keys(RELEASE_ACCEPTANCE_COMMAND_ALLOWLIST).length
    || !Array.isArray(value.requirements)
    || value.requirements.length !== 18
  ) fail('catalog_contract_invalid');
  const commands = new Map();
  let previousCommand = '';
  for (const command of value.commands) {
    if (
      !exactKeys(command, ['executionClass', 'id', 'npmScript'])
      || !COMMAND_ID.test(command.id)
      || command.id <= previousCommand
      || !['short', 'targeted', 'infrastructure', 'full-stack', 'build', 'external', 'long-run'].includes(command.executionClass)
      || (command.npmScript !== null && (typeof command.npmScript !== 'string' || !/^[a-z][a-z0-9:-]{0,95}$/u.test(command.npmScript)))
    ) fail('catalog_contract_invalid');
    const allowed = RELEASE_ACCEPTANCE_COMMAND_ALLOWLIST[command.id];
    if (!allowed || allowed.executionClass !== command.executionClass || allowed.npmScript !== command.npmScript) {
      fail('catalog_command_unknown');
    }
    commands.set(command.id, command);
    previousCommand = command.id;
  }
  const requirements = new Map();
  const phaseCoverage = new Set();
  let previousRequirement = '';
  for (const [requirementIndex, requirement] of value.requirements.entries()) {
    if (
      !exactKeys(requirement, [
        'category', 'commandIds', 'descriptionCode', 'environments', 'evidenceTypes', 'id', 'maximumAgeHours', 'phases',
      ])
      || !REQUIREMENT_ID.test(requirement.id)
      || requirement.id !== `REL-${String(requirementIndex + 1).padStart(3, '0')}`
      || requirement.id <= previousRequirement
      || typeof requirement.category !== 'string'
      || !/^[a-z][a-z0-9-]{0,63}$/u.test(requirement.category)
      || typeof requirement.descriptionCode !== 'string'
      || !CODE.test(requirement.descriptionCode)
      || !boundedInteger(requirement.maximumAgeHours, 1, 8_760)
      || !sortedUnique(requirement.commandIds, (id) => typeof id === 'string' && commands.has(id))
      || !sortedUnique(requirement.environments, (environment) => ENVIRONMENTS.has(environment))
      || !sortedUnique(requirement.evidenceTypes, (type) => EVIDENCE_TYPES.has(type))
      || !sortedUnique(requirement.phases, (phase) => boundedInteger(phase, 1, 36))
    ) fail('catalog_contract_invalid');
    requirement.phases.forEach((phase) => phaseCoverage.add(phase));
    requirements.set(requirement.id, requirement);
    previousRequirement = requirement.id;
  }
  if ([...Array(36)].some((_value, index) => !phaseCoverage.has(index + 1))) fail('catalog_phase_coverage_incomplete');
  return { catalog: value, catalogDigest: digest(value), commands, requirements };
}

export async function readReleaseAcceptanceCatalog(filename) {
  return parseReleaseAcceptanceCatalog(await readBoundedJson(path.resolve(filename), 'catalog_input_invalid'));
}

function canonicalSignature(value) {
  if (typeof value !== 'string' || value.length > 512 || !BASE64.test(value)) fail('evidence_signature_invalid');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length !== 64 || bytes.toString('base64') !== value) fail('evidence_signature_invalid');
  return bytes;
}

function parseArtifactEvidence(value) {
  if (value === null) return null;
  if (
    !exactKeys(value, ['kind', 'manifestDigest', 'signatureDigest', 'signatureKeyId', 'trustStoreVersion'])
    || !ARTIFACT_KINDS.has(value.kind)
    || !SHA256.test(value.manifestDigest)
    || (value.signatureDigest !== null && !SHA256.test(value.signatureDigest))
    || (value.signatureKeyId !== null && !KEY_ID.test(value.signatureKeyId))
    || (value.trustStoreVersion !== null && !boundedInteger(value.trustStoreVersion, 1, 2_147_483_647))
    || ((value.signatureDigest === null || value.signatureKeyId === null || value.trustStoreVersion === null)
      && value.kind !== 'long-run-receipt')
    || (value.kind === 'long-run-receipt'
      && [value.signatureDigest, value.signatureKeyId, value.trustStoreVersion].some((entry) => entry !== null))
  ) fail('evidence_contract_invalid');
  return value;
}

function unsignedEvidenceFields(value) {
  return {
    artifactEvidence: value.artifactEvidence,
    attestation: {
      algorithm: value.attestation.algorithm,
      keyId: value.attestation.keyId,
      trustRef: value.attestation.trustRef,
      trustVersion: value.attestation.trustVersion,
    },
    commandId: value.commandId,
    completedAt: value.completedAt,
    evidenceType: value.evidenceType,
    format: value.format,
    formatVersion: value.formatVersion,
    release: value.release,
    requirementId: value.requirementId,
    resultCode: value.resultCode,
    startedAt: value.startedAt,
    testCounts: value.testCounts,
  };
}

function parseEvidenceContract(value, signatureMode = 'required') {
  if (
    !exactKeys(value, [
      'artifactEvidence', 'attestation', 'commandId', 'completedAt', 'evidenceType', 'format', 'formatVersion',
      'release', 'requirementId', 'resultCode', 'startedAt', 'testCounts',
    ])
    || value.format !== RELEASE_ACCEPTANCE_EVIDENCE_FORMAT
    || value.formatVersion !== RELEASE_ACCEPTANCE_FORMAT_VERSION
    || !REQUIREMENT_ID.test(value.requirementId)
    || !COMMAND_ID.test(value.commandId)
    || !EVIDENCE_TYPES.has(value.evidenceType)
    || !['passed', 'failed', 'aborted'].includes(value.resultCode)
    || !canonicalTimestamp(value.startedAt)
    || !canonicalTimestamp(value.completedAt)
    || Date.parse(value.startedAt) > Date.parse(value.completedAt)
    || !exactKeys(value.release, [
      'catalogDigest', 'codexUpstreamCommit', 'commit', 'migrationLedgerDigest', 'policyDigest',
      'vendorManifestSha256', 'version',
    ])
    || !SHA256.test(value.release.catalogDigest)
    || !COMMIT.test(value.release.codexUpstreamCommit)
    || !COMMIT.test(value.release.commit)
    || !SHA256.test(value.release.migrationLedgerDigest)
    || !SHA256.test(value.release.policyDigest)
    || !SHA256.test(value.release.vendorManifestSha256)
    || !VERSION.test(value.release.version)
    || !exactKeys(value.testCounts, ['failed', 'passed', 'skipped', 'total'])
    || Object.values(value.testCounts).some((entry) => !boundedInteger(entry, 0, Number.MAX_SAFE_INTEGER))
    || value.testCounts.total !== value.testCounts.failed + value.testCounts.passed + value.testCounts.skipped
  ) fail('evidence_contract_invalid');
  parseArtifactEvidence(value.artifactEvidence);
  if (
    ['build-receipt', 'artifact-receipt', 'provider-drill-receipt', 'soak-receipt'].includes(value.evidenceType)
    && value.artifactEvidence === null
  ) fail('evidence_contract_invalid');
  const attestationKeys = signatureMode === 'absent'
    ? ['algorithm', 'keyId', 'trustRef', 'trustVersion']
    : ['algorithm', 'keyId', 'signature', 'trustRef', 'trustVersion'];
  if (
    !exactKeys(value.attestation, attestationKeys)
    || value.attestation.algorithm !== 'Ed25519'
    || !KEY_ID.test(value.attestation.keyId)
    || typeof value.attestation.trustRef !== 'string'
    || !/^trustref:[a-z0-9][a-z0-9._-]{0,95}$/u.test(value.attestation.trustRef)
    || !boundedInteger(value.attestation.trustVersion, 1, 2_147_483_647)
  ) fail(signatureMode === 'absent' ? 'evidence_contract_invalid' : 'evidence_unsigned');
  if (signatureMode === 'required') canonicalSignature(value.attestation.signature).fill(0);
  return value;
}

export function releaseAcceptanceEvidenceSigningPayload(value) {
  const hasSignature = isRecord(value?.attestation) && Object.hasOwn(value.attestation, 'signature');
  parseEvidenceContract(value, hasSignature ? 'required' : 'absent');
  return Buffer.from(canonicalReleaseAcceptanceJson({
    domain: RELEASE_ACCEPTANCE_SIGNATURE_DOMAIN,
    evidence: unsignedEvidenceFields(value),
  }), 'utf8');
}

export function signReleaseAcceptanceEvidence(unsignedEvidence, privateKeyBytes) {
  parseEvidenceContract(unsignedEvidence, 'absent');
  if (!(privateKeyBytes instanceof Uint8Array) || privateKeyBytes.byteLength < 1) fail('evidence_signing_key_invalid');
  let signature;
  try {
    signature = signEd25519Payload(releaseAcceptanceEvidenceSigningPayload(unsignedEvidence), privateKeyBytes).toString('base64');
  } catch {
    fail('evidence_signing_key_invalid');
  }
  return {
    ...unsignedEvidence,
    attestation: { ...unsignedEvidence.attestation, signature },
  };
}

export function parseReleaseAcceptanceEvidence(value) {
  const evidence = parseEvidenceContract(value);
  return { evidence, evidenceDigest: digest(evidence) };
}

async function validateEvidenceSignature(parsedEvidence, catalog, trustStorePath) {
  if (typeof trustStorePath !== 'string' || !path.isAbsolute(trustStorePath)) fail('evidence_trust_store_invalid');
  const evidence = parsedEvidence.evidence;
  const signature = canonicalSignature(evidence.attestation.signature);
  let trust;
  try {
    trust = await verifyTrustedEd25519Payload({
      keyId: evidence.attestation.keyId,
      payload: releaseAcceptanceEvidenceSigningPayload(evidence),
      signature,
      trustStorePath,
    });
  } catch (error) {
    if (error?.message === 'Signature key is not present in the trust store.') fail('evidence_key_unknown');
    if (error?.message === 'Signature key is revoked.') fail('evidence_key_revoked');
    if (error?.message === 'Ed25519 signature verification failed.') fail('evidence_signature_invalid');
    fail('evidence_trust_store_invalid');
  } finally {
    signature.fill(0);
  }
  if (
    trust.storeVersion !== evidence.attestation.trustVersion
    || trust.storeVersion < catalog.catalog.trust.minimumStoreVersion
    || evidence.attestation.trustRef !== catalog.catalog.trust.reference
  ) fail('evidence_trust_mismatch');
  return trust;
}

function identityFields(identity, catalogDigest) {
  return {
    catalogDigest,
    codexUpstreamCommit: identity.codexUpstreamCommit,
    commit: identity.commit,
    migrationLedgerDigest: identity.migrationLedgerDigest,
    policyDigest: identity.policyDigest,
    vendorManifestSha256: identity.vendorManifestSha256,
    version: identity.version,
  };
}

function parseRepositoryIdentity(value) {
  if (
    !exactKeys(value, [
      'codexUpstreamCommit', 'commit', 'dirty', 'migrationLedger', 'migrationLedgerDigest',
      'policyDigest', 'vendorManifestSha256', 'version',
    ])
    || !COMMIT.test(value.codexUpstreamCommit)
    || !COMMIT.test(value.commit)
    || typeof value.dirty !== 'boolean'
    || !Array.isArray(value.migrationLedger)
    || value.migrationLedger.length !== 13
    || value.migrationLedger.some((migration, index) => (
      !exactKeys(migration, ['checksum', 'name', 'version'])
      || migration.version !== index + 1
      || typeof migration.name !== 'string'
      || !/^[a-z0-9][a-z0-9_-]{0,127}$/u.test(migration.name)
      || !SHA256.test(migration.checksum)
    ))
    || !SHA256.test(value.migrationLedgerDigest)
    || digest(value.migrationLedger) !== value.migrationLedgerDigest
    || !SHA256.test(value.policyDigest)
    || !SHA256.test(value.vendorManifestSha256)
    || !VERSION.test(value.version)
  ) fail('repository_identity_invalid');
  return value;
}

async function migrationLedger(repositoryRoot) {
  const directory = path.join(repositoryRoot, 'packages', 'product-db', 'migrations');
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch { fail('migration_ledger_invalid'); }
  const names = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.sql')).map((entry) => entry.name).sort();
  if (names.length !== 13) fail('migration_ledger_invalid');
  const ledger = [];
  for (let index = 0; index < names.length; index += 1) {
    const match = /^(\d{4})_([a-z0-9][a-z0-9_-]*)\.sql$/u.exec(names[index]);
    if (!match || Number(match[1]) !== index + 1) fail('migration_ledger_invalid');
    const bytes = await readFile(path.join(directory, names[index]));
    ledger.push({ version: index + 1, name: match[2], checksum: createHash('sha256').update(bytes).digest('hex') });
  }
  return { migrationLedger: ledger, migrationLedgerDigest: digest(ledger) };
}

export async function collectReleaseRepositoryIdentity(repositoryRoot) {
  if (typeof repositoryRoot !== 'string' || !path.isAbsolute(repositoryRoot)) fail('repository_identity_invalid');
  const root = path.resolve(repositoryRoot);
  let packageJson;
  let commit;
  let dirty;
  try {
    packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    ({ stdout: commit } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }));
    const status = await execFileAsync('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: root, encoding: 'utf8', windowsHide: true });
    dirty = status.stdout.length > 0;
  } catch {
    fail('repository_identity_invalid');
  }
  const policy = await readDatabaseRecoveryPolicy(path.join(root, 'config', 'database-recovery-policy.json'));
  const provenance = await verifyRepositoryProvenance(root, { requireBinary: false }).catch(() => fail('repository_provenance_invalid'));
  const migrations = await migrationLedger(root);
  return parseRepositoryIdentity({
    codexUpstreamCommit: provenance.commit,
    commit: commit.trim(),
    dirty,
    ...migrations,
    policyDigest: policy.policyDigest,
    vendorManifestSha256: provenance.vendorManifestSha256,
    version: packageJson.version,
  });
}

async function evidenceDirectory(directory) {
  if (directory === undefined) return [];
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) fail('evidence_directory_invalid');
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) {
    if (error?.code === 'ENOENT') return [];
    fail('evidence_directory_invalid');
  }
  if (entries.length > MAX_EVIDENCE_FILES) fail('evidence_limit_exceeded');
  const files = entries.filter((entry) => entry.name.endsWith('.json'));
  if (files.length !== entries.length || files.some((entry) => !entry.isFile() || !REQUIREMENT_ID.test(entry.name.slice(0, -5)))) {
    fail('evidence_unknown');
  }
  files.sort((left, right) => left.name.localeCompare(right.name));
  return Promise.all(files.map(async (entry) => {
    const value = await readBoundedJson(path.join(directory, entry.name), 'evidence_contract_invalid', true);
    const parsed = parseReleaseAcceptanceEvidence(value);
    if (`${parsed.evidence.requirementId}.json` !== entry.name) fail('evidence_unknown');
    return parsed;
  }));
}

function sourceMatches(requirement, evidence, sourceEvidence) {
  const requiredSource = SOURCE_REQUIRED[requirement.category];
  if (!requiredSource) return true;
  const source = sourceEvidence?.[requiredSource];
  if (!source || !evidence.artifactEvidence) return false;
  if (requiredSource === 'releaseArtifact') {
    return evidence.artifactEvidence.kind === 'release-bundle'
      && evidence.artifactEvidence.manifestDigest === source.manifestSha256
      && evidence.artifactEvidence.signatureDigest === source.signatureDigest
      && evidence.artifactEvidence.signatureKeyId === source.keyId
      && evidence.artifactEvidence.trustStoreVersion === source.trustStoreVersion;
  }
  if (requiredSource === 'installer') {
    return evidence.artifactEvidence.kind === 'windows-installer'
      && source.activeReleaseId === source.confirmedReleaseId
      && source.activeReleaseId === source.expectedReleaseId
      && source.transactionPhase === null
      && source.operatorRecoveryRequired === false
      && source.stagingCount === 0
      && source.installerTrustStoreVersion === source.releaseTrustStoreVersion
      && evidence.artifactEvidence.manifestDigest === source.manifestSha256
      && evidence.artifactEvidence.signatureDigest === source.signatureDigest
      && evidence.artifactEvidence.signatureKeyId === source.keyId
      && evidence.artifactEvidence.trustStoreVersion === source.releaseTrustStoreVersion;
  }
  if (requiredSource === 'providerRecovery') {
    return evidence.artifactEvidence.kind === 'database-recovery-receipt'
      && evidence.artifactEvidence.manifestDigest === source.receiptDigest
      && evidence.artifactEvidence.signatureDigest === source.signatureDigest
      && evidence.artifactEvidence.signatureKeyId === source.keyId
      && evidence.artifactEvidence.trustStoreVersion === source.trustStoreVersion;
  }
  if (requiredSource === 'soak') {
    const elapsed = Date.parse(source.receipt.completedAt) - Date.parse(source.receipt.startedAt);
    return evidence.artifactEvidence.kind === 'long-run-receipt'
      && evidence.artifactEvidence.manifestDigest === source.receiptDigest
      && source.receipt.resultCode === 'completed'
      && elapsed >= 43_200_000
      && elapsed <= 259_200_000
      && ['full-system-soak', 'product-local-postgresql-soak'].includes(source.receipt.scenarioId);
  }
  return false;
}

function artifactMatchesRequirement(requirement, evidence) {
  const expectedKinds = {
    'backup-restore': 'offline-backup',
    build: 'release-bundle',
    signing: 'release-bundle',
    installer: 'windows-installer',
    'provider-drill': 'database-recovery-receipt',
    'long-run-soak': 'long-run-receipt',
  };
  const expected = expectedKinds[requirement.category];
  return expected
    ? evidence.artifactEvidence?.kind === expected
    : evidence.artifactEvidence === null;
}

function blockedResult(code, catalog, receipts, categories, requirementCount) {
  return {
    catalogDigest: catalog.catalogDigest,
    code,
    evidenceReceiptCount: receipts,
    formatVersion: RELEASE_ACCEPTANCE_FORMAT_VERSION,
    kind: 'kodex_release_readiness',
    ok: false,
    pendingCategories: [...categories].sort(),
    pendingRequirementCount: requirementCount,
    readiness: 'blocked',
  };
}

export async function evaluateReleaseReadiness(options) {
  if (!isRecord(options) || !isRecord(options.catalog)) fail('readiness_options_invalid');
  const catalog = options.catalog;
  const identity = parseRepositoryIdentity(options.repositoryIdentity);
  const evaluatedAt = options.evaluatedAt ?? new Date().toISOString();
  if (!canonicalTimestamp(evaluatedAt)) fail('evaluation_time_invalid');
  const parsedReceipts = options.evidenceReceipts ?? [];
  if (!Array.isArray(parsedReceipts) || parsedReceipts.length > MAX_EVIDENCE_FILES) fail('evidence_limit_exceeded');
  const allCategories = new Set([...catalog.requirements.values()].map((requirement) => requirement.category));
  if (identity.dirty) return blockedResult('repository_dirty', catalog, parsedReceipts.length, allCategories, catalog.requirements.size);
  const byRequirement = new Map();
  for (const parsed of parsedReceipts) {
    if (!isRecord(parsed) || !isRecord(parsed.evidence)) fail('evidence_contract_invalid');
    const evidence = parseReleaseAcceptanceEvidence(parsed.evidence);
    if (byRequirement.has(evidence.evidence.requirementId)) fail('evidence_duplicate');
    if (!catalog.requirements.has(evidence.evidence.requirementId)) fail('evidence_unknown');
    byRequirement.set(evidence.evidence.requirementId, evidence);
  }
  const pending = new Set();
  let pendingRequirementCount = 0;
  let firstFailure = null;
  const expectedIdentity = identityFields(identity, catalog.catalogDigest);
  for (const requirement of catalog.requirements.values()) {
    const parsed = byRequirement.get(requirement.id);
    if (!parsed) {
      pending.add(requirement.category);
      pendingRequirementCount += 1;
      continue;
    }
    const evidence = parsed.evidence;
    let failure = null;
    if (!requirement.commandIds.includes(evidence.commandId) || !requirement.evidenceTypes.includes(evidence.evidenceType)) {
      failure = 'evidence_mismatch';
    } else if (canonicalReleaseAcceptanceJson(evidence.release) !== canonicalReleaseAcceptanceJson(expectedIdentity)) {
      failure = 'evidence_mismatch';
    } else if (evidence.resultCode !== 'passed' || evidence.testCounts.failed !== 0 || evidence.testCounts.passed < 1) {
      failure = 'evidence_failed';
    } else if (!artifactMatchesRequirement(requirement, evidence)) {
      failure = 'evidence_mismatch';
    } else {
      const age = Date.parse(evaluatedAt) - Date.parse(evidence.completedAt);
      if (age < 0) failure = 'evidence_from_future';
      else if (age > requirement.maximumAgeHours * 3_600_000) failure = 'evidence_stale';
    }
    if (!failure) {
      try { await validateEvidenceSignature(parsed, catalog, options.trustStorePath); } catch (error) {
        if (error instanceof ReleaseAcceptanceError) failure = error.code;
        else failure = 'evidence_signature_invalid';
      }
    }
    if (!failure && !sourceMatches(requirement, evidence, options.sourceEvidence)) {
      failure = 'evidence_source_unverified';
    }
    if (failure) {
      pending.add(requirement.category);
      pendingRequirementCount += 1;
      firstFailure ??= failure;
    }
  }
  if (pending.size > 0) {
    return blockedResult(firstFailure ?? 'release_evidence_pending', catalog, parsedReceipts.length, pending, pendingRequirementCount);
  }
  return {
    catalogDigest: catalog.catalogDigest,
    code: 'release_ready',
    evidenceReceiptCount: parsedReceipts.length,
    formatVersion: RELEASE_ACCEPTANCE_FORMAT_VERSION,
    kind: 'kodex_release_readiness',
    ok: true,
    pendingCategories: [],
    pendingRequirementCount: 0,
    readiness: 'ready',
  };
}

export async function collectReleaseSourceEvidence(options) {
  const output = {};
  if (options.releaseArtifactPath !== undefined) {
    if (!path.isAbsolute(options.releaseArtifactPath) || !path.isAbsolute(options.trustStorePath ?? '')) fail('source_input_invalid');
    const verified = await verifyReleaseArtifact(options.releaseArtifactPath, { trustStorePath: options.trustStorePath })
      .catch(() => fail('release_artifact_unverified'));
    const manifest = await verifyReleaseArtifactIntegrity(options.releaseArtifactPath)
      .catch(() => fail('release_artifact_unverified'));
    if (
      manifest.release.commit !== options.repositoryIdentity.commit
      || manifest.release.version !== options.repositoryIdentity.version
      || manifest.codex.upstreamCommit !== options.repositoryIdentity.codexUpstreamCommit
      || manifest.codex.vendorManifestSha256 !== options.repositoryIdentity.vendorManifestSha256
      || digest(manifest.database.migrations) !== options.repositoryIdentity.migrationLedgerDigest
    ) fail('release_artifact_mismatch');
    output.releaseArtifact = {
      keyId: verified.keyId,
      manifestSha256: verified.manifestSha256,
      signatureDigest: await sha256File(path.join(options.releaseArtifactPath, RELEASE_SIGNATURE_FILENAME)),
      trustStoreVersion: verified.trustStoreVersion,
    };
  }
  if (options.installRoot !== undefined) {
    if (!output.releaseArtifact || !path.isAbsolute(options.installRoot) || !path.isAbsolute(options.installerLayoutPath)) {
      fail('installer_source_unverified');
    }
    const status = await windowsInstallerStatus({
      installRoot: options.installRoot,
      layoutPath: options.installerLayoutPath,
    }).catch(() => fail('installer_source_unverified'));
    if (typeof status.activeReleaseId !== 'string') fail('installer_source_unverified');
    const installedRoot = path.join(options.installRoot, 'releases', status.activeReleaseId);
    const installed = await verifyReleaseArtifact(installedRoot, { trustStorePath: options.trustStorePath })
      .catch(() => fail('installer_source_unverified'));
    const installedSignatureDigest = await sha256File(path.join(installedRoot, RELEASE_SIGNATURE_FILENAME))
      .catch(() => fail('installer_source_unverified'));
    if (
      installed.manifestSha256 !== output.releaseArtifact.manifestSha256
      || installed.keyId !== output.releaseArtifact.keyId
      || installed.trustStoreVersion !== output.releaseArtifact.trustStoreVersion
      || installedSignatureDigest !== output.releaseArtifact.signatureDigest
    ) fail('installer_source_unverified');
    output.installer = {
      ...status,
      expectedReleaseId: `Kodex-${options.repositoryIdentity.version}-windows-x64-${options.repositoryIdentity.commit.slice(0, 12)}`,
      installerTrustStoreVersion: status.trustStoreVersion,
      keyId: output.releaseArtifact.keyId,
      manifestSha256: output.releaseArtifact.manifestSha256,
      releaseTrustStoreVersion: output.releaseArtifact.trustStoreVersion,
      signatureDigest: output.releaseArtifact.signatureDigest,
    };
  }
  if (options.recoveryReceiptPath !== undefined) {
    if (!path.isAbsolute(options.recoveryReceiptPath) || !path.isAbsolute(options.trustStorePath ?? '')) fail('source_input_invalid');
    const policy = parseDatabaseRecoveryPolicy(options.recoveryPolicy.policy ?? options.recoveryPolicy);
    const receipt = await readDatabaseRecoveryReceipt(options.recoveryReceiptPath);
    await validateDatabaseRecoveryReceipt(policy, receipt, options.evaluatedAt, options.trustStorePath)
      .catch(() => fail('provider_recovery_unverified'));
    const signature = Buffer.from(receipt.receipt.artifactSignature.signature, 'base64');
    try {
      output.providerRecovery = {
        keyId: receipt.receipt.artifactSignature.keyId,
        receiptDigest: receipt.receiptDigest,
        signatureDigest: createHash('sha256').update(signature).digest('hex'),
        trustStoreVersion: receipt.receipt.artifactSignature.trustVersion,
      };
    } finally {
      signature.fill(0);
    }
  }
  if (options.soakReceiptPath !== undefined) {
    if (!path.isAbsolute(options.soakReceiptPath)) fail('source_input_invalid');
    output.soak = await readLongRunReceipt(options.soakReceiptPath).catch(() => fail('soak_receipt_unverified'));
  }
  return output;
}

export async function releaseReadinessFromRepository(options) {
  if (!isRecord(options) || typeof options.repositoryRoot !== 'string' || !path.isAbsolute(options.repositoryRoot)) {
    fail('readiness_options_invalid');
  }
  const repositoryRoot = path.resolve(options.repositoryRoot);
  const catalog = await readReleaseAcceptanceCatalog(path.join(repositoryRoot, 'config', 'release-acceptance-catalog.json'));
  const repositoryIdentity = await collectReleaseRepositoryIdentity(repositoryRoot);
  let evidenceReceipts = [];
  if (options.evidenceDirectory !== undefined) {
    const evidenceRoot = path.resolve(options.evidenceDirectory);
    const relative = path.relative(repositoryRoot, evidenceRoot);
    if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) fail('evidence_directory_must_be_external');
    evidenceReceipts = await evidenceDirectory(evidenceRoot);
  }
  const evaluatedAt = options.evaluatedAt ?? new Date().toISOString();
  let recoveryPolicy;
  try { recoveryPolicy = await readDatabaseRecoveryPolicy(path.join(repositoryRoot, 'config', 'database-recovery-policy.json')); }
  catch { fail('repository_identity_invalid'); }
  let sourceEvidence = {};
  if (evidenceReceipts.length > 0) {
    if (typeof options.trustStorePath !== 'string' || !path.isAbsolute(options.trustStorePath)) fail('evidence_trust_store_invalid');
    const trustRelative = path.relative(repositoryRoot, path.resolve(options.trustStorePath));
    if (trustRelative === '' || (!trustRelative.startsWith('..') && !path.isAbsolute(trustRelative))) {
      fail('evidence_trust_store_must_be_external');
    }
  }
  if ([options.releaseArtifactPath, options.installRoot, options.recoveryReceiptPath, options.soakReceiptPath]
    .some((entry) => entry !== undefined)) {
    if (typeof options.trustStorePath !== 'string' || !path.isAbsolute(options.trustStorePath)) fail('evidence_trust_store_invalid');
    const trustRelative = path.relative(repositoryRoot, path.resolve(options.trustStorePath));
    if (trustRelative === '' || (!trustRelative.startsWith('..') && !path.isAbsolute(trustRelative))) {
      fail('evidence_trust_store_must_be_external');
    }
    sourceEvidence = await collectReleaseSourceEvidence({
      ...options,
      evaluatedAt,
      installerLayoutPath: path.join(repositoryRoot, 'config', 'windows-installer-layout.json'),
      recoveryPolicy,
      repositoryIdentity,
    });
  }
  return evaluateReleaseReadiness({
    catalog,
    evaluatedAt,
    evidenceReceipts,
    repositoryIdentity,
    sourceEvidence,
    trustStorePath: options.trustStorePath,
  });
}

export const ACCEPTANCE_SCHEMA_SHA256 = Object.freeze({
  'long-run-acceptance-config.schema.json': '361471e77891861a70d0050714acd8f4999bea9f06cd1043ca544013edb35d45',
  'long-run-acceptance-receipt.schema.json': 'ae78ac730b3c86f3b27f41ef9cd4ca8dff3de28c8720714ae1ac9d369e29c4d8',
  'long-run-acceptance-scenarios.schema.json': '5b99243c9d31ff8859410e73d1ca24660a908f45283682e05ee4695e011df7ba',
  'long-run-acceptance-state.schema.json': '4c155f81593dd433725c601c54f5bc5260f6551f57f50154d0b48efbc7e94329',
  'release-acceptance-catalog.schema.json': '25e9ef8e1fdc814db4d9a0dc7e55e13d5d81a836679220be25a1134d6b907519',
  'release-acceptance-evidence.schema.json': '808b29ddc5f3808ad3f1ef454d4cd65411c43dc4fdd024fad416cef80d868bf0',
});

const DOCUMENT_CONTRACTS = [
  ['README.md', ['Phase 36', 'acceptance:validate', 'release:readiness', 'acceptance:long-run']],
  ['docs/HANDOFF.md', ['Phase 36', 'release_evidence_pending', 'long-run acceptance']],
  ['docs/adr/0035-long-run-and-release-acceptance.md', ['Phase 36', 'Ed25519', 'fail-closed']],
  ['docs/operations/long-run-acceptance.md', ['SIGINT', 'duplicate_runner', '12', '72']],
  ['docs/operations/final-release-checklist.md', ['release:readiness', 'provider drill', 'long-run soak']],
  ['docs/operations/release-acceptance-matrix.md', ['REL-001', 'REL-018', 'Phase 1', 'Phase 36']],
  ['docs/operations/deployment-upgrade.md', ['release:readiness']],
  ['docs/operations/security-release.md', ['release-acceptance-catalog.json']],
  ['docs/operations/observability.md', ['payload-free aggregate metrics']],
  ['docs/security/threat-model.md', ['long-run acceptance', 'release readiness evidence']],
];

export async function verifyAcceptanceRepositoryContracts(repositoryRoot) {
  if (typeof repositoryRoot !== 'string' || !path.isAbsolute(repositoryRoot)) fail('repository_contract_invalid');
  const root = path.resolve(repositoryRoot);
  const catalog = await readReleaseAcceptanceCatalog(path.join(root, 'config', 'release-acceptance-catalog.json'));
  if (catalog.commands.size !== Object.keys(RELEASE_ACCEPTANCE_COMMAND_ALLOWLIST).length) fail('repository_contract_invalid');
  let longRunCatalog;
  try {
    longRunCatalog = parseLongRunScenarioCatalog(await readBoundedJson(
      path.join(root, 'config', 'long-run-acceptance-scenarios.json'), 'repository_contract_invalid',
    ));
  } catch {
    fail('repository_contract_invalid');
  }
  if ([...longRunCatalog.scenarios.values()].some((scenario) => scenario.minimumDurationSeconds < 43_200)) {
    fail('repository_contract_invalid');
  }
  for (const [name, expected] of Object.entries(ACCEPTANCE_SCHEMA_SHA256)) {
    if (expected === 'PLACEHOLDER') fail('repository_contract_invalid');
    const schema = await readBoundedJson(path.join(root, 'config', name), 'repository_contract_invalid');
    if (digest(schema) !== expected) fail('repository_contract_invalid');
  }
  let packageJson;
  try { packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')); }
  catch { fail('repository_contract_invalid'); }
  const expectedScripts = {
    'acceptance:long-run': 'node scripts/kodex-long-run-acceptance.mjs',
    'acceptance:validate': 'node scripts/acceptance-validate.mjs',
    'release:readiness': 'node scripts/kodex-release-acceptance.mjs status',
    'test:long-run-acceptance': 'node scripts/test-long-run-acceptance.mjs',
    'test:release-acceptance': 'node scripts/test-release-acceptance.mjs',
  };
  if (Object.entries(expectedScripts).some(([name, command]) => packageJson?.scripts?.[name] !== command)) {
    fail('repository_contract_invalid');
  }
  await migrationLedger(root);
  for (const [relative, required] of DOCUMENT_CONTRACTS) {
    let content;
    try { content = await readFile(path.join(root, ...relative.split('/')), 'utf8'); }
    catch { fail('documentation_contract_invalid'); }
    if (required.some((text) => !content.includes(text))) fail('documentation_contract_invalid');
  }
  return {
    catalogDigest: catalog.catalogDigest,
    commandCount: catalog.commands.size,
    documentContractCount: DOCUMENT_CONTRACTS.length,
    formatVersion: RELEASE_ACCEPTANCE_FORMAT_VERSION,
    longRunScenarioCount: longRunCatalog.scenarios.size,
    requirementCount: catalog.requirements.size,
    schemaContractCount: Object.keys(ACCEPTANCE_SCHEMA_SHA256).length,
  };
}
