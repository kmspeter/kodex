import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  scanReleaseInputSecrets,
  verifyDeploymentContracts,
  verifyPackageLock,
} from '../../scripts/lib/security-validation.mjs';

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');
const temporaryRoots: string[] = [];

afterEach(async () => Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true }))));

describe('Phase 29 security validation', () => {
  it('binds every workspace and registry dependency to package-lock v3', async () => {
    await expect(verifyPackageLock(repositoryRoot)).resolves.toMatchObject({ workspaceCount: 9 });
  });

  it('reports secret metadata without echoing the candidate value', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodex-secret-scan-'));
    temporaryRoots.push(root);
    const candidate = `sk-${'A1b2C3d4E5f6G7h8J9k0LmNopQrStUv'}`;
    await writeFile(path.join(root, 'input.txt'), `OPENAI_API_KEY=${candidate}\n`, 'utf8');
    try {
      await scanReleaseInputSecrets(root);
      throw new Error('Expected secret scan rejection');
    } catch (error) {
      expect(String(error)).toContain('rule=openai-api-key');
      expect(String(error)).not.toContain(candidate);
    }
  });

  it('scans bounded clean release inputs and enforces deployment hardening', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodex-clean-scan-'));
    temporaryRoots.push(root);
    await mkdir(path.join(root, 'metadata'));
    await writeFile(path.join(root, 'metadata', 'release.txt'), 'version=0.2.0\n', 'utf8');
    await expect(scanReleaseInputSecrets(root)).resolves.toMatchObject({ fileCount: 1, textFileCount: 1 });
    await expect(verifyDeploymentContracts(repositoryRoot)).resolves.toEqual({ contractCount: 3 });
  });
});
