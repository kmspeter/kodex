import { Buffer } from 'node:buffer';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { URL } from 'node:url';

function delay(milliseconds) {
  return new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds));
}

const PUBLIC_SERVICE_NAMES = new Map([
  ['Kodex Product API', 'Product API'],
  ['Kodex Local Server', 'Local Server'],
]);

export class DesktopStartupError extends Error {
  constructor(code, details = {}) {
    super(`Kodex desktop startup failed (${code}).`);
    this.name = 'DesktopStartupError';
    this.code = code;
    this.configPath = details.configPath;
    this.serviceName = details.serviceName;
  }
}

function publicConfigPath(value) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > 1_024
    || /[\r\n?&#="']/u.test(value)
    || /:\/\//u.test(value)
    || /(?:password|secret|token|api[_-]?key)\s*=/iu.test(value)
  ) return null;
  return path.resolve(value);
}

function withConfigPath(message, configPath) {
  const safePath = publicConfigPath(configPath);
  return safePath ? `${message}\n\nConfiguration file: ${safePath}` : message;
}

/**
 * Converts only coordinator-owned startup classifications into user-visible text.
 * Arbitrary Error.message values and error details are intentionally ignored.
 */
export function publicDesktopStartupMessage(error) {
  if (!(error instanceof DesktopStartupError)) {
    return 'Kodex could not start. Check the desktop configuration and try again.';
  }
  const service = PUBLIC_SERVICE_NAMES.get(error.serviceName);
  switch (error.code) {
    case 'DATABASE_URL_MISSING':
      return withConfigPath('DATABASE_URL is required before Kodex can start.', error.configPath);
    case 'AUTH_COOKIE_SECRET_MISSING':
      return withConfigPath('AUTH_COOKIE_SECRET is required before Kodex can start.', error.configPath);
    case 'DATABASE_URL_INVALID':
      return withConfigPath('DATABASE_URL in the desktop configuration is not a valid PostgreSQL URL.', error.configPath);
    case 'AUTH_COOKIE_SECRET_INVALID':
      return withConfigPath('AUTH_COOKIE_SECRET in the desktop configuration must contain at least 32 random bytes encoded as unpadded base64url.', error.configPath);
    case 'CONFIG_FILE_INVALID':
      return withConfigPath('The Kodex desktop configuration file could not be read.', error.configPath);
    case 'RUNTIME_FILES_MISSING':
      return service
        ? `Required ${service} runtime files are missing. Reinstall or rebuild Kodex.`
        : 'Required Kodex runtime files are missing. Reinstall or rebuild Kodex.';
    case 'CHILD_START_FAILED':
      return service ? `${service} could not be started.` : 'A required Kodex service could not be started.';
    case 'CHILD_EARLY_EXIT':
      return service
        ? `${service} stopped before Kodex finished starting.`
        : 'A required Kodex service stopped before startup completed.';
    case 'READINESS_TIMEOUT':
      return service
        ? `Timed out waiting for ${service} to become ready.`
        : 'Timed out waiting for a required Kodex service to become ready.';
    case 'CONFIG_INVALID':
      return withConfigPath('The Kodex desktop configuration contains an invalid value.', error.configPath);
    default:
      return 'Kodex could not start. Check the desktop configuration and try again.';
  }
}

export function assertOwnedChildPath(base, target, basenamePrefix) {
  const resolvedBase = path.resolve(base);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(resolvedBase, resolvedTarget);
  if (
    !relative
    || relative.startsWith('..')
    || path.isAbsolute(relative)
    || !path.basename(resolvedTarget).startsWith(basenamePrefix)
  ) {
    throw new Error('Refusing to remove a runtime data directory outside its trusted base.');
  }
  return resolvedTarget;
}

export function validateDesktopDependencies(environment, configPath) {
  const value = environment.DATABASE_URL?.trim();
  if (!value) {
    throw new DesktopStartupError('DATABASE_URL_MISSING', { configPath });
  }
  try {
    const url = new URL(value);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.pathname || url.pathname === '/') {
      throw new Error('invalid');
    }
  } catch {
    throw new DesktopStartupError('DATABASE_URL_INVALID', { configPath });
  }
  const cookieSecret = environment.AUTH_COOKIE_SECRET?.trim();
  if (!cookieSecret) {
    throw new DesktopStartupError('AUTH_COOKIE_SECRET_MISSING', { configPath });
  }
  if (
    !/^[A-Za-z0-9_-]+$/u.test(cookieSecret)
    || Buffer.from(cookieSecret, 'base64url').length < 32
    || Buffer.from(cookieSecret, 'base64url').toString('base64url') !== cookieSecret
  ) {
    throw new DesktopStartupError('AUTH_COOKIE_SECRET_INVALID', { configPath });
  }
}

export async function unusedLoopbackPort() {
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

export function startRuntimeChild(name, executable, entry, options) {
  const child = spawn(executable, [entry], {
    cwd: options.cwd,
    env: { ...options.env, ELECTRON_RUN_AS_NODE: '1' },
    shell: false,
    windowsHide: true,
    // Child logs are intentionally not forwarded. Startup failures are reported by
    // the desktop coordinator without risking DATABASE_URL or provider-key output.
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  child.kodexName = name;
  return child;
}

export async function waitForReady(child, url, name, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  const attemptTimeoutMs = Math.min(1_000, timeoutMs);
  let spawnError;
  child.once('error', (error) => { spawnError = error; });
  while (Date.now() < deadline) {
    if (spawnError) throw new DesktopStartupError('CHILD_START_FAILED', { serviceName: name });
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new DesktopStartupError('CHILD_EARLY_EXIT', { serviceName: name });
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    const controller = new globalThis.AbortController();
    const attemptTimer = globalThis.setTimeout(
      () => controller.abort(),
      Math.min(attemptTimeoutMs, remainingMs),
    );
    try {
      const response = await globalThis.fetch(url, {
        cache: 'no-store',
        signal: controller.signal,
      });
      const cancelBody = () => { void response.body?.cancel().catch(() => undefined); };
      if (response.ok) {
        cancelBody();
        return;
      }
      cancelBody();
    } catch { /* retry while the child binds and initializes */ }
    finally { globalThis.clearTimeout(attemptTimer); }
    const delayMs = Math.min(100, Math.max(0, deadline - Date.now()));
    if (delayMs > 0) await delay(delayMs);
  }
  throw new DesktopStartupError('READINESS_TIMEOUT', { serviceName: name });
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return Promise.race([
    new Promise((resolve) => child.once('exit', () => resolve(true))),
    delay(timeoutMs).then(() => false),
  ]);
}

export async function stopProcessTree(child, gracefulTimeoutMs = 5_000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (child.connected) {
    try { child.send({ type: 'kodex-shutdown' }); } catch { child.kill('SIGTERM'); }
  } else {
    child.kill('SIGTERM');
  }
  if (await waitForExit(child, gracefulTimeoutMs)) return;
  if (process.platform === 'win32' && child.pid) {
    spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      shell: false,
      windowsHide: true,
      stdio: 'ignore',
    });
  } else {
    child.kill('SIGKILL');
  }
  await waitForExit(child, 2_000);
}

export async function stopRuntimeChildren(children) {
  for (const child of [...children].reverse()) await stopProcessTree(child);
}
