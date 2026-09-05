import { createReadStream, createWriteStream } from 'node:fs';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  scrypt,
} from 'node:crypto';
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  stat,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { createGunzip, createGzip } from 'node:zlib';
import { finished, pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import {
  signEd25519Payload,
  verifyTrustedEd25519Payload,
} from './release-signature.mjs';
import {
  createOfflineBackup,
  restoreOfflineBackup,
  verifyOfflineBackup,
} from './offline-backup.mjs';

export const OFFLINE_BACKUP_ENVELOPE_FORMAT_VERSION = 2;
export const OFFLINE_BACKUP_ARCHIVE_FORMAT_VERSION = 1;

const ENVELOPE_MAGIC = Buffer.from('KODEX-BACKUP-V2\n', 'ascii');
const ARCHIVE_MAGIC = Buffer.from('KODEX-ARCHIVE-V1\n', 'ascii');
const ARCHIVE_FOOTER = Buffer.from('KODEX-ARCHIVE-END\n', 'ascii');
const ENVELOPE_FORMAT = 'kodex-offline-backup';
const ARCHIVE_FORMAT = 'kodex-offline-backup-archive';
const SIGNATURE_FORMAT = 'kodex-offline-backup-signature';
const SIGNING_MANIFEST_FORMAT = 'kodex-offline-backup-signing-manifest';
const ENCRYPTION_ALGORITHM = 'AES-256-GCM';
const SIGNATURE_ALGORITHM = 'Ed25519';
const KDF_ALGORITHM = 'scrypt';
const KDF_DOMAIN = 'kodex-offline-backup-v2';
const KDF_N = 32_768;
const KDF_R = 8;
const KDF_P = 1;
const KDF_KEY_LENGTH = 32;
const KDF_MAX_MEMORY = 64 * 1024 * 1024;
const KDF_SALT_BYTES = 32;
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const MAX_HEADER_BYTES = 4 * 1024 * 1024;
const MAX_SIGNATURE_BYTES = 16 * 1024;
const MAX_ARCHIVE_RECORD_HEADER_BYTES = 4 * 1024;
const MAX_ARCHIVE_FILES = 200_002;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const IO_CHUNK_BYTES = 64 * 1024;
const SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/u;
const KEY_ID = /^[a-z0-9](?:[a-z0-9._-]{0,63})$/u;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const scryptAsync = promisify(scrypt);

export class OfflineBackupEnvelopeError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'OfflineBackupEnvelopeError';
    this.code = code;
  }
}

function fail(code, message, cause) {
  throw new OfflineBackupEnvelopeError(code, message, cause === undefined ? undefined : { cause });
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

function uint32(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    fail('backup_integrity_rejected', 'Backup framing length is invalid.');
  }
  const bytes = Buffer.allocUnsafe(4);
  bytes.writeUInt32BE(value);
  return bytes;
}

function canonicalJson(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function decodeJson(bytes, name) {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    fail('backup_integrity_rejected', `${name} is not valid UTF-8 JSON.`, error);
  }
}

function canonicalBase64(value, expectedBytes, name) {
  if (typeof value !== 'string' || value.length > 512 || !BASE64.test(value)) {
    fail('backup_integrity_rejected', `${name} is not canonical base64.`);
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length !== expectedBytes || decoded.toString('base64') !== value) {
    decoded.fill(0);
    fail('backup_integrity_rejected', `${name} is not canonical base64.`);
  }
  return decoded;
}

function safeRelativePath(value) {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > 1_024
    || value.includes('\\')
    || value.includes('\0')
    || path.posix.isAbsolute(value)
  ) return false;
  const normalized = path.posix.normalize(value);
  return normalized === value && normalized !== '..' && !normalized.startsWith('../');
}

function normalizedPath(value, name) {
  if (typeof value !== 'string' || !value.trim()) fail('backup_usage_invalid', `${name} is required.`);
  const absolute = path.resolve(value);
  if (absolute === path.parse(absolute).root) fail('backup_usage_invalid', `${name} cannot be a filesystem root.`);
  return absolute;
}

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function parseMigrations(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 10_000) {
    fail('backup_provenance_rejected', 'Backup migration provenance is invalid.');
  }
  return value.map((migration, index) => {
    const version = index + 1;
    if (
      !exactKeys(migration, ['checksum', 'name', 'version'])
      || migration.version !== version
      || typeof migration.name !== 'string'
      || migration.name.length < 1
      || migration.name.length > 128
      || typeof migration.checksum !== 'string'
      || !SHA256.test(migration.checksum)
    ) fail('backup_provenance_rejected', `Backup migration provenance entry ${version} is invalid.`);
    return { version: migration.version, name: migration.name, checksum: migration.checksum };
  });
}

