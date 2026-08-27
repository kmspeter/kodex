import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

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
if (mode === 'start' && (!existsSync(path.join(repositoryRoot, 'apps', 'local-server', 'dist', 'main.js')) || !existsSync(path.join(repositoryRoot, 'apps', 'ui', 'dist', 'index.html')))) {
  process.stderr.write('Production artifacts are missing. Run npm run build first.\n');
  process.exit(1);
}

const npmCli = process.env.npm_execpath || path.resolve(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
const environment = {
  ...process.env,
  KODEX_SERVER_PORT: process.env.KODEX_SERVER_PORT || '47831',
  KODEX_UI_ORIGINS: mode === 'dev'
    ? 'http://127.0.0.1:5173,http://localhost:5173'
    : 'http://127.0.0.1:4173,http://localhost:4173',
  VITE_KODEX_API_URL: `http://127.0.0.1:${process.env.KODEX_SERVER_PORT || '47831'}`,
};

const commands = mode === 'dev'
  ? [
      { name: 'local-server', command: process.execPath, args: [npmCli, 'run', 'dev', '--workspace', '@kodex/local-server'] },
      { name: 'ui', command: process.execPath, args: [npmCli, 'run', 'dev', '--workspace', '@kodex/ui'] },
    ]
  : [
      { name: 'local-server', command: process.execPath, args: [path.join(repositoryRoot, 'apps', 'local-server', 'dist', 'main.js')] },
      { name: 'ui', command: process.execPath, args: [npmCli, 'run', 'preview', '--workspace', '@kodex/ui'] },
    ];

const children = commands.map((entry) => {
  const child = spawn(entry.command, entry.args, {
    cwd: repositoryRoot,
    env: environment,
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

process.stdout.write(`Kodex UI: http://127.0.0.1:${mode === 'dev' ? '5173' : '4173'}\n`);
process.stdout.write(`Kodex Local Server: http://127.0.0.1:${environment.KODEX_SERVER_PORT}\n`);
