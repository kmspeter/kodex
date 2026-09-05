import type { ReleaseArtifactManifest } from './release-artifact.mjs';

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
