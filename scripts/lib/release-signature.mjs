import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as signBytes,
  verify as verifyBytes,
} from 'node:crypto';
import { lstat, open, readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  readCanonicalReleaseManifest,
  RELEASE_SIGNATURE_FILENAME,
  verifyReleaseArtifactIntegrity,
} from './release-artifact.mjs';

export const RELEASE_SIGNATURE_FORMAT_VERSION = 1;
export const RELEASE_TRUST_STORE_FORMAT_VERSION = 1;

const SIGNATURE_FORMAT = 'kodex-release-signature';
const TRUST_STORE_FORMAT = 'kodex-release-trust-store';
const ALGORITHM = 'Ed25519';
const MAX_SIGNATURE_ENVELOPE_BYTES = 16 * 1024;
const MAX_TRUST_STORE_BYTES = 1024 * 1024;
const MAX_PRIVATE_KEY_BYTES = 64 * 1024;
const MAX_TRUSTED_KEYS = 256;
const KEY_ID = /^[a-z0-9](?:[a-z0-9._-]{0,63})$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, expected) {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function canonicalBase64(value, expectedBytes, name) {
  if (typeof value !== 'string' || value.length > 512 || !BASE64.test(value)) {
    throw new Error(`${name} is not canonical base64.`);
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length !== expectedBytes || decoded.toString('base64') !== value) {
    throw new Error(`${name} is not canonical base64.`);
  }
  return decoded;
}

function canonicalSignatureBytes(value) {
  return Buffer.from(`${JSON.stringify({
    format: value.format,
    formatVersion: value.formatVersion,
    algorithm: value.algorithm,
    keyId: value.keyId,
    manifestSha256: value.manifestSha256,
    signature: value.signature,
  }, null, 2)}\n`, 'utf8');
}

function canonicalTrustStoreBytes(value) {
  return Buffer.from(`${JSON.stringify({
    format: value.format,
    formatVersion: value.formatVersion,
    storeVersion: value.storeVersion,
    keys: value.keys.map((key) => ({
      keyId: key.keyId,
      algorithm: key.algorithm,
      status: key.status,
      publicKey: key.publicKey,
    })),
  }, null, 2)}\n`, 'utf8');
}

function decodeJson(bytes, name) {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return JSON.parse(text);
  } catch {
    throw new Error(`${name} is not valid UTF-8 JSON.`);
  }
}

async function readBoundedRegularFile(filename, maximumBytes, name) {
  let metadata;
  try {
    metadata = await lstat(filename);
  } catch {
    throw new Error(`${name} is missing or inaccessible.`);
  }
  if (
    !metadata.isFile()
    || metadata.isSymbolicLink()
    || metadata.size < 1
    || metadata.size > maximumBytes
  ) throw new Error(`${name} must be a bounded regular file, not a link.`);
  try {
    return await readFile(filename);
  } catch {
    throw new Error(`${name} is missing or inaccessible.`);
  }
}

function parseSignatureEnvelope(bytes) {
  const value = decodeJson(bytes, 'Release signature envelope');
  if (
    !exactKeys(value, ['algorithm', 'format', 'formatVersion', 'keyId', 'manifestSha256', 'signature'])
    || value.format !== SIGNATURE_FORMAT
    || value.formatVersion !== RELEASE_SIGNATURE_FORMAT_VERSION
    || value.algorithm !== ALGORITHM
    || typeof value.keyId !== 'string'
    || !KEY_ID.test(value.keyId)
    || typeof value.manifestSha256 !== 'string'
    || !SHA256.test(value.manifestSha256)
  ) throw new Error('Release signature envelope has an invalid contract.');
  canonicalBase64(value.signature, 64, 'Release signature');
  if (!bytes.equals(canonicalSignatureBytes(value))) {
    throw new Error('Release signature envelope is not canonical JSON.');
  }
  return value;
}

