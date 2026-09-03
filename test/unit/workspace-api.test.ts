import type { AuthContext, ProductDatabase, WorkspaceApplication } from '@kodex/product-db';
import { PostgresWorkspaceRepository, WorkspaceCursorError, WorkspaceOperationError } from '@kodex/product-db';
import { describe, expect, it, vi } from 'vitest';
import type { ProductApiConfig } from '../../apps/api/src/config.js';
import { createCsrfToken, csrfCookieName, sessionCookieName } from '../../apps/api/src/cookies.js';
import { ProductApiServer } from '../../apps/api/src/server.js';

const origin = 'http://127.0.0.1:5173';
const token = 'workspace-session';
const secret = Buffer.alloc(32, 41);
const csrf = createCsrfToken(token, secret);
const cookie = `${sessionCookieName}=${token}; ${csrfCookieName}=${csrf}`;
const userId = '10000000-0000-4000-8000-000000000001';
const workspaceId = '20000000-0000-4000-8000-000000000001';
const memberId = '30000000-0000-4000-8000-000000000001';

function context(): AuthContext {
  return {
    sessionId: '40000000-0000-4000-8000-000000000001',
    expiresAt: new Date(Date.now() + 60_000),
    user: { id: userId, email: 'owner@example.invalid', displayName: 'Owner', createdAt: new Date() },
    memberships: [{ id: workspaceId, name: 'Platform', role: 'owner', slug: 'platform' }],
  };
}

function application(): WorkspaceApplication {
  const joinedAt = new Date('2026-09-03T00:00:00.000Z');
  const member = {
    userId: memberId,
    email: 'member@example.invalid',
    displayName: 'Member',
    role: 'member' as const,
    joinedAt,
  };
  return {
    acceptInvitation: vi.fn(async () => ({ id: workspaceId, name: 'Platform', role: 'member' as const, slug: 'workspace-platform' })),
    createInvitation: vi.fn(),
    listInvitations: vi.fn(async () => ({ invitations: [] })),
    previewInvitation: vi.fn(),
    revokeInvitation: vi.fn(),
    createWorkspace: vi.fn(async () => ({
      id: workspaceId, name: 'Platform', role: 'owner' as const, slug: 'workspace-platform',
    })),
    listMembers: vi.fn(async () => ({ members: [member] })),
    addMember: vi.fn(async () => member),
    updateMemberRole: vi.fn(async (_actor, _workspace, _target, role) => ({ ...member, role })),
    removeMember: vi.fn(async () => undefined),
  };
}

function mutationHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Cookie: cookie,
    Origin: origin,
    'X-CSRF-Token': csrf,
  };
}