function parseProvenance(value) {
  if (!exactKeys(value, ['application', 'codex', 'database'])) {
    fail('backup_provenance_rejected', 'Backup provenance is invalid.');
  }
  if (
    !exactKeys(value.application, ['commit', 'version'])
    || typeof value.application.version !== 'string'
    || !VERSION.test(value.application.version)
    || typeof value.application.commit !== 'string'
    || !COMMIT.test(value.application.commit)
  ) fail('backup_provenance_rejected', 'Backup application provenance is invalid.');
  if (
    !exactKeys(value.codex, ['upstreamCommit', 'vendorManifestSha256'])
    || typeof value.codex.upstreamCommit !== 'string'
    || !COMMIT.test(value.codex.upstreamCommit)
    || typeof value.codex.vendorManifestSha256 !== 'string'
    || !SHA256.test(value.codex.vendorManifestSha256)
  ) fail('backup_provenance_rejected', 'Backup Codex provenance is invalid.');
  if (!exactKeys(value.database, ['migrations'])) {
    fail('backup_provenance_rejected', 'Backup database provenance is invalid.');
  }
  return {
    application: { version: value.application.version, commit: value.application.commit },
    codex: {
      upstreamCommit: value.codex.upstreamCommit,
      vendorManifestSha256: value.codex.vendorManifestSha256,
    },
    database: { migrations: parseMigrations(value.database.migrations) },
  };
}

function parseHeader(bytes) {
  const value = decodeJson(bytes, 'Backup envelope header');
  if (
    !exactKeys(value, ['createdAt', 'encryption', 'format', 'formatVersion', 'kdf', 'payload', 'provenance'])
    || value.format !== ENVELOPE_FORMAT
    || value.formatVersion !== OFFLINE_BACKUP_ENVELOPE_FORMAT_VERSION
    || typeof value.createdAt !== 'string'
    || !Number.isFinite(new Date(value.createdAt).getTime())
  ) fail('backup_integrity_rejected', 'Backup envelope header contract is invalid.');
  if (
    !exactKeys(value.kdf, ['N', 'algorithm', 'domain', 'keyLength', 'p', 'r', 'salt'])
    || value.kdf.algorithm !== KDF_ALGORITHM
    || value.kdf.domain !== KDF_DOMAIN
    || value.kdf.N !== KDF_N
    || value.kdf.r !== KDF_R
    || value.kdf.p !== KDF_P
    || value.kdf.keyLength !== KDF_KEY_LENGTH
  ) fail('backup_integrity_rejected', 'Backup KDF parameters are unsupported or outside policy.');
  canonicalBase64(value.kdf.salt, KDF_SALT_BYTES, 'Backup KDF salt').fill(0);
  if (
    !exactKeys(value.encryption, ['algorithm', 'nonce', 'tagLength'])
    || value.encryption.algorithm !== ENCRYPTION_ALGORITHM
    || value.encryption.tagLength !== AUTH_TAG_BYTES
  ) fail('backup_integrity_rejected', 'Backup encryption parameters are unsupported.');
  canonicalBase64(value.encryption.nonce, NONCE_BYTES, 'Backup nonce').fill(0);
  if (
    !exactKeys(value.payload, ['archiveLength', 'ciphertextLength', 'compression', 'fileCount', 'format', 'formatVersion'])
    || value.payload.format !== ARCHIVE_FORMAT
    || value.payload.formatVersion !== OFFLINE_BACKUP_ARCHIVE_FORMAT_VERSION
    || value.payload.compression !== 'gzip'
    || !Number.isSafeInteger(value.payload.archiveLength)
    || value.payload.archiveLength < ARCHIVE_MAGIC.length + ARCHIVE_FOOTER.length + 4
    || !Number.isSafeInteger(value.payload.ciphertextLength)
    || value.payload.ciphertextLength < 1
    || !Number.isSafeInteger(value.payload.fileCount)
    || value.payload.fileCount < 2
    || value.payload.fileCount > MAX_ARCHIVE_FILES
  ) fail('backup_integrity_rejected', 'Backup payload framing is invalid.');
  value.provenance = parseProvenance(value.provenance);
  if (!bytes.equals(canonicalJson(value))) {
    fail('backup_integrity_rejected', 'Backup envelope header is not canonical JSON.');
  }
  return value;
}

