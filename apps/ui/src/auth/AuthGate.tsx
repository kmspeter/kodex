import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { AlertTriangle, LoaderCircle, LockKeyhole, Mail, RefreshCw, UserPlus, X } from 'lucide-react';
import { KodexMark } from '../components/Brand';
import {
  isAbortError,
  ProductAuthClient,
  ProductAuthConfigurationError,
  ProductAuthError,
  type ProductAuthContext,
  type ProductAuthEstablishment,
  type ProductVerificationPending,
  type ProductWorkspaceInvitationPreview,
} from './product-auth';

type AuthState =
  | { status: 'authenticated'; context: ProductAuthContext }
  | { status: 'checking'; message: string }
  | { status: 'unauthenticated' }
  | { status: 'unavailable'; message: string };

export const MAX_SESSION_REVALIDATION_MS = 5 * 60 * 1_000;
// Keep clock-skew recovery bounded without turning an already-past client-side
// expiry into a tight polling loop against auth_sessions.last_seen_at.
export const MIN_SESSION_REVALIDATION_MS = 30_000;
export const FOREGROUND_REVALIDATION_THROTTLE_MS = 10_000;

export function sessionRevalidationDelay(expiresAt: string, now = Date.now()): number {
  const remaining = Date.parse(expiresAt) - now;
  if (!Number.isFinite(remaining)) return MIN_SESSION_REVALIDATION_MS;
  return Math.max(
    MIN_SESSION_REVALIDATION_MS,
    Math.min(MAX_SESSION_REVALIDATION_MS, remaining),
  );
}

class RevalidationControl {
  #stop: () => void = () => undefined;

  install(stop: () => void): void {
    this.#stop = stop;
  }

