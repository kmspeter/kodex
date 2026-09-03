import { KeyRound, Laptop, LoaderCircle, LogOut, RefreshCw, ShieldCheck, Trash2, X } from 'lucide-react';
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { validateRegistrationPassword } from '../auth/AuthGate';
import type { ProductAuthClient, ProductSession } from '../auth/product-auth';
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
    </div>
  </section></div>;
}