function parseSignatureEnvelope(bytes) {
  const value = decodeJson(bytes, 'Backup signature envelope');
  if (
    !exactKeys(value, ['algorithm', 'format', 'formatVersion', 'keyId', 'signature', 'signingManifestSha256'])
    || value.format !== SIGNATURE_FORMAT
    || value.formatVersion !== 1
    || value.algorithm !== SIGNATURE_ALGORITHM
    || typeof value.keyId !== 'string'
    || !KEY_ID.test(value.keyId)
    || typeof value.signingManifestSha256 !== 'string'
    || !SHA256.test(value.signingManifestSha256)
  ) fail('backup_authenticity_rejected', 'Backup signature envelope contract is invalid.');
  canonicalBase64(value.signature, 64, 'Backup signature').fill(0);
  if (!bytes.equals(canonicalJson(value))) {
    fail('backup_authenticity_rejected', 'Backup signature envelope is not canonical JSON.');
  }
  return value;
}

function signingManifestBytes(header, ciphertextSha256, authenticationTag) {
  return canonicalJson({
    format: SIGNING_MANIFEST_FORMAT,
    formatVersion: 1,
    header,
    ciphertextSha256,
    authenticationTag,
  });
}

function archiveRecordHeaderBytes(record) {
  return canonicalJson({ path: record.path, sizeBytes: record.sizeBytes });
}

async function sha256File(filename) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(filename, { highWaterMark: IO_CHUNK_BYTES })) digest.update(chunk);
  return digest.digest('hex');
}

async function backupRecords(root, manifest) {
  const manifestPath = path.join(root, 'manifest.json');
  const manifestStat = await lstat(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > MAX_MANIFEST_BYTES) {
    fail('backup_integrity_rejected', 'Inner backup manifest is invalid.');
  }
  const records = [{
    path: 'manifest.json',
    filename: manifestPath,
    sizeBytes: manifestStat.size,
    sha256: await sha256File(manifestPath),
  }, {
    path: 'database.dump',
    filename: path.join(root, 'database.dump'),
    sizeBytes: manifest.database.sizeBytes,
    sha256: manifest.database.sha256,
  }];
  for (const file of manifest.tenantData.files) {
    records.push({
      path: `tenant-data/${file.path}`,
      filename: path.join(root, 'tenant-data', ...file.path.split('/')),
      sizeBytes: file.sizeBytes,
      sha256: file.sha256,
    });
  }
  return records;
}

async function* archiveChunks(records, expectedLength) {
  let emitted = 0;
  const emit = (bytes) => {
    emitted += bytes.length;
    if (!Number.isSafeInteger(emitted) || emitted > expectedLength) {
      fail('backup_integrity_rejected', 'Inner backup archive exceeded its sealed length.');
    }
    return bytes;
  };
  yield emit(ARCHIVE_MAGIC);
  yield emit(uint32(records.length));
  for (const record of records) {
    const header = archiveRecordHeaderBytes(record);
    yield emit(uint32(header.length));
    yield emit(header);
    const digest = createHash('sha256');
    let size = 0;
    for await (const chunk of createReadStream(record.filename, { highWaterMark: IO_CHUNK_BYTES })) {
      size += chunk.length;
      digest.update(chunk);
      yield emit(chunk);
    }
    if (size !== record.sizeBytes || digest.digest('hex') !== record.sha256) {
      fail('backup_integrity_rejected', 'Inner backup changed while it was archived.');
    }
  }
  yield emit(ARCHIVE_FOOTER);
  if (emitted !== expectedLength) fail('backup_integrity_rejected', 'Inner backup archive length changed.');
}

export async function packOfflineBackupArchive(inputDirectory, output) {
  const root = normalizedPath(inputDirectory, 'Inner backup directory');
  const manifest = await verifyOfflineBackup(root).catch((error) => {
    fail('backup_integrity_rejected', 'Inner backup verification failed.', error);
  });
  const records = await backupRecords(root, manifest);
  let archiveLength = ARCHIVE_MAGIC.length + 4 + ARCHIVE_FOOTER.length;
  for (const record of records) {
    const header = archiveRecordHeaderBytes(record);
    archiveLength += 4 + header.length + record.sizeBytes;
    if (!Number.isSafeInteger(archiveLength)) fail('backup_integrity_rejected', 'Inner backup archive is too large.');
  }
  const target = normalizedPath(output, 'Compressed archive output');
  try {
    await pipeline(
      Readable.from(archiveChunks(records, archiveLength)),
      createGzip({ level: 9 }),
      createWriteStream(target, { flags: 'wx', mode: 0o600 }),
    );
  } catch (error) {
    await rm(target, { force: true });
    if (error instanceof OfflineBackupEnvelopeError) throw error;
    fail('backup_integrity_rejected', 'Inner backup archive creation failed.', error);
  }
  const compressed = await stat(target);
  if (!compressed.isFile() || compressed.size < 1) fail('backup_integrity_rejected', 'Compressed backup archive is empty.');
  return { archiveLength, ciphertextLength: compressed.size, fileCount: records.length, manifest };
}

class StreamReader {
  constructor(stream, maximumBytes) {
    this.iterator = stream[Symbol.asyncIterator]();
    this.maximumBytes = maximumBytes;
    this.buffer = Buffer.alloc(0);
    this.consumed = 0;
  }

