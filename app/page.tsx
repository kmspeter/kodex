"use client";

import { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft, ArrowRight, Bell, Box, Check, ChevronDown, ChevronRight, CircleDot,
  Clock3, Code2, Columns2, Copy, ExternalLink, FileCode2, Folder, GitBranch,
  GitCommitHorizontal, History, ImageIcon, Laptop, LayoutGrid, Mic, MoreHorizontal,
  PanelLeftClose, Paperclip, Play, Plus, Search, Settings, SlidersHorizontal,
  Sparkles, SquareTerminal, WandSparkles, X,
} from 'lucide-react';

type DialogName = 'automations' | 'skills' | 'settings' | 'handoff' | null;
type MenuName = 'project' | 'open' | 'permissions' | 'model' | 'more' | 'context' | null;
type Thread = { id: string; title: string; project: string; time: string };

const initialThreads: Thread[] = [
  { id: 'kodex-shell', title: 'Kodex 데스크톱 UI 완성', project: 'kodex-ui', time: '지금' },
  { id: 'responsive', title: '좁은 창 레이아웃 점검', project: 'kodex-ui', time: '18분' },
  { id: 'review-panel', title: '변경 검토 패널 정리', project: 'kodex-ui', time: '1시간' },
];
const projects = ['kodex-ui', 'kodex-core', 'ui-reference'];
const changedFiles = [
  { name: 'app/page.tsx', added: 286, removed: 174 },
  { name: 'app/globals.css', added: 311, removed: 203 },
  { name: 'app/layout.tsx', added: 8, removed: 8 },
  { name: 'public/og.png', added: 1, removed: 1 },
];
const diffLines = [
  { n: '73', kind: 'context', text: 'const [sidebarOpen, setSidebarOpen] = useState(true);' },
  { n: '74', kind: 'removed', text: "const productName = 'Desktop Agent UI';" },
  { n: '74', kind: 'added', text: "const productName = 'Kodex';" },
  { n: '75', kind: 'added', text: 'const [detailPanel, setDetailPanel] = useState(false);' },
  { n: '76', kind: 'added', text: 'const [activeMenu, setActiveMenu] = useState(null);' },
];

function KodexMark({ compact = false }: { compact?: boolean }) {
  return <span className={`kodex-mark ${compact ? 'is-compact' : ''}`} aria-hidden="true"><span>K</span></span>;
}

function SidebarItem({ icon, children, active = false, onClick }: {
  icon: React.ReactNode; children: React.ReactNode; active?: boolean; onClick: () => void;
}) {
  return <button className={`sidebar-item ${active ? 'is-active' : ''}`} onClick={onClick}>
    <span className="sidebar-icon">{icon}</span><span>{children}</span>
  </button>;
}

