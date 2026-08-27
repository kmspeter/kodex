import type { GitStatus } from '@kodex/kodex-api';
import { ChevronRight, FileCode2, GitBranch, RefreshCw, X } from 'lucide-react';

export function ChangesPanel(props: { git: GitStatus; selectedFile: string; diff: string; onSelect: (path: string) => void; onClose: () => void; onRefresh: () => void }) {
  return <aside className="detail-panel"><div className="detail-header"><div><strong>Changes</strong><span>{props.git.isRepository ? `${props.git.branch} · staged / unstaged` : 'Not a Git repository'}</span></div><div className="detail-actions"><button className="icon-button" onClick={props.onRefresh}><RefreshCw size={14} /></button><button className="icon-button" onClick={props.onClose}><X size={15} /></button></div></div>
    <div className="change-overview"><div className="change-overview-top"><span>{props.git.totals.files} files changed</span><span className="diff-summary"><b>+{props.git.totals.added}</b><em>−{props.git.totals.removed}</em></span></div></div>
    <div className="file-change-list">{props.git.files.map((file) => <button className={`file-change ${props.selectedFile === file.path ? 'is-selected' : ''}`} key={file.path} onClick={() => props.onSelect(file.path)}><FileCode2 size={14} /><span>{file.path}</span><span className="git-layer">{file.staged ? 'S' : ''}{file.unstaged ? 'U' : ''}</span><b>+{file.added}</b><em>−{file.removed}</em><ChevronRight size={12} /></button>)}</div>
    <section className="diff-inspector"><header><FileCode2 size={13} /><strong>{props.selectedFile || 'Select a changed file'}</strong></header><pre className="diff-text">{props.diff || '변경 파일을 선택하세요.'}</pre></section>
    <div className="detail-bottom"><div className="branch-card"><GitBranch size={14} /><div><span>Local branch</span><strong>{props.git.branch || 'none'}</strong></div></div><span className="detail-note">Remote Git uses the selected Codex sandbox and approval policy.</span></div>
  </aside>;
}
