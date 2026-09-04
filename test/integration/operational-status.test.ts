import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProductOperationalTelemetry } from '../../apps/api/src/operational-status.js';
import { ProductApiServer } from '../../apps/api/src/server.js';
import type { ProductApiConfig } from '../../apps/api/src/config.js';
import { LocalHttpServer } from '../../apps/local-server/src/api/http-server.js';
import type {
  ProductAuthorization,
  ProductAuthorizer,
} from '../../apps/local-server/src/auth/product-authorization.js';
import { LocalOperationalTelemetry } from '../../apps/local-server/src/operational-status.js';
import { RuntimeManager, type RuntimeManagerOperationalStatus } from '../../apps/local-server/src/runtime-manager.js';

const secret = 'observability-secret-that-is-never-returned-123456789';
const sensitive = 'postgresql://operator:super-secret@database/private-history';
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function productConfig(): ProductApiConfig {
  return {
    allowedHosts: new Set(),
    allowedOrigins: new Set(['http://127.0.0.1:5173']),
    cookieSecret: Buffer.alloc(32, 7),
    host: '127.0.0.1',
    loginRateLimitBlockMs: 900_000,
    loginRateLimitMaxAttempts: 5,
    loginRateLimitWindowMs: 900_000,
    maxBodyBytes: 65_536,
    port: 0,
    secureCookies: false,
    sessionTtlMs: 60_000,
  };
}

function runtimeStatus(): RuntimeManagerOperationalStatus {
  return {
    activeLeases: 2,
    activeRuntimes: 2,
    atCapacity: true,
    engine: {
      failed: 1,
      missingBinary: 0,
      missingKey: 0,
      ready: 1,
      starting: 0,
      stopped: 0,
    },
    history: {
      attachedRuntimes: 2,
      databaseUnavailableRuntimes: 1,
      invalidSpoolRuntimes: 0,
      overflowedRuntimes: 1,
      pendingBytes: 4_096,
      pendingRecords: 3,
      reconciliationFailedRuntimes: 1,
      reconciliationPartialRuntimes: 0,
      reconciliationRunningRuntimes: 0,
      runningOutboxes: 2,
    },
    maxActiveRuntimes: 2,
    startingRuntimes: 0,
  };
}

