export const DATABASE_RECOVERY_POLICY_FORMAT_VERSION: 1;
export const DATABASE_RECOVERY_RECEIPT_FORMAT_VERSION: 1;
export const DATABASE_RECOVERY_RECEIPT_SIGNATURE_DOMAIN: 'kodex-database-recovery-drill-receipt-signature-v1';
export const DATABASE_RECOVERY_POLICY_SCHEMA_SHA256: string;
export const DATABASE_RECOVERY_RECEIPT_SCHEMA_SHA256: string;

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
  receipt: DatabaseRecoveryReceipt;
  receiptDigest: string;
}

export interface DatabaseRecoveryReceiptObjectives {
  observedRecoveryPointAgeMinutes: number;
  observedRecoveryTimeMinutes: number;
  rpoMet: boolean;
  rtoMet: boolean;
}

export interface DatabaseRecoveryReceiptProtections {
  baseBackupVerified: boolean;
  legalHoldPropagationVerified: boolean;
  physicalDeletionBoundVerified: boolean;
  replicaVerified: boolean;
  snapshotVerified: boolean;
  walArchiveVerified: boolean;
}

export interface DatabaseRecoveryUnsignedReceipt {
  artifactSignature: {
    algorithm: 'Ed25519';
    keyId: string;
    trustRef: string;
    trustVersion: number;
  };
  format: 'kodex-database-recovery-drill-receipt';
  formatVersion: 1;
  objectives: DatabaseRecoveryReceiptObjectives;
  performedAt: string;
  policyDigest: string;
  protections: DatabaseRecoveryReceiptProtections;
  resultCode: 'control-failed' | 'failed' | 'passed' | 'rpo-missed' | 'rto-missed';
}

export interface DatabaseRecoveryReceipt extends Omit<DatabaseRecoveryUnsignedReceipt, 'artifactSignature'> {
  artifactSignature: DatabaseRecoveryUnsignedReceipt['artifactSignature'] & { signature: string };
}

export function canonicalDatabaseRecoveryJson(value: unknown): string;
export function parseDatabaseRecoveryPolicy(value: unknown): ParsedDatabaseRecoveryPolicy;
export function readDatabaseRecoveryPolicy(filename: string): Promise<ParsedDatabaseRecoveryPolicy>;
export function parseDatabaseRecoveryReceipt(value: unknown): ParsedDatabaseRecoveryReceipt;
export function readDatabaseRecoveryReceipt(filename: string): Promise<ParsedDatabaseRecoveryReceipt>;
export function databaseRecoveryReceiptSigningPayload(value: unknown): Buffer;
export function signDatabaseRecoveryReceipt(
  unsignedReceipt: DatabaseRecoveryUnsignedReceipt,
  privateKeyBytes: Uint8Array,
): DatabaseRecoveryReceipt;
export function validateDatabaseRecoveryReceipt(
  policy: ParsedDatabaseRecoveryPolicy,
  receipt: ParsedDatabaseRecoveryReceipt,
  evaluatedAt: string,
  trustStorePath: string,
): Promise<{ evidenceAgeBucket: string; policyDigest: string; receiptDigest: string }>;
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
  receiptFormatVersion: number;
  schemaContractCount: number;
}>;
