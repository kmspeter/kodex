import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { ServerNotification } from '@kodex/codex-protocol';
import { PRODUCT_SESSION_COOKIE_NAME, PRODUCT_WORKSPACE_HEADER_NAME } from '@kodex/product-contract';
import { expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { AppServerClient } from '../../apps/local-server/src/process/app-server-client';
import { startResponsesLoopbackFixture, type ResponsesLoopbackFixture } from '../fixtures/responses-loopback';

type UnknownRecord = Record<string, unknown>;

interface AuthSession {
  cookie: string;
  csrfToken: string;
  sessionToken: string;
  userId: string;
  workspaceId: string;
}

interface ManagedProcess {
  child: ChildProcess;
  name: string;
}

interface SocketClient {
  messages: UnknownRecord[];
  rpc(method: string, params: UnknownRecord): Promise<unknown>;
  socket: WebSocket;
}

interface HistoryDetail {
  items: Array<{ itemType: string; payload: { content: string }; role: string | null; status: string; turnId: string }>;
  thread: { threadId: string };
  toolCalls: Array<{ result: { content: string } | null; status: string; toolName: string; turnId: string }>;
  turns: Array<{ status: string; turnId: string }>;
}

interface ProductWorkspaceSummary {
  id: string;
  name: string;
}

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');
const productMain = path.join(repositoryRoot, 'apps', 'api', 'dist', 'main.js');
const localMain = path.join(repositoryRoot, 'apps', 'local-server', 'dist', 'main.js');
const codexBinary = path.join(repositoryRoot, 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex');
const password = 'correct horse battery staple';

function record(value: unknown, phase: string): UnknownRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${phase} returned a non-object response.`);
  }
  return value as UnknownRecord;
}

async function reservePort(): Promise<number> {
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

function startProcess(name: string, entrypoint: string, env: NodeJS.ProcessEnv): ManagedProcess {
  if (!existsSync(entrypoint)) throw new Error(`${name} build output is missing at ${entrypoint}.`);
  const child = spawn(process.execPath, [entrypoint], {
    cwd: repositoryRoot,
    env,
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child.stdout?.resume();
  child.stderr?.resume();
  child.on('error', () => undefined);
  return { child, name };
}

async function stopProcess(processRecord: ManagedProcess | undefined): Promise<void> {
  const child = processRecord?.child;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (child.connected) {
    try { child.send({ type: 'kodex-shutdown' }); } catch { /* fall back to process termination */ }
  }
  await Promise.race([
    new Promise<void>((resolve) => child.once('exit', () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise<void>((resolve) => child.once('exit', () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32' && child.pid) {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
      stdio: 'ignore', shell: false, windowsHide: true,
    });
    await new Promise<void>((resolve) => {
      killer.once('error', () => resolve());
      killer.once('exit', () => resolve());
    });
  } else child.kill('SIGKILL');
}

async function waitForHttp(
  processRecord: ManagedProcess,
  url: string,
  phase: string,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (processRecord.child.exitCode !== null || processRecord.child.signalCode !== null) {
      throw new Error(`${phase} failed because ${processRecord.name} exited before becoming ready.`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch { /* retry until the bounded deadline */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${phase} timed out after ${timeoutMs} ms.`);
}

function setCookies(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  return headers.getSetCookie?.() ?? [response.headers.get('set-cookie') ?? ''].filter(Boolean);
}

function authSession(response: Response, body: UnknownRecord, phase: string): AuthSession {
  const pairs = setCookies(response).map((entry) => entry.split(';', 1)[0]);
  const cookies = new Map(pairs.map((pair) => {
    const separator = pair.indexOf('=');
    return [pair.slice(0, separator), decodeURIComponent(pair.slice(separator + 1))];
  }));
  const sessionToken = cookies.get(PRODUCT_SESSION_COOKIE_NAME);
  const csrfToken = typeof body.csrfToken === 'string' ? body.csrfToken : undefined;
  const user = record(body.user, phase);
  const memberships = Array.isArray(body.workspaces) ? body.workspaces : [];
  const workspace = record(
    body.defaultWorkspace ?? memberships.find((entry) => {
      const membership = entry && typeof entry === 'object' && !Array.isArray(entry)
        ? entry as UnknownRecord
        : undefined;
      return ['owner', 'admin', 'member'].includes(String(membership?.role));
    }),
    phase,
  );
  if (!sessionToken || !csrfToken || typeof user.id !== 'string' || typeof workspace.id !== 'string') {
    throw new Error(`${phase} did not return the complete cookie, CSRF, user, and workspace contract.`);
  }
  return {
    cookie: pairs.join('; '),
    csrfToken,
    sessionToken,
    userId: user.id,
    workspaceId: workspace.id,
  };
}

