import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AutomationRecord, KodexSettings } from '@kodex/kodex-api';
import { redactSecrets, sanitizeUnknown } from '@kodex/shared';

const DEFAULT_SETTINGS: KodexSettings = {
  theme: 'light',
  density: 'compact',
  notifications: true,
  sandbox: 'workspace-write',
  approvalPolicy: 'on-request',
  network: { shell: true, webSearch: true, remoteMcp: true },
  lastProjectId: null,
  sidebarOpen: true,
  detailPanelOpen: false,
};

export class LocalStore {
  readonly root: string;
  readonly codexHome: string;
  readonly logsRoot: string;
  readonly settingsPath: string;
  readonly automationsPath: string;
  readonly approvalsPath: string;
  readonly projectsPath: string;

  constructor(repositoryRoot: string) {
    this.root = path.join(repositoryRoot, '.kodex-data');
    this.codexHome = path.join(this.root, 'codex-home');
    this.logsRoot = path.join(this.root, 'logs');
    this.settingsPath = path.join(this.root, 'settings.json');
    this.automationsPath = path.join(this.root, 'automations.json');
    this.approvalsPath = path.join(this.root, 'approvals.jsonl');
    this.projectsPath = path.join(this.root, 'projects.json');
  }

  async initialize(): Promise<void> {
    await Promise.all([
      mkdir(this.root, { recursive: true }),
      mkdir(this.codexHome, { recursive: true }),
      mkdir(this.logsRoot, { recursive: true }),
    ]);
  }

  async readSettings(): Promise<KodexSettings> {
    const stored = await this.readJson<Partial<KodexSettings>>(this.settingsPath, {});
    return {
      ...DEFAULT_SETTINGS,
      ...stored,
      network: { ...DEFAULT_SETTINGS.network, ...(stored.network ?? {}) },
    };
  }

  async writeSettings(patch: Partial<KodexSettings>): Promise<KodexSettings> {
    const current = await this.readSettings();
    const next: KodexSettings = {
      ...current,
      ...patch,
      network: { ...current.network, ...(patch.network ?? {}) },
    };
    await this.writeJson(this.settingsPath, next);
    return next;
  }

  async listAutomations(): Promise<AutomationRecord[]> {
    const stored = await this.readJson<unknown>(this.automationsPath, []);
    return Array.isArray(stored) ? stored as AutomationRecord[] : [];
  }

  async createAutomation(input: Pick<AutomationRecord, 'name' | 'prompt' | 'intervalMinutes' | 'projectId'>): Promise<AutomationRecord> {
    const entries = await this.listAutomations();
    const now = Date.now();
    const intervalMinutes = Math.max(1, Math.min(10_080, Number(input.intervalMinutes) || 60));
    const automation: AutomationRecord = {
      id: randomUUID(),
      name: String(input.name || 'Local automation').trim().slice(0, 120),
      prompt: String(input.prompt || '').trim().slice(0, 20_000),
      intervalMinutes,
      enabled: true,
      projectId: input.projectId,
      createdAt: now,
      updatedAt: now,
      nextRunAt: now + intervalMinutes * 60_000,
      lastRunAt: null,
      lastStatus: 'never-run',
      lastError: null,
      threadId: null,
    };
    if (!automation.prompt) throw new Error('Automation prompt is required.');
    entries.push(automation);
    await this.writeJson(this.automationsPath, entries);
    return automation;
  }

  async deleteAutomation(id: string): Promise<void> {
    const entries = await this.listAutomations();
    const next = entries.filter((entry) => entry.id !== id);
    if (next.length === entries.length) throw new Error('Automation was not found.');
    await this.writeJson(this.automationsPath, next);
  }

  async recordAutomation(id: string, patch: Partial<AutomationRecord>): Promise<void> {
    const entries = await this.listAutomations();
    const index = entries.findIndex((entry) => entry.id === id);
    if (index < 0) return;
    const current = entries[index]!;
    entries[index] = {
      ...current,
      ...patch,
      updatedAt: Date.now(),
      lastRunAt: Date.now(),
      nextRunAt: Date.now() + current.intervalMinutes * 60_000,
    };
    await this.writeJson(this.automationsPath, entries);
  }

  async appendApproval(entry: unknown): Promise<void> {
    await this.initialize();
    const safe = sanitizeUnknown({ entry, recordedAt: new Date().toISOString() });
    await writeFile(this.approvalsPath, `${JSON.stringify(safe)}\n`, { encoding: 'utf8', flag: 'a' });
  }

  async appendLog(filename: string, line: string): Promise<void> {
    await this.initialize();
    const safeName = filename.replace(/[^A-Za-z0-9_.-]/gu, '_');
    await writeFile(path.join(this.logsRoot, safeName), `${redactSecrets(line)}\n`, { encoding: 'utf8', flag: 'a' });
  }

  async readJson<T>(filename: string, fallback: T): Promise<T> {
    try {
      return JSON.parse(await readFile(filename, 'utf8')) as T;
    } catch {
      return structuredClone(fallback);
    }
  }

  async writeJson(filename: string, value: unknown): Promise<void> {
    await this.initialize();
    const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await rename(temporary, filename);
  }
}
