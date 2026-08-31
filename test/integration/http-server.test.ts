import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { PRODUCT_SESSION_COOKIE_NAME, PRODUCT_WORKSPACE_HEADER_NAME } from '@kodex/product-contract';
import { hashSessionToken, type AuthContext } from '@kodex/product-db';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { LocalHttpServer } from '../../apps/local-server/src/api/http-server';
import { DatabaseProductAuthorizer } from '../../apps/local-server/src/auth/product-authorization';
import { RuntimeManager } from '../../apps/local-server/src/runtime-manager';

const origin = 'http://127.0.0.1:5173';
const userA = '10000000-0000-4000-8000-000000000001';
const userB = '10000000-0000-4000-8000-000000000002';
const workspaceA = '20000000-0000-4000-8000-000000000001';
const workspaceB = '20000000-0000-4000-8000-000000000002';
const sessionA = '30000000-0000-4000-8000-000000000001';
const sessionB = '30000000-0000-4000-8000-000000000002';
const tokenA = 'a'.repeat(43);
const tokenB = 'b'.repeat(43);
const roots: string[] = [];

async function getWithHost(url: string, host: string): Promise<{ body: string; status: number }> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: 'GET',
      headers: { Host: host },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.once('end', () => resolve({
        body: Buffer.concat(chunks).toString('utf8'),
        status: response.statusCode ?? 0,
      }));
    });
    request.once('error', reject);
    request.end();
  });
}

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

class MemorySessionRepository {
  readonly sessions = new Map<string, AuthContext>();

  set(token: string, context: AuthContext): void {
    this.sessions.set(hashSessionToken(token).toString('hex'), context);
  }

  revoke(token: string): void {
    this.sessions.delete(hashSessionToken(token).toString('hex'));
  }

  async findAuthContext(tokenHash: Buffer): Promise<AuthContext | undefined> {
    return this.sessions.get(tokenHash.toString('hex'));
  }
}

function context(userId: string, sessionId: string, workspaceId: string): AuthContext {
  return {
    user: { id: userId, email: 'redacted@example.invalid', displayName: null, createdAt: new Date(0) },
    sessionId,
    expiresAt: new Date(Date.now() + 60 * 60_000),
    memberships: [{ id: workspaceId, name: 'Test', slug: `test-${workspaceId.slice(-4)}`, role: 'owner' }],
  };
}

async function fixture(options: { productApiOrigins?: ReadonlySet<string>; revalidateMs?: number; uiRoot?: string } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodex-tenant-http-'));
  roots.push(root);
  const repository = new MemorySessionRepository();
  repository.set(tokenA, context(userA, sessionA, workspaceA));
  repository.set(tokenB, context(userB, sessionB, workspaceB));
  const manager = new RuntimeManager({
    repositoryRoot: root,
    dataRoot: path.join(root, 'data'),
    tenantRoot: path.join(root, 'data', 'tenants'),
    runtimeOptions: { startAppServer: false },
    idleTimeoutMs: 60_000,
    sweepIntervalMs: 60_000,
  });
  const server = new LocalHttpServer(manager, new DatabaseProductAuthorizer(repository), {
    host: '127.0.0.1',
    port: 0,
    allowedOrigins: new Set([origin]),
    authorizationRevalidateMs: options.revalidateMs,
    productApiOrigins: options.productApiOrigins,
    uiRoot: options.uiRoot,
  });
  const port = await server.listen();
  return { baseUrl: `http://127.0.0.1:${port}`, manager, port, repository, root, server };
}

function productCookie(token: string): string {
  return `${PRODUCT_SESSION_COOKIE_NAME}=${token}`;
}

async function bootstrap(baseUrl: string, token: string, workspaceId: string) {
  const response = await fetch(`${baseUrl}/api/bootstrap`, {
    headers: {
      Origin: origin,
      Cookie: productCookie(token),
      [PRODUCT_WORKSPACE_HEADER_NAME]: workspaceId,
    },
  });
  const body = await response.json() as { csrfToken: string; sessionToken: string };
  const localCookie = response.headers.get('set-cookie')?.split(';', 1)[0] ?? '';
  return { body, localCookie, response };
}

function waitForMessage(messages: Array<Record<string, unknown>>, predicate: (message: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 3_000;
    const inspect = () => {
      const found = messages.find(predicate);
      if (found) { resolve(found); return; }
      if (Date.now() >= deadline) { reject(new Error('Timed out waiting for WebSocket message')); return; }
      setTimeout(inspect, 10);
    };
    inspect();
  });
}

