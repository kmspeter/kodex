import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  constants,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {
  readCanonicalReleaseManifest,
} from './release-artifact.mjs';
import { verifyReleaseArtifact } from './release-signature.mjs';
import { scanReleaseInputSecrets, sha256File } from './security-validation.mjs';

export const WINDOWS_INSTALLER_FORMAT_VERSION = 1;
export const WINDOWS_RELEASE_COMPATIBILITY_PATH = 'resources/app/metadata/installer-compatibility.json';

const MAX_JSON_BYTES = 1024 * 1024;
const RELEASE_ID = /^Kodex-(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?-windows-x64-[a-f0-9]{12}$/u;
const STAGING_ID = /^\.staging-[0-9a-f-]{36}$/u;
const REMOVED_ID = /^\.removed-[0-9a-f-]{36}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_INSTALL_ENTRIES = 200_000;
const POINTER_FORMAT = 'kodex-windows-release-pointer';
const JOURNAL_FORMAT = 'kodex-windows-installer-transaction';
const LOCK_FORMAT = 'kodex-windows-installer-lock';
const RECEIPT_FORMAT = 'kodex-windows-trust-store-receipt';

export class WindowsInstallerError extends Error {
  constructor(code) {
    super(`Kodex Windows installer failed (${code}).`);
    this.name = 'WindowsInstallerError';
    this.code = code;
  }
}

function fail(code) {
  throw new WindowsInstallerError(code);
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

function canonicalBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function samePath(left, right) {
  const normalize = (value) => process.platform === 'win32'
    ? path.resolve(value).toLowerCase()
    : path.resolve(value);
  return normalize(left) === normalize(right);
}

function isWithin(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function safeAbsoluteRoot(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) fail('absolute_install_root_required');
  const root = path.resolve(value);
  if (samePath(root, path.parse(root).root) || samePath(root, os.homedir())) fail('unsafe_install_root');
  return root;
}

async function boundedRegularFile(filename, name) {
  let metadata;
  try {
    metadata = await lstat(filename);
  } catch {
    fail(`${name}_missing`);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 || metadata.size > MAX_JSON_BYTES) {
    fail(`${name}_unsafe`);
  }
  return readFile(filename);
}

function parseJson(bytes, name) {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    fail(`${name}_invalid`);
  }
}

export async function loadWindowsInstallerLayout(filename) {
  const value = parseJson(await boundedRegularFile(filename, 'layout'), 'layout');
  if (
    !exactKeys(value, ['adapters', 'arch', 'directories', 'externalData', 'files', 'format', 'formatVersion', 'platform', 'retention', 'scope'])
    || value.format !== 'kodex-windows-installer-layout'
    || value.formatVersion !== WINDOWS_INSTALLER_FORMAT_VERSION
    || value.scope !== 'per-user'
    || value.platform !== 'win32'
    || value.arch !== 'x64'
    || !exactKeys(value.directories, ['releases', 'state'])
    || value.directories.releases !== 'releases'
    || value.directories.state !== '.installer-state'
    || !exactKeys(value.files, ['current', 'journal', 'lastKnownGood', 'lock', 'rollbackCandidate', 'trustStoreReceipt'])
    || JSON.stringify(value.files) !== JSON.stringify({
      current: 'current.json',
      journal: 'transaction.json',
      lastKnownGood: 'last-known-good.json',
      lock: 'installer.lock',
      rollbackCandidate: 'rollback-candidate.json',
      trustStoreReceipt: 'trust-store-receipt.json',
    })
    || !exactKeys(value.retention, ['maximumReleases'])
    || !Number.isSafeInteger(value.retention.maximumReleases)
    || value.retention.maximumReleases < 3
    || value.retention.maximumReleases > 10
    || JSON.stringify(value.externalData) !== JSON.stringify([
      'tenant-data', 'codex-home', 'postgresql-data', 'operator-backups', 'kodex-env',
    ])
    || JSON.stringify(value.adapters) !== JSON.stringify([
      'windows-acl-verifier', 'process-lifecycle', 'service-manager', 'registry', 'shortcuts', 'packaging-code-removal',
    ])
  ) fail('layout_invalid');
  return value;
}

function installerPaths(installRoot, layout) {
  const root = safeAbsoluteRoot(installRoot);
  const releases = path.join(root, layout.directories.releases);
  const state = path.join(root, layout.directories.state);
  return {
    root,
    releases,
    state,
    current: path.join(state, layout.files.current),
    journal: path.join(state, layout.files.journal),
    lastKnownGood: path.join(state, layout.files.lastKnownGood),
    lock: path.join(state, layout.files.lock),
    rollbackCandidate: path.join(state, layout.files.rollbackCandidate),
    trustStoreReceipt: path.join(state, layout.files.trustStoreReceipt),
  };
}

async function assertTreeStructure(root) {
  const resolved = path.resolve(root);
  let rootMetadata;
  try {
    rootMetadata = await lstat(resolved);
  } catch {
    fail('filesystem_entry_inaccessible');
  }
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) fail('reparse_or_special_file_rejected');
  let actualRoot;
  try {
    actualRoot = await realpath(resolved);
  } catch {
    fail('filesystem_entry_inaccessible');
  }
  if (!samePath(actualRoot, resolved)) fail('reparse_or_special_file_rejected');
  const pending = [resolved];
  let inspectedEntries = 0;
  while (pending.length > 0) {
    const parent = pending.pop();
    let entries;
    try {
      entries = await readdir(parent, { withFileTypes: true });
    } catch {
      fail('filesystem_entry_inaccessible');
    }
    for (const entry of entries) {
      inspectedEntries += 1;
      if (inspectedEntries > MAX_INSTALL_ENTRIES) fail('install_entry_limit_exceeded');
      const child = path.join(parent, entry.name);
      const metadata = await lstat(child).catch(() => fail('filesystem_entry_inaccessible'));
      if (metadata.isSymbolicLink() || (!metadata.isDirectory() && !metadata.isFile())) {
        fail('reparse_or_special_file_rejected');
      }
      const actual = await realpath(child).catch(() => fail('filesystem_entry_inaccessible'));
      if (!isWithin(resolved, actual) || !samePath(actual, child)) fail('reparse_or_special_file_rejected');
      if (metadata.isDirectory()) pending.push(child);
    }
  }
}

