import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
} from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import {
  extractOfflineBackupArchive,
  OfflineBackupEnvelopeError,
  sealOfflineBackupDirectory,
  verifyEncryptedOfflineBackup,
  withVerifiedEncryptedOfflineBackup,
} from './lib/offline-backup-envelope.mjs';
import { verifyOfflineBackup } from './lib/offline-backup.mjs';
import {
  normalizeBackupPassphrase,
  readRestrictedSecretFile,
  readSecretPipe,
} from './lib/secret-input.mjs';

const ENVELOPE_MAGIC_BYTES = Buffer.byteLength('KODEX-BACKUP-V2\n');
const root = await mkdtemp(path.join(os.tmpdir(), 'kodex-backup-encryption-test-'));
const backupRoot = path.join(root, 'plaintext-backup');
const workRoot = path.join(root, 'work');
const encrypted = path.join(root, 'backup.kdbx');
const encryptedSecond = path.join(root, 'backup-second.kdbx');
const passphraseText = 'correct battery staple for encrypted backup';
const passphrase = Buffer.from(passphraseText, 'utf8');
const wrongPassphrase = Buffer.from('wrong battery staple for encrypted backup', 'utf8');
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const privateKeyBytes = Buffer.from(privateKey.export({ format: 'pem', type: 'pkcs8' }));
const publicKeyBytes = Buffer.from(publicKey.export({ format: 'der', type: 'spki' }));
const keyId = 'backup-fixture-2026';
let databaseBytes;
let tenantBytes;
const provenance = {
  application: { version: '0.2.0', commit: 'a'.repeat(40) },
  codex: { upstreamCommit: 'b'.repeat(40), vendorManifestSha256: 'c'.repeat(64) },
  database: { migrations: [{ version: 1, name: 'initial', checksum: 'd'.repeat(64) }] },
};

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function canonical(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function u32(value) {
  const bytes = Buffer.allocUnsafe(4);
  bytes.writeUInt32BE(value);
  return bytes;
}

async function expectCode(operation, code) {
  await assert.rejects(operation, (error) => (
    error instanceof OfflineBackupEnvelopeError && error.code === code
  ));
}

async function writeTrustStore(filename, status = 'trusted', selectedKeyId = keyId) {
  await writeFile(filename, canonical({
    format: 'kodex-release-trust-store',
    formatVersion: 1,
    storeVersion: status === 'trusted' ? 7 : 8,
    keys: [{
      keyId: selectedKeyId,
      algorithm: 'Ed25519',
      status,
      publicKey: publicKeyBytes.toString('base64'),
    }],
  }), { mode: 0o600 });
}

function envelopeLayout(bytes) {
  const headerLength = bytes.readUInt32BE(ENVELOPE_MAGIC_BYTES);
  const headerOffset = ENVELOPE_MAGIC_BYTES + 4;
  const header = JSON.parse(bytes.subarray(headerOffset, headerOffset + headerLength).toString('utf8'));
  const ciphertextOffset = headerOffset + headerLength;
  const tagOffset = ciphertextOffset + header.payload.ciphertextLength;
  const signatureLengthOffset = tagOffset + 16;
  const signatureLength = bytes.readUInt32BE(signatureLengthOffset);
  return {
    ciphertextOffset,
    header,
    headerLength,
    headerOffset,
    signatureLength,
    signatureOffset: signatureLengthOffset + 4,
    tagOffset,
  };
}

async function tamperedArtifact(name, mutate) {
  const bytes = Buffer.from(await readFile(encrypted));
  mutate(bytes, envelopeLayout(bytes));
  const filename = path.join(root, name);
  await writeFile(filename, bytes, { mode: 0o600 });
  return filename;
}

function rawArchive(records, footer = Buffer.from('KODEX-ARCHIVE-END\n', 'ascii')) {
  const chunks = [Buffer.from('KODEX-ARCHIVE-V1\n', 'ascii'), u32(records.length)];
  for (const record of records) {
    const header = canonical({ path: record.path, sizeBytes: record.bytes.length });
    chunks.push(u32(header.length), header, record.bytes);
  }
  chunks.push(footer);
  return Buffer.concat(chunks);
}

function restrictWindowsFile(filename) {
  const powershell = path.join(
    process.env.SystemRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  const script = [
    "$ErrorActionPreference='Stop'",
    '$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User',
    '$acl=[Security.AccessControl.FileSecurity]::new()',
    '$acl.SetOwner($sid)',
    '$acl.SetAccessRuleProtection($true,$false)',
    "$rule=[Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.AccessControlType]::Allow)",
    '$acl.AddAccessRule($rule)',
    'Set-Acl -LiteralPath $args[0] -AclObject $acl',
  ].join(';');
  const result = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script, filename], {
    shell: false,
    stdio: 'ignore',
    windowsHide: true,
  });
  return result.status === 0;
}