async function connectSocket(
  port: number,
  token: string,
  workspaceId: string,
  localSession: string,
): Promise<{ messages: Array<Record<string, unknown>>; socket: WebSocket }> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?workspace_id=${workspaceId}`, ['kodex', localSession], {
    origin,
    headers: { Cookie: productCookie(token) },
  });
  const messages: Array<Record<string, unknown>> = [];
  socket.on('message', (raw) => messages.push(JSON.parse(raw.toString()) as Record<string, unknown>));
  const hello = await waitForMessage(messages, (message) => message.type === 'hello');
  socket.send(JSON.stringify({ type: 'replay', epoch: hello.epoch, afterSequence: hello.latestSequence }));
  return { messages, socket };
}

describe('tenant-authorized Local Server', () => {
  it('keeps readiness public but rejects missing sessions, missing scopes, and non-member HTTP before runtime creation', async () => {
    const { baseUrl, manager, server } = await fixture();
    try {
      expect((await fetch(`${baseUrl}/api/health`)).status).toBe(200);
      expect(manager.inspect()).toHaveLength(0);

      const missingSession = await fetch(`${baseUrl}/api/bootstrap`, {
        headers: { Origin: origin, [PRODUCT_WORKSPACE_HEADER_NAME]: workspaceA },
      });
      expect(missingSession.status).toBe(401);
      const missingScope = await fetch(`${baseUrl}/api/bootstrap`, {
        headers: { Origin: origin, Cookie: productCookie(tokenA) },
      });
      expect(missingScope.status).toBe(403);
      const crossTenant = await fetch(`${baseUrl}/api/bootstrap`, {
        headers: { Origin: origin, Cookie: productCookie(tokenA), [PRODUCT_WORKSPACE_HEADER_NAME]: workspaceB },
      });
      expect(crossTenant.status).toBe(403);
      expect(manager.inspect()).toHaveLength(0);
    } finally {
      await server.close();
      await manager.close();
    }
  });

  it('combines product authorization with the existing bootstrap session and mutation CSRF checks', async () => {
    const { baseUrl, manager, server } = await fixture();
    try {
      const established = await bootstrap(baseUrl, tokenA, workspaceA);
      expect(established.response.status).toBe(200);
      const denied = await fetch(`${baseUrl}/api/settings`, {
        method: 'PUT',
        headers: {
          Origin: origin,
          Cookie: `${productCookie(tokenA)}; ${established.localCookie}`,
          [PRODUCT_WORKSPACE_HEADER_NAME]: workspaceA,
          'Content-Type': 'application/json',
        },
        body: '{}',
      });
      expect(denied.status).toBe(403);

      const accepted = await fetch(`${baseUrl}/api/settings`, {
        method: 'PUT',
        headers: {
          Origin: origin,
          Cookie: productCookie(tokenA),
          [PRODUCT_WORKSPACE_HEADER_NAME]: workspaceA,
          'X-Kodex-Session': established.body.sessionToken,
          'X-Kodex-CSRF': established.body.csrfToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ network: { webSearch: false } }),
      });
      expect(accepted.status).toBe(200);
      expect((await accepted.json() as { network: { webSearch: boolean } }).network.webSearch).toBe(false);
      expect(manager.inspect()[0]?.root).toContain(path.join('users', userA, 'workspaces', workspaceA));
    } finally {
      await server.close();
      await manager.close();
    }
  });

  it('serves static login UI without creating a runtime', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodex-static-ui-'));
    roots.push(root);
    const uiRoot = path.join(root, 'ui');
    await mkdir(uiRoot, { recursive: true });
    await writeFile(path.join(uiRoot, 'index.html'), '<!doctype html><html><head><title>Kodex local</title></head><body><div id="root"></div></body></html>', 'utf8');
    const instance = await fixture({
      uiRoot,
      productApiOrigins: new Set([
        'http://127.0.0.1:49000',
        'http://localhost:49000',
      ]),
    });
    try {
      const page = await fetch(`${instance.baseUrl}/some/spa/route`);
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain('Kodex local');
      expect(html).toContain('<meta name="kodex-product-api-origin" content="http://127.0.0.1:49000">');
      expect(page.headers.get('content-security-policy')).toContain('http://127.0.0.1:49000 http://localhost:49000');
      expect(page.headers.get('content-security-policy')).not.toContain('47832');
      const localhostPage = await getWithHost(
        `${instance.baseUrl}/`,
        `localhost:${instance.port}`,
      );
      expect(localhostPage.status).toBe(200);
      expect(localhostPage.body).toContain(
        '<meta name="kodex-product-api-origin" content="http://localhost:49000">',
      );
      expect(instance.manager.inspect()).toHaveLength(0);
    } finally {
      await instance.server.close();
      await instance.manager.close();
    }
  });

  it('isolates event/replay streams by runtime and closes a socket after session revocation', async () => {
    const { manager, port, repository, server, baseUrl } = await fixture({ revalidateMs: 50 });
    const establishedA = await bootstrap(baseUrl, tokenA, workspaceA);
    const establishedB = await bootstrap(baseUrl, tokenB, workspaceB);
    const socketA = await connectSocket(port, tokenA, workspaceA, establishedA.body.sessionToken);
    const socketB = await connectSocket(port, tokenB, workspaceB, establishedB.body.sessionToken);
    try {
      const leaseA = await manager.acquire({
        userId: userA, workspaceId: workspaceA, sessionId: sessionA, sessionExpiresAt: new Date(Date.now() + 60_000), workspaceRole: 'owner',
      });
      leaseA.runtime.emit({ type: 'engine', engine: leaseA.runtime.appServer.status() });
      leaseA.release();
      await waitForMessage(socketA.messages, (message) => message.type === 'engine');
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(socketB.messages.some((message) => message.type === 'engine')).toBe(false);

      const closed = new Promise<number>((resolve) => socketA.socket.once('close', (code) => resolve(code)));
      repository.revoke(tokenA);
      await expect(closed).resolves.toBe(1008);
      expect(socketB.socket.readyState).toBe(WebSocket.OPEN);
    } finally {
      socketA.socket.close();
      socketB.socket.close();
      await server.close();
      await manager.close();
    }
  });
});
