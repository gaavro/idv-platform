import { Injectable, OnModuleInit } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { Db } from '../db/db.service';
import { WEBHOOK_JOB, WebhookPayload } from '../jobs/job-queue';
import { JobWorker } from '../jobs/job-worker';

/** Partners verify `X-IDV-Signature: t=<unix seconds>,v1=<hex>` by recomputing this over the raw body. */
export function signWebhook(secret: string, timestamp: number, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

@Injectable()
export class WebhookService implements OnModuleInit {
  constructor(
    private readonly db: Db,
    private readonly worker: JobWorker,
  ) {}

  onModuleInit() {
    this.worker.register(WEBHOOK_JOB, {
      run: (payload: WebhookPayload) => this.deliver(payload),
      // 30s doubling up to 6h; 10 attempts cover roughly 8.5 hours.
      backoffSeconds: (attempt) => Math.min(30 * 2 ** (attempt - 1), 6 * 3600),
    });
  }

  /**
   * The body carries only the new status; partners fetch details with GET /v1/verifications/:id,
   * so personal data never travels in webhooks.
   */
  async deliver(payload: WebhookPayload) {
    const tenant = await this.db.withContext({ tenantId: payload.tenantId }, async (client) => {
      const { rows } = await client.query(`SELECT webhook_url, webhook_secret FROM tenants WHERE id = $1`, [
        payload.tenantId,
      ]);
      return rows[0];
    });
    if (!tenant?.webhook_url) return;

    const body = JSON.stringify({
      event: 'verification.status_changed',
      verification_id: payload.verificationId,
      status: payload.status,
      occurred_at: payload.occurredAt,
    });
    const timestamp = Math.floor(Date.now() / 1000);
    const response = await fetch(tenant.webhook_url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-idv-signature': `t=${timestamp},v1=${signWebhook(tenant.webhook_secret, timestamp, body)}`,
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Webhook endpoint responded ${response.status}`);
  }
}
