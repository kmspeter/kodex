export interface LongRunResourceSample {
  heapBytes: number;
  handleCount: number;
  socketCount: number;
  databasePoolCount: number;
  outboxItemCount: number;
  leaseCount: number;
  temporaryBytes: number;
  diskBytes: number;
}

export class LongRunAcceptanceError extends Error { code: string; }
export class LongRunSimulatedCrash extends Error {}
export const LONG_RUN_FORMAT_VERSION: 1;
export const LONG_RUN_COMMAND_ALLOWLIST: Readonly<Record<string, { kind: 'workload' | 'chaos'; npmScript: string }>>;
export function canonicalLongRunJson(value: unknown): string;
export function parseLongRunScenarioCatalog(value: unknown, options?: { commandAllowlist?: Record<string, { kind: string; npmScript: string }> }): unknown;
export function readLongRunScenarioCatalog(filename: string): Promise<unknown>;
export function parseLongRunConfig(value: unknown, parsedCatalog: unknown): unknown;
export function readLongRunConfig(filename: string, parsedCatalog: unknown): Promise<unknown>;
export function parseLongRunState(value: unknown, parsedPlan?: unknown): unknown;
export function readLongRunState(filename: string, parsedPlan?: unknown): Promise<unknown>;
export function parseLongRunAdapterResult(value: unknown): unknown;
export function parseLongRunReceipt(value: unknown): { receipt: unknown; receiptDigest: string };
export function readLongRunReceipt(filename: string): Promise<{ receipt: unknown; receiptDigest: string }>;
export function runLongRunAcceptance(options: Record<string, unknown>): Promise<{ receipt: unknown; receiptDigest: string }>;
export function createProcessLongRunAdapter(repositoryRoot: string, parsedCatalog: unknown): unknown;
export function writeLongRunReceipt(filename: string, parsedReceipt: unknown): Promise<{ receipt: unknown; receiptDigest: string }>;
