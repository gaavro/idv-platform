import { CheckResult, ExtractedFields } from '../domain/types';
import { isValidCpf, normalizeCpf } from './cpf';

/** In-house checks on the extracted data: CPF digits, expiry and date coherence. */
export function checkDocumentConsistency(
  fields: ExtractedFields,
  partnerCpf: string | null,
  today: Date = new Date(),
): CheckResult {
  const problems: string[] = [];
  let critical = false;
  const flag = (problem: string, isCritical: boolean) => {
    problems.push(problem);
    critical ||= isCritical;
  };

  const documentCpf = fields.cpf.value ? normalizeCpf(fields.cpf.value) : null;
  if (documentCpf && !isValidCpf(documentCpf)) flag('cpf_invalid_check_digits', true);
  if (documentCpf && partnerCpf && documentCpf !== partnerCpf) flag('cpf_differs_from_partner', true);
  if (!documentCpf && !partnerCpf) flag('cpf_unavailable', true);

  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const expiry = parseIsoDate(fields.expiry_date.value);
  const birth = parseIsoDate(fields.birth_date.value);
  const issue = parseIsoDate(fields.issue_date.value);

  if (expiry !== null && expiry < todayUtc) flag('document_expired', true);
  if (birth !== null) {
    const ageYears = (todayUtc - birth) / (365.25 * 24 * 3600 * 1000);
    if (ageYears < 0 || ageYears > 130) flag('birth_date_implausible', false);
  }
  if (issue !== null && birth !== null && issue < birth) flag('issue_date_before_birth', false);
  if (issue !== null && issue > todayUtc) flag('issue_date_in_future', false);

  return {
    type: 'document_consistency',
    outcome: problems.length ? 'fail' : 'pass',
    score: problems.length ? (critical ? 0 : 40) : 100,
    critical,
    provider: 'internal',
    details: { problems },
  };
}

function parseIsoDate(value: string | null): number | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isNaN(time) ? null : time;
}
