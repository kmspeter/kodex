import type { Readable } from 'node:stream';

export interface RestrictedSecretOptions {
  forbiddenRoots?: string[];
  maximumBytes: number;
  minimumBytes: number;
  name: string;
}

export function readRestrictedSecretFile(
  filename: string,
  options: RestrictedSecretOptions,
): Promise<Buffer>;
export function readSecretPipe(stream: Readable, options: RestrictedSecretOptions): Promise<Buffer>;
export function normalizeBackupPassphrase(bytes: Uint8Array): Buffer;
export function assertRestrictedDirectory(dirname: string, name?: string): Promise<string>;
