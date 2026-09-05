import { Archive, Building2, Check, Copy, LoaderCircle, Mail, Pencil, Plus, RefreshCw, Trash2, Users, X } from 'lucide-react';
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import {
  isValidProductWorkspaceName,
  PRODUCT_WORKSPACE_PAGE_DEFAULT_LIMIT,
  PRODUCT_WORKSPACE_NAME_MAX_UTF16_CODE_UNITS,
  PRODUCT_WORKSPACE_DELETE_CONFIRMATION,
  workspaceInvitationRoles,
  workspaceRoles,
  type WorkspaceInvitationRole,
  type WorkspaceRole,
} from '@kodex/product-contract';
import { isAbortError } from '../auth/product-auth';
import type {
  ProductAuthClient,
  ProductAuthContext,
  ProductWorkspace,
  ProductWorkspaceInvitation,
  ProductWorkspaceMember,
} from '../auth/product-auth';
import { createInvitationShareLink } from '../auth/invitation-fragment';
import { KodexMark } from './Brand';

export function WorkspaceManagementDialog(props: {
  account: ProductAuthContext;
  activeWorkspace?: ProductWorkspace;
  client: ProductAuthClient;
  onArchived?: (userId: string, workspaceId: string) => void;
  onClose: () => void;
  onRefresh: (context: ProductAuthContext, selectedWorkspaceId?: string) => void;
}) {
  const [members, setMembers] = useState<ProductWorkspaceMember[]>([]);
  const [invitations, setInvitations] = useState<ProductWorkspaceInvitation[]>([]);
  const [membersCursor, setMembersCursor] = useState<string>();
  const [invitationsCursor, setInvitationsCursor] = useState<string>();
  const [membersInitialLoading, setMembersInitialLoading] = useState(Boolean(props.activeWorkspace));
  const [invitationsInitialLoading, setInvitationsInitialLoading] = useState(Boolean(props.activeWorkspace));
  const [membersInitialError, setMembersInitialError] = useState('');
  const [invitationsInitialError, setInvitationsInitialError] = useState('');
  const [membersMoreLoading, setMembersMoreLoading] = useState(false);
  const [invitationsMoreLoading, setInvitationsMoreLoading] = useState(false);
  const [membersMoreError, setMembersMoreError] = useState('');
  const [invitationsMoreError, setInvitationsMoreError] = useState('');
  const [actionError, setActionError] = useState('');
  const [pending, setPending] = useState('');
  const [renameName, setRenameName] = useState(props.activeWorkspace?.name ?? '');
  const [renameError, setRenameError] = useState('');
  const [renamePending, setRenamePending] = useState(false);
  const [archiveConfirmation, setArchiveConfirmation] = useState('');
  const [archiveError, setArchiveError] = useState('');
  const [archivePending, setArchivePending] = useState(false);
  const [deletePassword, setDeletePassword] = useState('');
  const [deleteName, setDeleteName] = useState('');
  const [deleteConfirmation, setDeleteConfirmation] = useState('');
  const [deleteError, setDeleteError] = useState('');
  const [deletePending, setDeletePending] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<WorkspaceInvitationRole>('member');
  const [createdLink, setCreatedLink] = useState('');
  const [copyStatus, setCopyStatus] = useState<'copied' | 'manual' | ''>('');
  const closeRef = useRef<HTMLButtonElement>(null);
  const linkRef = useRef<HTMLInputElement>(null);
  const requestsRef = useRef(new Set<AbortController>());
  const scopeRef = useRef(0);
  const mountedRef = useRef(true);
  const renameRequestRef = useRef<symbol | null>(null);
  const archiveRequestRef = useRef<symbol | null>(null);
  const active = props.activeWorkspace;
  const activeId = active?.id;
  const activeName = active?.name ?? '';
  const accountUserId = props.account.user.id;
  const canManage = active?.role === 'owner' || active?.role === 'admin';
  const dialogBusy = Boolean(pending) || renamePending || archivePending || deletePending;
  const createValid = isValidProductWorkspaceName(name);
  const renameValid = isValidProductWorkspaceName(renameName);

  const abortPageRequests = useCallback(() => {
    for (const controller of requestsRef.current) controller.abort();
    requestsRef.current.clear();
  }, []);

  const loadMemberPage = useCallback(async (workspaceId: string, cursor: string | undefined, scope: number) => {
    const controller = new AbortController();
    requestsRef.current.add(controller);
    if (cursor) {
      setMembersMoreLoading(true);
      setMembersMoreError('');
    } else {
      setMembersInitialLoading(true);
      setMembersInitialError('');
    }
    try {
      const page = await props.client.workspaceMembers(workspaceId, {
        cursor,
        limit: PRODUCT_WORKSPACE_PAGE_DEFAULT_LIMIT,
        signal: controller.signal,
      });
      if (controller.signal.aborted || scopeRef.current !== scope) return;
      setMembers((current) => cursor
        ? [...new Map([...current, ...page.members].map((entry) => [entry.userId, entry])).values()]
        : page.members);
      setMembersCursor(page.nextCursor);
    } catch (nextError) {
      if (controller.signal.aborted || scopeRef.current !== scope) return;
      const message = nextError instanceof Error ? nextError.message : String(nextError);
      if (cursor) setMembersMoreError(message);
      else setMembersInitialError(message);
    } finally {
      requestsRef.current.delete(controller);
      if (!controller.signal.aborted && scopeRef.current === scope) {
        if (cursor) setMembersMoreLoading(false);
        else setMembersInitialLoading(false);
      }
    }
  }, [props.client]);

  const loadInvitationPage = useCallback(async (workspaceId: string, cursor: string | undefined, scope: number) => {
    const controller = new AbortController();
    requestsRef.current.add(controller);
    if (cursor) {
      setInvitationsMoreLoading(true);
      setInvitationsMoreError('');
    } else {
      setInvitationsInitialLoading(true);
      setInvitationsInitialError('');
    }
    try {
      const page = await props.client.workspaceInvitations(workspaceId, {
        cursor,
        limit: PRODUCT_WORKSPACE_PAGE_DEFAULT_LIMIT,
        signal: controller.signal,
      });
      if (controller.signal.aborted || scopeRef.current !== scope) return;
      setInvitations((current) => cursor
        ? [...new Map([...current, ...page.invitations].map((entry) => [entry.id, entry])).values()]
        : page.invitations);
      setInvitationsCursor(page.nextCursor);
    } catch (nextError) {
      if (controller.signal.aborted || scopeRef.current !== scope) return;
      const message = nextError instanceof Error ? nextError.message : String(nextError);
      if (cursor) setInvitationsMoreError(message);
      else setInvitationsInitialError(message);
    } finally {
      requestsRef.current.delete(controller);
      if (!controller.signal.aborted && scopeRef.current === scope) {
        if (cursor) setInvitationsMoreLoading(false);
        else setInvitationsInitialLoading(false);
      }
    }
  }, [props.client]);

  const reloadFirstPages = useCallback(async (workspaceId: string, manager: boolean) => {
    abortPageRequests();
    const scope = ++scopeRef.current;
    setMembers([]);
    setInvitations([]);
    setMembersCursor(undefined);
    setInvitationsCursor(undefined);
    setMembersInitialError('');
    setInvitationsInitialError('');
    setMembersMoreError('');
    setInvitationsMoreError('');
    setMembersMoreLoading(false);
    setInvitationsMoreLoading(false);
    setInvitationsInitialLoading(manager);
    const loads: Promise<void>[] = [loadMemberPage(workspaceId, undefined, scope)];
    if (manager) loads.push(loadInvitationPage(workspaceId, undefined, scope));
    await Promise.all(loads);
  }, [abortPageRequests, loadInvitationPage, loadMemberPage]);

  useEffect(() => {
    mountedRef.current = true;
    closeRef.current?.focus();
    setCreatedLink('');
    setCopyStatus('');
    setActionError('');
    setRenameName(activeName);
    setRenameError('');
    setRenamePending(false);
    renameRequestRef.current = null;
    setArchiveConfirmation('');
    setArchiveError('');
    setArchivePending(false);
    archiveRequestRef.current = null;
    setEmail('');
    setRole('member');
    if (activeId) void reloadFirstPages(activeId, canManage);
    else {
      abortPageRequests();
      ++scopeRef.current;
      setMembers([]);
      setInvitations([]);
      setMembersInitialLoading(false);
      setInvitationsInitialLoading(false);
    }
    return () => {
      abortPageRequests();
    };
  }, [abortPageRequests, accountUserId, activeId, activeName, canManage, reloadFirstPages]);

  useEffect(() => () => {
    mountedRef.current = false;
    abortPageRequests();
  }, [abortPageRequests]);

  async function revalidate(options: {
    controller?: AbortController;
    expectedUserId?: string;
    scope?: number;
    selectedWorkspaceId?: string;
  } = {}): Promise<ProductAuthContext | null> {
    const controller = options.controller ?? new AbortController();
    const scope = options.scope ?? scopeRef.current;
    const generation = props.client.sessionGeneration;
    requestsRef.current.add(controller);
    try {
      if (controller.signal.aborted || !mountedRef.current || scopeRef.current !== scope) return null;
      const context = await props.client.me({ signal: controller.signal });
      if (
        controller.signal.aborted
        || !mountedRef.current
        || scopeRef.current !== scope
        || props.client.sessionGeneration !== generation
        || (options.expectedUserId !== undefined && context.user.id !== options.expectedUserId)
      ) return null;
      if (options.selectedWorkspaceId === undefined) props.onRefresh(context);
      else props.onRefresh(context, options.selectedWorkspaceId);
      return context;
    } catch (error) {
      if (
        controller.signal.aborted
        || scopeRef.current !== scope
        || props.client.sessionGeneration !== generation
        || isAbortError(error)
      ) return null;
      throw error;
    } finally {
      requestsRef.current.delete(controller);
    }
  }

  async function create(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending || !isValidProductWorkspaceName(name)) return;
    setPending('create');
    setActionError('');
    try {
      const created = await props.client.createWorkspace(name);
      await revalidate({ selectedWorkspaceId: created.id });
      if (mountedRef.current) setName('');
    } catch (nextError) {
      if (mountedRef.current) setActionError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      if (mountedRef.current) setPending('');
    }
  }

  async function rename(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (
      !active
      || !canManage
      || renameRequestRef.current
      || archiveRequestRef.current
      || !isValidProductWorkspaceName(renameName)
      || renameName === active.name
    ) return;
    const scope = scopeRef.current;
    const workspaceId = active.id;
    const userId = accountUserId;
    const request = Symbol('rename-workspace');
    renameRequestRef.current = request;
    setRenamePending(true);
    setRenameError('');
    try {
      const renamed = await props.client.renameWorkspace(workspaceId, renameName);
      const context = await revalidate({ expectedUserId: userId, scope });
      if (
        !context
        || !mountedRef.current
        || scopeRef.current !== scope
        || props.account.user.id !== userId
        || activeId !== workspaceId
      ) return;
      setRenameName(renamed.name);
      setArchiveConfirmation('');
    } catch (nextError) {
      if (mountedRef.current && scopeRef.current === scope) {
        setRenameError(nextError instanceof Error ? nextError.message : String(nextError));
      }
    } finally {
      if (renameRequestRef.current === request) {
        renameRequestRef.current = null;
        if (mountedRef.current && scopeRef.current === scope) setRenamePending(false);
      }
    }
  }

  async function archive(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (
      !active
      || active.role !== 'owner'
      || archiveRequestRef.current
      || renameRequestRef.current
      || archiveConfirmation !== active.name
    ) return;
    const scope = scopeRef.current;
    const workspaceId = active.id;
    const userId = accountUserId;
    const request = Symbol('archive-workspace');
    archiveRequestRef.current = request;
    setArchivePending(true);
    setArchiveError('');
    let archived = false;
    let refreshController: AbortController | null = null;
    try {
      await props.client.archiveWorkspace(workspaceId, archiveConfirmation);
      archived = true;
      if (!mountedRef.current || scopeRef.current !== scope || props.account.user.id !== userId || activeId !== workspaceId) return;
      refreshController = new AbortController();
      requestsRef.current.add(refreshController);
      props.onArchived?.(userId, workspaceId);
      await revalidate({ controller: refreshController, expectedUserId: userId, scope });
    } catch (nextError) {
      if (!archived && mountedRef.current && scopeRef.current === scope) {
        setArchiveError(nextError instanceof Error ? nextError.message : String(nextError));
      }
    } finally {
      if (refreshController) requestsRef.current.delete(refreshController);
      if (archiveRequestRef.current === request) {
        archiveRequestRef.current = null;
        if (mountedRef.current && scopeRef.current === scope) setArchivePending(false);
      }
    }
  }

  async function permanentlyDelete(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (
      !active
      || active.role !== 'owner'
      || deletePending
      || archivePending
      || renamePending
      || deleteName !== active.name
      || deleteConfirmation !== PRODUCT_WORKSPACE_DELETE_CONFIRMATION
      || !deletePassword
    ) return;
    const scope = scopeRef.current;
    const workspaceId = active.id;
    const userId = accountUserId;
    const currentPassword = deletePassword;
    setDeletePassword('');
    setDeleteName('');
    setDeleteConfirmation('');
    setDeletePending(true);
    setDeleteError('');
    let requested = false;
    try {
      await props.client.deleteWorkspace(
        workspaceId,
        currentPassword,
        active.name,
        PRODUCT_WORKSPACE_DELETE_CONFIRMATION,
      );
      requested = true;
      if (!mountedRef.current || scopeRef.current !== scope || props.account.user.id !== userId || activeId !== workspaceId) return;
      props.onArchived?.(userId, workspaceId);
      await revalidate({ expectedUserId: userId, scope });
    } catch (nextError) {
      if (!requested && mountedRef.current && scopeRef.current === scope) {
        setDeleteError(nextError instanceof Error ? nextError.message : String(nextError));
      }
    } finally {
      if (mountedRef.current && scopeRef.current === scope) setDeletePending(false);
    }
  }

  async function invite(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!active || pending) return;
    setPending('invite');
    setActionError('');
    try {
      const created = await props.client.createWorkspaceInvitation(active.id, email.trim(), role);
      setCreatedLink(createInvitationShareLink(window.location.origin, created.token));
      setCopyStatus('');
      setEmail('');
      await reloadFirstPages(active.id, canManage);
    } catch (nextError) {
      if (mountedRef.current) setActionError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      if (mountedRef.current) setPending('');
    }
  }

  async function copyLink(): Promise<void> {
    if (!createdLink) return;
    try {
      await navigator.clipboard.writeText(createdLink);
      setCopyStatus('copied');
    } catch {
      linkRef.current?.focus();
      linkRef.current?.select();
      setCopyStatus('manual');
    }
  }

  async function revokeInvitation(entry: ProductWorkspaceInvitation): Promise<void> {
    if (!active || pending) return;
    setPending(`invite:${entry.id}`);
    setActionError('');
    try {
      await props.client.revokeWorkspaceInvitation(active.id, entry.id);
      await reloadFirstPages(active.id, canManage);
    } catch (nextError) {
      if (mountedRef.current) setActionError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      if (mountedRef.current) setPending('');
    }
  }

  async function changeRole(member: ProductWorkspaceMember, nextRole: WorkspaceRole): Promise<void> {
    if (!active || pending || member.role === nextRole) return;
    setPending(`role:${member.userId}`);
    setActionError('');
    try {
      await props.client.updateWorkspaceMember(active.id, member.userId, nextRole);
      const context = await revalidate();
      if (!context) return;
      const current = context.workspaces.find((workspace) => workspace.id === active.id);
      if (current) await reloadFirstPages(active.id, current.role === 'owner' || current.role === 'admin');
    } catch (nextError) {
      if (mountedRef.current) setActionError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      if (mountedRef.current) setPending('');
    }
  }

  async function remove(member: ProductWorkspaceMember): Promise<void> {
    if (!active || pending) return;
    setPending(`remove:${member.userId}`);
    setActionError('');
    try {
      await props.client.removeWorkspaceMember(active.id, member.userId);
      const context = await revalidate();
      if (!context) return;
      const current = context.workspaces.find((workspace) => workspace.id === active.id);
      if (current) await reloadFirstPages(active.id, current.role === 'owner' || current.role === 'admin');
    } catch (nextError) {
      if (mountedRef.current) setActionError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      if (mountedRef.current) setPending('');
    }
  }

  function adminCanChange(member: ProductWorkspaceMember): boolean {
    return active?.role === 'owner' || (active?.role === 'admin' && member.role !== 'owner' && member.role !== 'admin');
  }

  function mayRemove(member: ProductWorkspaceMember): boolean {
    if (active?.role === 'owner') return true;
    return active?.role === 'admin' && (member.userId === props.account.user.id || !['owner', 'admin'].includes(member.role));
  }

  function closeDialog(): void {
    ++scopeRef.current;
    abortPageRequests();
    props.onClose();
  }

  return <div className="dialog-backdrop"><section className="app-dialog workspace-management-dialog" role="dialog" aria-modal="true" aria-labelledby="workspace-management-title" aria-busy={dialogBusy}>
    <header className="dialog-header"><div className="dialog-title-lockup"><KodexMark compact /><div><span>Product account</span><h2 id="workspace-management-title">Workspace 관리</h2></div></div><button ref={closeRef} className="icon-button" aria-label="Close" disabled={dialogBusy} onClick={closeDialog}><X size={16} /></button></header>
    <div className="dialog-body workspace-management-body">
      <section className="workspace-management-section" aria-labelledby="create-workspace-title"><div className="dialog-intro"><div className="dialog-icon"><Building2 size={20} /></div><div><h3 id="create-workspace-title">새 workspace</h3><p>생성자는 owner가 되며, 생성 직후 이 workspace로 runtime을 전환합니다.</p></div></div>
        <form className="workspace-inline-form" onSubmit={(event) => void create(event)}><label>Workspace 이름<input required maxLength={PRODUCT_WORKSPACE_NAME_MAX_UTF16_CODE_UNITS} value={name} disabled={Boolean(pending)} onChange={(event) => setName(event.target.value)} placeholder="예: Platform Team" /></label><button className="primary-action" type="submit" disabled={Boolean(pending) || !createValid}>{pending === 'create' ? <LoaderCircle className="spin" size={13} /> : <Plus size={13} />} 생성</button></form>
      </section>
      {active && canManage && <section className="workspace-management-section" aria-labelledby="rename-workspace-title"><div className="dialog-intro"><div className="dialog-icon"><Pencil size={20} /></div><div><h3 id="rename-workspace-title">Workspace 이름 변경</h3><p>표시 이름만 갱신하며 현재 runtime 연결은 다시 시작하지 않습니다.</p></div></div>
        <form className="workspace-inline-form workspace-rename-form" onSubmit={(event) => void rename(event)}><label>새 workspace 이름<input aria-label="새 workspace 이름" required maxLength={PRODUCT_WORKSPACE_NAME_MAX_UTF16_CODE_UNITS} value={renameName} disabled={renamePending || archivePending} onChange={(event) => setRenameName(event.target.value)} /></label><button className="primary-action" type="submit" disabled={renamePending || archivePending || !renameValid || renameName === active.name}>{renamePending ? <LoaderCircle className="spin" size={13} /> : <Pencil size={13} />} 이름 변경</button></form>
        {renameError && <div className="workspace-management-error" role="alert"><span>{renameError}</span></div>}
      </section>}
      {active && <section className="workspace-management-section" aria-labelledby="workspace-members-title"><div className="dialog-intro"><div className="dialog-icon"><Users size={20} /></div><div><h3 id="workspace-members-title">{active.name} 멤버</h3><p>Workspace membership은 Saved DB History와 RAG 문서를 공유하지 않습니다. 두 데이터는 사용자별 private scope입니다.</p></div></div>
        {!canManage && <p className="workspace-permission-note">현재 {active.role} 역할은 멤버 목록을 볼 수 있지만 관리할 수 없습니다. Owner 또는 admin 권한이 필요합니다.</p>}
        {canManage && <><form className="workspace-inline-form member-add-form" onSubmit={(event) => void invite(event)}><label>초대할 email<input type="email" required maxLength={320} value={email} disabled={Boolean(pending)} onChange={(event) => setEmail(event.target.value)} placeholder="member@example.com" /></label><label>역할<select aria-label="초대할 역할" value={role} disabled={Boolean(pending)} onChange={(event) => setRole(event.target.value as WorkspaceInvitationRole)}>{workspaceInvitationRoles.filter((entry) => active.role === 'owner' || entry === 'member' || entry === 'viewer').map((entry) => <option key={entry} value={entry}>{entry}</option>)}</select></label><button className="primary-action" type="submit" disabled={Boolean(pending) || !email.trim()}>{pending === 'invite' ? <LoaderCircle className="spin" size={13} /> : <Mail size={13} />} 초대 링크 생성</button></form>
          {createdLink && <div className="invitation-created" role="status"><div><strong>이 링크는 지금 한 번만 표시됩니다.</strong><span>외부 이메일은 발송하지 않습니다. 안전한 채널로 직접 전달하세요.</span></div><div className="invitation-copy-row"><input ref={linkRef} aria-label="새 workspace 초대 링크" readOnly value={createdLink} onFocus={(event) => event.currentTarget.select()} /><button className="secondary-action" type="button" onClick={() => void copyLink()}>{copyStatus === 'copied' ? <Check size={12} /> : <Copy size={12} />}{copyStatus === 'copied' ? '복사됨' : '복사'}</button><button className="icon-button" type="button" aria-label="초대 링크 닫기" onClick={() => { setCreatedLink(''); setCopyStatus(''); }}><X size={12} /></button></div>{copyStatus === 'manual' && <span className="invitation-copy-fallback" role="alert">클립보드 접근이 거부되었습니다. 선택된 링크를 직접 복사하세요.</span>}</div>}
          <h4 className="workspace-subheading">대기 중인 초대</h4>
          <div className="workspace-invitation-list" aria-live="polite">
            {invitationsInitialLoading && <p className="dialog-empty"><LoaderCircle className="spin" size={13} /> 초대를 불러오는 중…</p>}
            {!invitationsInitialLoading && invitationsInitialError && <div className="workspace-management-error" role="alert"><span>{invitationsInitialError}</span><button className="secondary-action" disabled={Boolean(pending)} onClick={() => void loadInvitationPage(active.id, undefined, scopeRef.current)}><RefreshCw size={12} /> 다시 시도</button></div>}
            {!invitationsInitialLoading && !invitationsInitialError && invitations.length === 0 && <p className="dialog-empty">대기 중인 초대가 없습니다.</p>}
            {!invitationsInitialLoading && invitations.map((entry) => <div className="workspace-invitation-row" key={entry.id}><div><strong>{entry.targetEmail}</strong><span>{entry.role} · {new Date(entry.expiresAt).toLocaleString()} 만료</span></div><button className="icon-button" type="button" aria-label={`${entry.targetEmail} 초대 취소`} title={active.role === 'owner' || entry.role !== 'admin' ? '초대 취소' : 'Admin 초대는 owner만 취소할 수 있습니다'} disabled={Boolean(pending) || (active.role === 'admin' && entry.role === 'admin')} onClick={() => void revokeInvitation(entry)}>{pending === `invite:${entry.id}` ? <LoaderCircle className="spin" size={13} /> : <Trash2 size={13} />}</button></div>)}
            {!invitationsInitialLoading && invitationsMoreError && <div className="workspace-management-error" role="alert"><span>{invitationsMoreError}</span><button className="secondary-action" disabled={Boolean(pending) || invitationsMoreLoading} onClick={() => void loadInvitationPage(active.id, invitationsCursor, scopeRef.current)}><RefreshCw size={12} /> 더 보기 다시 시도</button></div>}
            {!invitationsInitialLoading && !invitationsMoreError && invitationsCursor && <button className="secondary-action workspace-page-more" type="button" disabled={Boolean(pending) || invitationsMoreLoading} onClick={() => void loadInvitationPage(active.id, invitationsCursor, scopeRef.current)}>{invitationsMoreLoading ? <LoaderCircle className="spin" size={12} /> : null} 초대 더 보기</button>}
          </div>
        </>}
        <h4 className="workspace-subheading">현재 멤버</h4>
        <div className="workspace-member-list" aria-live="polite">
          {membersInitialLoading && <p className="dialog-empty"><LoaderCircle className="spin" size={13} /> 멤버를 불러오는 중…</p>}
          {!membersInitialLoading && membersInitialError && <div className="workspace-management-error" role="alert"><span>{membersInitialError}</span><button className="secondary-action" disabled={Boolean(pending)} onClick={() => void loadMemberPage(active.id, undefined, scopeRef.current)}><RefreshCw size={12} /> 다시 시도</button></div>}
          {!membersInitialLoading && !membersInitialError && members.length === 0 && <p className="dialog-empty">표시할 멤버가 없습니다.</p>}
          {!membersInitialLoading && members.map((entry) => <div className="workspace-member-row" key={entry.userId}><div><strong>{entry.displayName || entry.email}{entry.userId === props.account.user.id ? ' (나)' : ''}</strong><span>{entry.email}</span></div><select aria-label={`${entry.email} 역할`} value={entry.role} disabled={Boolean(pending) || !adminCanChange(entry)} onChange={(event) => void changeRole(entry, event.target.value as WorkspaceRole)}>{workspaceRoles.filter((next) => active.role === 'owner' || next === entry.role || next === 'member' || next === 'viewer').map((next) => <option key={next} value={next}>{next}</option>)}</select><button className="icon-button" aria-label={`${entry.email} 제거`} title={mayRemove(entry) ? 'Workspace에서 제거' : '이 역할은 관리할 수 없습니다'} disabled={Boolean(pending) || !mayRemove(entry)} onClick={() => void remove(entry)}>{pending === `remove:${entry.userId}` ? <LoaderCircle className="spin" size={13} /> : <Trash2 size={13} />}</button></div>)}
          {!membersInitialLoading && membersMoreError && <div className="workspace-management-error" role="alert"><span>{membersMoreError}</span><button className="secondary-action" disabled={Boolean(pending) || membersMoreLoading} onClick={() => void loadMemberPage(active.id, membersCursor, scopeRef.current)}><RefreshCw size={12} /> 더 보기 다시 시도</button></div>}
          {!membersInitialLoading && !membersMoreError && membersCursor && <button className="secondary-action workspace-page-more" type="button" disabled={Boolean(pending) || membersMoreLoading} onClick={() => void loadMemberPage(active.id, membersCursor, scopeRef.current)}>{membersMoreLoading ? <LoaderCircle className="spin" size={12} /> : null} 멤버 더 보기</button>}
        </div>
        {actionError && <div className="workspace-management-error" role="alert"><span>{actionError}</span></div>}
      </section>}
      {active?.role === 'owner' && <section className="workspace-management-section workspace-danger-section" aria-labelledby="archive-workspace-title"><div className="dialog-intro"><div className="dialog-icon"><Archive size={20} /></div><div><h3 id="archive-workspace-title">워크스페이스 보관</h3><p>새 접근은 즉시 차단되고 현재 UI runtime은 즉시 전환되거나 종료됩니다. 다른 곳에서 이미 열린 연결은 세션 만료 또는 최대 5분 주기의 재인가 때 닫힙니다. Database, history, RAG, audit 행과 로컬 tenant 파일은 그대로 유지되며 안전한 삭제가 아닙니다.</p></div></div>
        <p className="workspace-archive-note">이 단계의 보관은 한 방향이며 self-service 복원 기능이 없습니다. 계속하려면 현재 이름 <strong>{active.name}</strong>을 정확히 입력하세요.</p>
        <form className="workspace-inline-form workspace-archive-form" onSubmit={(event) => void archive(event)}><label>현재 workspace 이름 확인<input aria-label="보관할 workspace 이름 확인" required maxLength={PRODUCT_WORKSPACE_NAME_MAX_UTF16_CODE_UNITS} autoComplete="off" value={archiveConfirmation} disabled={archivePending || renamePending} onChange={(event) => setArchiveConfirmation(event.target.value)} /></label><button className="danger-action" type="submit" disabled={archivePending || renamePending || archiveConfirmation !== active.name}>{archivePending ? <LoaderCircle className="spin" size={13} /> : <Archive size={13} />} 워크스페이스 보관</button></form>
        {archiveError && <div className="workspace-management-error" role="alert"><span>{archiveError}</span></div>}
      </section>}
      {active?.role === 'owner' && <section className="workspace-management-section workspace-danger-section" aria-labelledby="delete-workspace-title"><div className="dialog-intro"><div className="dialog-icon"><Trash2 size={20} /></div><div><h3 id="delete-workspace-title">Workspace 영구 삭제</h3><p>새 접근을 즉시 차단하고 durable worker가 이 Workspace의 History, RAG, audit, membership과 연결된 Local tenant root를 삭제합니다. Active runtime lease 또는 legal hold가 있으면 안전하게 대기합니다.</p></div></div>
        <p className="workspace-archive-note">Online DB와 연결된 Local 설치 범위의 삭제이며 secure erasure가 아닙니다. Backup, WAL, replica, snapshot, 수동 복사본과 영구 offline 장치는 별도 보존 정책이 적용됩니다. 늦게 연결되는 Local 설치를 정리하기 위한 payload-free lifecycle UUID tombstone은 남습니다.</p>
        <form className="security-password-form" onSubmit={(event) => void permanentlyDelete(event)}><label>현재 비밀번호<input aria-label="Workspace 영구 삭제 현재 비밀번호" type="password" autoComplete="current-password" value={deletePassword} disabled={dialogBusy} onChange={(event) => setDeletePassword(event.target.value)} /></label><label>현재 Workspace 이름<input aria-label="영구 삭제할 Workspace 이름 확인" autoComplete="off" value={deleteName} disabled={dialogBusy} onChange={(event) => setDeleteName(event.target.value)} /></label><label><code>{PRODUCT_WORKSPACE_DELETE_CONFIRMATION}</code> 입력<input aria-label="Workspace 영구 삭제 확인" autoComplete="off" value={deleteConfirmation} disabled={dialogBusy} onChange={(event) => setDeleteConfirmation(event.target.value)} /></label><button className="danger-action" type="submit" disabled={dialogBusy || !deletePassword || deleteName !== active.name || deleteConfirmation !== PRODUCT_WORKSPACE_DELETE_CONFIRMATION}>{deletePending ? <LoaderCircle className="spin" size={13} /> : <Trash2 size={13} />} 영구 삭제 요청</button></form>
        {deleteError && <div className="workspace-management-error" role="alert"><span>{deleteError}</span></div>}
      </section>}
      {!active && <p className="workspace-permission-note">현재 실행 가능한 workspace가 없습니다. 새 workspace를 생성하면 owner로 바로 시작할 수 있습니다.</p>}
    </div>
  </section></div>;
}
