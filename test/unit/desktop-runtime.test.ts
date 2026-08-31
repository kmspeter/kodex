import path from 'node:path';
import process from 'node:process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertOwnedChildPath,
  DesktopStartupError,
  publicDesktopStartupMessage,
  startRuntimeChild,
  stopProcessTree,
  stopRuntimeChildren,
  unusedLoopbackPort,
  validateDesktopDependencies,
  waitForReady,
} from '../../apps/desktop/runtime-processes.mjs';

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');
const fixture = path.join(repositoryRoot, 'apps', 'desktop', 'smoke-service.mjs');
const children: ReturnType<typeof startRuntimeChild>[] = [];

afterEach(async () => stopRuntimeChildren(children.splice(0)));

describe('desktop runtime process coordination', () => {
  it('fails before launch when external PostgreSQL or the cookie secret is missing or malformed', () => {
    const configPath = 'C:\\Users\\person\\AppData\\Roaming\\Kodex\\kodex.env';
    expect(() => validateDesktopDependencies({}, configPath)).toThrowError(
      expect.objectContaining({ code: 'DATABASE_URL_MISSING' }),
    );
    expect(() => validateDesktopDependencies({
      DATABASE_URL: 'postgresql://127.0.0.1/kodex',
    }, configPath)).toThrowError(expect.objectContaining({ code: 'AUTH_COOKIE_SECRET_MISSING' }));
    expect(() => validateDesktopDependencies({
      DATABASE_URL: 'not-a-postgres-url',
      AUTH_COOKIE_SECRET: 'A'.repeat(43),
    }, configPath)).toThrowError(expect.objectContaining({ code: 'DATABASE_URL_INVALID' }));
    expect(() => validateDesktopDependencies({
      DATABASE_URL: 'postgresql://127.0.0.1/kodex',
      AUTH_COOKIE_SECRET: 'short',
    }, configPath)).toThrowError(expect.objectContaining({ code: 'AUTH_COOKIE_SECRET_INVALID' }));
    expect(() => validateDesktopDependencies({
      DATABASE_URL: 'postgresql://127.0.0.1/kodex',
      AUTH_COOKIE_SECRET: 'A'.repeat(43),
    }, configPath)).not.toThrow();
  });

  it('maps only allowlisted startup failures to bounded, credential-free messages', () => {
    const configPath = 'C:\\Users\\person\\AppData\\Roaming\\Kodex\\kodex.env';
    expect(publicDesktopStartupMessage(
      new DesktopStartupError('DATABASE_URL_MISSING', { configPath }),
    )).toBe(`DATABASE_URL is required before Kodex can start.\n\nConfiguration file: ${configPath}`);
    expect(publicDesktopStartupMessage(
      new DesktopStartupError('READINESS_TIMEOUT', { serviceName: 'Kodex Product API' }),
    )).toBe('Timed out waiting for Product API to become ready.');
    expect(publicDesktopStartupMessage(
      new DesktopStartupError('CHILD_EARLY_EXIT', { serviceName: 'Kodex Local Server' }),
    )).toBe('Local Server stopped before Kodex finished starting.');

    const generic = 'Kodex could not start. Check the desktop configuration and try again.';
    expect(publicDesktopStartupMessage(new Error(
      'postgresql://admin:password@db.example/kodex?token=provider-secret',
    ))).toBe(generic);
    expect(publicDesktopStartupMessage(
      new DesktopStartupError('UNKNOWN', {
        configPath: 'https://user:password@example.test/?token=secret',
        serviceName: 'OPENAI_API_KEY=secret',
      }),
    )).toBe(generic);
    const unsafePathMessage = publicDesktopStartupMessage(
      new DesktopStartupError('AUTH_COOKIE_SECRET_MISSING', {
        configPath: 'C:\\temp\\AUTH_COOKIE_SECRET=credential\\kodex.env',
      }),
    );
    expect(unsafePathMessage).toBe('AUTH_COOKIE_SECRET is required before Kodex can start.');
    expect(unsafePathMessage).not.toContain('credential');
  });

  it('keeps cleanup targets inside the explicitly trusted temporary base', () => {
    const base = path.join(repositoryRoot, '.temporary-test-base');
    expect(assertOwnedChildPath(base, path.join(base, 'kodex-desktop-smoke-owned'), 'kodex-desktop-smoke-'))
      .toBe(path.join(base, 'kodex-desktop-smoke-owned'));
    expect(() => assertOwnedChildPath(base, repositoryRoot, 'kodex-desktop-smoke-'))
      .toThrow('outside its trusted base');
    expect(() => assertOwnedChildPath(base, base, 'kodex-desktop-smoke-'))
      .toThrow('outside its trusted base');
  });

  it('waits for Product API readiness on an isolated port and shuts the child down', async () => {
    const productPort = await unusedLoopbackPort();
    const localPort = await unusedLoopbackPort();
    const localOrigin = `http://127.0.0.1:${localPort}`;
    const child = startRuntimeChild('Product API fixture', process.execPath, fixture, {
      cwd: repositoryRoot,
      env: {
        KODEX_SMOKE_SERVICE: 'product-api',
        PRODUCT_API_PORT: String(productPort),
        KODEX_SERVER_PORT: String(localPort),
        KODEX_UI_ORIGINS: localOrigin,
        KODEX_PRODUCT_API_ORIGINS: `http://127.0.0.1:${productPort}`,
      },
    });
    children.push(child);
    await expect(waitForReady(
      child,
      `http://127.0.0.1:${productPort}/api/health/ready`,
      'Product API fixture',
      5_000,
    )).resolves.toBeUndefined();
    const stopStartedAt = Date.now();
    await stopRuntimeChildren(children.splice(0));
    expect(Date.now() - stopStartedAt).toBeLessThan(1_500);
    expect(child.exitCode).toBe(0);
  });

  it('aborts a readiness attempt when a server accepts TCP but never responds', async () => {
    const productPort = await unusedLoopbackPort();
    const child = startRuntimeChild('Hanging readiness fixture', process.execPath, fixture, {
      cwd: repositoryRoot,
      env: {
        KODEX_SMOKE_SERVICE: 'hanging',
        PRODUCT_API_PORT: String(productPort),
      },
    });
    children.push(child);
    const startedAt = Date.now();
    await expect(waitForReady(
      child,
      `http://127.0.0.1:${productPort}/api/health/hang`,
      'Hanging readiness fixture',
      300,
    )).rejects.toMatchObject({ code: 'READINESS_TIMEOUT' });
    expect(Date.now() - startedAt).toBeLessThan(1_500);
    await stopProcessTree(child, 1_000);
    children.splice(children.indexOf(child), 1);
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  });
});
