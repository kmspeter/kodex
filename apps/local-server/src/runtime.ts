import { randomUUID } from 'node:crypto';
import type {
  ClientRequest, JsonValue, RequestId, SandboxPolicy, ServerNotification, ServerRequest,
  ThreadForkParams, ThreadListParams, ThreadResumeParams, ThreadStartParams, TurnStartParams,
} from '@kodex/codex-protocol';
import type { BootstrapResponse, EngineStatus, KodexSettings, ProjectRecord } from '@kodex/kodex-api';
import { SequenceBuffer, sanitizeUnknown } from '@kodex/shared';
import { validateServerRequestResult } from './api/validation.js';
import { AppServerClient, type AppServerClientOptions } from './process/app-server-client.js';
import { ProjectStore } from './projects/project-store.js';
import { LocalStore } from './storage/local-store.js';
import type { TurnRagAugmenter } from './rag/augmenter.js';

export type ServerRequestResolution = 'answered' | 'timeout' | 'disconnect' | 'app-server-restart' | 'unsupported';

export type RuntimeEvent =
  | { type: 'notification'; notification: ServerNotification }
  | { type: 'server-request'; request: ServerRequest; ownerId: string }
  | {
    type: 'server-request-resolved';
    requestId: RequestId;
    reason: ServerRequestResolution;
    request?: ServerRequest;
    response?: unknown;
  }
  | { type: 'engine'; engine: EngineStatus };

type RuntimeListener = (sequence: number, event: RuntimeEvent) => void;

interface PendingServerRequest {
  request: ServerRequest;
  ownerId: string;
  timer: NodeJS.Timeout;
}

interface AutomationRun {
  automationId: string;
  claimId: string;
  threadId: string;
  turnId: string;
}

export const ALLOWED_METHODS = new Set<string>([
  'thread/start', 'thread/list', 'thread/read', 'thread/resume', 'thread/fork',
  'thread/archive', 'thread/unarchive', 'thread/name/set',
  'turn/start', 'turn/steer', 'turn/interrupt', 'model/list',
  'skills/list', 'config/read', 'config/value/write',
  'app/list', 'plugin/list', 'plugin/install', 'plugin/uninstall',
  'mcpServerStatus/list', 'mcpServer/oauth/login', 'config/mcpServer/reload',
  'experimentalFeature/list', 'experimentalFeature/enablement/set',
]);

const SUPPORTED_SERVER_REQUESTS = new Set<ServerRequest['method']>([
  'item/commandExecution/requestApproval', 'item/fileChange/requestApproval',
  'item/permissions/requestApproval', 'item/tool/requestUserInput', 'mcpServer/elicitation/request',
]);

const KNOWN_UI_NOTIFICATIONS = new Set<string>([
  'error', 'warning', 'thread/started', 'thread/status/changed', 'thread/archived', 'thread/unarchived',
  'thread/name/updated', 'thread/tokenUsage/updated', 'turn/started', 'turn/completed', 'turn/diff/updated',
  'turn/plan/updated', 'item/started', 'item/completed', 'item/agentMessage/delta', 'item/plan/delta',
  'item/reasoning/summaryTextDelta', 'item/reasoning/summaryPartAdded', 'item/reasoning/textDelta',
  'item/commandExecution/outputDelta', 'item/commandExecution/terminalInteraction',
  'item/fileChange/outputDelta', 'item/fileChange/patchUpdated', 'command/exec/outputDelta',
  'process/outputDelta', 'process/exited', 'serverRequest/resolved',
]);

export interface RpcProjectContext {
  projectId?: string;
  cwd?: string;
  rag?: boolean;
}

export interface KodexRuntimeOptions {
  dataRoot?: string;
  localApiKey?: string;
  ragAugmenter?: TurnRagAugmenter;
  ragAutomationsEnabled?: boolean;
  serverRequestTimeoutMs?: number;
  schedulerIntervalMs?: number;
  startAppServer?: boolean;
  appServerOptions?: Partial<Pick<AppServerClientOptions, 'binary' | 'spawnArgs' | 'extraArgs' | 'stableRunMs' | 'maxConsecutiveRestarts' | 'restartDelaysMs'>>;
}

function requestKey(id: RequestId): string { return `${typeof id}:${String(id)}`; }

