import { describe, expect, it, vi } from 'vitest';
import {
  ProductAuthClient,
  ProductAuthConfigurationError,
  ProductAuthError,
  parseProductAuthResponse,
  reconcileProductRuntimeWorkspace,
  resolveProductApiBase,
  selectProductRuntimeWorkspace,
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
  it('uses fixed saved-history GET paths with one normalized workspace query/header', async () => {
    const workspaceId = '20000000-0000-4000-8000-000000000001';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        nextCursor: null,
        threads: [{
          threadId: 'thread:safe', title: 'Saved', status: 'active', projectName: 'Project',
          createdAt: '2026-08-31T00:00:00.000Z', updatedAt: '2026-08-31T01:00:00.000Z',
        }],
      }))
      .mockResolvedValueOnce(jsonResponse({
        thread: {
          threadId: 'thread:safe', title: 'Saved', status: 'active', projectName: 'Project',
          createdAt: '2026-08-31T00:00:00.000Z', updatedAt: '2026-08-31T01:00:00.000Z',
        },
        turns: [], items: [], toolCalls: [], approvals: [], nextCursor: null,
        omitted: { items: false, toolCalls: false, approvals: false },
      }));
    const client = new ProductAuthClient({
      apiBase: 'http://127.0.0.1:47832', development: true,
      fetch: fetchMock, pageUrl: 'http://127.0.0.1:5173/',
    });

    await expect(client.historyThreads(workspaceId, { limit: 20 })).resolves.toMatchObject({
      threads: [{ threadId: 'thread:safe' }],
    });
    await client.historyThread(workspaceId, 'thread:safe', { limit: 20 });

    for (const [rawUrl, init] of fetchMock.mock.calls) {
      const url = new URL(String(rawUrl));
      expect(url.searchParams.getAll('workspace_id')).toEqual([workspaceId]);
      expect(url.searchParams.getAll('limit')).toEqual(['20']);
      expect(new Headers(init.headers).get('X-Kodex-Workspace-Id')).toBe(workspaceId);
      expect(init).toMatchObject({ method: 'GET', credentials: 'include', cache: 'no-store' });
    }
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('/api/history/threads/thread%3Asafe?');
    await expect(client.historyThread(workspaceId, '../knowledge/query')).rejects.toMatchObject({ kind: 'rejected' });
    await expect(client.historyThreads(workspaceId, { limit: 51 })).rejects.toMatchObject({ kind: 'rejected' });
  });

  it('strictly rejects extra saved-history fields and invalidates only on 401', async () => {
    const workspaceId = '20000000-0000-4000-8000-000000000001';
    const malformed = new ProductAuthClient({
      apiBase: 'http://127.0.0.1:47832', development: true,
      fetch: vi.fn().mockResolvedValue(jsonResponse({ nextCursor: null, threads: [], internalId: 'leak' })),
      pageUrl: 'http://127.0.0.1:5173/',
    });
    await expect(malformed.historyThreads(workspaceId)).rejects.toMatchObject({ kind: 'invalid-response' });

    for (const [status, code, kind, invalidates] of [
      [401, 'unauthenticated', 'unauthenticated', true],
      [503, 'internal_error', 'unavailable', false],
    ] as const) {
      const client = new ProductAuthClient({
        apiBase: 'http://127.0.0.1:47832', development: true,
        fetch: vi.fn().mockResolvedValue(jsonResponse(errorBody(code), status)),
        pageUrl: 'http://127.0.0.1:5173/',
      });
      const listener = vi.fn();
      client.onUnauthenticated(listener);
      await expect(client.historyThreads(workspaceId)).rejects.toMatchObject({ kind, status });
      expect(listener).toHaveBeenCalledTimes(invalidates ? 1 : 0);
    }

    const offlineClient = new ProductAuthClient({
      apiBase: 'http://127.0.0.1:47832', development: true,
      fetch: vi.fn().mockRejectedValue(new Error('offline')),
      pageUrl: 'http://127.0.0.1:5173/',
    });
    const offlineListener = vi.fn();
    offlineClient.onUnauthenticated(offlineListener);
    await expect(offlineClient.historyThreads(workspaceId)).rejects.toMatchObject({ kind: 'unavailable' });
    expect(offlineListener).not.toHaveBeenCalled();
  });

  it('binds the browser global fetch receiver before storing it on the client', async () => {
    const originalFetch = globalThis.fetch;
    const receiver = vi.fn();
    globalThis.fetch = async function (this: unknown) {
      receiver(this);
      return jsonResponse(authBody());
    };
    try {
      const client = new ProductAuthClient({
        apiBase: 'http://127.0.0.1:47832',
        development: true,
        pageUrl: 'http://127.0.0.1:5173/',
      });
      await client.me();
      expect(receiver).toHaveBeenCalledWith(globalThis);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

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

  it('selects only execution-capable memberships and does not start from viewer-only access', () => {
    const viewer = { id: 'workspace-viewer', name: 'Read only', slug: 'read-only', role: 'viewer' as const };
    const member = { id: 'workspace-member', name: 'Runnable', slug: 'runnable', role: 'member' as const };
    const base = parseProductAuthResponse(authBody(), false).context;
    expect(selectProductRuntimeWorkspace({ ...base, defaultWorkspace: viewer, workspaces: [viewer, member] }))
      .toEqual(member);
    expect(selectProductRuntimeWorkspace({ ...base, defaultWorkspace: viewer, workspaces: [viewer] }))
      .toBeUndefined();
  });

  it('reconciles an in-memory runtime workspace across defaults, revalidation, users, and role changes', () => {
    const owner = { id: 'workspace-owner', name: 'Owner', slug: 'owner', role: 'owner' as const };
    const admin = { id: 'workspace-admin', name: 'Admin', slug: 'admin', role: 'admin' as const };
    const member = { id: 'workspace-member', name: 'Member', slug: 'member', role: 'member' as const };
    const viewer = { id: 'workspace-viewer', name: 'Viewer', slug: 'viewer', role: 'viewer' as const };
    const base = parseProductAuthResponse(authBody(), false).context;
    const multiple = { ...base, defaultWorkspace: admin, workspaces: [owner, admin, member, viewer] };

    expect(reconcileProductRuntimeWorkspace(multiple, null)).toEqual({
      userId: base.user.id,
      workspaceId: admin.id,
    });
    const selectedMember = { userId: base.user.id, workspaceId: member.id };
    expect(reconcileProductRuntimeWorkspace({ ...multiple, session: { ...multiple.session } }, selectedMember))
      .toBe(selectedMember);

    const memberRemoved = { ...multiple, workspaces: [owner, admin, viewer] };
    expect(reconcileProductRuntimeWorkspace(memberRemoved, selectedMember)).toEqual({
      userId: base.user.id,
      workspaceId: admin.id,
    });
    const memberDowngraded = {
      ...multiple,
      defaultWorkspace: owner,
      workspaces: [owner, { ...member, role: 'viewer' as const }, viewer],
    };
    expect(reconcileProductRuntimeWorkspace(memberDowngraded, selectedMember)).toEqual({
      userId: base.user.id,
      workspaceId: owner.id,
    });
    expect(reconcileProductRuntimeWorkspace({
      ...multiple,
      defaultWorkspace: viewer,
      workspaces: [viewer],
    }, selectedMember)).toBeNull();

    const otherUser = { ...multiple, user: { ...base.user, id: 'user-2' }, defaultWorkspace: owner };
    expect(reconcileProductRuntimeWorkspace(otherUser, selectedMember)).toEqual({
      userId: 'user-2',
      workspaceId: owner.id,
    });
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

  it('uses CSRF-protected workspace APIs and strictly parses allowlisted responses', async () => {
    const workspaceId = '20000000-0000-4000-8000-000000000001';
    const userId = '10000000-0000-4000-8000-000000000001';
    const workspace = { id: workspaceId, name: 'Platform', slug: 'workspace-safe', role: 'owner' };
    const member = {
      userId, email: 'member@example.com', displayName: 'Member', role: 'member',
      joinedAt: '2026-08-31T00:00:00.000Z',
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(authBody()))
      .mockResolvedValueOnce(jsonResponse(workspace, 201))
      .mockResolvedValueOnce(jsonResponse({ members: [member] }))
      .mockResolvedValueOnce(jsonResponse(member, 201))
      .mockResolvedValueOnce(jsonResponse({ ...member, role: 'viewer' }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new ProductAuthClient({
      apiBase: 'http://127.0.0.1:47832', development: true,
      fetch: fetchMock, pageUrl: 'http://127.0.0.1:5173/',
    });
    await client.me();
    await expect(client.createWorkspace('Platform')).resolves.toEqual(workspace);
    await expect(client.workspaceMembers(workspaceId)).resolves.toEqual([member]);
    await expect(client.addWorkspaceMember(workspaceId, member.email, 'member')).resolves.toEqual(member);
    await expect(client.updateWorkspaceMember(workspaceId, userId, 'viewer')).resolves.toMatchObject({ role: 'viewer' });
    await client.removeWorkspaceMember(workspaceId, userId);

    expect(fetchMock.mock.calls.slice(1).map(([url]) => String(url))).toEqual([
      'http://127.0.0.1:47832/api/workspaces',
      `http://127.0.0.1:47832/api/workspaces/${workspaceId}/members`,
      `http://127.0.0.1:47832/api/workspaces/${workspaceId}/members`,
      `http://127.0.0.1:47832/api/workspaces/${workspaceId}/members/${userId}`,
      `http://127.0.0.1:47832/api/workspaces/${workspaceId}/members/${userId}`,
    ]);
    for (const [, init] of [fetchMock.mock.calls[1], fetchMock.mock.calls[3], fetchMock.mock.calls[4], fetchMock.mock.calls[5]]) {
      expect(new Headers(init.headers).get('X-CSRF-Token')).toBe(csrfToken);
    }

    const malformed = new ProductAuthClient({
      apiBase: 'http://127.0.0.1:47832', development: true,
      fetch: vi.fn().mockResolvedValue(jsonResponse({ members: [{ ...member, passwordHash: 'leak' }] })),
      pageUrl: 'http://127.0.0.1:5173/',
    });
    await expect(malformed.workspaceMembers(workspaceId)).rejects.toMatchObject({ kind: 'invalid-response' });
    const malformedEmail = new ProductAuthClient({
      apiBase: 'http://127.0.0.1:47832', development: true,
      fetch: vi.fn().mockResolvedValue(jsonResponse({ members: [{ ...member, email: 'not-an-email' }] })),
      pageUrl: 'http://127.0.0.1:5173/',
    });
    await expect(malformedEmail.workspaceMembers(workspaceId)).rejects.toMatchObject({ kind: 'invalid-response' });
    await expect(client.workspaceMembers('not-a-uuid')).rejects.toMatchObject({ kind: 'rejected' });
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

  it('signals session invalidation for Knowledge 401 but not Knowledge 503', async () => {
    const workspaceId = '20000000-0000-4000-8000-000000000001';
    const unauthorizedFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(authBody()))
      .mockResolvedValueOnce(jsonResponse(errorBody('unauthenticated'), 401));
    const unauthorizedClient = new ProductAuthClient({
      apiBase: 'http://127.0.0.1:47832', development: true,
      fetch: unauthorizedFetch, pageUrl: 'http://127.0.0.1:5173/',
    });
    const invalidated = vi.fn();
    unauthorizedClient.onUnauthenticated(invalidated);
    await unauthorizedClient.me();
    await expect(unauthorizedClient.knowledge('/api/knowledge/query', workspaceId, {
      method: 'POST', body: JSON.stringify({ query: 'expired' }),
    })).rejects.toMatchObject({ kind: 'unauthenticated', status: 401 });
    expect(invalidated).toHaveBeenCalledOnce();

    const unavailableFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(authBody()))
      .mockResolvedValueOnce(jsonResponse(errorBody('knowledge_unavailable'), 503));
    const unavailableClient = new ProductAuthClient({
      apiBase: 'http://127.0.0.1:47832', development: true,
      fetch: unavailableFetch, pageUrl: 'http://127.0.0.1:5173/',
    });
    const notInvalidated = vi.fn();
    unavailableClient.onUnauthenticated(notInvalidated);
    await unavailableClient.me();
    await expect(unavailableClient.knowledge('/api/knowledge/query', workspaceId, {
      method: 'POST', body: JSON.stringify({ query: 'temporarily unavailable' }),
    })).rejects.toMatchObject({ kind: 'unavailable', status: 503 });
    expect(notInvalidated).not.toHaveBeenCalled();
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
    expect(() => resolveProductApiBase(
      undefined,
      'http://127.0.0.1:47831/',
      false,
    )).toThrow('runtime configuration is missing');
    expect(() => resolveProductApiBase(
      'http://localhost:49000',
      'http://127.0.0.1:47831/',
      false,
    )).toThrow('same loopback hostname');
    expect(() => resolveProductApiBase(
      'https://auth.example.test',
      'http://127.0.0.1:47831/',
      false,
    )).toThrow('UI protocol and hostname');
    expect(() => resolveProductApiBase(
      'https://127.0.0.1:49000',
      'http://127.0.0.1:47831/',
      false,
    )).toThrow('UI protocol and hostname');
    expect(resolveProductApiBase(
      'http://127.0.0.1:49000',
      'http://127.0.0.1:47831/',
      false,
    )).toBe('http://127.0.0.1:49000');
    expect(() => resolveProductApiBase(
      'https://api.example.test',
      'https://app.example.test/',
      false,
    )).toThrow('must use the UI origin');
    expect(resolveProductApiBase(
      'https://app.example.test',
      'https://app.example.test/',
      false,
    )).toBe('https://app.example.test');
  });
});
