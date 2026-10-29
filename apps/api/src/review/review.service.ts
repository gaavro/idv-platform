import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { AnalystAuth } from '../auth/guards';
import { recordAudit } from '../common/audit';
import { config } from '../config';
import { Db } from '../db/db.service';
import { VerificationStatus } from '../domain/types';
import { enqueueStatusWebhook } from '../jobs/job-queue';
import { MediaStorage } from '../storage/media-storage';
import { loadVerificationView } from '../verifications/verification-view';

export type AnalystDecision = 'approve' | 'reject' | 'request_resubmission';

const OUTCOMES: Record<AnalystDecision, { status: VerificationStatus; outcome: string }> = {
  approve: { status: 'approved', outcome: 'approved' },
  reject: { status: 'rejected', outcome: 'rejected' },
  request_resubmission: { status: 'resubmission_requested', outcome: 'resubmission_requested' },
};

/**
 * The analyst dashboard. Analysts are platform staff and see every company's queue.
 * TODO: restrict analysts to the companies they are assigned to.
 */
@Injectable()
export class ReviewService {
  constructor(
    private readonly db: Db,
    private readonly storage: MediaStorage,
  ) {}

  /** Suspicious cases first, then oldest first. */
  async queue(limit: number) {
    return this.db.withContext({ platform: true }, async (client) => {
      const { rows } = await client.query(
        `SELECT v.id, v.tenant_id, t.name AS tenant_name, v.journey, v.score, v.created_at,
                d.reason, coalesce((d.details->>'suspicious')::boolean, false) AS suspicious
         FROM verifications v
         JOIN tenants t ON t.id = v.tenant_id
         LEFT JOIN LATERAL (
           SELECT reason, details FROM decisions WHERE verification_id = v.id ORDER BY created_at DESC LIMIT 1
         ) d ON true
         WHERE v.status = 'in_review'
         ORDER BY suspicious DESC, v.created_at ASC
         LIMIT $1`,
        [limit],
      );
      return { items: rows };
    });
  }

  async detail(analyst: AnalystAuth, id: string) {
    return this.db.withContext({ platform: true }, async (client) => {
      const view = await loadVerificationView(client, id);
      if (!view) throw new NotFoundException();
      const {
        rows: [verification],
      } = await client.query(`SELECT tenant_id, capture_round, current_analysis_run FROM verifications WHERE id = $1`, [id]);
      const { rows: captures } = await client.query(
        `SELECT id, kind, round, mime_type, created_at FROM captures WHERE verification_id = $1 ORDER BY round DESC, created_at DESC`,
        [id],
      );
      const { rows: checks } = await client.query(
        `SELECT type, outcome, critical, score, provider, details FROM check_results
         WHERE verification_id = $1 AND analysis_run = $2 ORDER BY type`,
        [id, verification.current_analysis_run],
      );
      const { rows: decisions } = await client.query(
        `SELECT outcome, origin, reason, analyst_id, score, rules_version, details, created_at
         FROM decisions WHERE verification_id = $1 ORDER BY created_at DESC`,
        [id],
      );
      await recordAudit(client, {
        tenantId: verification.tenant_id,
        verificationId: id,
        actorType: 'analyst',
        actorId: analyst.analystId,
        action: 'evidence.viewed',
      });
      return { ...view, checks, captures, decisions };
    });
  }

  /** TODO: watermark images with the analyst's name before serving them. */
  async media(analyst: AnalystAuth, captureId: string) {
    const capture = await this.db.withContext({ platform: true }, async (client) => {
      const {
        rows: [row],
      } = await client.query(`SELECT tenant_id, verification_id, storage_key, mime_type FROM captures WHERE id = $1`, [
        captureId,
      ]);
      if (!row) throw new NotFoundException();
      await recordAudit(client, {
        tenantId: row.tenant_id,
        verificationId: row.verification_id,
        actorType: 'analyst',
        actorId: analyst.analystId,
        action: 'media.viewed',
        details: { capture_id: captureId },
      });
      return row;
    });
    return { mimeType: capture.mime_type as string, data: await this.storage.get(capture.storage_key) };
  }

  async decide(analyst: AnalystAuth, id: string, decision: AnalystDecision, reason: string) {
    const { status, outcome } = OUTCOMES[decision];
    return this.db.withContext({ platform: true }, async (client) => {
      const {
        rows: [verification],
      } = await client.query(`SELECT tenant_id, status, score FROM verifications WHERE id = $1 FOR UPDATE`, [id]);
      if (!verification) throw new NotFoundException();
      if (verification.status !== 'in_review') {
        throw new ConflictException({ message: 'Verification is not awaiting review', status: verification.status });
      }

      if (decision === 'request_resubmission') {
        // New captures start a new round and the end user gets a fresh deadline.
        await client.query(
          `UPDATE verifications
           SET status = $2, capture_round = capture_round + 1,
               expires_at = now() + make_interval(hours => $3), updated_at = now()
           WHERE id = $1`,
          [id, status, config.verificationTtlHours],
        );
      } else {
        await client.query(`UPDATE verifications SET status = $2, updated_at = now() WHERE id = $1`, [id, status]);
      }
      await client.query(
        `INSERT INTO decisions (tenant_id, verification_id, outcome, origin, reason, analyst_id, score)
         VALUES ($1, $2, $3, 'manual', $4, $5, $6)`,
        [verification.tenant_id, id, outcome, reason, analyst.analystId, verification.score],
      );
      await recordAudit(client, {
        tenantId: verification.tenant_id,
        verificationId: id,
        actorType: 'analyst',
        actorId: analyst.analystId,
        action: 'verification.decided',
        details: { decision, reason },
      });
      await enqueueStatusWebhook(client, verification.tenant_id, id, status);
      return { id, status };
    });
  }
}