async function postAuth(
  productBaseUrl: string,
  origin: string,
  route: 'login' | 'register',
  input: UnknownRecord,
): Promise<AuthSession> {
  const response = await fetch(`${productBaseUrl}/api/auth/${route}`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = record(await response.json(), `Product ${route}`);
  expect(response.status, `Product ${route} status`).toBe(route === 'register' ? 201 : 200);
  return authSession(response, body, `Product ${route}`);
}

async function logout(productBaseUrl: string, origin: string, session: AuthSession): Promise<Response> {
  return fetch(`${productBaseUrl}/api/auth/logout`, {
    method: 'POST',
    headers: {
      Origin: origin,
      Cookie: session.cookie,
      'X-CSRF-Token': session.csrfToken,
      'Content-Type': 'application/json',
    },
    body: '{}',
  });
}

async function createProductWorkspace(
  productBaseUrl: string,
  origin: string,
  session: AuthSession,
  name: string,
): Promise<ProductWorkspaceSummary> {
  const response = await fetch(`${productBaseUrl}/api/workspaces`, {
    method: 'POST',
    headers: {
      Origin: origin,
      Cookie: session.cookie,
      'X-CSRF-Token': session.csrfToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name }),
  });
  expect(response.status, 'Product workspace create status').toBe(201);
  const body = record(await response.json(), 'Product workspace create');
  if (typeof body.id !== 'string' || typeof body.name !== 'string') {
    throw new Error('Product workspace create did not return its ID and name.');
  }
  return { id: body.id, name: body.name };
}

async function archiveProductWorkspace(
  productBaseUrl: string,
  origin: string,
  session: AuthSession,
  workspaceId: string,
  confirmationName: string,
): Promise<Response> {
  return fetch(`${productBaseUrl}/api/workspaces/${workspaceId}`, {
    method: 'DELETE',
    headers: {
      Origin: origin,
      Cookie: session.cookie,
      'X-CSRF-Token': session.csrfToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ confirmationName }),
  });
}

async function productWorkspaces(
  productBaseUrl: string,
  session: AuthSession,
  phase: string,
): Promise<{ response: Response; workspaces: ProductWorkspaceSummary[] }> {
  const response = await fetch(`${productBaseUrl}/api/auth/me`, { headers: { Cookie: session.cookie } });
  const body = record(await response.json(), phase);
  if (!Array.isArray(body.workspaces)) throw new Error(`${phase} did not return a workspace list.`);
  const workspaces = body.workspaces.map((entry) => {
    const workspace = record(entry, `${phase} workspace`);
    if (typeof workspace.id !== 'string' || typeof workspace.name !== 'string') {
      throw new Error(`${phase} returned a workspace without its ID and name.`);
    }
    return { id: workspace.id, name: workspace.name };
  });
  return { response, workspaces };
}

async function bootstrapLocal(
  localBaseUrl: string,
  origin: string,
  session: AuthSession,
  workspaceId = session.workspaceId,
): Promise<{ body: UnknownRecord; response: Response }> {
  const response = await fetch(`${localBaseUrl}/api/bootstrap`, {
    headers: {
      Origin: origin,
      Cookie: session.cookie,
      [PRODUCT_WORKSPACE_HEADER_NAME]: workspaceId,
      'X-Kodex-Bootstrap': '1',
    },
  });
  const body = record(await response.json(), 'Local bootstrap');
  return { body, response };
}

function waitForSocketMessage(
  messages: UnknownRecord[],
  predicate: (message: UnknownRecord) => boolean,
  phase: string,
  timeoutMs = 20_000,
): Promise<UnknownRecord> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const inspect = () => {
      const found = messages.find(predicate);
      if (found) { resolve(found); return; }
      if (Date.now() >= deadline) { reject(new Error(`${phase} timed out after ${timeoutMs} ms.`)); return; }
      setTimeout(inspect, 20);
    };
    inspect();
  });
}

