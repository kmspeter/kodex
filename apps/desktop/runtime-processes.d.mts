import type { ChildProcess } from 'node:child_process';

export class DesktopStartupError extends Error {
  readonly code: string;
  readonly configPath?: string;
  readonly serviceName?: string;
  constructor(code: string, details?: { configPath?: string; serviceName?: string });
}
export function publicDesktopStartupMessage(error: unknown): string;
export function unusedLoopbackPort(): Promise<number>;
export function assertOwnedChildPath(base: string, target: string, basenamePrefix: string): string;
export function validateDesktopDependencies(environment: NodeJS.ProcessEnv, configPath: string): void;
export function startRuntimeChild(
  name: string,
  executable: string,
  entry: string,
  options: { cwd: string; env: NodeJS.ProcessEnv },
): ChildProcess;
export function waitForReady(child: ChildProcess, url: string, name: string, timeoutMs?: number): Promise<void>;
export function stopProcessTree(child: ChildProcess | null | undefined, gracefulTimeoutMs?: number): Promise<void>;
export function stopRuntimeChildren(children: ChildProcess[]): Promise<void>;
