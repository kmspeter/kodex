export const defaultSourceRoot: string;
export const defaultManifestPath: string;
export function createVendorManifest(sourceRoot?: string, commit?: string): Promise<{ algorithm: 'sha256'; upstream: string; commit: string; files: Record<string, string> }>;
export function verifyVendorManifest(sourceRoot?: string, manifestPath?: string): Promise<{ commit: string; fileCount: number }>;
