import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { normalizeCpf } from '../checks/cpf';
import { checkDocumentConsistency } from '../checks/document-consistency';
import { recordAudit } from '../common/audit';
import { Db } from '../db/db.service';
import { decide, DEFAULT_POLICY } from '../decision/decision-engine';
import { allFieldsMissing, CheckResult, CheckType, VerificationStatus } from '../domain/types';
import { ANALYZE_JOB, AnalyzePayload, enqueueStatusWebhook } from '../jobs/job-queue';
import { JobWorker } from '../jobs/job-worker';
import {
  CpfProvider,
  DocumentAnalysis,
  DocumentProvider,
  FaceMatchProvider,
  LivenessProvider,
  ProviderContext,
  sandboxScenario,
} from '../providers/providers';
import { MediaStorage } from '../storage/media-storage';

const PROVIDER_ATTEMPTS = 3;
const RETRY_DELAY_MS = 200;

const STATUS_BY_OUTCOME: Record<string, VerificationStatus> = {
  approved: 'approved',
  manual_review: 'in_review',
  technical_error: 'technical_error',
};

/** Runs every check on a submitted verification and applies the automatic decision. */
@Injectable()
export class AnalysisService implements OnModuleInit {
  private readonly logger = new Logger(AnalysisService.name);

  constructor(
    private readonly db: Db,
    private readonly worker: JobWorker,
    private readonly storage: MediaStorage,
    private readonly liveness: LivenessProvider,
    private readonly documents: DocumentProvider,
    private readonly faceMatch: FaceMatchProvider,
    private readonly cpf: CpfProvider,
  ) {}

  onModuleInit() {
    this.worker.register(ANALYZE_JOB, {
      run: (payload: AnalyzePayload) => this.analyze(payload.tenantId, payload.verificationId),
      onExhausted: (payload: AnalyzePayload, error) =>
        this.markTechnicalError(payload.tenantId, payload.verificationId, `analysis_failed:${error.message}`),
    });
  }