  async readExact(length, name) {
    if (!Number.isSafeInteger(length) || length < 0 || this.consumed + length > this.maximumBytes) {
      fail('backup_integrity_rejected', `${name} exceeds the sealed archive length.`);
    }
    while (this.buffer.length < length) {
      let item;
      try { item = await this.iterator.next(); } catch (error) {
        fail('backup_integrity_rejected', 'Compressed backup archive is invalid.', error);
      }
      if (item.done) fail('backup_integrity_rejected', `${name} is truncated.`);
      const next = Buffer.from(item.value);
      this.buffer = this.buffer.length === 0 ? next : Buffer.concat([this.buffer, next]);
    }
    const result = Buffer.from(this.buffer.subarray(0, length));
    this.buffer = Buffer.from(this.buffer.subarray(length));
    this.consumed += length;
    return result;
  }

  async assertEnd() {
    if (this.consumed !== this.maximumBytes || this.buffer.length !== 0) {
      fail('backup_integrity_rejected', 'Inner backup archive has trailing content or a length mismatch.');
    }
    let item;
    try { item = await this.iterator.next(); } catch (error) {
      fail('backup_integrity_rejected', 'Compressed backup archive is invalid.', error);
    }
    if (!item.done) fail('backup_integrity_rejected', 'Inner backup archive has trailing content.');
  }
}

function parseArchiveRecordHeader(bytes) {
  const value = decodeJson(bytes, 'Backup archive record');
  if (
    !exactKeys(value, ['path', 'sizeBytes'])
    || !safeRelativePath(value.path)
    || !Number.isSafeInteger(value.sizeBytes)
    || value.sizeBytes < 0
    || !bytes.equals(archiveRecordHeaderBytes(value))
  ) fail('backup_integrity_rejected', 'Backup archive record is invalid or non-canonical.');
  return value;
}

