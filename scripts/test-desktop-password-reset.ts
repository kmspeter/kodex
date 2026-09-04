import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startIsolatedPostgres } from './lib/isolated-postgres.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Run this harness through npm run test:desktop-password-reset.');
const codexBinary = path.join(repositoryRoot, 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex');
const electronBinary = path.join(
  repositoryRoot, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron',
);
if (!existsSync(codexBinary)) throw new Error(`The repository Codex binary is missing at ${codexBinary}.`);
if (!existsSync(electronBinary)) throw new Error('The repository Electron runtime is not installed. Run npm install first.');

interface IsolatedPostgres { databaseUrl: string; stop(): Promise<void> }

let activeChild: ChildProcess | undefined;
let cleaning = false;
let deliveryServer: Server | undefined;
let postgres: IsolatedPostgres | undefined;
let temporaryRoot: string | undefined;

async function terminate(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32' && child.pid) {
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore', shell: false, windowsHide: true,
    });
    await new Promise<void>((resolve) => {
      killer.once('error', () => resolve());
      killer.once('exit', () => resolve());
    });
    return;
  }
  child.kill('SIGTERM');
  await Promise.race([
    new Promise<void>((resolve) => child.once('exit', () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

async function cleanup(): Promise<void> {
  if (cleaning) return;
  cleaning = true;
  await terminate(activeChild);
  activeChild = undefined;
  await new Promise<void>((resolve) => deliveryServer?.close(() => resolve()) ?? resolve());
  deliveryServer = undefined;
  await postgres?.stop().catch(() => undefined);
  postgres = undefined;
  if (temporaryRoot) {
    const resolved = path.resolve(temporaryRoot);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('kodex-desktop-ui-')) {
      throw new Error('Refusing to remove a desktop acceptance path outside the owned temporary root.');
    }
    await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

function run(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
  timeoutMs: number,
  phase: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: 'inherit', shell: false, windowsHide: true });
    activeChild = child;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (activeChild === child) activeChild = undefined;
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => {
      void terminate(child).finally(() => finish(new Error(`${phase} timed out after ${timeoutMs} ms.`)));
    }, timeoutMs);
    child.once('error', (error) => finish(error));
    child.once('exit', (code) => finish(code === 0 ? undefined : new Error(`${phase} failed with exit code ${code}.`)));
  });
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { void cleanup().finally(() => process.exit(130)); });
}

