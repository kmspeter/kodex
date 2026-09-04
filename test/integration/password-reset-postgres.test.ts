import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import {
  Argon2idPasswordHasher,
  AuthService,
  hashPasswordResetToken,
  loadMigrations,
  PasswordResetService,
  PostgresAbuseRateLimiter,
  PostgresAuthRepository,
  PostgresLoginRateLimiter,
  PostgresPasswordResetRepository,
  requireProductDatabaseFromEnv,
  type AbuseRateLimitPolicies,
  type ProductDatabase,
} from '@kodex/product-db';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { ProductApiConfig } from '../../apps/api/src/config.js';
import { WebhookPasswordResetDelivery } from '../../apps/api/src/password-reset-delivery.js';
import { ProductApiServer } from '../../apps/api/src/server.js';

const databaseUrl = process.env.PASSWORD_RESET_DATABASE_URL;
if (!databaseUrl) throw new Error('Password reset PostgreSQL acceptance requires PASSWORD_RESET_DATABASE_URL.');
const mode = process.env.PASSWORD_RESET_MIGRATION_MODE === 'legacy-upgrade' ? 'legacy-upgrade' : 'fresh';
const origin = 'http://127.0.0.1:5173';
const bearerToken = 'delivery-secret-'.padEnd(40, 'x');

let database: ProductDatabase;
let api: ProductApiServer;
let apiBase: string;
let deliveryServer: Server;
let deliveryUrl: string;
let failDelivery = false;
const deliveries: Array<Record<string, unknown>> = [];

const policies: AbuseRateLimitPolicies = Object.fromEntries([
  'register', 'invitation_preview', 'invitation_accept', 'password_reset_request', 'password_reset_complete',
].map((action) => [action, { maxAttempts: 100, windowMs: 60_000, blockMs: 30_000 }])) as AbuseRateLimitPolicies;