function parseTrustStore(bytes) {
  const value = decodeJson(bytes, 'Release trust store');
  if (
    !exactKeys(value, ['format', 'formatVersion', 'keys', 'storeVersion'])
    || value.format !== TRUST_STORE_FORMAT
    || value.formatVersion !== RELEASE_TRUST_STORE_FORMAT_VERSION
    || !Number.isSafeInteger(value.storeVersion)
    || value.storeVersion < 1
    || value.storeVersion > 2_147_483_647
    || !Array.isArray(value.keys)
    || value.keys.length > MAX_TRUSTED_KEYS
  ) throw new Error('Release trust store has an invalid contract.');
  const keys = new Map();
  let previousKeyId = '';
  for (const entry of value.keys) {
    if (
      !exactKeys(entry, ['algorithm', 'keyId', 'publicKey', 'status'])
      || typeof entry.keyId !== 'string'
      || !KEY_ID.test(entry.keyId)
      || entry.keyId <= previousKeyId
      || entry.algorithm !== ALGORITHM
      || !['trusted', 'revoked'].includes(entry.status)
    ) throw new Error('Release trust store contains an invalid key entry.');
    const publicKeyBytes = canonicalBase64(entry.publicKey, 44, 'Release public key');
    let publicKey;
    try {
      publicKey = createPublicKey({ key: publicKeyBytes, format: 'der', type: 'spki' });
      const exported = Buffer.from(publicKey.export({ format: 'der', type: 'spki' }));
      if (publicKey.asymmetricKeyType !== 'ed25519' || !exported.equals(publicKeyBytes)) throw new Error();
    } catch {
      throw new Error('Release trust store contains an invalid Ed25519 public key.');
    }
    keys.set(entry.keyId, { ...entry, publicKeyObject: publicKey });
    previousKeyId = entry.keyId;
  }
  if (!bytes.equals(canonicalTrustStoreBytes(value))) {
    throw new Error('Release trust store is not canonical JSON.');
  }
  return { keys, storeVersion: value.storeVersion };
}

async function loadTrustStore(filename) {
  if (typeof filename !== 'string' || !filename.trim()) throw new Error('Release trust store path is required.');
  const bytes = await readBoundedRegularFile(
    path.resolve(filename),
    MAX_TRUST_STORE_BYTES,
    'Release trust store',
  );
  return parseTrustStore(bytes);
}

function pathIsWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function parsePrivateKey(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > MAX_PRIVATE_KEY_BYTES) {
    throw new Error('Signing key input is empty or exceeds the byte limit.');
  }
  const material = Buffer.from(bytes);
  try {
    const privateKey = createPrivateKey(material);
    if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error();
    return privateKey;
  } catch {
    throw new Error('Signing key is not a valid Ed25519 private key.');
  } finally {
    material.fill(0);
  }
}

async function signingKey(options, releaseRoot) {
  const hasFile = typeof options.keyFile === 'string' && options.keyFile.length > 0;
  const hasBytes = options.privateKeyBytes instanceof Uint8Array;
  if (hasFile === hasBytes) throw new Error('Signer requires exactly one private key input boundary.');
  if (hasBytes) return parsePrivateKey(options.privateKeyBytes);
  const filename = path.resolve(options.keyFile);
  if (
    options.forbiddenKeyRoots !== undefined
    && (
      !Array.isArray(options.forbiddenKeyRoots)
      || options.forbiddenKeyRoots.length > 16
      || options.forbiddenKeyRoots.some((root) => typeof root !== 'string' || !root.trim())
    )
  ) throw new Error('Signing key forbidden roots are invalid.');
  const forbiddenRoots = [releaseRoot, ...(options.forbiddenKeyRoots ?? []).map((root) => path.resolve(root))];
  if (forbiddenRoots.some((root) => pathIsWithin(root, filename))) {
    throw new Error('Signing key file must remain outside repository and release roots.');
  }
  const bytes = await readBoundedRegularFile(filename, MAX_PRIVATE_KEY_BYTES, 'Signing key file');
  try {
    return parsePrivateKey(bytes);
  } finally {
    bytes.fill(0);
  }
}

