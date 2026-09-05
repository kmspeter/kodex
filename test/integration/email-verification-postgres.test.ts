import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import {
  Argon2idPasswordHasher,
  AuthService,
  EmailVerificationService,
  hashEmailVerificationToken,
  hashWorkspaceInvitationToken,
  loadMigrations,
  PostgresAbuseRateLimiter,
  PostgresAuthRepository,
  PostgresEmailDeliveryRepository,
  PostgresEmailVerificationRepository,
  PostgresLoginRateLimiter,
  PostgresWorkspaceRepository,
  requireProductDatabaseFromEnv,
  type AbuseRateLimitPolicies,
  type ProductDatabase,
} from '@kodex/product-db';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { ProductApiConfig } from '../../apps/api/src/config.js';
import { WebhookEmailDelivery, type EmailDeliveryConfig } from '../../apps/api/src/email-delivery.js';
import { EmailDeliveryWorker } from '../../apps/api/src/email-delivery-worker.js';
import { ProductApiServer } from '../../apps/api/src/server.js';

const databaseUrl = process.env.EMAIL_VERIFICATION_DATABASE_URL;
if (!databaseUrl) throw new Error('Email verification PostgreSQL acceptance requires EMAIL_VERIFICATION_DATABASE_URL.');
const mode = process.env.EMAIL_VERIFICATION_MIGRATION_MODE === 'legacy-upgrade' ? 'legacy-upgrade' : 'fresh';
const origin = 'http://127.0.0.1:5173';
const bearerToken = 'phase-32-delivery-secret'.padEnd(40, 'x');
const cookieSecret = Buffer.alloc(32, 83);
const policy = { maxAttempts: 100, windowMs: 60_000, blockMs: 30_000 };
const policies = Object.fromEntries([
  'register', 'invitation_preview', 'invitation_accept', 'password_reset_request', 'password_reset_complete',
  'email_verification_resend', 'email_verification_complete',
].map((action) => [action, policy])) as AbuseRateLimitPolicies;

let database: ProductDatabase;
let api: ProductApiServer;
let apiBase = '';
let provider: Server;
let worker: EmailDeliveryWorker;
let legacyUserId: string | undefined;
let providerStatus = 202;
const deliveries: Array<Record<string, unknown>> = [];

function cookieHeader(response: Response): string {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const values = headers.getSetCookie?.() ?? [response.headers.get('set-cookie') ?? ''].filter(Boolean);
  return values.map((entry) => entry.split(';', 1)[0]).join('; ');
}

function tokenFromDelivery(index: number, field: 'invitationUrl' | 'verificationUrl', prefix: string): string {
  const url = new URL(String(deliveries[index]?.[field]));
  expect(url.origin).toBe(origin);
  expect(url.search).toBe('');
  const token = url.hash.slice(prefix.length);
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  return token;
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
      for (const migration of migrations.slice(0, 12)) {
        await client.query(migration.sql);
        await client.query(
          'INSERT INTO public.schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
          [migration.version, migration.name, migration.checksum],
        );
      }
      const existing = await client.query<{ id: string }>(
        `INSERT INTO users (email, display_name) VALUES ($1, 'Existing User') RETURNING id`,
        [`existing-${randomUUID()}@example.com`],
      );
      legacyUserId = existing.rows[0].id;
    });
  }
  const applied = await database.migrate();
  expect(applied.map((migration) => migration.version)).toEqual(
    mode === 'legacy-upgrade' ? [13] : Array.from({ length: 13 }, (_, index) => index + 1),
  );
  if (legacyUserId) {
    const existing = await database.query<{ email_verified_at: Date | null }>(
      'SELECT email_verified_at FROM users WHERE id = $1',
      [legacyUserId],
    );
    expect(existing.rows[0].email_verified_at).toBeInstanceOf(Date);
  }

  provider = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      expect(request.headers.authorization).toBe(`Bearer ${bearerToken}`);
      deliveries.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>);
      response.statusCode = providerStatus;
      response.setHeader('Content-Type', 'application/json');
      response.end('{}');
    })();
  });
  await new Promise<void>((resolve, reject) => {
    provider.once('error', reject);
    provider.listen(0, '127.0.0.1', resolve);
  });
  const address = provider.address();
  if (!address || typeof address === 'string') throw new Error('Email provider fixture did not bind.');
  const deliveryConfig: EmailDeliveryConfig = {
    bearerToken,
    deliveryUrl: `http://127.0.0.1:${address.port}/delivery`,
    leaseMs: 30_000,
    maxAttempts: 3,
    maxResponseBytes: 4_096,
    pollMs: 60_000,
    publicOrigin: origin,
    retryBaseMs: 1_000,
    timeoutMs: 5_000,
    verificationTtlMs: 60 * 60_000,
  };
  const abuse = new PostgresAbuseRateLimiter(database, cookieSecret, policies);
  const auth = await AuthService.create(new PostgresAuthRepository(database), new Argon2idPasswordHasher(), {
    abuseRateLimiter: abuse,
    loginRateLimitSecret: cookieSecret,
    loginRateLimiter: new PostgresLoginRateLimiter(database, {
      maxAttempts: 20, windowMs: 60_000, blockMs: 30_000,
    }),
    requireEmailVerification: true,
  });
  const verification = new EmailVerificationService(
    new PostgresEmailVerificationRepository(database),
    abuse,
  );
  worker = new EmailDeliveryWorker(
    new PostgresEmailDeliveryRepository(database),
    new WebhookEmailDelivery(deliveryConfig),
    deliveryConfig,
  );
  const config: ProductApiConfig = {
    host: '127.0.0.1', port: 0, allowedHosts: new Set(), allowedOrigins: new Set([origin]),
    cookieSecret, secureCookies: false, sessionTtlMs: 60 * 60_000, maxBodyBytes: 65_536,
    loginRateLimitMaxAttempts: 20, loginRateLimitWindowMs: 60_000, loginRateLimitBlockMs: 30_000,
  };
  api = new ProductApiServer(
    auth,
    config,
    undefined,
    undefined,
    undefined,
    new PostgresWorkspaceRepository(database, {
      cursorSecret: cookieSecret,
      emailDeliveryEnabled: true,
    }),
    abuse,
    undefined,
    undefined,
    undefined,
    undefined,
    verification,
  );
  apiBase = `http://127.0.0.1:${await api.listen()}`;
});

