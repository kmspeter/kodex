import type {
  EmailDeliveryJob,
  EmailDeliveryRepository,
  PreparedEmailDelivery,
} from '../../packages/product-db/src/email-delivery-repository.js';
import {
  emailDeliveryConfigFromEnv,
  WebhookEmailDelivery,
  type EmailDeliveryConfig,
} from '../../apps/api/src/email-delivery.js';
import { EmailDeliveryWorker, type EmailDeliveryLogEvent } from '../../apps/api/src/email-delivery-worker.js';
import { describe, expect, it, vi } from 'vitest';

const config: EmailDeliveryConfig = {
  bearerToken: 'delivery-bearer'.padEnd(32, 'x'),
  deliveryUrl: 'https://mailer.example/deliver',
  leaseMs: 30_000,
  maxAttempts: 2,
  maxResponseBytes: 4,
  pollMs: 60_000,
  publicOrigin: 'https://kodex.example',
  retryBaseMs: 1_000,
  timeoutMs: 5_000,
  verificationTtlMs: 60 * 60_000,
};

describe('email delivery boundary', () => {
  it('is opt-in and rejects insecure production endpoints and weak bearer secrets', () => {
    expect(emailDeliveryConfigFromEnv({})).toBeUndefined();
    expect(() => emailDeliveryConfigFromEnv({
      AUTH_EMAIL_DELIVERY_ENABLED: 'true',
      AUTH_EMAIL_DELIVERY_URL: 'http://mailer.example/deliver',
      AUTH_EMAIL_PUBLIC_ORIGIN: 'https://kodex.example',
      AUTH_EMAIL_DELIVERY_BEARER_TOKEN: 'x'.repeat(32),
    })).toThrow('secure absolute URL');
    expect(() => emailDeliveryConfigFromEnv({
      AUTH_EMAIL_DELIVERY_ENABLED: 'true',
      AUTH_EMAIL_DELIVERY_URL: 'https://mailer.example/deliver',
      AUTH_EMAIL_PUBLIC_ORIGIN: 'https://kodex.example',
      AUTH_EMAIL_DELIVERY_BEARER_TOKEN: 'weak',
    })).toThrow('32 to 4096');
  });

  it('uses a fragment-only URL, server bearer, redirect refusal, timeout signal, and response bound', async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.redirect).toBe('error');
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${config.bearerToken}`);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.verificationUrl).toBe(`https://kodex.example/#email-verification=${'A'.repeat(43)}`);
      expect(String(body.verificationUrl)).not.toContain('?');
      return new Response('12345', { status: 202 });
    });
    const delivery = new WebhookEmailDelivery(config, fetch as typeof globalThis.fetch);
    await expect(delivery.send({
      kind: 'email_verification',
      email: 'person@example.com',
      expiresAt: new Date('2026-09-05T12:00:00.000Z'),
      token: 'A'.repeat(43),
    })).rejects.toThrow('Email delivery failed');
  });

  it('records only fixed aggregate retry state in worker logs', async () => {
    const job: EmailDeliveryJob = { id: 'job-id', kind: 'workspace_invitation', attemptCount: 1 };
    const prepared: PreparedEmailDelivery = {
      kind: 'workspace_invitation',
      email: 'private@example.com',
      expiresAt: new Date('2026-09-05T12:00:00.000Z'),
      role: 'member',
      token: 'S'.repeat(43),
      workspaceName: 'Secret Workspace',
    };
    const repository: EmailDeliveryRepository = {
      claim: vi.fn()
        .mockResolvedValueOnce(job)
        .mockResolvedValueOnce({ ...job, attemptCount: 2 }),
      prepare: vi.fn(async () => prepared),
      succeed: vi.fn(async () => undefined),
      fail: vi.fn()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true),
    };
    const events: EmailDeliveryLogEvent[] = [];
    const worker = new EmailDeliveryWorker(repository, {
      send: vi.fn(async () => { throw new Error('provider rejected private@example.com'); }),
    }, config, (event) => events.push(event), () => new Date('2026-09-05T10:00:00.000Z'));
    await worker.runOnce();
    await worker.runOnce();
    expect(repository.fail).toHaveBeenCalled();
    expect(events).toEqual([
      { attempt: 1, category: 'email_delivery', kind: 'workspace_invitation', outcome: 'retry' },
      { attempt: 2, category: 'email_delivery', kind: 'workspace_invitation', outcome: 'failed' },
    ]);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(prepared.email);
    expect(serialized).not.toContain(prepared.token);
    expect(serialized).not.toContain(prepared.workspaceName);
  });
});
