import {
  parseProductEmailVerificationStatus,
  parseProductVerificationPending,
} from '../../packages/product-contract/src/index.js';
import {
  recoverEmailVerificationTokenFromLocation,
} from '../../apps/ui/src/auth/email-verification-fragment.js';
import { ProductAuthClient } from '../../apps/ui/src/auth/product-auth.js';
import { describe, expect, it, vi } from 'vitest';

const token = 'A'.repeat(43);

describe('email verification browser boundary', () => {
  it('removes the fragment before returning a canonical token', () => {
    const replaceState = vi.fn();
    expect(recoverEmailVerificationTokenFromLocation({
      hash: `#email-verification=${token}`,
      pathname: '/app',
      search: '?safe=1',
    }, { state: { navigation: true }, replaceState })).toBe(token);
    expect(replaceState).toHaveBeenCalledWith({ navigation: true }, '', '/app?safe=1');

    expect(recoverEmailVerificationTokenFromLocation({
      hash: '#email-verification=not-a-token',
      pathname: '/',
      search: '',
    }, { state: null, replaceState })).toBeNull();
    expect(replaceState).toHaveBeenLastCalledWith(null, '', '/');
    expect(recoverEmailVerificationTokenFromLocation({
      hash: `#email-verification=${'V'.repeat(43)}`,
      pathname: '/',
      search: '',
    }, { state: null, replaceState })).toBeNull();
  });

  it('strictly rejects provider secrets, tokens, and extra status fields', () => {
    expect(parseProductVerificationPending({
      csrfToken: 'C'.repeat(43), email: 'person@example.com', status: 'verification_pending',
    })).toMatchObject({ email: 'person@example.com', status: 'verification_pending' });
    expect(parseProductEmailVerificationStatus({ email: 'person@example.com', status: 'pending' }))
      .toEqual({ email: 'person@example.com', status: 'pending' });
    expect(() => parseProductVerificationPending({
      csrfToken: 'C'.repeat(43), email: 'person@example.com', status: 'verification_pending', token,
    })).toThrow();
    expect(() => parseProductEmailVerificationStatus({
      email: 'person@example.com', status: 'pending', providerSecret: 'forbidden',
    })).toThrow();
  });

  it('keeps the pending CSRF proof only in client memory for resend', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        csrfToken: 'C'.repeat(43), email: 'person@example.com', status: 'verification_pending',
      }), { status: 202, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), {
        status: 202, headers: { 'Content-Type': 'application/json' },
      }));
    const client = new ProductAuthClient({
      apiBase: 'https://kodex.example',
      development: false,
      pageUrl: 'https://kodex.example/app',
      fetch,
    });
    await expect(client.register({ email: 'person@example.com', password: 'long enough password' }))
      .resolves.toMatchObject({ status: 'verification_pending' });
    await expect(client.resendEmailVerification()).resolves.toBeUndefined();
    const resend = fetch.mock.calls[1][1] as RequestInit;
    expect(new Headers(resend.headers).get('X-CSRF-Token')).toBe('C'.repeat(43));
    expect(JSON.stringify(fetch.mock.calls)).not.toContain(token);
  });
});
