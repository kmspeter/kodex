import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export interface SecurityOptions {
  host: string;
  port: number;
  allowedOrigins: Set<string>;
  maxBodyBytes?: number;
}

function constantTimeEqual(left: string | undefined, right: string): boolean {
  const leftBuffer = Buffer.from(left ?? '');
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of (header ?? '').split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name) cookies.set(name, decodeURIComponent(rest.join('=')));
  }
  return cookies;
}

export class LocalSecurity {
  readonly sessionToken = randomBytes(32).toString('base64url');
  readonly csrfToken = randomBytes(32).toString('base64url');
  readonly maxBodyBytes: number;

  constructor(readonly options: SecurityOptions) {
    this.maxBodyBytes = options.maxBodyBytes ?? 1_000_000;
  }

  applyCors(request: IncomingMessage, response: ServerResponse): void {
    const origin = request.headers.origin;
    if (origin && this.options.allowedOrigins.has(origin)) {
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Access-Control-Allow-Credentials', 'true');
      response.setHeader('Vary', 'Origin');
    }
    response.setHeader('Cache-Control', 'no-store, max-age=0');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-site');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    // Bootstrap is a same-origin GET in production. Keep referrers off the wire for
    // cross-origin navigation while allowing the browser to prove the local UI origin.
    response.setHeader('Referrer-Policy', 'same-origin');
  }

  verify(request: IncomingMessage, mutation = false): void {
    const host = (request.headers.host ?? '').toLocaleLowerCase();
    const allowedHosts = new Set([
      `${this.options.host}:${this.options.port}`.toLocaleLowerCase(),
      `localhost:${this.options.port}`,
    ]);
    if (!allowedHosts.has(host)) throw new Error('Kodex only accepts loopback Host headers.');
    const origin = request.headers.origin;
    if (origin && !this.options.allowedOrigins.has(origin)) throw new Error('Browser Origin is not allowed.');
    if (!mutation) return;
    if (!origin || !this.options.allowedOrigins.has(origin)) throw new Error('A valid Origin is required for mutations.');
    const cookies = parseCookies(request.headers.cookie);
    const sessionHeader = request.headers['x-kodex-session'] as string | undefined;
    if (!constantTimeEqual(cookies.get('kodex_session'), this.sessionToken) && !constantTimeEqual(sessionHeader, this.sessionToken)) throw new Error('Kodex session is invalid.');
    if (!constantTimeEqual(request.headers['x-kodex-csrf'] as string | undefined, this.csrfToken)) throw new Error('CSRF token is invalid.');
    const contentLength = Number(request.headers['content-length'] ?? 0);
    if (contentLength > this.maxBodyBytes) throw new Error('Request body is too large.');
  }

  verifyWebSocket(request: IncomingMessage): void {
    this.verify(request, false);
    const origin = request.headers.origin;
    if (!origin || !this.options.allowedOrigins.has(origin)) throw new Error('WebSocket Origin is not allowed.');
    const cookies = parseCookies(request.headers.cookie);
    const protocols = (request.headers['sec-websocket-protocol'] ?? '').split(',').map((entry) => entry.trim());
    if (!constantTimeEqual(cookies.get('kodex_session'), this.sessionToken) && !protocols.some((entry) => constantTimeEqual(entry, this.sessionToken))) throw new Error('Kodex WebSocket session is invalid.');
  }

  verifyBootstrap(request: IncomingMessage): void {
    if (request.headers['x-kodex-bootstrap'] === '1') return;
    const origin = request.headers.origin;
    if (origin && this.options.allowedOrigins.has(origin)) return;
    const referer = request.headers.referer;
    if (!origin && referer) {
      try {
        if (this.options.allowedOrigins.has(new URL(referer).origin)) return;
      } catch { /* reject below */ }
    }
    throw new Error('Kodex bootstrap requires an allowed local UI Origin.');
  }

  setSessionCookie(response: ServerResponse): void {
    response.setHeader('Set-Cookie', `kodex_session=${encodeURIComponent(this.sessionToken)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200`);
  }
}
