import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import dotenv from 'dotenv';
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import {
  assertOwnedChildPath,
  DesktopStartupError,
  publicDesktopStartupMessage,
  startRuntimeChild,
  stopRuntimeChildren,
  unusedLoopbackPort,
  validateDesktopDependencies,
  waitForReady,
} from './runtime-processes.mjs';

app.setName('Kodex');

const desktopRoot = path.dirname(fileURLToPath(import.meta.url));
const bundledCandidate = path.resolve(desktopRoot, '..');
const bundledRuntime = existsSync(path.join(bundledCandidate, 'server', 'main.js'))
  && existsSync(path.join(bundledCandidate, 'product-api', 'main.js'))
  && existsSync(path.join(bundledCandidate, 'ui', 'index.html'));
const sourceRoot = bundledRuntime ? bundledCandidate : path.resolve(desktopRoot, '..', '..');
const fakeSmoke = process.argv.includes('--smoke');
const fullStackAcceptance = process.argv.includes('--full-stack-acceptance');
const workspaceLifecycleAcceptance = process.argv.includes('--workspace-lifecycle-acceptance');
const workspaceInvitationAcceptance = process.argv.includes('--workspace-invitation-acceptance');
const repositoryRagAcceptance = process.argv.includes('--repository-rag-acceptance');
const desktopAcceptance = fullStackAcceptance || workspaceLifecycleAcceptance || workspaceInvitationAcceptance || repositoryRagAcceptance;
const smoke = fakeSmoke || process.argv.includes('--smoke-real') || desktopAcceptance;
const children = [];
let mainWindow = null;
let quitting = false;
let launchComplete = false;
let smokeDataRoot = null;
let smokeStage = 'waiting for Electron ready';
let acceptanceArtifactDirectory = null;

const smokeTimeout = smoke ? globalThis.setTimeout(() => {
  void fatalShutdown(new Error(`Desktop smoke timed out while ${smokeStage}.`));
}, repositoryRagAcceptance ? 270_000 : workspaceLifecycleAcceptance || workspaceInvitationAcceptance ? 210_000 : fullStackAcceptance ? 180_000 : 30_000) : null;

if (desktopAcceptance) {
  const isolatedUserData = path.resolve(process.env.KODEX_DESKTOP_ACCEPTANCE_USER_DATA?.trim() ?? '');
  const artifactDirectory = path.resolve(process.env.KODEX_DESKTOP_ACCEPTANCE_ARTIFACT_DIR?.trim() ?? '');
  const acceptanceRoot = path.dirname(isolatedUserData);
  const relativeRoot = path.relative(app.getPath('temp'), acceptanceRoot);
  if (
    !path.isAbsolute(process.env.KODEX_DESKTOP_ACCEPTANCE_USER_DATA?.trim() ?? '')
    || !path.isAbsolute(process.env.KODEX_DESKTOP_ACCEPTANCE_ARTIFACT_DIR?.trim() ?? '')
    || !path.basename(acceptanceRoot).startsWith('kodex-desktop-ui-')
    || relativeRoot.startsWith('..')
    || path.isAbsolute(relativeRoot)
    || path.basename(isolatedUserData) !== 'electron-user-data'
    || path.dirname(artifactDirectory) !== acceptanceRoot
    || path.basename(artifactDirectory) !== 'failure-artifacts'
  ) {
    throw new Error('Desktop acceptance requires owned paths under its temporary root.');
  }
  app.setPath('userData', isolatedUserData);
  acceptanceArtifactDirectory = artifactDirectory;
}

function runtimeRoot() {
  return bundledRuntime || app.isPackaged ? sourceRoot : path.resolve(desktopRoot, '..', '..');
}

function entries(root) {
  if (fakeSmoke) {
    const fixture = path.join(desktopRoot, 'smoke-service.mjs');
    return { productApi: fixture, localServer: fixture };
  }
  return bundledRuntime || app.isPackaged
    ? {
        productApi: path.join(root, 'product-api', 'main.js'),
        localServer: path.join(root, 'server', 'main.js'),
      }
    : {
        productApi: path.join(root, 'apps', 'api', 'dist', 'main.js'),
        localServer: path.join(root, 'apps', 'local-server', 'dist', 'main.js'),
      };
}

