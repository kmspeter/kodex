import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AutomationRecord, KodexSettings } from '@kodex/kodex-api';
import { redactSecrets, sanitizeUnknown } from '@kodex/shared';

const DEFAULT_SETTINGS: KodexSettings = {
  sandbox: 'workspace-write',
  approvalPolicy: 'on-request',
  network: { shell: true, webSearch: true },
  provider: { mode: 'openai', baseUrl: '', model: '' },
  lastProjectId: null,
  sidebarOpen: true,
  detailPanelOpen: false,
};

interface StoredAutomation extends AutomationRecord {
  _claimId?: string | null;
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function publicAutomation(entry: StoredAutomation): AutomationRecord {
  const record = { ...entry };
  delete record._claimId;
  return record;
}

export class LocalStore {
  readonly root: string;
  readonly codexHome: string;
  readonly logsRoot: string;
  readonly settingsPath: string;
  readonly automationsPath: string;
  readonly approvalsPath: string;
  readonly projectsPath: string;
  readonly lockPath: string;
  readonly instanceId = randomUUID();
  #initializePromise: Promise<void> | null = null;
  #ownsLock = false;
  #writeTail: Promise<void> = Promise.resolve();

  constructor(repositoryRoot: string, dataRoot = path.join(repositoryRoot, '.kodex-data')) {
    this.root = dataRoot;
    this.codexHome = path.join(this.root, 'codex-home');
    this.logsRoot = path.join(this.root, 'logs');
    this.settingsPath = path.join(this.root, 'settings.json');
    this.automationsPath = path.join(this.root, 'automations.json');
    this.approvalsPath = path.join(this.root, 'approvals.jsonl');
    this.projectsPath = path.join(this.root, 'projects.json');
    this.lockPath = path.join(this.root, 'instance.lock');
  }

  async initialize(): Promise<void> {
    this.#initializePromise ??= this.#initialize();
    return this.#initializePromise;
  }

  async #initialize(): Promise<void> {
    await Promise.all([
      mkdir(this.root, { recursive: true }),
      mkdir(this.codexHome, { recursive: true }),
      mkdir(this.logsRoot, { recursive: true }),
    ]);
    await this.#acquireInstanceLock();
  }

