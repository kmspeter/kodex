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
if (!npmCli) throw new Error('Run this harness through npm run test:release-deployment.');
const vitestCli = path.join(repositoryRoot, 'node_modules', 'vitest', 'vitest.mjs');
let postgres;

try {
  await run(process.execPath, [npmCli, 'run', 'build'], { cwd: repositoryRoot, env: process.env });
  await run(process.execPath, [npmCli, 'run', 'runtime:bundle'], { cwd: repositoryRoot, env: process.env });
  postgres = await startIsolatedPostgres({
    database: 'kodex_release_deployment_test',
    namePrefix: 'kodex-release-deployment-test',
  });
  await run(process.execPath, [vitestCli, 'run', '--config', 'vitest.release-deployment.config.ts'], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      KODEX_DISABLE_ENV_FILE: '1',
      KODEX_RELEASE_TEST_DATABASE_URL: postgres.databaseUrl,
    },
  });
} finally {
  await postgres?.stop();
}
