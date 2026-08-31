import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { createProductApiEnvironment, createUiEnvironment, createServerEnvironment } from '../../scripts/process-environment.mjs';
import { createVendorManifest, verifyVendorManifest } from '../../scripts/vendor-manifest.mjs';
import { appServerEnvironment } from '../../apps/local-server/src/process/binary';

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');
const temporaryRoots: string[] = [];
afterEach(async () => Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe('repository reproducibility and secret isolation', () => {
  it('ignores nested dependencies, local state, secrets, caches, and temporary files', async () => {
    const ignored = ['apps/ui/node_modules/example.js', '.env.local', '.kodex-data/settings.json', 'apps/ui/dist/index.html', 'scratch.tmp'];
    const result = await execFileAsync('git', ['check-ignore', '--', ...ignored], { cwd: repositoryRoot, encoding: 'utf8' });
    expect(result.stdout.trim().split(/\r?\n/u)).toEqual(ignored);
    const tracked = await execFileAsync('git', ['ls-files', ':(glob)**/node_modules/**'], { cwd: repositoryRoot, encoding: 'utf8' });
    expect(tracked.stdout.trim()).toBe('');
  });

  it('detects changed, added, and deleted vendored source files by SHA-256', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodex-vendor-manifest-'));
    temporaryRoots.push(root);
    const source = path.join(root, 'source');
    await mkdir(source);
    await writeFile(path.join(source, 'a.rs'), 'fn main() {}\n', 'utf8');
    const commit = (await readFile(path.join(repositoryRoot, 'CODEX_UPSTREAM_COMMIT'), 'utf8')).trim();
    const manifestPath = path.join(root, 'manifest.json');
    await writeFile(manifestPath, `${JSON.stringify(await createVendorManifest(source, commit), null, 2)}\n`, 'utf8');
    await expect(verifyVendorManifest(source, manifestPath)).resolves.toMatchObject({ fileCount: 1 });
    await writeFile(path.join(source, 'a.rs'), 'fn changed() {}\n', 'utf8');
    await expect(verifyVendorManifest(source, manifestPath)).rejects.toThrow('changed: a.rs');
    await writeFile(path.join(source, 'a.rs'), 'fn main() {}\n', 'utf8');
    await writeFile(path.join(source, 'added.rs'), '', 'utf8');
    await expect(verifyVendorManifest(source, manifestPath)).rejects.toThrow('added: added.rs');
    await rm(path.join(source, 'added.rs'));
    await rm(path.join(source, 'a.rs'));
    await expect(verifyVendorManifest(source, manifestPath)).rejects.toThrow('deleted: a.rs');
  });

  it('removes provider and product server secrets from the Vite process environment', () => {
    const source = {
      PATH: 'test',
      OPENAI_API_KEY: 'sk-ui-must-not-see-this',
      KODEX_LOCAL_LLM_API_KEY: 'local-secret',
      DATABASE_URL: 'postgresql://private',
      AUTH_COOKIE_SECRET: 'cookie-secret',
      PRODUCT_DB_PASSWORD: 'database-secret',
      VITE_PRODUCT_API_URL: 'http://127.0.0.1:47832',
      VITE_DATABASE_URL: 'postgresql://vite-private',
      VITE_AUTH_COOKIE_SECRET: 'vite-cookie-secret',
      VITE_ARBITRARY_VALUE: 'must-not-reach-ui',
      vite_lowercase_secret: 'lowercase-must-not-reach-ui',
    };
    const ui = createUiEnvironment(source, '47831');
    const server = createServerEnvironment(source, 'dev', '47831');
    const productApi = createProductApiEnvironment(source, 'dev', '47832', '47831');
    expect(ui.OPENAI_API_KEY).toBeUndefined();
    expect(ui.KODEX_LOCAL_LLM_API_KEY).toBeUndefined();
    expect(ui.DATABASE_URL).toBeUndefined();
    expect(ui.AUTH_COOKIE_SECRET).toBeUndefined();
    expect(ui.PRODUCT_DB_PASSWORD).toBeUndefined();
    expect(ui.VITE_PRODUCT_API_URL).toBe(source.VITE_PRODUCT_API_URL);
    expect(ui.VITE_KODEX_API_URL).toBe('http://127.0.0.1:47831');
    expect(ui.VITE_DATABASE_URL).toBeUndefined();
    expect(ui.VITE_AUTH_COOKIE_SECRET).toBeUndefined();
    expect(ui.VITE_ARBITRARY_VALUE).toBeUndefined();
    expect(ui.vite_lowercase_secret).toBeUndefined();
    expect(JSON.stringify(ui)).not.toContain('sk-ui-must-not-see-this');
    expect(JSON.stringify(ui)).not.toContain('postgresql://private');
    expect(JSON.stringify(ui)).not.toContain('cookie-secret');
    expect(JSON.stringify(ui)).not.toContain('must-not-reach-ui');
    expect(server.OPENAI_API_KEY).toBe(source.OPENAI_API_KEY);
    expect(server.KODEX_LOCAL_LLM_API_KEY).toBe(source.KODEX_LOCAL_LLM_API_KEY);
    expect(server.KODEX_PRODUCT_API_ORIGINS)
      .toBe('http://127.0.0.1:47832,http://localhost:47832');
    expect(createServerEnvironment(source, 'start', '47831', '49000').KODEX_PRODUCT_API_ORIGINS)
      .toBe('http://127.0.0.1:49000,http://localhost:49000');
    expect(productApi.AUTH_ALLOWED_ORIGINS).toBe('http://127.0.0.1:5173,http://localhost:5173');
    expect(createProductApiEnvironment(source, 'start', '47832', '47831').AUTH_ALLOWED_ORIGINS)
      .toBe('http://127.0.0.1:47831,http://localhost:47831');
  });

  it('passes only the selected provider secret to the official App Server child', () => {
    const inherited = {
      PATH: 'test', openai_api_key: 'wrong-openai', KODEX_LOCAL_LLM_API_KEY: 'wrong-local',
      vite_accidental_secret: 'renderer-only', Next_Public_Value: 'renderer-only',
    };
    const openai = appServerEnvironment('D:/codex-home', { openAiApiKey: 'selected-openai' }, inherited);
    expect(openai).toMatchObject({ OPENAI_API_KEY: 'selected-openai', CODEX_HOME: 'D:/codex-home' });
    expect(openai.openai_api_key).toBeUndefined();
    expect(openai.KODEX_LOCAL_LLM_API_KEY).toBeUndefined();
    expect(JSON.stringify(openai)).not.toContain('wrong-local');
    expect(JSON.stringify(openai)).not.toContain('renderer-only');

    const local = appServerEnvironment('D:/codex-home', { localApiKey: 'selected-local' }, inherited);
    expect(local.KODEX_LOCAL_LLM_API_KEY).toBe('selected-local');
    expect(local.OPENAI_API_KEY).toBeUndefined();
    expect(local.openai_api_key).toBeUndefined();
  });
});
