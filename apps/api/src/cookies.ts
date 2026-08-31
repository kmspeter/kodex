import { createHmac, timingSafeEqual } from 'node:crypto';
import { PRODUCT_SESSION_COOKIE_NAME } from '@kodex/product-contract';

export const sessionCookieName = PRODUCT_SESSION_COOKIE_NAME;
export const csrfCookieName = 'kodex_product_csrf';

function constantTimeEqual(left: string | undefined, right: string): boolean {
  const leftBuffer = Buffer.from(left ?? '', 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function parseCookies(header: string | undefined): Map<string, string> {
  const result = new Map<string, string>();
  for (const part of (header ?? '').split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (!name || rest.length === 0) {
      continue;
    }
    try {
      result.set(name, decodeURIComponent(rest.join('=')));
    } catch {
      // Invalid cookie encoding is treated as a missing credential.
    }
  }
  return result;
}

export function createCsrfToken(sessionToken: string, secret: Buffer): string {
  return createHmac('sha256', secret)
    .update('kodex-product-csrf\0', 'utf8')
    .update(sessionToken, 'utf8')
    .digest('base64url');
}

function cookieAttributes(
  expiresAt: Date,
  secure: boolean,
  httpOnly: boolean,
): string {
  const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1_000));
  return [
    'Path=/',
    httpOnly ? 'HttpOnly' : undefined,
    'SameSite=Strict',
    secure ? 'Secure' : undefined,
    `Max-Age=${maxAge}`,
    `Expires=${expiresAt.toUTCString()}`,
  ].filter(Boolean).join('; ');
}

export function createSessionCookies(
  sessionToken: string,
  expiresAt: Date,
  secret: Buffer,
  secure: boolean,
): string[] {
  const csrfToken = createCsrfToken(sessionToken, secret);
  return [
    `${sessionCookieName}=${encodeURIComponent(sessionToken)}; ${cookieAttributes(expiresAt, secure, true)}`,
    `${csrfCookieName}=${encodeURIComponent(csrfToken)}; ${cookieAttributes(expiresAt, secure, false)}`,
  ];
}

export function clearSessionCookies(secure: boolean): string[] {
  const common = `Path=/; SameSite=Strict;${secure ? ' Secure;' : ''} Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
  return [
    `${sessionCookieName}=; HttpOnly; ${common}`,
    `${csrfCookieName}=; ${common}`,
  ];
}

export function verifyCsrfToken(
  sessionToken: string,
  cookieToken: string | undefined,
  headerToken: string | undefined,
  secret: Buffer,
): boolean {
  const expected = createCsrfToken(sessionToken, secret);
  return constantTimeEqual(cookieToken, expected) && constantTimeEqual(headerToken, expected);
}
