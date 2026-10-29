import { CheckResult, CheckType } from '../domain/types';

export interface DecisionPolicy {
  version: string;
  /** Minimum score for automatic approval. */
  threshold: number;
  /** Weights of the checks that make up the 0-100 score. */
  weights: Partial<Record<CheckType, number>>;
  /** Checks that must pass for automatic approval. */
  required: CheckType[];
}

export const DEFAULT_POLICY: DecisionPolicy = {
  version: '2026-11-01',
  threshold: 80,
  weights: {
    face_match: 0.3,
    liveness: 0.25,
    document_tampering: 0.2,
    cpf_validation: 0.15,
    document_consistency: 0.1,
  },
  required: [
    'liveness',
    'document_type',
    'data_extraction',
    'document_consistency',
    'face_match',
    'cpf_validation',
    'document_tampering',
  ],
};

export type AutomaticOutcome = 'approved' | 'manual_review' | 'technical_error';

export interface AutomaticDecision {
  outcome: AutomaticOutcome;
  score: number | null;
  reasons: string[];
  /** True when a critical failure was found; the review queue shows these first. */
  suspicious: boolean;
  rulesVersion: string;
}

/**
 * Applies, in order: technical errors, critical failures, then the score.
 * The engine never rejects on its own; anything not clearly approved goes to an analyst.
 */
export function decide(results: CheckResult[], policy: DecisionPolicy = DEFAULT_POLICY): AutomaticDecision {
  const byType = new Map(results.map((r) => [r.type, r]));
  const rulesVersion = policy.version;

  const missing = policy.required.filter((type) => !byType.has(type));
  const technical = policy.required.filter((type) => byType.get(type)?.outcome === 'technical_error');
  if (missing.length || technical.length) {
    return {
      outcome: 'technical_error',
      score: null,
      suspicious: false,
      rulesVersion,
      reasons: [...missing.map((t) => `missing_check:${t}`), ...technical.map((t) => `technical_error:${t}`)],
    };
  }

  const score = weightedScore(results, policy);

  const critical = results.filter((r) => r.outcome === 'fail' && r.critical);
  if (critical.length) {
    return {
      outcome: 'manual_review',
      score,
      suspicious: true,
      rulesVersion,
      reasons: critical.map((r) => `critical_failure:${r.type}`),
    };
  }

  // Optional checks only block when they fail; if they could not run, required checks still decide.
  const unsatisfied = results.filter((r) =>
    policy.required.includes(r.type) ? r.outcome !== 'pass' : r.outcome === 'fail',
  );
  const reasons = unsatisfied.map((r) => `check_not_satisfied:${r.type}`);
  if (score < policy.threshold) reasons.push(`score_below_threshold:${score}<${policy.threshold}`);

  if (reasons.length) {
    return { outcome: 'manual_review', score, suspicious: false, rulesVersion, reasons };
  }
  return { outcome: 'approved', score, suspicious: false, rulesVersion, reasons: ['all_checks_passed'] };
}

function weightedScore(results: CheckResult[], policy: DecisionPolicy): number {
  let total = 0;
  let weightSum = 0;
  for (const r of results) {
    const weight = policy.weights[r.type];
    if (!weight) continue;
    total += weight * (r.score ?? (r.outcome === 'pass' ? 100 : 0));
    weightSum += weight;
  }
  return weightSum ? Math.round(total / weightSum) : 0;
}