describe('authenticated payload-free operational status', () => {
  it('keeps Product API failures behind bearer auth and removes injected diagnostics', async () => {
    const readiness = { check: vi.fn(async () => { throw new Error(sensitive); }) };
    const telemetry = new ProductOperationalTelemetry(readiness, undefined, () => Date.parse('2026-09-04T00:00:00.000Z'));
    const auth = {
      authenticate: vi.fn(),
      login: vi.fn(),
      logout: vi.fn(),
      register: vi.fn(),
    };
    const disabled = new ProductApiServer(auth, productConfig());
    const disabledPort = await disabled.listen();
    try {
      expect((await fetch(`http://127.0.0.1:${disabledPort}/api/operations/status`)).status).toBe(404);
    } finally {
      await disabled.close();
    }
    const server = new ProductApiServer(auth, productConfig(), undefined, undefined, readiness, undefined, undefined, undefined, undefined, {
      token: secret,
      snapshot: () => telemetry.snapshot(),
    });
    const port = await server.listen();
    const endpoint = `http://127.0.0.1:${port}/api/operations/status`;
    try {
      expect((await fetch(endpoint)).status).toBe(401);
      expect((await fetch(endpoint, { headers: { Authorization: `Bearer ${secret}x` } })).status).toBe(401);
      expect((await fetch(endpoint, {
        headers: { Authorization: `Bearer ${secret}`, Origin: 'http://127.0.0.1:5173' },
      })).status).toBe(401);

      const response = await fetch(endpoint, { headers: { Authorization: `Bearer ${secret}` } });
      const text = await response.text();
      expect(response.status).toBe(200);
      expect(JSON.parse(text)).toMatchObject({
        alerts: [{ code: 'product_database_unavailable', severity: 'critical' }],
        component: 'product-api',
        database: { consecutiveFailures: 1, status: 'down' },
        status: 'degraded',
      });
      expect(text).not.toContain(sensitive);
      expect(text).not.toContain(secret);
    } finally {
      await server.close();
    }
  });

  it('aggregates Local runtime/history/reconciliation and DB/revalidation failures without tenant data', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodex-operations-'));
    roots.push(root);
    const manager = new RuntimeManager({
      dataRoot: path.join(root, 'data'),
      repositoryRoot: root,
      runtimeOptions: { startAppServer: false },
      tenantRoot: path.join(root, 'data', 'tenants'),
    });
    let databaseUnavailable = true;
    let now = Date.parse('2026-09-04T01:00:00.000Z');
    const telemetry = new LocalOperationalTelemetry(
      { operationalStatus: runtimeStatus },
      async () => { if (databaseUnavailable) throw new Error(sensitive); },
      () => now,
    );
    telemetry.recordHistory({
      kind: 'history_reconciliation_failed',
      counts: {
        failedThreads: 1,
        items: 0,
        threadPages: 0,
        threads: 0,
        truncated: false,
        turnPages: 0,
        turns: 0,
      },
      phase: 'items',
      retryInMs: 5_000,
    });
    telemetry.recordSecurity({ kind: 'ws_revalidation_failed', status: 503 });
    const authorizer: ProductAuthorizer = {
      authorizeRequest: vi.fn(async () => { throw new Error('not used'); }),
      reauthorize: vi.fn(async (authorization: ProductAuthorization) => authorization),
    };
    const disabled = new LocalHttpServer(manager, authorizer, {
      allowedOrigins: new Set(['http://127.0.0.1:5173']),
      host: '127.0.0.1',
      port: 0,
    });
    const disabledPort = await disabled.listen();
    try {
      expect((await fetch(`http://127.0.0.1:${disabledPort}/api/operations/status`)).status).toBe(404);
    } finally {
      await disabled.close();
    }
    const server = new LocalHttpServer(manager, authorizer, {
      allowedOrigins: new Set(['http://127.0.0.1:5173']),
      host: '127.0.0.1',
      operations: { token: secret, snapshot: () => telemetry.snapshot() },
      port: 0,
    });
    const port = await server.listen();
    const endpoint = `http://127.0.0.1:${port}/api/operations/status`;
    try {
      expect((await fetch(endpoint)).status).toBe(401);
      const response = await fetch(endpoint, { headers: { Authorization: `Bearer ${secret}` } });
      const text = await response.text();
      const body = JSON.parse(text) as {
        alerts: Array<{ code: string }>;
        counters: { historyReconciliationFailures: number };
        status: string;
      };
      expect(response.status).toBe(200);
      expect(body.status).toBe('degraded');
      expect(body.counters.historyReconciliationFailures).toBe(1);
      expect(body.alerts.map((alert) => alert.code)).toEqual(expect.arrayContaining([
        'local_database_unavailable',
        'runtime_capacity_saturated',
        'codex_app_server_unavailable',
        'history_outbox_overflow',
        'history_outbox_database_unavailable',
        'history_reconciliation_failed',
        'authorization_revalidation_unavailable',
      ]));
      expect(text).not.toContain(sensitive);
      expect(text).not.toContain(secret);
      expect(text).not.toContain(root);

      databaseUnavailable = false;
      now += 1_000;
      telemetry.recordSecurity({ kind: 'ws_revalidation_succeeded', status: 200 });
      const recovered = await (await fetch(endpoint, {
        headers: { Authorization: `Bearer ${secret}` },
      })).json() as { alerts: Array<{ code: string }>; database: { status: string } };
      expect(recovered.database.status).toBe('up');
      expect(recovered.alerts.map((alert) => alert.code)).not.toContain('local_database_unavailable');
      expect(recovered.alerts.map((alert) => alert.code)).not.toContain('authorization_revalidation_unavailable');
    } finally {
      await server.close();
      await manager.close();
    }
  });
});