function jsonPost(pathname: string, body: unknown): Promise<Response> {
  return fetch(`${apiBase}${pathname}`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function deliveredToken(index: number): string {
  const resetUrl = new URL(String(deliveries[index]?.resetUrl));
  expect(resetUrl.origin).toBe(origin);
  expect(resetUrl.search).toBe('');
  const value = resetUrl.hash.slice('#password-reset='.length);
  expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  return value;
}

beforeAll(async () => {
  process.env.DATABASE_URL = databaseUrl;
  process.env.PRODUCT_DB_SSL = 'disable';
  database = requireProductDatabaseFromEnv();
  if (mode === 'legacy-upgrade') {
    const migrations = await loadMigrations();
    await database.transaction(async (client) => {
      await client.query(`CREATE TABLE public.schema_migrations (
        version bigint PRIMARY KEY, name text NOT NULL, checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
      for (const migration of migrations.slice(0, 10)) {
        await client.query(migration.sql);
        await client.query(
          'INSERT INTO public.schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
          [migration.version, migration.name, migration.checksum],
        );
      }
    });
  }
  const applied = await database.migrate();
  expect(applied.map((migration) => migration.version)).toEqual(
    mode === 'legacy-upgrade' ? [11] : Array.from({ length: 11 }, (_, index) => index + 1),
  );

  deliveryServer = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      expect(request.headers.authorization).toBe(`Bearer ${bearerToken}`);
      deliveries.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>);
      response.statusCode = failDelivery ? 503 : 202;
      response.end();
    })();
  });
  await new Promise<void>((resolve, reject) => {
    deliveryServer.once('error', reject);
    deliveryServer.listen(0, '127.0.0.1', () => resolve());
  });
  const deliveryAddress = deliveryServer.address();
  if (!deliveryAddress || typeof deliveryAddress === 'string') throw new Error('Delivery fixture did not bind.');
  deliveryUrl = `http://127.0.0.1:${deliveryAddress.port}/reset`;

  const cookieSecret = Buffer.alloc(32, 61);
  const abuse = new PostgresAbuseRateLimiter(database, cookieSecret, policies);
  const hasher = new Argon2idPasswordHasher();
  const auth = await AuthService.create(new PostgresAuthRepository(database), hasher, {
    abuseRateLimiter: abuse,
    loginRateLimitSecret: cookieSecret,
    loginRateLimiter: new PostgresLoginRateLimiter(database, {
      maxAttempts: 20, windowMs: 60_000, blockMs: 30_000,
    }),
  });
  const reset = new PasswordResetService(
    new PostgresPasswordResetRepository(database),
    hasher,
    new WebhookPasswordResetDelivery({
      enabled: true,
      bearerToken,
      deliveryUrl,
      publicOrigin: origin,
      timeoutMs: 5_000,
      ttlMs: 60 * 60_000,
    }),
    abuse,
  );
  const config: ProductApiConfig = {
    host: '127.0.0.1', port: 0, allowedHosts: new Set(), allowedOrigins: new Set([origin]),
    cookieSecret, secureCookies: false, sessionTtlMs: 60 * 60_000, maxBodyBytes: 65_536,
    loginRateLimitMaxAttempts: 20, loginRateLimitWindowMs: 60_000, loginRateLimitBlockMs: 30_000,
  };
  api = new ProductApiServer(auth, config, undefined, undefined, undefined, undefined, abuse, undefined, reset);
  apiBase = `http://127.0.0.1:${await api.listen()}`;
});

afterAll(async () => {
  await api?.close();
  await new Promise<void>((resolve) => deliveryServer?.close(() => resolve()));
  await database?.close();
});

it(`keeps reset tokens hash-only and generic, consumes once, revokes sessions, and compensates delivery failure (${mode})`, async () => {
  const auth = await AuthService.create(
    new PostgresAuthRepository(database),
    new Argon2idPasswordHasher(),
    {
      loginRateLimitSecret: Buffer.alloc(32, 61),
      loginRateLimiter: new PostgresLoginRateLimiter(database, {
        maxAttempts: 20, windowMs: 60_000, blockMs: 30_000,
      }),
    },
  );
  const email = `reset-${randomUUID()}@example.com`;
  const oldPassword = 'old password long enough';
  const newPassword = 'new password long enough';
  const registration = await auth.register({ email, password: oldPassword, displayName: 'Recovery Drill' });
  const second = await auth.login({ email, password: oldPassword }, { directAddress: '127.0.0.2' });

  const known = await jsonPost('/api/auth/password-reset/request', { email });
  const knownBody = await known.text();
  const unknown = await jsonPost('/api/auth/password-reset/request', { email: `missing-${randomUUID()}@example.com` });
  expect(unknown.status).toBe(known.status);
  expect(await unknown.text()).toBe(knownBody);
  expect(known.status).toBe(202);
  expect(deliveries).toHaveLength(1);
  const resetToken = deliveredToken(0);
  const stored = await database.query<{ hash: string; raw_column_count: number }>(
    `SELECT encode(token_hash, 'hex') AS hash,
       (SELECT count(*)::int FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'password_reset_requests'
          AND column_name IN ('token', 'raw_token', 'email', 'reset_url')) AS raw_column_count
     FROM password_reset_requests ORDER BY created_at DESC LIMIT 1`,
  );
  expect(stored.rows[0].hash).toBe(hashPasswordResetToken(resetToken).toString('hex'));
  expect(stored.rows[0].raw_column_count).toBe(0);

  const completions = await Promise.all([
    jsonPost('/api/auth/password-reset/complete', { token: resetToken, newPassword }),
    jsonPost('/api/auth/password-reset/complete', { token: resetToken, newPassword }),
  ]);
  expect(completions.map((response) => response.status).sort()).toEqual([204, 410]);
  await expect(auth.authenticate(registration.token)).rejects.toMatchObject({ code: 'unauthenticated' });
  await expect(auth.authenticate(second.token)).rejects.toMatchObject({ code: 'unauthenticated' });
  await expect(auth.login({ email, password: oldPassword }, { directAddress: '127.0.0.3' }))
    .rejects.toMatchObject({ code: 'invalid_credentials' });
  await expect(auth.login({ email, password: newPassword }, { directAddress: '127.0.0.3' }))
    .resolves.toMatchObject({ context: { user: { email } } });

  expect((await jsonPost('/api/auth/password-reset/request', { email })).status).toBe(202);
  const supersededToken = deliveredToken(1);
  expect((await jsonPost('/api/auth/password-reset/request', { email })).status).toBe(202);
  const expiredToken = deliveredToken(2);
  expect((await jsonPost('/api/auth/password-reset/complete', {
    token: supersededToken, newPassword: 'superseded password is rejected',
  })).status).toBe(410);
  await database.query(
    `UPDATE password_reset_requests
     SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour'
     WHERE token_hash = $1`,
    [hashPasswordResetToken(expiredToken)],
  );
  expect((await jsonPost('/api/auth/password-reset/complete', {
    token: expiredToken, newPassword: 'expired password is rejected',
  })).status).toBe(410);

  failDelivery = true;
  const failed = await jsonPost('/api/auth/password-reset/request', { email });
  expect(failed.status).toBe(202);
  expect(await failed.text()).toBe(knownBody);
  const failedRow = await database.query<{ delivery_failed_at: Date | null; revoked_at: Date | null }>(
    'SELECT delivery_failed_at, revoked_at FROM password_reset_requests ORDER BY created_at DESC, id DESC LIMIT 1',
  );
  expect(failedRow.rows[0].delivery_failed_at).toBeInstanceOf(Date);
  expect(failedRow.rows[0].revoked_at).toBeInstanceOf(Date);
  expect(JSON.stringify(deliveries)).not.toContain(oldPassword);
  expect(JSON.stringify(deliveries)).not.toContain(newPassword);
});
