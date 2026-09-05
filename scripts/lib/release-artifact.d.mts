export interface ReleaseMigration {
  checksum: string;
  name: string;
  version: number;
}

export interface ReleaseArtifactManifest {
  codex: { upstreamCommit: string; vendorManifestSha256: string };
  createdAt: string;
  database: { migrations: ReleaseMigration[] };
  files: Array<{ path: string; sha256: string; sizeBytes: number }>;
  formatVersion: 1;
  release: { arch: 'x64'; commit: string; platform: 'win32'; version: string };
}

export const RELEASE_ARTIFACT_FORMAT_VERSION: 1;
export const RELEASE_MANIFEST_FILENAME: 'release-manifest.json';
export const RELEASE_SIGNATURE_FILENAME: 'release-signature.json';
export function readCanonicalReleaseManifest(directory: string): Promise<{
  bytes: Buffer;
  manifest: ReleaseArtifactManifest;
}>;
export function verifyReleaseArtifactIntegrity(directory: string): Promise<ReleaseArtifactManifest>;
export function createReleaseArtifact(options: {
  codexUpstreamCommit: string;
  commit: string;
  migrations: ReleaseMigration[];
  output: string;
  runtimeRoot: string;
  vendorManifestSha256: string;
  version: string;
}): Promise<{ manifest: ReleaseArtifactManifest; releaseId: string }>;