async function connectSocket(
  localPort: number,
  origin: string,
  session: AuthSession,
  localSessionToken: string,
  workspaceId = session.workspaceId,
): Promise<SocketClient> {
  const socket = new WebSocket(
    `ws://127.0.0.1:${localPort}/ws?workspace_id=${workspaceId}`,
    ['kodex', localSessionToken],
    { origin, headers: { Cookie: session.cookie } },
  );
  const messages: UnknownRecord[] = [];
  socket.on('message', (raw) => messages.push(record(JSON.parse(raw.toString()) as unknown, 'Local WebSocket')));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Local WebSocket open timed out after 20 seconds.')), 20_000);
    socket.once('open', () => { clearTimeout(timer); resolve(); });
    socket.once('error', (error) => { clearTimeout(timer); reject(error); });
  });
  const hello = await waitForSocketMessage(messages, (message) => message.type === 'hello', 'Local WebSocket hello');
  socket.send(JSON.stringify({
    type: 'replay',
    epoch: hello.epoch,
    afterSequence: hello.latestSequence,
  }));
  let requestSequence = 0;
  return {
    messages,
    socket,
    rpc: async (method, params) => {
      requestSequence += 1;
      const requestId = `acceptance-${requestSequence}`;
      socket.send(JSON.stringify({
        type: 'rpc',
        requestId,
        request: { id: requestSequence, method, params },
      }));
      const response = await waitForSocketMessage(
        messages,
        (message) => (message.type === 'rpc-result' || message.type === 'rpc-error')
          && message.requestId === requestId,
        `Local WebSocket ${method}`,
        30_000,
      );
      if (response.type === 'rpc-error') {
        const publicMessage = typeof response.message === 'string'
          ? response.message.slice(0, 500)
          : 'No public error message was returned.';
        throw new Error(`Local WebSocket ${method} returned an RPC error: ${publicMessage}`);
      }
      return response.result;
    },
  };
}

async function expectSocketRejected(
  localPort: number,
  origin: string,
  session: AuthSession,
  localSessionToken: string,
  workspaceId: string,
  expectedStatus: number,
): Promise<void> {
  const socket = new WebSocket(
    `ws://127.0.0.1:${localPort}/ws?workspace_id=${workspaceId}`,
    ['kodex', localSessionToken],
    { origin, headers: { Cookie: session.cookie } },
  );
  socket.on('error', () => undefined);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error(`Rejected Local WebSocket did not respond within 10 seconds (expected HTTP ${expectedStatus}).`));
    }, 10_000);
    socket.once('open', () => {
      clearTimeout(timer);
      socket.close();
      reject(new Error(`Local WebSocket unexpectedly opened (expected HTTP ${expectedStatus}).`));
    });
    socket.once('unexpected-response', (_request, response) => {
      clearTimeout(timer);
      response.destroy();
      if (response.statusCode === expectedStatus) resolve();
      else reject(new Error(`Local WebSocket returned HTTP ${response.statusCode}; expected ${expectedStatus}.`));
    });
  });
}

function waitForSocketCloseCode(
  socket: WebSocket,
  phase: string,
  timeoutMs = 10_000,
): Promise<number> {
  return new Promise((resolve, reject) => {
    function onClose(code: number) {
      clearTimeout(timer);
      socket.off('close', onClose);
      resolve(code);
    }
    const timer = setTimeout(() => {
      socket.off('close', onClose);
      reject(new Error(`${phase} did not close within ${timeoutMs} ms.`));
    }, timeoutMs);
    socket.once('close', onClose);
  });
}

async function closeSocket(socket: WebSocket | undefined): Promise<void> {
  if (!socket || socket.readyState === WebSocket.CLOSED) return;
  const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
  socket.close();
  await Promise.race([closed, new Promise<void>((resolve) => setTimeout(resolve, 1_000))]);
  if (Number(socket.readyState) !== WebSocket.CLOSED) socket.terminate();
}

async function historyGet(
  productBaseUrl: string,
  session: AuthSession,
  route: string,
  workspaceId = session.workspaceId,
): Promise<Response> {
  return fetch(`${productBaseUrl}${route}${route.includes('?') ? '&' : '?'}workspace_id=${workspaceId}`, {
    headers: { Cookie: session.cookie, [PRODUCT_WORKSPACE_HEADER_NAME]: workspaceId },
  });
}