  async analyze(tenantId: string, verificationId: string) {
    const loaded = await this.db.withContext({ tenantId }, async (client) => {
      const {
        rows: [verification],
      } = await client.query(
        `SELECT v.id, v.environment, v.external_user_id, v.cpf, v.metadata, v.status, v.capture_round,
                t.auto_approve_threshold
         FROM verifications v JOIN tenants t ON t.id = v.tenant_id WHERE v.id = $1`,
        [verificationId],
      );
      if (!verification) return null;
      const { rows: captures } = await client.query(
        `SELECT DISTINCT ON (kind) kind, storage_key, sha256, liveness_session_id
         FROM captures WHERE verification_id = $1 AND round = $2 ORDER BY kind, created_at DESC`,
        [verificationId, verification.capture_round],
      );
      return { verification, captures };
    });
    // Cancelled or already analyzed while the job waited.
    if (!loaded || loaded.verification.status !== 'analyzing') return;

    const { verification, captures } = loaded;
    const capture = (kind: string) => captures.find((c) => c.kind === kind);
    const selfie = capture('selfie');
    const front = capture('document_front');
    const back = capture('document_back');
    if (!selfie || !front) throw new Error('Submitted verification is missing required captures');

    const [selfieImage, frontImage, backImage] = await Promise.all([
      this.storage.get(selfie.storage_key),
      this.storage.get(front.storage_key),
      back ? this.storage.get(back.storage_key) : Promise.resolve(null),
    ]);
    const ctx: ProviderContext = { verificationId, scenario: sandboxScenario(verification) };

    const [liveness, document, faceMatch] = await Promise.all([
      withRetry('liveness', this.liveness.name, () => this.liveness.getResult(ctx, selfie.liveness_session_id)),
      this.analyzeDocument(ctx, frontImage, backImage),
      withRetry('face_match', this.faceMatch.name, () => this.faceMatch.compare(ctx, selfieImage, frontImage)),
    ]);

    const documentFailed = document.results.some((r) => r.outcome === 'technical_error');
    const consistency = documentFailed
      ? technicalError('document_consistency', 'internal', 'document_analysis_unavailable')
      : checkDocumentConsistency(document.fields, verification.cpf);
    const cpfValidation = await this.validateCpf(ctx, document, verification.cpf, documentFailed);
    const reuse = await this.checkCaptureReuse(tenantId, verification, [selfie.sha256, front.sha256, back?.sha256]);

    const results = [liveness, ...document.results, consistency, faceMatch, cpfValidation, reuse];
    const decision = decide(results, { ...DEFAULT_POLICY, threshold: verification.auto_approve_threshold });
    const status = STATUS_BY_OUTCOME[decision.outcome];
    const analysisRun = randomUUID();

    await this.db.withContext({ tenantId }, async (client) => {
      const updated = await client.query(
        `UPDATE verifications SET status = $2, score = $3, current_analysis_run = $4, updated_at = now()
         WHERE id = $1 AND status = 'analyzing'`,
        [verificationId, status, decision.score, analysisRun],
      );
      if (!updated.rowCount) return;

      for (const r of results) {
        await client.query(
          `INSERT INTO check_results
             (tenant_id, verification_id, analysis_run, type, outcome, critical, score, provider, details)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [tenantId, verificationId, analysisRun, r.type, r.outcome, r.critical, r.score, r.provider, JSON.stringify(r.details)],
        );
      }
      await client.query(
        `INSERT INTO extracted_data (verification_id, tenant_id, document_type, fields)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (verification_id) DO UPDATE
           SET document_type = excluded.document_type, fields = excluded.fields, updated_at = now()`,
        [verificationId, tenantId, document.documentType, JSON.stringify(document.fields)],
      );
      await client.query(
        `INSERT INTO decisions (tenant_id, verification_id, outcome, origin, reason, score, rules_version, details)
         VALUES ($1, $2, $3, 'automatic', $4, $5, $6, $7)`,
        [
          tenantId,
          verificationId,
          decision.outcome,
          decision.reasons.join(';'),
          decision.score,
          decision.rulesVersion,
          JSON.stringify({ suspicious: decision.suspicious, reasons: decision.reasons }),
        ],
      );
      await recordAudit(client, {
        tenantId,
        verificationId,
        actorType: 'system',
        action: 'verification.analyzed',
        details: { outcome: decision.outcome, score: decision.score, reasons: decision.reasons },
      });
      await enqueueStatusWebhook(client, tenantId, verificationId, status);
    });
  }

  private async analyzeDocument(ctx: ProviderContext, front: Buffer, back: Buffer | null): Promise<DocumentAnalysis> {
    try {
      return await retry(() => this.documents.analyze(ctx, front, back));
    } catch (err) {
      const reason = errorMessage(err);
      return {
        documentType: null,
        fields: allFieldsMissing('document_analysis_unavailable'),
        results: (['document_type', 'data_extraction', 'document_tampering'] as const).map((type) =>
          technicalError(type, this.documents.name, reason),
        ),
      };
    }
  }

  private async validateCpf(
    ctx: ProviderContext,
    document: DocumentAnalysis,
    partnerCpf: string | null,
    documentFailed: boolean,
  ): Promise<CheckResult> {
    const documentCpf = document.fields.cpf.value ? normalizeCpf(document.fields.cpf.value) : null;
    const cpf = documentCpf ?? partnerCpf;
    if (!cpf) {
      return documentFailed
        ? technicalError('cpf_validation', 'internal', 'document_analysis_unavailable')
        : { type: 'cpf_validation', outcome: 'inconclusive', score: null, critical: false, provider: 'internal', details: { reason: 'no_cpf_available' } };
    }
    return withRetry('cpf_validation', this.cpf.name, () =>
      this.cpf.validate(ctx, {
        cpf,
        fullName: document.fields.full_name.value,
        birthDate: document.fields.birth_date.value,
      }),
    );
  }

  /**
   * Flags images already used by another user of the same company. Exact hashes only for now;
   * perceptual hashes and face embeddings will come from the image analysis service.
   */
  private async checkCaptureReuse(
    tenantId: string,
    verification: { id: string; external_user_id: string },
    hashes: (string | undefined)[],
  ): Promise<CheckResult> {
    const { rows } = await this.db.withContext({ tenantId }, (client) =>
      client.query(
        `SELECT DISTINCT c.verification_id FROM captures c JOIN verifications v ON v.id = c.verification_id
         WHERE c.sha256 = ANY($1) AND c.verification_id <> $2 AND v.external_user_id <> $3`,
        [hashes.filter(Boolean), verification.id, verification.external_user_id],
      ),
    );
    const reusedIn = rows.map((row) => row.verification_id);
    return reusedIn.length
      ? { type: 'capture_reuse', outcome: 'fail', score: 0, critical: true, provider: 'internal', details: { reused_in: reusedIn } }
      : { type: 'capture_reuse', outcome: 'pass', score: 100, critical: false, provider: 'internal', details: {} };
  }

  private async markTechnicalError(tenantId: string, verificationId: string, reason: string) {
    this.logger.error(`Verification ${verificationId} failed analysis: ${reason}`);
    await this.db.withContext({ tenantId }, async (client) => {
      const updated = await client.query(
        `UPDATE verifications SET status = 'technical_error', updated_at = now() WHERE id = $1 AND status = 'analyzing'`,
        [verificationId],
      );
      if (!updated.rowCount) return;
      await client.query(
        `INSERT INTO decisions (tenant_id, verification_id, outcome, origin, reason, rules_version)
         VALUES ($1, $2, 'technical_error', 'automatic', $3, $4)`,
        [tenantId, verificationId, reason, DEFAULT_POLICY.version],
      );
      await recordAudit(client, {
        tenantId,
        verificationId,
        actorType: 'system',
        action: 'verification.technical_error',
        details: { reason },
      });
      await enqueueStatusWebhook(client, tenantId, verificationId, 'technical_error');
    });
  }
}

async function retry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= PROVIDER_ATTEMPTS) throw err;
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * attempt));
    }
  }
}

/** Retries a provider call; if it keeps failing, the check becomes a technical_error instead of throwing. */
async function withRetry(type: CheckType, provider: string, fn: () => Promise<CheckResult>): Promise<CheckResult> {
  try {
    return await retry(fn);
  } catch (err) {
    return technicalError(type, provider, errorMessage(err));
  }
}

function technicalError(type: CheckType, provider: string, error: string): CheckResult {
  return { type, outcome: 'technical_error', score: null, critical: false, provider, details: { error } };
}

function errorMessage(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}
