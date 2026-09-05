export interface RepositoryProvenance {
  binaryPresent: boolean;
  binarySha256?: string;
  buildMetadataSha256?: string;
  cargoLockSha256: string;
  commit: string;
  dependencyCount: number;
  packageLockSha256: string;
  vendorFileCount: number;
  vendorManifestSha256: string;
  workspaceCount: number;
}

export function sha256File(filename: string): Promise<string>;
export function verifyPackageLock(root: string): Promise<Pick<RepositoryProvenance, 'dependencyCount' | 'packageLockSha256' | 'workspaceCount'>>;
export function verifyRepositoryProvenance(root: string, options?: { requireBinary?: boolean }): Promise<RepositoryProvenance>;
export function verifyPackagedRuntimeProvenance(appRoot: string, expected: RepositoryProvenance): Promise<{
  binarySha256: string; cargoLockSha256: string; commit: string; packageLockSha256: string; vendorManifestSha256: string;
}>;
export function scanTrackedSecrets(root: string): Promise<{ fileCount: number; scannedBytes: number; textFileCount: number }>;
export function scanReleaseInputSecrets(root: string): Promise<{ fileCount: number; scannedBytes: number; textFileCount: number }>;
export function verifyDeploymentContracts(root: string): Promise<{ contractCount: number }>;
