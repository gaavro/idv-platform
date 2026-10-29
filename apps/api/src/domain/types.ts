export const JOURNEYS = ['signup', 'login', 'deposit', 'withdrawal'] as const;
export type Journey = (typeof JOURNEYS)[number];

export const CAPTURE_KINDS = ['selfie', 'document_front', 'document_back'] as const;
export type CaptureKind = (typeof CAPTURE_KINDS)[number];
export const REQUIRED_CAPTURES: CaptureKind[] = ['selfie', 'document_front'];

export type VerificationStatus =
  | 'created'
  | 'capturing'
  | 'analyzing'
  | 'in_review'
  | 'approved'
  | 'rejected'
  | 'resubmission_requested'
  | 'technical_error'
  | 'expired'
  | 'cancelled';

/** Statuses in which the end user may still send captures. */
export const CAPTURABLE_STATUSES: VerificationStatus[] = ['created', 'capturing', 'resubmission_requested'];

export const CHECK_TYPES = [
  'liveness',
  'document_type',
  'data_extraction',
  'document_consistency',
  'face_match',
  'cpf_validation',
  'document_tampering',
  'capture_reuse',
] as const;
export type CheckType = (typeof CHECK_TYPES)[number];

/** technical_error means the check could not run (provider down, timeout); it is never an identity failure. */
export type CheckOutcome = 'pass' | 'fail' | 'inconclusive' | 'technical_error';

export interface CheckResult {
  type: CheckType;
  outcome: CheckOutcome;
  /** 0-100 confidence, or null when the check produced no score. */
  score: number | null;
  /** A critical failure blocks automatic approval regardless of the overall score. */
  critical: boolean;
  provider: string;
  details: Record<string, unknown>;
}

export const FIELD_NAMES = [
  'full_name',
  'cpf',
  'birth_date',
  'mother_name',
  'father_name',
  'document_number',
  'issue_date',
  'expiry_date',
  'address',
] as const;
export type FieldName = (typeof FIELD_NAMES)[number];

/** A field that could not be read stays null with a reason; it is never guessed. Dates are YYYY-MM-DD. */
export interface ExtractedField {
  value: string | null;
  confidence: number | null;
  unreadable_reason?: string;
}
export type ExtractedFields = Record<FieldName, ExtractedField>;

export function missingField(reason: string): ExtractedField {
  return { value: null, confidence: null, unreadable_reason: reason };
}

export function allFieldsMissing(reason: string): ExtractedFields {
  return Object.fromEntries(FIELD_NAMES.map((name) => [name, missingField(reason)])) as ExtractedFields;
}
