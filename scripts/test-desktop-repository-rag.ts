import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from 'pg';
import { startRepositoryRagLoopbackFixture } from '../test/fixtures/repository-rag-loopback';
import { startIsolatedPostgres } from './lib/isolated-postgres.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Run this acceptance harness through npm run test:desktop-repository-rag.');
const codexBinary = path.join(repositoryRoot, 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex');
const electronBinary = path.join(
  repositoryRoot, 'node_modules', 'electron', 'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron',
);
if (!existsSync(codexBinary)) {
  throw new Error(`The repository Codex binary is missing at ${codexBinary}. Run npm run codex:build first.`);
}
if (!existsSync(electronBinary)) throw new Error('The repository Electron runtime is not installed. Run npm install first.');

const INITIAL_CONTENT = 'REPOSITORY_ACCEPTANCE_ALPHA initial repository version.\nSafe relative citations must use docs/repository-note.md.\n';
const UPDATED_CONTENT = 'REPOSITORY_ACCEPTANCE_ALPHA changed repository version with stable identity.\nSafe relative citations must use docs/repository-note.md.\n';
const MANUAL_CONTENT = 'MANUAL_KNOWLEDGE_BRAVO manual knowledge must survive repository deletion.';
const IGNORED_SECRET = 'IGNORED_FILE_SECRET_DO_NOT_INDEX';
const ENV_SECRET = 'ENV_SECRET_DO_NOT_INDEX';
const SSH_SECRET = 'SSH_PRIVATE_SECRET_DO_NOT_INDEX';

interface IsolatedPostgres {
  databaseUrl: string;
  stop(): Promise<void>;
}

let activeChild: ChildProcess | undefined;
let postgres: IsolatedPostgres | undefined;
let fixture: Awaited<ReturnType<typeof startRepositoryRagLoopbackFixture>> | undefined;
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
  await fixture?.close().catch(() => undefined);
  fixture = undefined;
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
    const child = spawn(command, args, { ...options, stdio: 'inherit', shell: false, windowsHide: true });
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

function capture(command: string, args: string[], cwd: string, timeoutMs = 15_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${command} timed out after ${timeoutMs} ms.`));
    }, timeoutMs);
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `${command} exited with ${code}.`));
    });
  });
}

async function createRepositoryFixture(root: string): Promise<string> {
  await mkdir(path.join(root, 'docs'), { recursive: true });
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, 'ignored'), { recursive: true });
  await mkdir(path.join(root, '.ssh'), { recursive: true });
  await capture('git', ['init', '--quiet'], root);
  await Promise.all([
    writeFile(path.join(root, '.gitignore'), 'ignored/\n*.ignored.txt\n', 'utf8'),
    writeFile(path.join(root, 'docs', 'repository-note.md'), INITIAL_CONTENT, 'utf8'),
    writeFile(path.join(root, 'src', 'example.ts'), 'export const acceptanceFixture = true;\n', 'utf8'),
    writeFile(path.join(root, 'README.md'), '# Repository acceptance fixture\n', 'utf8'),
    writeFile(path.join(root, 'ignored', 'private.txt'), `${IGNORED_SECRET}\n`, 'utf8'),
    writeFile(path.join(root, 'discarded.ignored.txt'), `${IGNORED_SECRET}\n`, 'utf8'),
    writeFile(path.join(root, '.env'), `TOKEN=${ENV_SECRET}\n`, 'utf8'),
    writeFile(path.join(root, '.ssh', 'id_ed25519'), `${SSH_SECRET}\n`, 'utf8'),
  ]);
  return path.join(root, 'docs', 'repository-note.md');
}

async function verifyFinalDatabase(databaseUrl: string, email: string): Promise<void> {
  const client = new Client({ connectionString: databaseUrl, ssl: false });
  await client.connect();
  try {
    const result = await client.query<{
      content_text: string;
      source_type: string;
      title: string;
    }>(`
      SELECT document.title, document.content_text, source.source_type
      FROM documents AS document
      JOIN knowledge_sources AS source ON source.id = document.source_id
      JOIN users AS account ON account.id = document.created_by_user_id
      WHERE lower(account.email) = lower($1)
      ORDER BY document.title
    `, [email]);
    if (result.rows.length !== 1 || result.rows[0]?.source_type !== 'manual_text') {
      throw new Error(`Final DB state did not retain exactly the manual document: ${JSON.stringify(result.rows)}`);
    }
    if (result.rows[0].title !== 'Manual acceptance knowledge' || result.rows[0].content_text !== MANUAL_CONTENT) {
      throw new Error('Final DB state changed the manual knowledge document.');
    }
  } finally {
    await client.end();
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { void cleanup().finally(() => process.exit(130)); });
}

try {
  temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'kodex-desktop-ui-'));
  const artifactDirectory = path.join(temporaryRoot, 'failure-artifacts');
  const userDataDirectory = path.join(temporaryRoot, 'electron-user-data');
  const fixtureRepository = path.join(temporaryRoot, 'repository-fixture');
  const embeddingLog = path.join(temporaryRoot, 'embedding-inputs.jsonl');
  const sourceFile = await createRepositoryFixture(fixtureRepository);
  await mkdir(userDataDirectory, { recursive: true });
  postgres = await startIsolatedPostgres({
    database: 'kodex_desktop_repository_rag_test',
    namePrefix: 'kodex-desktop-repository-rag-test',
  }) as IsolatedPostgres;
  fixture = await startRepositoryRagLoopbackFixture();
  const primaryEmail = `desktop-rag-${randomUUID()}@example.invalid`;
  const foreignEmail = `desktop-rag-foreign-${randomUUID()}@example.invalid`;
  const embeddingHook = pathToFileURL(path.join(
    repositoryRoot, 'test', 'fixtures', 'deterministic-embedding-fetch-hook.mjs',
  )).href;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: postgres.databaseUrl,
    PRODUCT_DB_SSL: 'disable',
    KODEX_DISABLE_ENV_FILE: '1',
    KODEX_CODEX_BIN: codexBinary,
    KODEX_RAG_ENABLED: 'true',
    KODEX_RAG_AUTOMATIONS_ENABLED: 'false',
    KODEX_RAG_SCORE_THRESHOLD: '0.9',
    KODEX_RAG_TOP_K: '5',
    KODEX_RAG_MAX_TOP_K: '20',
    KODEX_RAG_CONTEXT_MAX_CHARACTERS: '2000',
    KODEX_AUTH_REVALIDATE_MS: '100',
    KODEX_HISTORY_RETRY_INITIAL_MS: '25',
    KODEX_HISTORY_RETRY_MAX_MS: '250',
    OPENAI_API_KEY: 'kodex-acceptance-key',
    OPENAI_EMBEDDING_MODEL: 'kodex-acceptance-embedding-v1',
    OPENAI_EMBEDDING_DIMENSIONS: '3',
    OPENAI_EMBEDDING_MAX_RETRIES: '0',
    OPENAI_EMBEDDING_TIMEOUT_MS: '2000',
    KODEX_LOCAL_LLM_API_KEY: '',
    AUTH_COOKIE_SECRET: randomBytes(32).toString('base64url'),
    KODEX_ACCEPTANCE_EMBEDDING_LOG: embeddingLog,
    KODEX_DESKTOP_ACCEPTANCE_NODE_OPTIONS: `--import=${embeddingHook}`,
    KODEX_DESKTOP_ACCEPTANCE_ARTIFACT_DIR: artifactDirectory,
    KODEX_DESKTOP_ACCEPTANCE_BASE_URL: fixture.baseUrl,
    KODEX_DESKTOP_ACCEPTANCE_DISPLAY_NAME: 'Repository RAG Acceptance User',
    KODEX_DESKTOP_ACCEPTANCE_EMAIL: primaryEmail,
    KODEX_DESKTOP_ACCEPTANCE_PASSWORD: 'repository rag acceptance password',
    KODEX_DESKTOP_ACCEPTANCE_FOREIGN_EMAIL: foreignEmail,
    KODEX_DESKTOP_ACCEPTANCE_FOREIGN_PASSWORD: 'foreign repository rag password',
    KODEX_DESKTOP_ACCEPTANCE_REPOSITORY_ROOT: fixtureRepository,
    KODEX_DESKTOP_ACCEPTANCE_SOURCE_FILE: sourceFile,
    KODEX_DESKTOP_ACCEPTANCE_UPDATED_CONTENT: UPDATED_CONTENT,
    KODEX_DESKTOP_ACCEPTANCE_USER_DATA: userDataDirectory,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const buildEnv = { ...env };
  for (const key of Object.keys(buildEnv)) {
    if (key.startsWith('KODEX_DESKTOP_ACCEPTANCE_') || key === 'KODEX_ACCEPTANCE_EMBEDDING_LOG') {
      delete buildEnv[key];
    }
  }

  await run(process.execPath, [npmCli, 'run', 'build'], { cwd: repositoryRoot, env: buildEnv }, 300_000, 'Product build');
  await run(
    electronBinary,
    [path.join(repositoryRoot, 'apps', 'desktop', 'main.mjs'), '--repository-rag-acceptance'],
    { cwd: repositoryRoot, env },
    300_000,
    'Desktop repository RAG acceptance',
  );

  if (!fixture.sawRepositoryContext()) throw new Error('The model fixture did not receive repository RAG context.');
  const modelRequests = JSON.stringify(fixture.requests);
  const embeddingInputs = await readFile(embeddingLog, 'utf8');
  for (const forbidden of [IGNORED_SECRET, ENV_SECRET, SSH_SECRET]) {
    if (modelRequests.includes(forbidden) || embeddingInputs.includes(forbidden)) {
      throw new Error(`Excluded repository content reached a model fixture: ${forbidden}`);
    }
  }
  if (fixture.requests.some((request) => request.headers.authorization !== undefined)) {
    throw new Error('The keyless repository Responses fixture received an unexpected Authorization header.');
  }
  await verifyFinalDatabase(postgres.databaseUrl, primaryEmail);
  process.stdout.write('Desktop repository RAG acceptance passed: renderer consent -> Local HTTP -> Product API/KnowledgeService -> PostgreSQL/pgvector -> safe citation/update/delete/isolation.\n');
} catch (error) {
  const artifactDirectory = temporaryRoot ? path.join(temporaryRoot, 'failure-artifacts') : undefined;
  if (artifactDirectory && existsSync(artifactDirectory)) {
    const retainedArtifacts = path.join(os.tmpdir(), `kodex-desktop-repository-rag-failure-${randomUUID()}`);
    try {
      await rename(artifactDirectory, retainedArtifacts);
      process.stderr.write(`Desktop repository RAG artifacts retained under ${retainedArtifacts}.\n`);
    } catch {
      process.stderr.write('Desktop repository RAG artifacts could not be retained safely; runtime data will still be removed.\n');
    }
  }
  throw error;
} finally {
  await cleanup();
}
