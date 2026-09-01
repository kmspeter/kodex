import type { ProjectRecord } from '@kodex/kodex-api';
import type { Thread } from '@kodex/codex-protocol';
import { Archive, BookOpenText, Box, CircleDot, Clock3, Database, PanelLeftClose, Plus, Search, Settings, WandSparkles, X } from 'lucide-react';
import type { ConnectionState } from '../client/kodex-client';
import { KodexMark } from './Brand';

function relativeTime(timestamp: number | null): string {
  if (!timestamp) return '';
  const delta = Date.now() - timestamp * 1_000;
  if (delta < 60_000) return '지금';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}분`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}시간`;
  return new Date(timestamp * 1_000).toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' });
}

export function threadTitle(thread: Thread | null): string {
  return thread?.name || thread?.preview || 'New thread';
}

export function Sidebar(props: {
  open: boolean;
  connection: ConnectionState;
  threads: Thread[];
  activeThreadId: string | null;
  projects: ProjectRecord[];
  activeProjectId: string;
  onClose: () => void;
  onNew: () => void;
  onSelectThread: (thread: Thread) => void;
  onSelectProject: (project: ProjectRecord) => void;
  onDialog: (dialog: 'automations' | 'skills' | 'archived' | 'history' | 'knowledge' | 'settings') => void;
}) {
  const [searchOpen, setSearchOpen] = useSidebarSearch();
  const filtered = props.threads.filter((thread) => threadTitle(thread).toLocaleLowerCase().includes(searchOpen.query.toLocaleLowerCase()));
  if (!props.open) return null;
  return <aside className="sidebar">
    <div className="sidebar-top"><div className="brand-lockup"><KodexMark /><strong>Kodex</strong><span className={`local-status ${props.connection === 'connected' ? 'is-ready' : ''}`}>{props.connection}</span></div><button className="icon-button" aria-label="Close sidebar" onClick={props.onClose}><PanelLeftClose size={15} /></button></div>
    <nav className="sidebar-nav">
      <button className="sidebar-item" onClick={props.onNew}><span className="sidebar-icon"><Plus size={14} /></span><span>New thread</span></button>
      <button className="sidebar-item" onClick={() => props.onDialog('automations')}><span className="sidebar-icon"><Clock3 size={14} /></span><span>Automations</span></button>
      <button className="sidebar-item" onClick={() => props.onDialog('skills')}><span className="sidebar-icon"><WandSparkles size={14} /></span><span>Skills & tools</span></button>
      <button className="sidebar-item" onClick={() => props.onDialog('knowledge')}><span className="sidebar-icon"><BookOpenText size={14} /></span><span>Knowledge / RAG</span></button>
      <button className="sidebar-item" onClick={() => props.onDialog('history')}><span className="sidebar-icon"><Database size={14} /></span><span>저장된 DB 히스토리</span></button>
      <button className="sidebar-item" onClick={() => props.onDialog('archived')}><span className="sidebar-icon"><Archive size={14} /></span><span>Archived</span></button>
    </nav>
    <section className="sidebar-section thread-section"><div className="section-heading"><span>Threads</span><button className="icon-button tiny" aria-label="Search threads" onClick={() => setSearchOpen({ ...searchOpen, visible: !searchOpen.visible })}><Search size={13} /></button></div>
      {searchOpen.visible && <div className="sidebar-search"><Search size={13} /><input autoFocus placeholder="Search local threads" value={searchOpen.query} onChange={(event) => setSearchOpen({ ...searchOpen, query: event.target.value })} />{searchOpen.query && <button aria-label="Clear" onClick={() => setSearchOpen({ ...searchOpen, query: '' })}><X size={12} /></button>}</div>}
      <div className="thread-list">{filtered.map((thread) => <button className={`thread-row ${props.activeThreadId === thread.id ? 'is-current' : ''}`} key={thread.id} onClick={() => props.onSelectThread(thread)}><span className="thread-copy"><span className="thread-title">{threadTitle(thread)}</span><span className="thread-project">{thread.cwd}</span></span><span className="thread-time">{relativeTime(thread.recencyAt || thread.updatedAt)}</span></button>)}{filtered.length === 0 && <p className="no-results">저장된 로컬 스레드가 없습니다.</p>}</div>
    </section>
    <section className="sidebar-section projects-section"><div className="section-heading"><span>Projects</span></div><div className="project-list">{props.projects.map((project) => <button className={`project-row ${project.id === props.activeProjectId ? 'is-current' : ''}`} key={project.id} onClick={() => props.onSelectProject(project)}><Box size={14} /><span>{project.name}</span>{project.id === props.activeProjectId && <CircleDot className="project-dot" size={11} />}</button>)}</div></section>
    <div className="sidebar-bottom"><button className="sidebar-item" onClick={() => props.onDialog('settings')}><span className="sidebar-icon"><Settings size={14} /></span><span>Settings</span></button></div>
  </aside>;
}

import { useState } from 'react';

function useSidebarSearch() {
  const [state, setState] = useState({ visible: false, query: '' });
  return [state, setState] as const;
}