function uiRoot(root) {
  return bundledRuntime || app.isPackaged ? path.join(root, 'ui') : path.join(root, 'apps', 'ui', 'dist');
}

function positivePort(value, fallback) {
  const port = value?.trim() ? Number(value) : fallback;
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) {
    throw new DesktopStartupError('CONFIG_INVALID');
  }
  return port;
}

async function loadDesktopConfiguration() {
  const configuredPath = process.env.KODEX_CONFIG_FILE?.trim();
  const configPath = configuredPath
    ? path.resolve(configuredPath)
    : path.join(app.getPath('userData'), 'kodex.env');
  if (!fakeSmoke && existsSync(configPath)) {
    let parsed;
    try {
      parsed = dotenv.parse(await readFile(configPath, 'utf8'));
    } catch {
      throw new DesktopStartupError('CONFIG_FILE_INVALID', { configPath });
    }
    for (const [key, value] of Object.entries(parsed)) {
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }
  if (!fakeSmoke) validateDesktopDependencies(process.env, configPath);
  return configPath;
}

function childEnvironment(overrides) {
  const environment = { ...process.env, ...overrides };
  for (const key of Object.keys(environment)) {
    if (
      /^(?:VITE_|NEXT_PUBLIC_|KODEX_DESKTOP_ACCEPTANCE_)/iu.test(key)
      || environment[key] === undefined
    ) delete environment[key];
  }
  if (fakeSmoke) {
    for (const key of [
      'AUTH_COOKIE_SECRET',
      'DATABASE_URL',
      'KODEX_LOCAL_LLM_API_KEY',
      'OPENAI_API_KEY',
      'PRODUCT_DB_PASSWORD',
    ]) delete environment[key];
  }
  if (desktopAcceptance && process.env.KODEX_DESKTOP_ACCEPTANCE_NODE_OPTIONS?.trim()) {
    environment.NODE_OPTIONS = process.env.KODEX_DESKTOP_ACCEPTANCE_NODE_OPTIONS.trim();
  }
  return environment;
}

function watchChild(name, child) {
  child.once('exit', () => {
    if (quitting || !launchComplete) return;
    void fatalShutdown(new DesktopStartupError('CHILD_EARLY_EXIT', { serviceName: name }));
  });
}

async function startChild(name, entry, environment, readyUrl, root) {
  if (!existsSync(entry)) throw new DesktopStartupError('RUNTIME_FILES_MISSING', { serviceName: name });
  const child = startRuntimeChild(name, process.execPath, entry, { cwd: root, env: environment });
  children.push(child);
  watchChild(name, child);
  await waitForReady(child, readyUrl, name);
  return child;
}

async function startServices() {
  const root = runtimeRoot();
  const serviceEntries = entries(root);
  const rendererRoot = uiRoot(root);
  if (!existsSync(rendererRoot)) throw new DesktopStartupError('RUNTIME_FILES_MISSING');

  const localPort = smoke
    ? await unusedLoopbackPort()
    : positivePort(process.env.KODEX_SERVER_PORT, 47_831);
  const productPort = smoke
    ? await unusedLoopbackPort()
    : positivePort(process.env.PRODUCT_API_PORT, 47_832);
  if (localPort === productPort) throw new DesktopStartupError('CONFIG_INVALID');
  const localOrigin = `http://127.0.0.1:${localPort}`;
  const productOrigin = `http://127.0.0.1:${productPort}`;
  const dataRoot = smoke
    ? (smokeDataRoot = await mkdtemp(path.join(app.getPath('temp'), 'kodex-desktop-smoke-')))
    : path.join(app.getPath('userData'), 'data');

  smokeStage = 'waiting for Product API readiness';
  await startChild('Kodex Product API', serviceEntries.productApi, childEnvironment({
    KODEX_RUNTIME_ROOT: root,
    KODEX_DISABLE_ENV_FILE: '1',
    KODEX_SMOKE_SERVICE: fakeSmoke ? 'product-api' : undefined,
    PRODUCT_API_NODE_ENV: 'development',
    PRODUCT_API_HOST: '127.0.0.1',
    PRODUCT_API_PORT: String(productPort),
    PRODUCT_API_ALLOWED_HOSTS: `127.0.0.1:${productPort}`,
    AUTH_ALLOWED_ORIGINS: localOrigin,
    AUTH_COOKIE_SECURE: 'false',
    KODEX_UI_ORIGINS: localOrigin,
  }), `${productOrigin}/api/health/ready`, root);

  smokeStage = 'waiting for Local Server readiness';
  await startChild('Kodex Local Server', serviceEntries.localServer, childEnvironment({
    KODEX_RUNTIME_ROOT: root,
    KODEX_DISABLE_ENV_FILE: '1',
    KODEX_SMOKE_SERVICE: fakeSmoke ? 'local-server' : undefined,
    KODEX_DATA_ROOT: dataRoot,
    KODEX_TENANT_ROOT: path.join(dataRoot, 'tenants'),
    KODEX_SERVER_PORT: String(localPort),
    PRODUCT_API_PORT: String(productPort),
    KODEX_SERVE_UI: '1',
    KODEX_UI_ROOT: rendererRoot,
    KODEX_UI_ORIGINS: localOrigin,
    KODEX_PRODUCT_API_ORIGINS: productOrigin,
  }), `${localOrigin}/api/health`, root);
  const exited = children.find((child) => child.exitCode !== null || child.signalCode !== null);
  if (exited) throw new DesktopStartupError('CHILD_EARLY_EXIT', { serviceName: exited.kodexName });
  launchComplete = true;
  return { localOrigin, productOrigin };
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
    if (repositoryRagAcceptance) {
      const configured = path.resolve(process.env.KODEX_DESKTOP_ACCEPTANCE_REPOSITORY_ROOT?.trim() ?? '');
      const acceptanceRoot = path.dirname(configured);
      const relativeRoot = path.relative(app.getPath('temp'), acceptanceRoot);
      if (
        !path.isAbsolute(process.env.KODEX_DESKTOP_ACCEPTANCE_REPOSITORY_ROOT?.trim() ?? '')
        || path.basename(configured) !== 'repository-fixture'
        || !path.basename(acceptanceRoot).startsWith('kodex-desktop-ui-')
        || relativeRoot.startsWith('..')
        || path.isAbsolute(relativeRoot)
      ) throw new Error('Repository RAG acceptance directory is outside its owned temporary root.');
      return configured;
    }
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

async function stopServices() {
  await stopRuntimeChildren(children.splice(0));
  if (smokeDataRoot) {
    const target = smokeDataRoot;
    smokeDataRoot = null;
    await rm(assertOwnedChildPath(app.getPath('temp'), target, 'kodex-desktop-smoke-'), {
      recursive: true,
      force: true,
    });
  }
}

async function fatalShutdown(error) {
  if (quitting) return;
  quitting = true;
  launchComplete = false;
  if (smokeTimeout) globalThis.clearTimeout(smokeTimeout);
  const publicMessage = publicDesktopStartupMessage(error);
  process.stderr.write(`Kodex desktop failed: ${publicMessage.replaceAll('\n', ' ')}\n`);
  mainWindow?.destroy();
  mainWindow = null;
  if (!smoke) {
    try { dialog.showErrorBox('Kodex could not start', publicMessage); } catch { /* exit below */ }
  }
  await stopServices().catch(() => undefined);
  app.exit(1);
}

async function launch() {
  if (smoke) process.stdout.write('Kodex desktop smoke: Electron ready.\n');
  await loadDesktopConfiguration();
  registerDesktopIpc();
  const { localOrigin, productOrigin } = await startServices();
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 980,
    minHeight: 680,
    show: !smoke,
    webPreferences: {
      preload: path.join(runtimeRoot(), bundledRuntime || app.isPackaged ? 'desktop/preload.cjs' : 'apps/desktop/preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const target = safeExternalUrl(url);
    if (target) void shell.openExternal(target);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, target) => {
    try {
      if (new URL(target).origin === localOrigin) return;
    } catch { /* block malformed navigation below */ }
    event.preventDefault();
    const external = safeExternalUrl(target);
    if (external) void shell.openExternal(external);
  });
  smokeStage = 'loading the localhost renderer';
  await mainWindow.loadURL(localOrigin);
  if (!smoke) return;

  if (fullStackAcceptance) {
    smokeStage = 'running the renderer DOM acceptance scenario';
    const { runDesktopFullStackAcceptance } = await import('./full-stack-acceptance-driver.mjs');
    await runDesktopFullStackAcceptance(mainWindow, {
      artifactDirectory: acceptanceArtifactDirectory,
      displayName: process.env.KODEX_DESKTOP_ACCEPTANCE_DISPLAY_NAME,
      email: process.env.KODEX_DESKTOP_ACCEPTANCE_EMAIL,
      fixtureBaseUrl: process.env.KODEX_DESKTOP_ACCEPTANCE_BASE_URL,
      password: process.env.KODEX_DESKTOP_ACCEPTANCE_PASSWORD,
    });
    process.stdout.write('Kodex desktop full-stack acceptance passed through renderer DOM interactions.\n');
    if (smokeTimeout) globalThis.clearTimeout(smokeTimeout);
    quitting = true;
    launchComplete = false;
    mainWindow.destroy();
    mainWindow = null;
    await stopServices();
    app.quit();
    return;
  }

  if (workspaceInvitationAcceptance) {
    smokeStage = 'running the workspace invitation renderer DOM acceptance scenario';
    const { runDesktopWorkspaceInvitationAcceptance } = await import('./workspace-invitation-acceptance-driver.mjs');
    await runDesktopWorkspaceInvitationAcceptance(mainWindow, {
      artifactDirectory: acceptanceArtifactDirectory,
      databaseUrl: process.env.DATABASE_URL,
      inviteeDisplayName: process.env.KODEX_DESKTOP_ACCEPTANCE_INVITEE_DISPLAY_NAME,
      inviteeEmail: process.env.KODEX_DESKTOP_ACCEPTANCE_INVITEE_EMAIL,
      inviteePassword: process.env.KODEX_DESKTOP_ACCEPTANCE_INVITEE_PASSWORD,
      localOrigin,
      ownerDisplayName: process.env.KODEX_DESKTOP_ACCEPTANCE_OWNER_DISPLAY_NAME,
      ownerEmail: process.env.KODEX_DESKTOP_ACCEPTANCE_OWNER_EMAIL,
      ownerPassword: process.env.KODEX_DESKTOP_ACCEPTANCE_OWNER_PASSWORD,
      productOrigin,
    });
    process.stdout.write('Kodex desktop workspace invitation acceptance passed through renderer DOM interactions.\n');
    if (smokeTimeout) globalThis.clearTimeout(smokeTimeout);
    quitting = true;
    launchComplete = false;
    mainWindow.destroy();
    mainWindow = null;
    await stopServices();
    app.quit();
    return;
  }

  if (workspaceLifecycleAcceptance) {
    smokeStage = 'running the workspace lifecycle renderer DOM acceptance scenario';
    const { runDesktopWorkspaceLifecycleAcceptance } = await import('./workspace-lifecycle-acceptance-driver.mjs');
    await runDesktopWorkspaceLifecycleAcceptance(mainWindow, {
      artifactDirectory: acceptanceArtifactDirectory,
      databaseUrl: process.env.DATABASE_URL,
      displayName: process.env.KODEX_DESKTOP_ACCEPTANCE_DISPLAY_NAME,
      email: process.env.KODEX_DESKTOP_ACCEPTANCE_EMAIL,
      localOrigin,
      password: process.env.KODEX_DESKTOP_ACCEPTANCE_PASSWORD,
      productOrigin,
      renamedWorkspaceName: process.env.KODEX_DESKTOP_ACCEPTANCE_RENAMED_WORKSPACE_NAME,
      targetWorkspaceName: process.env.KODEX_DESKTOP_ACCEPTANCE_TARGET_WORKSPACE_NAME,
    });
    process.stdout.write('Kodex desktop workspace lifecycle acceptance passed through renderer DOM interactions.\n');
    if (smokeTimeout) globalThis.clearTimeout(smokeTimeout);
    quitting = true;
    launchComplete = false;
    mainWindow.destroy();
    mainWindow = null;
    await stopServices();
    app.quit();
    return;
  }

  if (repositoryRagAcceptance) {
    smokeStage = 'running the repository RAG renderer DOM acceptance scenario';
    const { runDesktopRepositoryRagAcceptance } = await import('./repository-rag-acceptance-driver.mjs');
    await runDesktopRepositoryRagAcceptance(mainWindow, {
      artifactDirectory: acceptanceArtifactDirectory,
      databaseUrl: process.env.DATABASE_URL,
      displayName: process.env.KODEX_DESKTOP_ACCEPTANCE_DISPLAY_NAME,
      email: process.env.KODEX_DESKTOP_ACCEPTANCE_EMAIL,
      fixtureBaseUrl: process.env.KODEX_DESKTOP_ACCEPTANCE_BASE_URL,
      foreignEmail: process.env.KODEX_DESKTOP_ACCEPTANCE_FOREIGN_EMAIL,
      foreignPassword: process.env.KODEX_DESKTOP_ACCEPTANCE_FOREIGN_PASSWORD,
      localOrigin,
      password: process.env.KODEX_DESKTOP_ACCEPTANCE_PASSWORD,
      productOrigin,
      repositoryRoot: process.env.KODEX_DESKTOP_ACCEPTANCE_REPOSITORY_ROOT,
      sourceFile: process.env.KODEX_DESKTOP_ACCEPTANCE_SOURCE_FILE,
      updatedContent: process.env.KODEX_DESKTOP_ACCEPTANCE_UPDATED_CONTENT,
    });
    process.stdout.write('Kodex desktop repository RAG acceptance passed through renderer DOM interactions.\n');
    if (smokeTimeout) globalThis.clearTimeout(smokeTimeout);
    quitting = true;
    launchComplete = false;
    mainWindow.destroy();
    mainWindow = null;
    await stopServices();
    app.quit();
    return;
  }

  smokeStage = 'checking Product API runtime configuration and login UI';
  const rendered = await mainWindow.webContents.executeJavaScript(`new Promise((resolve) => {
    const deadline = Date.now() + 10_000;
    let retried = false;
    const inspect = () => {
      const text = document.body.innerText;
      const configured = document.querySelector('meta[name="kodex-product-api-origin"]')?.content;
      if (text.includes('Kodex에 로그인')) { resolve({ ok: configured === ${JSON.stringify(productOrigin)}, text, configured }); return; }
      if (!retried && text.includes('인증 서비스를 확인할 수 없습니다')) {
        retried = true;
        document.querySelector('#auth-unavailable-title')?.parentElement?.querySelector('button')?.click();
      }
      if (Date.now() >= deadline) {
        void fetch(configured + '/api/auth/me', { credentials: 'include', cache: 'no-store' })
          .then((response) => resolve({ ok: false, text, configured, probe: { status: response.status } }))
          .catch((error) => resolve({ ok: false, text, configured, probe: { error: String(error) } }));
        return;
      }
      setTimeout(inspect, 50);
    };
    inspect();
  })`);
  if (!rendered.ok) {
    throw new Error(`Renderer did not reach the login screen with the expected Product API origin (${rendered.configured ?? 'missing'}); probe=${JSON.stringify(rendered.probe)}, text=${String(rendered.text).slice(0, 300)}.`);
  }
  process.stdout.write('Kodex desktop smoke test passed: Product API ready -> Local Server ready -> login UI.\n');
  if (smokeTimeout) globalThis.clearTimeout(smokeTimeout);
  quitting = true;
  launchComplete = false;
  mainWindow.destroy();
  mainWindow = null;
  await stopServices();
  app.quit();
}

app.on('before-quit', (event) => {
  if (quitting || children.length === 0) return;
  event.preventDefault();
  quitting = true;
  launchComplete = false;
  void stopServices().finally(() => app.quit());
});
app.on('window-all-closed', () => { if (!quitting) app.quit(); });

app.whenReady().then(() => launch()).catch((error) => fatalShutdown(error));