export async function extractOfflineBackupArchive(input, output, expected) {
  const target = normalizedPath(output, 'Archive extraction root');
  try {
    await lstat(target);
    fail('backup_target_rejected', 'Archive extraction root already exists.');
  } catch (error) {
    if (error instanceof OfflineBackupEnvelopeError) throw error;
    if (error?.code !== 'ENOENT') fail('backup_target_rejected', 'Archive extraction root is inaccessible.', error);
  }
  await mkdir(target, { recursive: false, mode: 0o700 });
  const source = createReadStream(input, { highWaterMark: IO_CHUNK_BYTES });
  const gunzip = source.pipe(createGunzip());
  const streamsFinished = Promise.allSettled([finished(source), finished(gunzip)]);
  const reader = new StreamReader(gunzip, expected.archiveLength);
  try {
    const magic = await reader.readExact(ARCHIVE_MAGIC.length, 'Backup archive magic');
    if (!magic.equals(ARCHIVE_MAGIC)) fail('backup_integrity_rejected', 'Backup archive magic is invalid.');
    const count = (await reader.readExact(4, 'Backup archive file count')).readUInt32BE(0);
    if (count !== expected.fileCount || count < 2 || count > MAX_ARCHIVE_FILES) {
      fail('backup_integrity_rejected', 'Backup archive file count is invalid.');
    }
    const seen = new Set();
    let previousTenantPath = '';
    for (let index = 0; index < count; index += 1) {
      const headerLength = (await reader.readExact(4, 'Backup archive record header length')).readUInt32BE(0);
      if (headerLength < 1 || headerLength > MAX_ARCHIVE_RECORD_HEADER_BYTES) {
        fail('backup_integrity_rejected', 'Backup archive record header length is invalid.');
      }
      const record = parseArchiveRecordHeader(
        await reader.readExact(headerLength, 'Backup archive record header'),
      );
      if (
        seen.has(record.path)
        || (index === 0 && record.path !== 'manifest.json')
        || (index === 1 && record.path !== 'database.dump')
        || (index > 1 && (!record.path.startsWith('tenant-data/') || record.path <= previousTenantPath))
      ) fail('backup_integrity_rejected', 'Backup archive contains duplicate, unlisted, or unordered content.');
      seen.add(record.path);
      if (index > 1) previousTenantPath = record.path;
      const filename = path.resolve(target, ...record.path.split('/'));
      if (!isWithin(target, filename)) fail('backup_integrity_rejected', 'Backup archive path escapes its extraction root.');
      await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
      const handle = await open(filename, 'wx', 0o600);
      try {
        let remaining = record.sizeBytes;
        while (remaining > 0) {
          const bytes = await reader.readExact(Math.min(remaining, IO_CHUNK_BYTES), 'Backup archive file');
          await handle.write(bytes);
          remaining -= bytes.length;
        }
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    const footer = await reader.readExact(ARCHIVE_FOOTER.length, 'Backup archive footer');
    if (!footer.equals(ARCHIVE_FOOTER)) fail('backup_integrity_rejected', 'Backup archive footer is invalid.');
    await reader.assertEnd();
    return await verifyOfflineBackup(target).catch((error) => {
      fail('backup_integrity_rejected', 'Extracted backup manifest or content verification failed.', error);
    });
  } catch (error) {
    await rm(target, { recursive: true, force: true });
    if (error instanceof OfflineBackupEnvelopeError) throw error;
    fail('backup_integrity_rejected', 'Backup archive extraction failed.', error);
  } finally {
    source.destroy();
    gunzip.destroy();
    await streamsFinished;
  }
}

function assertPassphrase(passphrase) {
  if (!(passphrase instanceof Uint8Array) || passphrase.byteLength < 16 || passphrase.byteLength > 4_096) {
    fail('backup_secret_rejected', 'Backup passphrase is empty or outside the byte limit.');
  }
}

async function deriveKey(passphrase, salt) {
  assertPassphrase(passphrase);
  const domain = Buffer.from(KDF_DOMAIN, 'utf8');
  const separatedSalt = Buffer.concat([domain, Buffer.from([0]), salt]);
  try {
    return Buffer.from(await scryptAsync(passphrase, separatedSalt, KDF_KEY_LENGTH, {
      N: KDF_N,
      r: KDF_R,
      p: KDF_P,
      maxmem: KDF_MAX_MEMORY,
    }));
  } catch (error) {
    fail('backup_secret_rejected', 'Backup key derivation failed.', error);
  } finally {
    separatedSalt.fill(0);
  }
}

function envelopeAad(headerBytes) {
  return Buffer.concat([ENVELOPE_MAGIC, uint32(headerBytes.length), headerBytes]);
}

async function writeEncryptedEnvelope(options) {
  const headerBytes = canonicalJson(options.header);
  parseHeader(headerBytes);
  const salt = canonicalBase64(options.header.kdf.salt, KDF_SALT_BYTES, 'Backup KDF salt');
  const nonce = canonicalBase64(options.header.encryption.nonce, NONCE_BYTES, 'Backup nonce');
  const key = await deriveKey(options.passphrase, salt);
  salt.fill(0);
  const handle = await open(options.output, 'wx', 0o600);
  try {
    await handle.write(ENVELOPE_MAGIC);
    await handle.write(uint32(headerBytes.length));
    await handle.write(headerBytes);
    const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: AUTH_TAG_BYTES });
    cipher.setAAD(envelopeAad(headerBytes), { plaintextLength: options.header.payload.ciphertextLength });
    const digest = createHash('sha256');
    let encryptedBytes = 0;
    for await (const chunk of createReadStream(options.compressedArchive, { highWaterMark: IO_CHUNK_BYTES })) {
      const encrypted = cipher.update(chunk);
      encryptedBytes += encrypted.length;
      digest.update(encrypted);
      await handle.write(encrypted);
    }
    const final = cipher.final();
    encryptedBytes += final.length;
    digest.update(final);
    if (final.length > 0) await handle.write(final);
    if (encryptedBytes !== options.header.payload.ciphertextLength) {
      fail('backup_integrity_rejected', 'Encrypted backup length changed during sealing.');
    }
    const authenticationTag = cipher.getAuthTag();
    const ciphertextSha256 = digest.digest('hex');
    const signingBytes = signingManifestBytes(
      options.header,
      ciphertextSha256,
      authenticationTag.toString('base64'),
    );
    let signature;
    try {
      signature = signEd25519Payload(signingBytes, options.privateKeyBytes);
    } catch (error) {
      fail('backup_secret_rejected', 'Backup signing key was rejected.', error);
    }
    const signatureEnvelope = {
      format: SIGNATURE_FORMAT,
      formatVersion: 1,
      algorithm: SIGNATURE_ALGORITHM,
      keyId: options.keyId,
      signingManifestSha256: createHash('sha256').update(signingBytes).digest('hex'),
      signature: signature.toString('base64'),
    };
    const signatureBytes = canonicalJson(signatureEnvelope);
    parseSignatureEnvelope(signatureBytes);
    await handle.write(authenticationTag);
    await handle.write(uint32(signatureBytes.length));
    await handle.write(signatureBytes);
    await handle.sync();
    return { ciphertextSha256, signature: signatureEnvelope };
  } finally {
    key.fill(0);
    nonce.fill(0);
    await handle.close();
  }
}

async function readExactAt(handle, position, length, name) {
  const bytes = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(bytes, offset, length - offset, position + offset);
    if (bytesRead === 0) fail('backup_integrity_rejected', `${name} is truncated.`);
    offset += bytesRead;
  }
  return bytes;
}

