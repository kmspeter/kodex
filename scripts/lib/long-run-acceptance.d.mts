export interface LongRunObservedValue { observed: boolean; value: number | null; }
export interface LongRunResourceSample {
  heapBytes: LongRunObservedValue;
  handleCount: LongRunObservedValue;
  socketCount: LongRunObservedValue;
  databasePoolCount: LongRunObservedValue;
  outboxItemCount: LongRunObservedValue;
  leaseCount: LongRunObservedValue;
  temporaryBytes: LongRunObservedValue;
  diskBytes: LongRunObservedValue;
}

export class LongRunAcceptanceError extends Error { code: string; }
export class LongRunSimulatedCrash extends Error {}
export const LONG_RUN_FORMAT_VERSION: 1;
export const LONG_RUN_RESOURCE_NAMES: readonly string[];
export const LONG_RUN_COMMAND_ALLOWLIST: Readonly<Record<string, {
  kind: 'workload' | 'chaos';
  npmScript: string;
  recoveryEvidence: 'none' | 'reconnect' | 'restart';
}>>;
export function canonicalLongRunJson(value: unknown): string;
export function parseLongRunScenarioCatalog(value: unknown, options?: { commandAllowlist?: Record<string, { kind: string; npmScript: string }> }): unknown;
export function readLongRunScenarioCatalog(filename: string): Promise<unknown>;
export function parseLongRunConfig(value: unknown, parsedCatalog: unknown): unknown;
export function readLongRunConfig(filename: string, parsedCatalog: unknown): Promise<unknown>;
export function parseLongRunState(value: unknown, parsedPlan?: unknown): unknown;
export function readLongRunState(filename: string, parsedPlan?: unknown): Promise<unknown>;
export function parseLongRunAdapterResult(value: unknown): unknown;
export function resolveNpmCliInvocation(npmExecPath?: string): { executable: string; argumentPrefix: string[] };
export function readExternalLongRunAdapterResult(
  resultDirectory: string,
  repositoryRoot: string,
  invocation: Record<string, unknown>,
  options?: { consumedInvocationIds?: Set<string> },
): Promise<unknown>;
export function parseLongRunReceipt(value: unknown): { receipt: unknown; receiptDigest: string };
export function readLongRunReceipt(filename: string): Promise<{ receipt: unknown; receiptDigest: string }>;
export function runLongRunAcceptance(options: Record<string, unknown>): Promise<{ receipt: unknown; receiptDigest: string }>;
export function createProcessLongRunAdapter(
  repositoryRoot: string,
  parsedCatalog: unknown,
  options?: { npmExecPath?: string; resultDirectory?: string },
): unknown;
export function writeLongRunReceipt(filename: string, parsedReceipt: unknown): Promise<{ receipt: unknown; receiptDigest: string }>;