function Popover({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <div className={`popover ${className}`}>{children}</div>;
}

export default function Home() {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [dialog, setDialog] = useState<DialogName>(null);
  const [activeMenu, setActiveMenu] = useState<MenuName>(null);
  const [activeThread, setActiveThread] = useState(initialThreads[0].id);
  const [activeProject, setActiveProject] = useState(projects[0]);
  const [draft, setDraft] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [settingsTab, setSettingsTab] = useState('General');
  const [selectedFile, setSelectedFile] = useState(changedFiles[0].name);
  const [model, setModel] = useState('GPT-5.6 Sol');
  const [permission, setPermission] = useState('Default permissions');
  const [toast, setToast] = useState('');
  const [threadTitle, setThreadTitle] = useState(initialThreads[0].title);
  const [userPrompt, setUserPrompt] = useState(
    'Windows Codex 앱과 동일한 화면으로 다시 만들어줘. 제품 로고와 이름만 Kodex로 바꾸고, 작업 로그는 이 프로젝트 내용으로 맞춰줘.',
  );
  const isNewThread = activeThread === 'new';

  const filteredThreads = useMemo(() => {
    const query = searchQuery.trim().toLocaleLowerCase();
    if (!query) return initialThreads;
    return initialThreads.filter((thread) => `${thread.title} ${thread.project}`.toLocaleLowerCase().includes(query));
  }, [searchQuery]);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(''), 2200);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setActiveMenu(null); setDialog(null); }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const selectThread = (thread: Thread) => {
    setActiveThread(thread.id); setThreadTitle(thread.title); setActiveProject(thread.project);
    setDetailsOpen(false); setActiveMenu(null);
  };
  const startNewThread = () => {
    setActiveThread('new'); setThreadTitle('New thread'); setDraft(''); setDetailsOpen(false);
  };
  const sendDraft = () => {
    const prompt = draft.trim();
    if (!prompt) return;
    setUserPrompt(prompt); setThreadTitle(prompt.length > 38 ? `${prompt.slice(0, 38)}…` : prompt);
    setActiveThread('custom'); setDraft(''); setActiveMenu(null); setToast('새 Kodex 작업을 시작했습니다');
  };
  const notify = (message: string) => { setActiveMenu(null); setToast(message); };

  return (
    <main className={`app-shell ${sidebarOpen ? '' : 'sidebar-collapsed'}`} onClick={() => activeMenu && setActiveMenu(null)}>
      {sidebarOpen && <button className="mobile-scrim" aria-label="Close sidebar" onClick={() => setSidebarOpen(false)} />}
      <aside className="sidebar" aria-hidden={!sidebarOpen}>
        <div className="window-row">
          <div className="brand-lockup" aria-label="Kodex"><KodexMark /><span>Kodex</span></div>
          <div className="window-actions">
            <button className="icon-button" aria-label="Go back" onClick={() => selectThread(initialThreads[1])}><ArrowLeft size={15} /></button>
            <button className="icon-button is-muted" aria-label="Go forward" onClick={() => selectThread(initialThreads[0])}><ArrowRight size={15} /></button>
            <button className="icon-button" aria-label="Hide sidebar" onClick={() => setSidebarOpen(false)}><PanelLeftClose size={15} /></button>
          </div>
        </div>

        <nav className="sidebar-nav" aria-label="Workspace navigation">
          <SidebarItem icon={<Plus size={16} />} active={isNewThread} onClick={startNewThread}>New thread<span className="shortcut-hint">Ctrl N</span></SidebarItem>
          <SidebarItem icon={<Clock3 size={15} />} onClick={() => setDialog('automations')}>Automations</SidebarItem>
          <SidebarItem icon={<WandSparkles size={15} />} onClick={() => setDialog('skills')}>Skills</SidebarItem>
        </nav>

        <section className="sidebar-section thread-section">
          <div className="section-heading"><span>Threads</span><button className="icon-button tiny" aria-label="Search threads" onClick={() => setSearchOpen((open) => !open)}><Search size={13} /></button></div>
          {searchOpen && <div className="sidebar-search"><Search size={13} /><input autoFocus aria-label="Search threads" placeholder="Search" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} />{searchQuery && <button aria-label="Clear search" onClick={() => setSearchQuery('')}><X size={12} /></button>}</div>}
          <div className="thread-list">
            {filteredThreads.map((thread) => <button className={`thread-row ${activeThread === thread.id ? 'is-current' : ''}`} key={thread.id} onClick={() => selectThread(thread)}>
              <span className="thread-copy"><span className="thread-title">{thread.title}</span><span className="thread-project">{thread.project}</span></span><span className="thread-time">{thread.time}</span>
            </button>)}
            {filteredThreads.length === 0 && <p className="no-results">일치하는 스레드가 없습니다.</p>}
          </div>
        </section>

        <section className="sidebar-section projects-section">
          <div className="section-heading"><span>Projects</span><button className="icon-button tiny" aria-label="Add project" onClick={() => notify('프로젝트 추가 화면을 열었습니다')}><Plus size={13} /></button></div>
          <div className="project-list">{projects.map((project) => <button className={`project-row ${activeProject === project ? 'is-current' : ''}`} key={project} onClick={() => { setActiveProject(project); notify(`${project} 프로젝트로 전환했습니다`); }}>
            <Box size={14} strokeWidth={1.8} /><span>{project}</span>{activeProject === project && <CircleDot className="project-dot" size={11} />}
          </button>)}</div>
        </section>

        <button className="sidebar-settings" onClick={() => setDialog('settings')}><Settings size={15} /><span>Settings</span><span className="settings-version">Kodex</span></button>
      </aside>

      <section className={`workspace ${detailsOpen ? 'has-details' : ''}`}>
        <header className="workspace-header">
          <div className="title-group">
            {!sidebarOpen && <button className="icon-button reopen-sidebar" aria-label="Open sidebar" onClick={() => setSidebarOpen(true)}><PanelLeftClose size={15} className="flip-x" /></button>}
            <h1>{threadTitle}</h1>
            <div className="project-switch-wrap">
              <button className="project-switcher" onClick={(event) => { event.stopPropagation(); setActiveMenu(activeMenu === 'project' ? null : 'project'); }}>{activeProject} <ChevronDown size={12} /></button>
              {activeMenu === 'project' && <Popover className="header-popover project-popover"><span className="popover-label">Project</span>{projects.map((project) => <button key={project} onClick={() => { setActiveProject(project); setActiveMenu(null); }}><Box size={14} /> {project} {activeProject === project && <Check size={13} />}</button>)}</Popover>}
            </div>
          </div>

          <div className="header-actions">
            <div className="menu-anchor">
              <button className="toolbar-button" onClick={(event) => { event.stopPropagation(); setActiveMenu(activeMenu === 'open' ? null : 'open'); }}><Code2 size={14} /><span>Open</span><ChevronDown size={11} /></button>
              {activeMenu === 'open' && <Popover className="header-popover open-popover"><button onClick={() => notify('Visual Studio Code에서 열 준비가 되었습니다')}><Code2 size={14} /> Open in VS Code</button><button onClick={() => notify('파일 탐색기에서 프로젝트를 열었습니다')}><Folder size={14} /> Open in Explorer</button><button onClick={() => notify('통합 터미널을 열었습니다')}><SquareTerminal size={14} /> Open terminal</button></Popover>}
            </div>
            <button className="toolbar-button" onClick={() => setDialog('handoff')}><Play size={13} fill="currentColor" /><span>Hand off</span></button>
            <button className={`toolbar-button change-button ${detailsOpen ? 'is-active' : ''}`} onClick={() => setDetailsOpen(true)}><GitCommitHorizontal size={14} /><span>Review changes</span><span className="change-count plus">+606</span><span className="change-count minus">−386</span></button>
            <button className={`icon-button bordered ${detailsOpen ? 'is-active' : ''}`} aria-label="Toggle changes panel" onClick={() => setDetailsOpen((open) => !open)}><Columns2 size={15} /></button>
            <div className="menu-anchor">
              <button className="icon-button" aria-label="More actions" onClick={(event) => { event.stopPropagation(); setActiveMenu(activeMenu === 'more' ? null : 'more'); }}><MoreHorizontal size={17} /></button>
              {activeMenu === 'more' && <Popover className="header-popover more-popover"><button onClick={() => notify('스레드 이름을 복사했습니다')}><Copy size={14} /> Copy thread link</button><button onClick={() => notify('알림을 켰습니다')}><Bell size={14} /> Turn on notifications</button><button onClick={() => notify('스레드를 보관했습니다')}><History size={14} /> Archive thread</button></Popover>}
            </div>
          </div>
        </header>

        <div className="conversation-scroll">
          <article className="conversation">
            {isNewThread ? <div className="empty-thread"><KodexMark compact /><h2>What would you like Kodex to build?</h2><p>코드베이스를 설명하거나, 변경을 요청하거나, 아래 제안에서 시작하세요.</p><div className="suggestion-grid">
              <button onClick={() => setDraft('이 코드베이스의 구조와 핵심 흐름을 설명해줘')}><Code2 size={14} /> Explain this codebase</button>
              <button onClick={() => setDraft('현재 변경 사항에서 버그와 회귀 가능성을 검토해줘')}><GitCommitHorizontal size={14} /> Review current changes</button>
              <button onClick={() => setDraft('실패하는 테스트를 찾아 원인을 진단해줘')}><SquareTerminal size={14} /> Diagnose failing tests</button>
              <button onClick={() => setDraft('이 화면의 반응형 동작을 개선해줘')}><Laptop size={14} /> Improve responsive UI</button>
            </div></div> : <>
              <div className="user-message"><p>{userPrompt}</p></div>
              <div className="assistant-block">
                <div className="assistant-avatar" aria-label="Kodex"><KodexMark compact /></div>
                <div className="assistant-content">
                  <p>Windows Codex의 작업공간 구조를 기준으로 사이드바, 스레드 헤더, 대화 기록, 변경 검토 패널과 컴포저를 다시 맞추고 있습니다. 제품 표기와 로고만 Kodex로 교체했습니다.</p>
                  <div className="activity-stack">
                    <div className="activity-row"><Search size={14} /><span>Searched</span><code>Windows Codex desktop layout</code><span className="activity-time">0.4s</span></div>
                    <div className="activity-row"><FileCode2 size={14} /><span>Read</span><code>app/page.tsx</code><span className="activity-detail">interface shell</span></div>
                    <div className="activity-row"><FileCode2 size={14} /><span>Read</span><code>app/globals.css</code><span className="activity-detail">responsive rules</span></div>
                  </div>
                  <p>기존 화면은 구조만 비슷한 정적 목업이어서, 창 크기 변화와 메뉴 상태까지 실제 데스크톱 앱처럼 이어지도록 인터랙션과 레이아웃 상태를 정리했습니다.</p>
                  <div className="edit-card"><div className="edit-card-top"><div><FileCode2 size={14} /><span>Edited</span><strong>app/page.tsx</strong></div><span className="diff-summary"><b>+286</b><em>−174</em></span></div><div className="code-preview" aria-hidden="true"><span className="line-no">74</span><span className="code-line removed">const productName = &apos;Desktop Agent UI&apos;;</span><span className="line-no">74</span><span className="code-line added">const productName = &apos;Kodex&apos;;</span><span className="line-no">75</span><span className="code-line added">const desktopShell = &apos;complete&apos;;</span></div></div>
                  <div className="activity-row single"><SquareTerminal size={14} /><span>Ran</span><code>npm run build</code><span className="success-status">Passed</span><span className="activity-time">5.4s</span></div>
                  <div className="worked-line"><span>Worked for 8m 24s</span></div>
                  <p>Kodex 데스크톱 화면을 일관된 한 제품으로 정리했습니다. 사이드바와 패널은 좁은 Windows 창에서도 다시 열 수 있고, 주요 메뉴와 검토 흐름이 실제로 반응합니다.</p>
                  <div className="result-actions"><button onClick={() => notify('마지막 변경을 되돌릴 준비가 되었습니다')}><History size={13} /> Undo</button><button onClick={() => setDetailsOpen(true)}><GitBranch size={13} /> View changes</button></div>
                </div>
              </div>
            </>}
          </article>
        </div>

        <div className="composer-wrap">
          <div className="composer">
            <textarea aria-label="Message" placeholder={isNewThread ? 'Ask Kodex anything' : 'Ask for follow-up changes'} rows={2} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendDraft(); } }} />
            <div className="composer-footer">
              <div className="composer-left">
                <div className="menu-anchor"><button className="icon-button composer-add" aria-label="Add context" onClick={(event) => { event.stopPropagation(); setActiveMenu(activeMenu === 'context' ? null : 'context'); }}><Plus size={17} /></button>{activeMenu === 'context' && <Popover className="composer-popover context-popover"><button onClick={() => notify('파일 선택기를 열었습니다')}><Paperclip size={14} /> Add files</button><button onClick={() => notify('이미지 선택기를 열었습니다')}><ImageIcon size={14} /> Add image</button><button onClick={() => notify('컨텍스트를 추가했습니다')}><Code2 size={14} /> Add code context</button></Popover>}</div>
                <button className="composer-select" onClick={() => notify('로컬 환경을 사용합니다')}><LayoutGrid size={13} /> Local <ChevronDown size={11} /></button>
                <div className="menu-anchor"><button className="composer-select permission-select" onClick={(event) => { event.stopPropagation(); setActiveMenu(activeMenu === 'permissions' ? null : 'permissions'); }}><SlidersHorizontal size={13} /> {permission}<ChevronDown size={11} /></button>{activeMenu === 'permissions' && <Popover className="composer-popover permission-popover">{['Default permissions', 'Read only', 'Full access'].map((item) => <button key={item} onClick={() => { setPermission(item); setActiveMenu(null); }}><SlidersHorizontal size={14} /> {item} {permission === item && <Check size={13} />}</button>)}</Popover>}</div>
                <button className="composer-select branch-select" onClick={() => notify('master 브랜치에서 작업 중입니다')}><GitBranch size={13} /> master</button>
              </div>
              <div className="composer-right">
                <div className="menu-anchor"><button className="model-select" onClick={(event) => { event.stopPropagation(); setActiveMenu(activeMenu === 'model' ? null : 'model'); }}>{model} <span>High</span> <ChevronDown size={11} /></button>{activeMenu === 'model' && <Popover className="composer-popover model-popover">{['GPT-5.6 Sol', 'GPT-5.6 Terra', 'GPT-5.6 Luna'].map((item) => <button key={item} onClick={() => { setModel(item); setActiveMenu(null); }}><Sparkles size={14} /> {item} {model === item && <Check size={13} />}</button>)}</Popover>}</div>
                <button className="icon-button" aria-label="Voice input" onClick={() => notify('음성 입력을 시작할 준비가 되었습니다')}><Mic size={16} /></button>
                <button className="send-button" aria-label="Send message" onClick={sendDraft} disabled={!draft.trim()}><ArrowRight size={15} /></button>
              </div>
            </div>
          </div>
          <p className="composer-note">Enter to send · Shift+Enter for a new line</p>
        </div>

        {detailsOpen && <aside className="detail-panel" aria-label="Thread changes">
          <div className="detail-header"><div><strong>Changes</strong><span>{activeProject}</span></div><button className="icon-button" aria-label="Close changes" onClick={() => setDetailsOpen(false)}><X size={15} /></button></div>
          <div className="change-overview"><div className="change-overview-top"><span>4 files changed</span><span className="diff-summary"><b>+606</b><em>−386</em></span></div><div className="diff-bar" aria-hidden="true"><span className="added-bar" /><span className="removed-bar" /></div></div>
          <div className="file-change-list">{changedFiles.map((file) => <button className={`file-change ${selectedFile === file.name ? 'is-selected' : ''}`} key={file.name} onClick={() => setSelectedFile(file.name)}><FileCode2 size={14} /><span>{file.name}</span><b>+{file.added}</b><em>−{file.removed}</em><ChevronRight size={12} /></button>)}</div>
          <section className="diff-inspector" aria-label={`Diff for ${selectedFile}`}><header><FileCode2 size={13} /><strong>{selectedFile}</strong><button aria-label="Open file" onClick={() => notify(`${selectedFile} 파일을 열었습니다`)}><ExternalLink size={12} /></button></header><div className="inspector-code">{diffLines.map((line, index) => <div className={`inspector-line ${line.kind}`} key={`${line.n}-${index}`}><span>{line.n}</span><code>{line.kind === 'added' ? '+ ' : line.kind === 'removed' ? '− ' : '  '}{line.text}</code></div>)}</div></section>
          <div className="detail-bottom"><div className="branch-card"><GitBranch size={14} /><div><span>Current branch</span><strong>master</strong></div></div><button className="primary-action" onClick={() => notify('모든 변경 사항 검토를 시작했습니다')}>Review all changes</button></div>
        </aside>}
      </section>

      {dialog && <div className="dialog-backdrop" role="presentation" onMouseDown={() => setDialog(null)}><section className={`app-dialog ${dialog === 'settings' ? 'settings-dialog' : ''}`} role="dialog" aria-modal="true" aria-label={`${dialog} panel`} onMouseDown={(event) => event.stopPropagation()}>
        <header className="dialog-header"><div className="dialog-title-lockup"><KodexMark compact /><div><span>{dialog === 'settings' ? 'Kodex preferences' : 'Kodex workspace'}</span><h2>{dialog === 'automations' ? 'Automations' : dialog === 'skills' ? 'Skills' : dialog === 'handoff' ? 'Hand off task' : 'Settings'}</h2></div></div><button className="icon-button" aria-label="Close dialog" onClick={() => setDialog(null)}><X size={16} /></button></header>
        {dialog === 'automations' && <div className="dialog-body"><div className="dialog-intro"><div className="dialog-icon"><Clock3 size={20} /></div><div><h3>Scheduled work</h3><p>Kodex가 이 프로젝트에서 반복 작업을 실행하도록 예약합니다.</p></div><button className="primary-action" onClick={() => notify('새 자동화를 만들 준비가 되었습니다')}><Plus size={13} /> New automation</button></div><div className="automation-list"><button><span className="automation-status" /><div><strong>Daily UI regression check</strong><span>Every weekday at 09:00</span></div><span>Active</span><ChevronRight size={13} /></button><button><span className="automation-status paused" /><div><strong>Weekly dependency audit</strong><span>Every Monday at 10:00</span></div><span>Paused</span><ChevronRight size={13} /></button></div></div>}
        {dialog === 'skills' && <div className="dialog-body"><div className="dialog-intro"><div className="dialog-icon"><WandSparkles size={20} /></div><div><h3>Skills</h3><p>Kodex가 전문 작업 흐름을 수행할 때 사용하는 지침입니다.</p></div></div><div className="skills-grid">{[[WandSparkles, 'Interface review', 'Spacing, hierarchy, and accessibility.'], [Code2, 'Frontend workflow', 'Build and verify focused UI changes.'], [SquareTerminal, 'Test runner', 'Run checks and summarize failures.'], [GitCommitHorizontal, 'Change review', 'Inspect diffs for regressions.']].map(([Icon, title, copy]) => { const SkillIcon = Icon as typeof WandSparkles; return <button key={String(title)} onClick={() => notify(`${title} skill을 선택했습니다`)}><SkillIcon size={17} /><div><strong>{String(title)}</strong><span>{String(copy)}</span></div><span className="status-pill">Ready</span></button>; })}</div></div>}
        {dialog === 'handoff' && <div className="dialog-body handoff-body"><div className="handoff-graphic"><Laptop size={25} /><ArrowRight size={17} /><Sparkles size={25} /></div><h3>Move this task to another environment</h3><p>현재 대화와 Git 상태를 유지한 채 다른 Kodex 환경에서 계속할 수 있습니다.</p><div className="handoff-option is-selected"><CircleDot size={15} /><div><strong>Kodex worktree</strong><span>격리된 작업공간에서 계속 작업</span></div><Check size={15} /></div><div className="dialog-actions"><button className="secondary-action" onClick={() => setDialog(null)}>Cancel</button><button className="primary-action" onClick={() => { setDialog(null); setToast('Kodex worktree로 hand off했습니다'); }}>Hand off</button></div></div>}
        {dialog === 'settings' && <div className="settings-layout"><nav className="settings-nav">{['General', 'Appearance', 'Agent', 'Integrations', 'About Kodex'].map((tabName) => <button className={settingsTab === tabName ? 'is-selected' : ''} key={tabName} onClick={() => setSettingsTab(tabName)}>{tabName}</button>)}</nav><div className="settings-content">
          <div className="settings-page-title"><h3>{settingsTab}</h3><p>{settingsTab === 'About Kodex' ? 'Kodex desktop interface prototype' : 'Kodex의 작업 환경을 설정합니다.'}</p></div>
          {settingsTab === 'General' && <><div className="setting-row"><div><strong>Open files with</strong><span>Choose the default editor.</span></div><button className="select-control" onClick={() => notify('기본 편집기는 Visual Studio Code입니다')}>Visual Studio Code <ChevronDown size={12} /></button></div><div className="setting-row"><div><strong>Integrated shell</strong><span>Shell used for local commands.</span></div><button className="select-control" onClick={() => notify('PowerShell을 사용합니다')}>PowerShell <ChevronDown size={12} /></button></div><div className="setting-row"><div><strong>Notifications</strong><span>Notify when a long task completes.</span></div><button className="toggle-control is-on" aria-label="Toggle notifications" onClick={(event) => event.currentTarget.classList.toggle('is-on')}><span /></button></div></>}
          {settingsTab === 'Appearance' && <><div className="setting-row"><div><strong>Theme</strong><span>Use the light desktop appearance.</span></div><button className="select-control" onClick={() => notify('Light 테마를 사용합니다')}>Light <ChevronDown size={12} /></button></div><div className="setting-row"><div><strong>Interface density</strong><span>Match the compact Windows layout.</span></div><button className="select-control" onClick={() => notify('Compact 밀도를 사용합니다')}>Compact <ChevronDown size={12} /></button></div></>}
          {settingsTab === 'Agent' && <><div className="setting-row"><div><strong>Default model</strong><span>Used for new Kodex threads.</span></div><button className="select-control" onClick={() => notify(`${model} 모델을 사용합니다`)}>{model} <ChevronDown size={12} /></button></div><div className="setting-row"><div><strong>Reasoning effort</strong><span>Controls depth for new tasks.</span></div><button className="select-control" onClick={() => notify('High reasoning을 사용합니다')}>High <ChevronDown size={12} /></button></div></>}
          {settingsTab === 'Integrations' && <div className="settings-empty"><Box size={20} /><strong>No integrations connected</strong><span>Connect tools and services from the Skills panel.</span></div>}
          {settingsTab === 'About Kodex' && <div className="about-kodex"><KodexMark /><h3>Kodex</h3><p>Windows desktop UI · Version 1.0.0</p><span>Built to mirror the Codex workspace with Kodex branding.</span></div>}
        </div></div>}
      </section></div>}
      {toast && <div className="toast" role="status"><Check size={14} />{toast}</div>}
    </main>
  );
}