function sandboxPolicy(settings: KodexSettings, projectPath: string): SandboxPolicy {
  if (settings.sandbox === 'danger-full-access') return { type: 'dangerFullAccess' };
  if (settings.sandbox === 'read-only') return { type: 'readOnly', networkAccess: settings.network.shell };
  return {
    type: 'workspaceWrite', writableRoots: [projectPath], networkAccess: settings.network.shell,
    excludeTmpdirEnvVar: false, excludeSlashTmp: false,
  };
}

function threadConfig(settings: KodexSettings): Record<string, JsonValue> {
  return { web_search: settings.network.webSearch ? 'live' : 'disabled' };
}

function selectedModel(settings: KodexSettings, requested: string | null | undefined): string | null {
  if (settings.provider.mode === 'local') return settings.provider.model;
  return requested ?? (settings.provider.model || null);
}

export class KodexRuntime {
  readonly store: LocalStore;
  readonly projects: ProjectStore;
  readonly appServer: AppServerClient;
  readonly events = new SequenceBuffer<RuntimeEvent>(1_000);
  readonly epoch = randomUUID();
  #listeners = new Set<RuntimeListener>();
  #scheduler: NodeJS.Timeout | null = null;
  #initializePromise: Promise<void> | null = null;
  #uiOrder: string[] = [];
  #activeUiId: string | null = null;
  #pendingServerRequests = new Map<string, PendingServerRequest>();
  #automationRuns = new Map<string, AutomationRun>();
  #automationById = new Map<string, AutomationRun>();

