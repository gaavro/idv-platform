import { Queryable } from '../db/db.service';
import { ExtractedField } from '../domain/types';

/** What partners see through the API. Runs under the caller's RLS context. */
export async function loadVerificationView(client: Queryable, id: string) {
  const {
    rows: [verification],
  } = await client.query(
    `SELECT id, external_user_id, journey, status, score, current_analysis_run, created_at, updated_at, expires_at
     FROM verifications WHERE id = $1`,
    [id],
  );
  if (!verification) return null;

  const {
    rows: [decision],
  } = await client.query(
    `SELECT outcome, origin, reason, rules_version, created_at
     FROM decisions WHERE verification_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [id],
  );
  const { rows: checks } = await client.query(
    `SELECT type, outcome, score FROM check_results WHERE verification_id = $1 AND analysis_run = $2 ORDER BY type`,
    [id, verification.current_analysis_run],
  );
  const {
    rows: [extracted],
  } = await client.query(`SELECT document_type, fields FROM extracted_data WHERE verification_id = $1`, [id]);

  return {
    id: verification.id,
    external_user_id: verification.external_user_id,
    journey: verification.journey,
    status: verification.status,
    score: verification.score,
    decision: decision
      ? {
          outcome: decision.outcome,
          origin: decision.origin,
          reason: decision.reason,
          rules_version: decision.rules_version,
          decided_at: decision.created_at,
        }
      : null,
    document_type: extracted?.document_type ?? null,
    extracted: extracted ? formatFields(extracted.fields) : null,
    checks,
    created_at: verification.created_at,
    updated_at: verification.updated_at,
    expires_at: verification.expires_at,
  };
}

function formatFields(fields: Record<string, ExtractedField>) {
  const values: Record<string, string | null> = {};
  const unreadable: Record<string, string> = {};
  for (const [name, field] of Object.entries(fields)) {
    values[name] = field.value;
    if (field.value === null && field.unreadable_reason) unreadable[name] = field.unreadable_reason;
  }
  return { fields: values, unreadable_fields: unreadable };
}
