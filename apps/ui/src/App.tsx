import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type {
  AppInfo,
  ConfigReadResponse,
  McpServerStatus,
  Model,
  PluginListResponse,
  ReasoningEffort,
  SkillsListEntry,
  Thread,
} from '@kodex/codex-protocol';
import type { AutomationRecord, BootstrapResponse, GitStatus, KodexSettings, ProjectRecord } from '@kodex/kodex-api';
import { Code2, GitCommitHorizontal, LoaderCircle, ShieldCheck, SquareTerminal } from 'lucide-react';
import { ProductAuthGate } from './auth/AuthGate';
import { selectProductRuntimeWorkspace, type ProductAuthClient, type ProductAuthContext } from './auth/product-auth';
import { KodexClient, type ConnectionState } from './client/kodex-client';
import { KodexMark } from './components/Brand';
import { ChangesPanel } from './components/ChangesPanel';
import { Composer } from './components/Composer';
import { Dialogs, type DialogName } from './components/Dialogs';
import { ItemView } from './components/ItemView';
import { RequestCard } from './components/RequestCard';
import { Sidebar } from './components/Sidebar';
import { WorkspaceHeader } from './components/WorkspaceHeader';
import { eventReducer, initialEventState } from './state/events';

const EMPTY_GIT: GitStatus = { isRepository: false, branch: '', files: [], totals: { files: 0, added: 0, removed: 0 } };
type ActivePopover = 'header-account' | 'header-open' | 'header-more' | 'composer-model' | null;

export function App() {
  return <ProductAuthGate>{(account, logout, loggingOut, authClient) => <ProductWorkspaceApp
    account={account}
    authClient={authClient}
    loggingOut={loggingOut}
    onLogout={logout}
  />}</ProductAuthGate>;
}

function ProductWorkspaceApp(props: {
  account: ProductAuthContext;
  authClient: ProductAuthClient;
  loggingOut: boolean;
  onLogout: () => Promise<void>;
}) {
  const workspace = selectProductRuntimeWorkspace(props.account);
  if (!workspace) {
    return <main className="auth-screen"><section className="auth-card recovery-card" aria-labelledby="workspace-required-title">
      <div className="auth-brand"><KodexMark /><span>Kodex</span></div>
      <div className="auth-status-icon is-error"><ShieldCheck size={20} /></div>
      <h1 id="workspace-required-title">실행 가능한 workspace가 없습니다</h1>
      <p>{props.account.workspaces.length > 0
        ? '현재 membership은 읽기 전용입니다. Kodex runtime을 시작하려면 owner, admin 또는 member 역할이 필요합니다.'
        : '계정은 인증되었지만 활성 membership이 없어 로컬 runtime을 시작하지 않았습니다. Workspace 관리자에게 접근 권한을 요청하세요.'}</p>
      <button className="auth-submit" type="button" disabled={props.loggingOut} onClick={() => void props.onLogout()}>로그아웃</button>
    </section></main>;
  }
  return <AuthenticatedApp
    key={`${props.account.user.id}:${workspace.id}`}
    {...props}
    workspaceId={workspace.id}
  />;
}

