import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { AlertTriangle, LoaderCircle, LockKeyhole, RefreshCw } from 'lucide-react';
import { KodexMark } from '../components/Brand';
import {
  ProductAuthClient,
  ProductAuthConfigurationError,
  ProductAuthError,
  type ProductAuthContext,
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
  ) => ReactNode;
  client?: ProductAuthClient;
}

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

export function ProductAuthGate({ children, client: providedClient }: ProductAuthGateProps) {
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
  const authenticatedContext = state.status === 'authenticated' ? state.context : null;

  useEffect(() => {
    if (!client) return;
    return client.onUnauthenticated(() => {
      revalidationControl.stop();
      client.clearMemory();
      setLoggingOut(false);
      setState({ status: 'unauthenticated' });
    });
  }, [client, revalidationControl]);

  useEffect(() => {
    if (!client) return;
    let active = true;
    const controller = new AbortController();
    setState({ status: 'checking', message: '제품 세션을 확인하는 중…' });
    void client.me({ signal: controller.signal }).then((context) => {
      if (active) setState({ status: 'authenticated', context });
    }).catch((error: unknown) => {
      if (!active) return;
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
    if (!client || !authenticatedContext) {
      revalidationControl.stop();
      return;
    }
    const authClient = client;
    const contextAtStart = authenticatedContext;

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
        if (!active || pendingController !== controller) return;
        lastValidatedAt = Date.now();
        setState({ status: 'authenticated', context });
        schedule(context);
      } catch (error) {
        if (!active || pendingController !== controller || controller.signal.aborted) return;
        if (error instanceof ProductAuthError && error.kind === 'unauthenticated') {
          authClient.clearMemory();
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
    try {
      await client.logout();
      setState({ status: 'unauthenticated' });
    } catch (error) {
      if (error instanceof ProductAuthError && error.kind === 'unauthenticated') {
        setState({ status: 'unauthenticated' });
      } else {
        setState({ status: 'unavailable', message: unavailableMessage(error) });
      }
    } finally {
      client.clearMemory();
      setLoggingOut(false);
    }
  }, [client, loggingOut, revalidationControl]);

  if (!client) {
    return <AuthUnavailable
      message={unavailableMessage(clientResult.error)}
      onRetry={() => window.location.reload()}
    />;
  }

  if (state.status === 'checking') {
    return <main className="boot-screen"><KodexMark /><LoaderCircle className="spin" size={20} /><p>{state.message}</p></main>;
  }
  if (state.status === 'unavailable') {
    return <AuthUnavailable message={state.message} onRetry={() => setAttempt((value) => value + 1)} />;
  }
  if (state.status === 'unauthenticated') {
    return <AuthForm client={client} onAuthenticated={(context) => setState({ status: 'authenticated', context })} />;
  }
  return children(state.context, logout, loggingOut, client);
}

type AuthMode = 'login' | 'register';

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
  client: Pick<ProductAuthClient, 'login' | 'register'>;
  onAuthenticated: (context: ProductAuthContext) => void;
}) {
  const [mode, setMode] = useState<AuthMode>('login');
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);

  function changeMode(next: AuthMode): void {
    if (busy || next === mode) return;
    setMode(next);
    setError('');
    setPassword('');
    window.setTimeout(() => emailRef.current?.focus(), 0);
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy) return;
    const normalizedEmail = email.trim();
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
    } else if (!password || passwordByteLength(password) > 1_024) {
      setError('이메일 또는 비밀번호를 확인하세요.');
      return;
    }

    setBusy(true);
    setError('');
    const request = mode === 'login'
      ? props.client.login({ email: normalizedEmail, password })
      : props.client.register({
        email: normalizedEmail,
        password,
        ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
      });
    // The request body has already been constructed. Remove the password from
    // the controlled field while the request is in flight.
    setPassword('');
    try {
      props.onAuthenticated(await request);
    } catch (requestError) {
      if (requestError instanceof ProductAuthError && requestError.kind === 'unavailable') {
        setError('인증 서비스에 연결할 수 없습니다. 잠시 후 다시 시도하세요.');
      } else if (requestError instanceof ProductAuthError && requestError.kind === 'invalid-response') {
        setError('인증 응답을 안전하게 확인할 수 없습니다. 다시 시도하세요.');
      } else {
        setError(mode === 'login'
          ? '이메일 또는 비밀번호가 올바르지 않습니다.'
          : '계정을 만들 수 없습니다. 입력을 확인하거나 잠시 후 다시 시도하세요.');
      }
    } finally {
      setBusy(false);
    }
  }

  return <main className="auth-screen"><section className="auth-card" aria-labelledby="auth-title">
    <div className="auth-brand"><KodexMark /><span>Kodex</span></div>
    <div className="auth-heading"><div className="auth-status-icon"><LockKeyhole size={19} /></div><div>
      <h1 id="auth-title">{mode === 'login' ? 'Kodex에 로그인' : 'Kodex 계정 만들기'}</h1>
      <p>계정 확인 후 로컬 에이전트 작업공간을 시작합니다.</p>
    </div></div>
    <div className="auth-tabs" role="tablist" aria-label="인증 방법">
      <button type="button" role="tab" aria-selected={mode === 'login'} onClick={() => changeMode('login')}>로그인</button>
      <button type="button" role="tab" aria-selected={mode === 'register'} onClick={() => changeMode('register')}>회원가입</button>
    </div>
    <form className="auth-form" onSubmit={(event) => void submit(event)} noValidate>
      {mode === 'register' && <label>표시 이름 <span>선택</span><input name="displayName" type="text" autoComplete="name" maxLength={100} value={displayName} disabled={busy} onChange={(event) => setDisplayName(event.target.value)} /></label>}
      <label>이메일<input ref={emailRef} name="email" type="email" autoComplete="email" inputMode="email" required value={email} disabled={busy} onChange={(event) => setEmail(event.target.value)} /></label>
      <label>비밀번호<input name="password" type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required value={password} disabled={busy} onChange={(event) => setPassword(event.target.value)} aria-describedby={mode === 'register' ? 'password-help' : undefined} /></label>
      {mode === 'register' && <p className="auth-help" id="password-help">UTF-8 기준 12~1,024바이트. 한글과 이모지는 문자 수보다 더 많은 바이트를 사용할 수 있습니다.</p>}
      {error && <p className="auth-error" role="alert">{error}</p>}
      <button className="auth-submit" type="submit" disabled={busy}>{busy && <LoaderCircle className="spin" size={14} />}{busy ? '확인 중…' : mode === 'login' ? '로그인' : '계정 만들기'}</button>
    </form>
    <p className="auth-security-note">세션은 브라우저의 HttpOnly 쿠키로만 관리되며 비밀번호를 기기에 저장하지 않습니다.</p>
  </section></main>;
}
