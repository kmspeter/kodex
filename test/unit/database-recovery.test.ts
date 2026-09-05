import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createDatabaseRecoveryDrillPlan,
  databaseRecoveryStatusResult,
  parseDatabaseRecoveryPolicy,
  parseDatabaseRecoveryReceipt,
  validateDatabaseRecoveryReceipt,
} from '../../scripts/lib/database-recovery.mjs';

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');

async function policyValue() {
  return JSON.parse(await readFile(path.join(repositoryRoot, 'config', 'database-recovery-policy.json'), 'utf8'));
}

describe('Phase 35 managed PostgreSQL recovery policy', () => {
  it('creates only a bounded payload-free production drill plan', async () => {
    const policy = parseDatabaseRecoveryPolicy(await policyValue());
    const plan = createDatabaseRecoveryDrillPlan(policy);
    expect(plan).toMatchObject({ code: 'drill_plan_created', ok: true, stepCount: 12 });
    expect(JSON.stringify(plan)).not.toMatch(/tenantId|workspaceId|databaseUrl|snapshotId|walLsn|timeline|host|path|secret|token/iu);
  });

  it('rejects weak production combinations and non-production promotion', async () => {
    const weak = await policyValue();
    weak.walArchive.retentionHours = weak.objectives.pitrWindowHours - 1;
    expect(() => parseDatabaseRecoveryPolicy(weak)).toThrow('policy_inconsistent');

    const acceptance = await policyValue();
    acceptance.profile = 'acceptance';
    acceptance.replica.enabled = false;
    const parsed = parseDatabaseRecoveryPolicy(acceptance);
    expect(parsed.promotionEligible).toBe(false);
    expect(() => createDatabaseRecoveryDrillPlan(parsed)).toThrow('policy_profile_not_promotable');
  });

  it('blocks stale, failed, mismatched, or unsigned evidence from readiness', async () => {
    const policy = parseDatabaseRecoveryPolicy(await policyValue());
    const receipt = {
      format: 'kodex-database-recovery-drill-receipt', formatVersion: 1,
      performedAt: '2026-09-01T00:00:00.000Z', resultCode: 'passed', policyDigest: policy.policyDigest,
      artifactSignature: { algorithm: 'Ed25519', trustRef: 'trustref:recovery-evidence-v1', trustVersion: 1, verified: true },
      objectives: { rpoMet: true, rtoMet: true, observedRecoveryPointAgeMinutes: 10, observedRecoveryTimeMinutes: 45 },
      protections: {
        walArchiveVerified: true, baseBackupVerified: true, replicaVerified: true, snapshotVerified: true,
        legalHoldPropagationVerified: true, physicalDeletionBoundVerified: true,
      },
    };
    const parsedReceipt = parseDatabaseRecoveryReceipt(receipt);
    const validation = validateDatabaseRecoveryReceipt(policy, parsedReceipt, '2026-09-05T00:00:00.000Z');
    expect(databaseRecoveryStatusResult(policy, validation)).toMatchObject({ readiness: 'ready', evidenceAgeBucket: '1-6d' });
    expect(() => validateDatabaseRecoveryReceipt(policy, parsedReceipt, '2026-10-10T00:00:00.001Z')).toThrow('receipt_stale');
    expect(() => validateDatabaseRecoveryReceipt(policy, parseDatabaseRecoveryReceipt({
      ...receipt, resultCode: 'failed',
    }), '2026-09-05T00:00:00.000Z')).toThrow('receipt_failed');
    expect(() => validateDatabaseRecoveryReceipt(policy, parseDatabaseRecoveryReceipt({
      ...receipt, policyDigest: '0'.repeat(64),
    }), '2026-09-05T00:00:00.000Z')).toThrow('receipt_policy_mismatch');
    expect(() => validateDatabaseRecoveryReceipt(policy, parseDatabaseRecoveryReceipt({
      ...receipt, artifactSignature: { ...receipt.artifactSignature, verified: false },
    }), '2026-09-05T00:00:00.000Z')).toThrow('receipt_trust_rejected');
  });
});