try {
  await mkdir(path.join(backupRoot, 'tenant-data', 'tenants', 'fixture'), { recursive: true, mode: 0o700 });
  await mkdir(workRoot, { mode: 0o700 });
  databaseBytes = randomBytes(180_000);
  tenantBytes = randomBytes(210_000);
  await writeFile(path.join(backupRoot, 'database.dump'), databaseBytes, { mode: 0o600 });
  await writeFile(
    path.join(backupRoot, 'tenant-data', 'tenants', 'fixture', 'multi-chunk.bin'),
    tenantBytes,
    { mode: 0o600 },
  );
  const manifest = {
    formatVersion: 1,
    createdAt: '2026-09-05T00:00:00.000Z',
    application: provenance.application,
    database: {
      file: 'database.dump',
      format: 'postgres-custom',
      migrations: provenance.database.migrations.map(({ version, name, checksum }) => ({ checksum, name, version })),
      sha256: sha256(databaseBytes),
      sizeBytes: databaseBytes.length,
    },
    tenantData: {
      directory: 'tenant-data',
      fileCount: 1,
      files: [{
        path: 'tenants/fixture/multi-chunk.bin',
        sha256: sha256(tenantBytes),
        sizeBytes: tenantBytes.length,
      }],
      totalBytes: tenantBytes.length,
    },
  };
  await writeFile(path.join(backupRoot, 'manifest.json'), canonical(manifest), { mode: 0o600 });
  assert.equal((await verifyOfflineBackup(backupRoot)).tenantData.totalBytes, tenantBytes.length);

  const trustStorePath = path.join(root, 'trust-store.json');
  const revokedStorePath = path.join(root, 'trust-store-revoked.json');
  const unknownStorePath = path.join(root, 'trust-store-unknown.json');
  await writeTrustStore(trustStorePath);
  await writeTrustStore(revokedStorePath, 'revoked');
  await writeTrustStore(unknownStorePath, 'trusted', 'some-other-key');

  const first = await sealOfflineBackupDirectory({
    input: backupRoot,
    keyId,
    output: encrypted,
    passphrase,
    privateKeyBytes,
    provenance,
  });
  const second = await sealOfflineBackupDirectory({
    input: backupRoot,
    keyId,
    output: encryptedSecond,
    passphrase,
    privateKeyBytes,
    provenance,
  });
  assert.notEqual(first.header.kdf.salt, second.header.kdf.salt);
  assert.notEqual(first.header.encryption.nonce, second.header.encryption.nonce);
  assert.notEqual(first.ciphertextSha256, second.ciphertextSha256);

  const verified = await verifyEncryptedOfflineBackup({
    expectedProvenance: provenance,
    input: encrypted,
    passphrase,
    trustStorePath,
    workDirectory: workRoot,
  });
  assert.equal(verified.header.formatVersion, 2);
  assert.equal(verified.header.payload.fileCount, 3);
  assert.equal(verified.manifest.database.sha256, manifest.database.sha256);
  assert.equal(verified.keyId, keyId);
  assert.equal(verified.trustStoreVersion, 7);

  let mutationCalled = false;
  const opened = await withVerifiedEncryptedOfflineBackup({
    expectedProvenance: provenance,
    input: encrypted,
    passphrase,
    trustStorePath,
    workDirectory: workRoot,
  }, async ({ plaintextRoot }) => {
    mutationCalled = true;
    assert.equal(await sha256File(path.join(plaintextRoot, 'database.dump')), manifest.database.sha256);
    assert.equal(
      await sha256File(path.join(plaintextRoot, 'tenant-data', 'tenants', 'fixture', 'multi-chunk.bin')),
      manifest.tenantData.files[0].sha256,
    );
    return 'verified-before-mutation';
  });
  assert.equal(mutationCalled, true);
  assert.equal(opened.result, 'verified-before-mutation');

  mutationCalled = false;
  await expectCode(() => withVerifiedEncryptedOfflineBackup({
    expectedProvenance: provenance,
    input: encrypted,
    passphrase: wrongPassphrase,
    trustStorePath,
    workDirectory: workRoot,
  }, async () => { mutationCalled = true; }), 'backup_integrity_rejected');
  assert.equal(mutationCalled, false);

  await expectCode(() => verifyEncryptedOfflineBackup({
    expectedProvenance: provenance,
    input: encrypted,
    passphrase: wrongPassphrase,
    trustStorePath: unknownStorePath,
    workDirectory: workRoot,
  }), 'backup_authenticity_rejected');
  await expectCode(() => verifyEncryptedOfflineBackup({
    expectedProvenance: provenance,
    input: encrypted,
    passphrase,
    trustStorePath: revokedStorePath,
    workDirectory: workRoot,
  }), 'backup_authenticity_rejected');

  const ciphertextTamper = await tamperedArtifact('ciphertext-tamper.kdbx', (bytes, layout) => {
    bytes[layout.ciphertextOffset + 70_000] ^= 0x01;
  });
  const nonceTamper = await tamperedArtifact('nonce-tamper.kdbx', (bytes, layout) => {
    const header = layout.header;
    header.encryption.nonce = `${header.encryption.nonce[0] === 'A' ? 'B' : 'A'}${header.encryption.nonce.slice(1)}`;
    const replacement = canonical(header);
    assert.equal(replacement.length, layout.headerLength);
    replacement.copy(bytes, layout.headerOffset);
  });
  const kdfTamper = await tamperedArtifact('kdf-tamper.kdbx', (bytes, layout) => {
    const header = layout.header;
    header.kdf.N = 32_769;
    const replacement = canonical(header);
    assert.equal(replacement.length, layout.headerLength);
    replacement.copy(bytes, layout.headerOffset);
  });
  const tagTamper = await tamperedArtifact('tag-tamper.kdbx', (bytes, layout) => {
    bytes[layout.tagOffset] ^= 0x01;
  });
  const signatureTamper = await tamperedArtifact('signature-tamper.kdbx', (bytes, layout) => {
    const signature = JSON.parse(bytes.subarray(
      layout.signatureOffset,
      layout.signatureOffset + layout.signatureLength,
    ).toString('utf8'));
    signature.signature = `${signature.signature[0] === 'A' ? 'B' : 'A'}${signature.signature.slice(1)}`;
    const replacement = canonical(signature);
    assert.equal(replacement.length, layout.signatureLength);
    replacement.copy(bytes, layout.signatureOffset);
  });
  const truncated = path.join(root, 'truncated.kdbx');
  const midCiphertextTruncated = path.join(root, 'ciphertext-truncated.kdbx');
  const trailing = path.join(root, 'trailing.kdbx');
  const encryptedBytes = await readFile(encrypted);
  assert.equal(encryptedBytes.includes(Buffer.from(passphraseText)), false);
  const originalLayout = envelopeLayout(encryptedBytes);
  await writeFile(truncated, encryptedBytes.subarray(0, encryptedBytes.length - 1), { mode: 0o600 });
  await writeFile(
    midCiphertextTruncated,
    encryptedBytes.subarray(0, originalLayout.ciphertextOffset + 100),
    { mode: 0o600 },
  );
  await writeFile(trailing, Buffer.concat([encryptedBytes, Buffer.from('trailing')]), { mode: 0o600 });

  for (const [filename, code] of [
    [ciphertextTamper, 'backup_authenticity_rejected'],
    [nonceTamper, 'backup_authenticity_rejected'],
    [kdfTamper, 'backup_integrity_rejected'],
    [tagTamper, 'backup_authenticity_rejected'],
    [signatureTamper, 'backup_authenticity_rejected'],
    [truncated, 'backup_integrity_rejected'],
    [midCiphertextTruncated, 'backup_integrity_rejected'],
    [trailing, 'backup_integrity_rejected'],
  ]) {
    mutationCalled = false;
    await expectCode(() => withVerifiedEncryptedOfflineBackup({
      expectedProvenance: provenance,
      input: filename,
      passphrase,
      trustStorePath,
      workDirectory: workRoot,
    }, async () => { mutationCalled = true; }), code);
    assert.equal(mutationCalled, false);
  }

  for (const expectedProvenance of [
    { ...provenance, application: { ...provenance.application, version: '0.2.1' } },
    { ...provenance, application: { ...provenance.application, commit: 'e'.repeat(40) } },
    {
      ...provenance,
      database: { migrations: [{ ...provenance.database.migrations[0], checksum: 'e'.repeat(64) }] },
    },
    {
      ...provenance,
      codex: { ...provenance.codex, vendorManifestSha256: 'e'.repeat(64) },
    },
  ]) {
    await expectCode(() => verifyEncryptedOfflineBackup({
      expectedProvenance,
      input: encrypted,
      passphrase,
      trustStorePath,
      workDirectory: workRoot,
    }), 'backup_provenance_rejected');
  }

  const plaintextExtra = path.join(backupRoot, 'unlisted.txt');
  await writeFile(plaintextExtra, 'unlisted', { mode: 0o600 });
  await assert.rejects(() => verifyOfflineBackup(backupRoot), /unlisted/u);
  await rm(plaintextExtra);
  await expectCode(() => verifyEncryptedOfflineBackup({
    expectedProvenance: provenance,
    input: backupRoot,
    passphrase,
    trustStorePath,
    workDirectory: workRoot,
  }), 'backup_integrity_rejected');

  const maliciousRaw = rawArchive([
    { path: 'manifest.json', bytes: Buffer.from('{}\n') },
    { path: '../outside.txt', bytes: Buffer.from('escape') },
  ]);
  const maliciousGzip = path.join(root, 'malicious.gz');
  const maliciousOutput = path.join(root, 'malicious-output');
  await writeFile(maliciousGzip, gzipSync(maliciousRaw), { mode: 0o600 });
  await expectCode(() => extractOfflineBackupArchive(maliciousGzip, maliciousOutput, {
    archiveLength: maliciousRaw.length,
    fileCount: 2,
  }), 'backup_integrity_rejected');
  await assert.rejects(() => lstat(maliciousOutput), { code: 'ENOENT' });
  await assert.rejects(() => lstat(path.join(root, 'outside.txt')), { code: 'ENOENT' });

  const invalidGzip = path.join(root, 'invalid.gz');
  const invalidOutput = path.join(root, 'invalid-output');
  await writeFile(invalidGzip, randomBytes(64), { mode: 0o600 });
  await expectCode(() => extractOfflineBackupArchive(invalidGzip, invalidOutput, {
    archiveLength: 128,
    fileCount: 2,
  }), 'backup_integrity_rejected');
  await assert.rejects(() => lstat(invalidOutput), { code: 'ENOENT' });

  assert.throws(() => normalizeBackupPassphrase(Buffer.alloc(0)), /16 to 4096/u);
  assert.throws(() => normalizeBackupPassphrase(Buffer.from('short')), /16 to 4096/u);
  assert.throws(() => normalizeBackupPassphrase(Buffer.from('valid passphrase line\nsecond line')), /one non-empty/u);
  const normalized = normalizeBackupPassphrase(Buffer.from(`${passphraseText}\r\n`));
  assert.equal(normalized.toString('utf8'), passphraseText);
  normalized.fill(0);

  const piped = await readSecretPipe(Readable.from([Buffer.from(passphraseText)]), {
    maximumBytes: 4_096,
    minimumBytes: 1,
    name: 'Fixture secret',
  });
  assert.equal(piped.toString('utf8'), passphraseText);
  piped.fill(0);
  const tty = Readable.from([Buffer.from(passphraseText)]);
  tty.isTTY = true;
  await assert.rejects(() => readSecretPipe(tty, {
    maximumBytes: 4_096,
    minimumBytes: 1,
    name: 'Fixture secret',
  }), /non-interactive pipe/u);

  const secretFile = path.join(root, 'passphrase.secret');
  const broadSecretFile = path.join(root, 'broad.secret');
  const oversizedSecretFile = path.join(root, 'oversized.secret');
  await writeFile(secretFile, passphraseText, { mode: 0o600 });
  await writeFile(broadSecretFile, passphraseText, { mode: 0o600 });
  await writeFile(oversizedSecretFile, Buffer.alloc(4_097, 0x61), { mode: 0o600 });
  let secretFileReadable = true;
  if (process.platform === 'win32') {
    await assert.rejects(() => readRestrictedSecretFile(broadSecretFile, {
      maximumBytes: 4_096,
      minimumBytes: 1,
      name: 'Fixture secret',
    }), /ACL is broad/u);
    secretFileReadable = restrictWindowsFile(secretFile);
  }
  if (secretFileReadable) {
    const secretRead = await readRestrictedSecretFile(secretFile, {
      forbiddenRoots: [backupRoot],
      maximumBytes: 4_096,
      minimumBytes: 1,
      name: 'Fixture secret',
    });
    assert.equal(secretRead.toString('utf8'), passphraseText);
    secretRead.fill(0);
  } else {
    await assert.rejects(() => readRestrictedSecretFile(secretFile, {
      maximumBytes: 4_096,
      minimumBytes: 1,
      name: 'Fixture secret',
    }), /ACL is broad/u);
  }
  await assert.rejects(() => readRestrictedSecretFile(backupRoot, {
    maximumBytes: 4_096,
    minimumBytes: 1,
    name: 'Fixture secret',
  }), /regular file/u);
  await assert.rejects(() => readRestrictedSecretFile(oversizedSecretFile, {
    maximumBytes: 4_096,
    minimumBytes: 1,
    name: 'Fixture secret',
  }), /bounded regular file/u);
  if (process.platform !== 'win32') {
    await chmod(secretFile, 0o644);
    await assert.rejects(() => readRestrictedSecretFile(secretFile, {
      maximumBytes: 4_096,
      minimumBytes: 1,
      name: 'Fixture secret',
    }), /permissions/u);
    await chmod(secretFile, 0o600);
  }
  const secretLink = path.join(root, 'passphrase-link.secret');
  try {
    await symlink(secretFile, secretLink, 'file');
    await assert.rejects(() => readRestrictedSecretFile(secretLink, {
      maximumBytes: 4_096,
      minimumBytes: 1,
      name: 'Fixture secret',
    }), /regular file/u);
  } catch (error) {
    if (!['EPERM', 'EACCES'].includes(error?.code)) throw error;
  }

  const wrongSecretError = await verifyEncryptedOfflineBackup({
    expectedProvenance: provenance,
    input: encrypted,
    passphrase: wrongPassphrase,
    trustStorePath,
    workDirectory: workRoot,
  }).catch((error) => error);
  assert.equal(String(wrongSecretError).includes(passphraseText), false);
  assert.equal(String(wrongSecretError.stack).includes(passphraseText), false);

  await writeFile(path.join(workRoot, 'unrelated.keep'), 'keep', { mode: 0o600 });
  assert.deepEqual(
    (await readdir(workRoot)).filter((name) => name.startsWith('.kodex-backup-open-')),
    [],
  );
  assert.equal(await readFile(path.join(workRoot, 'unrelated.keep'), 'utf8'), 'keep');
  assert.deepEqual(
    (await readdir(root)).filter((name) => name.startsWith('.kodex-backup-seal-')),
    [],
  );

  process.stdout.write(`${JSON.stringify({
    kind: 'kodex_backup_encryption_fixture_passed',
    archiveBytes: first.header.payload.archiveLength,
    ciphertextBytes: first.header.payload.ciphertextLength,
    envelopeFormatVersion: first.header.formatVersion,
    multiChunk: true,
    trustStoreVersion: verified.trustStoreVersion,
  })}\n`);
} finally {
  passphrase.fill(0);
  wrongPassphrase.fill(0);
  privateKeyBytes.fill(0);
  databaseBytes?.fill?.(0);
  tenantBytes?.fill?.(0);
  await rm(root, { recursive: true, force: true });
}

async function sha256File(filename) {
  return sha256(await readFile(filename));
}
