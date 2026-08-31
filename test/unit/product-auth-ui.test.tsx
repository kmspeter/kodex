// @vitest-environment jsdom

import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AuthForm,
  FOREGROUND_REVALIDATION_THROTTLE_MS,
  MAX_SESSION_REVALIDATION_MS,
  MIN_SESSION_REVALIDATION_MS,
  ProductAuthGate,
  sessionRevalidationDelay,
  validateRegistrationPassword,
} from '../../apps/ui/src/auth/AuthGate';
import {
  ProductAuthClient,
  ProductAuthError,
  type ProductAuthContext,
} from '../../apps/ui/src/auth/product-auth';

const context: ProductAuthContext = {
  user: {
    id: 'user-1',
    email: 'person@example.com',
    displayName: 'Person',
    createdAt: '2026-08-31T00:00:00.000Z',
  },
  workspaces: [{ id: 'workspace-1', name: 'Personal', slug: 'personal-1', role: 'owner' }],
  session: { expiresAt: '2026-08-31T12:00:00.000Z' },
};
const responseContext = { ...context, csrfToken: 'A'.repeat(43) };

function sessionResponse(options: {
  csrfToken?: string;
  displayName?: string;
  expiresAt: string;
}): object {
  return {
    ...responseContext,
    user: {
      ...responseContext.user,
      displayName: options.displayName ?? responseContext.user.displayName,
    },
    session: { expiresAt: options.expiresAt },
    csrfToken: options.csrfToken ?? responseContext.csrfToken,
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function setInput(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('product authentication UI', () => {
  it('provides accessible login/register fields and UTF-8 registration validation', async () => {
    const client = { login: vi.fn(), register: vi.fn() };
    await act(async () => root.render(<AuthForm client={client} onAuthenticated={() => undefined} />));

    const email = container.querySelector<HTMLInputElement>('input[name="email"]')!;
    const password = container.querySelector<HTMLInputElement>('input[name="password"]')!;
    expect(email.autocomplete).toBe('email');
    expect(password.autocomplete).toBe('current-password');
    expect(email.closest('label')?.textContent).toContain('이메일');

    const registerTab = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
      .find((button) => button.textContent === '회원가입')!;
    await act(async () => registerTab.click());
    expect(container.querySelector<HTMLInputElement>('input[name="password"]')?.autocomplete)
      .toBe('new-password');
    expect(container.querySelector('#password-help')?.textContent).toContain('12~1,024바이트');
    expect(validateRegistrationPassword('short')).toContain('12바이트');
    expect(validateRegistrationPassword('비밀비밀')).toBeNull();
    expect(validateRegistrationPassword('가'.repeat(342))).toContain('1,024바이트');
  });

  it('clears the password as soon as submit starts and supports native form submit', async () => {
    let resolveLogin!: (value: ProductAuthContext) => void;
    const login = vi.fn(() => new Promise<ProductAuthContext>((resolve) => { resolveLogin = resolve; }));
    const authenticated = vi.fn();
    await act(async () => root.render(<AuthForm
      client={{ login, register: vi.fn() }}
      onAuthenticated={authenticated}
    />));
    const email = container.querySelector<HTMLInputElement>('input[name="email"]')!;
    const password = container.querySelector<HTMLInputElement>('input[name="password"]')!;
    await act(async () => {
      setInput(email, 'person@example.com');
      setInput(password, 'not persisted');
    });
    await act(async () => {
      container.querySelector('form')?.dispatchEvent(new Event('submit', {
        bubbles: true,
        cancelable: true,
      }));
      await flush();
    });

    expect(login).toHaveBeenCalledWith({ email: 'person@example.com', password: 'not persisted' });
    expect(password.value).toBe('');
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);

    await act(async () => {
      resolveLogin(context);
      await flush();
    });
    expect(authenticated).toHaveBeenCalledWith(context);
  });

  it('submits registration with a generic failure message that does not expose account existence', async () => {
    const register = vi.fn().mockRejectedValue(new ProductAuthError(
      'rejected',
      'Account could not be created.',
      400,
      'registration_failed',
    ));
    await act(async () => root.render(<AuthForm
      client={{ login: vi.fn(), register }}
      onAuthenticated={() => undefined}
    />));
    const registerTab = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
      .find((button) => button.textContent === '회원가입')!;
    await act(async () => registerTab.click());
    const email = container.querySelector<HTMLInputElement>('input[name="email"]')!;
    const displayName = container.querySelector<HTMLInputElement>('input[name="displayName"]')!;
    const password = container.querySelector<HTMLInputElement>('input[name="password"]')!;
    await act(async () => {
      setInput(email, 'new@example.com');
      setInput(displayName, 'New Person');
      setInput(password, '비밀비밀');
    });
    await act(async () => {
      container.querySelector('form')?.dispatchEvent(new Event('submit', {
        bubbles: true,
        cancelable: true,
      }));
      await flush();
    });

    expect(register).toHaveBeenCalledWith({
      email: 'new@example.com',
      displayName: 'New Person',
      password: '비밀비밀',
    });
    expect(password.value).toBe('');
    expect(container.querySelector('[role="alert"]')?.textContent)
      .toBe('계정을 만들 수 없습니다. 입력을 확인하거나 잠시 후 다시 시도하세요.');
    expect(container.textContent).not.toContain('Account could not be created');
  });

  it('keeps 401 on the login path and gives 5xx a distinct retry screen', async () => {
    const unauthorizedClient = new ProductAuthClient({
      apiBase: 'http://localhost:47832',
      development: true,
      pageUrl: 'http://localhost:5173/',
      fetch: vi.fn().mockResolvedValue(jsonResponse({
        ok: false,
        error: { code: 'unauthenticated', message: 'Authentication is required.' },
      }, 401)),
    });
    await act(async () => {
      root.render(<ProductAuthGate client={unauthorizedClient}>{() => <div>runtime</div>}</ProductAuthGate>);
      await flush();
    });
    expect(container.textContent).toContain('Kodex에 로그인');
    expect(container.textContent).not.toContain('인증 서비스를 확인할 수 없습니다');

    await act(async () => root.unmount());
    container.remove();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    const unavailableClient = new ProductAuthClient({
      apiBase: 'http://localhost:47832',
      development: true,
      pageUrl: 'http://localhost:5173/',
      fetch: vi.fn().mockResolvedValue(jsonResponse({
        ok: false,
        error: { code: 'internal_error', message: 'Failed.' },
      }, 503)),
    });
    await act(async () => {
      root.render(<ProductAuthGate client={unavailableClient}>{() => <div>runtime</div>}</ProductAuthGate>);
      await flush();
    });
    expect(container.textContent).toContain('인증 서비스를 확인할 수 없습니다');
    expect(container.textContent).toContain('다시 시도');
  });

  it('bounds session revalidation by expiry without a zero-delay loop', () => {
    const now = Date.parse('2026-08-31T00:00:00.000Z');
    expect(sessionRevalidationDelay('2026-08-31T12:00:00.000Z', now))
      .toBe(MAX_SESSION_REVALIDATION_MS);
    expect(sessionRevalidationDelay('2026-08-30T23:59:00.000Z', now))
      .toBe(MIN_SESSION_REVALIDATION_MS);
  });

  it('refreshes context and CSRF at the bounded interval without unmounting runtime', async () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-08-31T00:00:00.000Z');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(sessionResponse({
        expiresAt: '2026-08-31T12:00:00.000Z',
      })))
      .mockResolvedValueOnce(jsonResponse(sessionResponse({
        csrfToken: 'B'.repeat(43),
        displayName: 'Refreshed Person',
        expiresAt: '2026-08-31T13:00:00.000Z',
      })))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new ProductAuthClient({
      apiBase: 'http://localhost:47832',
      development: true,
      pageUrl: 'http://localhost:5173/',
      fetch: fetchMock,
    });
    const cleanup = vi.fn();

    function RuntimeProbe(props: {
      account: ProductAuthContext;
      logout: () => Promise<void>;
    }) {
      useEffect(() => cleanup, []);
      return <div><span>{props.account.user.displayName}</span><button type="button" onClick={() => void props.logout()}>logout refreshed</button></div>;
    }

    await act(async () => {
      root.render(<ProductAuthGate client={client}>{(account, logout) => <RuntimeProbe account={account} logout={logout} />}</ProductAuthGate>);
      await flush();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(MAX_SESSION_REVALIDATION_MS - 1);
      await flush();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
      await flush();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('Refreshed Person');
    expect(cleanup).not.toHaveBeenCalled();

    await act(async () => {
      Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent === 'logout refreshed')?.click();
      await flush();
    });
    const logoutHeaders = fetchMock.mock.calls[2]?.[1]?.headers as Record<string, string>;
    expect(logoutHeaders['X-CSRF-Token']).toBe('B'.repeat(43));
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('deduplicates focus/visibility checks and cleans timer, listeners, and pending fetch on unmount', async () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-08-31T00:00:00.000Z');
    const pendingSignals: AbortSignal[] = [];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(sessionResponse({
        expiresAt: '2026-08-31T12:00:00.000Z',
      })))
      .mockImplementationOnce((_url: string, init: RequestInit) => {
        pendingSignals.push(init.signal as AbortSignal);
        return new Promise<Response>(() => undefined);
      });
    const client = new ProductAuthClient({
      apiBase: 'http://localhost:47832',
      development: true,
      pageUrl: 'http://localhost:5173/',
      fetch: fetchMock,
    });
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');

    await act(async () => {
      root.render(<ProductAuthGate client={client}>{() => <div>runtime active</div>}</ProductAuthGate>);
      await flush();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FOREGROUND_REVALIDATION_THROTTLE_MS);
    });
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
      await flush();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(pendingSignals[0]?.aborted).toBe(false);

    await act(async () => root.unmount());
    expect(pendingSignals[0]?.aborted).toBe(true);
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(MAX_SESSION_REVALIDATION_MS * 2);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    container.remove();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  it('unmounts runtime on background 401 and separates background 5xx as unavailable', async () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-08-31T00:00:00.000Z');
    const cleanup = vi.fn();
    const unauthorizedFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(sessionResponse({
        expiresAt: '2026-08-31T12:00:00.000Z',
      })))
      .mockResolvedValueOnce(jsonResponse({
        ok: false,
        error: { code: 'unauthenticated', message: 'Authentication is required.' },
      }, 401));
    const unauthorizedClient = new ProductAuthClient({
      apiBase: 'http://localhost:47832',
      development: true,
      pageUrl: 'http://localhost:5173/',
      fetch: unauthorizedFetch,
    });

    function RuntimeProbe() {
      useEffect(() => cleanup, []);
      return <div>runtime guarded</div>;
    }

    await act(async () => {
      root.render(<ProductAuthGate client={unauthorizedClient}>{() => <RuntimeProbe />}</ProductAuthGate>);
      await flush();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MAX_SESSION_REVALIDATION_MS);
      await flush();
    });
    expect(container.textContent).toContain('Kodex에 로그인');
    expect(cleanup).toHaveBeenCalledTimes(1);

    await act(async () => root.unmount());
    container.remove();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    const unavailableFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(sessionResponse({
        expiresAt: '2026-08-31T12:00:00.000Z',
      })))
      .mockResolvedValueOnce(jsonResponse({
        ok: false,
        error: { code: 'internal_error', message: 'Failed.' },
      }, 503));
    const unavailableClient = new ProductAuthClient({
      apiBase: 'http://localhost:47832',
      development: true,
      pageUrl: 'http://localhost:5173/',
      fetch: unavailableFetch,
    });
    await act(async () => {
      root.render(<ProductAuthGate client={unavailableClient}>{() => <div>runtime unavailable</div>}</ProductAuthGate>);
      await flush();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MAX_SESSION_REVALIDATION_MS);
      await flush();
    });
    expect(container.textContent).toContain('인증 서비스를 확인할 수 없습니다');
    expect(container.textContent).not.toContain('Kodex에 로그인');
  });

  it('treats an already-expired logout 401 as a completed logout', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(responseContext))
      .mockResolvedValueOnce(jsonResponse({
        ok: false,
        error: { code: 'unauthenticated', message: 'Authentication is required.' },
      }, 401));
    const client = new ProductAuthClient({
      apiBase: 'http://localhost:47832',
      development: true,
      pageUrl: 'http://localhost:5173/',
      fetch: fetchMock,
    });
    await act(async () => {
      root.render(<ProductAuthGate client={client}>{(_account, logout) => <button type="button" onClick={() => void logout()}>logout expired</button>}</ProductAuthGate>);
      await flush();
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button')?.click();
      await flush();
    });
    expect(container.textContent).toContain('Kodex에 로그인');
    expect(container.textContent).not.toContain('인증 서비스를 확인할 수 없습니다');
  });

  it('mounts runtime only after session success and unmounts it before logout finishes', async () => {
    let resolveLogout!: (value: Response) => void;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(responseContext))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveLogout = resolve; }));
    const client = new ProductAuthClient({
      apiBase: 'http://localhost:47832',
      development: true,
      pageUrl: 'http://localhost:5173/',
      fetch: fetchMock,
    });
    const cleanup = vi.fn();

    function RuntimeProbe(props: { logout: () => Promise<void> }) {
      useEffect(() => cleanup, []);
      return <button type="button" onClick={() => void props.logout()}>logout runtime</button>;
    }

    await act(async () => {
      root.render(<ProductAuthGate client={client}>{(_account, logout) => <RuntimeProbe logout={logout} />}</ProductAuthGate>);
      expect(container.textContent).not.toContain('logout runtime');
      await flush();
    });
    expect(container.textContent).toContain('logout runtime');

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button')?.click();
      await flush();
    });
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('세션을 종료하는 중');
    const logoutHeaders = fetchMock.mock.calls[1]?.[1]?.headers as Record<string, string>;
    expect(logoutHeaders['X-CSRF-Token']).toBe('A'.repeat(43));

    await act(async () => {
      resolveLogout(new Response(null, { status: 204 }));
      await flush();
    });
    expect(container.textContent).toContain('Kodex에 로그인');
  });
});
