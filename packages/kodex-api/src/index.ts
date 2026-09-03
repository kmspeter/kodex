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
}

export type ProviderMode = 'openai' | 'local';

export interface ProviderSettings {
  mode: ProviderMode;
  /** Loopback-only Responses API base URL, including /v1 when required by the server. */
  baseUrl: string;
  model: string;
}

export interface KodexSettings {
  sandbox: SandboxChoice;
  approvalPolicy: ApprovalChoice;
  network: NetworkPreferences;
  provider: ProviderSettings;
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
  lastStatus: 'never-run' | 'running' | 'succeeded' | 'failed' | 'interrupted';
  lastError: string | null;
  threadId: string | null;
  runningSince: number | null;
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
  consecutiveFailures: number;
  providerMode: ProviderMode;
  providerModel: string | null;
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
    hostDynamicTools: false;
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

export type RepositoryPreviewExclusionReason =
  | 'binary_or_invalid_utf8'
  | 'credential_or_secret'
  | 'default_directory'
  | 'git_ignored'
  | 'oversized'
  | 'preview_limit'
  | 'unsafe_link'
  | 'unsupported_file';

export interface RepositoryPreviewFile {
  path: string;
  sizeBytes: number;
  status: 'eligible';
}

export interface RepositoryPreviewResponse {
  expiresAt: string;
  excluded: Array<{ count: number; reason: RepositoryPreviewExclusionReason }>;
  files: RepositoryPreviewFile[];
  limits: {
    maxFileBytes: number;
    maxSelectedFiles: number;
    maxTotalBytes: number;
    maxTotalCharacters: number;
  };
  previewToken: string;
  project: { id: string; name: string };
  truncated: boolean;
}

export interface RepositoryIndexResponse {
  files: Array<{
    chunkCount: number;
    documentId: string;
    path: string;
    status: 'indexed' | 'unchanged';
  }>;
  indexed: number;
  project: { id: string; name: string };
  unchanged: number;
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
  | { type: 'replay'; epoch: string; afterSequence: number }
  | { type: 'ping' };

export interface PendingServerRequest {
  request: ServerRequest;
  owned: boolean;
}

export type ServerSocketMessage =
  | { type: 'hello'; epoch: string; latestSequence: number; oldestSequence: number; engine: EngineStatus }
  | { type: 'rpc-result'; requestId: string; result: unknown }
  | { type: 'rpc-error'; requestId: string; code: number; message: string }
  | { type: 'notification'; epoch: string; sequence: number; notification: ServerNotification }
  | { type: 'server-request'; epoch: string; sequence: number; request: ServerRequest; owned: boolean }
  | { type: 'server-request-resolved'; epoch: string; sequence: number; requestId: RequestId; reason: 'answered' | 'timeout' | 'disconnect' | 'app-server-restart' | 'unsupported' }
  | { type: 'engine'; epoch: string; sequence: number; engine: EngineStatus }
  | { type: 'resync-required'; reason: 'replay-gap' | 'server-restart'; epoch: string; oldestAvailable: number; newestAvailable: number }
  | { type: 'pong' };

export interface ApiErrorBody {
  ok: false;
  error: string;
}
