export class ReleaseAcceptanceError extends Error { code: string; }
export const RELEASE_ACCEPTANCE_FORMAT_VERSION: 1;
export const RELEASE_ACCEPTANCE_COMMAND_ALLOWLIST: Readonly<Record<string, { executionClass: string; npmScript: string | null }>>;
export const ACCEPTANCE_SCHEMA_SHA256: Readonly<Record<string, string>>;
export function canonicalReleaseAcceptanceJson(value: unknown): string;
export function parseReleaseAcceptanceCatalog(value: unknown): unknown;
export function readReleaseAcceptanceCatalog(filename: string): Promise<unknown>;
export function releaseAcceptanceEvidenceSigningPayload(value: unknown): Buffer;
export function signReleaseAcceptanceEvidence(unsignedEvidence: unknown, privateKeyBytes: Uint8Array): unknown;
export function parseReleaseAcceptanceEvidence(value: unknown): { evidence: unknown; evidenceDigest: string };
export function collectReleaseRepositoryIdentity(repositoryRoot: string): Promise<unknown>;
export function collectReleaseSourceEvidence(options: Record<string, unknown>): Promise<unknown>;
export function evaluateReleaseReadiness(options: Record<string, unknown>): Promise<Record<string, unknown>>;
export function releaseReadinessFromRepository(options: Record<string, unknown>): Promise<Record<string, unknown>>;
export function verifyAcceptanceRepositoryContracts(repositoryRoot: string): Promise<Record<string, unknown>>;
