import path from 'node:path';
import { canUseWorkspaceRuntime, isUuid } from '@kodex/product-contract';
import type { HistoryEventSink } from '@kodex/product-db';
import {
  RuntimeHistoryRecorder,
  type HistoryRecorderLogEvent,
  type RuntimeHistoryRecorderOptions,
} from './history/recorder.js';
import { KodexRuntime, type KodexRuntimeOptions } from './runtime.js';
import type { RuntimeScope } from './auth/product-authorization.js';

export interface RuntimeLease {
  readonly runtime: KodexRuntime;
  readonly scope: RuntimeScope;
  release(): void;
}

export interface RuntimeManagerOptions {
  apiKey?: string;
  clock?: () => number;
  createRuntime?: (scope: RuntimeScope, dataRoot: string) => KodexRuntime | Promise<KodexRuntime>;
  idleTimeoutMs?: number;
  historyLog?: (event: HistoryRecorderLogEvent & { userId: string; workspaceId: string }) => void;
  historyOptions?: Pick<
    RuntimeHistoryRecorderOptions,
    'maxEventBytes' | 'maxOutboxBytes' | 'maxOutboxRecords' | 'retryInitialMs' | 'retryMaximumMs'
  >;
  historySink?: HistoryEventSink;
  localApiKey?: string;
  maxActiveRuntimes?: number;
  repositoryRoot: string;
  runtimeOptions?: Omit<KodexRuntimeOptions, 'dataRoot' | 'localApiKey'>;
  sweepIntervalMs?: number;
  tenantRoot?: string;
}

interface RuntimeEntry {
  key: string;
  lastUsedAt: number;
  leases: number;
  promise: Promise<KodexRuntime>;
  root: string;
  runtime?: KodexRuntime;
  history?: RuntimeHistoryRecorder;
  scope: RuntimeScope;
  stopPromise?: Promise<void>;
}

export class RuntimeCapacityError extends Error {
  readonly status = 503;
  readonly code = 'runtime_capacity';

  constructor() {
    super('All tenant runtimes are currently in use. Retry later.');
    this.name = 'RuntimeCapacityError';
  }
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate <= 0) throw new Error(`${name} must be a positive integer.`);
  return candidate;
}

function copyScope(scope: RuntimeScope): RuntimeScope {
  return { ...scope, sessionExpiresAt: new Date(scope.sessionExpiresAt.getTime()) };
}

export class RuntimeManager {
  readonly idleTimeoutMs: number;
  readonly maxActiveRuntimes: number;
  readonly repositoryRoot: string;
  readonly sweepIntervalMs: number;
  readonly tenantRoot: string;
  #clock: () => number;
  #closed = false;
  #entries = new Map<string, RuntimeEntry>();
  #historyLog: RuntimeManagerOptions['historyLog'];
  #historyOptions: RuntimeManagerOptions['historyOptions'];
  #historySink: HistoryEventSink | undefined;
  #tail: Promise<void> = Promise.resolve();
  #sweepTimer: NodeJS.Timeout;
  #createRuntime: (scope: RuntimeScope, dataRoot: string) => KodexRuntime | Promise<KodexRuntime>;

