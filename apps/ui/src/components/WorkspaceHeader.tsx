import type { GitStatus, ProjectRecord } from '@kodex/kodex-api';
import type { Thread } from '@kodex/codex-protocol';
import { Archive, Building2, ChevronDown, Code2, Columns2, Copy, GitBranch, GitCommitHorizontal, History, LogOut, MoreHorizontal, PanelLeftClose, ShieldCheck, UserRound } from 'lucide-react';
import type { ProductAuthContext } from '../auth/product-auth';
import { threadTitle } from './Sidebar';

export function WorkspaceHeader(props: {
  sidebarOpen: boolean;
  thread: Thread | null;
  project: ProjectRecord;
  git: GitStatus;
  detailsOpen: boolean;
  menu: 'account' | 'open' | 'more' | null;
  networkEnabled: boolean;
  account: ProductAuthContext;
  loggingOut: boolean;
  onMenu: (menu: 'account' | 'open' | 'more' | null) => void;
  onOpenSidebar: () => void;
  onToggleDetails: () => void;
  onArchive: () => void;
  onFork: () => void;
  onLogout: () => void;
  onRename: () => void;
  onToast: (message: string) => void;
}) {
  const accountName = props.account.user.displayName || props.account.user.email;
  const productWorkspace = props.account.defaultWorkspace ?? props.account.workspaces[0];
  const workspaceLabel = !productWorkspace
    ? 'workspace 없음'
    : props.account.defaultWorkspace ? '기본 workspace' : 'workspace';
  return <header className="workspace-header"><div className="title-group">
    {!props.sidebarOpen && <button className="icon-button reopen-sidebar" aria-label="Open sidebar" onClick={props.onOpenSidebar}><PanelLeftClose size={15} className="flip-x" /></button>}
    <h1>{threadTitle(props.thread)}</h1><span className="project-switcher"><GitBranch size={11} /> {props.project.name}</span>
  </div><div className="header-actions">
    <div className="menu-anchor"><button className="toolbar-button" aria-label="Open" aria-expanded={props.menu === 'open'} onClick={() => props.onMenu(props.menu === 'open' ? null : 'open')}><Code2 size={14} /><span>Open</span><ChevronDown size={11} /></button>{props.menu === 'open' && <div className="popover header-popover open-popover"><button onClick={() => { void navigator.clipboard.writeText(props.project.path); props.onToast('작업공간 경로를 복사했습니다.'); props.onMenu(null); }}><Copy size={14} /> Copy workspace path</button></div>}</div>
    <span className="toolbar-button policy-badge"><ShieldCheck size={13} /><span>{props.networkEnabled ? 'Tool network on' : 'Tool network off'}</span></span>
    <button className={`toolbar-button change-button ${props.detailsOpen ? 'is-active' : ''}`} aria-label="Review changes" onClick={() => { props.onMenu(null); props.onToggleDetails(); }}><GitCommitHorizontal size={14} /><span>Review changes</span><span className="change-count plus">+{props.git.totals.added}</span><span className="change-count minus">−{props.git.totals.removed}</span></button>
    <button className={`icon-button bordered ${props.detailsOpen ? 'is-active' : ''}`} aria-label="Toggle changes panel" onClick={() => { props.onMenu(null); props.onToggleDetails(); }}><Columns2 size={15} /></button>
    <div className="menu-anchor"><button className="icon-button" aria-label="More actions" aria-expanded={props.menu === 'more'} onClick={() => props.onMenu(props.menu === 'more' ? null : 'more')}><MoreHorizontal size={17} /></button>{props.menu === 'more' && <div className="popover header-popover more-popover"><button disabled={!props.thread} onClick={() => { props.onMenu(null); props.onRename(); }}><History size={14} /> Rename thread</button><button disabled={!props.thread} onClick={() => { props.onMenu(null); props.onFork(); }}><GitBranch size={14} /> Fork thread</button><button disabled={!props.thread} onClick={() => { props.onMenu(null); props.onArchive(); }}><Archive size={14} /> Archive thread</button></div>}</div>
    <div className="menu-anchor account-anchor"><button className="account-button" type="button" aria-label={`${accountName} 계정 메뉴`} aria-expanded={props.menu === 'account'} onClick={() => props.onMenu(props.menu === 'account' ? null : 'account')}><UserRound size={14} /><span>{accountName}</span><ChevronDown size={11} /></button>{props.menu === 'account' && <div className="popover header-popover account-popover"><div className="account-summary"><strong>{accountName}</strong><span>{props.account.user.email}</span></div><div className="account-workspace"><Building2 size={13} /><div><span>{workspaceLabel}</span><strong>{productWorkspace?.name ?? '할당된 workspace가 없습니다'}</strong>{productWorkspace && <small>{productWorkspace.role}</small>}</div></div><button disabled={props.loggingOut} onClick={() => { props.onMenu(null); props.onLogout(); }}><LogOut size={14} /> {props.loggingOut ? '로그아웃 중…' : '로그아웃'}</button></div>}</div>
  </div></header>;
}
