import { describe, expect, it, vi } from 'vitest';
import {
  ProductApiConfigurationError,
  productRetentionMaintenanceConfigFromEnv,
} from '../../apps/api/src/config.js';
import {
  ProductRetentionMaintenance,
  type RetentionMaintenanceLogEvent,
  type RetentionMaintenanceRuntimeConfig,
} from '../../apps/api/src/retention-maintenance.js';
import type { RetentionRepository } from '../../packages/product-db/src/retention-repository.js';

const referenceTime = new Date('2026-09-03T12:00:00.000Z');

function runtimeConfig(overrides: Partial<RetentionMaintenanceRuntimeConfig> = {}): RetentionMaintenanceRuntimeConfig {
  return {
    abuseRateLimitStaleMs: 40_000,
    batchSize: 5,
    enabled: true,
    intervalMs: 60_000,
    invitationRetentionMs: 20_000,
    maxBatches: 2,
    rateLimitStaleMs: 30_000,
    sessionRetentionMs: 10_000,
    ...overrides,
  };
}

function fakeRepository(overrides: Partial<RetentionRepository> = {}): RetentionRepository {
  return {
    deleteStaleAbuseRateLimitsBatch: vi.fn(async () => 0),
    deleteStaleLoginRateLimitsBatch: vi.fn(async () => 0),
    deleteTerminalInvitationsBatch: vi.fn(async () => 0),
    deleteTerminalSessionsBatch: vi.fn(async () => 0),
    ...overrides,
  };
}

describe('retention maintenance configuration', () => {
  it('has documented bounded defaults and parses every explicit setting', () => {
    expect(productRetentionMaintenanceConfigFromEnv({})).toEqual({
      batchSize: 100,
      enabled: true,
      intervalMs: 3_600_000,
      invitationRetentionMs: 2_592_000_000,
      maxBatches: 10,
      sessionRetentionMs: 2_592_000_000,
    });
    expect(productRetentionMaintenanceConfigFromEnv({
      PRODUCT_RETENTION_ENABLED: 'false',
      PRODUCT_RETENTION_INTERVAL_SECONDS: '60',
      PRODUCT_RETENTION_BATCH_SIZE: '1',
      PRODUCT_RETENTION_MAX_BATCHES: '100',
      PRODUCT_RETENTION_SESSION_DAYS: '3650',
      PRODUCT_RETENTION_INVITATION_DAYS: '2',
    })).toEqual({
      batchSize: 1,
      enabled: false,
      intervalMs: 60_000,
      invitationRetentionMs: 172_800_000,
      maxBatches: 100,
      sessionRetentionMs: 315_360_000_000,
    });
  });

  it.each([
    ['PRODUCT_RETENTION_ENABLED', 'yes'],
    ['PRODUCT_RETENTION_INTERVAL_SECONDS', '59'],
    ['PRODUCT_RETENTION_INTERVAL_SECONDS', '86401'],
    ['PRODUCT_RETENTION_BATCH_SIZE', '0'],
    ['PRODUCT_RETENTION_BATCH_SIZE', '1001'],
    ['PRODUCT_RETENTION_MAX_BATCHES', '101'],
    ['PRODUCT_RETENTION_SESSION_DAYS', '0'],
    ['PRODUCT_RETENTION_INVITATION_DAYS', '3651'],
  ])('rejects invalid %s before startup', (name, value) => {
    expect(() => productRetentionMaintenanceConfigFromEnv({ [name]: value }))
      .toThrow(ProductApiConfigurationError);
  });
});

