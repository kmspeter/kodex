import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createDatabaseRecoveryDrillPlan,
  databaseRecoveryReceiptSigningPayload,
  databaseRecoveryStatusResult,
  parseDatabaseRecoveryPolicy,
  parseDatabaseRecoveryReceipt,
  signDatabaseRecoveryReceipt,
  validateDatabaseRecoveryReceipt,
} from '../../scripts/lib/database-recovery.mjs';
import type { DatabaseRecoveryUnsignedReceipt } from '../../scripts/lib/database-recovery.mjs';

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');
const temporaryRoots: string[] = [];

afterEach(async () => Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true }))));

async function policyValue() {
  return JSON.parse(await readFile(path.join(repositoryRoot, 'config', 'database-recovery-policy.json'), 'utf8'));
}

async function signingFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodex-recovery-unit-'));
  temporaryRoots.push(root);
  const keys = generateKeyPairSync('ed25519');
  const keyId = 'recovery-unit-key';
  const trustVersion = 7;
  const trustStorePath = path.join(root, 'trust-store.json');
  await writeFile(trustStorePath, `${JSON.stringify({
    format: 'kodex-release-trust-store', formatVersion: 1, storeVersion: trustVersion,
    keys: [{
      keyId, algorithm: 'Ed25519', status: 'trusted',
      publicKey: Buffer.from(keys.publicKey.export({ format: 'der', type: 'spki' })).toString('base64'),
    }],
  }, null, 2)}\n`, 'utf8');
  return {
    keyId,
    privateKey: Buffer.from(keys.privateKey.export({ format: 'pem', type: 'pkcs8' })),
    trustStorePath,
    trustVersion,
  };
}

function unsignedReceipt(
  policy: ReturnType<typeof parseDatabaseRecoveryPolicy>,
  fixture: Awaited<ReturnType<typeof signingFixture>>,
): DatabaseRecoveryUnsignedReceipt {
  return {
    format: 'kodex-database-recovery-drill-receipt', formatVersion: 1,
    performedAt: '2026-09-01T00:00:00.000Z', resultCode: 'passed', policyDigest: policy.policyDigest,
    artifactSignature: {
      algorithm: 'Ed25519', trustRef: 'trustref:recovery-evidence-v1',
      trustVersion: fixture.trustVersion, keyId: fixture.keyId,
    },
    objectives: { rpoMet: true, rtoMet: true, observedRecoveryPointAgeMinutes: 10, observedRecoveryTimeMinutes: 45 },
    protections: {
      walArchiveVerified: true, baseBackupVerified: true, replicaVerified: true, snapshotVerified: true,
      legalHoldPropagationVerified: true, physicalDeletionBoundVerified: true,
    },
  };
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

  it('cryptographically binds every receipt semantic field to the external trust store', async () => {
    const policy = parseDatabaseRecoveryPolicy(await policyValue());
    const fixture = await signingFixture();
    const signed = signDatabaseRecoveryReceipt(unsignedReceipt(policy, fixture), fixture.privateKey);
    expect(signed.artifactSignature).not.toHaveProperty('verified');
    expect(signed.artifactSignature.signature).toMatch(/^[A-Za-z0-9+/]{86}==$/u);
    expect(databaseRecoveryReceiptSigningPayload(signed).toString()).toContain('kodex-database-recovery-drill-receipt-signature-v1');

    const parsedReceipt = parseDatabaseRecoveryReceipt(signed);
    const validation = await validateDatabaseRecoveryReceipt(
      policy, parsedReceipt, '2026-09-05T00:00:00.000Z', fixture.trustStorePath,
    );
    expect(databaseRecoveryStatusResult(policy, validation)).toMatchObject({ readiness: 'ready', evidenceAgeBucket: '1-6d' });

    const altered = structuredClone(signed);
    altered.objectives.observedRecoveryTimeMinutes += 1;
    await expect(validateDatabaseRecoveryReceipt(
      policy, parseDatabaseRecoveryReceipt(altered), '2026-09-05T00:00:00.000Z', fixture.trustStorePath,
    )).rejects.toThrow('receipt_signature_invalid');
    await expect(validateDatabaseRecoveryReceipt(
      policy, parsedReceipt, '2026-09-05T00:00:00.000Z', path.join(path.dirname(fixture.trustStorePath), 'missing.json'),
    )).rejects.toThrow('receipt_trust_store_invalid');
    fixture.privateKey.fill(0);
  });

  it('keeps the receipt schema exact and removes the forgeable verified boolean', async () => {
    const schema = JSON.parse(await readFile(
      path.join(repositoryRoot, 'config', 'database-recovery-receipt.schema.json'), 'utf8',
    ));
    expect(schema.properties.artifactSignature.required.sort()).toEqual([
      'algorithm', 'keyId', 'signature', 'trustRef', 'trustVersion',
    ]);
    expect(schema.properties.artifactSignature.properties).not.toHaveProperty('verified');
  });
});
