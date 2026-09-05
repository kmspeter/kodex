export interface WindowsInstallerAclAdapter {
  readonly executablePath?: string;
  assertSafeTree(root: string, purpose: string): Promise<boolean> | boolean;
}

export interface WindowsInstallerOptions {
  aclAdapter?: WindowsInstallerAclAdapter;
  installRoot: string;
  layoutPath: string;
}

export interface WindowsInstallerCandidateOptions extends WindowsInstallerOptions {
  candidate: string;
  trustStorePath: string;
}

export interface WindowsInstallerReleaseOptions extends WindowsInstallerOptions {
  releaseId: string;
  trustStorePath: string;
}

export class WindowsInstallerError extends Error {
  readonly code: string;
  constructor(code: string);
}

export const WINDOWS_INSTALLER_FORMAT_VERSION: 1;
export const WINDOWS_RELEASE_COMPATIBILITY_PATH: 'resources/app/metadata/installer-compatibility.json';
export function loadWindowsInstallerLayout(filename: string): Promise<Record<string, unknown>>;
export function createExternalWindowsAclAdapter(executable: string): Promise<WindowsInstallerAclAdapter>;
export function planWindowsInstallerUpdate(options: WindowsInstallerCandidateOptions): Promise<Record<string, unknown>>;
export function stageWindowsInstallerCandidate(options: WindowsInstallerCandidateOptions): Promise<Record<string, unknown>>;
export function activateWindowsInstallerRelease(options: WindowsInstallerReleaseOptions): Promise<Record<string, unknown>>;
export function confirmWindowsInstallerRelease(options: WindowsInstallerReleaseOptions & {
  databaseSchemaVersion: number;
}): Promise<Record<string, unknown>>;
export function rollbackWindowsInstallerRelease(options: WindowsInstallerOptions & {
  databaseSchemaVersion?: number;
  trustStorePath: string;
}): Promise<Record<string, unknown>>;
export function recoverWindowsInstaller(options: WindowsInstallerOptions & {
  trustStorePath: string;
}): Promise<Record<string, unknown>>;
export function windowsInstallerStatus(options: WindowsInstallerOptions): Promise<Record<string, unknown>>;
export function planWindowsUninstallCodeBoundary(options: WindowsInstallerOptions): Promise<Record<string, unknown>>;
export function holdWindowsInstallerLockForTest(
  options: WindowsInstallerOptions,
  action: () => Promise<unknown>,
): Promise<unknown>;
