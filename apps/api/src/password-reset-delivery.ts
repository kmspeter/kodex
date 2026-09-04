import { ProductApiConfigurationError } from './config.js';
import type { PasswordResetDelivery } from '@kodex/product-db';

export interface PasswordResetDeliveryConfig {
  bearerToken: string;
  deliveryUrl: string;
  enabled: boolean;
  publicOrigin: string;
  timeoutMs: number;
  ttlMs: number;
}

function integer(value: string | undefined, fallback: number, minimum: number, maximum: number, name: string): number {
  const parsed = value?.trim() ? Number(value) : fallback;
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ProductApiConfigurationError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function exactOrigin(value: string, production: boolean): string {
  let url: URL;
  try { url = new URL(value); } catch {
    throw new ProductApiConfigurationError('AUTH_PASSWORD_RESET_PUBLIC_ORIGIN must be an exact HTTP(S) origin');
  }
  if (
    !['http:', 'https:'].includes(url.protocol)
    || url.origin !== value
    || url.username
    || url.password
    || (production && url.protocol !== 'https:')
  ) throw new ProductApiConfigurationError('AUTH_PASSWORD_RESET_PUBLIC_ORIGIN must be an exact secure origin');
  return url.origin;
}

function endpoint(value: string, production: boolean): string {
  let url: URL;
  try { url = new URL(value); } catch {
    throw new ProductApiConfigurationError('AUTH_PASSWORD_RESET_DELIVERY_URL must be an absolute HTTP(S) URL');
  }
  if (
    !['http:', 'https:'].includes(url.protocol)
    || url.username
    || url.password
    || url.hash
    || (production && url.protocol !== 'https:')
  ) throw new ProductApiConfigurationError('AUTH_PASSWORD_RESET_DELIVERY_URL must be a secure absolute URL');
  return url.toString();
}

export function passwordResetDeliveryConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): PasswordResetDeliveryConfig | undefined {
  const enabledValue = env.AUTH_PASSWORD_RESET_ENABLED?.trim();
  if (!enabledValue || enabledValue === 'false' || enabledValue === '0') return undefined;
  if (!['true', '1'].includes(enabledValue)) {
    throw new ProductApiConfigurationError('AUTH_PASSWORD_RESET_ENABLED must be true or false');
  }
  const production = (env.PRODUCT_API_NODE_ENV ?? env.NODE_ENV) === 'production';
  const deliveryValue = env.AUTH_PASSWORD_RESET_DELIVERY_URL?.trim();
  const originValue = env.AUTH_PASSWORD_RESET_PUBLIC_ORIGIN?.trim();
  const bearerToken = env.AUTH_PASSWORD_RESET_DELIVERY_BEARER_TOKEN?.trim();
  if (!deliveryValue || !originValue || !bearerToken) {
    throw new ProductApiConfigurationError('Enabled password reset requires delivery URL, public origin, and bearer token');
  }
  if (bearerToken.length < 32 || bearerToken.length > 4_096 || /[\r\n]/u.test(bearerToken)) {
    throw new ProductApiConfigurationError('AUTH_PASSWORD_RESET_DELIVERY_BEARER_TOKEN must contain 32 to 4096 safe characters');
  }
  return {
    enabled: true,
    deliveryUrl: endpoint(deliveryValue, production),
    publicOrigin: exactOrigin(originValue, production),
    bearerToken,
    timeoutMs: integer(env.AUTH_PASSWORD_RESET_DELIVERY_TIMEOUT_MS, 5_000, 500, 30_000, 'AUTH_PASSWORD_RESET_DELIVERY_TIMEOUT_MS'),
    ttlMs: integer(env.AUTH_PASSWORD_RESET_TTL_MINUTES, 60, 15, 1_440, 'AUTH_PASSWORD_RESET_TTL_MINUTES') * 60_000,
  };
}

export class WebhookPasswordResetDelivery implements PasswordResetDelivery {
  constructor(
    private readonly config: PasswordResetDeliveryConfig,
    private readonly fetchImplementation: typeof globalThis.fetch = globalThis.fetch,
  ) {}

  async send(input: { email: string; expiresAt: Date; token: string }): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    timer.unref?.();
    try {
      const response = await this.fetchImplementation(this.config.deliveryUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.bearerToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          kind: 'password_reset',
          email: input.email,
          expiresAt: input.expiresAt.toISOString(),
          resetUrl: `${this.config.publicOrigin}/#password-reset=${input.token}`,
        }),
        redirect: 'error',
        signal: controller.signal,
      });
      await response.body?.cancel().catch(() => undefined);
      if (!response.ok) throw new Error('delivery rejected');
    } catch {
      throw new Error('Password reset delivery failed');
    } finally {
      clearTimeout(timer);
    }
  }
}
