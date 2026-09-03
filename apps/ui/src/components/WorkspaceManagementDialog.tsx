import { Building2, LoaderCircle, Plus, RefreshCw, Trash2, Users, X } from 'lucide-react';
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { workspaceRoles, type WorkspaceRole } from '@kodex/product-contract';
import type {
  ProductAuthClient,
  ProductAuthContext,
  ProductWorkspace,
  ProductWorkspaceMember,
} from '../auth/product-auth';
import { KodexMark } from './Brand';

export function WorkspaceManagementDialog(props: {
  account: ProductAuthContext;
  activeWorkspace?: ProductWorkspace;
  client: ProductAuthClient;
  onClose: () => void;
  onRefresh: (context: ProductAuthContext, selectedWorkspaceId?: string) => void;
}) {
  const [members, setMembers] = useState<ProductWorkspaceMember[]>([]);
  const [loading, setLoading] = useState(Boolean(props.activeWorkspace));
  const [error, setError] = useState('');
  const [pending, setPending] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<WorkspaceRole>('member');
  const closeRef = useRef<HTMLButtonElement>(null);
  const active = props.activeWorkspace;
  const canManage = active?.role === 'owner' || active?.role === 'admin';

  const loadMembers = useCallback(async () => {
    if (!active) return;
    setLoading(true);
    setError('');
    try {
      setMembers(await props.client.workspaceMembers(active.id));
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setLoading(false);
    }
  }, [active, props.client]);

  useEffect(() => { closeRef.current?.focus(); void loadMembers(); }, [loadMembers]);

  async function revalidate(selectedWorkspaceId?: string): Promise<void> {
    const context = await props.client.me();
    props.onRefresh(context, selectedWorkspaceId);
  }

  async function create(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending) return;
    setPending('create');
    setError('');
    try {
      const created = await props.client.createWorkspace(name);
      await revalidate(created.id);
      setName('');
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setPending('');
    }
  }

  async function add(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!active || pending) return;
    setPending('add');
    setError('');
    try {
      await props.client.addWorkspaceMember(active.id, email.trim(), role);
      await revalidate();
      setEmail('');
      await loadMembers();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setPending('');
    }
  }

  async function changeRole(member: ProductWorkspaceMember, nextRole: WorkspaceRole): Promise<void> {
    if (!active || pending || member.role === nextRole) return;
    setPending(`role:${member.userId}`);
    setError('');
    try {
      await props.client.updateWorkspaceMember(active.id, member.userId, nextRole);
      await revalidate();
      await loadMembers();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setPending('');
    }
  }

  async function remove(member: ProductWorkspaceMember): Promise<void> {
    if (!active || pending) return;
    setPending(`remove:${member.userId}`);
    setError('');
    try {
      await props.client.removeWorkspaceMember(active.id, member.userId);
      await revalidate();
      if (member.userId !== props.account.user.id) await loadMembers();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setPending('');
    }
  }

  function adminCanChange(member: ProductWorkspaceMember): boolean {
    return active?.role === 'owner' || (active?.role === 'admin' && member.role !== 'owner' && member.role !== 'admin');
  }

  function mayRemove(member: ProductWorkspaceMember): boolean {
    if (active?.role === 'owner') return true;
    return active?.role === 'admin' && (member.userId === props.account.user.id || !['owner', 'admin'].includes(member.role));
  }

  return <div className="dialog-backdrop"><section className="app-dialog workspace-management-dialog" role="dialog" aria-modal="true" aria-labelledby="workspace-management-title" aria-busy={Boolean(pending)}>
    <header className="dialog-header"><div className="dialog-title-lockup"><KodexMark compact /><div><span>Product account</span><h2 id="workspace-management-title">Workspace 관리</h2></div></div><button ref={closeRef} className="icon-button" aria-label="Close" disabled={Boolean(pending)} onClick={props.onClose}><X size={16} /></button></header>
    <div className="dialog-body workspace-management-body">
      <section className="workspace-management-section" aria-labelledby="create-workspace-title"><div className="dialog-intro"><div className="dialog-icon"><Building2 size={20} /></div><div><h3 id="create-workspace-title">새 workspace</h3><p>생성자는 owner가 되며, 생성 직후 이 workspace로 runtime을 전환합니다.</p></div></div>
        <form className="workspace-inline-form" onSubmit={(event) => void create(event)}><label>Workspace 이름<input required maxLength={100} value={name} disabled={Boolean(pending)} onChange={(event) => setName(event.target.value)} placeholder="예: Platform Team" /></label><button className="primary-action" type="submit" disabled={Boolean(pending) || !name.trim()}>{pending === 'create' ? <LoaderCircle className="spin" size={13} /> : <Plus size={13} />} 생성</button></form>
      </section>
      {active && <section className="workspace-management-section" aria-labelledby="workspace-members-title"><div className="dialog-intro"><div className="dialog-icon"><Users size={20} /></div><div><h3 id="workspace-members-title">{active.name} 멤버</h3><p>Workspace membership은 Saved DB History와 RAG 문서를 공유하지 않습니다. 두 데이터는 사용자별 private scope입니다.</p></div></div>
        {!canManage && <p className="workspace-permission-note">현재 {active.role} 역할은 멤버 목록을 볼 수 있지만 관리할 수 없습니다. Owner 또는 admin 권한이 필요합니다.</p>}
        {canManage && <form className="workspace-inline-form member-add-form" onSubmit={(event) => void add(event)}><label>기존 계정 email<input type="email" required maxLength={320} value={email} disabled={Boolean(pending)} onChange={(event) => setEmail(event.target.value)} placeholder="member@example.com" /></label><label>역할<select aria-label="추가할 역할" value={role} disabled={Boolean(pending)} onChange={(event) => setRole(event.target.value as WorkspaceRole)}>{workspaceRoles.filter((entry) => active.role === 'owner' || entry === 'member' || entry === 'viewer').map((entry) => <option key={entry} value={entry}>{entry}</option>)}</select></label><button className="primary-action" type="submit" disabled={Boolean(pending) || !email.trim()}>{pending === 'add' ? <LoaderCircle className="spin" size={13} /> : <Plus size={13} />} 기존 계정 추가</button></form>}
        <div className="workspace-member-list" aria-live="polite">{loading && <p className="dialog-empty"><LoaderCircle className="spin" size={13} /> 멤버를 불러오는 중…</p>}{!loading && !error && members.length === 0 && <p className="dialog-empty">표시할 멤버가 없습니다.</p>}{!loading && members.map((entry) => <div className="workspace-member-row" key={entry.userId}><div><strong>{entry.displayName || entry.email}{entry.userId === props.account.user.id ? ' (나)' : ''}</strong><span>{entry.email}</span></div><select aria-label={`${entry.email} 역할`} value={entry.role} disabled={Boolean(pending) || !adminCanChange(entry)} onChange={(event) => void changeRole(entry, event.target.value as WorkspaceRole)}>{workspaceRoles.filter((next) => active.role === 'owner' || next === entry.role || next === 'member' || next === 'viewer').map((next) => <option key={next} value={next}>{next}</option>)}</select><button className="icon-button" aria-label={`${entry.email} 제거`} title={mayRemove(entry) ? 'Workspace에서 제거' : '이 역할은 관리할 수 없습니다'} disabled={Boolean(pending) || !mayRemove(entry)} onClick={() => void remove(entry)}>{pending === `remove:${entry.userId}` ? <LoaderCircle className="spin" size={13} /> : <Trash2 size={13} />}</button></div>)}</div>
        {error && <div className="workspace-management-error" role="alert"><span>{error}</span><button className="secondary-action" disabled={Boolean(pending)} onClick={() => void loadMembers()}><RefreshCw size={12} /> 다시 시도</button></div>}
      </section>}
      {!active && <p className="workspace-permission-note">현재 실행 가능한 workspace가 없습니다. 새 workspace를 생성하면 owner로 바로 시작할 수 있습니다.</p>}
    </div>
  </section></div>;
}
