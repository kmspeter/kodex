import path from 'node:path';
import os from 'node:os';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { lstat, readFile, readdir, realpath, rename, rmdir, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { canUseWorkspaceRuntime, isUuid } from '@kodex/product-contract';
import type { HistoryEventSink, KnowledgeService, RagConfig } from '@kodex/product-db';
import {
  RuntimeHistoryRecorder,
  type HistoryRecorderLogEvent,
  type RuntimeHistoryRecorderOptions,
} from './history/recorder.js';
import { KodexRuntime, type KodexRuntimeOptions } from './runtime.js';
import type { RuntimeScope } from './auth/product-authorization.js';
import { RagAugmenter, type RagLogEvent } from './rag/augmenter.js';

export interface RuntimeLease {
  readonly runtime: KodexRuntime;
  readonly scope: RuntimeScope;
  release(): void;
}

export interface RuntimeManagerOperationalStatus {
  activeLeases: number;
  activeRuntimes: number;
  atCapacity: boolean;
  engine: {
    failed: number;
    missingBinary: number;
    missingKey: number;
    ready: number;
    starting: number;
    stopped: number;
  };
  history: {
    attachedRuntimes: number;
    databaseUnavailableRuntimes: number;
    invalidSpoolRuntimes: number;
    overflowedRuntimes: number;
    pendingBytes: number;
    pendingRecords: number;
    reconciliationFailedRuntimes: number;
    reconciliationPartialRuntimes: number;
    reconciliationRunningRuntimes: number;
    runningOutboxes: number;
  };
  maxActiveRuntimes: number;
  startingRuntimes: number;
}

export interface RuntimeManagerOptions {
  apiKey?: string;
  clock?: () => number;
  createRuntime?: (scope: RuntimeScope, dataRoot: string) => KodexRuntime | Promise<KodexRuntime>;
  dataRoot?: string;
  idleTimeoutMs?: number;
  historyLog?: (event: HistoryRecorderLogEvent & { userId: string; workspaceId: string }) => void;
  historyOptions?: Pick<
    RuntimeHistoryRecorderOptions,
    | 'maxEventBytes'
    | 'maxOutboxBytes'
    | 'maxOutboxRecords'
    | 'reconciliationIntervalMs'
    | 'reconciliationMaxItemsPerThread'
    | 'reconciliationMaxThreadsPerState'
    | 'reconciliationMaxTurnsPerThread'
    | 'reconciliationPageSize'
    | 'reconciliationRequestTimeoutMs'
    | 'reconciliationRetryInitialMs'
    | 'reconciliationRetryMaximumMs'
    | 'retryInitialMs'
    | 'retryMaximumMs'
  >;
  historySink?: HistoryEventSink;
  knowledgeService?: KnowledgeService;
  ragConfig?: RagConfig;
  ragLog?: (event: RagLogEvent & { userId: string; workspaceId: string }) => void;
  localApiKey?: string;
  maxActiveRuntimes?: number;
  repositoryRoot: string;
  runtimeOptions?: Omit<KodexRuntimeOptions, 'dataRoot' | 'localApiKey'>;
  sweepIntervalMs?: number;
  tenantRoot?: string;
  tenantObserver?: (scope: Pick<RuntimeScope, 'userId' | 'workspaceId'>) => Promise<void>;
}

export type TenantCleanupResult = 'busy' | 'deleted' | 'missing' | 'partial';

export class TenantCleanupSafetyError extends Error {
  constructor() {
    super('Tenant cleanup refused an unsafe filesystem shape.');
    this.name = 'TenantCleanupSafetyError';
  }
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
  readonly dataRoot: string;
  #clock: () => number;
  #closed = false;
  #entries = new Map<string, RuntimeEntry>();
  #historyLog: RuntimeManagerOptions['historyLog'];
  #historyOptions: RuntimeManagerOptions['historyOptions'];
  #historySink: HistoryEventSink | undefined;
  #tail: Promise<void> = Promise.resolve();
  #sweepTimer: NodeJS.Timeout;
  #createRuntime: (scope: RuntimeScope, dataRoot: string) => KodexRuntime | Promise<KodexRuntime>;
  #tenantObserver: RuntimeManagerOptions['tenantObserver'];

  constructor(options: RuntimeManagerOptions) {
    this.repositoryRoot = path.resolve(options.repositoryRoot);
    this.dataRoot = path.resolve(options.dataRoot ?? path.join(this.repositoryRoot, '.kodex-data'));
    this.tenantRoot = path.resolve(options.tenantRoot ?? path.join(this.dataRoot, 'tenants'));
    this.#validateDataRoots();
    mkdirSync(this.dataRoot, { recursive: true, mode: 0o700 });
    this.maxActiveRuntimes = positiveInteger(options.maxActiveRuntimes, 8, 'maxActiveRuntimes');
    this.idleTimeoutMs = positiveInteger(options.idleTimeoutMs, 15 * 60_000, 'idleTimeoutMs');
    this.sweepIntervalMs = positiveInteger(options.sweepIntervalMs, 60_000, 'sweepIntervalMs');
    this.#clock = options.clock ?? Date.now;
    this.#historyLog = options.historyLog;
    this.#historyOptions = options.historyOptions;
    this.#historySink = options.historySink;
    this.#tenantObserver = options.tenantObserver;
    this.#createRuntime = options.createRuntime ?? ((scope, dataRoot) => {
      const ragAugmenter = options.knowledgeService && options.ragConfig?.enabled
        ? new RagAugmenter(options.knowledgeService, {
          userId: scope.userId,
          workspaceId: scope.workspaceId,
        }, options.ragConfig, (event) => options.ragLog?.({
          ...event,
          userId: scope.userId,
          workspaceId: scope.workspaceId,
        }))
        : options.ragConfig?.enabled === false
          ? undefined
          : options.runtimeOptions?.ragAugmenter;
      return new KodexRuntime(
        this.repositoryRoot,
        options.apiKey,
        {
          ...options.runtimeOptions,
          localApiKey: options.localApiKey,
          dataRoot,
          ragAugmenter,
          ragAutomationsEnabled: options.ragConfig?.enabled === true
            && options.ragConfig.automationsEnabled,
        },
      );
    });
    this.#sweepTimer = setInterval(() => void this.evictIdle(), this.sweepIntervalMs);
    this.#sweepTimer.unref?.();
  }

  async acquire(scope: RuntimeScope): Promise<RuntimeLease> {
    this.#validateScope(scope);
    const leaseScope = copyScope(scope);
    const key = this.#key(scope);
    const entry = await this.#serialize(async () => {
      if (this.#closed) throw new Error('Runtime manager is closed.');
      await this.#tenantObserver?.({ userId: scope.userId, workspaceId: scope.workspaceId });
      const existing = this.#entries.get(key);
      if (existing) {
        existing.leases += 1;
        existing.lastUsedAt = this.#clock();
        return existing;
      }
      await this.#makeCapacity();
      const runtimeStartIntent = path.join(
        this.dataRoot,
        `.kodex-runtime-start.${randomUUID()}.lock`,
      );
      writeFileSync(runtimeStartIntent, '', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      if (existsSync(path.join(this.dataRoot, '.kodex-offline-maintenance.lock'))) {
        unlinkSync(runtimeStartIntent);
        throw new Error('KODEX_DATA_ROOT is locked for offline backup or restore.');
      }
      const root = this.dataRootFor(scope);
      let runtimeResult: KodexRuntime | Promise<KodexRuntime>;
      try {
        runtimeResult = this.#createRuntime(scope, root);
      } catch (error) {
        unlinkSync(runtimeStartIntent);
        throw error;
      }
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
          if (created.history && runtime.options.startAppServer !== false) {
            created.history.startReconciliation();
          }
          return runtime;
        }).finally(() => {
          try { unlinkSync(runtimeStartIntent); } catch { /* Backup remains fail-closed on a stale intent. */ }
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

  #validateDataRoots(): void {
    const filesystemRoot = path.parse(this.dataRoot).root;
    const home = path.resolve(os.homedir());
    const repositoryInsideDataRoot = path.relative(this.dataRoot, this.repositoryRoot);
    if (
      this.dataRoot === filesystemRoot
      || this.dataRoot === home
      || this.dataRoot === this.repositoryRoot
      || (!repositoryInsideDataRoot.startsWith('..') && !path.isAbsolute(repositoryInsideDataRoot))
    ) {
      throw new Error('KODEX_DATA_ROOT must be a dedicated writable data directory, not a drive root, home, or repository/source root.');
    }
    const relativeTenantRoot = path.relative(this.dataRoot, this.tenantRoot);
    if (
      !relativeTenantRoot
      || relativeTenantRoot.startsWith('..')
      || path.isAbsolute(relativeTenantRoot)
    ) {
      throw new Error('KODEX_TENANT_ROOT must remain inside the trusted KODEX_DATA_ROOT.');
    }
    if (existsSync(path.join(this.dataRoot, '.kodex-offline-maintenance.lock'))) {
      throw new Error('KODEX_DATA_ROOT is locked for offline backup or restore.');
    }
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

  async cleanupTenantData(
    scope: Pick<RuntimeScope, 'userId' | 'workspaceId'>,
    maximumEntries = 10_000,
  ): Promise<TenantCleanupResult> {
    if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 1 || maximumEntries > 100_000) {
      throw new Error('Tenant cleanup entry bound is invalid.');
    }
    return this.#serialize(async () => {
      const key = this.#key(scope);
      const entry = this.#entries.get(key);
      if (entry?.leases) return 'busy';
      if (entry) await this.#evict(entry);
      const root = this.dataRootFor(scope);
      const rootMetadata = await lstat(root).catch((error: unknown) => {
        if (filesystemErrorCode(error) === 'ENOENT') return undefined;
        throw error;
      });
      if (!rootMetadata) return 'missing';
      if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) throw new TenantCleanupSafetyError();
      await assertRealTenantPath(this.tenantRoot, root, scope);
      if (await liveInstanceLock(root)) return 'busy';
      const budget = { remaining: maximumEntries };
      const complete = await removeDirectoryContents(root, budget, 0);
      if (!complete) return 'partial';
      try {
        await rmdir(root);
      } catch (error) {
        if (filesystemErrorCode(error) === 'ENOENT') return 'missing';
        if (['ENOTEMPTY', 'EBUSY', 'EPERM'].includes(filesystemErrorCode(error) ?? '')) return 'busy';
        throw error;
      }
      await removeEmptyParent(path.dirname(root));
      await removeEmptyParent(path.dirname(path.dirname(root)));
      return 'deleted';
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

  operationalStatus(): RuntimeManagerOperationalStatus {
    const status: RuntimeManagerOperationalStatus = {
      activeLeases: 0,
      activeRuntimes: this.#entries.size,
      atCapacity: this.#entries.size >= this.maxActiveRuntimes
        && [...this.#entries.values()].every((entry) => entry.leases > 0),
      engine: {
        failed: 0,
        missingBinary: 0,
        missingKey: 0,
        ready: 0,
        starting: 0,
        stopped: 0,
      },
      history: {
        attachedRuntimes: 0,
        databaseUnavailableRuntimes: 0,
        invalidSpoolRuntimes: 0,
        overflowedRuntimes: 0,
        pendingBytes: 0,
        pendingRecords: 0,
        reconciliationFailedRuntimes: 0,
        reconciliationPartialRuntimes: 0,
        reconciliationRunningRuntimes: 0,
        runningOutboxes: 0,
      },
      maxActiveRuntimes: this.maxActiveRuntimes,
      startingRuntimes: 0,
    };
    for (const entry of this.#entries.values()) {
      status.activeLeases += entry.leases;
      if (!entry.runtime) {
        status.startingRuntimes += 1;
        status.engine.starting += 1;
      } else {
        const engineState = entry.runtime.appServer.status().state;
        if (engineState === 'missing-binary') status.engine.missingBinary += 1;
        else if (engineState === 'missing-key') status.engine.missingKey += 1;
        else status.engine[engineState] += 1;
      }
      const history = entry.history?.status();
      if (!history) continue;
      status.history.attachedRuntimes += 1;
      if (history.running) status.history.runningOutboxes += 1;
      status.history.pendingRecords += history.pendingRecords;
      status.history.pendingBytes += history.pendingBytes;
      if (history.overflowed) status.history.overflowedRuntimes += 1;
      if (history.lastError === 'database_unavailable') {
        status.history.databaseUnavailableRuntimes += 1;
      } else if (history.lastError === 'invalid_spool_record') {
        status.history.invalidSpoolRuntimes += 1;
      }
      if (history.reconciliation.running) status.history.reconciliationRunningRuntimes += 1;
      if (history.reconciliation.lastResult === 'failed') {
        status.history.reconciliationFailedRuntimes += 1;
      } else if (history.reconciliation.lastResult === 'partial') {
        status.history.reconciliationPartialRuntimes += 1;
      }
    }
    return status;
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
        entry.history?.cancelReconciliation();
        await runtime.stop();
        await entry.history?.stop();
      } catch {
        entry.history?.cancelReconciliation();
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

function filesystemErrorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;
}

function sameFilesystemPath(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
    : path.resolve(left) === path.resolve(right);
}

async function assertRealTenantPath(
  tenantRoot: string,
  root: string,
  scope: Pick<RuntimeScope, 'userId' | 'workspaceId'>,
): Promise<void> {
  const tenantMetadata = await lstat(tenantRoot);
  if (!tenantMetadata.isDirectory() || tenantMetadata.isSymbolicLink()) throw new TenantCleanupSafetyError();
  const realTenantRoot = await realpath(tenantRoot);
  const realRoot = await realpath(root);
  const expected = path.join(realTenantRoot, 'users', scope.userId, 'workspaces', scope.workspaceId);
  if (!sameFilesystemPath(realRoot, expected)) throw new TenantCleanupSafetyError();
}

async function liveInstanceLock(root: string): Promise<boolean> {
  const lockPath = path.join(root, 'instance.lock');
  const metadata = await lstat(lockPath).catch((error: unknown) => {
    if (filesystemErrorCode(error) === 'ENOENT') return undefined;
    throw error;
  });
  if (!metadata) return false;
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 4_096) {
    throw new TenantCleanupSafetyError();
  }
  let pid: number | undefined;
  try {
    const parsed = JSON.parse(await readFile(lockPath, 'utf8')) as { pid?: unknown };
    if (typeof parsed.pid === 'number' && Number.isSafeInteger(parsed.pid) && parsed.pid > 0) pid = parsed.pid;
  } catch {
    throw new TenantCleanupSafetyError();
  }
  if (!pid) throw new TenantCleanupSafetyError();
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (filesystemErrorCode(error) === 'EPERM') return true;
  }
  const stale = `${lockPath}.stale.lifecycle`;
  await rename(lockPath, stale).catch((error: unknown) => {
    if (filesystemErrorCode(error) !== 'ENOENT') throw error;
  });
  return false;
}

async function removeDirectoryContents(
  directory: string,
  budget: { remaining: number },
  depth: number,
): Promise<boolean> {
  if (depth > 64) throw new TenantCleanupSafetyError();
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (budget.remaining <= 0) return false;
    budget.remaining -= 1;
    const absolute = path.join(directory, entry.name);
    const metadata = await lstat(absolute).catch((error: unknown) => {
      if (filesystemErrorCode(error) === 'ENOENT') return undefined;
      throw error;
    });
    if (!metadata) continue;
    if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
      if (!await removeDirectoryContents(absolute, budget, depth + 1)) return false;
      await rmdir(absolute).catch((error: unknown) => {
        if (!['ENOENT', 'ENOTEMPTY'].includes(filesystemErrorCode(error) ?? '')) throw error;
      });
    } else {
      await unlink(absolute).catch((error: unknown) => {
        if (filesystemErrorCode(error) !== 'ENOENT') throw error;
      });
    }
  }
  return true;
}

async function removeEmptyParent(directory: string): Promise<void> {
  await rmdir(directory).catch((error: unknown) => {
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(filesystemErrorCode(error) ?? '')) throw error;
  });
}
