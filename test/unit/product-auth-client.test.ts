import { describe, expect, it, vi } from 'vitest';
import {
  ProductAuthClient,
  ProductAuthConfigurationError,
  ProductAuthError,
  parseProductAuthResponse,
  resolveProductApiBase,
} from '../../apps/ui/src/auth/product-auth';

const csrfToken = 'A'.repeat(43);

function authBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    user: {
      id: 'user-1',
      email: 'person@example.com',
      displayName: 'Person',
      createdAt: '2026-08-31T00:00:00.000Z',
    },
    workspaces: [{ id: 'workspace-1', name: 'Personal', slug: 'personal-1', role: 'owner' }],
    session: { expiresAt: '2026-08-31T12:00:00.000Z' },
    csrfToken,
    ...extra,
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function errorBody(code: string, message = 'Request failed.'): object {
  return { ok: false, error: { code, message } };
}

describe('product auth browser contract', () => {
  it('strictly validates success JSON and rejects unknown or inconsistent fields', () => {
    expect(parseProductAuthResponse(authBody(), false).context.user.email)
      .toBe('person@example.com');
    expect(() => parseProductAuthResponse(authBody({ unexpected: true }), false))
      .toThrow(ProductAuthError);
    expect(() => parseProductAuthResponse(authBody({
      defaultWorkspace: { id: 'other', name: 'Other', slug: 'other', role: 'owner' },
    }), true)).toThrow('default workspace');
    expect(() => parseProductAuthResponse(authBody({ csrfToken: 'short' }), false))
      .toThrow('invalid response');
  });

  it('uses credentialed no-store requests and returns CSRF proof on logout', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(authBody()))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new ProductAuthClient({
      apiBase: 'http://127.0.0.1:47832',
      development: true,
      fetch: fetchMock,
      pageUrl: 'http://127.0.0.1:5173/',
    });

    await expect(client.me()).resolves.toMatchObject({ user: { id: 'user-1' } });
    await client.logout();

    expect(fetchMock).toHaveBeenNthCalledWith(1, 'http://127.0.0.1:47832/api/auth/me', expect.objectContaining({
      credentials: 'include',
      cache: 'no-store',
      method: 'GET',
    }));
    const logoutInit = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(logoutInit).toMatchObject({ credentials: 'include', cache: 'no-store', body: '{}' });
    expect(logoutInit.headers).toMatchObject({
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken,
    });
    await expect(client.logout()).rejects.toMatchObject({ kind: 'invalid-response' });
  });

  it('posts login and registration only to the product auth boundary', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(authBody()))
      .mockResolvedValueOnce(jsonResponse(authBody({
        defaultWorkspace: { id: 'workspace-1', name: 'Personal', slug: 'personal-1', role: 'owner' },
      }), 201));
    const client = new ProductAuthClient({
      apiBase: 'http://127.0.0.1:47832',
      development: true,
      fetch: fetchMock,
      pageUrl: 'http://127.0.0.1:5173/',
    });

    await client.login({ email: 'person@example.com', password: 'login password' });
    await client.register({
      email: 'new@example.com',
      password: 'registration password',
      displayName: 'New Person',
    });

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'http://127.0.0.1:47832/api/auth/login',
      'http://127.0.0.1:47832/api/auth/register',
    ]);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init).toMatchObject({ method: 'POST', credentials: 'include', cache: 'no-store' });
    }
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      email: 'new@example.com',
      password: 'registration password',
      displayName: 'New Person',
    });
  });

  it('separates 401, 5xx, network, and malformed-response failures', async () => {
    const cases: Array<[Response | Error, ProductAuthError['kind']]> = [
      [jsonResponse(errorBody('unauthenticated'), 401), 'unauthenticated'],
      [jsonResponse(errorBody('internal_error'), 503), 'unavailable'],
      [new Error('offline'), 'unavailable'],
      [new Response('<html>bad gateway</html>', { status: 502, headers: { 'Content-Type': 'text/html' } }), 'invalid-response'],
    ];
    for (const [result, kind] of cases) {
      const fetchMock = result instanceof Error
        ? vi.fn().mockRejectedValue(result)
        : vi.fn().mockResolvedValue(result);
      const client = new ProductAuthClient({
        apiBase: 'http://127.0.0.1:47832',
        development: true,
        fetch: fetchMock,
        pageUrl: 'http://127.0.0.1:5173/',
      });
      await expect(client.me()).rejects.toMatchObject({ kind });
    }
  });

  it('does not quietly mix localhost and 127.0.0.1 cookie hosts in development', () => {
    expect(() => resolveProductApiBase(
      'http://localhost:47832',
      'http://127.0.0.1:5173/',
      true,
    )).toThrow(ProductAuthConfigurationError);
    expect(resolveProductApiBase(
      'http://127.0.0.1:47832',
      'http://127.0.0.1:5173/',
      true,
    )).toBe('http://127.0.0.1:47832');
  });
});
