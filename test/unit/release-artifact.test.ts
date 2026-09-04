import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadProductReleaseIdentity } from '../../apps/api/src/release-identity';
import { createReleaseArtifact, verifyReleaseArtifact } from '../../scripts/lib/release-artifact.mjs';

const roots: string[] = [];
const commit = 'a'.repeat(40);
const codexCommit = 'b'.repeat(40);
const vendorHash = 'c'.repeat(64);
const migrations = [
  { version: 1, name: 'initial', checksum: 'd'.repeat(64) },
  { version: 2, name: 'next', checksum: 'e'.repeat(64) },
];

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodex-release-artifact-'));
  roots.push(root);
  return root;
}

async function fixture(root: string): Promise<string> {
  const runtime = path.join(root, 'runtime');
  await mkdir(path.join(runtime, 'resources', 'app', 'metadata'), { recursive: true });
  await writeFile(path.join(runtime, 'Kodex.exe'), 'portable-binary', 'utf8');
  await writeFile(path.join(runtime, 'resources', 'app', 'package.json'), '{"version":"0.2.0"}\n', 'utf8');
  return runtime;
}

describe('versioned release artifacts', () => {
  it('seals an exact file tree with release, migration, and Codex provenance', async () => {
    const root = await temporaryRoot();
    const runtime = await fixture(root);
    const output = path.join(root, 'release', 'Kodex-0.2.0-windows-x64-aaaaaaaaaaaa');
    const created = await createReleaseArtifact({
      runtimeRoot: runtime,
      output,
      version: '0.2.0',
      commit,
      migrations,
      codexUpstreamCommit: codexCommit,
      vendorManifestSha256: vendorHash,
    });
    expect(created.releaseId).toBe('Kodex-0.2.0-windows-x64-aaaaaaaaaaaa');
    await expect(stat(runtime)).rejects.toMatchObject({ code: 'ENOENT' });
    const verified = await verifyReleaseArtifact(output);
    expect(verified.database.migrations).toEqual(migrations);
    expect(verified.release).toEqual({ version: '0.2.0', commit, platform: 'win32', arch: 'x64' });
    expect(JSON.parse(await readFile(
      path.join(output, 'resources', 'app', 'metadata', 'release.json'),
      'utf8',
    ))).toEqual({ version: '0.2.0', commit });

    await writeFile(path.join(output, 'unlisted.txt'), 'tamper', 'utf8');
    await expect(verifyReleaseArtifact(output)).rejects.toThrow('unlisted or missing');
  });

  it('refuses tenant data and leaves the generated runtime recoverable after failure', async () => {
    const root = await temporaryRoot();
    const runtime = await fixture(root);
    const forbidden = path.join(runtime, 'resources', 'app', 'tenants', 'users', 'private');
    await mkdir(forbidden, { recursive: true });
    await writeFile(path.join(forbidden, 'settings.json'), '{}\n', 'utf8');
    await expect(createReleaseArtifact({
      runtimeRoot: runtime,
      output: path.join(root, 'Kodex-0.2.0-windows-x64-aaaaaaaaaaaa'),
      version: '0.2.0',
      commit,
      migrations,
      codexUpstreamCommit: codexCommit,
      vendorManifestSha256: vendorHash,
    })).rejects.toThrow('tenant data');
    await expect(stat(runtime)).resolves.toMatchObject({});
    await expect(stat(path.join(runtime, 'release-manifest.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(path.join(runtime, 'resources', 'app', 'metadata', 'release.json')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('Product API release identity', () => {
  it('loads the sealed identity and rejects environment or package mismatches', async () => {
    const root = await temporaryRoot();
    await mkdir(path.join(root, 'metadata'), { recursive: true });
    await writeFile(path.join(root, 'package.json'), '{"version":"0.2.0"}\n', 'utf8');
    await writeFile(
      path.join(root, 'metadata', 'release.json'),
      `${JSON.stringify({ version: '0.2.0', commit })}\n`,
      'utf8',
    );
    await expect(loadProductReleaseIdentity(root)).resolves.toEqual({ version: '0.2.0', commit });
    await expect(loadProductReleaseIdentity(root, { KODEX_RELEASE_COMMIT: 'f'.repeat(40) }))
      .rejects.toThrow('does not match the packaged release');
    await expect(loadProductReleaseIdentity(root, { KODEX_RELEASE_VERSION: '0.3.0' }))
      .rejects.toThrow('must match the application version');
  });
});