async function writeExclusive(filename, bytes) {
  let handle;
  try {
    handle = await open(filename, 'wx', 0o644);
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error('Release signature already exists; sealed artifacts are not re-signed in place.');
    throw error;
  } finally {
    await handle?.close();
  }
}

export async function validateReleaseTrustStore(filename) {
  const trustStore = await loadTrustStore(filename);
  let revokedKeyCount = 0;
  for (const key of trustStore.keys.values()) {
    if (key.status === 'revoked') revokedKeyCount += 1;
  }
  return {
    keyCount: trustStore.keys.size,
    revokedKeyCount,
    storeVersion: trustStore.storeVersion,
    trustedKeyCount: trustStore.keys.size - revokedKeyCount,
  };
}

export async function signReleaseArtifact(options) {
  if (
    !isRecord(options)
    || typeof options.directory !== 'string'
    || !options.directory.trim()
    || typeof options.keyId !== 'string'
    || !KEY_ID.test(options.keyId)
  ) {
    throw new Error('Release signer options are invalid.');
  }
  const releaseRoot = path.resolve(options.directory);
  await verifyReleaseArtifactIntegrity(releaseRoot);
  const before = await readCanonicalReleaseManifest(releaseRoot);
  const privateKey = await signingKey(options, releaseRoot);
  const digest = createHash('sha256').update(before.bytes).digest('hex');
  const signature = signBytes(null, before.bytes, privateKey);
  const publicKey = createPublicKey(privateKey);
  if (!verifyBytes(null, before.bytes, publicKey, signature)) {
    throw new Error('Release signature self-verification failed.');
  }
  await verifyReleaseArtifactIntegrity(releaseRoot);
  const after = await readCanonicalReleaseManifest(releaseRoot);
  if (createHash('sha256').update(after.bytes).digest('hex') !== digest) {
    throw new Error('Release manifest changed while it was being signed.');
  }
  const envelope = {
    format: SIGNATURE_FORMAT,
    formatVersion: RELEASE_SIGNATURE_FORMAT_VERSION,
    algorithm: ALGORITHM,
    keyId: options.keyId,
    manifestSha256: digest,
    signature: signature.toString('base64'),
  };
  const envelopeBytes = canonicalSignatureBytes(envelope);
  parseSignatureEnvelope(envelopeBytes);
  await writeExclusive(path.join(releaseRoot, RELEASE_SIGNATURE_FILENAME), envelopeBytes);
  return envelope;
}

export async function verifyReleaseArtifact(directory, options = {}) {
  if (!isRecord(options) || !exactKeys(options, ['trustStorePath'])) {
    throw new Error('Authenticity verification requires exactly one versioned release trust store.');
  }
  const trustStore = await loadTrustStore(options.trustStorePath);
  const manifest = await verifyReleaseArtifactIntegrity(directory);
  const releaseRoot = path.resolve(directory);
  const envelopeBytes = await readBoundedRegularFile(
    path.join(releaseRoot, RELEASE_SIGNATURE_FILENAME),
    MAX_SIGNATURE_ENVELOPE_BYTES,
    'Release signature envelope',
  );
  const envelope = parseSignatureEnvelope(envelopeBytes);
  const { bytes: manifestBytes } = await readCanonicalReleaseManifest(releaseRoot);
  const manifestSha256 = createHash('sha256').update(manifestBytes).digest('hex');
  if (envelope.manifestSha256 !== manifestSha256) {
    throw new Error('Release signature manifest digest does not match the artifact manifest.');
  }
  const trustedKey = trustStore.keys.get(envelope.keyId);
  if (!trustedKey) throw new Error('Release signature key is not present in the trust store.');
  if (trustedKey.status === 'revoked') throw new Error('Release signature key is revoked.');
  const signature = canonicalBase64(envelope.signature, 64, 'Release signature');
  if (!verifyBytes(null, manifestBytes, trustedKey.publicKeyObject, signature)) {
    throw new Error('Release signature verification failed.');
  }
  return {
    keyId: envelope.keyId,
    manifest,
    manifestSha256,
    signatureFormatVersion: envelope.formatVersion,
    trustStoreVersion: trustStore.storeVersion,
  };
}
