import type {
  OfflineBackupManifest,
  OfflineDatabaseToolOptions,
} from './offline-backup.mjs';

export interface OfflineBackupProvenance {
  application: { commit: string; version: string };
  codex: { upstreamCommit: string; vendorManifestSha256: string };
  database: { migrations: Array<{ checksum: string; name: string; version: number }> };
}

export interface OfflineBackupEnvelopeHeader {
  createdAt: string;
  encryption: { algorithm: 'AES-256-GCM'; nonce: string; tagLength: 16 };
  format: 'kodex-offline-backup';
  formatVersion: 2;
  kdf: {
    N: 32768;
    algorithm: 'scrypt';
    domain: 'kodex-offline-backup-v2';
    keyLength: 32;
    p: 1;
    r: 8;
    salt: string;
  };
  payload: {
    archiveLength: number;
    ciphertextLength: number;
    compression: 'gzip';
    fileCount: number;
    format: 'kodex-offline-backup-archive';
    formatVersion: 1;
  };
  provenance: OfflineBackupProvenance;
}

export class OfflineBackupEnvelopeError extends Error {
  code: string;
}

export const OFFLINE_BACKUP_ENVELOPE_FORMAT_VERSION: 2;
export const OFFLINE_BACKUP_ARCHIVE_FORMAT_VERSION: 1;

export function packOfflineBackupArchive(inputDirectory: string, output: string): Promise<{
  archiveLength: number;
  ciphertextLength: number;
  fileCount: number;
  manifest: OfflineBackupManifest;
}>;
export function extractOfflineBackupArchive(
  input: string,
  output: string,
  expected: { archiveLength: number; fileCount: number },
): Promise<OfflineBackupManifest>;

interface EncryptedBackupReadOptions {
  expectedProvenance: OfflineBackupProvenance;
  input: string;
  passphrase: Uint8Array;
  trustStorePath: string;
  workDirectory?: string;
}

interface EncryptedBackupVerification {
  header: OfflineBackupEnvelopeHeader;
  keyId: string;
  manifest: OfflineBackupManifest;
  trustStoreVersion: number;
}

export function sealOfflineBackupDirectory(options: {
  input: string;
  keyId: string;
  output: string;
  passphrase: Uint8Array;
  privateKeyBytes: Uint8Array;
  provenance: OfflineBackupProvenance;
}): Promise<{
  ciphertextSha256: string;
  header: OfflineBackupEnvelopeHeader;
  manifest: OfflineBackupManifest;
  signature: object;
}>;

export function createEncryptedOfflineBackup(options: OfflineDatabaseToolOptions & {
  applicationVersion: string;
  commit: string;
  dataRoot: string;
  keyId: string;
  output: string;
  passphrase: Uint8Array;
  privateKeyBytes: Uint8Array;
  provenance: OfflineBackupProvenance;
}): Promise<{
  ciphertextSha256: string;
  durationMs: number;
  header: OfflineBackupEnvelopeHeader;
  manifest: OfflineBackupManifest;
  signature: object;
}>;

export function withVerifiedEncryptedOfflineBackup<T>(
  options: EncryptedBackupReadOptions,
  operation: (verified: EncryptedBackupVerification & { plaintextRoot: string }) => Promise<T>,
): Promise<EncryptedBackupVerification & { result: T }>;
export function verifyEncryptedOfflineBackup(
  options: EncryptedBackupReadOptions,
): Promise<EncryptedBackupVerification>;
export function restoreEncryptedOfflineBackup(
  options: EncryptedBackupReadOptions & OfflineDatabaseToolOptions & { dataRoot: string },
): Promise<EncryptedBackupVerification & { durationMs: number }>;