async function assertDirectoryBoundary(directory) {
  const resolved = path.resolve(directory);
  const metadata = await lstat(resolved).catch(() => fail('filesystem_entry_inaccessible'));
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) fail('reparse_or_special_file_rejected');
  const actual = await realpath(resolved).catch(() => fail('filesystem_entry_inaccessible'));
  if (!samePath(actual, resolved)) fail('reparse_or_special_file_rejected');
}

async function assertAcl(adapter, root, purpose) {
  if (!adapter || typeof adapter.assertSafeTree !== 'function') fail('acl_adapter_required');
  let result;
  try {
    result = await adapter.assertSafeTree(path.resolve(root), purpose);
  } catch {
    fail('unsafe_acl_or_acl_unavailable');
  }
  if (result !== true) fail('unsafe_acl_or_acl_unavailable');
}

export async function createExternalWindowsAclAdapter(executable) {
  if (typeof executable !== 'string' || !path.isAbsolute(executable)) fail('acl_adapter_invalid');
  const filename = path.resolve(executable);
  const metadata = await lstat(filename).catch(() => fail('acl_adapter_invalid'));
  if (!metadata.isFile() || metadata.isSymbolicLink()) fail('acl_adapter_invalid');
  return {
    executablePath: filename,
    async assertSafeTree(root, purpose) {
      const result = spawnSync(filename, [], {
        env: {
          KODEX_ACL_INSPECTION_PURPOSE: purpose,
          KODEX_ACL_INSPECTION_ROOT: root,
          SystemRoot: process.env.SystemRoot,
          WINDIR: process.env.WINDIR,
        },
        shell: false,
        stdio: 'ignore',
        windowsHide: true,
      });
      return result.status === 0;
    },
  };
}

function parseCompatibility(value, manifest) {
  if (
    !exactKeys(value, ['database', 'format', 'formatVersion'])
    || value.format !== 'kodex-windows-release-compatibility'
    || value.formatVersion !== WINDOWS_INSTALLER_FORMAT_VERSION
    || !exactKeys(value.database, [
      'latestSchemaVersion', 'maximumReadableSchemaVersion', 'migrationStrategy', 'minimumReadableSchemaVersion',
    ])
    || value.database.migrationStrategy !== 'forward-only'
    || !Number.isSafeInteger(value.database.latestSchemaVersion)
    || !Number.isSafeInteger(value.database.minimumReadableSchemaVersion)
    || !Number.isSafeInteger(value.database.maximumReadableSchemaVersion)
    || value.database.minimumReadableSchemaVersion < 1
    || value.database.minimumReadableSchemaVersion > value.database.maximumReadableSchemaVersion
    || value.database.latestSchemaVersion < value.database.minimumReadableSchemaVersion
    || value.database.latestSchemaVersion > value.database.maximumReadableSchemaVersion
    || value.database.latestSchemaVersion !== manifest.database.migrations.at(-1)?.version
  ) fail('compatibility_metadata_invalid');
  return value;
}

async function readCompatibility(releaseRoot, manifest) {
  const filename = path.join(releaseRoot, ...WINDOWS_RELEASE_COMPATIBILITY_PATH.split('/'));
  const bytes = await boundedRegularFile(filename, 'compatibility_metadata');
  const value = parseJson(bytes, 'compatibility_metadata');
  parseCompatibility(value, manifest);
  if (!bytes.equals(canonicalBytes(value))) fail('compatibility_metadata_noncanonical');
  return value;
}

async function externalTrustStore(candidate, installRoot, trustStorePath) {
  if (typeof trustStorePath !== 'string' || !path.isAbsolute(trustStorePath)) fail('absolute_trust_store_required');
  const trust = path.resolve(trustStorePath);
  if (isWithin(candidate, trust) || isWithin(installRoot, trust)) fail('external_trust_store_required');
  const actualTrust = await realpath(trust).catch(() => fail('external_trust_store_required'));
  const actualCandidate = await realpath(candidate).catch(() => fail('candidate_inaccessible'));
  if (isWithin(actualCandidate, actualTrust)) fail('external_trust_store_required');
  return trust;
}