  constructor(readonly repositoryRoot: string, apiKey: string | undefined, readonly options: KodexRuntimeOptions = {}) {
    this.store = new LocalStore(repositoryRoot, options.dataRoot);
    this.projects = new ProjectStore(this.store, repositoryRoot);
    this.appServer = new AppServerClient({
      repositoryRoot, codexHome: this.store.codexHome, apiKey, localApiKey: options.localApiKey,
      log: (filename, line) => this.store.appendLog(filename, line),
      ...options.appServerOptions,
    });
    this.appServer.on('notification', (notification: ServerNotification) => void this.#onNotification(notification));
    this.appServer.on('server-request', (request: ServerRequest) => this.#onServerRequest(request));
    this.appServer.on('status', (engine: EngineStatus) => void this.#onEngineStatus(engine));
  }

  async initialize(): Promise<void> {
    this.#initializePromise ??= this.#initialize();
    return this.#initializePromise;
  }

  async #initialize(): Promise<void> {
    await this.store.initialize();
    await this.projects.initialize();
    await this.store.recoverInterruptedAutomations();
    const settings = await this.store.readSettings();
    this.appServer.configureProvider(settings.provider);
    if (!this.#scheduler) {
      const interval = this.options.schedulerIntervalMs ?? 30_000;
      this.#scheduler = setInterval(() => void this.runDueAutomations(), interval);
      this.#scheduler.unref?.();
      queueMicrotask(() => void this.runDueAutomations());
    }
    if (this.options.startAppServer !== false && !['missing-key', 'missing-binary'].includes(this.appServer.status().state)) {
      void this.appServer.start().catch(() => undefined);
    }
  }

  emit(event: RuntimeEvent): void {
    const entry = this.events.push(event);
    for (const listener of this.#listeners) listener(entry.sequence, event);
  }

  subscribe(listener: RuntimeListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  registerUi(clientId: string): void {
    this.#uiOrder = [...this.#uiOrder.filter((id) => id !== clientId), clientId];
    this.#activeUiId = clientId;
  }

  touchUi(clientId: string): void {
    if (!this.#uiOrder.includes(clientId)) return;
    this.#uiOrder = [...this.#uiOrder.filter((id) => id !== clientId), clientId];
    this.#activeUiId = clientId;
  }

  unregisterUi(clientId: string): void {
    this.#uiOrder = this.#uiOrder.filter((id) => id !== clientId);
    this.#activeUiId = this.#uiOrder.at(-1) ?? null;
    for (const [key, pending] of this.#pendingServerRequests) {
      if (pending.ownerId !== clientId) continue;
      clearTimeout(pending.timer);
      this.#pendingServerRequests.delete(key);
      try { this.appServer.respondError(pending.request.id, -32001, 'The approval owner disconnected. Retry the operation.'); } catch { /* App Server may already be gone */ }
      this.emit({
        type: 'server-request-resolved',
        requestId: pending.request.id,
        reason: 'disconnect',
        request: pending.request,
      });
    }
  }

  isRequestOwner(clientId: string, requestId: RequestId): boolean {
    return this.#pendingServerRequests.get(requestKey(requestId))?.ownerId === clientId;
  }

  async bootstrap(apiBaseUrl: string, csrfToken: string, sessionToken: string): Promise<BootstrapResponse> {
    await this.initialize();
    const [settings, projects, activeProject, automations] = await Promise.all([
      this.store.readSettings(), this.projects.list(), this.projects.active(), this.store.listAutomations(),
    ]);
    try { this.appServer.detectVersion(); } catch { /* status contains the actionable binary error */ }
    return {
      product: 'Kodex', csrfToken, sessionToken, apiBaseUrl, engine: this.appServer.status(), settings,
      projects, activeProject, automations,
      capabilities: { localState: true, cloudBackend: false, webSearch: true, remoteMcp: true, apps: true, plugins: true, hostDynamicTools: false },
    };
  }

  async updateSettings(patch: Partial<KodexSettings>): Promise<KodexSettings> {
    const before = await this.store.readSettings();
    const next = await this.store.writeSettings(patch);
    if (JSON.stringify(before.provider) !== JSON.stringify(next.provider)) {
      await this.appServer.stop();
      this.appServer.configureProvider(next.provider);
      if (!['missing-key', 'missing-binary'].includes(this.appServer.status().state)) await this.appServer.start();
      this.emit({ type: 'engine', engine: this.appServer.status() });
    }
    return next;
  }

  async restartAppServer(): Promise<EngineStatus> {
    const settings = await this.store.readSettings();
    await this.appServer.stop();
    this.appServer.configureProvider(settings.provider);
    await this.appServer.restart();
    return this.appServer.status();
  }

  async handleRpc(request: ClientRequest, context: RpcProjectContext = {}): Promise<unknown> {
    if (request.method === 'initialize') throw new Error('Kodex owns the App Server initialize handshake.');
    if (!ALLOWED_METHODS.has(request.method)) throw new Error(`Kodex UI does not expose ${request.method}.`);
    const [project, settings] = await Promise.all([this.#resolveProject(context), this.store.readSettings()]);
    switch (request.method) {
      case 'thread/start': {
        const params: ThreadStartParams = {
          ...request.params, cwd: project.path, approvalPolicy: settings.approvalPolicy,
          approvalsReviewer: 'user', sandbox: settings.sandbox,
          model: selectedModel(settings, request.params.model),
          modelProvider: settings.provider.mode === 'local' ? 'kodex_local' : request.params.modelProvider,
          config: { ...request.params.config, ...threadConfig(settings) }, ephemeral: false, serviceName: 'Kodex',
        };
        return this.appServer.request('thread/start', params);
      }
      case 'thread/list': {
        const params: ThreadListParams = { ...request.params, cwd: project.path };
        return this.appServer.request('thread/list', params);
      }
      case 'thread/resume': {
        const params: ThreadResumeParams = {
          ...request.params, cwd: project.path, approvalPolicy: settings.approvalPolicy,
          approvalsReviewer: 'user', sandbox: settings.sandbox,
          model: selectedModel(settings, request.params.model),
          modelProvider: settings.provider.mode === 'local' ? 'kodex_local' : request.params.modelProvider,
          config: { ...request.params.config, ...threadConfig(settings) },
        };
        return this.appServer.request('thread/resume', params);
      }
      case 'thread/fork': {
        const params: ThreadForkParams = {
          ...request.params, cwd: project.path, approvalPolicy: settings.approvalPolicy,
          approvalsReviewer: 'user', sandbox: settings.sandbox,
          model: selectedModel(settings, request.params.model),
          modelProvider: settings.provider.mode === 'local' ? 'kodex_local' : request.params.modelProvider,
          config: { ...request.params.config, ...threadConfig(settings) }, ephemeral: false,
        };
        return this.appServer.request('thread/fork', params);
      }
      case 'turn/start': {
        await this.appServer.request('thread/resume', {
          threadId: request.params.threadId, cwd: project.path, approvalPolicy: settings.approvalPolicy,
          approvalsReviewer: 'user', sandbox: settings.sandbox, config: threadConfig(settings),
          model: selectedModel(settings, request.params.model),
          modelProvider: settings.provider.mode === 'local' ? 'kodex_local' : null,
          excludeTurns: true,
        });
        const input = this.options.ragAugmenter && context.rag !== false
          ? await this.options.ragAugmenter.augment(request.params.input)
          : request.params.input;
        const params: TurnStartParams = {
          ...request.params, input, cwd: project.path, approvalPolicy: settings.approvalPolicy,
          approvalsReviewer: 'user', sandboxPolicy: sandboxPolicy(settings, project.path),
          model: selectedModel(settings, request.params.model),
        };
        return this.appServer.request('turn/start', params);
      }
      case 'config/read': return this.appServer.request('config/read', { ...request.params, cwd: project.path });
      default: return this.appServer.requestRaw(request.method, request.params, 120_000);
    }
  }

  async #resolveProject(context: RpcProjectContext): Promise<ProjectRecord> {
    const project = context.projectId ? await this.projects.get(context.projectId) : await this.projects.active();
    if (context.cwd && context.cwd.toLocaleLowerCase() !== project.path.toLocaleLowerCase()) throw new Error('RPC project context does not match its cwd.');
    return project;
  }

  async respondToServerRequest(clientId: string, id: RequestId, result: unknown): Promise<boolean> {
    const key = requestKey(id);
    const pending = this.#pendingServerRequests.get(key);
    if (!pending || pending.ownerId !== clientId) return false;
    const validated = validateServerRequestResult(pending.request.method, result);
    this.#pendingServerRequests.delete(key);
    clearTimeout(pending.timer);
    this.appServer.respond(id, validated);
    await this.store.appendApproval({ id, method: pending.request.method, result: validated });
    this.emit({
      type: 'server-request-resolved', requestId: id, reason: 'answered',
      request: pending.request, response: validated,
    });
    return true;
  }

  async respondToServerRequestError(clientId: string, id: RequestId, code: number, message: string): Promise<boolean> {
    const key = requestKey(id);
    const pending = this.#pendingServerRequests.get(key);
    if (!pending || pending.ownerId !== clientId) return false;
    this.#pendingServerRequests.delete(key);
    clearTimeout(pending.timer);
    this.appServer.respondError(id, code, message);
    await this.store.appendApproval({ id, method: pending.request.method, error: { code, message } });
    this.emit({
      type: 'server-request-resolved', requestId: id, reason: 'answered',
      request: pending.request, response: { error: { code, message } },
    });
    return true;
  }

  #onServerRequest(request: ServerRequest): void {
    if (!SUPPORTED_SERVER_REQUESTS.has(request.method)) {
      try { this.appServer.respondError(request.id, -32601, `${request.method} is unavailable because Kodex has no host-side dynamic tool/auth registry.`); } catch { /* process may exit */ }
      void this.store.appendLog('unsupported-requests.log', `${new Date().toISOString()} ${request.method}`);
      this.emit({
        type: 'server-request-resolved', requestId: request.id, reason: 'unsupported', request,
      });
      return;
    }
    const ownerId = this.#activeUiId;
    if (!ownerId) {
      try { this.appServer.respondError(request.id, -32001, 'No active Kodex UI is connected to answer this request.'); } catch { /* process may exit */ }
      this.emit({
        type: 'server-request-resolved', requestId: request.id, reason: 'disconnect', request,
      });
      return;
    }
    const key = requestKey(request.id);
    const previous = this.#pendingServerRequests.get(key);
    if (previous) clearTimeout(previous.timer);
    const timer = setTimeout(() => {
      const pending = this.#pendingServerRequests.get(key);
      if (!pending) return;
      this.#pendingServerRequests.delete(key);
      try { this.appServer.respondError(request.id, -32002, 'Kodex approval request timed out.'); } catch { /* process may exit */ }
      this.emit({
        type: 'server-request-resolved', requestId: request.id, reason: 'timeout', request,
      });
    }, this.options.serverRequestTimeoutMs ?? 120_000);
    timer.unref?.();
    this.#pendingServerRequests.set(key, { request, ownerId, timer });
    this.emit({ type: 'server-request', request, ownerId });
  }

  async #onNotification(notification: ServerNotification): Promise<void> {
    if (!KNOWN_UI_NOTIFICATIONS.has(notification.method)) {
      const metadata = sanitizeUnknown({ method: notification.method, paramKeys: notification.params && typeof notification.params === 'object' ? Object.keys(notification.params).slice(0, 20) : [] });
      await this.store.appendLog('unhandled-notifications.log', `${new Date().toISOString()} ${JSON.stringify(metadata)}`);
    }
    if (notification.method === 'turn/completed') {
      const run = this.#automationRuns.get(notification.params.turn.id);
      if (run) {
        this.#automationRuns.delete(run.turnId);
        this.#automationById.delete(run.automationId);
        const status = notification.params.turn.status === 'completed' ? 'succeeded' : notification.params.turn.status === 'interrupted' ? 'interrupted' : 'failed';
        await this.store.finishAutomation(run.automationId, run.claimId, status, notification.params.turn.error?.message ?? null);
      }
    }
    this.emit({ type: 'notification', notification });
  }

  async #onEngineStatus(engine: EngineStatus): Promise<void> {
    if (engine.state === 'failed' || engine.state === 'stopped') {
      this.#clearPendingRequests('app-server-restart');
      for (const run of this.#automationById.values()) await this.store.finishAutomation(run.automationId, run.claimId, 'interrupted', 'Codex App Server stopped before the turn completed.');
      this.#automationById.clear();
      this.#automationRuns.clear();
    }
    this.emit({ type: 'engine', engine });
  }

  #clearPendingRequests(reason: ServerRequestResolution): void {
    for (const pending of this.#pendingServerRequests.values()) {
      clearTimeout(pending.timer);
      this.emit({
        type: 'server-request-resolved', requestId: pending.request.id, reason,
        request: pending.request,
      });
    }
    this.#pendingServerRequests.clear();
  }

  async createAutomation(input: { name: string; prompt: string; intervalMinutes: number; projectId?: string }): Promise<unknown> {
    const project = input.projectId ? await this.projects.get(input.projectId) : await this.projects.active();
    return this.store.createAutomation({ ...input, projectId: project.id });
  }

  async runAutomation(id: string, force = true): Promise<{ threadId: string; turnId: string }> {
    const existing = this.#automationById.get(id);
    if (existing) return { threadId: existing.threadId, turnId: existing.turnId };
    const claim = await this.store.claimAutomation(id, Date.now(), force);
    if (!claim) throw new Error('Automation is already running or is not due.');
    const context: RpcProjectContext = {
      projectId: claim.automation.projectId,
      rag: this.options.ragAutomationsEnabled === true,
    };
    try {
      const started = await this.handleRpc({ method: 'thread/start', id: 0, params: {} }, context);
      const threadId = (started as { thread: { id: string } }).thread.id;
      await this.store.setAutomationThread(id, claim.claimId, threadId);
      await this.handleRpc({ method: 'thread/name/set', id: 0, params: { threadId, name: `[Automation] ${claim.automation.name}` } }, context);
      const turn = await this.handleRpc({ method: 'turn/start', id: 0, params: { threadId, input: [{ type: 'text', text: claim.automation.prompt, text_elements: [] }] } }, context) as { turn: { id: string } };
      const run = { automationId: id, claimId: claim.claimId, threadId, turnId: turn.turn.id };
      this.#automationById.set(id, run);
      this.#automationRuns.set(run.turnId, run);
      return { threadId, turnId: run.turnId };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.store.finishAutomation(id, claim.claimId, 'failed', message);
      throw error;
    }
  }

  async runDueAutomations(now = Date.now()): Promise<void> {
    const entries = await this.store.listAutomations();
    for (const entry of entries) {
      if (entry.enabled && entry.nextRunAt <= now && entry.lastStatus !== 'running') void this.runAutomation(entry.id, false).catch(() => undefined);
    }
  }

  async stop(): Promise<void> {
    if (this.#scheduler) clearInterval(this.#scheduler);
    this.#scheduler = null;
    this.#clearPendingRequests('app-server-restart');
    for (const run of this.#automationById.values()) await this.store.finishAutomation(run.automationId, run.claimId, 'interrupted', 'Kodex Local Server stopped.');
    this.#automationById.clear();
    this.#automationRuns.clear();
    await this.appServer.stop();
    await this.store.close();
  }
}
