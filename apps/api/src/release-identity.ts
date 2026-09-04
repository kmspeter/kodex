import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ProductApiConfigurationError } from './config.js';

export interface ProductReleaseIdentity {
  commit: string | null;
  version: string;
}

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u;
const COMMIT = /^[a-f0-9]{40}$/u;

function exactIdentity(value: unknown, source: string): ProductReleaseIdentity {
  if (
    typeof value !== 'object'
    || value === null
    || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'commit,version'
  ) throw new ProductApiConfigurationError(`${source} release identity is invalid`);
  const record = value as Record<string, unknown>;
  if (
    typeof record.version !== 'string'
    || !VERSION.test(record.version)
    || (record.commit !== null && (typeof record.commit !== 'string' || !COMMIT.test(record.commit)))
  ) throw new ProductApiConfigurationError(`${source} release identity is invalid`);
  return { version: record.version, commit: record.commit as string | null };
}

async function optionalReleaseFile(repositoryRoot: string): Promise<ProductReleaseIdentity | undefined> {
  const filename = path.join(repositoryRoot, 'metadata', 'release.json');
  try {
    return exactIdentity(JSON.parse(await readFile(filename, 'utf8')), 'Packaged');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined;
    if (error instanceof ProductApiConfigurationError) throw error;
    throw new ProductApiConfigurationError('Packaged release identity could not be read');
  }
}

export async function loadProductReleaseIdentity(
  repositoryRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProductReleaseIdentity> {
  let application: ProductReleaseIdentity;
  try {
    const manifest = JSON.parse(await readFile(path.join(repositoryRoot, 'package.json'), 'utf8')) as unknown;
    const version = typeof manifest === 'object' && manifest !== null && 'version' in manifest
      ? (manifest as { version?: unknown }).version
      : undefined;
    application = exactIdentity({ version, commit: null }, 'Application');
  } catch (error) {
    if (error instanceof ProductApiConfigurationError) throw error;
    throw new ProductApiConfigurationError('Application release identity could not be read');
  }

  const packaged = await optionalReleaseFile(repositoryRoot);
  const configuredVersion = env.KODEX_RELEASE_VERSION?.trim();
  const configuredCommit = env.KODEX_RELEASE_COMMIT?.trim();
  if (configuredVersion && (!VERSION.test(configuredVersion) || configuredVersion !== application.version)) {
    throw new ProductApiConfigurationError('KODEX_RELEASE_VERSION must match the application version');
  }
  if (configuredCommit && !COMMIT.test(configuredCommit)) {
    throw new ProductApiConfigurationError('KODEX_RELEASE_COMMIT must be a lowercase 40-character Git hash');
  }
  if (packaged && packaged.version !== application.version) {
    throw new ProductApiConfigurationError('Packaged release version does not match the application version');
  }
  if (packaged?.commit && configuredCommit && packaged.commit !== configuredCommit) {
    throw new ProductApiConfigurationError('Configured release commit does not match the packaged release');
  }
  return {
    version: application.version,
    commit: packaged?.commit ?? configuredCommit ?? null,
  };
}
