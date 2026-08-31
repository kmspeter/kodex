import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';

const desktopRoot = path.dirname(fileURLToPath(import.meta.url));
const bundledCandidate = path.resolve(desktopRoot, '..');
const bundledRuntime = existsSync(path.join(bundledCandidate, 'server', 'main.js')) && existsSync(path.join(bundledCandidate, 'ui', 'index.html'));
const sourceRoot = bundledRuntime ? bundledCandidate : path.resolve(desktopRoot, '..', '..');
const smoke = process.argv.includes('--smoke');
let localServer = null;
let quitting = false;
let smokeDataRoot = null;
let smokeStage = 'waiting for Electron ready';
const smokeTimeout = smoke ? globalThis.setTimeout(() => {
  process.stderr.write(`Kodex desktop smoke timed out while ${smokeStage}.\n`);
  void stopLocalServer().finally(() => app.exit(1));
}, 20_000) : null;

function runtimeRoot() {
  return bundledRuntime ? sourceRoot : app.isPackaged ? path.join(process.resourcesPath, 'app') : sourceRoot;
}

function serverEntry(root) {
  return bundledRuntime || app.isPackaged ? path.join(root, 'server', 'main.js') : path.join(root, 'apps', 'local-server', 'dist', 'main.js');
}

function uiRoot(root) {
  return bundledRuntime || app.isPackaged ? path.join(root, 'ui') : path.join(root, 'apps', 'ui', 'dist');
}

async function unusedLoopbackPort() {
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

async function waitForLocalServer(url, child) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Kodex Local Server exited with code ${child.exitCode}.`);
    try {
      const response = await globalThis.fetch(`${url}/api/health`, { cache: 'no-store' });
      if (response.ok) return;
    } catch { /* retry while the local process starts */ }
    await new Promise((resolve) => globalThis.setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for the Kodex Local Server.');
}

async function startLocalServer() {
  smokeStage = 'starting the Local Server';
  const root = runtimeRoot();
  const entry = serverEntry(root);
  if (!existsSync(entry) || !existsSync(uiRoot(root))) throw new Error('Built Local Server/UI files are missing. Run npm run build first.');
  const port = smoke ? await unusedLoopbackPort() : Math.max(1, Math.min(65_535, Number(process.env.KODEX_SERVER_PORT) || 47_831));
  const origin = `http://127.0.0.1:${port}`;
  if (smoke) smokeDataRoot = await mkdtemp(path.join(app.getPath('temp'), 'kodex-desktop-smoke-'));
  const environment = {
    ...process.env,
    KODEX_RUNTIME_ROOT: root,
    KODEX_DATA_ROOT: smoke ? smokeDataRoot : bundledRuntime || app.isPackaged ? path.join(app.getPath('userData'), '.kodex-data') : path.join(root, '.kodex-data'),
    KODEX_SERVER_PORT: String(port),
    KODEX_SERVE_UI: '1',
    KODEX_UI_ROOT: uiRoot(root),
    KODEX_UI_ORIGINS: `${origin},http://localhost:${port}`,
  };
  for (const key of Object.keys(environment)) if (/^(?:VITE_|NEXT_PUBLIC_)/u.test(key)) delete environment[key];
  if (smoke) {
    environment.KODEX_DISABLE_ENV_FILE = '1';
    delete environment.OPENAI_API_KEY;
    delete environment.KODEX_LOCAL_LLM_API_KEY;
  }
  localServer = spawn(process.execPath, [entry], {
    cwd: root, env: { ...environment, ELECTRON_RUN_AS_NODE: '1' }, shell: false, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  localServer.stdout.on('data', (chunk) => process.stdout.write(chunk));
  localServer.stderr.on('data', (chunk) => process.stderr.write(chunk));
  await waitForLocalServer(origin, localServer);
  smokeStage = 'loading the localhost renderer';
  return origin;
}

function safeExternalUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : null;
  } catch { return null; }
}

function registerDesktopIpc() {
  ipcMain.handle('kodex:select-directory', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  ipcMain.handle('kodex:select-file', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openFile'] });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  ipcMain.handle('kodex:open-external', async (_event, value) => {
    const target = safeExternalUrl(value);
    if (!target) throw new Error('Only http/https external links are allowed.');
    await shell.openExternal(target);
  });
}

async function stopLocalServer() {
  const child = localServer;
  localServer = null;
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => globalThis.setTimeout(resolve, 5_000)),
    ]);
    if (child.exitCode === null && process.platform === 'win32' && child.pid) {
      spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' });
      await new Promise((resolve) => child.once('exit', resolve));
    }
  }
  if (smokeDataRoot) {
    const target = smokeDataRoot;
    smokeDataRoot = null;
    await rm(target, { recursive: true, force: true });
  }
}

async function launch() {
  if (smoke) process.stdout.write('Kodex desktop smoke: Electron ready.\n');
  registerDesktopIpc();
  const origin = await startLocalServer();
  const window = new BrowserWindow({
    width: 1440, height: 920, minWidth: 980, minHeight: 680, show: !smoke,
    webPreferences: {
      preload: path.join(runtimeRoot(), bundledRuntime || app.isPackaged ? 'desktop/preload.mjs' : 'apps/desktop/preload.mjs'),
      nodeIntegration: false, contextIsolation: true, sandbox: true,
    },
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    const target = safeExternalUrl(url);
    if (target) void shell.openExternal(target);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, target) => {
    if (new URL(target).origin !== origin) {
      event.preventDefault();
      const external = safeExternalUrl(target);
      if (external) void shell.openExternal(external);
    }
  });
  await window.loadURL(origin);
  if (smoke) {
    smokeStage = 'checking the rendered document';
    const title = await window.webContents.executeJavaScript('document.title');
    if (!String(title).toLocaleLowerCase().includes('kodex')) throw new Error(`Unexpected desktop document title: ${title}`);
    process.stdout.write('Kodex desktop smoke test passed.\n');
    if (smokeTimeout) globalThis.clearTimeout(smokeTimeout);
    window.destroy();
    await stopLocalServer();
    app.quit();
  }
}

app.on('before-quit', (event) => {
  if (quitting || !localServer) return;
  event.preventDefault();
  quitting = true;
  void stopLocalServer().finally(() => app.quit());
});
app.on('window-all-closed', () => app.quit());

app.whenReady().then(() => launch()).catch(async (error) => {
  if (smokeTimeout) globalThis.clearTimeout(smokeTimeout);
  process.stderr.write(`Kodex desktop failed: ${error instanceof Error ? error.message : String(error)}\n`);
  await stopLocalServer();
  app.exit(1);
});