async function pollForHistory(
  productBaseUrl: string,
  session: AuthSession,
  threadId: string,
  turnId: string,
  outboxDirectory: string,
): Promise<HistoryDetail> {
  const deadline = Date.now() + 20_000;
  let lastObservation = 'history detail was not available';
  while (Date.now() < deadline) {
    const response = await historyGet(
      productBaseUrl,
      session,
      `/api/history/threads/${encodeURIComponent(threadId)}?limit=50`,
    );
    if (response.status === 200) {
      const detail = await response.json() as HistoryDetail;
      lastObservation = JSON.stringify({
        threadMatched: detail.thread.threadId === threadId,
        turns: detail.turns.map((entry) => ({ matched: entry.turnId === turnId, status: entry.status })),
        items: detail.items.map((entry) => ({
          matched: entry.turnId === turnId,
          itemType: entry.itemType,
          role: entry.role,
          status: entry.status,
        })),
        toolCalls: detail.toolCalls.map((entry) => ({
          matched: entry.turnId === turnId,
          toolName: entry.toolName,
          status: entry.status,
          hasResult: entry.result !== null,
        })),
      });
      const assistant = detail.items.find(
        (item) => item.turnId === turnId && item.role === 'assistant' && item.status === 'completed'
          && item.payload.content.includes('local stream ok'),
      );
      const tool = detail.toolCalls.find(
        (call) => call.turnId === turnId && call.toolName === 'shell' && call.status === 'completed'
          && call.result?.content.includes('kodex-loopback-tool'),
      );
      if (
        detail.thread.threadId === threadId
        && detail.turns.some((turn) => turn.turnId === turnId && turn.status === 'completed')
        && assistant
        && tool
      ) return detail;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  let pendingObservation = 'outbox unavailable';
  try {
    const filenames = (await readdir(outboxDirectory)).filter((entry) => entry.endsWith('.json')).sort().slice(0, 20);
    const pending = [];
    for (const filename of filenames) {
      const event = record(JSON.parse(await readFile(path.join(outboxDirectory, filename), 'utf8')) as unknown, 'history outbox diagnostic');
      const item = event.item && typeof event.item === 'object' && !Array.isArray(event.item)
        ? event.item as UnknownRecord
        : undefined;
      const toolCall = event.toolCall && typeof event.toolCall === 'object' && !Array.isArray(event.toolCall)
        ? event.toolCall as UnknownRecord
        : undefined;
      const eventThread = event.thread && typeof event.thread === 'object' && !Array.isArray(event.thread)
        ? event.thread as UnknownRecord
        : undefined;
      const eventTurn = event.turn && typeof event.turn === 'object' && !Array.isArray(event.turn)
        ? event.turn as UnknownRecord
        : undefined;
      pending.push({
        eventType: event.eventType,
        threadIdLength: typeof eventThread?.codexThreadId === 'string' ? eventThread.codexThreadId.length : null,
        turnIdLength: typeof eventTurn?.codexTurnId === 'string' ? eventTurn.codexTurnId.length : null,
        turnSortKeyLength: typeof eventTurn?.sourceSortKey === 'string' ? eventTurn.sourceSortKey.length : null,
        itemIdLength: typeof item?.codexItemId === 'string' ? item.codexItemId.length : null,
        itemSortKeyLength: typeof item?.sourceSortKey === 'string' ? item.sourceSortKey.length : null,
        itemType: item?.itemType,
        itemStatus: item?.status,
        toolName: toolCall?.toolName,
        toolStatus: toolCall?.status,
      });
    }
    pendingObservation = JSON.stringify(pending);
  } catch { /* keep the structural API observation */ }
  throw new Error(`PostgreSQL Saved DB History projection did not contain the thread, completed turn, assistant item, and tool result within 20 seconds. Last structural state: ${lastObservation}. Pending structural outbox state: ${pendingObservation}`);
}

async function createPreexistingTenantThread(
  codexHome: string,
  fixture: ResponsesLoopbackFixture,
): Promise<{ threadId: string; turnId: string }> {
  const notifications: ServerNotification[] = [];
  const client = new AppServerClient({
    repositoryRoot,
    codexHome,
    apiKey: undefined,
    binary: { command: codexBinary, source: 'local' },
    provider: { mode: 'local', baseUrl: fixture.baseUrl, model: 'kodex-loopback-model' },
    extraArgs: ['-c', 'web_search="disabled"', '-c', 'analytics.enabled=false'],
    log: async () => undefined,
  });
  client.on('notification', (notification: ServerNotification) => notifications.push(notification));
  try {
    await client.start();
    const started = await client.request('thread/start', {
      model: 'kodex-loopback-model',
      modelProvider: 'kodex_local',
      cwd: repositoryRoot,
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      sandbox: 'danger-full-access',
      config: { web_search: 'disabled' },
      ephemeral: false,
      serviceName: 'Kodex',
    });
    const turn = await client.request('turn/start', {
      threadId: started.thread.id,
      input: [{ type: 'text', text: 'Run the provided local echo tool, then answer.', text_elements: [] }],
      cwd: repositoryRoot,
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      sandboxPolicy: { type: 'dangerFullAccess' },
      model: 'kodex-loopback-model',
    });
    const deadline = Date.now() + 30_000;
    while (
      Date.now() < deadline
      && !notifications.some((notification) => notification.method === 'turn/completed'
        && notification.params.turn.id === turn.turn.id
        && notification.params.turn.status === 'completed')
    ) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(notifications.some((notification) => notification.method === 'turn/completed'
      && notification.params.turn.id === turn.turn.id
      && notification.params.turn.status === 'completed')).toBe(true);
    return { threadId: started.thread.id, turnId: turn.turn.id };
  } finally {
    await client.stop();
  }
}

it('accepts auth -> built services/codex.exe -> PostgreSQL history -> isolation -> workspace archive -> logout over HTTP/WS', async () => {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error('DATABASE_URL is required. Use npm run test:full-stack.');
  if (!existsSync(codexBinary)) throw new Error(`Repository Codex binary is missing at ${codexBinary}.`);

  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'kodex-full-stack-'));
  const productPort = await reservePort();
  const localPort = await reservePort();
  const productBaseUrl = `http://127.0.0.1:${productPort}`;
  const localBaseUrl = `http://127.0.0.1:${localPort}`;
  const origin = localBaseUrl;
  const commonEnv: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    PRODUCT_DB_SSL: 'disable',
    KODEX_DISABLE_ENV_FILE: '1',
    KODEX_CODEX_BIN: codexBinary,
    KODEX_RAG_ENABLED: 'false',
    KODEX_RAG_AUTOMATIONS_ENABLED: 'false',
    OPENAI_API_KEY: '',
    KODEX_LOCAL_LLM_API_KEY: '',
  };
  let productProcess: ManagedProcess | undefined;
  let localProcess: ManagedProcess | undefined;
  let loopback: ResponsesLoopbackFixture | undefined;
  let socketAOriginal: SocketClient | undefined;
  let socketAFallback: SocketClient | undefined;
  let socketBPersonal: SocketClient | undefined;
  let socketBShared: SocketClient | undefined;
  try {
    productProcess = startProcess('Product API', productMain, {
      ...commonEnv,
      PRODUCT_API_NODE_ENV: 'test',
      PRODUCT_API_HOST: '127.0.0.1',
      PRODUCT_API_PORT: String(productPort),
      PRODUCT_API_ALLOWED_HOSTS: `127.0.0.1:${productPort}`,
      AUTH_ALLOWED_ORIGINS: origin,
      AUTH_COOKIE_SECRET: randomBytes(32).toString('base64url'),
      AUTH_COOKIE_SECURE: 'false',
    });
    await waitForHttp(productProcess, `${productBaseUrl}/api/health/ready`, 'Product API readiness');

    localProcess = startProcess('Local Server', localMain, {
      ...commonEnv,
      PRODUCT_API_PORT: String(productPort),
      KODEX_SERVER_PORT: String(localPort),
      KODEX_PRODUCT_API_ORIGINS: productBaseUrl,
      KODEX_UI_ORIGINS: origin,
      KODEX_DATA_ROOT: path.join(temporaryRoot, 'data'),
      KODEX_TENANT_ROOT: path.join(temporaryRoot, 'data', 'tenants'),
      KODEX_AUTH_REVALIDATE_MS: '100',
      KODEX_HISTORY_RETRY_INITIAL_MS: '25',
      KODEX_HISTORY_RETRY_MAX_MS: '250',
      KODEX_HISTORY_RECONCILIATION_INTERVAL_MS: '60000',
      KODEX_HISTORY_RECONCILIATION_RETRY_INITIAL_MS: '50',
      KODEX_HISTORY_RECONCILIATION_RETRY_MAX_MS: '250',
    });
    await waitForHttp(localProcess, `${localBaseUrl}/api/health`, 'Local Server readiness');
    loopback = await startResponsesLoopbackFixture();

    const emailA = `full-stack-a-${randomUUID()}@example.invalid`;
    const registeredA = await postAuth(productBaseUrl, origin, 'register', {
      email: emailA, password, displayName: 'Acceptance User A',
    });
    expect((await fetch(`${productBaseUrl}/api/auth/me`, { headers: { Cookie: registeredA.cookie } })).status).toBe(200);
    expect((await logout(productBaseUrl, origin, registeredA)).status).toBe(204);
    expect((await fetch(`${productBaseUrl}/api/auth/me`, { headers: { Cookie: registeredA.cookie } })).status).toBe(401);

    const sessionA = await postAuth(productBaseUrl, origin, 'login', { email: emailA, password });
    expect(sessionA.userId).toBe(registeredA.userId);
    expect(sessionA.workspaceId).toBe(registeredA.workspaceId);
    const userADataRoot = path.join(
      temporaryRoot,
      'data',
      'tenants',
      'users',
      sessionA.userId,
      'workspaces',
      sessionA.workspaceId,
    );
    const preexisting = await createPreexistingTenantThread(
      path.join(userADataRoot, 'codex-home'),
      loopback,
    );
    await loopback.close();
    loopback = await startResponsesLoopbackFixture();
    expect((await historyGet(
      productBaseUrl,
      sessionA,
      `/api/history/threads/${encodeURIComponent(preexisting.threadId)}?limit=50`,
    )).status).toBe(404);
    const bootstrapA = await bootstrapLocal(localBaseUrl, origin, sessionA);
    expect(bootstrapA.response.status).toBe(200);
    const localSessionToken = bootstrapA.body.sessionToken;
    const localCsrfToken = bootstrapA.body.csrfToken;
    if (typeof localSessionToken !== 'string' || typeof localCsrfToken !== 'string') {
      throw new Error('Local bootstrap did not return its session and CSRF proof.');
    }
    const settingsResponse = await fetch(`${localBaseUrl}/api/settings`, {
      method: 'PUT',
      headers: {
        Origin: origin,
        Cookie: sessionA.cookie,
        [PRODUCT_WORKSPACE_HEADER_NAME]: sessionA.workspaceId,
        'X-Kodex-Session': localSessionToken,
        'X-Kodex-CSRF': localCsrfToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        approvalPolicy: 'never',
        sandbox: 'danger-full-access',
        network: { shell: false, webSearch: false },
        provider: { mode: 'local', baseUrl: loopback.baseUrl, model: 'kodex-loopback-model' },
      }),
    });
    expect(settingsResponse.status, 'Authenticated Local Server provider settings update').toBe(200);
    expect(await settingsResponse.json()).toMatchObject({
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      network: { shell: false, webSearch: false },
      provider: { mode: 'local', baseUrl: loopback.baseUrl, model: 'kodex-loopback-model' },
    });

    const userAOutbox = path.join(userADataRoot, 'product-history-outbox');
    await pollForHistory(
      productBaseUrl,
      sessionA,
      preexisting.threadId,
      preexisting.turnId,
      userAOutbox,
    );

    socketAOriginal = await connectSocket(localPort, origin, sessionA, localSessionToken);
    const threadResult = record(await socketAOriginal.rpc('thread/start', {}), 'thread/start');
    const thread = record(threadResult.thread, 'thread/start');
    if (typeof thread.id !== 'string') throw new Error('thread/start did not return a thread ID.');
    const turnResult = record(await socketAOriginal.rpc('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: 'Run the provided local echo tool, then answer.', text_elements: [] }],
    }), 'turn/start');
    const turn = record(turnResult.turn, 'turn/start');
    if (typeof turn.id !== 'string') throw new Error('turn/start did not return a turn ID.');
    await waitForSocketMessage(
      socketAOriginal.messages,
      (message) => {
        if (message.type !== 'notification') return false;
        const notification = record(message.notification, 'turn completion notification');
        if (notification.method !== 'turn/completed') return false;
        const params = record(notification.params, 'turn completion notification');
        const completedTurn = record(params.turn, 'turn completion notification');
        return completedTurn.id === turn.id && completedTurn.status === 'completed';
      },
      'Official turn/completed notification',
      30_000,
    );
    expect(loopback.requests.length).toBeGreaterThanOrEqual(2);
    expect(loopback.requests.every((request) => request.url === '/v1/responses')).toBe(true);
    expect(loopback.requests.every((request) => !request.headers.authorization)).toBe(true);
    expect(loopback.sawToolOutput()).toBe(true);
    expect(loopback.toolOutputContainsExpectedText()).toBe(true);
    expect(loopback.toolOutputSucceeded()).toBe(true);
    const liveItemLifecycles = socketAOriginal.messages.flatMap((message) => {
      if (message.type !== 'notification') return [];
      const notification = record(message.notification, 'live item lifecycle diagnostic');
      if (notification.method !== 'item/started' && notification.method !== 'item/completed') return [];
      const params = record(notification.params, 'live item lifecycle diagnostic');
      const item = record(params.item, 'live item lifecycle diagnostic');
      return [{ method: notification.method, itemType: item.type }];
    });
    expect(liveItemLifecycles).toEqual(expect.arrayContaining([
      { method: 'item/completed', itemType: 'agentMessage' },
      { method: 'item/completed', itemType: 'commandExecution' },
    ]));

    const listA = await historyGet(productBaseUrl, sessionA, '/api/history/threads?limit=50');
    expect(listA.status).toBe(200);
    await pollForHistory(productBaseUrl, sessionA, thread.id, turn.id, userAOutbox);

    const emailB = `full-stack-b-${randomUUID()}@example.invalid`;
    const sessionB = await postAuth(productBaseUrl, origin, 'register', {
      email: emailB,
      password,
      displayName: 'Acceptance User B',
    });
    const bootstrapB = await bootstrapLocal(localBaseUrl, origin, sessionB);
    expect(bootstrapB.response.status).toBe(200);
    const localSessionB = bootstrapB.body.sessionToken;
    if (typeof localSessionB !== 'string') throw new Error('User B Local bootstrap did not return a session proof.');
    socketBPersonal = await connectSocket(localPort, origin, sessionB, localSessionB);

    const deniedBeforeInvitation = await bootstrapLocal(localBaseUrl, origin, sessionB, sessionA.workspaceId);
    expect(deniedBeforeInvitation.response.status).toBe(403);
    await expectSocketRejected(localPort, origin, sessionB, localSessionB, sessionA.workspaceId, 403);
    const invitationResponse = await fetch(`${productBaseUrl}/api/workspaces/${sessionA.workspaceId}/invitations`, {
      method: 'POST',
      headers: {
        Origin: origin, Cookie: sessionA.cookie, 'X-CSRF-Token': sessionA.csrfToken, 'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email: emailB, role: 'member' }),
    });
    expect(invitationResponse.status).toBe(201);
    const invitationBody = record(await invitationResponse.json(), 'Product invitation create');
    if (typeof invitationBody.token !== 'string') throw new Error('Product invitation did not return its one-time token.');
    const acceptedInvitation = await fetch(`${productBaseUrl}/api/invitations/accept`, {
      method: 'POST',
      headers: {
        Origin: origin, Cookie: sessionB.cookie, 'X-CSRF-Token': sessionB.csrfToken, 'Content-Type': 'application/json',
      },
      body: JSON.stringify({ token: invitationBody.token }),
    });
    expect(acceptedInvitation.status).toBe(200);
    const meB = record(await (await fetch(`${productBaseUrl}/api/auth/me`, { headers: { Cookie: sessionB.cookie } })).json(), 'User B /me after invitation');
    expect(Array.isArray(meB.workspaces) && meB.workspaces.some((entry) => record(entry, 'User B workspace').id === sessionA.workspaceId)).toBe(true);
    const sharedBootstrapB = await bootstrapLocal(localBaseUrl, origin, sessionB, sessionA.workspaceId);
    expect(sharedBootstrapB.response.status).toBe(200);
    if (typeof sharedBootstrapB.body.sessionToken !== 'string') throw new Error('Invited user Local bootstrap did not return a session proof.');
    socketBShared = await connectSocket(localPort, origin, sessionB, sharedBootstrapB.body.sessionToken, sessionA.workspaceId);

    const tenantRoot = path.join(temporaryRoot, 'data', 'tenants', 'users');
    const userARoot = path.join(tenantRoot, sessionA.userId, 'workspaces', sessionA.workspaceId);
    const userBRoot = path.join(tenantRoot, sessionB.userId, 'workspaces', sessionB.workspaceId);
    const userBSharedRoot = path.join(tenantRoot, sessionB.userId, 'workspaces', sessionA.workspaceId);
    expect(path.resolve(userARoot)).not.toBe(path.resolve(userBRoot));
    expect((await stat(userARoot)).isDirectory()).toBe(true);
    expect((await stat(userBRoot)).isDirectory()).toBe(true);
    expect((await stat(userBSharedRoot)).isDirectory()).toBe(true);

    const bList = await historyGet(productBaseUrl, sessionB, '/api/history/threads?limit=50', sessionA.workspaceId);
    expect(bList.status).toBe(200);
    expect(await bList.json()).toMatchObject({ threads: [] });
    expect((await historyGet(
      productBaseUrl,
      sessionB,
      `/api/history/threads/${encodeURIComponent(thread.id)}?limit=50`,
      sessionA.workspaceId,
    )).status).toBe(404);

    const fallbackWorkspaceA = await createProductWorkspace(
      productBaseUrl,
      origin,
      sessionA,
      `Acceptance Fallback ${randomUUID().slice(0, 8)}`,
    );
    const fallbackBootstrapA = await bootstrapLocal(localBaseUrl, origin, sessionA, fallbackWorkspaceA.id);
    expect(fallbackBootstrapA.response.status).toBe(200);
    const fallbackLocalSessionA = fallbackBootstrapA.body.sessionToken;
    if (typeof fallbackLocalSessionA !== 'string') {
      throw new Error('User A fallback Local bootstrap did not return a session proof.');
    }
    socketAFallback = await connectSocket(
      localPort,
      origin,
      sessionA,
      fallbackLocalSessionA,
      fallbackWorkspaceA.id,
    );

    const beforeArchiveA = await productWorkspaces(productBaseUrl, sessionA, 'User A /me before archive');
    expect(beforeArchiveA.response.status).toBe(200);
    const archivedWorkspace = beforeArchiveA.workspaces.find((workspace) => workspace.id === sessionA.workspaceId);
    if (!archivedWorkspace) throw new Error('User A /me did not contain the workspace selected for archive.');
    expect(socketAOriginal.socket.readyState).toBe(WebSocket.OPEN);
    expect(socketBShared.socket.readyState).toBe(WebSocket.OPEN);
    const ownerArchivedSocketClosed = waitForSocketCloseCode(
      socketAOriginal.socket,
      'Owner Local WebSocket for archived workspace',
    );
    const memberArchivedSocketClosed = waitForSocketCloseCode(
      socketBShared.socket,
      'Member Local WebSocket for archived workspace',
    );
    const archiveResponse = await archiveProductWorkspace(
      productBaseUrl,
      origin,
      sessionA,
      archivedWorkspace.id,
      archivedWorkspace.name,
    );
    expect(archiveResponse.status).toBe(204);
    await expect(Promise.all([ownerArchivedSocketClosed, memberArchivedSocketClosed])).resolves.toEqual([1008, 1008]);

    const [afterArchiveA, afterArchiveB] = await Promise.all([
      productWorkspaces(productBaseUrl, sessionA, 'User A /me after archive'),
      productWorkspaces(productBaseUrl, sessionB, 'User B /me after archive'),
    ]);
    expect([afterArchiveA.response.status, afterArchiveB.response.status]).toEqual([200, 200]);
    expect(afterArchiveA.workspaces.map((workspace) => workspace.id)).toContain(fallbackWorkspaceA.id);
    expect(afterArchiveB.workspaces.map((workspace) => workspace.id)).toContain(sessionB.workspaceId);
    expect(afterArchiveA.workspaces.map((workspace) => workspace.id)).not.toContain(archivedWorkspace.id);
    expect(afterArchiveB.workspaces.map((workspace) => workspace.id)).not.toContain(archivedWorkspace.id);

    expect((await historyGet(
      productBaseUrl,
      sessionA,
      '/api/history/threads?limit=50',
      archivedWorkspace.id,
    )).status).toBe(403);
    const [archivedBootstrapA, archivedBootstrapB] = await Promise.all([
      bootstrapLocal(localBaseUrl, origin, sessionA, archivedWorkspace.id),
      bootstrapLocal(localBaseUrl, origin, sessionB, archivedWorkspace.id),
    ]);
    expect([archivedBootstrapA.response.status, archivedBootstrapB.response.status]).toEqual([403, 403]);
    await Promise.all([
      expectSocketRejected(localPort, origin, sessionA, localSessionToken, archivedWorkspace.id, 403),
      expectSocketRejected(localPort, origin, sessionB, localSessionB, archivedWorkspace.id, 403),
    ]);
    expect(socketAFallback.socket.readyState).toBe(WebSocket.OPEN);
    expect(socketBPersonal.socket.readyState).toBe(WebSocket.OPEN);

    const fallbackSocketClosedAfterLogout = waitForSocketCloseCode(
      socketAFallback.socket,
      'Existing fallback Local WebSocket after logout',
    );
    expect((await logout(productBaseUrl, origin, sessionA)).status).toBe(204);
    expect((await fetch(`${productBaseUrl}/api/auth/me`, { headers: { Cookie: sessionA.cookie } })).status).toBe(401);
    expect((await historyGet(
      productBaseUrl,
      sessionA,
      '/api/history/threads?limit=50',
      fallbackWorkspaceA.id,
    )).status).toBe(401);
    expect((await bootstrapLocal(localBaseUrl, origin, sessionA, fallbackWorkspaceA.id)).response.status).toBe(401);
    await expectSocketRejected(
      localPort,
      origin,
      sessionA,
      fallbackLocalSessionA,
      fallbackWorkspaceA.id,
      401,
    );
    await expect(fallbackSocketClosedAfterLogout).resolves.toBe(1008);
  } finally {
    await closeSocket(socketAOriginal?.socket);
    await closeSocket(socketAFallback?.socket);
    await closeSocket(socketBPersonal?.socket);
    await closeSocket(socketBShared?.socket);
    await loopback?.close();
    await stopProcess(localProcess);
    await stopProcess(productProcess);
    await rm(temporaryRoot, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
}, 120_000);