async function inspectCandidate({ aclAdapter, candidate, installRoot, requireReleaseBasename = true, trustStorePath }) {
  const releaseRoot = path.resolve(candidate);
  if (
    typeof aclAdapter?.executablePath === 'string'
    && (isWithin(releaseRoot, aclAdapter.executablePath) || isWithin(installRoot, aclAdapter.executablePath))
  ) fail('external_acl_adapter_required');
  const trust = await externalTrustStore(releaseRoot, installRoot, trustStorePath);
  let verified;
  try {
    // Authenticity is intentionally the first content inspection gate.
    verified = await verifyReleaseArtifact(releaseRoot, { trustStorePath: trust });
  } catch {
    fail('release_authenticity_verification_failed');
  }
  try {
    await scanReleaseInputSecrets(releaseRoot);
  } catch {
    fail('release_secret_gate_failed');
  }
  await assertTreeStructure(releaseRoot);
  await assertAcl(aclAdapter, releaseRoot, 'signed-release-candidate');
  const releaseId = `Kodex-${verified.manifest.release.version}-windows-x64-${verified.manifest.release.commit.slice(0, 12)}`;
  if (!RELEASE_ID.test(releaseId) || (requireReleaseBasename && path.basename(releaseRoot) !== releaseId)) {
    fail('release_identity_invalid');
  }
  const compatibility = await readCompatibility(releaseRoot, verified.manifest);
  return {
    compatibility,
    keyId: verified.keyId,
    manifest: verified.manifest,
    manifestSha256: verified.manifestSha256,
    releaseId,
    trustStoreSha256: await sha256File(trust),
    trustStoreVersion: verified.trustStoreVersion,
  };
}

function parsePointer(value) {
  if (
    !exactKeys(value, ['format', 'formatVersion', 'generation', 'releaseId', 'updatedAt'])
    || value.format !== POINTER_FORMAT
    || value.formatVersion !== WINDOWS_INSTALLER_FORMAT_VERSION
    || !Number.isSafeInteger(value.generation)
    || value.generation < 1
    || typeof value.releaseId !== 'string'
    || !RELEASE_ID.test(value.releaseId)
    || typeof value.updatedAt !== 'string'
    || new Date(value.updatedAt).toISOString() !== value.updatedAt
  ) fail('installer_pointer_invalid');
  return value;
}

function parseReceipt(value) {
  if (
    !exactKeys(value, ['format', 'formatVersion', 'sha256', 'storeVersion', 'updatedAt'])
    || value.format !== RECEIPT_FORMAT
    || value.formatVersion !== WINDOWS_INSTALLER_FORMAT_VERSION
    || !Number.isSafeInteger(value.storeVersion)
    || value.storeVersion < 1
    || typeof value.sha256 !== 'string'
    || !SHA256.test(value.sha256)
    || typeof value.updatedAt !== 'string'
    || new Date(value.updatedAt).toISOString() !== value.updatedAt
  ) fail('trust_store_receipt_invalid');
  return value;
}

function parseJournal(value) {
  if (
    !exactKeys(value, [
      'automaticRollbackAllowed', 'createdAt', 'databaseSchemaVersion', 'format', 'formatVersion',
      'fromReleaseId', 'id', 'operation', 'phase', 'toReleaseId', 'updatedAt',
    ])
    || value.format !== JOURNAL_FORMAT
    || value.formatVersion !== WINDOWS_INSTALLER_FORMAT_VERSION
    || !/^[0-9a-f-]{36}$/u.test(value.id)
    || !['activate', 'rollback'].includes(value.operation)
    || !['prepared', 'awaiting-health', 'confirming', 'rolling-back'].includes(value.phase)
    || (value.fromReleaseId !== null && (typeof value.fromReleaseId !== 'string' || !RELEASE_ID.test(value.fromReleaseId)))
    || typeof value.toReleaseId !== 'string'
    || !RELEASE_ID.test(value.toReleaseId)
    || !Number.isSafeInteger(value.databaseSchemaVersion)
    || value.databaseSchemaVersion < 1
    || typeof value.automaticRollbackAllowed !== 'boolean'
    || typeof value.createdAt !== 'string'
    || new Date(value.createdAt).toISOString() !== value.createdAt
    || typeof value.updatedAt !== 'string'
    || new Date(value.updatedAt).toISOString() !== value.updatedAt
  ) fail('installer_journal_invalid');
  return value;
}

function parseLock(value) {
  if (
    !exactKeys(value, ['createdAt', 'format', 'formatVersion', 'id', 'pid'])
    || value.format !== LOCK_FORMAT
    || value.formatVersion !== WINDOWS_INSTALLER_FORMAT_VERSION
    || !/^[0-9a-f-]{36}$/u.test(value.id)
    || !Number.isSafeInteger(value.pid)
    || value.pid < 1
    || typeof value.createdAt !== 'string'
    || new Date(value.createdAt).toISOString() !== value.createdAt
  ) fail('installer_lock_invalid');
  return value;
}

async function readState(filename, parser, missing = null) {
  let bytes;
  try {
    bytes = await boundedRegularFile(filename, 'installer_state');
  } catch (error) {
    if (error instanceof WindowsInstallerError && error.code === 'installer_state_missing') return missing;
    throw error;
  }
  const value = parser(parseJson(bytes, 'installer_state'));
  if (!bytes.equals(canonicalBytes(value))) fail('installer_state_noncanonical');
  return value;
}

