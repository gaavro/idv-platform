import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { TenantAuth } from '../auth/guards';
import { generateToken, hashToken } from '../auth/tokens';
import { recordAudit } from '../common/audit';
import { config } from '../config';
import { Db, Queryable } from '../db/db.service';
import { CAPTURABLE_STATUSES, Journey } from '../domain/types';
import { enqueueStatusWebhook } from '../jobs/job-queue';
import { loadVerificationView } from './verification-view';

export interface CreateVerificationInput {
  external_user_id: string;
  journey: Journey;
  cpf?: string;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class VerificationsService {
  constructor(private readonly db: Db) {}

  async create(auth: TenantAuth, input: CreateVerificationInput, idempotencyKey: string | null) {
    return this.db.withContext({ tenantId: auth.tenantId }, async (client) => {
      if (idempotencyKey) {
        const { rows } = await client.query(
          `SELECT id FROM verifications WHERE tenant_id = $1 AND idempotency_key = $2`,
          [auth.tenantId, idempotencyKey],
        );
        if (rows[0]) return this.issueSession(client, auth.tenantId, rows[0].id);
      }

      const {
        rows: [created],
      } = await client.query(
        `INSERT INTO verifications
           (tenant_id, environment, external_user_id, journey, cpf, status, metadata, idempotency_key, expires_at)
         VALUES ($1, $2, $3, $4, $5, 'created', $6, $7, now() + make_interval(hours => $8))
         RETURNING id`,
        [
          auth.tenantId,
          auth.environment,
          input.external_user_id,
          input.journey,
          input.cpf ?? null,
          JSON.stringify(input.metadata ?? {}),
          idempotencyKey,
          config.verificationTtlHours,
        ],
      );
      await recordAudit(client, {
        tenantId: auth.tenantId,
        verificationId: created.id,
        actorType: 'api_key',
        actorId: auth.apiKeyId,
        action: 'verification.created',
        details: { journey: input.journey },
      });
      return this.issueSession(client, auth.tenantId, created.id);
    });
  }

  async get(auth: TenantAuth, id: string) {
    const view = await this.db.withContext({ tenantId: auth.tenantId }, (client) => loadVerificationView(client, id));
    if (!view) throw new NotFoundException();
    return view;
  }

  async cancel(auth: TenantAuth, id: string) {
    return this.db.withContext({ tenantId: auth.tenantId }, async (client) => {
      await this.lockCapturable(client, id);
      await client.query(`UPDATE verifications SET status = 'cancelled', updated_at = now() WHERE id = $1`, [id]);
      await recordAudit(client, {
        tenantId: auth.tenantId,
        verificationId: id,
        actorType: 'api_key',
        actorId: auth.apiKeyId,
        action: 'verification.cancelled',
      });
      await enqueueStatusWebhook(client, auth.tenantId, id, 'cancelled');
      return { id, status: 'cancelled' };
    });
  }

  /** A fresh SDK session, e.g. after an analyst asks for new captures. */
  async newSession(auth: TenantAuth, id: string) {
    return this.db.withContext({ tenantId: auth.tenantId }, async (client) => {
      await this.lockCapturable(client, id);
      return this.issueSession(client, auth.tenantId, id);
    });
  }

  private async lockCapturable(client: Queryable, id: string) {
    const {
      rows: [verification],
    } = await client.query(`SELECT status FROM verifications WHERE id = $1 FOR UPDATE`, [id]);
    if (!verification) throw new NotFoundException();
    if (!CAPTURABLE_STATUSES.includes(verification.status)) {
      throw new ConflictException({ message: 'Verification is no longer open', status: verification.status });
    }
  }

  private async issueSession(client: Queryable, tenantId: string, verificationId: string) {
    const token = generateToken('ses');
    const {
      rows: [session],
    } = await client.query(
      `INSERT INTO verification_sessions (token_hash, verification_id, tenant_id, expires_at)
       VALUES ($1, $2, $3, now() + make_interval(mins => $4))
       RETURNING expires_at`,
      [hashToken(token), verificationId, tenantId, config.sessionTtlMinutes],
    );
    const {
      rows: [verification],
    } = await client.query(`SELECT status FROM verifications WHERE id = $1`, [verificationId]);
    return {
      id: verificationId,
      status: verification.status,
      session_token: token,
      session_expires_at: session.expires_at,
    };
  }
}