async function* fileRange(filename, start, length) {
  if (length === 0) return;
  for await (const chunk of createReadStream(filename, {
    start,
    end: start + length - 1,
    highWaterMark: IO_CHUNK_BYTES,
  })) yield chunk;
}

async function inspectEncryptedEnvelope(input, trustStorePath) {
  const filename = normalizedPath(input, 'Encrypted backup input');
  let metadata;
  try { metadata = await lstat(filename); } catch (error) {
    fail('backup_integrity_rejected', 'Encrypted backup is missing or inaccessible.', error);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    fail('backup_integrity_rejected', 'Encrypted backup must be a regular file, not a link.');
  }
  const handle = await open(filename, 'r');
  try {
    const magic = await readExactAt(handle, 0, ENVELOPE_MAGIC.length, 'Backup envelope magic');
    if (!magic.equals(ENVELOPE_MAGIC)) fail('backup_integrity_rejected', 'Backup envelope magic is invalid.');
    const headerLength = (await readExactAt(handle, ENVELOPE_MAGIC.length, 4, 'Backup header length')).readUInt32BE(0);
    if (headerLength < 1 || headerLength > MAX_HEADER_BYTES) {
      fail('backup_integrity_rejected', 'Backup envelope header length is invalid.');
    }
    const headerOffset = ENVELOPE_MAGIC.length + 4;
    const headerBytes = await readExactAt(handle, headerOffset, headerLength, 'Backup envelope header');
    const header = parseHeader(headerBytes);
    const ciphertextOffset = headerOffset + headerLength;
    const tagOffset = ciphertextOffset + header.payload.ciphertextLength;
    const signatureLengthOffset = tagOffset + AUTH_TAG_BYTES;
    if (!Number.isSafeInteger(signatureLengthOffset) || signatureLengthOffset + 4 > metadata.size) {
      fail('backup_integrity_rejected', 'Backup envelope ciphertext is truncated.');
    }
    const authenticationTag = await readExactAt(handle, tagOffset, AUTH_TAG_BYTES, 'Backup authentication tag');
    const signatureLength = (await readExactAt(handle, signatureLengthOffset, 4, 'Backup signature length')).readUInt32BE(0);
    if (signatureLength < 1 || signatureLength > MAX_SIGNATURE_BYTES) {
      fail('backup_authenticity_rejected', 'Backup signature envelope length is invalid.');
    }
    const expectedSize = signatureLengthOffset + 4 + signatureLength;
    if (metadata.size !== expectedSize) {
      fail('backup_integrity_rejected', 'Backup envelope is truncated or has trailing content.');
    }
    const signatureBytes = await readExactAt(handle, signatureLengthOffset + 4, signatureLength, 'Backup signature envelope');
    const signatureEnvelope = parseSignatureEnvelope(signatureBytes);
    const digest = createHash('sha256');
    let ciphertextBytes = 0;
    for await (const chunk of fileRange(filename, ciphertextOffset, header.payload.ciphertextLength)) {
      ciphertextBytes += chunk.length;
      digest.update(chunk);
    }
    if (ciphertextBytes !== header.payload.ciphertextLength) {
      fail('backup_integrity_rejected', 'Backup ciphertext is truncated.');
    }
    const ciphertextSha256 = digest.digest('hex');
    const signingBytes = signingManifestBytes(
      header,
      ciphertextSha256,
      authenticationTag.toString('base64'),
    );
    if (createHash('sha256').update(signingBytes).digest('hex') !== signatureEnvelope.signingManifestSha256) {
      fail('backup_authenticity_rejected', 'Backup signed manifest digest does not match the envelope.');
    }
    const signature = canonicalBase64(signatureEnvelope.signature, 64, 'Backup signature');
    let trust;
    try {
      trust = await verifyTrustedEd25519Payload({
        trustStorePath,
        keyId: signatureEnvelope.keyId,
        payload: signingBytes,
        signature,
      });
    } catch (error) {
      fail('backup_authenticity_rejected', 'Backup signature is not trusted.', error);
    } finally {
      signature.fill(0);
    }
    return {
      authenticationTag,
      ciphertextOffset,
      ciphertextSha256,
      filename,
      header,
      headerBytes,
      keyId: signatureEnvelope.keyId,
      trustStoreVersion: trust.storeVersion,
    };
  } finally {
    await handle.close();
  }
}