  async #acquireInstanceLock(): Promise<void> {
    const payload = `${JSON.stringify({ instanceId: this.instanceId, pid: process.pid, startedAt: new Date().toISOString() }, null, 2)}\n`;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await open(this.lockPath, 'wx');
        try { await handle.writeFile(payload, 'utf8'); } finally { await handle.close(); }
        this.#ownsLock = true;
        return;
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') throw error;
        let existing: { pid?: number; instanceId?: string } = {};
        try { existing = JSON.parse(await readFile(this.lockPath, 'utf8')) as typeof existing; } catch { /* preserve below */ }
        let alive = false;
        if (typeof existing.pid === 'number') {
          try { process.kill(existing.pid, 0); alive = true; } catch (probeError) { alive = errorCode(probeError) === 'EPERM'; }
        }
        if (alive) throw new Error(`Another Kodex instance (pid ${existing.pid}) already owns ${this.root}.`);
        const stalePath = `${this.lockPath}.stale.${Date.now()}.${existing.instanceId ?? 'unknown'}`;
        try { await rename(this.lockPath, stalePath); } catch (renameError) {
          if (attempt > 0) throw renameError;
        }
      }
    }
    throw new Error(`Unable to acquire the Kodex instance lock at ${this.lockPath}.`);
  }

  async close(): Promise<void> {
    await this.#writeTail.catch(() => undefined);
    if (!this.#ownsLock) return;
    this.#ownsLock = false;
    try {
      const current = JSON.parse(await readFile(this.lockPath, 'utf8')) as { instanceId?: string };
      if (current.instanceId === this.instanceId) await unlink(this.lockPath);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
  }

  async readSettings(): Promise<KodexSettings> {
    const stored = await this.readJson<unknown>(this.settingsPath, {});
    return this.#mergeSettings(stored);
  }

  async writeSettings(patch: Partial<KodexSettings>): Promise<KodexSettings> {
    return this.#serial(async () => {
      const current = this.#mergeSettings(await this.#readJsonUnlocked<unknown>(this.settingsPath, {}));
      const next: KodexSettings = {
        ...current,
        ...patch,
        network: { ...current.network, ...(patch.network ?? {}) },
        provider: { ...current.provider, ...(patch.provider ?? {}) },
      };
      await this.#writeJsonUnlocked(this.settingsPath, next);
      return next;
    });
  }

  #mergeSettings(stored: unknown): KodexSettings {
    if (!isRecord(stored)) throw new Error(`Kodex settings file must contain a JSON object: ${this.settingsPath}`);
    const network = isRecord(stored.network) ? stored.network : {};
    const provider = isRecord(stored.provider) ? stored.provider : {};
    const sandbox = stored.sandbox ?? DEFAULT_SETTINGS.sandbox;
    const approvalPolicy = stored.approvalPolicy ?? DEFAULT_SETTINGS.approvalPolicy;
    if (!['read-only', 'workspace-write', 'danger-full-access'].includes(String(sandbox))) throw new Error(`Kodex settings file has an invalid sandbox value: ${this.settingsPath}`);
    if (!['untrusted', 'on-request', 'never'].includes(String(approvalPolicy))) throw new Error(`Kodex settings file has an invalid approvalPolicy value: ${this.settingsPath}`);
    if (network.shell !== undefined && typeof network.shell !== 'boolean') throw new Error(`Kodex settings file has an invalid network.shell value: ${this.settingsPath}`);
    if (network.webSearch !== undefined && typeof network.webSearch !== 'boolean') throw new Error(`Kodex settings file has an invalid network.webSearch value: ${this.settingsPath}`);
    const mode = provider.mode ?? DEFAULT_SETTINGS.provider.mode;
    if (mode !== 'openai' && mode !== 'local') throw new Error(`Kodex settings file has an invalid provider mode: ${this.settingsPath}`);
    if (provider.baseUrl !== undefined && typeof provider.baseUrl !== 'string') throw new Error(`Kodex settings file has an invalid provider baseUrl: ${this.settingsPath}`);
    if (provider.model !== undefined && typeof provider.model !== 'string') throw new Error(`Kodex settings file has an invalid provider model: ${this.settingsPath}`);
    if (stored.lastProjectId !== undefined && stored.lastProjectId !== null && typeof stored.lastProjectId !== 'string') throw new Error(`Kodex settings file has an invalid lastProjectId: ${this.settingsPath}`);
    return {
      sandbox: sandbox as KodexSettings['sandbox'], approvalPolicy: approvalPolicy as KodexSettings['approvalPolicy'],
      network: { shell: network.shell ?? DEFAULT_SETTINGS.network.shell, webSearch: network.webSearch ?? DEFAULT_SETTINGS.network.webSearch } as KodexSettings['network'],
      provider: { mode, baseUrl: String(provider.baseUrl ?? ''), model: String(provider.model ?? '') },
      lastProjectId: (stored.lastProjectId ?? null) as string | null,
      sidebarOpen: typeof stored.sidebarOpen === 'boolean' ? stored.sidebarOpen : DEFAULT_SETTINGS.sidebarOpen,
      detailPanelOpen: typeof stored.detailPanelOpen === 'boolean' ? stored.detailPanelOpen : DEFAULT_SETTINGS.detailPanelOpen,
    };
  }

  async listAutomations(): Promise<AutomationRecord[]> {
    return (await this.#readAutomations()).map(publicAutomation);
  }

  async createAutomation(input: Pick<AutomationRecord, 'name' | 'prompt' | 'intervalMinutes' | 'projectId'>): Promise<AutomationRecord> {
    return this.#serial(async () => {
      const entries = await this.#readAutomationsUnlocked();
      const now = Date.now();
      const intervalMinutes = Math.max(1, Math.min(10_080, Number(input.intervalMinutes) || 60));
      const automation: StoredAutomation = {
        id: randomUUID(), name: String(input.name || 'Local automation').trim().slice(0, 120),
        prompt: String(input.prompt || '').trim().slice(0, 20_000), intervalMinutes, enabled: true,
        projectId: input.projectId, createdAt: now, updatedAt: now,
        nextRunAt: now + intervalMinutes * 60_000, lastRunAt: null, lastStatus: 'never-run',
        lastError: null, threadId: null, runningSince: null, _claimId: null,
      };
      if (!automation.prompt) throw new Error('Automation prompt is required.');
      entries.push(automation);
      await this.#writeJsonUnlocked(this.automationsPath, entries);
      return publicAutomation(automation);
    });
  }

  async deleteAutomation(id: string): Promise<void> {
    await this.#serial(async () => {
      const entries = await this.#readAutomationsUnlocked();
      const target = entries.find((entry) => entry.id === id);
      if (!target) throw new Error('Automation was not found.');
      if (target.lastStatus === 'running') throw new Error('A running automation cannot be deleted.');
      await this.#writeJsonUnlocked(this.automationsPath, entries.filter((entry) => entry.id !== id));
    });
  }

  async claimAutomation(id: string, now = Date.now(), force = false): Promise<{ automation: AutomationRecord; claimId: string } | null> {
    return this.#serial(async () => {
      const entries = await this.#readAutomationsUnlocked();
      const index = entries.findIndex((entry) => entry.id === id);
      if (index < 0) throw new Error('Automation was not found.');
      const current = entries[index]!;
      if (!current.enabled || current.lastStatus === 'running' || (!force && current.nextRunAt > now)) return null;
      const claimId = randomUUID();
      const claimed: StoredAutomation = {
        ...current, lastStatus: 'running', lastError: null, lastRunAt: now, runningSince: now,
        updatedAt: now, nextRunAt: now + current.intervalMinutes * 60_000, _claimId: claimId,
      };
      entries[index] = claimed;
      await this.#writeJsonUnlocked(this.automationsPath, entries);
      return { automation: publicAutomation(claimed), claimId };
    });
  }

  async setAutomationThread(id: string, claimId: string, threadId: string): Promise<void> {
    await this.#patchClaim(id, claimId, { threadId });
  }

  async finishAutomation(id: string, claimId: string, status: 'succeeded' | 'failed' | 'interrupted', lastError: string | null): Promise<boolean> {
    return this.#serial(async () => {
      const entries = await this.#readAutomationsUnlocked();
      const index = entries.findIndex((entry) => entry.id === id);
      if (index < 0 || entries[index]!._claimId !== claimId) return false;
      entries[index] = { ...entries[index]!, lastStatus: status, lastError, runningSince: null, updatedAt: Date.now(), _claimId: null };
      await this.#writeJsonUnlocked(this.automationsPath, entries);
      return true;
    });
  }

  async recoverInterruptedAutomations(now = Date.now()): Promise<number> {
    return this.#serial(async () => {
      const entries = await this.#readAutomationsUnlocked();
      let recovered = 0;
      const next = entries.map((entry): StoredAutomation => {
        if (entry.lastStatus !== 'running') return entry;
        recovered += 1;
        return { ...entry, lastStatus: 'interrupted', lastError: 'Local Server restarted while this automation was running.', runningSince: null, nextRunAt: now, updatedAt: now, _claimId: null };
      });
      if (recovered) await this.#writeJsonUnlocked(this.automationsPath, next);
      return recovered;
    });
  }

  async #patchClaim(id: string, claimId: string, patch: Partial<StoredAutomation>): Promise<void> {
    await this.#serial(async () => {
      const entries = await this.#readAutomationsUnlocked();
      const index = entries.findIndex((entry) => entry.id === id);
      if (index < 0 || entries[index]!._claimId !== claimId) throw new Error('Automation claim is no longer active.');
      entries[index] = { ...entries[index]!, ...patch, updatedAt: Date.now() };
      await this.#writeJsonUnlocked(this.automationsPath, entries);
    });
  }

  async appendApproval(entry: unknown): Promise<void> {
    await this.#serial(async () => {
      const safe = sanitizeUnknown({ entry, recordedAt: new Date().toISOString() });
      await writeFile(this.approvalsPath, `${JSON.stringify(safe)}\n`, { encoding: 'utf8', flag: 'a' });
    });
  }

  async appendLog(filename: string, line: string): Promise<void> {
    await this.#serial(async () => {
      const safeName = filename.replace(/[^A-Za-z0-9_.-]/gu, '_');
      await writeFile(path.join(this.logsRoot, safeName), `${redactSecrets(line)}\n`, { encoding: 'utf8', flag: 'a' });
    });
  }

  async readJson<T>(filename: string, fallback: T): Promise<T> {
    await this.initialize();
    return this.#readJsonUnlocked(filename, fallback);
  }

  async #readJsonUnlocked<T>(filename: string, fallback: T): Promise<T> {
    try {
      const source = await readFile(filename, 'utf8');
      try { return JSON.parse(source) as T; } catch (error) {
        throw new Error(`Kodex preserved a corrupt JSON file at ${filename}: ${error instanceof Error ? error.message : String(error)}`);
      }
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return structuredClone(fallback);
      throw error;
    }
  }

  async writeJson(filename: string, value: unknown): Promise<void> {
    await this.#serial(() => this.#writeJsonUnlocked(filename, value));
  }

  async #writeJsonUnlocked(filename: string, value: unknown): Promise<void> {
    const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await rename(temporary, filename);
  }

  async #readAutomations(): Promise<StoredAutomation[]> {
    await this.initialize();
    return this.#readAutomationsUnlocked();
  }

  async #readAutomationsUnlocked(): Promise<StoredAutomation[]> {
    const stored = await this.#readJsonUnlocked<unknown>(this.automationsPath, []);
    if (!Array.isArray(stored)) throw new Error(`Kodex automations file must contain a JSON array: ${this.automationsPath}`);
    return stored.map((entry) => {
      if (!isRecord(entry) || typeof entry.id !== 'string' || typeof entry.projectId !== 'string') throw new Error(`Kodex automations file contains an invalid record: ${this.automationsPath}`);
      const migratedStatus = entry.lastStatus === 'started' ? 'interrupted' : entry.lastStatus;
      return { runningSince: null, ...entry, lastStatus: migratedStatus } as StoredAutomation;
    });
  }

  async #serial<T>(operation: () => Promise<T>): Promise<T> {
    await this.initialize();
    const run = this.#writeTail.then(operation, operation);
    this.#writeTail = run.then(() => undefined, () => undefined);
    return run;
  }
}
