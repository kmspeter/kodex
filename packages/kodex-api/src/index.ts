import type {
  AppsListResponse,
  ClientRequest,
  ConfigReadResponse,
  ConfigWriteResponse,
  ListMcpServerStatusResponse,
  ModelListResponse,
  PluginListResponse,
  RequestId,
  ServerNotification,
  ServerRequest,
  SkillsListResponse,
  ThreadArchiveResponse,
  ThreadForkResponse,
  ThreadListResponse,
  ThreadReadResponse,
  ThreadResumeResponse,
  ThreadSetNameResponse,
  ThreadStartResponse,
  ThreadUnarchiveResponse,
  TurnInterruptResponse,
  TurnStartResponse,
  TurnSteerResponse,
} from '@kodex/codex-protocol';

export type SandboxChoice = 'read-only' | 'workspace-write' | 'danger-full-access';
export type ApprovalChoice = 'untrusted' | 'on-request' | 'never';

export interface NetworkPreferences {
  shell: boolean;
  webSearch: boolean;
  remoteMcp: boolean;
}

export interface KodexSettings {
  theme: 'light' | 'system';
  density: 'compact' | 'comfortable';
  notifications: boolean;
  sandbox: SandboxChoice;
  approvalPolicy: ApprovalChoice;
  network: NetworkPreferences;
  lastProjectId: string | null;
  sidebarOpen: boolean;
  detailPanelOpen: boolean;
}

export interface ProjectRecord {
  id: string;
  name: string;
  path: string;
  createdAt: number;
  lastOpenedAt: number;
}

export interface AutomationRecord {
  id: string;
  name: string;
  prompt: string;
  intervalMinutes: number;
  enabled: boolean;
  projectId: string;
  createdAt: number;
  updatedAt: number;
  nextRunAt: number;
  lastRunAt: number | null;
  lastStatus: 'never-run' | 'started' | 'failed';
  lastError: string | null;
  threadId: string | null;
}

export interface EngineStatus {
  state: 'ready' | 'starting' | 'stopped' | 'failed' | 'missing-key' | 'missing-binary';
  message: string;
  apiKeyConfigured: boolean;
  binary: string | null;
  binarySource: 'local' | 'global-fallback' | null;
  version: string | null;
  pid: number | null;
  restartCount: number;
  transport: 'stdio JSONL';
}

export interface BootstrapResponse {
  product: 'Kodex';
  csrfToken: string;
  sessionToken: string;
  apiBaseUrl: string;
  engine: EngineStatus;
  settings: KodexSettings;
  projects: ProjectRecord[];
  activeProject: ProjectRecord;
  automations: AutomationRecord[];
  capabilities: {
    localState: true;
    cloudBackend: false;
    webSearch: boolean;
    remoteMcp: boolean;
    apps: boolean;
    plugins: boolean;
  };
}

export interface GitFileStatus {
  path: string;
  staged: boolean;
  unstaged: boolean;
  added: number;
  removed: number;
}

export interface GitStatus {
  isRepository: boolean;
  branch: string;
  files: GitFileStatus[];
  totals: { files: number; added: number; removed: number };
}

export type ClientRpc = ClientRequest;

export type ClientMethod = ClientRequest['method'];
export type RequestFor<M extends ClientMethod> = Extract<ClientRequest, { method: M }>;
export type ParamsFor<M extends ClientMethod> = RequestFor<M> extends { params?: infer P } ? P : never;

export interface CodexResponseByMethod {
  'thread/start': ThreadStartResponse;
  'thread/list': ThreadListResponse;
  'thread/read': ThreadReadResponse;
  'thread/resume': ThreadResumeResponse;
  'thread/fork': ThreadForkResponse;
  'thread/archive': ThreadArchiveResponse;
  'thread/unarchive': ThreadUnarchiveResponse;
  'thread/name/set': ThreadSetNameResponse;
  'turn/start': TurnStartResponse;
  'turn/steer': TurnSteerResponse;
  'turn/interrupt': TurnInterruptResponse;
  'model/list': ModelListResponse;
  'skills/list': SkillsListResponse;
  'config/read': ConfigReadResponse;
  'config/value/write': ConfigWriteResponse;
  'app/list': AppsListResponse;
  'plugin/list': PluginListResponse;
  'mcpServerStatus/list': ListMcpServerStatusResponse;
}

export type ResponseFor<M extends ClientMethod> = M extends keyof CodexResponseByMethod ? CodexResponseByMethod[M] : unknown;

export type ClientSocketMessage =
  | { type: 'rpc'; requestId: string; request: ClientRequest }
  | { type: 'server-response'; requestId: RequestId; result: unknown }
  | { type: 'server-error'; requestId: RequestId; code: number; message: string }
  | { type: 'replay'; afterSequence: number }
  | { type: 'ping' };

export type ServerSocketMessage =
  | { type: 'hello'; sequence: number; engine: EngineStatus }
  | { type: 'rpc-result'; requestId: string; result: unknown }
  | { type: 'rpc-error'; requestId: string; code: number; message: string }
  | { type: 'notification'; sequence: number; notification: ServerNotification }
  | { type: 'server-request'; sequence: number; request: ServerRequest }
  | { type: 'engine'; sequence: number; engine: EngineStatus }
  | { type: 'replay-gap'; oldestAvailable: number; newestAvailable: number }
  | { type: 'pong' };

export interface ApiErrorBody {
  ok: false;
  error: string;
}