async function decryptEnvelope(inspected, passphrase, output) {
  const salt = canonicalBase64(inspected.header.kdf.salt, KDF_SALT_BYTES, 'Backup KDF salt');
  const nonce = canonicalBase64(inspected.header.encryption.nonce, NONCE_BYTES, 'Backup nonce');
  const key = await deriveKey(passphrase, salt);
  salt.fill(0);
  const handle = await open(output, 'wx', 0o600);
  let failure;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: AUTH_TAG_BYTES });
    decipher.setAAD(envelopeAad(inspected.headerBytes), {
      plaintextLength: inspected.header.payload.ciphertextLength,
    });
    decipher.setAuthTag(inspected.authenticationTag);
    let written = 0;
    for await (const chunk of fileRange(
      inspected.filename,
      inspected.ciphertextOffset,
      inspected.header.payload.ciphertextLength,
    )) {
      const decrypted = decipher.update(chunk);
      written += decrypted.length;
      await handle.write(decrypted);
    }
    const final = decipher.final();
    written += final.length;
    if (final.length > 0) await handle.write(final);
    if (written !== inspected.header.payload.ciphertextLength) {
      fail('backup_integrity_rejected', 'Decrypted backup length does not match the envelope.');
    }
    await handle.sync();
  } catch (error) {
    failure = error instanceof OfflineBackupEnvelopeError
      ? error
      : new OfflineBackupEnvelopeError(
        'backup_integrity_rejected',
        'Backup authenticated decryption failed.',
        { cause: error },
      );
  } finally {
    key.fill(0);
    nonce.fill(0);
    inspected.authenticationTag.fill(0);
    await handle.close();
  }
  if (failure) {
    await rm(output, { force: true });
    throw failure;
  }
}

function assertMatchingProvenance(header, manifest, expectedProvenance) {
  const expected = parseProvenance(expectedProvenance);
  const inner = {
    application: manifest.application,
    codex: header.provenance.codex,
    database: { migrations: manifest.database.migrations },
  };
  if (
    header.createdAt !== manifest.createdAt
    || JSON.stringify(parseProvenance(inner)) !== JSON.stringify(header.provenance)
    || JSON.stringify(header.provenance) !== JSON.stringify(expected)
  ) fail('backup_provenance_rejected', 'Backup provenance does not match its contents or this runtime.');
}

async function privateTemporaryRoot(parent, prefix) {
  const root = await mkdtemp(path.join(parent, prefix));
  if (process.platform !== 'win32') await chmod(root, 0o700);
  return root;
}

export async function sealOfflineBackupDirectory(options) {
  const input = normalizedPath(options.input, 'Inner backup directory');
  const output = normalizedPath(options.output, 'Encrypted backup output');
  if (isWithin(input, output) || isWithin(output, input)) {
    fail('backup_usage_invalid', 'Encrypted output and inner backup directory must not contain each other.');
  }
  assertPassphrase(options.passphrase);
  if (!(options.privateKeyBytes instanceof Uint8Array) || typeof options.keyId !== 'string' || !KEY_ID.test(options.keyId)) {
    fail('backup_secret_rejected', 'Backup signing input is invalid.');
  }
  const parent = path.dirname(output);
  const parentStat = await lstat(parent).catch((error) => fail('backup_target_rejected', 'Backup output parent is inaccessible.', error));
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) fail('backup_target_rejected', 'Backup output parent must be a real directory.');
  try {
    await lstat(output);
    fail('backup_target_rejected', 'Encrypted backup output already exists.');
  } catch (error) {
    if (error instanceof OfflineBackupEnvelopeError) throw error;
    if (error?.code !== 'ENOENT') fail('backup_target_rejected', 'Encrypted backup output is inaccessible.', error);
  }
  const provenance = parseProvenance(options.provenance);
  const workRoot = await privateTemporaryRoot(parent, `.kodex-backup-seal-${randomUUID()}-`);
  const compressedArchive = path.join(workRoot, 'archive.gz');
  const stagedOutput = path.join(workRoot, 'encrypted-backup.kdbx');
  try {
    const packed = await packOfflineBackupArchive(input, compressedArchive);
    const header = {
      format: ENVELOPE_FORMAT,
      formatVersion: OFFLINE_BACKUP_ENVELOPE_FORMAT_VERSION,
      createdAt: packed.manifest.createdAt,
      provenance,
      kdf: {
        algorithm: KDF_ALGORITHM,
        domain: KDF_DOMAIN,
        N: KDF_N,
        r: KDF_R,
        p: KDF_P,
        keyLength: KDF_KEY_LENGTH,
        salt: randomBytes(KDF_SALT_BYTES).toString('base64'),
      },
      encryption: {
        algorithm: ENCRYPTION_ALGORITHM,
        nonce: randomBytes(NONCE_BYTES).toString('base64'),
        tagLength: AUTH_TAG_BYTES,
      },
      payload: {
        format: ARCHIVE_FORMAT,
        formatVersion: OFFLINE_BACKUP_ARCHIVE_FORMAT_VERSION,
        compression: 'gzip',
        archiveLength: packed.archiveLength,
        ciphertextLength: packed.ciphertextLength,
        fileCount: packed.fileCount,
      },
    };
    assertMatchingProvenance(header, packed.manifest, provenance);
    const sealed = await writeEncryptedEnvelope({
      compressedArchive,
      header,
      keyId: options.keyId,
      output: stagedOutput,
      passphrase: options.passphrase,
      privateKeyBytes: options.privateKeyBytes,
    });
    try {
      await link(stagedOutput, output);
    } catch (error) {
      if (error?.code === 'EEXIST') fail('backup_target_rejected', 'Encrypted backup output already exists.', error);
      throw error;
    }
    await unlink(stagedOutput).catch(() => undefined);
    return { header, manifest: packed.manifest, ...sealed };
  } finally {
    await rm(workRoot, { recursive: true, force: true });
  }
}

