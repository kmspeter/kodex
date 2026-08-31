import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectStore } from '../../apps/local-server/src/projects/project-store';
import { LocalStore } from '../../apps/local-server/src/storage/local-store';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe('local storage and projects', () => {
  it('stores settings, projects, automations, logs, and approvals only under .kodex-data', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodex-store-'));
    roots.push(root);
    const store = new LocalStore(root);
    const projects = new ProjectStore(store, root);
    const [project] = await projects.initialize();
    expect(project?.path).toBe(root);
    const settings = await store.writeSettings({ network: { shell: false, webSearch: true } });
    expect(settings.network.shell).toBe(false);
    const automation = await store.createAutomation({ name: 'test', prompt: 'run tests', intervalMinutes: 5, projectId: project!.id });
    expect(automation.projectId).toBe(project!.id);
    await store.appendApproval({ decision: 'accept', token: 'sk-test-secret-value' });
    const approval = await readFile(store.approvalsPath, 'utf8');
    expect(approval).not.toContain('sk-test-secret-value');
    expect(store.codexHome.startsWith(path.join(root, '.kodex-data'))).toBe(true);
    await store.close();
  });

  it('switches among absolute local project paths', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodex-projects-'));
    const second = await mkdtemp(path.join(os.tmpdir(), 'kodex-second-'));
    roots.push(root, second);
    const store = new LocalStore(root);
    const projects = new ProjectStore(store, root);
    await projects.initialize();
    const added = await projects.add(second, 'Second');
    expect((await projects.active()).id).toBe(added.id);
    expect((await projects.list()).length).toBe(2);
    await store.close();
  });

  it('preserves corrupt JSON and serializes concurrent settings writes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodex-corrupt-'));
    roots.push(root);
    const store = new LocalStore(root);
    await store.initialize();
    await Promise.all([
      store.writeSettings({ sidebarOpen: false }),
      store.writeSettings({ detailPanelOpen: true }),
    ]);
    expect(await store.readSettings()).toMatchObject({ sidebarOpen: false, detailPanelOpen: true });
    await writeFile(store.settingsPath, '{broken-json', 'utf8');
    await expect(store.readSettings()).rejects.toThrow('preserved a corrupt JSON file');
    expect(await readFile(store.settingsPath, 'utf8')).toBe('{broken-json');
    await store.close();
  });

  it('prevents two Kodex stores from owning the same data directory', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodex-lock-'));
    roots.push(root);
    const first = new LocalStore(root);
    const second = new LocalStore(root);
    await first.initialize();
    await expect(second.initialize()).rejects.toThrow('already owns');
    await first.close();
  });
});