  remove(stop: () => void): void {
    if (this.#stop === stop) this.#stop = () => undefined;
  }

  stop(): void {
    const stop = this.#stop;
    this.#stop = () => undefined;
    stop();
  }
}

interface ProductAuthGateProps {
  children: (
    context: ProductAuthContext,
    logout: () => Promise<void>,
    loggingOut: boolean,
    client: ProductAuthClient,
    updateContext: (context: ProductAuthContext) => void,
  ) => ReactNode;
  client?: ProductAuthClient;
  initialEmailVerificationToken?: string | null;
  initialInvitationToken?: string | null;
  initialPasswordResetToken?: string | null;
}

type InvitationPreviewState =
  | { status: 'checking' }
  | { status: 'ready'; value: ProductWorkspaceInvitationPreview }
  | { status: 'unavailable'; message: string };

function unavailableMessage(error: unknown): string {
  if (error instanceof ProductAuthConfigurationError) return error.message;
  if (error instanceof ProductAuthError && error.kind === 'invalid-response') {
    return '인증 API 응답을 안전하게 확인할 수 없습니다. 서버 설정을 확인한 뒤 다시 시도하세요.';
  }
  return '인증 API에 연결할 수 없습니다. 계정이 없는 상태로 처리하지 않았습니다.';
}

function AuthUnavailable(props: { message: string; onRetry: () => void }) {
  return <main className="auth-screen"><section className="auth-card recovery-card" aria-labelledby="auth-unavailable-title">
    <div className="auth-brand"><KodexMark /><span>Kodex</span></div>
    <div className="auth-status-icon is-error"><AlertTriangle size={20} /></div>
    <h1 id="auth-unavailable-title">인증 서비스를 확인할 수 없습니다</h1>
    <p>{props.message}</p>
    <button className="auth-submit" type="button" onClick={props.onRetry}><RefreshCw size={14} /> 다시 시도</button>
  </section></main>;
}

export function ProductAuthGate({
  children,
  client: providedClient,
  initialEmailVerificationToken = null,
  initialInvitationToken = null,
  initialPasswordResetToken = null,
}: ProductAuthGateProps) {
  const [clientResult] = useState(() => {
    try {
      return { client: providedClient ?? new ProductAuthClient(), error: null };
    } catch (error) {
      return { client: null, error };
    }
  });
  const client = clientResult.client;
  const [state, setState] = useState<AuthState>({
    status: 'checking',
    message: '제품 세션을 확인하는 중…',
  });
  const [attempt, setAttempt] = useState(0);
  const [loggingOut, setLoggingOut] = useState(false);
  const [revalidationControl] = useState(() => new RevalidationControl());
  const [invitationToken, setInvitationToken] = useState(initialInvitationToken);
  const [invitationAttempt, setInvitationAttempt] = useState(0);
  const [invitationPreview, setInvitationPreview] = useState<InvitationPreviewState>({ status: 'checking' });
  const [invitationOutcome, setInvitationOutcome] = useState('');
  const [passwordResetToken, setPasswordResetToken] = useState(initialPasswordResetToken);
  const [emailVerificationToken, setEmailVerificationToken] = useState(initialEmailVerificationToken);
  const [verificationPending, setVerificationPending] = useState<ProductVerificationPending | null>(null);
  const authenticatedContext = state.status === 'authenticated' ? state.context : null;

  useEffect(() => {
    if (!client) return;
    return client.onUnauthenticated(() => {
      revalidationControl.stop();
      setLoggingOut(false);
      setState({ status: 'unauthenticated' });
    });
  }, [client, revalidationControl]);

  useEffect(() => {
    if (!client) return;
    let active = true;
    const controller = new AbortController();
    const generation = client.sessionGeneration;
    setState({ status: 'checking', message: '제품 세션을 확인하는 중…' });
    void client.me({ signal: controller.signal }).then((context) => {
      if (active && generation === client.sessionGeneration) {
        setState({ status: 'authenticated', context });
      }
    }).catch((error: unknown) => {
      if (!active || generation !== client.sessionGeneration || isAbortError(error)) return;
      if (error instanceof ProductAuthError && error.kind === 'unauthenticated') {
        setState({ status: 'unauthenticated' });
      } else {
        setState({ status: 'unavailable', message: unavailableMessage(error) });
      }
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [attempt, client]);

  useEffect(() => {
    if (!client || !invitationToken) return;
    let active = true;
    setInvitationPreview({ status: 'checking' });
    void client.previewWorkspaceInvitation(invitationToken).then((value) => {
      if (active) setInvitationPreview({ status: 'ready', value });
    }).catch((error: unknown) => {
      if (!active) return;
      if (error instanceof ProductAuthError && error.kind === 'unavailable') {
        setInvitationPreview({ status: 'unavailable', message: '초대 정보를 불러올 수 없습니다. 잠시 후 다시 시도하세요.' });
      } else {
        setInvitationToken(null);
        setInvitationOutcome('이 초대는 유효하지 않거나 이미 만료·취소·사용되었습니다.');
      }
    });
    return () => { active = false; };
  }, [client, invitationAttempt, invitationToken]);

  useEffect(() => {
    if (!client || !authenticatedContext) {
      revalidationControl.stop();
      return;
    }
    const authClient = client;
    const contextAtStart = authenticatedContext;
    const generationAtStart = client.sessionGeneration;

    let active = true;
    let timer: number | null = null;
    let pendingController: AbortController | null = null;
    let validating = false;
    let lastValidatedAt = Date.now();

    function clearTimer(): void {
      if (timer === null) return;
      window.clearTimeout(timer);
      timer = null;
    }

    function schedule(context: ProductAuthContext): void {
      clearTimer();
      if (!active) return;
      timer = window.setTimeout(() => {
        timer = null;
        void revalidate('timer');
      }, sessionRevalidationDelay(context.session.expiresAt));
    }

    async function revalidate(trigger: 'foreground' | 'timer'): Promise<void> {
      const now = Date.now();
      if (
        !active
        || generationAtStart !== authClient.sessionGeneration
        || validating
        || (trigger === 'foreground'
          && now - lastValidatedAt < FOREGROUND_REVALIDATION_THROTTLE_MS)
      ) {
        return;
      }
      clearTimer();
      validating = true;
      const controller = new AbortController();
      pendingController = controller;
      try {
        const context = await authClient.me({ signal: controller.signal });
        if (
          !active
          || pendingController !== controller
          || generationAtStart !== authClient.sessionGeneration
        ) return;
        lastValidatedAt = Date.now();
        setState({ status: 'authenticated', context });
        schedule(context);
      } catch (error) {
        if (
          !active
          || pendingController !== controller
          || controller.signal.aborted
          || generationAtStart !== authClient.sessionGeneration
          || isAbortError(error)
        ) return;
        if (error instanceof ProductAuthError && error.kind === 'unauthenticated') {
          setState({ status: 'unauthenticated' });
        } else {
          setState({ status: 'unavailable', message: unavailableMessage(error) });
        }
      } finally {
        if (pendingController === controller) pendingController = null;
        validating = false;
      }
    }

    function onFocus(): void {
      void revalidate('foreground');
    }

    function onVisibilityChange(): void {
      if (document.visibilityState === 'visible') void revalidate('foreground');
    }

    function stop(): void {
      if (!active) return;
      active = false;
      clearTimer();
      pendingController?.abort();
      pendingController = null;
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    }

    revalidationControl.install(stop);
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibilityChange);
    schedule(contextAtStart);

    return () => {
      stop();
      revalidationControl.remove(stop);
    };
  }, [authenticatedContext, client, revalidationControl]);

  const logout = useCallback(async (): Promise<void> => {
    if (loggingOut || !client) return;
    setLoggingOut(true);
    revalidationControl.stop();
    // Unmount the runtime before waiting for the network so sockets and in-memory
    // Codex credentials are removed immediately when logout begins.
    setState({ status: 'checking', message: '세션을 종료하는 중…' });
    const request = client.logout();
    const generation = client.sessionGeneration;
    try {
      await request;
      if (generation !== client.sessionGeneration) return;
      setState({ status: 'unauthenticated' });
    } catch (error) {
      if (generation !== client.sessionGeneration || isAbortError(error)) return;
      if (error instanceof ProductAuthError && error.kind === 'unauthenticated') {
        setState({ status: 'unauthenticated' });
      } else {
        setState({ status: 'unavailable', message: unavailableMessage(error) });
      }
    } finally {
      if (generation === client.sessionGeneration) setLoggingOut(false);
    }
  }, [client, loggingOut, revalidationControl]);

  if (!client) {
    return <AuthUnavailable
      message={unavailableMessage(clientResult.error)}
      onRetry={() => window.location.reload()}
    />;
  }

  if (passwordResetToken) {
    return <PasswordResetCompletion
      client={client}
      token={passwordResetToken}
      onComplete={() => {
        client.clearMemory();
        setPasswordResetToken(null);
        setState({ status: 'unauthenticated' });
      }}
      onCancel={() => setPasswordResetToken(null)}
    />;
  }

  if (emailVerificationToken) {
    return <EmailVerificationCompletion
      client={client}
      token={emailVerificationToken}
      onComplete={() => {
        setEmailVerificationToken(null);
        setVerificationPending(null);
        setState({ status: 'checking', message: '확인된 제품 세션을 불러오는 중…' });
        setAttempt((value) => value + 1);
      }}
      onCancel={() => setEmailVerificationToken(null)}
    />;
  }

  if (verificationPending) {
    return <EmailVerificationPending
      client={client}
      pending={verificationPending}
      onAuthenticated={(context) => {
        setVerificationPending(null);
        setState({ status: 'authenticated', context });
      }}
      onUseAnotherAccount={() => {
        setVerificationPending(null);
        void logout();
      }}
    />;
  }

  if (invitationOutcome) {
    return <main className="auth-screen"><section className="auth-card recovery-card" aria-labelledby="invitation-outcome-title">
      <div className="auth-brand"><KodexMark /><span>Kodex</span></div>
      <div className="auth-status-icon is-error"><AlertTriangle size={20} /></div>
      <h1 id="invitation-outcome-title">Workspace 초대를 처리할 수 없습니다</h1>
      <p role="alert">{invitationOutcome}</p>
      <button className="auth-submit" type="button" onClick={() => setInvitationOutcome('')}>계속</button>
    </section></main>;
  }
  if (invitationToken && invitationPreview.status === 'checking') {
    return <main className="boot-screen"><KodexMark /><LoaderCircle className="spin" size={20} /><p>Workspace 초대를 확인하는 중…</p></main>;
  }
  if (invitationToken && invitationPreview.status === 'unavailable') {
    return <AuthUnavailable message={invitationPreview.message} onRetry={() => setInvitationAttempt((value) => value + 1)} />;
  }

  if (state.status === 'checking') {
    return <main className="boot-screen"><KodexMark /><LoaderCircle className="spin" size={20} /><p>{state.message}</p></main>;
  }
  if (state.status === 'unavailable') {
    return <AuthUnavailable message={state.message} onRetry={() => setAttempt((value) => value + 1)} />;
  }
  if (state.status === 'unauthenticated') {
    return <AuthForm
      client={client}
      invitation={invitationToken && invitationPreview.status === 'ready' ? invitationPreview.value : undefined}
      onEstablished={(result) => {
        if ('status' in result && result.status === 'verification_pending') {
          setVerificationPending(result);
        } else {
          setState({ status: 'authenticated', context: result as ProductAuthContext });
        }
      }}
    />;
  }
  if (invitationToken && invitationPreview.status === 'ready') {
    return <InvitationAcceptance
      client={client}
      preview={invitationPreview.value}
      token={invitationToken}
      onDismiss={() => setInvitationToken(null)}
      onFailed={() => {
        setInvitationToken(null);
        setInvitationOutcome('초대를 수락하지 못했습니다. 로그인 계정의 이메일이 초대 대상과 일치하는지 확인하세요.');
      }}
      onAccepted={(context) => {
        setInvitationToken(null);
        setState({ status: 'authenticated', context });
      }}
    />;
  }
  const childGeneration = client.sessionGeneration;
  return children(
    state.context,
    logout,
    loggingOut,
    client,
    (context) => {
      if (childGeneration !== client.sessionGeneration) return;
      setState((current) => current.status === 'authenticated'
        ? { status: 'authenticated', context }
        : current);
    },
  );
}

type AuthMode = 'login' | 'register' | 'recover';

export function passwordByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function validateRegistrationPassword(value: string): string | null {
  const bytes = passwordByteLength(value);
  if (bytes < 12) return '비밀번호는 UTF-8 기준 12바이트 이상이어야 합니다.';
  if (bytes > 1_024) return '비밀번호는 UTF-8 기준 1,024바이트 이하여야 합니다.';
  return null;
}

export function AuthForm(props: {
  client: Pick<ProductAuthClient, 'login' | 'register'> & Partial<Pick<ProductAuthClient, 'requestPasswordReset'>>;
  invitation?: ProductWorkspaceInvitationPreview;
  onAuthenticated?: (context: ProductAuthContext) => void;
  onEstablished?: (result: ProductAuthEstablishment) => void;
}) {
  const [mode, setMode] = useState<AuthMode>('login');
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const emailRef = useRef<HTMLInputElement>(null);

  function changeMode(next: AuthMode): void {
    if (busy || next === mode) return;
    setMode(next);
    setError('');
    setNotice('');
    setPassword('');
    window.setTimeout(() => emailRef.current?.focus(), 0);
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy) return;
    const normalizedEmail = email.trim();
    const requestPasswordReset = props.client.requestPasswordReset;
    if (!normalizedEmail) {
      setError('이메일을 입력하세요.');
      emailRef.current?.focus();
      return;
    }
    if (!emailRef.current?.checkValidity()) {
      setError('올바른 이메일 주소를 입력하세요.');
      emailRef.current?.focus();
      return;
    }
    if (mode === 'register') {
      const passwordError = validateRegistrationPassword(password);
      if (passwordError) {
        setError(passwordError);
        return;
      }
      if (displayName.trim().length > 100) {
        setError('표시 이름은 100자 이하여야 합니다.');
        return;
      }
    } else if (mode === 'login' && (!password || passwordByteLength(password) > 1_024)) {
      setError('이메일 또는 비밀번호를 확인하세요.');
      return;
    }
    if (mode === 'recover' && !requestPasswordReset) {
      setError('재설정 요청을 처리할 수 없습니다. 잠시 후 다시 시도하세요.');
      return;
    }

    setBusy(true);
    setError('');
    const request = mode === 'login'
      ? props.client.login({ email: normalizedEmail, password })
      : mode === 'register'
        ? props.client.register({
          email: normalizedEmail,
          password,
          ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
        })
        : requestPasswordReset!(normalizedEmail);
    // The request body has already been constructed. Remove the password from
    // the controlled field while the request is in flight.
    setPassword('');
    try {
      const result = await request;
      if (mode === 'recover') {
        setNotice('계정이 존재하면 비밀번호 재설정 안내를 보냈습니다. 이메일을 확인하세요.');
      } else {
        const established = result as ProductAuthEstablishment;
        if ('status' in established && established.status === 'verification_pending') {
          props.onEstablished?.(established);
        } else {
          props.onEstablished?.(established);
          props.onAuthenticated?.(established as ProductAuthContext);
        }
      }
    } catch (requestError) {
      if (requestError instanceof ProductAuthError && requestError.kind === 'unavailable') {
        setError('인증 서비스에 연결할 수 없습니다. 잠시 후 다시 시도하세요.');
      } else if (requestError instanceof ProductAuthError && requestError.kind === 'invalid-response') {
        setError('인증 응답을 안전하게 확인할 수 없습니다. 다시 시도하세요.');
      } else {
        setError(mode === 'login'
          ? '이메일 또는 비밀번호가 올바르지 않습니다.'
          : mode === 'register'
            ? '계정을 만들 수 없습니다. 입력을 확인하거나 잠시 후 다시 시도하세요.'
            : '재설정 요청을 처리할 수 없습니다. 잠시 후 다시 시도하세요.');
      }
    } finally {
      setBusy(false);
    }
  }

  return <main className="auth-screen"><section className="auth-card" aria-labelledby="auth-title">
    <div className="auth-brand"><KodexMark /><span>Kodex</span></div>
    {props.invitation && <div className="invitation-auth-note"><Mail size={17} /><div><strong>{props.invitation.workspaceName} 초대</strong><span>{props.invitation.targetEmailHint} · {props.invitation.role}</span><small>로그인하거나 가입한 뒤 이 화면에서 초대를 수락합니다.</small></div></div>}
    <div className="auth-heading"><div className="auth-status-icon"><LockKeyhole size={19} /></div><div>
      <h1 id="auth-title">{mode === 'login' ? 'Kodex에 로그인' : mode === 'register' ? 'Kodex 계정 만들기' : '비밀번호 재설정'}</h1>
      <p>계정 확인 후 로컬 에이전트 작업공간을 시작합니다.</p>
    </div></div>
    <div className="auth-tabs" role="tablist" aria-label="인증 방법">
      <button type="button" role="tab" aria-selected={mode === 'login'} onClick={() => changeMode('login')}>로그인</button>
      <button type="button" role="tab" aria-selected={mode === 'register'} onClick={() => changeMode('register')}>회원가입</button>
    </div>
    <form className="auth-form" onSubmit={(event) => void submit(event)} noValidate>
      {mode === 'register' && <label>표시 이름 <span>선택</span><input name="displayName" type="text" autoComplete="name" maxLength={100} value={displayName} disabled={busy} onChange={(event) => setDisplayName(event.target.value)} /></label>}
      <label>이메일<input ref={emailRef} name="email" type="email" autoComplete="email" inputMode="email" required value={email} disabled={busy} onChange={(event) => setEmail(event.target.value)} /></label>
      {mode !== 'recover' && <label>비밀번호<input name="password" type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required value={password} disabled={busy} onChange={(event) => setPassword(event.target.value)} aria-describedby={mode === 'register' ? 'password-help' : undefined} /></label>}
      {mode === 'register' && <p className="auth-help" id="password-help">UTF-8 기준 12~1,024바이트. 한글과 이모지는 문자 수보다 더 많은 바이트를 사용할 수 있습니다.</p>}
      {error && <p className="auth-error" role="alert">{error}</p>}
      {notice && <p className="auth-help" role="status">{notice}</p>}
      <button className="auth-submit" type="submit" disabled={busy || (mode === 'recover' && !props.client.requestPasswordReset)}>{busy && <LoaderCircle className="spin" size={14} />}{busy ? '확인 중…' : mode === 'login' ? '로그인' : mode === 'register' ? '계정 만들기' : '재설정 안내 보내기'}</button>
      {mode === 'login' && <button className="auth-link-button" type="button" disabled={busy} onClick={() => changeMode('recover')}>비밀번호를 잊으셨나요?</button>}
      {mode === 'recover' && <button className="auth-link-button" type="button" disabled={busy} onClick={() => changeMode('login')}>로그인으로 돌아가기</button>}
    </form>
    <p className="auth-security-note">세션은 브라우저의 HttpOnly 쿠키로만 관리되며 비밀번호를 기기에 저장하지 않습니다.</p>
  </section></main>;
}

function EmailVerificationPending(props: {
  client: Pick<ProductAuthClient, 'emailVerificationStatus' | 'me' | 'resendEmailVerification'>;
  onAuthenticated: (context: ProductAuthContext) => void;
  onUseAnotherAccount: () => void;
  pending: ProductVerificationPending;
}) {
  const [busy, setBusy] = useState<'check' | 'resend' | ''>('');
  const [message, setMessage] = useState('확인 링크를 보냈습니다. 이메일에서 링크를 연 뒤 상태를 확인하세요.');
  const [error, setError] = useState('');

  async function check(): Promise<void> {
    if (busy) return;
    setBusy('check');
    setError('');
    try {
      const status = await props.client.emailVerificationStatus();
      if (status.email !== props.pending.email) {
        throw new ProductAuthError('invalid-response', 'The email verification status account did not match.');
      }
      if (status.status === 'verified') {
        props.onAuthenticated(await props.client.me());
      } else {
        setMessage('아직 확인되지 않았습니다. 이메일 링크를 연 뒤 다시 확인하세요.');
      }
    } catch {
      setError('확인 상태를 불러올 수 없습니다. 잠시 후 다시 시도하세요.');
    } finally {
      setBusy('');
    }
  }

  async function resend(): Promise<void> {
    if (busy) return;
    setBusy('resend');
    setError('');
    try {
      await props.client.resendEmailVerification();
      setMessage('확인 이메일을 다시 요청했습니다. 이전 링크는 더 이상 사용할 수 없습니다.');
    } catch {
      setError('확인 이메일을 다시 요청할 수 없습니다. 잠시 후 다시 시도하세요.');
    } finally {
      setBusy('');
    }
  }

  return <main className="auth-screen"><section className="auth-card recovery-card" aria-labelledby="verification-pending-title" aria-busy={Boolean(busy)}>
    <div className="auth-brand"><KodexMark /><span>Kodex</span></div>
    <div className="auth-status-icon"><Mail size={20} /></div>
    <h1 id="verification-pending-title">이메일 확인이 필요합니다</h1>
    <p><strong>{props.pending.email}</strong></p>
    <p className="auth-help" role="status">{message}</p>
    {error && <p className="auth-error" role="alert">{error}</p>}
    <button className="auth-submit" type="button" disabled={Boolean(busy)} onClick={() => void check()}>{busy === 'check' && <LoaderCircle className="spin" size={14} />} 확인 상태 확인</button>
    <button className="auth-link-button" type="button" disabled={Boolean(busy)} onClick={() => void resend()}>{busy === 'resend' && <LoaderCircle className="spin" size={14} />} 확인 이메일 다시 보내기</button>
    <button className="auth-link-button" type="button" disabled={Boolean(busy)} onClick={props.onUseAnotherAccount}>다른 계정 사용</button>
  </section></main>;
}

function EmailVerificationCompletion(props: {
  client: Pick<ProductAuthClient, 'completeEmailVerification'>;
  onCancel: () => void;
  onComplete: () => void;
  token: string;
}) {
  const [busy, setBusy] = useState(false);
  const [complete, setComplete] = useState(false);
  const [error, setError] = useState('');

  async function verify(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await props.client.completeEmailVerification(props.token);
      setComplete(true);
    } catch {
      setError('확인 링크가 유효하지 않거나 만료·취소·사용되었습니다. 새 확인 이메일을 요청하세요.');
    } finally {
      setBusy(false);
    }
  }

  return <main className="auth-screen"><section className="auth-card recovery-card" aria-labelledby="email-verification-title" aria-busy={busy}>
    <div className="auth-brand"><KodexMark /><span>Kodex</span></div>
    <div className={`auth-status-icon${error ? ' is-error' : ''}`}><Mail size={20} /></div>
    <h1 id="email-verification-title">{complete ? '이메일 확인 완료' : '이메일 주소 확인'}</h1>
    <p>{complete ? '이메일 주소가 확인되었습니다. 같은 브라우저의 제한 세션 또는 비밀번호로 로그인할 수 있습니다.' : '이 링크를 한 번 사용해 가입 이메일의 소유권을 확인합니다.'}</p>
    {error && <p className="auth-error" role="alert">{error}</p>}
    {complete
      ? <button className="auth-submit" type="button" onClick={props.onComplete}>계속</button>
      : <><button className="auth-submit" type="button" disabled={busy} onClick={() => void verify()}>{busy && <LoaderCircle className="spin" size={14} />}{busy ? '확인 중…' : '이메일 확인'}</button><button className="auth-link-button" type="button" disabled={busy} onClick={props.onCancel}>취소</button></>}
  </section></main>;
}

function PasswordResetCompletion(props: {
  client: Pick<ProductAuthClient, 'completePasswordReset'>;
  onCancel: () => void;
  onComplete: () => void;
  token: string;
}) {
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy) return;
    const passwordError = validateRegistrationPassword(password);
    if (passwordError) { setError(passwordError); return; }
    if (password !== confirmation) { setError('새 비밀번호 확인이 일치하지 않습니다.'); return; }
    setBusy(true);
    setError('');
    const request = props.client.completePasswordReset(props.token, password);
    setPassword('');
    setConfirmation('');
    try {
      await request;
      props.onComplete();
    } catch (requestError) {
      if (requestError instanceof ProductAuthError && requestError.kind === 'unavailable') {
        setError('인증 서비스에 연결할 수 없습니다. 잠시 후 다시 시도하세요.');
      } else {
        setError('재설정 링크가 유효하지 않거나 만료·사용되었습니다. 새 안내를 요청하세요.');
      }
    } finally {
      setBusy(false);
    }
  }

  return <main className="auth-screen"><section className="auth-card" aria-labelledby="password-reset-title">
    <div className="auth-brand"><KodexMark /><span>Kodex</span></div>
    <div className="auth-heading"><div className="auth-status-icon"><LockKeyhole size={19} /></div><div>
      <h1 id="password-reset-title">새 비밀번호 설정</h1>
      <p>완료하면 기존의 모든 로그인 세션이 종료됩니다.</p>
    </div></div>
    <form className="auth-form" onSubmit={(event) => void submit(event)} noValidate>
      <label>새 비밀번호<input name="newPassword" type="password" autoComplete="new-password" required value={password} disabled={busy} onChange={(event) => setPassword(event.target.value)} /></label>
      <label>새 비밀번호 확인<input name="confirmPassword" type="password" autoComplete="new-password" required value={confirmation} disabled={busy} onChange={(event) => setConfirmation(event.target.value)} /></label>
      <p className="auth-help">UTF-8 기준 12~1,024바이트입니다.</p>
      {error && <p className="auth-error" role="alert">{error}</p>}
      <button className="auth-submit" type="submit" disabled={busy}>{busy && <LoaderCircle className="spin" size={14} />}{busy ? '변경 중…' : '비밀번호 변경'}</button>
      <button className="auth-link-button" type="button" disabled={busy} onClick={props.onCancel}>취소</button>
    </form>
  </section></main>;
}

