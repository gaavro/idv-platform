import { Queryable } from '../db/db.service';

export const ANALYZE_JOB = 'analyze_verification';
export const WEBHOOK_JOB = 'deliver_webhook';

export interface AnalyzePayload {
  tenantId: string;
  verificationId: string;
}

export interface WebhookPayload {
  tenantId: string;
  verificationId: string;
  status: string;
  occurredAt: string;
}

/**
 * Postgres-backed queue: enqueueing inside the caller's transaction means a job exists
 * only if the change that triggered it was committed. Swap for SQS when volume requires.
 */
export async function enqueueJob(client: Queryable, type: string, payload: object, maxAttempts = 5) {
  await client.query(`INSERT INTO jobs (type, payload, max_attempts) VALUES ($1, $2, $3)`, [
    type,
    JSON.stringify(payload),
    maxAttempts,
  ]);
}

export async function enqueueStatusWebhook(client: Queryable, tenantId: string, verificationId: string, status: string) {
  const payload: WebhookPayload = { tenantId, verificationId, status, occurredAt: new Date().toISOString() };
  await enqueueJob(client, WEBHOOK_JOB, payload, 10);
}
