import { CheckResult, CheckType } from '../domain/types';
import { decide, DEFAULT_POLICY } from './decision-engine';

function check(type: CheckType, overrides: Partial<CheckResult> = {}): CheckResult {
  return { type, outcome: 'pass', score: 100, critical: false, provider: 'test', details: {}, ...overrides };
}

function allPassing(overrides: Partial<Record<CheckType, Partial<CheckResult>>> = {}): CheckResult[] {
  return [...DEFAULT_POLICY.required, 'capture_reuse' as const].map((type) => check(type, overrides[type]));
}

describe('decide', () => {
  it('approves automatically when every required check passes and the score reaches the threshold', () => {
    const decision = decide(allPassing());
    expect(decision).toMatchObject({ outcome: 'approved', score: 100, reasons: ['all_checks_passed'] });
  });

  it('never lets a high score compensate for a critical failure', () => {
    const decision = decide(allPassing({ capture_reuse: { outcome: 'fail', critical: true, score: 0 } }));
    expect(decision.score).toBe(100);
    expect(decision).toMatchObject({ outcome: 'manual_review', suspicious: true, reasons: ['critical_failure:capture_reuse'] });
  });

  it('separates provider failures from identity failures', () => {
    const decision = decide(allPassing({ face_match: { outcome: 'technical_error', score: null } }));
    expect(decision).toMatchObject({ outcome: 'technical_error', score: null, reasons: ['technical_error:face_match'] });
  });

  it('treats a missing required check as a technical error', () => {
    const decision = decide(allPassing().filter((r) => r.type !== 'liveness'));
    expect(decision).toMatchObject({ outcome: 'technical_error', reasons: ['missing_check:liveness'] });
  });

  it('sends inconclusive required checks to review even with a passing score', () => {
    const decision = decide(allPassing({ data_extraction: { outcome: 'inconclusive', score: 50 } }));
    expect(decision).toMatchObject({ outcome: 'manual_review', reasons: ['check_not_satisfied:data_extraction'] });
  });

  it('approves at exactly the threshold and reviews one point below', () => {
    // face_match weighs 0.3 of the score; the others score 100.
    const atThreshold = decide(allPassing({ face_match: { score: 33 } }), { ...DEFAULT_POLICY, threshold: 80 });
    expect(atThreshold).toMatchObject({ outcome: 'approved', score: 80 });

    const below = decide(allPassing({ face_match: { score: 30 } }), { ...DEFAULT_POLICY, threshold: 80 });
    expect(below.score).toBe(79);
    expect(below.outcome).toBe('manual_review');
    expect(below.reasons).toContain('score_below_threshold:79<80');
  });

  it('does not block on an optional check that could not run', () => {
    const decision = decide(allPassing({ capture_reuse: { outcome: 'technical_error', score: null } }));
    expect(decision.outcome).toBe('approved');
  });

  it('honours a per-company threshold', () => {
    const decision = decide(allPassing({ face_match: { score: 70 } }), { ...DEFAULT_POLICY, threshold: 95 });
    expect(decision.outcome).toBe('manual_review');
  });
});
