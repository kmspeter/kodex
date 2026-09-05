import type { PreparedEmailDelivery } from '@kodex/product-db';
import { ProductApiConfigurationError } from './config.js';

export interface EmailDeliveryConfig {
  bearerToken: string;
  deliveryUrl: string;
  leaseMs: number;
  maxAttempts: number;
  maxResponseBytes: number;
  pollMs: number;
  publicOrigin: string;
  retryBaseMs: number;
  timeoutMs: number;
  verificationTtlMs: number;
}

export interface EmailDelivery {
  send(input: PreparedEmailDelivery): Promise<void>;
}

function integer(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  const parsed = value?.trim() ? Number(value) : fallback;
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ProductApiConfigurationError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function exactOrigin(value: string, production: boolean): string {
  let url: URL;
  try { url = new URL(value); } catch {
    throw new ProductApiConfigurationError('AUTH_EMAIL_PUBLIC_ORIGIN must be an exact HTTP(S) origin');
  }
  if (
    !['http:', 'https:'].includes(url.protocol)
    || url.origin !== value
    || url.username
    || url.password
    || (production && url.protocol !== 'https:')
  ) throw new ProductApiConfigurationError('AUTH_EMAIL_PUBLIC_ORIGIN must be an exact secure origin');
  return url.origin;
}

function endpoint(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch {
    throw new ProductApiConfigurationError('AUTH_EMAIL_DELIVERY_URL must be an absolute HTTP(S) URL');
  }
  if (
    url.protocol !== 'https:'
    || url.username
    || url.password
    || url.hash
  ) throw new ProductApiConfigurationError('AUTH_EMAIL_DELIVERY_URL must be a secure absolute URL');
  return url.toString();
}

export function emailDeliveryConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): EmailDeliveryConfig | undefined {
  const enabled = env.AUTH_EMAIL_DELIVERY_ENABLED?.trim();
  if (!enabled || enabled === 'false' || enabled === '0') return undefined;
  if (!['true', '1'].includes(enabled)) {
    throw new ProductApiConfigurationError('AUTH_EMAIL_DELIVERY_ENABLED must be true or false');
  }
  const production = (env.PRODUCT_API_NODE_ENV ?? env.NODE_ENV) === 'production';
  const deliveryUrl = env.AUTH_EMAIL_DELIVERY_URL?.trim();
  const publicOrigin = env.AUTH_EMAIL_PUBLIC_ORIGIN?.trim();
  const bearerToken = env.AUTH_EMAIL_DELIVERY_BEARER_TOKEN?.trim();
  if (!deliveryUrl || !publicOrigin || !bearerToken) {
    throw new ProductApiConfigurationError('Enabled email delivery requires delivery URL, public origin, and bearer token');
  }
  if (bearerToken.length < 32 || bearerToken.length > 4_096 || /[\u0000-\u001f\u007f]/u.test(bearerToken)) {
    throw new ProductApiConfigurationError('AUTH_EMAIL_DELIVERY_BEARER_TOKEN must contain 32 to 4096 safe characters');
  }
  const timeoutMs = integer(env.AUTH_EMAIL_DELIVERY_TIMEOUT_MS, 5_000, 500, 30_000, 'AUTH_EMAIL_DELIVERY_TIMEOUT_MS');
  return {
    bearerToken,
    deliveryUrl: endpoint(deliveryUrl),
    leaseMs: integer(env.AUTH_EMAIL_DELIVERY_LEASE_SECONDS, 60, 30, 600, 'AUTH_EMAIL_DELIVERY_LEASE_SECONDS') * 1_000,
    maxAttempts: integer(env.AUTH_EMAIL_DELIVERY_MAX_ATTEMPTS, 4, 1, 10, 'AUTH_EMAIL_DELIVERY_MAX_ATTEMPTS'),
    maxResponseBytes: integer(env.AUTH_EMAIL_DELIVERY_MAX_RESPONSE_BYTES, 4_096, 0, 65_536, 'AUTH_EMAIL_DELIVERY_MAX_RESPONSE_BYTES'),
    pollMs: integer(env.AUTH_EMAIL_DELIVERY_POLL_SECONDS, 5, 1, 300, 'AUTH_EMAIL_DELIVERY_POLL_SECONDS') * 1_000,
    publicOrigin: exactOrigin(publicOrigin, production),
    retryBaseMs: integer(env.AUTH_EMAIL_DELIVERY_RETRY_BASE_SECONDS, 30, 1, 3_600, 'AUTH_EMAIL_DELIVERY_RETRY_BASE_SECONDS') * 1_000,
    timeoutMs,
    verificationTtlMs: integer(env.AUTH_EMAIL_VERIFICATION_TTL_MINUTES, 60, 15, 1_440, 'AUTH_EMAIL_VERIFICATION_TTL_MINUTES') * 60_000,
  };
}

async function consumeBoundedResponse(response: Response, maximumBytes: number): Promise<void> {
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > maximumBytes)) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error('Email delivery provider response exceeded its bound');
  }
  if (!response.body) return;
  const reader = response.body.getReader();
  let received = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) return;
      received += next.value.byteLength;
      if (received > maximumBytes) throw new Error('Email delivery provider response exceeded its bound');
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export class WebhookEmailDelivery implements EmailDelivery {
  constructor(
    private readonly config: EmailDeliveryConfig,
    private readonly fetchImplementation: typeof globalThis.fetch = globalThis.fetch,
  ) {}

  async send(input: PreparedEmailDelivery): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    timer.unref?.();
    try {
      const payload = input.kind === 'email_verification'
        ? {
          kind: input.kind,
          email: input.email,
          expiresAt: input.expiresAt.toISOString(),
          verificationUrl: `${this.config.publicOrigin}/#email-verification=${input.token}`,
        }
        : {
          kind: input.kind,
          email: input.email,
          expiresAt: input.expiresAt.toISOString(),
          invitationUrl: `${this.config.publicOrigin}/#invite=${input.token}`,
          role: input.role,
          workspaceName: input.workspaceName,
        };
      const response = await this.fetchImplementation(this.config.deliveryUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.bearerToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        redirect: 'error',
        signal: controller.signal,
      });
      await consumeBoundedResponse(response, this.config.maxResponseBytes);
      if (!response.ok) throw new Error('Email delivery provider rejected the request');
    } catch {
      throw new Error('Email delivery failed');
    } finally {
      clearTimeout(timer);
    }
  }
}
