import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startIsolatedPostgres } from './lib/isolated-postgres.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Run this acceptance harness through npm run test:desktop-workspace-invitation.');
const codexBinary = path.join(repositoryRoot, 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex');
const electronBinary = path.join(
  repositoryRoot,
  'node_modules',
  'electron',
  'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron',
);
if (!existsSync(codexBinary)) {
  throw new Error(`The repository Codex binary is missing at ${codexBinary}. Run npm run codex:build first.`);
}
if (!existsSync(electronBinary)) throw new Error('The repository Electron runtime is not installed. Run npm install first.');

interface IsolatedPostgres {
  databaseUrl: string;
  stop(): Promise<void>;
}

let activeChild: ChildProcess | undefined;
let postgres: IsolatedPostgres | undefined;
let cleaning = false;
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
    if (child.exitCode === null && child.signalCode === null) {
      await Promise.race([
        new Promise<void>((resolve) => child.once('exit', () => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
      ]);
    }
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
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
  await postgres?.stop().catch(() => undefined);
  postgres = undefined;
  if (temporaryRoot) {
    await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
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
    const child = spawn(command, args, {
      ...options,
      stdio: 'inherit',
      shell: false,
      windowsHide: true,
    });
    activeChild = child;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (activeChild === child) activeChild = undefined;
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      void terminate(child).finally(() => finish(new Error(`${phase} timed out after ${timeoutMs} ms.`)));
    }, timeoutMs);
    child.once('error', (error) => finish(error));
    child.once('exit', (code) => finish(code === 0 ? undefined : new Error(`${phase} failed with exit code ${code}.`)));
  });
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void cleanup().finally(() => process.exit(130));
  });
}

try {
  temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'kodex-desktop-ui-'));
  const artifactDirectory = path.join(temporaryRoot, 'failure-artifacts');
  const userDataDirectory = path.join(temporaryRoot, 'electron-user-data');
  await mkdir(userDataDirectory, { recursive: true });
  postgres = await startIsolatedPostgres({
    database: 'kodex_desktop_workspace_invitation_test',
    namePrefix: 'kodex-desktop-workspace-invitation-test',
  }) as IsolatedPostgres;

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: postgres.databaseUrl,
    PRODUCT_DB_SSL: 'disable',
    KODEX_DISABLE_ENV_FILE: '1',
    KODEX_CODEX_BIN: codexBinary,
    KODEX_RAG_ENABLED: 'false',
    KODEX_RAG_AUTOMATIONS_ENABLED: 'false',
    KODEX_AUTH_REVALIDATE_MS: '100',
    OPENAI_API_KEY: '',
    KODEX_LOCAL_LLM_API_KEY: '',
    AUTH_COOKIE_SECRET: randomBytes(32).toString('base64url'),
    KODEX_DESKTOP_ACCEPTANCE_ARTIFACT_DIR: artifactDirectory,
    KODEX_DESKTOP_ACCEPTANCE_INVITEE_DISPLAY_NAME: 'Desktop Invitation Invitee',
    KODEX_DESKTOP_ACCEPTANCE_INVITEE_EMAIL: `desktop-invitee-${randomUUID()}@example.invalid`,
    KODEX_DESKTOP_ACCEPTANCE_INVITEE_PASSWORD: 'desktop invitation invitee password',
    KODEX_DESKTOP_ACCEPTANCE_OWNER_DISPLAY_NAME: 'Desktop Invitation Owner',
    KODEX_DESKTOP_ACCEPTANCE_OWNER_EMAIL: `desktop-owner-${randomUUID()}@example.invalid`,
    KODEX_DESKTOP_ACCEPTANCE_OWNER_PASSWORD: 'desktop invitation owner password',
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
    [path.join(repositoryRoot, 'apps', 'desktop', 'main.mjs'), '--workspace-invitation-acceptance'],
    { cwd: repositoryRoot, env },
    240_000,
    'Desktop workspace invitation acceptance',
  );
  process.stdout.write('Desktop workspace invitation acceptance passed: owner DOM create -> fragment login -> explicit accept -> Local bootstrap/WebSocket -> reused-token terminal state.\n');
} catch (error) {
  const artifactDirectory = temporaryRoot ? path.join(temporaryRoot, 'failure-artifacts') : undefined;
  if (artifactDirectory && existsSync(artifactDirectory)) {
    const retainedArtifacts = path.join(os.tmpdir(), `kodex-desktop-workspace-invitation-failure-${randomUUID()}`);
    try {
      await rename(artifactDirectory, retainedArtifacts);
      process.stderr.write(`Desktop invitation acceptance artifacts retained under ${retainedArtifacts}.\n`);
    } catch {
      process.stderr.write('Desktop invitation acceptance artifacts could not be retained safely; runtime data will still be removed.\n');
    }
  }
  throw error;
} finally {
  await cleanup();
}
