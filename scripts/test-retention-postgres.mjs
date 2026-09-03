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
if (!npmCli) throw new Error('Run this PostgreSQL harness through npm run test:retention-postgres.');
const vitestCli = path.join(repositoryRoot, 'node_modules', 'vitest', 'vitest.mjs');

await run(process.execPath, [npmCli, 'run', 'build'], { cwd: repositoryRoot });
for (const mode of ['fresh', 'legacy-upgrade']) {
  let postgres;
  try {
    postgres = await startIsolatedPostgres({
      database: `kodex_retention_${mode.replace('-', '_')}_test`,
      namePrefix: `kodex-retention-${mode}-test`,
    });
    const env = {
      ...process.env,
      DATABASE_URL: postgres.databaseUrl,
      PRODUCT_DB_SSL: 'disable',
      KODEX_DISABLE_ENV_FILE: '1',
      RETENTION_MIGRATION_MODE: mode,
    };
    await run(process.execPath, [vitestCli, 'run', '--config', 'vitest.retention-postgres.config.ts'], {
      cwd: repositoryRoot,
      env,
    });
  } finally {
    await postgres?.stop();
  }
}
