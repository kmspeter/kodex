export const DATABASE_RECOVERY_POLICY_FORMAT_VERSION: 1;
export const DATABASE_RECOVERY_RECEIPT_FORMAT_VERSION: 1;
export const DATABASE_RECOVERY_POLICY_SCHEMA_SHA256: string;

export class DatabaseRecoveryError extends Error {
  code: string;
}

export interface ParsedDatabaseRecoveryPolicy {
  policy: Record<string, unknown>;
  policyDigest: string;
  profile: 'acceptance' | 'development' | 'production';
  promotionEligible: boolean;
}

export interface ParsedDatabaseRecoveryReceipt {
  receipt: Record<string, unknown>;
  receiptDigest: string;
}

export function canonicalDatabaseRecoveryJson(value: unknown): string;
export function parseDatabaseRecoveryPolicy(value: unknown): ParsedDatabaseRecoveryPolicy;
export function readDatabaseRecoveryPolicy(filename: string): Promise<ParsedDatabaseRecoveryPolicy>;
export function parseDatabaseRecoveryReceipt(value: unknown): ParsedDatabaseRecoveryReceipt;
export function readDatabaseRecoveryReceipt(filename: string): Promise<ParsedDatabaseRecoveryReceipt>;
export function validateDatabaseRecoveryReceipt(
  policy: ParsedDatabaseRecoveryPolicy,
  receipt: ParsedDatabaseRecoveryReceipt,
  evaluatedAt: string,
): { evidenceAgeBucket: string; policyDigest: string; receiptDigest: string };
export function databaseRecoveryPolicyValidationResult(policy: ParsedDatabaseRecoveryPolicy): Record<string, unknown>;
export function createDatabaseRecoveryDrillPlan(policy: ParsedDatabaseRecoveryPolicy): Record<string, unknown>;
export function databaseRecoveryReceiptValidationResult(
  policy: ParsedDatabaseRecoveryPolicy,
  validation: { evidenceAgeBucket: string; receiptDigest: string },
): Record<string, unknown>;
export function databaseRecoveryStatusResult(
  policy: ParsedDatabaseRecoveryPolicy,
  validation: { evidenceAgeBucket: string; receiptDigest: string },
): Record<string, unknown>;
export function verifyDatabaseRecoveryRepositoryContracts(root: string): Promise<{
  documentContractCount: number;
  policyDigest: string;
  policyFormatVersion: number;
}>;
