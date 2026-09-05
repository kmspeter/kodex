import { randomUUID } from 'node:crypto';
import type { EmailDeliveryRepository } from '@kodex/product-db';
import type { EmailDelivery, EmailDeliveryConfig } from './email-delivery.js';

export interface EmailDeliveryLogEvent {
  attempt: number;
  category: 'email_delivery';
  kind: 'email_verification' | 'workspace_invitation';
  outcome: 'delivered' | 'retry' | 'failed';
}

export class EmailDeliveryWorker {
  readonly #workerId = randomUUID();
  #running: Promise<void> | undefined;
  #stopped = false;
  #timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly repository: EmailDeliveryRepository,
    private readonly delivery: EmailDelivery,
    private readonly config: EmailDeliveryConfig,
    private readonly log: (event: EmailDeliveryLogEvent) => void = () => undefined,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  start(): void {
    if (this.#stopped || this.#timer) return;
    this.#timer = setInterval(() => void this.runOnce(), this.config.pollMs);
    this.#timer.unref();
    void this.runOnce();
  }

  runOnce(): Promise<void> {
    if (this.#stopped || this.#running) return this.#running ?? Promise.resolve();
    const operation = this.#perform().finally(() => {
      if (this.#running === operation) this.#running = undefined;
    });
    this.#running = operation;
    return operation;
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#running;
  }

  async #perform(): Promise<void> {
    const now = this.clock();
    const job = await this.repository.claim(
      this.#workerId,
      now,
      new Date(now.getTime() + this.config.leaseMs),
    );
    if (!job) return;
    try {
      const prepared = await this.repository.prepare(
        job,
        this.#workerId,
        now,
        new Date(now.getTime() + this.config.verificationTtlMs),
      );
      if (!prepared) return;
      await this.delivery.send(prepared);
      await this.repository.succeed(job.id, this.#workerId, this.clock());
      this.#emit({ category: 'email_delivery', kind: job.kind, outcome: 'delivered', attempt: job.attemptCount });
    } catch {
      const failedAt = this.clock();
      const exponent = Math.min(job.attemptCount - 1, 10);
      const retryAt = new Date(failedAt.getTime() + this.config.retryBaseMs * (2 ** exponent));
      const terminal = await this.repository.fail(
        job,
        this.#workerId,
        failedAt,
        retryAt,
        this.config.maxAttempts,
      );
      this.#emit({
        category: 'email_delivery',
        kind: job.kind,
        outcome: terminal ? 'failed' : 'retry',
        attempt: job.attemptCount,
      });
    }
  }

  #emit(event: EmailDeliveryLogEvent): void {
    try { this.log(event); } catch { /* Delivery must not depend on logging. */ }
  }
}
