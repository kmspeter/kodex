import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', shell: false, ...options });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)));
  });
}

function capture(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr.trim() || `${command} exited with ${code}`)));
  });
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

const container = `kodex-rag-test-${randomUUID()}`;
const port = await freePort();
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('npm_execpath is required to run the isolated RAG test.');
const vitestCli = path.join(repositoryRoot, 'node_modules', 'vitest', 'vitest.mjs');
let started = false;

try {
  await capture('docker', [
    'run', '--rm', '-d', '--name', container,
    '-e', 'POSTGRES_DB=kodex_rag_test',
    '-e', 'POSTGRES_USER=kodex',
    '-e', 'POSTGRES_PASSWORD=kodex-test-only',
    '-p', `127.0.0.1:${port}:5432`,
    'pgvector/pgvector:0.8.6-pg17',
  ]);
  started = true;
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      await capture('docker', ['exec', container, 'pg_isready', '-U', 'kodex', '-d', 'kodex_rag_test']);
      ready = true;
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  if (!ready) throw new Error('The temporary pgvector container did not become ready.');
  const env = {
    ...process.env,
    DATABASE_URL: `postgresql://kodex:kodex-test-only@127.0.0.1:${port}/kodex_rag_test`,
    PRODUCT_DB_SSL: 'disable',
    KODEX_DISABLE_ENV_FILE: '1',
  };
  await run(process.execPath, [npmCli, 'run', 'build', '--workspace', '@kodex/product-db'], { env });
  await run(process.execPath, [npmCli, 'run', 'build', '--workspace', '@kodex/product-api'], { env });
  await run(process.execPath, [vitestCli, 'run', '--config', 'vitest.rag-postgres.config.ts'], { env });
} finally {
  if (started) await capture('docker', ['stop', '--time', '3', container]).catch(() => undefined);
}
