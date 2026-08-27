import type {
  ClientRequest,
  JsonValue,
  SandboxPolicy,
  ServerNotification,
  ServerRequest,
  ThreadForkParams,
  ThreadListParams,
  ThreadResumeParams,
  ThreadStartParams,
  TurnStartParams,
} from '@kodex/codex-protocol';
import type { BootstrapResponse, EngineStatus, KodexSettings } from '@kodex/kodex-api';
import { SequenceBuffer } from '@kodex/shared';
import { AppServerClient } from './process/app-server-client.js';
import { ProjectStore } from './projects/project-store.js';
import { LocalStore } from './storage/local-store.js';

export type RuntimeEvent =
  | { type: 'notification'; notification: ServerNotification }
  | { type: 'server-request'; request: ServerRequest }
  | { type: 'engine'; engine: EngineStatus };

type RuntimeListener = (sequence: number, event: RuntimeEvent) => void;

const ALLOWED_METHODS = new Set<ClientRequest['method']>([
  'thread/start', 'thread/list', 'thread/read', 'thread/resume', 'thread/fork',
  'thread/archive', 'thread/unarchive', 'thread/name/set',
  'turn/start', 'turn/steer', 'turn/interrupt', 'model/list',
  'skills/list', 'config/read', 'config/value/write',
  'app/list', 'plugin/list', 'plugin/install', 'plugin/uninstall',
  'mcpServerStatus/list', 'mcpServer/oauth/login', 'config/mcpServer/reload',
  'experimentalFeature/list', 'experimentalFeature/enablement/set',
]);

