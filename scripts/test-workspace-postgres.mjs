import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startIsolatedPostgres } from './lib/isolated-postgres.mjs';

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', shell: false, ...options });
    child.once('error', reject);
    child.once('exit', (code) => code === 0
      ? resolve()
      : reject(new Error(`${command} exited with ${code}`)));
  });
}

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('npm_execpath is required to run the isolated workspace PostgreSQL test.');
const vitestCli = path.join(repositoryRoot, 'node_modules', 'vitest', 'vitest.mjs');
let postgres;

try {
  postgres = await startIsolatedPostgres({
    database: 'kodex_workspace_test',
    namePrefix: 'kodex-workspace-test',
  });
  const env = {
    ...process.env,
    DATABASE_URL: postgres.databaseUrl,
    PRODUCT_DB_SSL: 'disable',
    KODEX_DISABLE_ENV_FILE: '1',
  };
  await run(process.execPath, [npmCli, 'run', 'build'], { env });
  await run(process.execPath, [vitestCli, 'run', '--config', 'vitest.workspace-postgres.config.ts'], { env });
  await run(process.execPath, [vitestCli, 'run', '--config', 'vitest.tenant-auth.config.ts'], { env });
} finally {
  await postgres?.stop();
}