async function atomicWrite(filename, value) {
  const temporary = path.join(path.dirname(filename), `.${path.basename(filename)}.${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', 0o600).catch(() => fail('atomic_write_failed'));
  try {
    await handle.writeFile(canonicalBytes(value));
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, filename);
  } catch {
    await rm(temporary, { force: true });
    fail('atomic_write_failed');
  }
}

async function atomicRemove(filename) {
  let metadata;
  try {
    metadata = await lstat(filename);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    fail('atomic_remove_failed');
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) fail('atomic_remove_failed');
  const tombstone = path.join(path.dirname(filename), `.${path.basename(filename)}.${randomUUID()}.removed`);
  await rename(filename, tombstone).catch(() => fail('atomic_remove_failed'));
  await rm(tombstone, { force: true });
}

async function ensureInstallRoot(paths, aclAdapter) {
  try {
    await lstat(paths.root);
  } catch (error) {
    if (error?.code !== 'ENOENT') fail('install_root_inaccessible');
    const parent = path.dirname(paths.root);
    await assertDirectoryBoundary(parent);
    await assertAcl(aclAdapter, parent, 'install-root-parent');
    await mkdir(paths.root, { mode: 0o700 }).catch(() => fail('install_root_create_failed'));
  }
  await assertTreeStructure(paths.root);
  await assertAcl(aclAdapter, paths.root, 'install-root');
  for (const directory of [paths.releases, paths.state]) {
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== 'EEXIST') fail('install_layout_create_failed');
    }
    const metadata = await lstat(directory).catch(() => fail('install_layout_invalid'));
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) fail('install_layout_invalid');
  }
  await assertTreeStructure(paths.root);
  await assertAcl(aclAdapter, paths.root, 'install-root');
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

async function acquireLock(paths, recoverStale) {
  const value = {
    format: LOCK_FORMAT,
    formatVersion: WINDOWS_INSTALLER_FORMAT_VERSION,
    id: randomUUID(),
    pid: process.pid,
    createdAt: new Date().toISOString(),
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let handle;
    try {
      handle = await open(paths.lock, 'wx', 0o600);
      await handle.writeFile(canonicalBytes(value));
      await handle.sync();
      await handle.close();
      return value;
    } catch (error) {
      await handle?.close();
      if (error?.code !== 'EEXIST') fail('installer_lock_failed');
      if (!recoverStale || attempt > 0) fail('installer_busy');
      const existing = await readState(paths.lock, parseLock);
      if (processAlive(existing.pid)) fail('installer_busy');
      await atomicRemove(paths.lock);
    }
  }
  fail('installer_busy');
}

async function releaseLock(paths, owned) {
  const existing = await readState(paths.lock, parseLock, null).catch(() => null);
  if (existing?.id === owned.id) await atomicRemove(paths.lock);
}

async function withLock(paths, recoverStale, action) {
  const owned = await acquireLock(paths, recoverStale);
  try {
    return await action();
  } finally {
    await releaseLock(paths, owned);
  }
}

function pointer(releaseId, generation) {
  return {
    format: POINTER_FORMAT,
    formatVersion: WINDOWS_INSTALLER_FORMAT_VERSION,
    generation,
    releaseId,
    updatedAt: new Date().toISOString(),
  };
}

function readableAt(compatibility, schemaVersion) {
  const database = compatibility.database;
  return schemaVersion >= database.minimumReadableSchemaVersion
    && schemaVersion <= database.maximumReadableSchemaVersion;
}

async function assertTrustReceipt(paths, candidate, write) {
  const current = await readState(paths.trustStoreReceipt, parseReceipt, null);
  if (
    current
    && (candidate.trustStoreVersion < current.storeVersion
      || (candidate.trustStoreVersion === current.storeVersion && candidate.trustStoreSha256 !== current.sha256))
  ) fail('trust_store_rollback_rejected');
  if (write && (!current || candidate.trustStoreVersion > current.storeVersion)) {
    await atomicWrite(paths.trustStoreReceipt, {
      format: RECEIPT_FORMAT,
      formatVersion: WINDOWS_INSTALLER_FORMAT_VERSION,
      storeVersion: candidate.trustStoreVersion,
      sha256: candidate.trustStoreSha256,
      updatedAt: new Date().toISOString(),
    });
  }
}

async function copyTree(source, destination) {
  await mkdir(destination, { mode: 0o700 });
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const sourceChild = path.join(source, entry.name);
    const destinationChild = path.join(destination, entry.name);
    const metadata = await lstat(sourceChild);
    if (metadata.isSymbolicLink() || (!metadata.isDirectory() && !metadata.isFile())) {
      fail('reparse_or_special_file_rejected');
    }
    if (metadata.isDirectory()) await copyTree(sourceChild, destinationChild);
    else await copyFile(sourceChild, destinationChild, constants.COPYFILE_EXCL);
  }
}

async function installedCandidate(paths, releaseId, trustStorePath, aclAdapter) {
  if (typeof releaseId !== 'string' || !RELEASE_ID.test(releaseId)) fail('release_id_invalid');
  return inspectCandidate({
    aclAdapter,
    candidate: path.join(paths.releases, releaseId),
    installRoot: paths.root,
    trustStorePath,
  });
}

async function removeOwnedTree(paths, target, aclAdapter, allowedName) {
  const resolved = path.resolve(target);
  if (path.dirname(resolved) !== paths.releases || !allowedName(path.basename(resolved))) fail('exact_root_cleanup_rejected');
  await assertTreeStructure(resolved);
  await assertAcl(aclAdapter, resolved, 'release-cleanup');
  const tombstone = path.join(paths.releases, `.removed-${randomUUID()}`);
  await rename(resolved, tombstone).catch(() => fail('exact_root_cleanup_failed'));
  await rm(tombstone, { recursive: true, force: false }).catch(() => fail('exact_root_cleanup_failed'));
}

async function releaseDirectories(paths) {
  const entries = await readdir(paths.releases, { withFileTypes: true });
  const releases = [];
  const staging = [];
  const removed = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) fail('unexpected_install_entry');
    if (RELEASE_ID.test(entry.name)) releases.push(entry.name);
    else if (STAGING_ID.test(entry.name)) staging.push(entry.name);
    else if (REMOVED_ID.test(entry.name)) removed.push(entry.name);
    else fail('unexpected_install_entry');
  }
  return { releases: releases.sort(), removed: removed.sort(), staging: staging.sort() };
}

async function pruneReleases(paths, layout, aclAdapter, protectedIds) {
  const { releases, removed, staging } = await releaseDirectories(paths);
  if (staging.length > 0) fail('interrupted_staging_requires_recovery');
  if (removed.length > 0) fail('interrupted_cleanup_requires_recovery');
  const candidates = [];
  for (const releaseId of releases) {
    if (protectedIds.has(releaseId)) continue;
    const { manifest } = await readCanonicalReleaseManifest(path.join(paths.releases, releaseId))
      .catch(() => fail('installed_release_invalid'));
    candidates.push({ createdAt: manifest.createdAt, releaseId });
  }
  candidates.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.releaseId.localeCompare(right.releaseId));
  let count = releases.length;
  while (count > layout.retention.maximumReleases && candidates.length > 0) {
    const candidate = candidates.shift();
    await removeOwnedTree(paths, path.join(paths.releases, candidate.releaseId), aclAdapter, (name) => RELEASE_ID.test(name));
    count -= 1;
  }
  if (count > layout.retention.maximumReleases) fail('release_retention_blocked');
  return releases.length - count;
}

async function stateSnapshot(paths) {
  const [current, journal, lastKnownGood, rollbackCandidate, trustStoreReceipt] = await Promise.all([
    readState(paths.current, parsePointer, null),
    readState(paths.journal, parseJournal, null),
    readState(paths.lastKnownGood, parsePointer, null),
    readState(paths.rollbackCandidate, parsePointer, null),
    readState(paths.trustStoreReceipt, parseReceipt, null),
  ]);
  return { current, journal, lastKnownGood, rollbackCandidate, trustStoreReceipt };
}

function commandContext(options) {
  if (!isRecord(options) || typeof options.layoutPath !== 'string') fail('installer_options_invalid');
  return loadWindowsInstallerLayout(options.layoutPath).then((layout) => ({
    layout,
    paths: installerPaths(options.installRoot, layout),
  }));
}

export async function planWindowsInstallerUpdate(options) {
  const { layout, paths } = await commandContext(options);
  const candidate = await inspectCandidate({ ...options, installRoot: paths.root });
  const state = await stateSnapshot(paths).catch((error) => {
    if (error instanceof WindowsInstallerError && error.code === 'installer_state_missing') return null;
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (state) await assertTrustReceipt(paths, candidate, false);
  let automaticRollbackAllowed = null;
  if (state?.current) {
    const previous = await installedCandidate(paths, state.current.releaseId, options.trustStorePath, options.aclAdapter);
    automaticRollbackAllowed = readableAt(previous.compatibility, candidate.compatibility.database.latestSchemaVersion);
  }
  return {
    kind: 'kodex_windows_installer_plan',
    operation: state?.current ? 'update' : 'install',
    releaseId: candidate.releaseId,
    schemaVersion: candidate.compatibility.database.latestSchemaVersion,
    trustStoreVersion: candidate.trustStoreVersion,
    maximumReleases: layout.retention.maximumReleases,
    automaticRollbackAllowed,
    externalDataPreserved: true,
  };
}

export async function stageWindowsInstallerCandidate(options) {
  const { layout, paths } = await commandContext(options);
  const initial = await inspectCandidate({ ...options, installRoot: paths.root });
  await ensureInstallRoot(paths, options.aclAdapter);
  return withLock(paths, false, async () => {
    const candidate = await inspectCandidate({ ...options, installRoot: paths.root });
    if (candidate.manifestSha256 !== initial.manifestSha256) fail('candidate_changed_during_stage');
    await assertTrustReceipt(paths, candidate, false);
    const destination = path.join(paths.releases, candidate.releaseId);
    try {
      await lstat(destination);
      const existing = await installedCandidate(paths, candidate.releaseId, options.trustStorePath, options.aclAdapter);
      if (existing.manifestSha256 !== candidate.manifestSha256) fail('release_id_collision');
      await assertTrustReceipt(paths, existing, true);
      const state = await stateSnapshot(paths);
      const protectedIds = new Set([
        candidate.releaseId,
        state.current?.releaseId,
        state.lastKnownGood?.releaseId,
        state.rollbackCandidate?.releaseId,
      ].filter(Boolean));
      const prunedReleaseCount = await pruneReleases(paths, layout, options.aclAdapter, protectedIds);
      return { kind: 'kodex_windows_installer_staged', releaseId: candidate.releaseId, alreadyStaged: true, prunedReleaseCount };
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const stagingId = `.staging-${randomUUID()}`;
    const staging = path.join(paths.releases, stagingId);
    let moved = false;
    try {
      await copyTree(path.resolve(options.candidate), staging);
      await assertTreeStructure(staging);
      await assertAcl(options.aclAdapter, staging, 'staged-release');
      const staged = await inspectCandidate({
        aclAdapter: options.aclAdapter,
        candidate: staging,
        installRoot: paths.root,
        requireReleaseBasename: false,
        trustStorePath: options.trustStorePath,
      });
      if (staged.manifestSha256 !== candidate.manifestSha256 || staged.releaseId !== candidate.releaseId) {
        fail('staged_candidate_mismatch');
      }
      await rename(staging, destination).catch(() => fail('side_by_side_commit_failed'));
      moved = true;
      await assertTrustReceipt(paths, staged, true);
      const state = await stateSnapshot(paths);
      const protectedIds = new Set([
        candidate.releaseId,
        state.current?.releaseId,
        state.lastKnownGood?.releaseId,
        state.rollbackCandidate?.releaseId,
      ].filter(Boolean));
      const prunedReleaseCount = await pruneReleases(paths, layout, options.aclAdapter, protectedIds);
      return { kind: 'kodex_windows_installer_staged', releaseId: candidate.releaseId, alreadyStaged: false, prunedReleaseCount };
    } finally {
      if (!moved) {
        try {
          await removeOwnedTree(paths, staging, options.aclAdapter, (name) => STAGING_ID.test(name));
        } catch (error) {
          if (error?.code !== 'ENOENT') {
            // Preserve a suspicious partial tree for explicit recover rather than broad deletion.
          }
        }
      }
    }
  });
}

async function beginActivation(paths, operation, fromReleaseId, target, databaseSchemaVersion, automaticRollbackAllowed) {
  const now = new Date().toISOString();
  const journal = {
    format: JOURNAL_FORMAT,
    formatVersion: WINDOWS_INSTALLER_FORMAT_VERSION,
    id: randomUUID(),
    operation,
    phase: 'prepared',
    fromReleaseId,
    toReleaseId: target.releaseId,
    databaseSchemaVersion,
    automaticRollbackAllowed,
    createdAt: now,
    updatedAt: now,
  };
  await atomicWrite(paths.journal, journal);
  const current = await readState(paths.current, parsePointer, null);
  await atomicWrite(paths.current, pointer(target.releaseId, (current?.generation ?? 0) + 1));
  journal.phase = 'awaiting-health';
  journal.updatedAt = new Date().toISOString();
  await atomicWrite(paths.journal, journal);
  return journal;
}

export async function activateWindowsInstallerRelease(options) {
  const { paths } = await commandContext(options);
  const target = await installedCandidate(paths, options.releaseId, options.trustStorePath, options.aclAdapter);
  await ensureInstallRoot(paths, options.aclAdapter);
  return withLock(paths, false, async () => {
    const verified = await installedCandidate(paths, options.releaseId, options.trustStorePath, options.aclAdapter);
    await assertTrustReceipt(paths, verified, true);
    const state = await stateSnapshot(paths);
    if (state.journal) {
      if (
        state.journal.phase === 'awaiting-health'
        && state.journal.toReleaseId === verified.releaseId
        && state.current?.releaseId === verified.releaseId
      ) {
        return {
          kind: 'kodex_windows_installer_activation_pending',
          releaseId: verified.releaseId,
          alreadyActive: true,
          automaticRollbackAllowed: state.journal.automaticRollbackAllowed,
        };
      }
      fail('installer_transaction_pending');
    }
    if (state.current?.releaseId === verified.releaseId) {
      return {
        kind: 'kodex_windows_installer_already_active',
        releaseId: verified.releaseId,
        healthConfirmationRequired: false,
      };
    }
    let automaticRollbackAllowed = false;
    if (state.current) {
      const previous = await installedCandidate(paths, state.current.releaseId, options.trustStorePath, options.aclAdapter);
      automaticRollbackAllowed = readableAt(previous.compatibility, verified.compatibility.database.latestSchemaVersion);
    }
    await beginActivation(
      paths,
      'activate',
      state.current?.releaseId ?? null,
      verified,
      verified.compatibility.database.latestSchemaVersion,
      automaticRollbackAllowed,
    );
    return {
      kind: 'kodex_windows_installer_activation_pending',
      releaseId: verified.releaseId,
      alreadyActive: false,
      automaticRollbackAllowed,
    };
  });
}

async function finishConfirmation(paths, journal) {
  const current = await readState(paths.current, parsePointer, null);
  if (current?.releaseId !== journal.toReleaseId) fail('active_pointer_mismatch');
  if (journal.fromReleaseId) {
    await atomicWrite(paths.rollbackCandidate, pointer(journal.fromReleaseId, current.generation));
  } else {
    await atomicRemove(paths.rollbackCandidate);
  }
  await atomicWrite(paths.lastKnownGood, pointer(journal.toReleaseId, current.generation));
  await atomicRemove(paths.journal);
}

export async function confirmWindowsInstallerRelease(options) {
  const { layout, paths } = await commandContext(options);
  const target = await installedCandidate(paths, options.releaseId, options.trustStorePath, options.aclAdapter);
  if (!Number.isSafeInteger(options.databaseSchemaVersion) || options.databaseSchemaVersion < 1) fail('database_schema_version_invalid');
  if (
    options.databaseSchemaVersion !== target.compatibility.database.latestSchemaVersion
    || !readableAt(target.compatibility, options.databaseSchemaVersion)
  ) fail('database_schema_not_confirmable');
  await ensureInstallRoot(paths, options.aclAdapter);
  return withLock(paths, false, async () => {
    const verified = await installedCandidate(paths, options.releaseId, options.trustStorePath, options.aclAdapter);
    await assertTrustReceipt(paths, verified, true);
    const journal = await readState(paths.journal, parseJournal, null);
    const current = await readState(paths.current, parsePointer, null);
    if (!journal) {
      const confirmed = await readState(paths.lastKnownGood, parsePointer, null);
      if (current?.releaseId === verified.releaseId && confirmed?.releaseId === verified.releaseId) {
        return { kind: 'kodex_windows_installer_confirmed', releaseId: verified.releaseId, alreadyConfirmed: true, prunedReleaseCount: 0 };
      }
      fail('health_confirmation_mismatch');
    }
    if (journal.phase !== 'awaiting-health' || journal.toReleaseId !== verified.releaseId || current?.releaseId !== verified.releaseId) {
      fail('health_confirmation_mismatch');
    }
    journal.phase = 'confirming';
    journal.databaseSchemaVersion = options.databaseSchemaVersion;
    journal.updatedAt = new Date().toISOString();
    await atomicWrite(paths.journal, journal);
    await finishConfirmation(paths, journal);
    const state = await stateSnapshot(paths);
    const protectedIds = new Set([
      state.current?.releaseId, state.lastKnownGood?.releaseId, state.rollbackCandidate?.releaseId,
    ].filter(Boolean));
    const prunedReleaseCount = await pruneReleases(paths, layout, options.aclAdapter, protectedIds);
    return { kind: 'kodex_windows_installer_confirmed', releaseId: verified.releaseId, prunedReleaseCount };
  });
}

async function finishAutomaticRollback(paths, journal, trustStorePath, aclAdapter) {
  const current = await readState(paths.current, parsePointer, null);
  const currentReleaseId = current?.releaseId ?? null;
  if (journal.phase === 'prepared' && currentReleaseId === journal.fromReleaseId) {
    await atomicRemove(paths.journal);
    return { releaseId: journal.fromReleaseId, result: 'activation_not_committed' };
  }
  if (journal.phase === 'confirming') {
    await finishConfirmation(paths, journal);
    return { releaseId: journal.toReleaseId, result: 'confirmation_completed' };
  }
  if (currentReleaseId !== journal.toReleaseId && currentReleaseId !== journal.fromReleaseId) fail('active_pointer_mismatch');
  if (currentReleaseId === journal.fromReleaseId) {
    await atomicRemove(paths.journal);
    return { releaseId: journal.fromReleaseId, result: 'rollback_completed' };
  }
  if (journal.fromReleaseId === null) {
    journal.phase = 'rolling-back';
    journal.updatedAt = new Date().toISOString();
    await atomicWrite(paths.journal, journal);
    await atomicRemove(paths.current);
    await atomicRemove(paths.journal);
    return { releaseId: null, result: 'initial_activation_disabled' };
  }
  const previous = await installedCandidate(paths, journal.fromReleaseId, trustStorePath, aclAdapter);
  if (!journal.automaticRollbackAllowed || !readableAt(previous.compatibility, journal.databaseSchemaVersion)) {
    fail('operator_recovery_required');
  }
  await assertTrustReceipt(paths, previous, true);
  journal.phase = 'rolling-back';
  journal.updatedAt = new Date().toISOString();
  await atomicWrite(paths.journal, journal);
  await atomicWrite(paths.current, pointer(journal.fromReleaseId, (current?.generation ?? 0) + 1));
  await atomicRemove(paths.journal);
  return { releaseId: journal.fromReleaseId, result: 'rollback_completed' };
}

export async function rollbackWindowsInstallerRelease(options) {
  const { paths } = await commandContext(options);
  const before = await stateSnapshot(paths);
  if (before.journal) {
    const verifyId = before.journal.operation === 'rollback'
      ? before.journal.toReleaseId
      : before.journal.fromReleaseId;
    if (verifyId) {
      await installedCandidate(paths, verifyId, options.trustStorePath, options.aclAdapter);
    }
  } else {
    if (!before.rollbackCandidate) fail('rollback_candidate_missing');
    await installedCandidate(paths, before.rollbackCandidate.releaseId, options.trustStorePath, options.aclAdapter);
  }
  await ensureInstallRoot(paths, options.aclAdapter);
  return withLock(paths, false, async () => {
    const state = await stateSnapshot(paths);
    if (state.journal) {
      if (
        state.journal.operation === 'rollback'
        && state.journal.phase === 'awaiting-health'
        && state.current?.releaseId === state.journal.toReleaseId
      ) {
        return {
          kind: 'kodex_windows_installer_rollback_pending',
          releaseId: state.journal.toReleaseId,
          alreadyPending: true,
          automaticRollbackAllowed: state.journal.automaticRollbackAllowed,
        };
      }
      const recovered = await finishAutomaticRollback(paths, state.journal, options.trustStorePath, options.aclAdapter);
      return { kind: 'kodex_windows_installer_rolled_back', ...recovered };
    }
    if (!state.current || !state.rollbackCandidate) fail('rollback_candidate_missing');
    const [active, target] = await Promise.all([
      installedCandidate(paths, state.current.releaseId, options.trustStorePath, options.aclAdapter),
      installedCandidate(paths, state.rollbackCandidate.releaseId, options.trustStorePath, options.aclAdapter),
    ]);
    const schemaVersion = options.databaseSchemaVersion ?? active.compatibility.database.latestSchemaVersion;
    if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 1) fail('database_schema_version_invalid');
    if (!readableAt(target.compatibility, schemaVersion)) fail('operator_recovery_required');
    await assertTrustReceipt(paths, target, true);
    await beginActivation(
      paths,
      'rollback',
      active.releaseId,
      target,
      schemaVersion,
      readableAt(active.compatibility, schemaVersion),
    );
    return {
      kind: 'kodex_windows_installer_rollback_pending',
      releaseId: target.releaseId,
      automaticRollbackAllowed: readableAt(active.compatibility, schemaVersion),
    };
  });
}

export async function recoverWindowsInstaller(options) {
  const { paths } = await commandContext(options);
  await ensureInstallRoot(paths, options.aclAdapter);
  return withLock(paths, true, async () => {
    const state = await stateSnapshot(paths);
    const { removed, staging } = await releaseDirectories(paths);
    for (const name of staging) {
      await removeOwnedTree(paths, path.join(paths.releases, name), options.aclAdapter, (value) => STAGING_ID.test(value));
    }
    for (const name of removed) {
      const target = path.join(paths.releases, name);
      await assertTreeStructure(target);
      await assertAcl(options.aclAdapter, target, 'release-cleanup-resume');
      await rm(target, { recursive: true, force: false }).catch(() => fail('exact_root_cleanup_failed'));
    }
    if (!state.journal) {
      return {
        kind: 'kodex_windows_installer_recovered',
        result: staging.length > 0 || removed.length > 0 ? 'partial_cleanup_completed' : 'nothing_to_recover',
        releaseId: state.current?.releaseId ?? null,
      };
    }
    const recovered = await finishAutomaticRollback(paths, state.journal, options.trustStorePath, options.aclAdapter);
    return { kind: 'kodex_windows_installer_recovered', ...recovered };
  });
}

export async function windowsInstallerStatus(options) {
  const { paths } = await commandContext(options);
  let state;
  let releases = [];
  let stagingCount = 0;
  try {
    state = await stateSnapshot(paths);
    const directories = await releaseDirectories(paths);
    releases = directories.releases;
    stagingCount = directories.staging.length + directories.removed.length;
  } catch (error) {
    if (error?.code === 'ENOENT' || (error instanceof WindowsInstallerError && error.code === 'installer_state_missing')) {
      state = { current: null, journal: null, lastKnownGood: null, rollbackCandidate: null, trustStoreReceipt: null };
    } else throw error;
  }
  return {
    kind: 'kodex_windows_installer_status',
    activeReleaseId: state.current?.releaseId ?? null,
    confirmedReleaseId: state.lastKnownGood?.releaseId ?? null,
    rollbackReleaseId: state.rollbackCandidate?.releaseId ?? null,
    releaseCount: releases.length,
    stagingCount,
    transactionPhase: state.journal?.phase ?? null,
    operatorRecoveryRequired: Boolean(state.journal && !state.journal.automaticRollbackAllowed && state.journal.fromReleaseId),
    trustStoreVersion: state.trustStoreReceipt?.storeVersion ?? null,
  };
}

export async function planWindowsUninstallCodeBoundary(options) {
  const { layout, paths } = await commandContext(options);
  const status = await windowsInstallerStatus(options);
  if (status.transactionPhase) fail('installer_transaction_pending');
  const rootMetadata = await lstat(paths.root).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    fail('install_root_inaccessible');
  });
  if (rootMetadata) {
    await assertTreeStructure(paths.root);
    await assertAcl(options.aclAdapter, paths.root, 'uninstall-code-boundary');
  }
  return {
    kind: 'kodex_windows_uninstall_code_boundary',
    releaseCount: status.releaseCount,
    externalDataPreserved: true,
    externalDataClassCount: layout.externalData.length,
    adapterActions: ['stop-processes', 'remove-install-root-code', 'remove-shortcuts'],
    registryOrServiceMutationPerformed: false,
    codeRemovalPerformed: false,
  };
}

export async function holdWindowsInstallerLockForTest(options, action) {
  const { paths } = await commandContext(options);
  await ensureInstallRoot(paths, options.aclAdapter);
  return withLock(paths, false, action);
}