function sandboxPolicy(settings: KodexSettings, projectPath: string): SandboxPolicy {
  if (settings.sandbox === 'danger-full-access') return { type: 'dangerFullAccess' };
  if (settings.sandbox === 'read-only') return { type: 'readOnly', networkAccess: settings.network.shell };
  return {
    type: 'workspaceWrite',
    writableRoots: [projectPath],
    networkAccess: settings.network.shell,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}

function threadConfig(settings: KodexSettings): Record<string, JsonValue> {
  return { web_search: settings.network.webSearch ? 'live' : 'disabled' };
}

export class KodexRuntime {
  readonly store: LocalStore;
  readonly projects: ProjectStore;
  readonly appServer: AppServerClient;
  readonly events = new SequenceBuffer<RuntimeEvent>(1_000);
  #listeners = new Set<RuntimeListener>();
  #scheduler: NodeJS.Timeout | null = null;

  constructor(readonly repositoryRoot: string, apiKey: string | undefined) {
    this.store = new LocalStore(repositoryRoot);
    this.projects = new ProjectStore(this.store, repositoryRoot);
    this.appServer = new AppServerClient({
      repositoryRoot,
      codexHome: this.store.codexHome,
      apiKey,
      log: (filename, line) => this.store.appendLog(filename, line),
    });
    this.appServer.on('notification', (notification: ServerNotification) => this.emit({ type: 'notification', notification }));
    this.appServer.on('server-request', (request: ServerRequest) => this.emit({ type: 'server-request', request }));
    this.appServer.on('status', (engine: EngineStatus) => this.emit({ type: 'engine', engine }));
  }

  async initialize(): Promise<void> {
    await this.store.initialize();
    await this.projects.initialize();
    if (!this.#scheduler) {
      this.#scheduler = setInterval(() => void this.#runDueAutomations(), 30_000);
      this.#scheduler.unref?.();
    }
    if (this.appServer.status().apiKeyConfigured && this.appServer.status().state !== 'missing-binary') {
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

  async bootstrap(apiBaseUrl: string, csrfToken: string, sessionToken: string): Promise<BootstrapResponse> {
    await this.initialize();
    const [settings, projects, activeProject, automations] = await Promise.all([
      this.store.readSettings(),
      this.projects.list(),
      this.projects.active(),
      this.store.listAutomations(),
    ]);
    try { this.appServer.detectVersion(); } catch { /* status contains the actionable binary error */ }
    return {
      product: 'Kodex',
      csrfToken,
      sessionToken,
      apiBaseUrl,
      engine: this.appServer.status(),
      settings,
      projects,
      activeProject,
      automations,
      capabilities: {
        localState: true,
        cloudBackend: false,
        webSearch: true,
        remoteMcp: true,
        apps: true,
        plugins: true,
      },
    };
  }

  async handleRpc(request: ClientRequest): Promise<unknown> {
    if (request.method === 'initialize') throw new Error('Kodex owns the App Server initialize handshake.');
    if (!ALLOWED_METHODS.has(request.method)) throw new Error(`Kodex UI does not expose ${request.method}.`);
    const [project, settings] = await Promise.all([this.projects.active(), this.store.readSettings()]);
    switch (request.method) {
      case 'thread/start': {
        const params: ThreadStartParams = {
          ...request.params,
          cwd: project.path,
          approvalPolicy: settings.approvalPolicy,
          approvalsReviewer: 'user',
          sandbox: settings.sandbox,
          config: { ...request.params.config, ...threadConfig(settings) },
          ephemeral: false,
          serviceName: 'Kodex',
        };
        return this.appServer.request('thread/start', params);
      }
      case 'thread/list': {
        const params: ThreadListParams = { ...request.params, cwd: project.path };
        return this.appServer.request('thread/list', params);
      }
      case 'thread/resume': {
        const params: ThreadResumeParams = {
          ...request.params,
          cwd: project.path,
          approvalPolicy: settings.approvalPolicy,
          approvalsReviewer: 'user',
          sandbox: settings.sandbox,
          config: { ...request.params.config, ...threadConfig(settings) },
        };
        return this.appServer.request('thread/resume', params);
      }
      case 'thread/fork': {
        const params: ThreadForkParams = {
          ...request.params,
          cwd: project.path,
          approvalPolicy: settings.approvalPolicy,
          approvalsReviewer: 'user',
          sandbox: settings.sandbox,
          config: { ...request.params.config, ...threadConfig(settings) },
          ephemeral: false,
        };
        return this.appServer.request('thread/fork', params);
      }
      case 'turn/start': {
        const params: TurnStartParams = {
          ...request.params,
          cwd: project.path,
          approvalPolicy: settings.approvalPolicy,
          approvalsReviewer: 'user',
          sandboxPolicy: sandboxPolicy(settings, project.path),
        };
        return this.appServer.request('turn/start', params);
      }
      case 'config/read':
        return this.appServer.request('config/read', { ...request.params, cwd: project.path });
      default:
        return this.appServer.requestRaw(request.method, request.params, 120_000);
    }
  }

  async respondToServerRequest(id: string | number, result: unknown): Promise<void> {
    this.appServer.respond(id, result);
    await this.store.appendApproval({ id, result });
  }

  async createAutomation(input: { name: string; prompt: string; intervalMinutes: number; projectId?: string }): Promise<unknown> {
    const project = input.projectId ? await this.projects.select(input.projectId) : await this.projects.active();
    return this.store.createAutomation({ ...input, projectId: project.id });
  }

  async runAutomation(id: string): Promise<{ threadId: string }> {
    const automations = await this.store.listAutomations();
    const automation = automations.find((entry) => entry.id === id);
    if (!automation) throw new Error('Automation was not found.');
    const project = await this.projects.select(automation.projectId);
    try {
      const started = await this.handleRpc({ method: 'thread/start', id: 0, params: { cwd: project.path } });
      const threadId = (started as { thread: { id: string } }).thread.id;
      await this.handleRpc({ method: 'thread/name/set', id: 0, params: { threadId, name: `[Automation] ${automation.name}` } });
      await this.handleRpc({ method: 'turn/start', id: 0, params: { threadId, input: [{ type: 'text', text: automation.prompt, text_elements: [] }] } });
      await this.store.recordAutomation(id, { lastStatus: 'started', lastError: null, threadId });
      return { threadId };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.store.recordAutomation(id, { lastStatus: 'failed', lastError: message });
      throw error;
    }
  }

  async #runDueAutomations(): Promise<void> {
    const entries = await this.store.listAutomations();
    const now = Date.now();
    for (const entry of entries) {
      if (entry.enabled && entry.nextRunAt <= now) void this.runAutomation(entry.id).catch(() => undefined);
    }
  }

  async stop(): Promise<void> {
    if (this.#scheduler) clearInterval(this.#scheduler);
    this.#scheduler = null;
    await this.appServer.stop();
  }
}
