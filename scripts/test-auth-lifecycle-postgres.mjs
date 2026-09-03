import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startIsolatedPostgres } from './lib/isolated-postgres.mjs';

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit', shell: false, windowsHide: true, ...options,
    });
    child.once('error', reject);
    child.once('exit', (code) => code === 0
      ? resolve()
      : reject(new Error(`${command} exited with ${code}`)));
  });
}

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Run this PostgreSQL harness through npm run test:auth-lifecycle-postgres.');
const vitestCli = path.join(repositoryRoot, 'node_modules', 'vitest', 'vitest.mjs');
let postgres;

try {
  postgres = await startIsolatedPostgres({
    database: 'kodex_auth_lifecycle_test',
    namePrefix: 'kodex-auth-lifecycle-test',
  });
  const env = {
    ...process.env,
    DATABASE_URL: postgres.databaseUrl,
    PRODUCT_DB_SSL: 'disable',
    KODEX_DISABLE_ENV_FILE: '1',
    KODEX_RAG_ENABLED: 'false',
  };
  await run(process.execPath, [npmCli, 'run', 'build'], { cwd: repositoryRoot, env });
  await run(process.execPath, [vitestCli, 'run', '--config', 'vitest.product-auth.config.ts'], {
    cwd: repositoryRoot, env,
  });
  await run(process.execPath, [vitestCli, 'run', '--config', 'vitest.tenant-auth.config.ts'], {
    cwd: repositoryRoot, env,
  });
} finally {
  await postgres?.stop();
}
