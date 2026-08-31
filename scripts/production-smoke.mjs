import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function unusedPort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

const port = await unusedPort();
const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'kodex-production-smoke-'));
const origin = `http://127.0.0.1:${port}`;
const environment = {
  ...process.env,
  KODEX_RUNTIME_ROOT: repositoryRoot,
  KODEX_DATA_ROOT: dataRoot,
  KODEX_SERVER_PORT: String(port),
  KODEX_SERVE_UI: '1',
  KODEX_UI_ROOT: path.join(repositoryRoot, 'apps', 'ui', 'dist'),
  KODEX_UI_ORIGINS: `${origin},http://localhost:${port}`,
  KODEX_DISABLE_ENV_FILE: '1',
};
for (const key of Object.keys(environment)) {
  if (/^(?:OPENAI_API_KEY|KODEX_LOCAL_LLM_API_KEY|VITE_|NEXT_PUBLIC_)/iu.test(key)) delete environment[key];
}

const child = spawn(process.execPath, [path.join(repositoryRoot, 'apps', 'local-server', 'dist', 'main.js')], {
  cwd: repositoryRoot,
  env: environment,
  shell: false,
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stdout.on('data', (chunk) => { output += chunk.toString(); });
child.stderr.on('data', (chunk) => { output += chunk.toString(); });

try {
  const deadline = Date.now() + 20_000;
  let health;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Local Server exited with ${child.exitCode}: ${output}`);
    try {
      health = await fetch(`${origin}/api/health`);
      if (health.ok) break;
    } catch { /* wait for startup */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!health?.ok) throw new Error(`Timed out waiting for ${origin}: ${output}`);
  const page = await fetch(origin);
  const html = await page.text();
  if (!page.ok || !html.includes('<div id="root">')) throw new Error('Built UI was not served by the Local Server.');
  const bootstrap = await fetch(`${origin}/api/bootstrap`, { headers: { referer: `${origin}/` } });
  const payload = await bootstrap.json();
  if (!bootstrap.ok || payload.engine?.state !== 'missing-key') throw new Error(`Unexpected keyless bootstrap: ${JSON.stringify(payload)}`);
  if (Object.hasOwn(payload, 'apiKey') || payload.engine?.apiKeyConfigured !== false) throw new Error('Bootstrap exposed API key material or reported an unexpected configured key.');
  process.stdout.write(`Kodex localhost production smoke test passed at ${origin}.\n`);
} finally {
  if (child.exitCode === null) {
    child.kill('SIGTERM');
    if (process.platform === 'win32' && child.pid) spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
  }
  await rm(dataRoot, { recursive: true, force: true });
}