try {
  temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'kodex-desktop-ui-'));
  const artifactDirectory = path.join(temporaryRoot, 'failure-artifacts');
  const userDataDirectory = path.join(temporaryRoot, 'electron-user-data');
  await mkdir(userDataDirectory, { recursive: true });
  postgres = await startIsolatedPostgres({
    database: 'kodex_desktop_password_reset_test',
    namePrefix: 'kodex-desktop-password-reset-test',
  }) as IsolatedPostgres;

  const providerBearer = randomBytes(32).toString('base64url');
  const probeBearer = randomBytes(32).toString('base64url');
  let resetUrl = '';
  deliveryServer = createServer((request, response) => {
    void (async () => {
      if (request.method === 'GET' && request.url === '/latest') {
        if (request.headers['x-acceptance-probe'] !== probeBearer) {
          response.statusCode = 403;
          response.end();
          return;
        }
        if (!resetUrl) {
          response.statusCode = 404;
          response.end();
          return;
        }
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ resetUrl }));
        return;
      }
      if (request.method !== 'POST' || request.url !== '/delivery'
        || request.headers.authorization !== `Bearer ${providerBearer}`) {
        response.statusCode = 403;
        response.end();
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request) {
        const value = Buffer.from(chunk);
        bytes += value.length;
        if (bytes > 16_384) throw new Error('Delivery fixture body exceeded its acceptance bound.');
        chunks.push(value);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      if (body.kind !== 'password_reset' || typeof body.resetUrl !== 'string'
        || typeof body.email !== 'string' || typeof body.expiresAt !== 'string') {
        throw new Error('Delivery fixture received a malformed provider contract.');
      }
      resetUrl = body.resetUrl;
      response.statusCode = 202;
      response.end();
    })().catch(() => {
      response.statusCode = 500;
      response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    deliveryServer!.once('error', reject);
    deliveryServer!.listen(0, '127.0.0.1', () => resolve());
  });
  const deliveryAddress = deliveryServer.address();
  if (!deliveryAddress || typeof deliveryAddress === 'string') throw new Error('Delivery fixture did not bind.');
  const fixtureOrigin = `http://127.0.0.1:${deliveryAddress.port}`;

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: postgres.databaseUrl,
    PRODUCT_DB_SSL: 'disable',
    KODEX_DISABLE_ENV_FILE: '1',
    KODEX_CODEX_BIN: codexBinary,
    KODEX_RAG_ENABLED: 'false',
    KODEX_RAG_AUTOMATIONS_ENABLED: 'false',
    OPENAI_API_KEY: '',
    KODEX_LOCAL_LLM_API_KEY: '',
    AUTH_COOKIE_SECRET: randomBytes(32).toString('base64url'),
    AUTH_PASSWORD_RESET_ENABLED: 'true',
    AUTH_PASSWORD_RESET_DELIVERY_URL: `${fixtureOrigin}/delivery`,
    AUTH_PASSWORD_RESET_DELIVERY_BEARER_TOKEN: providerBearer,
    AUTH_PASSWORD_RESET_TTL_MINUTES: '60',
    KODEX_DESKTOP_ACCEPTANCE_ARTIFACT_DIR: artifactDirectory,
    KODEX_DESKTOP_ACCEPTANCE_DELIVERY_PROBE_BEARER: probeBearer,
    KODEX_DESKTOP_ACCEPTANCE_DELIVERY_PROBE_URL: `${fixtureOrigin}/latest`,
    KODEX_DESKTOP_ACCEPTANCE_DISPLAY_NAME: 'Desktop Recovery User',
    KODEX_DESKTOP_ACCEPTANCE_EMAIL: `desktop-recovery-${randomUUID()}@example.invalid`,
    KODEX_DESKTOP_ACCEPTANCE_NEW_PASSWORD: 'desktop recovery new password',
    KODEX_DESKTOP_ACCEPTANCE_OLD_PASSWORD: 'desktop recovery old password',
    KODEX_DESKTOP_ACCEPTANCE_USER_DATA: userDataDirectory,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const buildEnv = { ...env };
  for (const key of Object.keys(buildEnv)) {
    if (key.startsWith('KODEX_DESKTOP_ACCEPTANCE_')) delete buildEnv[key];
  }

  await run(process.execPath, [npmCli, 'run', 'build'], { cwd: repositoryRoot, env: buildEnv }, 300_000, 'Product build');
  await run(
    electronBinary,
    [path.join(repositoryRoot, 'apps', 'desktop', 'main.mjs'), '--password-reset-acceptance'],
    { cwd: repositoryRoot, env },
    240_000,
    'Desktop password reset acceptance',
  );
  process.stdout.write('Desktop password reset acceptance passed: register -> logout -> generic request -> fragment completion -> session revocation -> new login.\n');
} catch (error) {
  const artifactDirectory = temporaryRoot ? path.join(temporaryRoot, 'failure-artifacts') : undefined;
  if (artifactDirectory && existsSync(artifactDirectory)) {
    const retainedArtifacts = path.join(os.tmpdir(), `kodex-desktop-password-reset-failure-${randomUUID()}`);
    try {
      await rename(artifactDirectory, retainedArtifacts);
      process.stderr.write(`Desktop password reset acceptance artifacts retained under ${retainedArtifacts}.\n`);
    } catch {
      process.stderr.write('Desktop password reset acceptance artifacts could not be retained safely.\n');
    }
  }
  throw error;
} finally {
  await cleanup();
}
