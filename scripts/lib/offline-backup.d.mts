import type { ProductDatabase } from '@kodex/product-db';

export interface OfflineDatabaseToolOptions {
  caCertificate?: string;
  database: ProductDatabase;
  databaseContainer?: string;
  databaseUrl: string;
  pgDumpBinary?: string;
  pgRestoreBinary?: string;
  sslMode?: 'disable' | 'require' | 'verify-full';
}

export interface OfflineBackupManifest {
  application: { commit: string | null; version: string };
  createdAt: string;
  database: {
    file: 'database.dump';
    format: 'postgres-custom';
    migrations: Array<{ checksum: string; name: string; version: number }>;
    sha256: string;
    sizeBytes: number;
  };
  formatVersion: 1;
  tenantData: {
    directory: 'tenant-data';
    fileCount: number;
    files: Array<{ path: string; sha256: string; sizeBytes: number }>;
    totalBytes: number;
  };
}

export const OFFLINE_BACKUP_FORMAT_VERSION: 1;
export const OFFLINE_MAINTENANCE_LOCK: '.kodex-offline-maintenance.lock';

export function verifyOfflineBackup(input: string): Promise<OfflineBackupManifest>;
export function createOfflineBackup(options: OfflineDatabaseToolOptions & {
  applicationVersion: string;
  commit?: string | null;
  dataRoot: string;
  output: string;
}): Promise<{ durationMs: number; manifest: OfflineBackupManifest }>;
export function restoreOfflineBackup(options: OfflineDatabaseToolOptions & {
  dataRoot: string;
  input: string;
}): Promise<{ durationMs: number; manifest: OfflineBackupManifest }>;
