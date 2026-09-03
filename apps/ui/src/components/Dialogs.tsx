import type { AppInfo, ConfigReadResponse, McpServerStatus, PluginListResponse, SkillsListEntry, Thread } from '@kodex/codex-protocol';
import type {
  AutomationRecord, BootstrapResponse, KodexSettings, ProjectRecord,
  RepositoryIndexResponse, RepositoryPreviewResponse,
} from '@kodex/kodex-api';
import { ArchiveRestore, BookOpenText, Box, Clock3, LoaderCircle, Network, Play, Plus, Search, ShieldCheck, Trash2, WandSparkles, X } from 'lucide-react';
import { type FormEvent, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ProductAuthClient } from '../auth/product-auth';
import { KodexMark } from './Brand';
import { SavedHistoryDialog } from './SavedHistoryDialog';

export type DialogName = 'automations' | 'skills' | 'archived' | 'history' | 'knowledge' | 'settings' | null;

interface AsyncActionProps {
  pendingAction: string | null;
  runAction: (key: string, action: () => Promise<void>, onSuccess?: () => void) => void;
}

export function Dialogs(props: {
  dialog: DialogName;
  bootstrap: BootstrapResponse;
  automations: AutomationRecord[];
  skills: SkillsListEntry[];
  apps: AppInfo[];
  plugins: PluginListResponse | null;
  mcpServers: McpServerStatus[];
  archivedThreads: Thread[];
  authClient: ProductAuthClient;
  codexConfig: ConfigReadResponse | null;
  workspaceId: string;
  onClose: () => void;
  onError: (error: unknown) => void;
  onCreateAutomation: (input: { name: string; prompt: string; intervalMinutes: number }) => Promise<void>;
  onRunAutomation: (id: string) => Promise<void>;
  onDeleteAutomation: (id: string) => Promise<void>;
  onSettings: (settings: Partial<KodexSettings>) => Promise<void>;
  onAddMcp: (name: string, url: string) => Promise<void>;
  onAddProject: (path: string, name?: string) => Promise<void>;
  onRemoveProject: (project: ProjectRecord) => Promise<void>;
  onUnarchive: (thread: Thread) => Promise<void>;
  onKnowledgeRequest: <T>(pathname: string, init?: RequestInit) => Promise<T>;
  onLocalRequest: <T>(pathname: string, init?: RequestInit) => Promise<T>;
}) {
  const { dialog, onClose } = props;
  const dialogRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const pendingActionRef = useRef<string | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);

  useEffect(() => {
    if (!dialog) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => closeButtonRef.current?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (!pendingActionRef.current) onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
      ) ?? []);
      if (!focusable.length) return;
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      if (event.shiftKey && (document.activeElement === first || !dialogRef.current?.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !dialogRef.current?.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener('keydown', onKeyDown);
      previousFocus?.focus();
    };
  }, [dialog, onClose]);

  const runAction: AsyncActionProps['runAction'] = (key, action, onSuccess) => {
    if (pendingActionRef.current) return;
    pendingActionRef.current = key;
    setPendingAction(key);
    void action()
      .then(() => onSuccess?.())
      .catch(props.onError)
      .finally(() => {
        pendingActionRef.current = null;
        setPendingAction(null);
      });
  };

  if (!props.dialog) return null;
  const titleId = `kodex-dialog-title-${props.dialog}`;
  const requestClose = () => { if (!pendingActionRef.current) props.onClose(); };
  return <div className="dialog-backdrop" onMouseDown={requestClose}><section ref={dialogRef} className={`app-dialog ${props.dialog === 'settings' ? 'settings-dialog' : ''} ${props.dialog === 'history' ? 'history-dialog' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-busy={pendingAction !== null} onMouseDown={(event) => event.stopPropagation()}>
    <header className="dialog-header"><div className="dialog-title-lockup"><KodexMark compact /><div><span>{props.dialog === 'history' ? 'Product DB projection' : 'Local Kodex workspace'}</span><h2 id={titleId}>{props.dialog === 'automations' ? 'Automations' : props.dialog === 'skills' ? 'Skills & tools' : props.dialog === 'archived' ? 'Archived threads' : props.dialog === 'history' ? '저장된 DB 히스토리' : props.dialog === 'knowledge' ? 'Knowledge / RAG' : 'Settings'}</h2></div></div><button ref={closeButtonRef} className="icon-button" aria-label="Close" disabled={pendingAction !== null} onClick={requestClose}><X size={16} /></button></header>
    {props.dialog === 'automations' && <AutomationDialog {...props} pendingAction={pendingAction} runAction={runAction} />}
    {props.dialog === 'skills' && <SkillsDialog skills={props.skills} apps={props.apps} plugins={props.plugins} mcpServers={props.mcpServers} />}
    {props.dialog === 'archived' && <ArchivedDialog threads={props.archivedThreads} onUnarchive={props.onUnarchive} pendingAction={pendingAction} runAction={runAction} />}
    {props.dialog === 'history' && <SavedHistoryDialog client={props.authClient} workspaceId={props.workspaceId} />}
    {props.dialog === 'knowledge' && <KnowledgeDialog
      project={props.bootstrap.activeProject}
      request={props.onKnowledgeRequest}
      localRequest={props.onLocalRequest}
    />}
    {props.dialog === 'settings' && <SettingsDialog {...props} pendingAction={pendingAction} runAction={runAction} />}
  </section></div>;
}

interface KnowledgeDocumentDto {
  createdAt: string;
  id: string;
  sourceId: string;
  sourceType: string;
  title: string | null;
  updatedAt: string;
}

interface KnowledgeCitationDto {
  chunkId: string;
  content: string;
  documentId: string;
  documentTitle: string | null;
  rank: number;
  score: number;
  sourceType: string;
}

function KnowledgeDialog(props: {
  project: ProjectRecord;
  request: <T>(pathname: string, init?: RequestInit) => Promise<T>;
  localRequest: <T>(pathname: string, init?: RequestInit) => Promise<T>;
}) {
  const { localRequest, project, request } = props;
  const [documents, setDocuments] = useState<KnowledgeDocumentDto[]>([]);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [query, setQuery] = useState('');
  const [citations, setCitations] = useState<KnowledgeCitationDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [searching, setSearching] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [repositoryPreview, setRepositoryPreview] = useState<RepositoryPreviewResponse | null>(null);
  const [repositoryResult, setRepositoryResult] = useState<RepositoryIndexResponse | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(() => new Set());
  const [repositoryConsent, setRepositoryConsent] = useState(false);
  const [repositoryPhase, setRepositoryPhase] = useState<'idle' | 'previewing' | 'ready' | 'indexing' | 'complete' | 'cancelled'>('idle');
  const repositoryAbortRef = useRef<AbortController | null>(null);
  const activeProjectIdRef = useRef(project.id);
  useLayoutEffect(() => { activeProjectIdRef.current = project.id; }, [project.id]);

  const refresh = useCallback(async (): Promise<void> => {
    const result = await request<{ data: KnowledgeDocumentDto[] }>('/api/knowledge/documents?limit=100');
    setDocuments(result.data);
  }, [request]);

  useEffect(() => {
    let active = true;
    void refresh().catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : String(reason));
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [refresh]);

  useEffect(() => {
    repositoryAbortRef.current?.abort();
    repositoryAbortRef.current = null;
    setRepositoryPreview(null);
    setRepositoryResult(null);
    setSelectedPaths(new Set());
    setRepositoryConsent(false);
    setRepositoryPhase('idle');
    return () => repositoryAbortRef.current?.abort();
  }, [project.id]);

  async function previewRepository(): Promise<void> {
    if (repositoryPhase === 'previewing' || repositoryPhase === 'indexing') return;
    const controller = new AbortController();
    repositoryAbortRef.current = controller;
    setRepositoryPhase('previewing');
    setRepositoryPreview(null);
    setRepositoryResult(null);
    setSelectedPaths(new Set());
    setRepositoryConsent(false);
    setError('');
    try {
      const preview = await localRequest<RepositoryPreviewResponse>('/api/knowledge/repository/preview', {
        method: 'POST',
        body: JSON.stringify({ projectId: project.id }),
        signal: controller.signal,
      });
      if (controller.signal.aborted || activeProjectIdRef.current !== project.id) return;
      setRepositoryPreview(preview);
      setRepositoryPhase('ready');
    } catch (reason) {
      if (controller.signal.aborted) setRepositoryPhase('cancelled');
      else {
        setRepositoryPhase('idle');
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      if (repositoryAbortRef.current === controller) repositoryAbortRef.current = null;
    }
  }

  async function confirmRepository(): Promise<void> {
    if (!repositoryPreview || !repositoryConsent || selectedPaths.size < 1 || repositoryPhase !== 'ready') return;
    const controller = new AbortController();
    repositoryAbortRef.current = controller;
    setRepositoryPhase('indexing');
    setError('');
    try {
      const result = await localRequest<RepositoryIndexResponse>('/api/knowledge/repository/confirm', {
        method: 'POST',
        body: JSON.stringify({
          previewToken: repositoryPreview.previewToken,
          projectId: project.id,
          paths: repositoryPreview.files.filter((file) => selectedPaths.has(file.path)).map((file) => file.path),
        }),
        signal: controller.signal,
      });
      if (controller.signal.aborted || activeProjectIdRef.current !== project.id) return;
      setRepositoryResult(result);
      setRepositoryPhase('complete');
      setRepositoryConsent(false);
      await refresh();
    } catch (reason) {
      if (controller.signal.aborted) setRepositoryPhase('cancelled');
      else {
        setRepositoryPhase('idle');
        setRepositoryPreview(null);
        setSelectedPaths(new Set());
        setRepositoryConsent(false);
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      if (repositoryAbortRef.current === controller) repositoryAbortRef.current = null;
    }
  }

  function cancelRepository(): void {
    repositoryAbortRef.current?.abort();
    repositoryAbortRef.current = null;
    setRepositoryPhase('cancelled');
    setRepositoryPreview(null);
    setSelectedPaths(new Set());
    setRepositoryConsent(false);
  }

  function toggleRepositoryPath(relativePath: string): void {
    if (!repositoryPreview || repositoryPhase !== 'ready') return;
    setSelectedPaths((current) => {
      const next = new Set(current);
      if (next.has(relativePath)) next.delete(relativePath);
      else if (next.size < repositoryPreview.limits.maxSelectedFiles) next.add(relativePath);
      return next;
    });
    setRepositoryConsent(false);
  }

  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (saving || !title.trim() || !content.trim()) return;
    setSaving(true);
    setError('');
    try {
      await request('/api/knowledge/documents', {
        method: 'POST',
        body: JSON.stringify({ documentId: crypto.randomUUID(), title: title.trim(), content }),
      });
      setTitle('');
      setContent('');
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  }

  async function remove(document: KnowledgeDocumentDto): Promise<void> {
    if (deletingId) return;
    setDeletingId(document.id);
    setError('');
    try {
      await request(`/api/knowledge/documents/${encodeURIComponent(document.id)}`, { method: 'DELETE' });
      setDocuments((current) => current.filter((entry) => entry.id !== document.id));
      setCitations((current) => current.filter((entry) => entry.documentId !== document.id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setDeletingId(null);
    }
  }

  async function search(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (searching || !query.trim()) return;
    setSearching(true);
    setHasSearched(false);
    setError('');
    try {
      const result = await request<{ citations: KnowledgeCitationDto[] }>('/api/knowledge/query', {
        method: 'POST',
        body: JSON.stringify({ query: query.trim(), topK: 5 }),
      });
      setCitations(result.citations);
      setHasSearched(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSearching(false);
    }
  }

  return <div className="dialog-body knowledge-dialog">
    <div className="dialog-intro"><div className="dialog-icon"><BookOpenText size={20} /></div><div><h3>Private user knowledge</h3><p>RAG를 켜면 등록 문서 chunk, 이 화면의 검색 미리보기 질의, 일반 agent turn의 첫 text 질의가 OpenAI Embeddings API로 전송됩니다. 자동화 prompt는 별도 opt-in일 때만 전송됩니다. Codex 생성 provider를 Local로 바꿔도 RAG provider는 OpenAI이며, repository/source tree·clipboard·전체 Codex history는 자동 전송하지 않습니다. 문서는 같은 workspace의 다른 사용자와 공유되지 않습니다.</p></div></div>
    {error && <p className="knowledge-error" role="alert">{error}</p>}
    <section className="repository-knowledge" aria-label="Repository indexing">
      <div className="repository-heading"><div><h4>현재 project 파일 인덱싱</h4><p><strong>{project.name}</strong>의 후보 경로와 크기만 먼저 표시합니다. 자동 인덱싱하지 않으며 선택한 파일만 확인 후 처리합니다.</p></div><button className="secondary-action" type="button" disabled={repositoryPhase === 'previewing' || repositoryPhase === 'indexing'} onClick={() => void previewRepository()}>{repositoryPhase === 'previewing' ? <LoaderCircle className="spin" size={12} /> : <Search size={12} />} {repositoryPreview ? '후보 다시 확인' : '후보 파일 확인'}</button></div>
      {repositoryPhase === 'previewing' && <div className="repository-actions"><p className="repository-status" role="status"><LoaderCircle className="spin" size={12} /> 후보 경로와 안전 상태를 확인하는 중…</p><button className="secondary-action" type="button" onClick={cancelRepository}>취소</button></div>}
      {repositoryPhase === 'cancelled' && <p className="repository-status" role="status">요청 표시를 취소했습니다. 서버에서 이미 시작된 파일은 완료될 수 있으므로 문서 목록을 다시 확인하고, 재시도하려면 새 preview를 만드세요.</p>}
      {repositoryPreview && <>
        <div className="repository-policy"><span>후보 {repositoryPreview.files.length}개</span><span>최대 선택 {repositoryPreview.limits.maxSelectedFiles}개</span><span>총 {Math.floor(repositoryPreview.limits.maxTotalBytes / 1024)} KiB 이하</span>{repositoryPreview.truncated && <span>탐색 상한 도달</span>}</div>
        {repositoryPreview.excluded.length > 0 && <div className="repository-exclusions" aria-label="제외 요약">{repositoryPreview.excluded.map((entry) => <span key={entry.reason}>{entry.reason}: {entry.count}</span>)}</div>}
        <div className="repository-file-list" aria-label="Repository candidate files">{repositoryPreview.files.map((file) => <label key={file.path}><input type="checkbox" checked={selectedPaths.has(file.path)} disabled={repositoryPhase !== 'ready'} onChange={() => toggleRepositoryPath(file.path)} /><span title={file.path}>{file.path}</span><code>{file.sizeBytes.toLocaleString('ko-KR')} B · eligible</code></label>)}{repositoryPreview.files.length === 0 && <p className="dialog-empty">안전 정책을 통과한 후보 파일이 없습니다.</p>}</div>
        <label className="repository-consent"><input type="checkbox" checked={repositoryConsent} disabled={repositoryPhase !== 'ready' || selectedPaths.size === 0} onChange={(event) => setRepositoryConsent(event.target.checked)} /><span>선택한 {selectedPaths.size}개 파일의 텍스트가 private RAG chunk와 embedding으로 저장·전송될 수 있음을 확인합니다.</span></label>
        <div className="repository-actions"><button className="primary-action" type="button" disabled={repositoryPhase !== 'ready' || !repositoryConsent || selectedPaths.size === 0} onClick={() => void confirmRepository()}>{repositoryPhase === 'indexing' && <LoaderCircle className="spin" size={12} />} 선택 파일 인덱싱</button>{(repositoryPhase === 'previewing' || repositoryPhase === 'indexing') && <button className="secondary-action" type="button" onClick={cancelRepository}>취소</button>}</div>
      </>}
      {repositoryPhase === 'indexing' && <p className="repository-status" role="status"><LoaderCircle className="spin" size={12} /> 선택 파일을 다시 검증하고 chunk/embedding을 저장하는 중…</p>}
      {repositoryResult && <div className="repository-result" role="status"><strong>인덱싱 완료</strong><span>저장/갱신 {repositoryResult.indexed}개 · 변경 없음 {repositoryResult.unchanged}개</span>{repositoryResult.files.map((file) => <span key={file.path}>{file.path} · {file.status} · {file.chunkCount} chunks</span>)}</div>}
      <p className="repository-deletion-note">선택 해제되거나 디스크에서 삭제된 파일은 자동으로 RAG에서 제거되지 않습니다. 아래 ‘내 문서’의 삭제 버튼으로 명시적으로 제거하세요.</p>
    </section>
    <h4 className="dialog-section-title">수동 텍스트 등록</h4>
    <form className="knowledge-form" onSubmit={(event) => void save(event)}>
      <label>문서 제목<input maxLength={200} required disabled={saving} value={title} onChange={(event) => setTitle(event.target.value)} /></label>
      <label>텍스트 원문<textarea required disabled={saving} value={content} onChange={(event) => setContent(event.target.value)} placeholder="검색에 사용할 텍스트를 붙여 넣으세요." /></label>
      <button className="primary-action" type="submit" disabled={saving || !title.trim() || !content.trim()}>{saving && <LoaderCircle className="spin" size={12} />} {saving ? '임베딩 중…' : '문서 등록'}</button>
    </form>
    <h4 className="dialog-section-title">내 문서</h4>
    <div className="knowledge-list" aria-busy={loading}>{loading && <p className="dialog-empty"><LoaderCircle className="spin" size={13} /> 문서를 불러오는 중…</p>}{!loading && documents.map((document) => <div className="knowledge-row" key={document.id}><div><strong>{document.title ?? '제목 없음'}</strong><span>{document.sourceType === 'repository_file' ? 'Repository file · 명시적 삭제만 적용' : 'Manual text'} · {new Date(document.updatedAt).toLocaleString('ko-KR')}</span></div><button className="icon-button" aria-label={`${document.title ?? '문서'} RAG에서 명시적으로 삭제`} disabled={deletingId !== null} onClick={() => void remove(document)}>{deletingId === document.id ? <LoaderCircle className="spin" size={13} /> : <Trash2 size={13} />}</button></div>)}{!loading && documents.length === 0 && <p className="dialog-empty">등록된 문서가 없습니다.</p>}</div>
    <h4 className="dialog-section-title">검색 미리보기</h4>
    <form className="knowledge-search" onSubmit={(event) => void search(event)}><input aria-label="Knowledge 검색어" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="문서에서 찾을 내용을 입력하세요." disabled={searching} /><button className="secondary-action" type="submit" disabled={searching || !query.trim()}>{searching ? <LoaderCircle className="spin" size={12} /> : <Search size={12} />} 검색</button></form>
    <div className="citation-list" aria-live="polite">{citations.map((citation) => <article className="citation-row" key={citation.chunkId}><header><strong>{citation.documentTitle ?? citation.documentId}</strong><span>{citation.sourceType === 'repository_file' ? 'repository' : 'manual'} · #{citation.rank} · {citation.score.toFixed(4)}</span></header><p>{citation.content}</p><code>document:{citation.documentId} · chunk:{citation.chunkId}</code></article>)}{!searching && hasSearched && citations.length === 0 && <p className="dialog-empty">기준 점수 이상의 검색 결과가 없습니다.</p>}</div>
  </div>;
}

function ArchivedDialog({ threads, onUnarchive, pendingAction, runAction }: { threads: Thread[]; onUnarchive: (thread: Thread) => Promise<void> } & AsyncActionProps) {
  return <div className="dialog-body"><div className="dialog-intro"><div className="dialog-icon"><ArchiveRestore size={20} /></div><div><h3>Official Codex archive</h3><p>Archived threads are read from and restored through App Server v2.</p></div></div>
    <div className="automation-list">{threads.map((thread) => <div className="automation-row" key={thread.id}><div><strong>{thread.name || thread.preview || thread.id}</strong><span>{thread.cwd}</span></div><button className="secondary-action" disabled={pendingAction !== null} onClick={() => runAction(`unarchive-${thread.id}`, () => onUnarchive(thread))}><ArchiveRestore size={12} /> Restore</button></div>)}{threads.length === 0 && <p className="dialog-empty">보관된 로컬 스레드가 없습니다.</p>}</div>
  </div>;
}

function AutomationDialog(props: Parameters<typeof Dialogs>[0] & AsyncActionProps) {
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [minutes, setMinutes] = useState(60);
  return <div className="dialog-body"><div className="dialog-intro"><div className="dialog-icon"><Clock3 size={20} /></div><div><h3>Local scheduler</h3><p>Prompts and schedules remain in `.kodex-data`; turns use the official App Server.</p></div></div>
    <div className="automation-form"><input aria-label="Automation name" disabled={props.pendingAction !== null} placeholder="Automation name" value={name} onChange={(event) => setName(event.target.value)} /><textarea aria-label="Task prompt" disabled={props.pendingAction !== null} placeholder="Task prompt" value={prompt} onChange={(event) => setPrompt(event.target.value)} /><label>반복 간격 (분)<input type="number" min={1} max={10080} disabled={props.pendingAction !== null} value={minutes} onChange={(event) => setMinutes(Number(event.target.value))} /></label><button className="primary-action" disabled={!prompt.trim() || props.pendingAction !== null} onClick={() => props.runAction('create-automation', () => props.onCreateAutomation({ name, prompt, intervalMinutes: minutes }), () => { setName(''); setPrompt(''); })}><Plus size={13} /> {props.pendingAction === 'create-automation' ? 'Saving…' : 'Save automation'}</button></div>
    <div className="automation-list">{props.automations.map((entry) => <div className="automation-row" key={entry.id}><span className={`automation-status ${entry.enabled ? '' : 'paused'}`} /><div><strong>{entry.name}</strong><span>{entry.intervalMinutes}분마다 · {entry.lastStatus}</span>{entry.lastError && <span className="error-copy">{entry.lastError}</span>}</div><button className="secondary-action" disabled={props.pendingAction !== null} onClick={() => props.runAction(`run-automation-${entry.id}`, () => props.onRunAutomation(entry.id))}><Play size={12} /> Run</button><button className="icon-button" aria-label={`Delete ${entry.name}`} disabled={props.pendingAction !== null} onClick={() => props.runAction(`delete-automation-${entry.id}`, () => props.onDeleteAutomation(entry.id))}><X size={13} /></button></div>)}{props.automations.length === 0 && <p className="dialog-empty">저장된 로컬 자동화가 없습니다.</p>}</div>
  </div>;
}

function SkillsDialog({ skills, apps, plugins, mcpServers }: { skills: SkillsListEntry[]; apps: AppInfo[]; plugins: PluginListResponse | null; mcpServers: McpServerStatus[] }) {
  const allSkills = skills.flatMap((entry) => entry.skills);
  return <div className="dialog-body"><div className="dialog-intro"><div className="dialog-icon"><WandSparkles size={20} /></div><div><h3>Official Codex integrations</h3><p>Inventory is read directly from App Server v2. Remote dependencies are not blanket-disabled.</p></div></div>
    <h4 className="dialog-section-title">Skills</h4><div className="skills-grid">{allSkills.map((skill) => <div className={`skill-card ${skill.enabled ? '' : 'is-disabled'}`} key={skill.path}><WandSparkles size={17} /><div><strong>{skill.name}</strong><span>{skill.description}</span><code>{skill.path}</code></div><span className={`status-pill ${skill.enabled ? '' : 'is-disabled'}`}>{skill.scope}</span></div>)}{allSkills.length === 0 && <p className="dialog-empty">App Server가 발견한 skill이 없습니다.</p>}</div>
    <h4 className="dialog-section-title">MCP servers</h4><div className="integration-list">{mcpServers.map((server) => <div className="integration-row" key={server.name}><Network size={15} /><div><strong>{server.name}</strong><span>{server.runtimeStatus ?? server.authStatus}</span></div><span className="status-pill">{Object.keys(server.tools).length} tools</span></div>)}{mcpServers.length === 0 && <p className="dialog-empty">Configured MCP server가 없습니다.</p>}</div>
    <h4 className="dialog-section-title">Apps & plugins</h4><div className="integration-list">{apps.map((app) => <div className="integration-row" key={app.id}><Box size={15} /><div><strong>{app.name}</strong><span>{app.description ?? 'Codex app'}</span></div><span className={`status-pill ${app.isAccessible && app.isEnabled ? '' : 'is-disabled'}`}>{app.isAccessible && app.isEnabled ? 'Available' : 'Unavailable'}</span></div>)}<div className="integration-row"><WandSparkles size={15} /><div><strong>Plugin marketplaces</strong><span>Official App Server response</span></div><span className="status-pill">{plugins?.marketplaces.length ?? 0}</span></div></div>
  </div>;
}

function SettingsDialog(props: Parameters<typeof Dialogs>[0] & AsyncActionProps) {
  const [tab, setTab] = useState('General');
  const [mcpName, setMcpName] = useState('');
  const [mcpUrl, setMcpUrl] = useState('');
  const [projectPath, setProjectPath] = useState('');
  const [projectName, setProjectName] = useState('');
  const settings = props.bootstrap.settings;
  const [providerMode, setProviderMode] = useState(settings.provider.mode);
  const [providerBaseUrl, setProviderBaseUrl] = useState(settings.provider.baseUrl);
  const [providerModel, setProviderModel] = useState(settings.provider.model);
  const tabs = ['General', 'Agent', 'Network & MCP', 'About Kodex'];
  const toggle = (patch: Partial<KodexSettings>) => props.runAction('update-settings', () => props.onSettings(patch));
  return <div className="settings-layout"><nav className="settings-nav" aria-label="Settings sections">{tabs.map((name) => <button className={tab === name ? 'is-selected' : ''} aria-current={tab === name ? 'page' : undefined} disabled={props.pendingAction !== null} key={name} onClick={() => setTab(name)}>{name}</button>)}</nav><div className="settings-content"><div className="settings-page-title"><h3>{tab}</h3><p>Kodex local host settings</p></div>
    {tab === 'General' && <>
      <div className="setting-row"><div><strong>Workspace</strong><span>{props.bootstrap.activeProject.path}</span></div><span className="status-pill">Local</span></div>
      <div className="setting-row"><div><strong>Storage</strong><span>.kodex-data · official CODEX_HOME format</span></div><span className="status-pill">Local</span></div>
      <div className="setting-row"><div><strong>Sidebar</strong><span>Persisted by Local Server, not browser storage.</span></div><button className={`toggle-control ${settings.sidebarOpen ? 'is-on' : ''}`} role="switch" aria-label="Show sidebar" aria-checked={settings.sidebarOpen} disabled={props.pendingAction !== null} onClick={() => toggle({ sidebarOpen: !settings.sidebarOpen })}><span /></button></div>
      <h4 className="dialog-section-title">Local projects</h4>
      <div className="integration-list">{props.bootstrap.projects.map((project) => <div className="integration-row" key={project.id}><Box size={15} /><div><strong>{project.name}</strong><span>{project.path}</span></div>{props.bootstrap.projects.length > 1 && <button className="icon-button" aria-label={`Remove ${project.name}`} disabled={props.pendingAction !== null} onClick={() => props.runAction(`remove-project-${project.id}`, () => props.onRemoveProject(project))}><Trash2 size={13} /></button>}</div>)}</div>
      <div className="mcp-form"><input aria-label="Absolute project path" disabled={props.pendingAction !== null} placeholder="D:\\absolute\\project\\path" value={projectPath} onChange={(event) => setProjectPath(event.target.value)} /><input aria-label="Optional project display name" disabled={props.pendingAction !== null} placeholder="Optional display name" value={projectName} onChange={(event) => setProjectName(event.target.value)} /><button className="primary-action" disabled={!projectPath.trim() || props.pendingAction !== null} onClick={() => props.runAction('add-project', () => props.onAddProject(projectPath, projectName || undefined), () => { setProjectPath(''); setProjectName(''); })}><Plus size={13} /> {props.pendingAction === 'add-project' ? 'Adding…' : 'Add project'}</button></div>
    </>}
    {tab === 'Agent' && <>
      <div className="setting-row"><div><strong>Codex source build</strong><span>{props.bootstrap.engine.version ?? props.bootstrap.engine.binary ?? 'Run npm run codex:build'}</span></div><span className="status-pill">{props.bootstrap.engine.binarySource ?? 'missing'}</span></div>
      <div className="setting-row"><div><strong>Official config</strong><span>{props.codexConfig ? `${props.codexConfig.layers?.length ?? 0} layers read for this workspace` : 'Unavailable until App Server is connected'}</span></div><span className="status-pill">App Server v2</span></div>
      <div className="setting-row"><div><strong>Model provider</strong><span>OpenAI uses `OPENAI_API_KEY`; local mode accepts only a loopback Responses API endpoint.</span></div><select aria-label="Model provider" value={providerMode} disabled={props.pendingAction !== null} onChange={(event) => setProviderMode(event.target.value as KodexSettings['provider']['mode'])}><option value="openai">OpenAI</option><option value="local">OpenAI-compatible local</option></select></div>
      {providerMode === 'local' && <div className="mcp-form"><input aria-label="Local Responses API base URL" disabled={props.pendingAction !== null} placeholder="http://127.0.0.1:8080/v1" value={providerBaseUrl} onChange={(event) => setProviderBaseUrl(event.target.value)} /><input aria-label="Local model name" disabled={props.pendingAction !== null} placeholder="local-model-name" value={providerModel} onChange={(event) => setProviderModel(event.target.value)} /><span>The pinned Codex build supports the Responses wire API only. Tool calling and streaming must be implemented by the local server.</span></div>}
      {providerMode === 'openai' && <div className="mcp-form"><input aria-label="Optional OpenAI model override" disabled={props.pendingAction !== null} placeholder="Leave blank for App Server default" value={providerModel} onChange={(event) => setProviderModel(event.target.value)} /><span>The official OpenAI endpoint is selected by Codex; custom remote base URLs are not accepted here.</span></div>}
      <button className="primary-action" disabled={props.pendingAction !== null || (providerMode === 'local' && (!providerBaseUrl.trim() || !providerModel.trim()))} onClick={() => props.runAction('apply-provider', () => props.onSettings({ provider: { mode: providerMode, baseUrl: providerMode === 'local' ? providerBaseUrl.trim() : '', model: providerModel.trim() } }))}>{props.pendingAction === 'apply-provider' ? 'Applying…' : 'Apply provider and restart App Server'}</button>
      <div className="setting-row"><div><strong>Sandbox</strong><span>Applied through official thread/turn parameters.</span></div><select aria-label="Sandbox policy" value={settings.sandbox} disabled={props.pendingAction !== null} onChange={(event) => toggle({ sandbox: event.target.value as KodexSettings['sandbox'] })}><option value="read-only">read-only</option><option value="workspace-write">workspace-write</option><option value="danger-full-access">danger-full-access</option></select></div>
      <div className="setting-row"><div><strong>Approval policy</strong><span>Official App Server approval requests are shown in the conversation.</span></div><select aria-label="Approval policy" value={settings.approvalPolicy} disabled={props.pendingAction !== null} onChange={(event) => toggle({ approvalPolicy: event.target.value as KodexSettings['approvalPolicy'] })}><option value="untrusted">untrusted</option><option value="on-request">on-request</option><option value="never">never</option></select></div>
    </>}
    {tab === 'Network & MCP' && <>
      <div className="setting-row"><div><strong>Shell network</strong><span>Controls `SandboxPolicy.networkAccess` for workspace/read-only turns.</span></div><button className={`toggle-control ${settings.network.shell ? 'is-on' : ''}`} role="switch" aria-label="Shell network" aria-checked={settings.network.shell} disabled={props.pendingAction !== null} onClick={() => toggle({ network: { ...settings.network, shell: !settings.network.shell } })}><span /></button></div>
      <div className="setting-row"><div><strong>Web Search</strong><span>Uses official `web_search` mode, separate from shell networking.</span></div><button className={`toggle-control ${settings.network.webSearch ? 'is-on' : ''}`} role="switch" aria-label="Web Search" aria-checked={settings.network.webSearch} disabled={props.pendingAction !== null} onClick={() => toggle({ network: { ...settings.network, webSearch: !settings.network.webSearch } })}><span /></button></div>
      <div className="setting-row"><div><strong>Remote MCP</strong><span>Configured in Kodex CODEX_HOME and authenticated through local environment variables.</span></div><span className="status-pill">Official config</span></div>
      <div className="mcp-form"><input aria-label="Remote MCP server name" disabled={props.pendingAction !== null} placeholder="server-name" value={mcpName} onChange={(event) => setMcpName(event.target.value)} /><input aria-label="Remote MCP URL" disabled={props.pendingAction !== null} placeholder="https://example.com/mcp" value={mcpUrl} onChange={(event) => setMcpUrl(event.target.value)} /><button className="primary-action" disabled={!mcpName.trim() || !mcpUrl.trim() || props.pendingAction !== null} onClick={() => props.runAction('add-mcp', () => props.onAddMcp(mcpName, mcpUrl), () => { setMcpName(''); setMcpUrl(''); })}><Plus size={13} /> {props.pendingAction === 'add-mcp' ? 'Adding…' : 'Add remote MCP'}</button><span>Secrets are not entered here. Reference environment variables in official Codex config when authentication is needed.</span></div>
    </>}
    {tab === 'About Kodex' && <div className="about-kodex"><KodexMark /><h3>Kodex</h3><p>Local UI + Local Server + official Codex App Server</p><span>API-key authentication · local application state · network-capable tools under official sandbox and approvals</span><div className="about-details"><ShieldCheck size={15} /> The browser never receives `OPENAI_API_KEY`.</div></div>}
  </div></div>;
}
