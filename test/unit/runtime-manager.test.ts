import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeScope } from '../../apps/local-server/src/auth/product-authorization';
import { KodexRuntime } from '../../apps/local-server/src/runtime';
import { RuntimeCapacityError, RuntimeManager } from '../../apps/local-server/src/runtime-manager';

const roots: string[] = [];
const userA = '10000000-0000-4000-8000-000000000001';
const userB = '10000000-0000-4000-8000-000000000002';
const workspaceA = '20000000-0000-4000-8000-000000000001';
const workspaceB = '20000000-0000-4000-8000-000000000002';

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function scope(userId: string, workspaceId: string): RuntimeScope {
  return {
    userId,
    workspaceId,
    sessionId: '30000000-0000-4000-8000-000000000001',
    sessionExpiresAt: new Date(Date.now() + 60_000),
    workspaceRole: 'owner',
  };
}

async function root(): Promise<string> {
  const value = await mkdtemp(path.join(os.tmpdir(), 'kodex-runtime-manager-'));
  roots.push(value);
  return value;
}

describe('tenant RuntimeManager', () => {
  it('deduplicates concurrent creation and physically separates user/workspace CODEX_HOME roots', async () => {
    const repositoryRoot = await root();
    let creations = 0;
    const manager = new RuntimeManager({
      repositoryRoot,
      tenantRoot: path.join(repositoryRoot, 'tenants'),
      createRuntime: (_scope, dataRoot) => {
        creations += 1;
        return new KodexRuntime(repositoryRoot, undefined, { dataRoot, startAppServer: false });
      },
    });
    try {
      const [first, second] = await Promise.all([
        manager.acquire(scope(userA, workspaceA)),
        manager.acquire(scope(userA, workspaceA)),
      ]);
      expect(creations).toBe(1);
      expect(first.runtime).toBe(second.runtime);
      expect(first.scope).toMatchObject({
        sessionId: '30000000-0000-4000-8000-000000000001',
        workspaceRole: 'owner',
      });
      expect(first.runtime.store.root).toBe(path.join(repositoryRoot, 'tenants', 'users', userA, 'workspaces', workspaceA));
      await expect(stat(first.runtime.store.codexHome)).resolves.toMatchObject({});
      first.release();
      second.release();

      const refreshed = await manager.acquire({
        ...scope(userA, workspaceA),
        sessionId: '30000000-0000-4000-8000-000000000002',
        workspaceRole: 'member',
      });
      expect(refreshed.runtime).toBe(first.runtime);
      expect(refreshed.scope).toMatchObject({
        sessionId: '30000000-0000-4000-8000-000000000002',
        workspaceRole: 'member',
      });
      expect(first.scope).toMatchObject({
        sessionId: '30000000-0000-4000-8000-000000000001',
        workspaceRole: 'owner',
      });
      refreshed.release();

      const sameWorkspaceOtherUser = await manager.acquire(scope(userB, workspaceA));
      const sameUserOtherWorkspace = await manager.acquire(scope(userA, workspaceB));
      expect(sameWorkspaceOtherUser.runtime).not.toBe(first.runtime);
      expect(sameUserOtherWorkspace.runtime).not.toBe(first.runtime);
      expect(new Set([
        first.runtime.store.codexHome,
        sameWorkspaceOtherUser.runtime.store.codexHome,
        sameUserOtherWorkspace.runtime.store.codexHome,
      ]).size).toBe(3);
      sameWorkspaceOtherUser.release();
      sameUserOtherWorkspace.release();
    } finally {
      await manager.close();
    }
  });

  it('respects active leases, evicts least-recent idle runtimes at capacity, and stops idle runtimes', async () => {
    const repositoryRoot = await root();
    let now = 1_000;
    const runtimes: KodexRuntime[] = [];
    const manager = new RuntimeManager({
      repositoryRoot,
      tenantRoot: path.join(repositoryRoot, 'tenants'),
      maxActiveRuntimes: 1,
      idleTimeoutMs: 100,
      sweepIntervalMs: 60_000,
      clock: () => now,
      createRuntime: (_scope, dataRoot) => {
        const runtime = new KodexRuntime(repositoryRoot, undefined, { dataRoot, startAppServer: false });
        runtimes.push(runtime);
        return runtime;
      },
    });
    try {
      const first = await manager.acquire(scope(userA, workspaceA));
      await expect(manager.acquire(scope(userB, workspaceB))).rejects.toBeInstanceOf(RuntimeCapacityError);
      const stopped = vi.spyOn(first.runtime, 'stop');
      first.release();
      now += 1;
      const replacement = await manager.acquire(scope(userB, workspaceB));
      expect(stopped).toHaveBeenCalledTimes(1);
      expect(manager.inspect()).toHaveLength(1);
      const replacementStopped = vi.spyOn(replacement.runtime, 'stop');
      replacement.release();
      now += 101;
      await expect(manager.evictIdle(now)).resolves.toBe(1);
      expect(replacementStopped).toHaveBeenCalledTimes(1);
      expect(manager.inspect()).toHaveLength(0);
      expect(runtimes).toHaveLength(2);
    } finally {
      await manager.close();
    }
  });

  it('rejects traversal-shaped or non-UUID tenant keys before creating directories', async () => {
    const repositoryRoot = await root();
    const manager = new RuntimeManager({ repositoryRoot, tenantRoot: path.join(repositoryRoot, 'tenants') });
    try {
      await expect(manager.acquire(scope('../escape', workspaceA))).rejects.toThrow('invalid UUID');
      await expect(manager.acquire({ ...scope(userA, workspaceA), workspaceRole: 'viewer' }))
        .rejects.toThrow('lacks an execution role');
      expect(manager.inspect()).toHaveLength(0);
    } finally {
      await manager.close();
    }
  });
});
