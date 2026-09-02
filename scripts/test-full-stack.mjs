import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startIsolatedPostgres } from './lib/isolated-postgres.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Run this acceptance harness through npm run test:full-stack.');
const binary = path.join(repositoryRoot, 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex');
if (!existsSync(binary)) throw new Error(`The repository Codex binary is missing at ${binary}. Run npm run codex:build first.`);
const vitestCli = path.join(repositoryRoot, 'node_modules', 'vitest', 'vitest.mjs');

let activeChild;
let postgres;
let cleaning = false;

async function terminate(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 3_000)),
  ]);
  if (child.exitCode !== null) return;
  if (process.platform === 'win32' && child.pid) {
    await new Promise((resolve) => {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
        stdio: 'ignore', shell: false, windowsHide: true,
      });
      killer.once('exit', resolve);
      killer.once('error', resolve);
    });
  } else child.kill('SIGKILL');
}

async function cleanup() {
  if (cleaning) return;
  cleaning = true;
  await terminate(activeChild);
  activeChild = undefined;
  await postgres?.stop();
}

function run(command, args, options, timeoutMs, phase) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', shell: false, windowsHide: true, ...options });
    activeChild = child;
    const timer = setTimeout(() => {
      void terminate(child);
      reject(new Error(`${phase} timed out after ${timeoutMs} ms.`));
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      if (activeChild === child) activeChild = undefined;
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (activeChild === child) activeChild = undefined;
      if (code === 0) resolve();
      else reject(new Error(`${phase} failed with exit code ${code}.`));
    });
  });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    void cleanup().finally(() => { process.exitCode = 130; });
  });
}

try {
  postgres = await startIsolatedPostgres({
    database: 'kodex_full_stack_test',
    namePrefix: 'kodex-full-stack-test',
  });
  const env = {
    ...process.env,
    DATABASE_URL: postgres.databaseUrl,
    PRODUCT_DB_SSL: 'disable',
    KODEX_DISABLE_ENV_FILE: '1',
    KODEX_RAG_ENABLED: 'false',
    OPENAI_API_KEY: '',
    KODEX_LOCAL_LLM_API_KEY: '',
  };
  await run(process.execPath, [npmCli, 'run', 'build'], { cwd: repositoryRoot, env }, 300_000, 'Product build');
  await run(
    process.execPath,
    [vitestCli, 'run', '--config', 'vitest.full-stack.config.ts'],
    { cwd: repositoryRoot, env },
    180_000,
    'Full-stack acceptance scenario',
  );
} finally {
  await cleanup();
}
