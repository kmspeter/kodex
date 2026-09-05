import { Download, KeyRound, Laptop, LoaderCircle, LogOut, RefreshCw, ShieldCheck, Trash2, X } from 'lucide-react';
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { PRODUCT_ACCOUNT_DELETE_CONFIRMATION } from '@kodex/product-contract';
import { validateRegistrationPassword } from '../auth/AuthGate';
import type { ProductAuthClient, ProductDataLifecycleJob, ProductSession } from '../auth/product-auth';
import { KodexMark } from './Brand';

function displayDate(value: string | null): string {
  if (!value) return '아직 기록 없음';
  return new Date(value).toLocaleString();
}

function activeSession(session: ProductSession): boolean {
  return !session.revoked && Date.parse(session.expiresAt) > Date.now();
}

export function SecurityDialog(props: {
  client: ProductAuthClient;
  onClose: () => void;
}) {
  const [sessions, setSessions] = useState<ProductSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pending, setPending] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [exportPassword, setExportPassword] = useState('');
  const [exportJob, setExportJob] = useState<ProductDataLifecycleJob | null>(null);
  const [accountPassword, setAccountPassword] = useState('');
  const [accountConfirmation, setAccountConfirmation] = useState('');
  const closeRef = useRef<HTMLButtonElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setSessions(await props.client.sessions());
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setLoading(false);
    }
  }, [props.client]);

  useEffect(() => {
    closeRef.current?.focus();
    void load();
  }, [load]);

  useEffect(() => {
    if (!exportJob || ['completed', 'failed'].includes(exportJob.status)) return;
    let cancelled = false;
    const timer = setInterval(() => {
      void props.client.dataLifecycleJob(exportJob.id).then((next) => {
        if (!cancelled) setExportJob(next);
      }).catch((nextError: unknown) => {
        if (!cancelled) setError(nextError instanceof Error ? nextError.message : String(nextError));
      });
    }, 1_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [exportJob, props.client]);

  async function changePassword(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending) return;
    const current = currentPassword;
    const next = newPassword;
    setCurrentPassword('');
    setNewPassword('');
    const validation = validateRegistrationPassword(next);
    if (!current || validation || current === next) {
      setError(validation ?? (current === next
        ? '새 비밀번호는 현재 비밀번호와 달라야 합니다.'
        : '현재 비밀번호를 입력하세요.'));
      return;
    }
    setPending('password');
    setError('');
    setNotice('');
    try {
      await props.client.changePassword(current, next);
      setNotice('비밀번호를 변경하고 현재 세션을 제외한 모든 세션을 종료했습니다.');
      await load();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setPending('');
    }
  }

  async function revoke(session: ProductSession): Promise<void> {
    if (pending || !activeSession(session)) return;
    setPending(`session:${session.id}`);
    setError('');
    setNotice('');
    try {
      await props.client.revokeSession(session);
      if (!session.current) {
        setNotice('선택한 세션을 종료했습니다.');
        await load();
      }
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setPending('');
    }
  }

  async function revokeOthers(): Promise<void> {
    if (pending) return;
    setPending('others');
    setError('');
    setNotice('');
    try {
      await props.client.revokeOtherSessions();
      setNotice('현재 세션을 제외한 모든 세션을 종료했습니다.');
      await load();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setPending('');
    }
  }

  async function logoutAll(): Promise<void> {
    if (pending) return;
    setPending('all');
    setError('');
    try {
      await props.client.logoutAll();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
      setPending('');
    }
  }

  async function requestExport(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending || !exportPassword) return;
    const currentPassword = exportPassword;
    setExportPassword('');
    setPending('export');
    setError('');
    setNotice('');
    try {
      const requested = await props.client.requestDataExport(currentPassword);
      setExportJob(requested);
      setNotice('내보내기 작업을 요청했습니다. 완료되면 이 창에서 JSON을 받을 수 있습니다.');
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setPending('');
    }
  }

  async function downloadExport(): Promise<void> {
    if (!exportJob || exportJob.status !== 'completed' || pending) return;
    setPending('download');
    setError('');
    try {
      const blob = await props.client.downloadDataExport(exportJob.id);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'kodex-user-export.json';
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setPending('');
    }
  }

  async function deleteAccount(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (
      pending
      || !accountPassword
      || accountConfirmation !== PRODUCT_ACCOUNT_DELETE_CONFIRMATION
    ) return;
    const currentPassword = accountPassword;
    const confirmation = accountConfirmation;
    setAccountPassword('');
    setAccountConfirmation('');
    setPending('account-delete');
    setError('');
    try {
      await props.client.deleteAccount(currentPassword, confirmation);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
      setPending('');
    }
  }

  const activeOtherSessions = sessions.filter((session) => !session.current && activeSession(session));
  return <div className="dialog-backdrop"><section className="app-dialog security-dialog" role="dialog" aria-modal="true" aria-labelledby="security-title" aria-busy={Boolean(pending)}>
    <header className="dialog-header"><div className="dialog-title-lockup"><KodexMark compact /><div><span>Product account</span><h2 id="security-title">Security</h2></div></div><button ref={closeRef} className="icon-button" aria-label="Close" disabled={Boolean(pending)} onClick={props.onClose}><X size={16} /></button></header>
    <div className="dialog-body security-body">
      <section className="security-section" aria-labelledby="password-title"><div className="dialog-intro"><div className="dialog-icon"><KeyRound size={20} /></div><div><h3 id="password-title">비밀번호 변경</h3><p>성공하면 이 기기의 현재 세션만 유지하고 다른 모든 활성 세션을 원자적으로 종료합니다.</p></div></div>
        <form className="security-password-form" onSubmit={(event) => void changePassword(event)}><label>현재 비밀번호<input aria-label="현재 비밀번호" type="password" autoComplete="current-password" value={currentPassword} disabled={Boolean(pending)} onChange={(event) => setCurrentPassword(event.target.value)} /></label><label>새 비밀번호<input aria-label="새 비밀번호" type="password" autoComplete="new-password" value={newPassword} disabled={Boolean(pending)} onChange={(event) => setNewPassword(event.target.value)} /></label><p>UTF-8 기준 12~1,024바이트. 요청을 시작하면 두 입력값을 즉시 지웁니다.</p><button className="primary-action" type="submit" disabled={Boolean(pending) || !currentPassword || !newPassword}>{pending === 'password' ? <LoaderCircle className="spin" size={13} /> : <ShieldCheck size={13} />} 비밀번호 변경</button></form>
      </section>
      <section className="security-section" aria-labelledby="sessions-title"><div className="dialog-intro"><div className="dialog-icon"><Laptop size={20} /></div><div><h3 id="sessions-title">세션</h3><p>세션 ID와 시간만 표시합니다. IP 주소, 전체 User-Agent, cookie와 token은 표시하거나 저장하지 않습니다.</p></div></div>
        <div className="security-actions"><button className="secondary-action" disabled={Boolean(pending) || activeOtherSessions.length === 0} onClick={() => void revokeOthers()}>{pending === 'others' ? <LoaderCircle className="spin" size={12} /> : <LogOut size={12} />} 다른 세션 모두 종료</button><button className="danger-action" disabled={Boolean(pending)} onClick={() => void logoutAll()}>{pending === 'all' ? <LoaderCircle className="spin" size={12} /> : <LogOut size={12} />} 모든 기기에서 로그아웃</button></div>
        <div className="security-session-list" aria-live="polite">{loading && <p className="dialog-empty"><LoaderCircle className="spin" size={13} /> 세션을 불러오는 중…</p>}{!loading && !error && sessions.length === 0 && <p className="dialog-empty">표시할 세션이 없습니다.</p>}{!loading && sessions.map((session) => <div className={`security-session-row ${activeSession(session) ? '' : 'is-revoked'}`} key={session.id}><Laptop size={15} /><div><strong>{session.current ? '현재 세션' : session.revoked ? '종료된 세션' : activeSession(session) ? '활성 세션' : '만료된 세션'}</strong><span>생성 {displayDate(session.createdAt)} · 최근 확인 {displayDate(session.lastSeenAt)}</span><small>만료 {displayDate(session.expiresAt)}{session.revokedAt ? ` · 종료 ${displayDate(session.revokedAt)}` : ''}</small></div><button className="icon-button" aria-label={`${session.current ? '현재' : session.id} 세션 종료`} disabled={Boolean(pending) || !activeSession(session)} onClick={() => void revoke(session)}>{pending === `session:${session.id}` ? <LoaderCircle className="spin" size={13} /> : <Trash2 size={13} />}</button></div>)}</div>
        {error && <div className="workspace-management-error" role="alert"><span>{error}</span><button className="secondary-action" disabled={Boolean(pending)} onClick={() => void load()}><RefreshCw size={12} /> 다시 시도</button></div>}{notice && <p className="security-notice" role="status">{notice}</p>}
      </section>
      <section className="security-section" aria-labelledby="data-export-title"><div className="dialog-intro"><div className="dialog-icon"><Download size={20} /></div><div><h3 id="data-export-title">내 데이터 내보내기</h3><p>Private History, RAG 원문과 내 account/workspace 기록을 bounded JSON으로 만듭니다. Password, session/reset/invitation token, provider credential과 embedding vector는 제외합니다.</p></div></div>
        <form className="security-password-form" onSubmit={(event) => void requestExport(event)}><label>현재 비밀번호<input aria-label="내보내기 현재 비밀번호" type="password" autoComplete="current-password" value={exportPassword} disabled={Boolean(pending)} onChange={(event) => setExportPassword(event.target.value)} /></label><button className="primary-action" type="submit" disabled={Boolean(pending) || !exportPassword}>{pending === 'export' ? <LoaderCircle className="spin" size={13} /> : <Download size={13} />} JSON 생성</button></form>
        {exportJob && <div className="security-actions" role="status"><span>내보내기 상태: {exportJob.status}</span><button className="secondary-action" type="button" disabled={Boolean(pending) || exportJob.status !== 'completed'} onClick={() => void downloadExport()}>{pending === 'download' ? <LoaderCircle className="spin" size={12} /> : <Download size={12} />} 다운로드</button></div>}
      </section>
      <section className="security-section workspace-danger-section" aria-labelledby="account-delete-title"><div className="dialog-intro"><div className="dialog-icon"><Trash2 size={20} /></div><div><h3 id="account-delete-title">계정 영구 삭제</h3><p>접근과 모든 session을 즉시 차단한 뒤 worker가 private DB data와 연결된 Local tenant root를 삭제합니다. 다른 멤버가 남은 소유 Workspace는 먼저 소유권을 이전하거나 별도로 삭제해야 합니다.</p></div></div>
        <p className="workspace-archive-note">이 요청은 online application data의 삭제이며 secure erasure가 아닙니다. Backup, WAL, replica, snapshot, 수동 복사본과 다시 연결되지 않는 장치는 각 보존 정책에 따라 별도로 만료해야 합니다. 늦게 연결되는 Local 설치를 정리하기 위한 payload-free lifecycle UUID tombstone은 남습니다.</p>
        <form className="security-password-form" onSubmit={(event) => void deleteAccount(event)}><label>현재 비밀번호<input aria-label="계정 삭제 현재 비밀번호" type="password" autoComplete="current-password" value={accountPassword} disabled={Boolean(pending)} onChange={(event) => setAccountPassword(event.target.value)} /></label><label><code>{PRODUCT_ACCOUNT_DELETE_CONFIRMATION}</code> 입력<input aria-label="계정 삭제 확인" autoComplete="off" value={accountConfirmation} disabled={Boolean(pending)} onChange={(event) => setAccountConfirmation(event.target.value)} /></label><button className="danger-action" type="submit" disabled={Boolean(pending) || !accountPassword || accountConfirmation !== PRODUCT_ACCOUNT_DELETE_CONFIRMATION}>{pending === 'account-delete' ? <LoaderCircle className="spin" size={13} /> : <Trash2 size={13} />} 계정 영구 삭제 요청</button></form>
      </section>
    </div>
  </section></div>;
}