export async function createEncryptedOfflineBackup(options) {
  const startedAt = Date.now();
  const output = normalizedPath(options.output, 'Encrypted backup output');
  const parent = path.dirname(output);
  const workRoot = await privateTemporaryRoot(parent, `.kodex-backup-create-${randomUUID()}-`);
  const plaintextRoot = path.join(workRoot, 'verified-plaintext');
  try {
    const created = await createOfflineBackup({ ...options, output: plaintextRoot });
    const sealed = await sealOfflineBackupDirectory({
      input: plaintextRoot,
      keyId: options.keyId,
      output,
      passphrase: options.passphrase,
      privateKeyBytes: options.privateKeyBytes,
      provenance: options.provenance,
    });
    return { ...sealed, durationMs: Date.now() - startedAt, manifest: created.manifest };
  } finally {
    await rm(workRoot, { recursive: true, force: true });
  }
}

export async function withVerifiedEncryptedOfflineBackup(options, operation) {
  if (typeof operation !== 'function') fail('backup_usage_invalid', 'Verified backup operation is required.');
  assertPassphrase(options.passphrase);
  const workParent = options.workDirectory === undefined
    ? path.dirname(path.resolve(options.input))
    : normalizedPath(options.workDirectory, 'Backup work directory');
  const parentStat = await lstat(workParent).catch((error) => fail('backup_target_rejected', 'Backup work directory is inaccessible.', error));
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) fail('backup_target_rejected', 'Backup work directory must be a real directory.');
  const workRoot = await privateTemporaryRoot(workParent, '.kodex-backup-open-');
  const compressedArchive = path.join(workRoot, 'archive.gz');
  const plaintextRoot = path.join(workRoot, 'verified-plaintext');
  try {
    const inspected = await inspectEncryptedEnvelope(options.input, options.trustStorePath);
    await decryptEnvelope(inspected, options.passphrase, compressedArchive);
    const manifest = await extractOfflineBackupArchive(compressedArchive, plaintextRoot, inspected.header.payload);
    assertMatchingProvenance(inspected.header, manifest, options.expectedProvenance);
    const result = await operation({
      header: inspected.header,
      keyId: inspected.keyId,
      manifest,
      plaintextRoot,
      trustStoreVersion: inspected.trustStoreVersion,
    });
    return {
      header: inspected.header,
      keyId: inspected.keyId,
      manifest,
      result,
      trustStoreVersion: inspected.trustStoreVersion,
    };
  } finally {
    await rm(workRoot, { recursive: true, force: true });
  }
}

export async function verifyEncryptedOfflineBackup(options) {
  const verified = await withVerifiedEncryptedOfflineBackup(options, async () => undefined);
  return {
    header: verified.header,
    keyId: verified.keyId,
    manifest: verified.manifest,
    trustStoreVersion: verified.trustStoreVersion,
  };
}

export async function restoreEncryptedOfflineBackup(options) {
  const startedAt = Date.now();
  let verified;
  try {
    verified = await withVerifiedEncryptedOfflineBackup(options, async ({ plaintextRoot }) => (
      restoreOfflineBackup({ ...options, input: plaintextRoot })
    ));
  } catch (error) {
    if (error instanceof OfflineBackupEnvelopeError) throw error;
    if (
      typeof error?.message === 'string'
      && (
        error.message.includes('Restore requires')
        || error.message.includes('KODEX_DATA_ROOT must')
        || error.message.includes('Backup input and KODEX_DATA_ROOT')
      )
    ) fail('backup_target_rejected', 'Backup restore target was rejected.', error);
    fail('backup_operation_failed', 'Backup restore operation failed.', error);
  }
  return {
    durationMs: Date.now() - startedAt,
    header: verified.header,
    keyId: verified.keyId,
    manifest: verified.manifest,
    trustStoreVersion: verified.trustStoreVersion,
  };
}
