import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { ProjectRecord } from '@kodex/kodex-api';
import type { LocalStore } from '../storage/local-store.js';

export class ProjectStore {
  constructor(private readonly store: LocalStore, private readonly repositoryRoot: string) {}

  async initialize(): Promise<ProjectRecord[]> {
    const projects = await this.list();
    if (projects.length) return projects;
    const now = Date.now();
    const initial: ProjectRecord = {
      id: randomUUID(),
      name: path.basename(this.repositoryRoot),
      path: this.repositoryRoot,
      createdAt: now,
      lastOpenedAt: now,
    };
    await this.store.writeJson(this.store.projectsPath, [initial]);
    await this.store.writeSettings({ lastProjectId: initial.id });
    return [initial];
  }

  async list(): Promise<ProjectRecord[]> {
    const stored = await this.store.readJson<unknown>(this.store.projectsPath, []);
    return Array.isArray(stored) ? stored as ProjectRecord[] : [];
  }

  async active(): Promise<ProjectRecord> {
    const projects = await this.initialize();
    const settings = await this.store.readSettings();
    return projects.find((project) => project.id === settings.lastProjectId) ?? projects[0]!;
  }

  async add(inputPath: string, name?: string): Promise<ProjectRecord> {
    if (!path.isAbsolute(inputPath)) throw new Error('Project path must be absolute.');
    const resolved = path.resolve(inputPath);
    const info = await stat(resolved);
    if (!info.isDirectory()) throw new Error('Project path must be a directory.');
    const projects = await this.initialize();
    const existing = projects.find((project) => project.path.toLocaleLowerCase() === resolved.toLocaleLowerCase());
    if (existing) return this.select(existing.id);
    const now = Date.now();
    const record: ProjectRecord = {
      id: randomUUID(),
      name: (name?.trim() || path.basename(resolved)).slice(0, 120),
      path: resolved,
      createdAt: now,
      lastOpenedAt: now,
    };
    projects.push(record);
    await this.store.writeJson(this.store.projectsPath, projects);
    await this.store.writeSettings({ lastProjectId: record.id });
    return record;
  }

  async select(id: string): Promise<ProjectRecord> {
    const projects = await this.initialize();
    const index = projects.findIndex((project) => project.id === id);
    if (index < 0) throw new Error('Project was not found.');
    const selected = { ...projects[index]!, lastOpenedAt: Date.now() };
    projects[index] = selected;
    await this.store.writeJson(this.store.projectsPath, projects);
    await this.store.writeSettings({ lastProjectId: id });
    return selected;
  }

  async remove(id: string): Promise<void> {
    const projects = await this.initialize();
    if (projects.length === 1) throw new Error('Kodex must keep at least one local project.');
    const next = projects.filter((project) => project.id !== id);
    if (next.length === projects.length) throw new Error('Project was not found.');
    await this.store.writeJson(this.store.projectsPath, next);
    const settings = await this.store.readSettings();
    if (settings.lastProjectId === id) await this.store.writeSettings({ lastProjectId: next[0]!.id });
  }
}
