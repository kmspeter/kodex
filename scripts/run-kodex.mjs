import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createProductApiEnvironment, createServerEnvironment, createUiEnvironment } from './process-environment.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv[2] ?? 'dev';
if (!['dev', 'start'].includes(mode)) {
  process.stderr.write('Usage: node scripts/run-kodex.mjs <dev|start>\n');
  process.exit(2);
}

const localCodex = path.join(repositoryRoot, 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex');
if (!existsSync(localCodex)) {
  process.stderr.write('Kodex notice: local bin/codex is missing. The UI will start in setup mode. Run npm run codex:build.\n');
}
if (mode === 'start' && (!existsSync(path.join(repositoryRoot, 'apps', 'api', 'dist', 'main.js')) || !existsSync(path.join(repositoryRoot, 'apps', 'local-server', 'dist', 'main.js')) || !existsSync(path.join(repositoryRoot, 'apps', 'ui', 'dist', 'index.html')))) {
  process.stderr.write('Production artifacts are missing. Run npm run build first.\n');
  process.exit(1);
}

const npmCli = process.env.npm_execpath || path.resolve(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
const port = process.env.KODEX_SERVER_PORT || '47831';
const productApiPort = process.env.PRODUCT_API_PORT || '47832';
const serverEnvironment = createServerEnvironment(process.env, mode, port, productApiPort);
const productApiEnvironment = createProductApiEnvironment(process.env, mode, productApiPort, port);
const uiEnvironment = createUiEnvironment(process.env, port, productApiPort);

const commands = mode === 'dev'
  ? [
      { name: 'product-api', command: process.execPath, args: [npmCli, 'run', 'dev', '--workspace', '@kodex/product-api'], env: productApiEnvironment },
      { name: 'local-server', command: process.execPath, args: [npmCli, 'run', 'dev', '--workspace', '@kodex/local-server'], env: serverEnvironment },
      { name: 'ui', command: process.execPath, args: [npmCli, 'run', 'dev', '--workspace', '@kodex/ui'], env: uiEnvironment },
    ]
  : [
      { name: 'product-api', command: process.execPath, args: [path.join(repositoryRoot, 'apps', 'api', 'dist', 'main.js')], env: productApiEnvironment },
      { name: 'local-server', command: process.execPath, args: [path.join(repositoryRoot, 'apps', 'local-server', 'dist', 'main.js')], env: serverEnvironment },
    ];

const children = commands.map((entry) => {
  const child = spawn(entry.command, entry.args, {
    cwd: repositoryRoot,
    env: entry.env,
    shell: false,
    windowsHide: true,
    stdio: 'inherit',
  });
  child.once('error', (error) => process.stderr.write(`${entry.name} failed to start: ${error.message}\n`));
  return { ...entry, child };
});

let stopping = false;
function terminateChildren(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  for (const { child } of children) {
    if (child.exitCode != null || !child.pid) continue;
    child.kill('SIGTERM');
    if (process.platform === 'win32') {
      spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
    }
  }
  process.exitCode = exitCode;
}

for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => terminateChildren(0));
for (const { name, child } of children) {
  child.once('exit', (code, signal) => {
    if (stopping) return;
    process.stderr.write(`${name} exited (code=${code ?? 'null'}, signal=${signal ?? 'none'}). Stopping Kodex.\n`);
    terminateChildren(code ?? 1);
  });
}

process.stdout.write(`Kodex UI: http://127.0.0.1:${mode === 'dev' ? '5173' : port}\n`);
process.stdout.write(`Kodex Local Server: http://127.0.0.1:${port}\n`);
process.stdout.write(`Kodex Product API: http://127.0.0.1:${productApiPort}\n`);
