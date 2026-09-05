import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, open, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { verifyVendorManifest } from '../vendor-manifest.mjs';

const execFileAsync = promisify(execFile);
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_TRACKED_FILES = 20_000;
const MAX_RELEASE_FILES = 50_000;
const MAX_TEXT_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SCANNED_TEXT_BYTES = 256 * 1024 * 1024;
const SECRET_ALLOWLIST = '.secret-scanner-allowlist.json';

const SECRET_RULES = [
  { id: 'aws-access-key', expression: /\bAKIA[0-9A-Z]{16}\b/gu },
  { id: 'github-token', expression: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/gu },
  { id: 'google-api-key', expression: /\bAIza[0-9A-Za-z_-]{35}\b/gu },
  { id: 'openai-api-key', expression: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/gu },
  { id: 'private-key', expression: /-----BEGIN (?:EC |ENCRYPTED |OPENSSH |PGP |RSA )?PRIVATE KEY-----/gu },
  { id: 'slack-token', expression: /\bxox[baprs]-[0-9A-Za-z-]{20,}\b/gu },
  {
    id: 'credentialed-postgres-url',
    expression: /\bpostgres(?:ql)?:\/\/[^\s/:@]+:([^\s/@]{8,})@[^\s"'`]+/gu,
    candidate: (match) => match[1],
  },
  {
    id: 'sensitive-assignment',
    expression: /(?:^|["'])(?:AUTH_COOKIE_SECRET|AUTH_EMAIL_DELIVERY_BEARER_TOKEN|AUTH_PASSWORD_RESET_DELIVERY_BEARER_TOKEN|DATABASE_URL|KODEX_LOCAL_LLM_API_KEY|KODEX_OPERATIONS_BEARER_TOKEN|OPENAI_API_KEY|PRODUCT_DB_(?:ADMIN|APP|MIGRATION)_PASSWORD|PRODUCT_DB_MIGRATION_URL|PRODUCT_OPERATIONS_BEARER_TOKEN)["']?\s*[:=]\s*["']?([^\s,"'`;}{]{20,})/giu,
    candidate: (match) => match[1],
  },
];

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, expected) {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function portablePath(value) {
  return value.split(path.sep).join('/');
}

function safeRelativePath(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 1_024
    && !value.includes('\\')
    && !value.includes('\0')
    && !path.posix.isAbsolute(value)
    && path.posix.normalize(value) === value
    && value !== '..'
    && !value.startsWith('../');
}

async function readJson(filename, name) {
  const metadata = await lstat(filename);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_JSON_BYTES) {
    throw new Error(`${name} is missing, linked, or too large.`);
  }
  let value;
  try {
    value = JSON.parse(await readFile(filename, 'utf8'));
  } catch {
    throw new Error(`${name} is not valid JSON.`);
  }
  return value;
}

export async function sha256File(filename) {
  const handle = await open(filename, 'r');
  const hash = createHash('sha256');
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function lockMetadata(manifest) {
  const fields = [
    'name', 'version', 'dependencies', 'devDependencies', 'optionalDependencies',
    'peerDependencies', 'peerDependenciesMeta', 'engines', 'os', 'cpu', 'workspaces',
  ];
  return Object.fromEntries(fields.filter((field) => manifest[field] !== undefined)
    .map((field) => [field, stableValue(manifest[field])]));
}

async function workspaceDirectories(root, patterns) {
  if (!Array.isArray(patterns) || patterns.length < 1 || patterns.length > 32) {
    throw new Error('Root workspace declarations are invalid.');
  }
  const directories = [];
  for (const pattern of patterns) {
    if (typeof pattern !== 'string' || !/^[a-z0-9-]+\/\*$/u.test(pattern)) {
      throw new Error('Workspace patterns must be bounded one-level directories.');
    }
    const parent = pattern.slice(0, -2);
    for (const entry of await readdir(path.join(root, parent), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const relative = `${parent}/${entry.name}`;
      try {
        const packageMetadata = await lstat(path.join(root, relative, 'package.json'));
        if (packageMetadata.isFile() && !packageMetadata.isSymbolicLink()) directories.push(relative);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
  }
  return directories.sort();
}

export async function verifyPackageLock(root) {
  const manifest = await readJson(path.join(root, 'package.json'), 'Root package manifest');
  const lock = await readJson(path.join(root, 'package-lock.json'), 'npm lockfile');
  if (!isRecord(lock) || lock.lockfileVersion !== 3 || lock.requires !== true || !isRecord(lock.packages)) {
    throw new Error('npm lockfile must use the exact lockfile v3 packages contract.');
  }
  if (JSON.stringify(lockMetadata(lock.packages[''])) !== JSON.stringify(lockMetadata(manifest))) {
    throw new Error('Root package manifest does not match package-lock.json.');
  }
  const workspaces = await workspaceDirectories(root, manifest.workspaces);
  for (const relative of workspaces) {
    const workspaceManifest = await readJson(path.join(root, relative, 'package.json'), 'Workspace package manifest');
    if (!isRecord(lock.packages[relative])) throw new Error('A workspace is missing from package-lock.json.');
    if (JSON.stringify(lockMetadata(lock.packages[relative])) !== JSON.stringify(lockMetadata(workspaceManifest))) {
      throw new Error('A workspace package manifest does not match package-lock.json.');
    }
  }
  const lockedWorkspaces = Object.keys(lock.packages)
    .filter((relative) => /^(?:apps|packages)\/[^/]+$/u.test(relative))
    .sort();
  if (JSON.stringify(lockedWorkspaces) !== JSON.stringify(workspaces)) {
    throw new Error('package-lock.json workspace membership does not match the repository.');
  }
  let dependencyCount = 0;
  for (const [relative, entry] of Object.entries(lock.packages)) {
    if (!relative.startsWith('node_modules/')) continue;
    dependencyCount += 1;
    if (!isRecord(entry)) throw new Error('npm lockfile contains an invalid package entry.');
    if (entry.link === true) {
      if (typeof entry.resolved !== 'string' || !workspaces.includes(entry.resolved)) {
        throw new Error('npm lockfile contains an invalid workspace link.');
      }
      continue;
    }
    if (
      typeof entry.version !== 'string'
      || typeof entry.resolved !== 'string'
      || !entry.resolved.startsWith('https://registry.npmjs.org/')
      || typeof entry.integrity !== 'string'
      || !entry.integrity.startsWith('sha512-')
    ) throw new Error('npm lockfile contains an unpinned or non-registry dependency.');
  }
  if (dependencyCount < 1) throw new Error('npm lockfile contains no dependency closure.');
  return { dependencyCount, packageLockSha256: await sha256File(path.join(root, 'package-lock.json')), workspaceCount: workspaces.length };
}

async function readPinnedCommit(filename) {
  const value = await readFile(filename, 'utf8');
  if (!/^([a-f0-9]{40})\r?\n$/u.test(value)) throw new Error('Codex upstream pin must be one exact commit line.');
  return value.trim();
}

function validateLegacyBuildMetadata(value, commit) {
  if (!exactKeys(value, ['builtAt', 'cliReportedVersion', 'commit', 'displayVersion', 'kind', 'source', 'upstream'])) {
    throw new Error('Legacy Codex build metadata has an invalid contract.');
  }
  if (
    value.upstream !== 'https://github.com/openai/codex'
    || value.commit !== commit
    || value.kind !== 'source-build'
    || value.source !== 'vendor/openai-codex'
    || value.displayVersion !== `Codex source build ${commit.slice(0, 12)}`
    || typeof value.cliReportedVersion !== 'string'
    || value.cliReportedVersion.length < 1
    || value.cliReportedVersion.length > 128
    || !Number.isFinite(new Date(value.builtAt).getTime())
  ) throw new Error('Legacy Codex build metadata does not match the pinned source.');
}

function validateBuildMetadataV2(value, expected) {
  if (!exactKeys(value, [
    'binarySha256', 'builtAt', 'cargoLockSha256', 'cliReportedVersion', 'commit',
    'displayVersion', 'formatVersion', 'kind', 'source', 'upstream', 'vendorManifestSha256',
  ])) throw new Error('Codex build metadata has an invalid v2 contract.');
  if (
    value.formatVersion !== 2
    || value.upstream !== 'https://github.com/openai/codex'
    || value.commit !== expected.commit
    || value.kind !== 'source-build'
    || value.source !== 'vendor/openai-codex'
    || value.displayVersion !== `Codex source build ${expected.commit.slice(0, 12)}`
    || value.vendorManifestSha256 !== expected.vendorManifestSha256
    || value.cargoLockSha256 !== expected.cargoLockSha256
    || !SHA256.test(value.binarySha256)
    || typeof value.cliReportedVersion !== 'string'
    || value.cliReportedVersion.length < 1
    || value.cliReportedVersion.length > 128
    || !Number.isFinite(new Date(value.builtAt).getTime())
  ) throw new Error('Codex build metadata does not match the pinned source inputs.');
}

export async function verifyRepositoryProvenance(root, options = {}) {
  const packageLock = await verifyPackageLock(root);
  const commit = await readPinnedCommit(path.join(root, 'CODEX_UPSTREAM_COMMIT'));
  const vendor = await verifyVendorManifest(
    path.join(root, 'vendor', 'openai-codex'),
    path.join(root, 'VENDOR_SOURCE_SHA256.json'),
  );
  if (vendor.commit !== commit) throw new Error('Vendored source does not match the Codex upstream pin.');
  const vendorManifestSha256 = await sha256File(path.join(root, 'VENDOR_SOURCE_SHA256.json'));
  const cargoLockSha256 = await sha256File(path.join(root, 'vendor', 'openai-codex', 'codex-rs', 'Cargo.lock'));
  const buildMetadataPath = path.join(root, 'bin', 'codex-build.json');
  const buildMetadata = await readJson(buildMetadataPath, 'Codex build metadata');
  const protocolMetadata = await readJson(
    path.join(root, 'packages', 'codex-protocol', 'codex-version.json'),
    'Generated Codex protocol metadata',
  );
  if (
    !exactKeys(protocolMetadata, ['cliReportedVersion', 'codexCommit', 'generatedAt', 'generatedWith', 'sourceIdentity'])
    || protocolMetadata.codexCommit !== commit
    || protocolMetadata.sourceIdentity !== `Codex source build ${commit.slice(0, 12)}`
    || protocolMetadata.cliReportedVersion !== buildMetadata.cliReportedVersion
    || protocolMetadata.generatedWith !== 'bin/codex'
    || !Number.isFinite(new Date(protocolMetadata.generatedAt).getTime())
  ) throw new Error('Generated protocol provenance does not match Codex build metadata.');

  const binaryPath = path.join(root, 'bin', 'codex.exe');
  let binaryPresent = true;
  try {
    const binaryMetadata = await lstat(binaryPath);
    if (!binaryMetadata.isFile() || binaryMetadata.isSymbolicLink()) throw new Error('Codex binary is not a regular file.');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    binaryPresent = false;
  }
  if (!binaryPresent) {
    validateLegacyBuildMetadata(buildMetadata, commit);
    if (options.requireBinary) throw new Error('Pinned Codex binary is required for release inputs.');
    return {
      ...packageLock,
      binaryPresent: false,
      cargoLockSha256,
      commit,
      vendorFileCount: vendor.fileCount,
      vendorManifestSha256,
    };
  }
  validateBuildMetadataV2(buildMetadata, { cargoLockSha256, commit, vendorManifestSha256 });
  const binarySha256 = await sha256File(binaryPath);
  if (buildMetadata.binarySha256 !== binarySha256) throw new Error('Codex binary does not match its build metadata.');
  return {
    ...packageLock,
    binaryPresent: true,
    binarySha256,
    buildMetadataSha256: await sha256File(buildMetadataPath),
    cargoLockSha256,
    commit,
    vendorFileCount: vendor.fileCount,
    vendorManifestSha256,
  };
}

export async function verifyPackagedRuntimeProvenance(appRoot, expected) {
  const [commit, buildMetadata, protocolMetadata] = await Promise.all([
    readPinnedCommit(path.join(appRoot, 'metadata', 'CODEX_UPSTREAM_COMMIT')),
    readJson(path.join(appRoot, 'bin', 'codex-build.json'), 'Packaged Codex build metadata'),
    readJson(path.join(appRoot, 'metadata', 'codex-version.json'), 'Packaged protocol metadata'),
  ]);
  const actual = {
    binarySha256: await sha256File(path.join(appRoot, 'bin', 'codex.exe')),
    cargoLockSha256: await sha256File(path.join(appRoot, 'metadata', 'codex-Cargo.lock')),
    commit,
    packageLockSha256: await sha256File(path.join(appRoot, 'metadata', 'package-lock.json')),
    vendorManifestSha256: await sha256File(path.join(appRoot, 'metadata', 'VENDOR_SOURCE_SHA256.json')),
  };
  validateBuildMetadataV2(buildMetadata, actual);
  if (
    buildMetadata.binarySha256 !== actual.binarySha256
    || protocolMetadata.codexCommit !== commit
    || protocolMetadata.sourceIdentity !== buildMetadata.displayVersion
    || protocolMetadata.cliReportedVersion !== buildMetadata.cliReportedVersion
    || Object.entries(actual).some(([key, value]) => expected[key] !== value)
  ) throw new Error('Packaged runtime provenance does not match repository release inputs.');
  return actual;
}

function likelyPlaceholder(value) {
  return /(?:example|dummy|fake|local-only|must-not|password|private|replace|secret|selected|test|token|wrong|your[_-])/iu.test(value)
    || /^([a-z0-9])\1{15,}$/iu.test(value)
    || /[<>{}]/u.test(value);
}

function entropy(value) {
  const frequencies = new Map();
  for (const character of value) frequencies.set(character, (frequencies.get(character) ?? 0) + 1);
  let result = 0;
  for (const count of frequencies.values()) {
    const probability = count / value.length;
    result -= probability * Math.log2(probability);
  }
  return result;
}

function secretFingerprint(rule, value) {
  return createHash('sha256').update(`${rule}\0${value}`).digest('hex').slice(0, 24);
}

function matchesForText(relative, text) {
  const findings = [];
  for (const rule of SECRET_RULES) {
    rule.expression.lastIndex = 0;
    for (const match of text.matchAll(rule.expression)) {
      const candidate = rule.candidate ? rule.candidate(match) : match[0];
      if (rule.id !== 'private-key' && likelyPlaceholder(candidate)) continue;
      if (rule.id === 'sensitive-assignment' && entropy(candidate) < 3.5) continue;
      findings.push({
        fingerprint: secretFingerprint(rule.id, candidate),
        line: text.slice(0, match.index).split('\n').length,
        path: relative,
        rule: rule.id,
      });
    }
  }
  return findings;
}

async function loadAllowlist(root) {
  const value = await readJson(path.join(root, SECRET_ALLOWLIST), 'Secret scanner allowlist');
  if (!exactKeys(value, ['entries', 'formatVersion']) || value.formatVersion !== 1 || !Array.isArray(value.entries) || value.entries.length > 1_000) {
    throw new Error('Secret scanner allowlist has an invalid contract.');
  }
  const entries = new Map();
  for (const entry of value.entries) {
    if (
      !exactKeys(entry, ['fingerprint', 'path', 'reason', 'rule'])
      || !safeRelativePath(entry.path)
      || !SECRET_RULES.some((rule) => rule.id === entry.rule)
      || !/^[a-f0-9]{24}$/u.test(entry.fingerprint)
      || typeof entry.reason !== 'string'
      || entry.reason.length < 12
      || entry.reason.length > 256
      || /[\r\n\0]/u.test(entry.reason)
    ) throw new Error('Secret scanner allowlist contains an invalid entry.');
    const key = `${entry.path}\0${entry.rule}\0${entry.fingerprint}`;
    if (entries.has(key)) throw new Error('Secret scanner allowlist contains a duplicate entry.');
    entries.set(key, entry);
  }
  return entries;
}

async function trackedFiles(root) {
  const result = await execFileAsync('git', ['ls-files', '-z'], {
    cwd: root,
    encoding: 'buffer',
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  const files = result.stdout.toString('utf8').split('\0').filter(Boolean);
  if (files.length < 1 || files.length > MAX_TRACKED_FILES || files.some((file) => !safeRelativePath(file))) {
    throw new Error('Tracked file set is empty, invalid, or exceeds the scanner bound.');
  }
  return files.sort();
}

async function releaseFiles(root, relative = '', output = []) {
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const child = path.join(relative, entry.name);
    const portable = portablePath(child);
    if (!safeRelativePath(portable)) throw new Error('Release input contains an unsafe path.');
    const metadata = await lstat(path.join(root, child));
    if (metadata.isSymbolicLink()) throw new Error('Release input contains a symbolic link.');
    if (metadata.isDirectory()) await releaseFiles(root, child, output);
    else if (metadata.isFile()) output.push(portable);
    else throw new Error('Release input contains an unsupported filesystem entry.');
    if (output.length > MAX_RELEASE_FILES) throw new Error('Release input exceeds the scanner file bound.');
  }
  return output.sort();
}

async function scanFiles(root, files, allowlist) {
  const findings = [];
  const usedAllowlist = new Set();
  let scannedBytes = 0;
  let textFileCount = 0;
  for (const relative of files) {
    const filename = path.join(root, ...relative.split('/'));
    const metadata = await lstat(filename);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('Secret scanner input must contain regular files only.');
    const prefixHandle = await open(filename, 'r');
    const prefix = Buffer.alloc(Math.min(metadata.size, 8 * 1024));
    try {
      if (prefix.length > 0) await prefixHandle.read(prefix, 0, prefix.length, 0);
    } finally {
      await prefixHandle.close();
    }
    if (prefix.includes(0)) continue;
    if (metadata.size > MAX_TEXT_FILE_BYTES) throw new Error('A text-like scanner input exceeds the per-file byte bound.');
    scannedBytes += metadata.size;
    if (scannedBytes > MAX_SCANNED_TEXT_BYTES) throw new Error('Secret scanner input exceeds the total text byte bound.');
    textFileCount += 1;
    const text = await readFile(filename, 'utf8');
    for (const finding of matchesForText(relative, text)) {
      const key = `${finding.path}\0${finding.rule}\0${finding.fingerprint}`;
      if (allowlist.has(key)) usedAllowlist.add(key);
      else findings.push(finding);
    }
  }
  const stale = [...allowlist.keys()].filter((key) => !usedAllowlist.has(key));
  if (findings.length > 0) {
    const detail = findings.slice(0, 20).map((finding) => (
      `${finding.path}:${finding.line} rule=${finding.rule} fingerprint=${finding.fingerprint}`
    ));
    const omitted = findings.length - detail.length;
    throw new Error(`Secret scan found ${findings.length} non-allowlisted candidate(s).\n${detail.join('\n')}${omitted > 0 ? `\n...and ${omitted} more` : ''}`);
  }
  if (stale.length > 0) throw new Error('Secret scanner allowlist contains stale entries.');
  return { fileCount: files.length, scannedBytes, textFileCount };
}

export async function scanTrackedSecrets(root) {
  return scanFiles(root, await trackedFiles(root), await loadAllowlist(root));
}

export async function scanReleaseInputSecrets(root) {
  const metadata = await lstat(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('Release input must be a real directory.');
  return scanFiles(root, await releaseFiles(root), new Map());
}

export async function verifyDeploymentContracts(root) {
  const [compose, dockerfile, localMain] = await Promise.all([
    readFile(path.join(root, 'infra', 'compose.yaml'), 'utf8'),
    readFile(path.join(root, 'apps', 'api', 'Dockerfile'), 'utf8'),
    readFile(path.join(root, 'apps', 'local-server', 'src', 'main.ts'), 'utf8'),
  ]);
  const requiredCompose = [
    'PRODUCT_DB_MIGRATION_URL:',
    'PRODUCT_DB_APP_PASSWORD:',
    'PRODUCT_DB_MIGRATION_PASSWORD:',
    'KODEX_DEPLOYMENT_PROFILE: production',
    'read_only: true',
    'no-new-privileges:true',
    'cap_drop:',
    '- ALL',
    '/docker-entrypoint-initdb.d/010-kodex-roles.sh:ro',
  ];
  if (requiredCompose.some((value) => !compose.includes(value))) {
    throw new Error('Compose deployment is missing a least-privilege contract.');
  }
  if (/privileged:\s*true/u.test(compose) || compose.includes('/var/run/docker.sock')) {
    throw new Error('Compose deployment enables a forbidden broad privilege.');
  }
  if (!/FROM node:[^\n]+ AS runtime[\s\S]+\nUSER node\r?\n[\s\S]+\nCMD /u.test(dockerfile)) {
    throw new Error('Product API runtime image must run as the unprivileged node user.');
  }
  if (!localMain.includes("const host = '127.0.0.1' as const") || !localMain.includes('bootstrapProductDatabase')) {
    throw new Error('Local Server must keep loopback binding and the database privilege bootstrap gate.');
  }
  return { contractCount: 3 };
}
