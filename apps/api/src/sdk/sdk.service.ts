import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { SessionAuth } from '../auth/guards';
import { recordAudit } from '../common/audit';
import { Db, Queryable } from '../db/db.service';
import { CAPTURABLE_STATUSES, CaptureKind, REQUIRED_CAPTURES } from '../domain/types';
import { ANALYZE_JOB, AnalyzePayload, enqueueJob, enqueueStatusWebhook } from '../jobs/job-queue';
import { LivenessProvider, sandboxScenario } from '../providers/providers';
import { checkCaptureQuality } from '../quality/capture-quality';
import { MediaStorage } from '../storage/media-storage';

/** Endpoints the capture SDK calls from the end user's device. */
@Injectable()
export class SdkService {
  constructor(
    private readonly db: Db,
    private readonly storage: MediaStorage,
    private readonly liveness: LivenessProvider,
  ) {}

  async getSession(session: SessionAuth) {
    return this.db.withContext({ tenantId: session.tenantId }, async (client) => {
      const verification = await this.loadVerification(client, session.verificationId);
      return {
        verification_id: verification.id,
        status: verification.status,
        required_captures: REQUIRED_CAPTURES,
        optional_captures: ['document_back'],
        captured: await this.capturedKinds(client, verification.id, verification.capture_round),
      };
    });
  }

  async startLiveness(session: SessionAuth) {
    const verification = await this.db.withContext({ tenantId: session.tenantId }, (client) =>
      this.loadVerification(client, session.verificationId, { capturable: true }),
    );
    const liveness = await this.liveness.createSession({
      verificationId: verification.id,
      scenario: sandboxScenario(verification),
    });
    return { provider: this.liveness.name, session_id: liveness.sessionId, client_config: liveness.clientConfig };
  }

  async uploadCapture(session: SessionAuth, kind: CaptureKind, image: Buffer, livenessSessionId?: string) {
    if (kind === 'selfie' && !livenessSessionId) {
      throw new BadRequestException('liveness_session_id is required for selfie captures');
    }
    const quality = checkCaptureQuality(image);
    if (quality.issues.length) throw new UnprocessableEntityException({ retry: true, issues: quality.issues });

    return this.db.withContext({ tenantId: session.tenantId }, async (client) => {
      const verification = await this.loadVerification(client, session.verificationId, { capturable: true });
      const captureId = randomUUID();
      const storageKey = `${session.tenantId}/${verification.id}/${captureId}`;
      // Written before commit: a rolled-back transaction can leave an orphan file, never a row without a file.
      await this.storage.put(storageKey, image);
      await client.query(
        `INSERT INTO captures
           (id, tenant_id, verification_id, round, kind, storage_key, mime_type, size_bytes, sha256, liveness_session_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          captureId,
          session.tenantId,
          verification.id,
          verification.capture_round,
          kind,
          storageKey,
          quality.mimeType,
          image.length,
          createHash('sha256').update(image).digest('hex'),
          kind === 'selfie' ? livenessSessionId : null,
        ],
      );
      if (verification.status !== 'capturing') {
        await client.query(`UPDATE verifications SET status = 'capturing', updated_at = now() WHERE id = $1`, [
          verification.id,
        ]);
      }
      await recordAudit(client, {
        tenantId: session.tenantId,
        verificationId: verification.id,
        actorType: 'end_user',
        action: 'capture.uploaded',
        details: { kind, capture_id: captureId },
      });
      return { capture_id: captureId, kind };
    });
  }

  async submit(session: SessionAuth) {
    return this.db.withContext({ tenantId: session.tenantId }, async (client) => {
      const verification = await this.loadVerification(client, session.verificationId, { capturable: true });
      const captured = await this.capturedKinds(client, verification.id, verification.capture_round);
      const missing = REQUIRED_CAPTURES.filter((kind) => !captured.includes(kind));
      if (missing.length) throw new UnprocessableEntityException({ message: 'Missing captures', missing });

      await client.query(`UPDATE verifications SET status = 'analyzing', updated_at = now() WHERE id = $1`, [
        verification.id,
      ]);
      const payload: AnalyzePayload = { tenantId: session.tenantId, verificationId: verification.id };
      await enqueueJob(client, ANALYZE_JOB, payload);
      await recordAudit(client, {
        tenantId: session.tenantId,
        verificationId: verification.id,
        actorType: 'end_user',
        action: 'verification.submitted',
      });
      await enqueueStatusWebhook(client, session.tenantId, verification.id, 'analyzing');
      return { status: 'analyzing' };
    });
  }

  private async loadVerification(client: Queryable, id: string, opts: { capturable?: boolean } = {}) {
    const {
      rows: [verification],
    } = await client.query(
      `SELECT id, status, environment, metadata, capture_round, expires_at <= now() AS expired
       FROM verifications WHERE id = $1 FOR UPDATE`,
      [id],
    );
    if (!verification) throw new NotFoundException();
    if (opts.capturable && (!CAPTURABLE_STATUSES.includes(verification.status) || verification.expired)) {
      throw new ConflictException({ message: 'Verification is not accepting captures', status: verification.status });
    }
    return verification;
  }

  private async capturedKinds(client: Queryable, verificationId: string, round: number): Promise<CaptureKind[]> {
    const { rows } = await client.query(
      `SELECT DISTINCT kind FROM captures WHERE verification_id = $1 AND round = $2 ORDER BY kind`,
      [verificationId, round],
    );
    return rows.map((row) => row.kind);
  }
}