  constructor(options: RuntimeManagerOptions) {
    this.repositoryRoot = path.resolve(options.repositoryRoot);
    this.tenantRoot = path.resolve(options.tenantRoot ?? path.join(this.repositoryRoot, '.kodex-data', 'tenants'));
    const relativeTenantRoot = path.relative(this.repositoryRoot, this.tenantRoot);
    if (relativeTenantRoot.startsWith('..') || path.isAbsolute(relativeTenantRoot)) {
      throw new Error('KODEX_TENANT_ROOT must remain inside the repository root.');
    }
    this.maxActiveRuntimes = positiveInteger(options.maxActiveRuntimes, 8, 'maxActiveRuntimes');
    this.idleTimeoutMs = positiveInteger(options.idleTimeoutMs, 15 * 60_000, 'idleTimeoutMs');
    this.sweepIntervalMs = positiveInteger(options.sweepIntervalMs, 60_000, 'sweepIntervalMs');
    this.#clock = options.clock ?? Date.now;
    this.#historyLog = options.historyLog;
    this.#historyOptions = options.historyOptions;
    this.#historySink = options.historySink;
    this.#createRuntime = options.createRuntime ?? ((scope, dataRoot) => new KodexRuntime(
      this.repositoryRoot,
      options.apiKey,
      { ...options.runtimeOptions, localApiKey: options.localApiKey, dataRoot },
    ));
    this.#sweepTimer = setInterval(() => void this.evictIdle(), this.sweepIntervalMs);
    this.#sweepTimer.unref?.();
  }

  async acquire(scope: RuntimeScope): Promise<RuntimeLease> {
    this.#validateScope(scope);
    const leaseScope = copyScope(scope);
    const key = this.#key(scope);
    const entry = await this.#serialize(async () => {
      if (this.#closed) throw new Error('Runtime manager is closed.');
      const existing = this.#entries.get(key);
      if (existing) {
        existing.leases += 1;
        existing.lastUsedAt = this.#clock();
        return existing;
      }
      await this.#makeCapacity();
      const root = this.dataRootFor(scope);
      const runtimeResult = this.#createRuntime(scope, root);
      const created: RuntimeEntry = {
        key,
        scope: copyScope(scope),
        root,
        leases: 1,
        lastUsedAt: this.#clock(),
        promise: Promise.resolve(runtimeResult).then(async (runtime) => {
          created.runtime = runtime;
          if (this.#historySink) {
            created.history = new RuntimeHistoryRecorder({
              ...this.#historyOptions,
              runtime,
              sink: this.#historySink,
              scope: created.scope,
              dataRoot: root,
              repositoryRoot: this.repositoryRoot,
              onLog: (event) => this.#historyLog?.({
                ...event,
                userId: created.scope.userId,
                workspaceId: created.scope.workspaceId,
              }),
            });
            created.history.start();
          }
          await runtime.initialize();
          return runtime;
        }),
      };
      this.#entries.set(key, created);
      return created;
    });

    let runtime: KodexRuntime;
    try {
      runtime = await entry.promise;
    } catch (error) {
      await this.#serialize(async () => {
        if (this.#entries.get(key) === entry) {
          this.#entries.delete(key);
          await this.#stopEntry(entry);
        }
      });
      throw error;
    }

    let released = false;
    return {
      runtime,
      scope: leaseScope,
      release: () => {
        if (released) return;
        released = true;
        const releasedAt = this.#clock();
        void this.#serialize(async () => {
          if (entry.leases > 0) entry.leases -= 1;
          entry.lastUsedAt = releasedAt;
        });
      },
    };
  }

  dataRootFor(scope: Pick<RuntimeScope, 'userId' | 'workspaceId'>): string {
    if (!isUuid(scope.userId) || !isUuid(scope.workspaceId)) throw new Error('Runtime scope IDs must be UUIDs.');
    const root = path.resolve(this.tenantRoot, 'users', scope.userId, 'workspaces', scope.workspaceId);
    const relative = path.relative(this.tenantRoot, root);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Tenant runtime path escaped its root.');
    return root;
  }

  async evictIdle(now = this.#clock()): Promise<number> {
    return this.#serialize(async () => {
      const candidates = [...this.#entries.values()]
        .filter((entry) => entry.leases === 0 && now - entry.lastUsedAt >= this.idleTimeoutMs)
        .sort((left, right) => left.lastUsedAt - right.lastUsedAt);
      for (const entry of candidates) await this.#evict(entry);
      return candidates.length;
    });
  }

  inspect(): Array<{
    history?: ReturnType<RuntimeHistoryRecorder['status']>;
    key: string;
    leases: number;
    root: string;
  }> {
    return [...this.#entries.values()].map((entry) => ({
      key: entry.key,
      leases: entry.leases,
      root: entry.root,
      ...(entry.history ? { history: entry.history.status() } : {}),
    }));
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#sweepTimer);
    await this.#serialize(async () => {
      const entries = [...this.#entries.values()];
      this.#entries.clear();
      await Promise.all(entries.map((entry) => this.#stopEntry(entry)));
    });
  }

  async #makeCapacity(): Promise<void> {
    if (this.#entries.size < this.maxActiveRuntimes) return;
    const candidate = [...this.#entries.values()]
      .filter((entry) => entry.leases === 0)
      .sort((left, right) => left.lastUsedAt - right.lastUsedAt)[0];
    if (!candidate) throw new RuntimeCapacityError();
    await this.#evict(candidate);
  }

  async #evict(entry: RuntimeEntry): Promise<void> {
    if (entry.leases !== 0 || this.#entries.get(entry.key) !== entry) return;
    this.#entries.delete(entry.key);
    await this.#stopEntry(entry);
  }

  #stopEntry(entry: RuntimeEntry): Promise<void> {
    entry.stopPromise ??= (async () => {
      try {
        const runtime = entry.runtime ?? await entry.promise;
        await runtime.stop();
        await entry.history?.stop();
      } catch {
        if (entry.runtime) await entry.runtime.stop().catch(() => undefined);
        await entry.history?.stop().catch(() => undefined);
      }
    })();
    return entry.stopPromise;
  }

  #validateScope(scope: RuntimeScope): void {
    if (!isUuid(scope.userId) || !isUuid(scope.workspaceId) || !isUuid(scope.sessionId)) {
      throw new Error('Authenticated runtime scope contains an invalid UUID.');
    }
    if (!Number.isFinite(scope.sessionExpiresAt.getTime()) || !canUseWorkspaceRuntime(scope.workspaceRole)) {
      throw new Error('Authenticated runtime scope has an invalid expiration or lacks an execution role.');
    }
  }

  #key(scope: Pick<RuntimeScope, 'userId' | 'workspaceId'>): string {
    return `${scope.userId}:${scope.workspaceId}`;
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(operation, operation);
    this.#tail = run.then(() => undefined, () => undefined);
    return run;
  }
}