afterAll(async () => {
  await worker?.stop();
  await api?.close();
  await new Promise<void>((resolve) => provider?.close(() => resolve()));
  await database?.close();
});

it(`verifies a new account once and delivers invitation links without renderer token exposure (${mode})`, async () => {
  const email = `verification-${randomUUID()}@example.com`;
  const registration = await fetch(`${apiBase}/api/auth/register`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'verification password long enough' }),
  });
  expect(registration.status).toBe(202);
  const cookie = cookieHeader(registration);
  const pending = await registration.json() as { csrfToken: string; email: string; status: string };
  expect(pending).toEqual({ csrfToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u), email, status: 'verification_pending' });
  expect((await fetch(`${apiBase}/api/auth/me`, { headers: { Cookie: cookie } })).status).toBe(401);
  const beforeDelivery = await database.query<{ jobs: number; requests: number }>(
    `SELECT
       (SELECT count(*)::int FROM email_delivery_jobs WHERE kind = 'email_verification') AS jobs,
       (SELECT count(*)::int FROM email_verification_requests) AS requests`,
  );
  expect(beforeDelivery.rows[0]).toEqual({ jobs: 1, requests: 0 });

  await worker.runOnce();
  expect(deliveries[0]).toMatchObject({ kind: 'email_verification', email });
  const verificationToken = tokenFromDelivery(0, 'verificationUrl', '#email-verification=');
  const stored = await database.query<{ hash: string; raw_column_count: number }>(
    `SELECT encode(token_hash, 'hex') AS hash,
       (SELECT count(*)::int FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name IN ('email_verification_requests', 'email_delivery_jobs')
          AND column_name IN ('token', 'raw_token', 'email', 'url', 'payload', 'response_body')) AS raw_column_count
     FROM email_verification_requests ORDER BY created_at DESC LIMIT 1`,
  );
  expect(stored.rows[0].hash).toBe(hashEmailVerificationToken(verificationToken).toString('hex'));
  expect(stored.rows[0].raw_column_count).toBe(0);

  const pendingStatus = await fetch(`${apiBase}/api/auth/email-verification/status`, { headers: { Cookie: cookie } });
  expect(await pendingStatus.json()).toEqual({ email, status: 'pending' });
  expect((await fetch(`${apiBase}/api/auth/email-verification/status`)).status).toBe(401);
  expect((await fetch(`${apiBase}/api/auth/email-verification/resend`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': pending.csrfToken },
    body: '{}',
  })).status).toBe(403);
  expect((await fetch(`${apiBase}/api/auth/email-verification/resend`, {
    method: 'POST',
    headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
    body: '{}',
  })).status).toBe(403);
  const resent = await fetch(`${apiBase}/api/auth/email-verification/resend`, {
    method: 'POST',
    headers: {
      Cookie: cookie,
      Origin: origin,
      'Content-Type': 'application/json',
      'X-CSRF-Token': pending.csrfToken,
    },
    body: '{}',
  });
  expect(resent.status).toBe(202);
  expect(await resent.json()).toEqual({ ok: true });
  await worker.runOnce();
  const resentToken = tokenFromDelivery(1, 'verificationUrl', '#email-verification=');
  expect((await fetch(`${apiBase}/api/auth/email-verification/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: verificationToken }),
  })).status).toBe(403);
  expect((await fetch(`${apiBase}/api/auth/email-verification/complete`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: verificationToken }),
  })).status).toBe(410);

  const completion = () => fetch(`${apiBase}/api/auth/email-verification/complete`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: resentToken }),
  });
  const completed = await Promise.all([completion(), completion()]);
  expect(completed.map((response) => response.status).sort()).toEqual([204, 410]);
  expect((await fetch(`${apiBase}/api/auth/me`, { headers: { Cookie: cookie } })).status).toBe(200);
  const verifiedResend = await fetch(`${apiBase}/api/auth/email-verification/resend`, {
    method: 'POST',
    headers: {
      Cookie: cookie,
      Origin: origin,
      'Content-Type': 'application/json',
      'X-CSRF-Token': pending.csrfToken,
    },
    body: '{}',
  });
  expect(verifiedResend.status).toBe(202);
  expect(await verifiedResend.json()).toEqual({ ok: true });

  const me = await (await fetch(`${apiBase}/api/auth/me`, { headers: { Cookie: cookie } })).json() as {
    workspaces: Array<{ id: string }>;
  };
  const invitation = await fetch(`${apiBase}/api/workspaces/${me.workspaces[0].id}/invitations`, {
    method: 'POST',
    headers: {
      Cookie: cookie,
      Origin: origin,
      'Content-Type': 'application/json',
      'X-CSRF-Token': pending.csrfToken,
    },
    body: JSON.stringify({ email: `invite-${randomUUID()}@example.com`, role: 'member' }),
  });
  expect(invitation.status).toBe(201);
  const invitationBody = await invitation.json() as Record<string, unknown>;
  expect(invitationBody).toMatchObject({ deliveryStatus: 'pending' });
  expect(invitationBody).not.toHaveProperty('token');
  await worker.runOnce();
  expect(deliveries[2]).toMatchObject({ kind: 'workspace_invitation', role: 'member' });
  const invitationToken = tokenFromDelivery(2, 'invitationUrl', '#invite=');
  const invitationHash = await database.query<{ hash: string }>(
    'SELECT encode(token_hash, \'hex\') AS hash FROM workspace_invitations ORDER BY created_at DESC LIMIT 1',
  );
  expect(invitationHash.rows[0].hash).toBe(hashWorkspaceInvitationToken(invitationToken).toString('hex'));

  providerStatus = 503;
  const retryInvitation = await fetch(`${apiBase}/api/workspaces/${me.workspaces[0].id}/invitations`, {
    method: 'POST',
    headers: {
      Cookie: cookie,
      Origin: origin,
      'Content-Type': 'application/json',
      'X-CSRF-Token': pending.csrfToken,
    },
    body: JSON.stringify({ email: `retry-${randomUUID()}@example.com`, role: 'viewer' }),
  });
  expect(retryInvitation.status).toBe(201);
  const retryInvitationBody = await retryInvitation.json() as {
    deliveryStatus: string;
    invitation: { id: string };
  };
  expect(retryInvitationBody.deliveryStatus).toBe('pending');
  await worker.runOnce();
  const firstAttemptToken = tokenFromDelivery(3, 'invitationUrl', '#invite=');
  const retryState = await database.query<{ attempt_count: number; last_error_code: string; status: string }>(
    `SELECT attempt_count, last_error_code, status FROM email_delivery_jobs
     WHERE invitation_id = $1`,
    [retryInvitationBody.invitation.id],
  );
  expect(retryState.rows[0]).toEqual({ attempt_count: 1, last_error_code: 'provider_failed', status: 'retry' });
  providerStatus = 202;
  await database.query(
    `UPDATE email_delivery_jobs SET available_at = now() - interval '1 second'
     WHERE invitation_id = $1`,
    [retryInvitationBody.invitation.id],
  );
  await worker.runOnce();
  const secondAttemptToken = tokenFromDelivery(4, 'invitationUrl', '#invite=');
  expect(secondAttemptToken).not.toBe(firstAttemptToken);
  const retryHash = await database.query<{ hash: string }>(
    'SELECT encode(token_hash, \'hex\') AS hash FROM workspace_invitations WHERE id = $1',
    [retryInvitationBody.invitation.id],
  );
  expect(retryHash.rows[0].hash).toBe(hashWorkspaceInvitationToken(secondAttemptToken).toString('hex'));
  expect(retryHash.rows[0].hash).not.toBe(hashWorkspaceInvitationToken(firstAttemptToken).toString('hex'));

  const jobs = await database.query<{ secret_columns: number; statuses: string[] }>(
    `SELECT array_agg(status ORDER BY created_at)::text[] AS statuses,
       (SELECT count(*)::int FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'email_delivery_jobs'
          AND column_name IN ('email', 'token', 'url', 'payload', 'request_body', 'response_body')) AS secret_columns
     FROM email_delivery_jobs`,
  );
  expect(jobs.rows[0].statuses).toEqual(['delivered', 'delivered', 'delivered', 'delivered']);
  expect(jobs.rows[0].secret_columns).toBe(0);
});
