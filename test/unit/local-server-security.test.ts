import { describe, expect, it } from 'vitest';
import { authorizationRevalidationDelay } from '../../apps/local-server/src/api/http-server';
import { parseProductApiOrigins } from '../../apps/local-server/src/api/security';

describe('Local Server tenant security configuration', () => {
  it('bounds clock-skew revalidation with a small minimum without delaying a future expiry', () => {
    const now = Date.parse('2026-08-31T00:00:00.000Z');
    expect(authorizationRevalidationDelay(new Date(now + 250), now, 300_000, true)).toBe(250);
    expect(authorizationRevalidationDelay(new Date(now - 1), now, 300_000, false)).toBe(0);
    expect(authorizationRevalidationDelay(new Date(now - 1), now, 300_000, true)).toBe(1_000);
    expect(authorizationRevalidationDelay(new Date(now - 1), now, 50, true)).toBe(50);
  });

  it('accepts exact custom Product API origins and rejects CSP injection-shaped values', () => {
    expect(parseProductApiOrigins('http://127.0.0.1:49000,https://auth.example.test'))
      .toEqual(new Set(['http://127.0.0.1:49000', 'https://auth.example.test']));
    for (const invalid of [
      '',
      'javascript:alert(1)',
      'http://127.0.0.1:49000/path',
      'http://127.0.0.1:49000;script-src *',
      'http://127.0.0.1:49000,http://127.0.0.1:49000',
      'http://user:password@127.0.0.1:49000',
    ]) {
      expect(() => parseProductApiOrigins(invalid)).toThrow('exact HTTP(S) origins');
    }
  });
});
