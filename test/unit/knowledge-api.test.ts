import { PRODUCT_WORKSPACE_HEADER_NAME } from '@kodex/product-contract';
import type { AuthContext } from '@kodex/product-db';
import { describe, expect, it, vi } from 'vitest';
import type { ProductApiConfig } from '../../apps/api/src/config.js';
import { createCsrfToken, csrfCookieName, sessionCookieName } from '../../apps/api/src/cookies.js';
import { ProductApiServer, type KnowledgeApplication } from '../../apps/api/src/server.js';

const userId = '10000000-0000-4000-8000-000000000001';
const workspaceId = '20000000-0000-4000-8000-000000000001';
const otherWorkspaceId = '20000000-0000-4000-8000-000000000002';
const origin = 'http://127.0.0.1:5173';
const token = 'opaque-session';
const secret = Buffer.alloc(32, 31);
const csrf = createCsrfToken(token, secret);
const cookie = `${sessionCookieName}=${token}; ${csrfCookieName}=${csrf}`;

function authContext(): AuthContext {
  return {
    sessionId: '30000000-0000-4000-8000-000000000001',
    expiresAt: new Date(Date.now() + 60_000),
    user: { id: userId, email: 'rag@example.invalid', displayName: null, createdAt: new Date() },
    memberships: [{ id: workspaceId, name: 'RAG', role: 'owner', slug: 'rag' }],
  };
}

function knowledgeApplication(): KnowledgeApplication {
  return {
    config: { maxDocumentCharacters: 1_000, maxQueryCharacters: 100, maxTopK: 10 },
    indexTextDocument: vi.fn(async (_scope, input) => ({
      document: {
        id: input.documentId!, sourceId: '40000000-0000-4000-8000-000000000001',
        sourceDocumentId: input.documentId!, sourceType: 'manual_text', title: input.title,
        contentChecksum: Buffer.alloc(32), indexConfigurationChecksum: Buffer.alloc(32),
        createdAt: new Date('2026-08-31T00:00:00.000Z'), updatedAt: new Date('2026-08-31T00:00:00.000Z'),
      },
      chunkCount: 1,
      skipped: false,
    })),
    listDocuments: vi.fn(async () => ({ data: [] })),
    deleteDocument: vi.fn(async () => undefined),
    retrieve: vi.fn(async () => ({ runId: '50000000-0000-4000-8000-000000000001', citations: [] })),
  };
}