describe('workspace Product API boundary', () => {
  it('rejects structurally valid-looking opaque cursor garbage before opening a database transaction', async () => {
    const transaction = vi.fn();
    const repository = new PostgresWorkspaceRepository(
      { transaction } as unknown as ProductDatabase,
      { cursorSecret: secret },
    );
    await expect(repository.listMembers(userId, workspaceId, { cursor: 'A'.repeat(80), limit: 50 }))
      .rejects.toBeInstanceOf(WorkspaceCursorError);
    expect(transaction).not.toHaveBeenCalled();
  });

  it('enforces CSRF and strict DTOs while routing only allowlisted workspace data', async () => {
    const workspaces = application();
    const config: ProductApiConfig = {
      host: '127.0.0.1', port: 0, allowedHosts: new Set(), allowedOrigins: new Set([origin]),
      cookieSecret: secret, secureCookies: false, sessionTtlMs: 60_000, maxBodyBytes: 4_096,
      loginRateLimitMaxAttempts: 5, loginRateLimitWindowMs: 900_000, loginRateLimitBlockMs: 900_000,
    };
    const server = new ProductApiServer({
      authenticate: vi.fn(async () => context()),
      login: vi.fn(), logout: vi.fn(), register: vi.fn(),
    }, config, undefined, undefined, undefined, workspaces);
    const port = await server.listen();
    const base = `http://127.0.0.1:${port}`;
    try {
      const noOrigin = await fetch(`${base}/api/workspaces`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': csrf },
        body: JSON.stringify({ name: 'Platform' }),
      });
      expect(noOrigin.status).toBe(403);
      expect(workspaces.createWorkspace).not.toHaveBeenCalled();

      const created = await fetch(`${base}/api/workspaces`, {
        method: 'POST', headers: mutationHeaders(), body: JSON.stringify({ name: 'Platform' }),
      });
      expect(created.status).toBe(201);
      expect(await created.json()).toEqual({
        id: workspaceId, name: 'Platform', role: 'owner', slug: 'workspace-platform',
      });
      expect(workspaces.createWorkspace).toHaveBeenCalledWith(userId, 'Platform');

      const listed = await fetch(`${base}/api/workspaces/${workspaceId}/members`, {
        headers: { Cookie: cookie },
      });
      expect(listed.status).toBe(200);
      expect(await listed.json()).toEqual({ members: [{
        userId: memberId,
        email: 'member@example.invalid',
        displayName: 'Member',
        role: 'member',
        joinedAt: '2026-09-03T00:00:00.000Z',
      }] });
      expect(workspaces.listMembers).toHaveBeenCalledWith(userId, workspaceId, { limit: 50 });

      const extraField = await fetch(`${base}/api/workspaces/${workspaceId}/members/${memberId}`, {
        method: 'PATCH', headers: mutationHeaders(), body: JSON.stringify({ role: 'viewer', ownerId: userId }),
      });
      expect(extraField.status).toBe(422);
      expect(workspaces.updateMemberRole).not.toHaveBeenCalled();

      const removed = await fetch(`${base}/api/workspaces/${workspaceId}/members/${memberId}`, {
        method: 'DELETE', headers: { Cookie: cookie, Origin: origin, 'X-CSRF-Token': csrf },
      });
      expect(removed.status).toBe(204);
      expect(workspaces.removeMember).toHaveBeenCalledWith(userId, workspaceId, memberId);
    } finally {
      await server.close();
    }
  });

  it('maps workspace authorization errors without exposing target existence', async () => {
    const workspaces = application();
    vi.mocked(workspaces.listMembers).mockRejectedValue(new WorkspaceOperationError('forbidden'));
    const config: ProductApiConfig = {
      host: '127.0.0.1', port: 0, allowedHosts: new Set(), allowedOrigins: new Set([origin]),
      cookieSecret: secret, secureCookies: false, sessionTtlMs: 60_000, maxBodyBytes: 4_096,
      loginRateLimitMaxAttempts: 5, loginRateLimitWindowMs: 900_000, loginRateLimitBlockMs: 900_000,
    };
    const server = new ProductApiServer({
      authenticate: vi.fn(async () => context()),
      login: vi.fn(), logout: vi.fn(), register: vi.fn(),
    }, config, undefined, undefined, undefined, workspaces);
    const port = await server.listen();
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/workspaces/${workspaceId}/members`, {
        headers: { Cookie: cookie },
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        ok: false,
        error: { code: 'workspace_forbidden', message: 'Workspace access is not permitted.' },
      });
    } finally {
      await server.close();
    }
  });

  it('bounds workspace page inputs before repository work and emits only optional opaque cursors', async () => {
    const workspaces = application();
    const nextCursor = 'opaque_next_page';
    vi.mocked(workspaces.listMembers).mockResolvedValue({ members: [], nextCursor });
    const config: ProductApiConfig = {
      host: '127.0.0.1', port: 0, allowedHosts: new Set(), allowedOrigins: new Set([origin]),
      cookieSecret: secret, secureCookies: false, sessionTtlMs: 60_000, maxBodyBytes: 4_096,
      loginRateLimitMaxAttempts: 5, loginRateLimitWindowMs: 900_000, loginRateLimitBlockMs: 900_000,
    };
    const server = new ProductApiServer({
      authenticate: vi.fn(async () => context()), login: vi.fn(), logout: vi.fn(), register: vi.fn(),
    }, config, undefined, undefined, undefined, workspaces);
    const port = await server.listen();
    const base = `http://127.0.0.1:${port}`;
    try {
      const page = await fetch(`${base}/api/workspaces/${workspaceId}/members?limit=1`, { headers: { Cookie: cookie } });
      expect(await page.json()).toEqual({ members: [], nextCursor });
      expect(workspaces.listMembers).toHaveBeenCalledWith(userId, workspaceId, { limit: 1 });
      const calls = vi.mocked(workspaces.listMembers).mock.calls.length;
      for (const query of ['limit=0', 'limit=101', 'limit=1&limit=2', 'cursor=bad%21cursor', 'cursor=a&cursor=b', 'offset=1']) {
        const response = await fetch(`${base}/api/workspaces/${workspaceId}/members?${query}`, { headers: { Cookie: cookie } });
        expect(response.status).toBe(400);
        expect(JSON.stringify(await response.json())).not.toMatch(/SQL|secret|stack/iu);
      }
      expect(workspaces.listMembers).toHaveBeenCalledTimes(calls);
    } finally {
      await server.close();
    }
  });

  it('keeps invitation tokens in strict JSON bodies and applies auth, Origin, and CSRF boundaries', async () => {
    const workspaces = application();
    const inviteToken = 'C'.repeat(43);
    const invitation = {
      id: memberId,
      workspaceId,
      targetEmail: 'invitee@example.invalid',
      role: 'member' as const,
      createdByUserId: userId,
      createdAt: new Date('2026-09-03T00:00:00.000Z'),
      expiresAt: new Date('2026-09-10T00:00:00.000Z'),
    };
    vi.mocked(workspaces.createInvitation).mockResolvedValue({ invitation, token: inviteToken });
    vi.mocked(workspaces.listInvitations).mockResolvedValue({ invitations: [invitation] });
    vi.mocked(workspaces.previewInvitation).mockResolvedValue({
      workspaceName: 'Platform', targetEmailHint: 'i***@example.invalid', role: 'member', expiresAt: invitation.expiresAt,
    });
    const config: ProductApiConfig = {
      host: '127.0.0.1', port: 0, allowedHosts: new Set(), allowedOrigins: new Set([origin]),
      cookieSecret: secret, secureCookies: false, sessionTtlMs: 60_000, maxBodyBytes: 4_096,
      loginRateLimitMaxAttempts: 5, loginRateLimitWindowMs: 900_000, loginRateLimitBlockMs: 900_000,
    };
    const server = new ProductApiServer({
      authenticate: vi.fn(async () => context()), login: vi.fn(), logout: vi.fn(), register: vi.fn(),
    }, config, undefined, undefined, undefined, workspaces);
    const port = await server.listen();
    const base = `http://127.0.0.1:${port}`;
    try {
      const previewWithoutOrigin = await fetch(`${base}/api/invitations/preview`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: inviteToken }),
      });
      expect(previewWithoutOrigin.status).toBe(403);
      expect(workspaces.previewInvitation).not.toHaveBeenCalled();

      const preview = await fetch(`${base}/api/invitations/preview`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ token: inviteToken }),
      });
      expect(preview.status).toBe(200);
      expect(await preview.json()).toEqual({
        workspaceName: 'Platform', targetEmailHint: 'i***@example.invalid', role: 'member', expiresAt: '2026-09-10T00:00:00.000Z',
      });

      const ownerRole = await fetch(`${base}/api/workspaces/${workspaceId}/invitations`, {
        method: 'POST', headers: mutationHeaders(), body: JSON.stringify({ email: 'invitee@example.invalid', role: 'owner' }),
      });
      expect(ownerRole.status).toBe(422);
      expect(workspaces.createInvitation).not.toHaveBeenCalled();

      const created = await fetch(`${base}/api/workspaces/${workspaceId}/invitations`, {
        method: 'POST', headers: mutationHeaders(), body: JSON.stringify({ email: 'invitee@example.invalid', role: 'member' }),
      });
      expect(created.status).toBe(201);
      expect(await created.json()).toEqual({
        invitation: {
          createdAt: '2026-09-03T00:00:00.000Z', createdByUserId: userId, expiresAt: '2026-09-10T00:00:00.000Z',
          id: memberId, role: 'member', targetEmail: 'invitee@example.invalid', workspaceId,
        },
        token: inviteToken,
      });

      const listed = await fetch(`${base}/api/workspaces/${workspaceId}/invitations`, { headers: { Cookie: cookie } });
      expect(listed.status).toBe(200);
      expect((await listed.json() as { invitations: unknown[] }).invitations).toHaveLength(1);

      const acceptWithoutCsrf = await fetch(`${base}/api/invitations/accept`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: origin }, body: JSON.stringify({ token: inviteToken }),
      });
      expect(acceptWithoutCsrf.status).toBe(403);
      const accepted = await fetch(`${base}/api/invitations/accept`, {
        method: 'POST', headers: mutationHeaders(), body: JSON.stringify({ token: inviteToken }),
      });
      expect(accepted.status).toBe(200);
      expect(workspaces.acceptInvitation).toHaveBeenCalledWith(userId, inviteToken);
    } finally {
      await server.close();
    }
  });
});