describe('product retention coordinator', () => {
  it('uses one reference time, stops after a short batch, and logs aggregate counts only', async () => {
    const repository = fakeRepository({
      deleteStaleAbuseRateLimitsBatch: vi.fn(async () => 1),
      deleteTerminalSessionsBatch: vi.fn(async () => 2),
      deleteTerminalInvitationsBatch: vi.fn(async () => 3),
      deleteStaleLoginRateLimitsBatch: vi.fn(async () => 4),
    });
    const events: RetentionMaintenanceLogEvent[] = [];
    const maintenance = new ProductRetentionMaintenance(repository, runtimeConfig(), {
      clock: () => referenceTime,
      log: (event) => events.push(event),
    });

    await expect(maintenance.runSweep('startup')).resolves.toBe(true);
    expect(repository.deleteTerminalSessionsBatch).toHaveBeenCalledWith({
      batchSize: 5,
      cutoff: new Date('2026-09-03T11:59:50.000Z'),
    });
    expect(repository.deleteTerminalInvitationsBatch).toHaveBeenCalledWith({
      batchSize: 5,
      cutoff: new Date('2026-09-03T11:59:40.000Z'),
    });
    expect(repository.deleteStaleLoginRateLimitsBatch).toHaveBeenCalledWith({
      batchSize: 5,
      cutoff: new Date('2026-09-03T11:59:30.000Z'),
      referenceTime,
    });
    expect(repository.deleteStaleAbuseRateLimitsBatch).toHaveBeenCalledWith({
      batchSize: 5,
      cutoff: new Date('2026-09-03T11:59:20.000Z'),
      referenceTime,
    });
    expect(events).toEqual([{
      abuseRateLimitsDeleted: 1,
      batches: 1,
      category: 'product_retention_maintenance',
      invitationsDeleted: 3,
      outcome: 'complete',
      rateLimitsDeleted: 4,
      sessionsDeleted: 2,
      trigger: 'startup',
    }]);
  });

  it('caps work, rejects overlap in one process, and permits a later sweep', async () => {
    let releaseFirst!: (count: number) => void;
    const firstBatch = new Promise<number>((resolve) => { releaseFirst = resolve; });
    const sessions = vi.fn()
      .mockImplementationOnce(async () => firstBatch)
      .mockResolvedValue(5);
    const repository = fakeRepository({
      deleteStaleAbuseRateLimitsBatch: vi.fn(async () => 5),
      deleteTerminalSessionsBatch: sessions,
      deleteTerminalInvitationsBatch: vi.fn(async () => 5),
      deleteStaleLoginRateLimitsBatch: vi.fn(async () => 5),
    });
    const maintenance = new ProductRetentionMaintenance(repository, runtimeConfig({ maxBatches: 2 }));

    const first = maintenance.runSweep('startup');
    await expect(maintenance.runSweep('periodic')).resolves.toBe(false);
    releaseFirst(5);
    await expect(first).resolves.toBe(true);
    expect(sessions).toHaveBeenCalledTimes(2);
    await expect(maintenance.runSweep('periodic')).resolves.toBe(true);
    expect(sessions).toHaveBeenCalledTimes(4);
  });

  it('keeps failures nonfatal and exposes no error message or dynamic error name', async () => {
    const sensitive = 'postgresql://user:secret@database/session-hash@example.invalid';
    const failure = new Error(sensitive);
    failure.name = `Leaked-${sensitive}`;
    const events: RetentionMaintenanceLogEvent[] = [];
    const maintenance = new ProductRetentionMaintenance(fakeRepository({
      deleteTerminalSessionsBatch: vi.fn(async () => { throw failure; }),
    }), runtimeConfig(), { log: (event) => events.push(event) });

    await expect(maintenance.runSweep('periodic')).resolves.toBe(true);
    expect(events).toEqual([{
      abuseRateLimitsDeleted: 0,
      batches: 1,
      category: 'product_retention_maintenance',
      errorClass: 'Error',
      invitationsDeleted: 0,
      outcome: 'failed',
      rateLimitsDeleted: 0,
      sessionsDeleted: 0,
      trigger: 'periodic',
    }]);
    expect(JSON.stringify(events)).not.toContain(sensitive);
  });

  it('does not schedule or query in disabled mode', async () => {
    const repository = fakeRepository();
    const interval = vi.spyOn(globalThis, 'setInterval');
    const maintenance = new ProductRetentionMaintenance(repository, runtimeConfig({ enabled: false }));
    maintenance.start();
    await expect(maintenance.runSweep()).resolves.toBe(false);
    await maintenance.stop();
    expect(interval).not.toHaveBeenCalled();
    expect(repository.deleteTerminalSessionsBatch).not.toHaveBeenCalled();
    interval.mockRestore();
  });

  it('clears its unrefed periodic timer and waits for in-flight work on stop', async () => {
    let release!: (count: number) => void;
    const pending = new Promise<number>((resolve) => { release = resolve; });
    const repository = fakeRepository({ deleteTerminalSessionsBatch: vi.fn(async () => pending) });
    const clear = vi.spyOn(globalThis, 'clearInterval');
    const maintenance = new ProductRetentionMaintenance(repository, runtimeConfig());
    maintenance.start();
    const stopping = maintenance.stop();
    let stopped = false;
    void stopping.then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release(0);
    await stopping;
    expect(clear).toHaveBeenCalledOnce();
    expect(repository.deleteTerminalInvitationsBatch).not.toHaveBeenCalled();
    clear.mockRestore();
  });
});
