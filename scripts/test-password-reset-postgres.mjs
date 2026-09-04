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
if (!npmCli) throw new Error('Run this harness through npm run test:password-reset-postgres.');
const vitestCli = path.join(repositoryRoot, 'node_modules', 'vitest', 'vitest.mjs');

await run(process.execPath, [npmCli, 'run', 'build', '--workspace', '@kodex/product-db'], { cwd: repositoryRoot });
await run(process.execPath, [npmCli, 'run', 'build', '--workspace', '@kodex/product-api'], { cwd: repositoryRoot });

for (const mode of ['fresh', 'legacy-upgrade']) {
  let postgres;
  try {
    postgres = await startIsolatedPostgres({
      database: `kodex_password_reset_${mode.replace('-', '_')}`,
      namePrefix: `kodex-password-reset-${mode}`,
    });
    await run(process.execPath, [vitestCli, 'run', '--config', 'vitest.password-reset.config.ts'], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        KODEX_DISABLE_ENV_FILE: '1',
        PASSWORD_RESET_DATABASE_URL: postgres.databaseUrl,
        PASSWORD_RESET_MIGRATION_MODE: mode,
      },
    });
  } finally {
    await postgres?.stop();
  }
}