function AuthenticatedApp(props: {
  account: ProductAuthContext;
  authClient: ProductAuthClient;
  loggingOut: boolean;
  onLogout: () => Promise<void>;
  workspaceId: string;
}) {
  const client = useMemo(() => new KodexClient({ workspaceId: props.workspaceId }), [props.workspaceId]);
  const [bootstrap, setBootstrap] = useState<BootstrapResponse | null>(null);
  const [fatalError, setFatalError] = useState('');
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [events, dispatch] = useReducer(eventReducer, initialEventState);
  const [models, setModels] = useState<Model[]>([]);
  const [model, setModel] = useState<string | null>(null);
  const [effort, setEffort] = useState<ReasoningEffort>('high');
  const [skills, setSkills] = useState<SkillsListEntry[]>([]);
  const [apps, setApps] = useState<AppInfo[]>([]);
  const [plugins, setPlugins] = useState<PluginListResponse | null>(null);
  const [mcpServers, setMcpServers] = useState<McpServerStatus[]>([]);
  const [archivedThreads, setArchivedThreads] = useState<Thread[]>([]);
  const [codexConfig, setCodexConfig] = useState<ConfigReadResponse | null>(null);
  const [automations, setAutomations] = useState<AutomationRecord[]>([]);
  const [git, setGit] = useState<GitStatus>(EMPTY_GIT);
  const [selectedFile, setSelectedFile] = useState('');
  const [selectedDiff, setSelectedDiff] = useState('');
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [dialog, setDialog] = useState<DialogName>(null);
  const [popover, setPopover] = useState<ActivePopover>(null);
  const [toast, setToast] = useState('');
  const closeDialog = useCallback(() => setDialog(null), []);
  const activeThreadIdRef = useRef<string | null>(null);
  const refreshGenerationRef = useRef(0);
  const threadSelectionGenerationRef = useRef(0);
  const sidebarOpenRef = useRef(true);
  const detailsOpenRef = useRef(false);
  const settingsSaveQueueRef = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => { activeThreadIdRef.current = events.activeThread?.id ?? null; }, [events.activeThread?.id]);

  const knowledgeRequest = useCallback(<T,>(pathname: string, init?: RequestInit): Promise<T> => (
    props.authClient.knowledge<T>(pathname, props.workspaceId, init)
  ), [props.authClient, props.workspaceId]);

  const refreshGit = useCallback(async () => {
    try { setGit(await client.http<GitStatus>('/api/git/status')); } catch { setGit(EMPTY_GIT); }
  }, [client]);

  const refreshData = useCallback(async (project?: ProjectRecord) => {
    const cwd = project?.path ?? bootstrap?.activeProject.path;
    if (!cwd) return;
    const generation = ++refreshGenerationRef.current;
    const [threadsResult, modelsResult, skillsResult, appsResult, pluginsResult, mcpResult, configResult] = await Promise.allSettled([
      client.rpc('thread/list', { limit: 200, archived: false }),
      client.rpc('model/list', { limit: 100, includeHidden: false }),
      client.rpc('skills/list', { cwds: [cwd], forceReload: false }),
      client.rpc('app/list', { limit: 100, forceRefetch: false }),
      client.rpc('plugin/list', { cwds: [cwd], forceRefetch: false }),
      client.rpc('mcpServerStatus/list', { limit: 100, detail: 'full', threadId: events.activeThread?.id ?? null }),
      client.rpc('config/read', { includeLayers: true, cwd }),
    ]);
    if (generation !== refreshGenerationRef.current) return;
    if (threadsResult.status === 'fulfilled') dispatch({ type: 'threads-loaded', threads: threadsResult.value.data });
    if (modelsResult.status === 'fulfilled') {
      setModels(modelsResult.value.data);
      const preferred = modelsResult.value.data.find((entry) => entry.isDefault) ?? modelsResult.value.data[0];
      if (preferred && !model) { setModel(preferred.model); setEffort(preferred.defaultReasoningEffort); }
    }
    if (skillsResult.status === 'fulfilled') setSkills(skillsResult.value.data);
    if (appsResult.status === 'fulfilled') setApps(appsResult.value.data);
    if (pluginsResult.status === 'fulfilled') setPlugins(pluginsResult.value);
    if (mcpResult.status === 'fulfilled') setMcpServers(mcpResult.value.data);
    if (configResult.status === 'fulfilled') setCodexConfig(configResult.value);
    await refreshGit();
  }, [bootstrap?.activeProject.path, client, events.activeThread?.id, model, refreshGit]);

  const resynchronize = useCallback(async () => {
    dispatch({ type: 'resync-started' });
    const listed = await client.rpc('thread/list', { limit: 200, archived: false });
    dispatch({ type: 'threads-loaded', threads: listed.data });
    const activeId = activeThreadIdRef.current;
    if (activeId) {
      try {
        const read = await client.rpc('thread/read', { threadId: activeId, includeTurns: true });
        dispatch({ type: 'thread-selected', thread: read.thread });
        const resumed = await client.rpc('thread/resume', { threadId: activeId });
        dispatch({ type: 'thread-selected', thread: resumed.thread });
      } catch { dispatch({ type: 'thread-selected', thread: null }); }
    }
    await refreshGit();
  }, [client, refreshGit]);

  useEffect(() => {
    let active = true;
    const offConnection = client.onConnection((next) => {
      setConnection(next);
      if (next !== 'connected') setPopover(null);
    });
    const offMessages = client.subscribe((message) => {
      if (message.type === 'hello') setBootstrap((current) => current ? { ...current, engine: message.engine } : current);
      if (message.type === 'engine') setBootstrap((current) => current ? { ...current, engine: message.engine } : current);
      if (message.type === 'server-request') dispatch({ type: 'server-request', request: { request: message.request, owned: message.owned } });
      if (message.type === 'server-request-resolved') dispatch({ type: 'server-request-resolved', id: message.requestId });
      if (message.type === 'notification') {
        dispatch({ type: 'notification', notification: message.notification });
        if (message.notification.method === 'turn/completed' || message.notification.method.includes('fileChange')) void refreshGit();
      }
      if (message.type === 'resync-required') {
        setPopover(null);
        setToast(message.reason === 'server-restart' ? 'Local Server가 다시 시작되어 thread 상태를 재동기화합니다.' : 'Replay gap을 감지하여 thread 상태를 재동기화합니다.');
        void resynchronize().catch((error: unknown) => setToast(error instanceof Error ? error.message : String(error)));
      }
    });
    void client.start().then((result) => {
      if (!active) return;
      setBootstrap(result);
      setAutomations(result.automations);
      sidebarOpenRef.current = result.settings.sidebarOpen;
      detailsOpenRef.current = result.settings.detailPanelOpen;
      setSidebarOpen(result.settings.sidebarOpen);
      setDetailsOpen(result.settings.detailPanelOpen);
    }).catch((error: unknown) => { if (active) setFatalError(error instanceof Error ? error.message : String(error)); });
    return () => { active = false; offConnection(); offMessages(); client.close(); };
  }, [client, refreshGit, resynchronize]);

  useEffect(() => {
    if (connection === 'connected' && bootstrap?.engine.state === 'ready') void refreshData();
  }, [connection, bootstrap?.engine.state, refreshData]);

  useEffect(() => {
    if (!selectedFile) { setSelectedDiff(''); return; }
    let active = true;
    void client.http<{ path: string; diff: string }>(`/api/git/diff?path=${encodeURIComponent(selectedFile)}`)
      .then((result) => { if (active) setSelectedDiff(result.diff); })
      .catch((error: unknown) => { if (active) setSelectedDiff(error instanceof Error ? error.message : String(error)); });
    return () => { active = false; };
  }, [client, selectedFile]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(''), 3_500);
    return () => window.clearTimeout(timer);
  }, [toast]);

  async function selectThread(thread: Thread): Promise<void> {
    const generation = ++threadSelectionGenerationRef.current;
    try {
      const read = await client.rpc('thread/read', { threadId: thread.id, includeTurns: false });
      if (generation !== threadSelectionGenerationRef.current) return;
      dispatch({ type: 'thread-selected', thread: read.thread });
      const resumed = await client.rpc('thread/resume', { threadId: thread.id });
      if (generation !== threadSelectionGenerationRef.current) return;
      dispatch({ type: 'thread-selected', thread: resumed.thread });
    } catch (error) { setToast(error instanceof Error ? error.message : String(error)); }
  }

  async function sendDraft(): Promise<void> {
    const text = draft.trim();
    if (!text || busy || !bootstrap) return;
    setDraft('');
    setBusy(true);
    try {
      if (events.activeThread && events.activeTurnId) {
        await client.rpc('turn/steer', { threadId: events.activeThread.id, expectedTurnId: events.activeTurnId, input: [{ type: 'text', text, text_elements: [] }] });
        return;
      }
      let thread = events.activeThread;
      if (!thread) {
        const started = await client.rpc('thread/start', { model, cwd: bootstrap.activeProject.path });
        thread = started.thread;
        dispatch({ type: 'thread-selected', thread });
        await client.rpc('thread/name/set', { threadId: thread.id, name: text.length > 60 ? `${text.slice(0, 60)}…` : text });
      }
      const startedTurn = await client.rpc('turn/start', { threadId: thread.id, input: [{ type: 'text', text, text_elements: [] }], model, effort });
      dispatch({ type: 'turn-accepted', threadId: thread.id, turn: startedTurn.turn });
    } catch (error) {
      setDraft(text);
      setToast(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function updateSettings(patch: Partial<KodexSettings>): Promise<void> {
    const operation = settingsSaveQueueRef.current.then(async () => {
      const settings = await client.http<KodexSettings>('/api/settings', { method: 'PUT', body: JSON.stringify(patch) });
      setBootstrap((current) => current ? { ...current, settings } : current);
      if (patch.sidebarOpen !== undefined) {
        sidebarOpenRef.current = patch.sidebarOpen;
        setSidebarOpen(patch.sidebarOpen);
      }
      if (patch.detailPanelOpen !== undefined) {
        detailsOpenRef.current = patch.detailPanelOpen;
        setDetailsOpen(patch.detailPanelOpen);
      }
    });
    settingsSaveQueueRef.current = operation.catch(() => undefined);
    return operation;
  }

  function persistLayoutSettings(patch: Pick<Partial<KodexSettings>, 'sidebarOpen' | 'detailPanelOpen'>): void {
    const operation = settingsSaveQueueRef.current.then(async () => {
      const settings = await client.http<KodexSettings>('/api/settings', { method: 'PUT', body: JSON.stringify(patch) });
      setBootstrap((current) => current ? {
        ...current,
        settings: {
          ...settings,
          sidebarOpen: sidebarOpenRef.current,
          detailPanelOpen: detailsOpenRef.current,
        },
      } : current);
    });
    settingsSaveQueueRef.current = operation.catch(() => undefined);
    void operation.catch((error: unknown) => setToast(error instanceof Error ? error.message : String(error)));
  }

  function setSidebarVisibility(open: boolean): void {
    sidebarOpenRef.current = open;
    setPopover(null);
    setSidebarOpen(open);
    persistLayoutSettings({ sidebarOpen: open });
  }

  function toggleDetailsPanel(): void {
    const open = !detailsOpenRef.current;
    detailsOpenRef.current = open;
    setPopover(null);
    setDetailsOpen(open);
    persistLayoutSettings({ detailPanelOpen: open });
  }

  async function selectProject(project: ProjectRecord): Promise<void> {
    threadSelectionGenerationRef.current += 1;
    try {
      const activeProject = await client.http<ProjectRecord>('/api/projects', { method: 'POST', body: JSON.stringify({ id: project.id }) });
      const projectResult = await client.http<{ data: ProjectRecord[]; active: ProjectRecord }>('/api/projects');
      setBootstrap((current) => current ? { ...current, activeProject, projects: projectResult.data } : current);
      dispatch({ type: 'thread-selected', thread: null });
      setSelectedFile('');
      await refreshData(activeProject);
    } catch (error) { setToast(error instanceof Error ? error.message : String(error)); }
  }

  async function addProject(projectPath: string, name?: string): Promise<void> {
    threadSelectionGenerationRef.current += 1;
    try {
      const project = await client.http<ProjectRecord>('/api/projects', { method: 'POST', body: JSON.stringify({ path: projectPath.trim(), name }) });
      const projectResult = await client.http<{ data: ProjectRecord[]; active: ProjectRecord }>('/api/projects');
      setBootstrap((current) => current ? { ...current, activeProject: project, projects: projectResult.data } : current);
      dispatch({ type: 'thread-selected', thread: null });
      await refreshData(project);
    } catch (error) { setToast(error instanceof Error ? error.message : String(error)); throw error; }
  }

  async function removeProject(project: ProjectRecord): Promise<void> {
    threadSelectionGenerationRef.current += 1;
    try {
      await client.http('/api/projects', { method: 'DELETE', body: JSON.stringify({ id: project.id }) });
      const projectResult = await client.http<{ data: ProjectRecord[]; active: ProjectRecord }>('/api/projects');
      setBootstrap((current) => current ? { ...current, activeProject: projectResult.active, projects: projectResult.data } : current);
      if (project.id === bootstrap?.activeProject.id) {
        dispatch({ type: 'thread-selected', thread: null });
        await refreshData(projectResult.active);
      }
    } catch (error) { setToast(error instanceof Error ? error.message : String(error)); throw error; }
  }

  async function openDialog(next: Exclude<DialogName, null>): Promise<void> {
    setPopover(null);
    setDialog(next);
    if (next !== 'archived') return;
    try {
      const result = await client.rpc('thread/list', { limit: 200, archived: true });
      setArchivedThreads(result.data);
    } catch (error) { setToast(error instanceof Error ? error.message : String(error)); }
  }

  async function unarchiveThread(thread: Thread): Promise<void> {
    try {
      await client.rpc('thread/unarchive', { threadId: thread.id });
      setArchivedThreads((current) => current.filter((entry) => entry.id !== thread.id));
      await refreshData();
    } catch (error) { setToast(error instanceof Error ? error.message : String(error)); throw error; }
  }

  async function archiveActive(): Promise<void> {
    if (!events.activeThread) return;
    await client.rpc('thread/archive', { threadId: events.activeThread.id });
    dispatch({ type: 'thread-selected', thread: null });
  }

  async function forkActive(): Promise<void> {
    if (!events.activeThread) return;
    const result = await client.rpc('thread/fork', { threadId: events.activeThread.id });
    dispatch({ type: 'thread-selected', thread: result.thread });
  }

  async function renameActive(): Promise<void> {
    if (!events.activeThread) return;
    const name = window.prompt('Thread name', events.activeThread.name ?? events.activeThread.preview);
    if (name?.trim()) await client.rpc('thread/name/set', { threadId: events.activeThread.id, name: name.trim() });
  }

  function resolveServerRequest(id: string | number, result: unknown): void {
    try {
      client.sendServerResponse(id, result);
      dispatch({ type: 'server-request-resolved', id });
    } catch (error) { setToast(error instanceof Error ? error.message : String(error)); }
  }

  function rejectServerRequest(id: string | number, message: string): void {
    try {
      client.sendServerError(id, -32601, message);
      dispatch({ type: 'server-request-resolved', id });
    } catch (error) { setToast(error instanceof Error ? error.message : String(error)); }
  }

  async function refreshAutomations(): Promise<void> {
    const result = await client.http<{ data: AutomationRecord[] }>('/api/automations');
    setAutomations(result.data);
  }

  if (fatalError) return <main className="boot-screen"><div className="setup-card is-error"><ShieldCheck size={20} /><div><strong>Kodex Local Server에 연결할 수 없습니다</strong><p>{fatalError}</p><code>npm run dev</code></div></div></main>;
  if (!bootstrap) return <main className="boot-screen"><KodexMark /><LoaderCircle className="spin" size={20} /><p>로컬 Kodex 상태를 읽는 중…</p></main>;

  const engineReady = bootstrap.engine.state === 'ready';
  const items = events.activeThread?.turns.flatMap((turn) => turn.items) ?? [];
  const visiblePopover = detailsOpen ? null : popover;
  return <main className={`app-shell ${sidebarOpen ? '' : 'sidebar-collapsed'} ${detailsOpen ? 'details-visible' : ''}`}>
    <Sidebar open={sidebarOpen} connection={connection} threads={events.threads} activeThreadId={events.activeThread?.id ?? null} projects={bootstrap.projects} activeProjectId={bootstrap.activeProject.id} onClose={() => setSidebarVisibility(false)} onNew={() => { setPopover(null); threadSelectionGenerationRef.current += 1; dispatch({ type: 'thread-selected', thread: null }); }} onSelectThread={(thread) => { setPopover(null); void selectThread(thread); }} onSelectProject={(project) => { setPopover(null); void selectProject(project); }} onDialog={(next) => void openDialog(next)} />
    <section className="workspace-shell">
      <WorkspaceHeader sidebarOpen={sidebarOpen} thread={events.activeThread} project={bootstrap.activeProject} git={git} detailsOpen={detailsOpen} menu={visiblePopover === 'header-open' ? 'open' : visiblePopover === 'header-more' ? 'more' : visiblePopover === 'header-account' ? 'account' : null} networkEnabled={bootstrap.settings.network.shell} account={props.account} loggingOut={props.loggingOut} onMenu={(next) => { if (next && detailsOpenRef.current) return; setPopover(next ? `header-${next}` : null); }} onOpenSidebar={() => setSidebarVisibility(true)} onToggleDetails={toggleDetailsPanel} onArchive={() => void archiveActive()} onFork={() => void forkActive()} onRename={() => void renameActive()} onLogout={() => void props.onLogout()} onToast={setToast} />
      <section className="workspace-body"><section className="conversation-pane"><div className="conversation-scroll"><div className="conversation-inner">
        {!engineReady && <div className="setup-card"><ShieldCheck size={20} /><div><strong>{bootstrap.engine.state === 'missing-key' ? 'OPENAI_API_KEY 설정이 필요합니다' : bootstrap.engine.state === 'missing-binary' ? '로컬 Codex 빌드가 필요합니다' : 'Codex App Server를 시작할 수 없습니다'}</strong><p>{bootstrap.engine.message}</p><code>{bootstrap.engine.state === 'missing-key' ? 'OPENAI_API_KEY=your_openai_api_key_here' : bootstrap.engine.state === 'missing-binary' ? 'npm run codex:build' : 'App Server failed locally'}</code><span>키는 Local Server와 선택된 provider를 실행하는 App Server 자식 프로세스에만 존재하며 브라우저로 전달되지 않습니다.</span>{bootstrap.engine.state === 'failed' && <button className="secondary-action" onClick={() => void client.http('/api/engine/restart', { method: 'POST', body: '{}' }).then((engine) => setBootstrap((current) => current ? { ...current, engine: engine as BootstrapResponse['engine'] } : current)).catch((error: unknown) => setToast(error instanceof Error ? error.message : String(error)))}>Restart App Server</button>}</div></div>}
        {!events.activeThread && engineReady && <div className="empty-thread"><KodexMark compact /><h2>What would you like Kodex to build?</h2><p>{bootstrap.activeProject.path}</p><div className="suggestion-grid"><button onClick={() => setDraft('이 코드베이스의 구조와 핵심 흐름을 설명해줘')}><Code2 size={14} /> Explain this codebase</button><button onClick={() => setDraft('현재 로컬 변경 사항에서 버그와 회귀 가능성을 검토해줘')}><GitCommitHorizontal size={14} /> Review current changes</button><button onClick={() => setDraft('실패하는 테스트를 찾아 원인을 진단해줘')}><SquareTerminal size={14} /> Diagnose failing tests</button><button onClick={() => setDraft('필요하면 공식 Web Search와 허용된 네트워크 도구를 사용해 이 프로젝트를 개선해줘')}><ShieldCheck size={14} /> Improve with tools</button></div></div>}
        {items.map((item) => <ItemView key={item.id} item={item} liveText={events.liveText[item.id]} />)}
        {events.pendingRequests.map((pending) => <RequestCard key={`${pending.request.method}:${String(pending.request.id)}`} request={pending.request} owned={pending.owned} onResolve={resolveServerRequest} onError={rejectServerRequest} />)}
        {events.notices.map((notice, index) => <div className="policy-event" key={`${index}:${notice}`}><ShieldCheck size={13} />{notice}</div>)}
      </div></div>
      <Composer draft={draft} busy={busy} connected={connection === 'connected'} engineReady={engineReady} activeTurnId={events.activeTurnId} models={models} model={model} modelOpen={visiblePopover === 'composer-model'} effort={effort} settings={bootstrap.settings} git={git} onDraft={setDraft} onModel={(nextModel, nextEffort) => { setModel(nextModel); setEffort(nextEffort); }} onModelOpen={(open) => { if (open && detailsOpenRef.current) return; setPopover(open ? 'composer-model' : null); }} onSend={() => void sendDraft()} onInterrupt={() => { if (events.activeThread && events.activeTurnId) void client.rpc('turn/interrupt', { threadId: events.activeThread.id, turnId: events.activeTurnId }).catch((error: unknown) => setToast(error instanceof Error ? error.message : String(error))); }} />
      </section>
      {detailsOpen && <ChangesPanel git={git} selectedFile={selectedFile} diff={selectedDiff} onSelect={setSelectedFile} onClose={toggleDetailsPanel} onRefresh={() => void refreshGit()} />}
      </section>
    </section>
    <Dialogs dialog={dialog} bootstrap={bootstrap} automations={automations} skills={skills} apps={apps} plugins={plugins} mcpServers={mcpServers} archivedThreads={archivedThreads} authClient={props.authClient} workspaceId={props.workspaceId} codexConfig={codexConfig} onClose={closeDialog} onError={(error) => setToast(error instanceof Error ? error.message : String(error))} onCreateAutomation={async (input) => { await client.http('/api/automations', { method: 'POST', body: JSON.stringify(input) }); await refreshAutomations(); }} onRunAutomation={async (id) => { await client.http('/api/automations/run', { method: 'POST', body: JSON.stringify({ id }) }); await refreshAutomations(); setToast('자동화를 공식 Codex turn으로 시작했습니다.'); }} onDeleteAutomation={async (id) => { await client.http('/api/automations', { method: 'DELETE', body: JSON.stringify({ id }) }); await refreshAutomations(); }} onSettings={updateSettings} onAddProject={addProject} onRemoveProject={removeProject} onUnarchive={unarchiveThread} onKnowledgeRequest={knowledgeRequest} onAddMcp={async (name, url) => { if (!/^[A-Za-z0-9_-]+$/u.test(name)) throw new Error('MCP name may only contain letters, numbers, _ and -.'); await client.rpc('config/value/write', { keyPath: `mcp_servers.${name}`, value: { url }, mergeStrategy: 'upsert' }); await client.rpc('config/mcpServer/reload', undefined); setToast('Remote MCP configuration saved locally.'); await refreshData(); }} />
    {toast && <div className="toast" role="status">{toast}</div>}
  </main>;
}
