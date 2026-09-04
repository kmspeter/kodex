import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startIsolatedPostgres } from './lib/isolated-postgres.mjs';

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', shell: false, windowsHide: true, ...options });
    child.once('error', reject);
    child.once('exit', (code) => code === 0
      ? resolve()
      : reject(new Error(`${command} exited with ${code}`)));
  });
}

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Run this harness through npm run test:backup-restore.');
const vitestCli = path.join(repositoryRoot, 'node_modules', 'vitest', 'vitest.mjs');
let source;
let target;

try {
  source = await startIsolatedPostgres({
    database: 'kodex_backup_source_test',
    namePrefix: 'kodex-backup-source-test',
  });
  target = await startIsolatedPostgres({
    database: 'kodex_backup_target_test',
    namePrefix: 'kodex-backup-target-test',
  });
  const env = {
    ...process.env,
    KODEX_BACKUP_TEST_SOURCE_CONTAINER: source.containerName,
    KODEX_BACKUP_TEST_SOURCE_URL: source.databaseUrl,
    KODEX_BACKUP_TEST_TARGET_CONTAINER: target.containerName,
    KODEX_BACKUP_TEST_TARGET_URL: target.databaseUrl,
    KODEX_DISABLE_ENV_FILE: '1',
  };
  await run(process.execPath, [npmCli, 'run', 'build', '--workspace', '@kodex/product-db'], { cwd: repositoryRoot, env });
  await run(process.execPath, [vitestCli, 'run', '--config', 'vitest.backup-restore.config.ts'], { cwd: repositoryRoot, env });
} finally {
  await Promise.all([source?.stop(), target?.stop()]);
}
