import type { GitStatus, ProjectRecord } from '@kodex/kodex-api';
import type { Thread } from '@kodex/codex-protocol';
import { canUseWorkspaceRuntime } from '@kodex/product-contract';
import { Archive, Building2, Check, ChevronDown, Code2, Columns2, Copy, GitBranch, GitCommitHorizontal, History, LogOut, MoreHorizontal, PanelLeftClose, ShieldCheck, UserRound } from 'lucide-react';
import type { ProductAuthContext, ProductWorkspace } from '../auth/product-auth';
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
  activeWorkspace: ProductWorkspace;
  loggingOut: boolean;
  onMenu: (menu: 'account' | 'open' | 'more' | null) => void;
  onOpenSidebar: () => void;
  onToggleDetails: () => void;
  onArchive: () => void;
  onFork: () => void;
  onLogout: () => void;
  onSelectWorkspace: (workspaceId: string) => void;
  onRename: () => void;
  onToast: (message: string) => void;
}) {
  const accountName = props.account.user.displayName || props.account.user.email;
  const showWorkspaceList = props.account.workspaces.length > 1;
  return <header className="workspace-header"><div className="title-group">
    {!props.sidebarOpen && <button className="icon-button reopen-sidebar" aria-label="Open sidebar" onClick={props.onOpenSidebar}><PanelLeftClose size={15} className="flip-x" /></button>}
    <h1>{threadTitle(props.thread)}</h1><span className="project-switcher"><GitBranch size={11} /> {props.project.name}</span>
  </div><div className="header-actions">
    <div className="menu-anchor"><button className="toolbar-button" aria-label="Open" aria-expanded={props.menu === 'open'} onClick={() => props.onMenu(props.menu === 'open' ? null : 'open')}><Code2 size={14} /><span>Open</span><ChevronDown size={11} /></button>{props.menu === 'open' && <div className="popover header-popover open-popover"><button onClick={() => { void navigator.clipboard.writeText(props.project.path); props.onToast('작업공간 경로를 복사했습니다.'); props.onMenu(null); }}><Copy size={14} /> Copy workspace path</button></div>}</div>
    <span className="toolbar-button policy-badge"><ShieldCheck size={13} /><span>{props.networkEnabled ? 'Tool network on' : 'Tool network off'}</span></span>
    <button className={`toolbar-button change-button ${props.detailsOpen ? 'is-active' : ''}`} aria-label="Review changes" onClick={() => { props.onMenu(null); props.onToggleDetails(); }}><GitCommitHorizontal size={14} /><span>Review changes</span><span className="change-count plus">+{props.git.totals.added}</span><span className="change-count minus">−{props.git.totals.removed}</span></button>
    <button className={`icon-button bordered ${props.detailsOpen ? 'is-active' : ''}`} aria-label="Toggle changes panel" onClick={() => { props.onMenu(null); props.onToggleDetails(); }}><Columns2 size={15} /></button>
    <div className="menu-anchor"><button className="icon-button" aria-label="More actions" aria-expanded={props.menu === 'more'} onClick={() => props.onMenu(props.menu === 'more' ? null : 'more')}><MoreHorizontal size={17} /></button>{props.menu === 'more' && <div className="popover header-popover more-popover"><button disabled={!props.thread} onClick={() => { props.onMenu(null); props.onRename(); }}><History size={14} /> Rename thread</button><button disabled={!props.thread} onClick={() => { props.onMenu(null); props.onFork(); }}><GitBranch size={14} /> Fork thread</button><button disabled={!props.thread} onClick={() => { props.onMenu(null); props.onArchive(); }}><Archive size={14} /> Archive thread</button></div>}</div>
    <div className="menu-anchor account-anchor"><button className="account-button" type="button" aria-label={`${accountName} 계정 메뉴, ${props.activeWorkspace.name} workspace, ${props.activeWorkspace.role} 역할`} aria-expanded={props.menu === 'account'} onClick={() => props.onMenu(props.menu === 'account' ? null : 'account')}><UserRound size={14} /><span>{accountName}</span><ChevronDown size={11} /></button>{props.menu === 'account' && <div className="popover header-popover account-popover"><div className="account-summary"><strong>{accountName}</strong><span>{props.account.user.email}</span></div><div className="account-workspace"><Building2 size={13} /><div><span>현재 runtime workspace</span><strong>{props.activeWorkspace.name}</strong><small>{props.activeWorkspace.role}</small></div></div>{showWorkspaceList && <div className="workspace-selector" role="group" aria-label="Runtime workspace 선택"><span className="workspace-selector-label">Workspace 전환</span>{props.account.workspaces.map((workspace) => {
      const current = workspace.id === props.activeWorkspace.id;
      const runnable = canUseWorkspaceRuntime(workspace.role);
      return <button className={`workspace-option ${current ? 'is-current' : ''}`} type="button" key={workspace.id} aria-current={current ? 'true' : undefined} disabled={current || !runnable} onClick={() => props.onSelectWorkspace(workspace.id)}><span><strong>{workspace.name}</strong><small>{workspace.role}</small></span><span className="workspace-option-state">{current ? <><Check size={11} /> 현재</> : runnable ? '전환' : '실행 불가'}</span></button>;
    })}<p className="workspace-switch-note">전환하면 이 UI 연결과 화면 상태가 바뀝니다. 진행 중인 turn은 서버 정책에 따라 계속될 수 있습니다.</p></div>}<button disabled={props.loggingOut} onClick={() => { props.onMenu(null); props.onLogout(); }}><LogOut size={14} /> {props.loggingOut ? '로그아웃 중…' : '로그아웃'}</button></div>}</div>
  </div></header>;
}
