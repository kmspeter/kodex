import type { ReleaseArtifactManifest } from './release-artifact.mjs';
import type { KeyObject } from 'node:crypto';

export interface ReleaseSignatureEnvelope {
  algorithm: 'Ed25519';
  format: 'kodex-release-signature';
  formatVersion: 1;
  keyId: string;
  manifestSha256: string;
  signature: string;
}

export const RELEASE_SIGNATURE_FORMAT_VERSION: 1;
export const RELEASE_TRUST_STORE_FORMAT_VERSION: 1;

export function parseEd25519PrivateKey(bytes: Uint8Array): KeyObject;
export function signEd25519Payload(payload: Uint8Array, privateKeyBytes: Uint8Array): Buffer;
export function verifyTrustedEd25519Payload(options: {
  keyId: string;
  payload: Uint8Array;
  signature: Uint8Array;
  trustStorePath: string;
}): Promise<{ storeVersion: number }>;

export function validateReleaseTrustStore(filename: string): Promise<{
  keyCount: number;
  revokedKeyCount: number;
  storeVersion: number;
  trustedKeyCount: number;
}>;

export function signReleaseArtifact(options: {
  directory: string;
  forbiddenKeyRoots?: string[];
  keyFile?: string;
  keyId: string;
  privateKeyBytes?: Uint8Array;
}): Promise<ReleaseSignatureEnvelope>;

export function verifyReleaseArtifact(directory: string, options: {
  trustStorePath: string;
}): Promise<{
  keyId: string;
  manifest: ReleaseArtifactManifest;
  manifestSha256: string;
  signatureFormatVersion: 1;
  trustStoreVersion: number;
}>;