function InvitationAcceptance(props: {
  client: ProductAuthClient;
  onAccepted: (context: ProductAuthContext) => void;
  onDismiss: () => void;
  onFailed: () => void;
  preview: ProductWorkspaceInvitationPreview;
  token: string;
}) {
  const [busy, setBusy] = useState(false);

  async function accept(): Promise<void> {
    if (busy) return;
    setBusy(true);
    const token = props.token;
    try {
      const accepted = await props.client.acceptWorkspaceInvitation(token);
      const refreshed = await props.client.me();
      const membership = refreshed.workspaces.find((workspace) => workspace.id === accepted.id);
      if (!membership) throw new ProductAuthError('invalid-response', 'Accepted workspace membership was not returned.');
      props.onAccepted({ ...refreshed, defaultWorkspace: membership });
    } catch {
      props.onFailed();
    }
  }

  return <main className="auth-screen"><section className="auth-card invitation-accept-card" aria-labelledby="invitation-accept-title" aria-busy={busy}>
    <button className="icon-button invitation-dismiss" type="button" aria-label="초대 닫기" disabled={busy} onClick={props.onDismiss}><X size={15} /></button>
    <div className="auth-brand"><KodexMark /><span>Kodex</span></div>
    <div className="auth-status-icon"><UserPlus size={20} /></div>
    <h1 id="invitation-accept-title">{props.preview.workspaceName} 참여</h1>
    <p><strong>{props.preview.targetEmailHint}</strong> 대상으로 <strong>{props.preview.role}</strong> 역할이 요청되었습니다.</p>
    <p className="auth-help">만료: {new Date(props.preview.expiresAt).toLocaleString()}</p>
    <button className="auth-submit" type="button" disabled={busy} onClick={() => void accept()}>{busy && <LoaderCircle className="spin" size={14} />}{busy ? '수락하는 중…' : '초대 수락'}</button>
  </section></main>;
}