describe('knowledge Product API security and validation', () => {
  it('requires matching workspace scope, session, Origin, CSRF, and exact bounded JSON', async () => {
    const knowledge = knowledgeApplication();
    const config: ProductApiConfig = {
      host: '127.0.0.1', port: 0, allowedHosts: new Set(), allowedOrigins: new Set([origin]),
      cookieSecret: secret, secureCookies: false, sessionTtlMs: 60_000, maxBodyBytes: 4_096,
    };
    const server = new ProductApiServer({
      authenticate: vi.fn(async () => authContext()),
      login: vi.fn(), logout: vi.fn(), register: vi.fn(),
    }, config, undefined, knowledge);
    const port = await server.listen();
    const base = `http://127.0.0.1:${port}`;
    const path = `/api/knowledge/documents?workspace_id=${workspaceId}`;
    const documentId = '60000000-0000-4000-8000-000000000001';
    const validBody = JSON.stringify({ documentId, title: 'Private note', content: 'Only explicit text is embedded.' });
    const request = (headers: Record<string, string>, body = validBody) => fetch(`${base}${path}`, {
      method: 'POST', body, headers: { 'Content-Type': 'application/json', ...headers },
    });
    try {
      expect((await request({ Cookie: cookie, 'X-CSRF-Token': csrf, [PRODUCT_WORKSPACE_HEADER_NAME]: workspaceId })).status).toBe(403);
      expect((await request({ Cookie: cookie, Origin: origin, 'X-CSRF-Token': 'forged', [PRODUCT_WORKSPACE_HEADER_NAME]: workspaceId })).status).toBe(403);
      expect((await request({ Cookie: cookie, Origin: origin, 'X-CSRF-Token': csrf, [PRODUCT_WORKSPACE_HEADER_NAME]: otherWorkspaceId })).status).toBe(403);
      expect((await request(
        { Cookie: cookie, Origin: origin, 'X-CSRF-Token': csrf, [PRODUCT_WORKSPACE_HEADER_NAME]: workspaceId },
        JSON.stringify({ documentId, title: 'Private note', content: 'text', ownerId: userId }),
      )).status).toBe(400);

      const valid = await request({ Cookie: cookie, Origin: origin, 'X-CSRF-Token': csrf, [PRODUCT_WORKSPACE_HEADER_NAME]: workspaceId });
      expect(valid.status).toBe(200);
      expect(await valid.json()).toEqual({
        document: {
          id: documentId,
          sourceId: '40000000-0000-4000-8000-000000000001',
          sourceType: 'manual_text',
          title: 'Private note',
          createdAt: '2026-08-31T00:00:00.000Z',
          updatedAt: '2026-08-31T00:00:00.000Z',
        },
        chunkCount: 1,
        skipped: false,
      });
      expect(knowledge.indexTextDocument).toHaveBeenCalledWith(
        { userId, workspaceId },
        { documentId, title: 'Private note', content: 'Only explicit text is embedded.' },
      );

      const listed = await fetch(`${base}${path}`, {
        headers: { Cookie: cookie, [PRODUCT_WORKSPACE_HEADER_NAME]: workspaceId },
      });
      expect(listed.status).toBe(200);
      expect(knowledge.listDocuments).toHaveBeenCalledWith({ userId, workspaceId }, { limit: 25 });
    } finally {
      await server.close();
    }
  });

  it('accepts a 60000-code-point four-byte Unicode document at the default body cap', async () => {
    const knowledge = knowledgeApplication();
    knowledge.config.maxDocumentCharacters = 60_000;
    const config: ProductApiConfig = {
      host: '127.0.0.1', port: 0, allowedHosts: new Set(), allowedOrigins: new Set([origin]),
      cookieSecret: secret, secureCookies: false, sessionTtlMs: 60_000, maxBodyBytes: 262_144,
    };
    const server = new ProductApiServer({
      authenticate: vi.fn(async () => authContext()),
      login: vi.fn(), logout: vi.fn(), register: vi.fn(),
    }, config, undefined, knowledge);
    const port = await server.listen();
    const documentId = '60000000-0000-4000-8000-000000000002';
    const content = '😀'.repeat(60_000);
    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/api/knowledge/documents?workspace_id=${workspaceId}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: cookie,
            Origin: origin,
            'X-CSRF-Token': csrf,
            [PRODUCT_WORKSPACE_HEADER_NAME]: workspaceId,
          },
          body: JSON.stringify({ documentId, title: 'Emoji boundary', content }),
        },
      );
      expect(response.status).toBe(200);
      expect(knowledge.indexTextDocument).toHaveBeenCalledWith(
        { userId, workspaceId },
        { documentId, title: 'Emoji boundary', content },
      );
    } finally {
      await server.close();
    }
  });

  it('returns 503 while RAG is disabled without invoking any knowledge run', async () => {
    const config: ProductApiConfig = {
      host: '127.0.0.1', port: 0, allowedHosts: new Set(), allowedOrigins: new Set([origin]),
      cookieSecret: secret, secureCookies: false, sessionTtlMs: 60_000, maxBodyBytes: 262_144,
    };
    const auth = {
      authenticate: vi.fn(async () => authContext()),
      login: vi.fn(), logout: vi.fn(), register: vi.fn(),
    };
    const server = new ProductApiServer(auth, config);
    const port = await server.listen();
    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/api/knowledge/query?workspace_id=${workspaceId}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: cookie,
            Origin: origin,
            'X-CSRF-Token': csrf,
            [PRODUCT_WORKSPACE_HEADER_NAME]: workspaceId,
          },
          body: JSON.stringify({ query: 'must not be recorded' }),
        },
      );
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        error: { code: 'knowledge_unavailable' },
      });
      expect(auth.authenticate).toHaveBeenCalledOnce();
    } finally {
      await server.close();
    }
  });
});
