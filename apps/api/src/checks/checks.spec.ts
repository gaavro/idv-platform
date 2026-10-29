import { ExtractedFields, FIELD_NAMES, missingField } from '../domain/types';
import { isValidCpf, normalizeCpf } from './cpf';
import { checkDocumentConsistency } from './document-consistency';

describe('isValidCpf', () => {
  it('accepts a CPF with correct check digits', () => {
    expect(isValidCpf('52998224725')).toBe(true);
    expect(isValidCpf(normalizeCpf('529.982.247-25'))).toBe(true);
  });

  it('rejects wrong check digits, repeated digits and wrong lengths', () => {
    expect(isValidCpf('52998224724')).toBe(false);
    expect(isValidCpf('11111111111')).toBe(false);
    expect(isValidCpf('5299822472')).toBe(false);
  });
});

describe('checkDocumentConsistency', () => {
  const today = new Date('2026-11-01T12:00:00Z');

  function fields(values: Partial<Record<(typeof FIELD_NAMES)[number], string | null>>): ExtractedFields {
    const base = {
      full_name: 'MARIA DE TESTE',
      cpf: '52998224725',
      birth_date: '1990-05-14',
      issue_date: '2021-03-10',
      expiry_date: '2031-03-10',
      ...values,
    } as Record<string, string | null | undefined>;
    return Object.fromEntries(
      FIELD_NAMES.map((name) => [
        name,
        base[name] ? { value: base[name] as string, confidence: 0.9 } : missingField('not_present_on_document'),
      ]),
    ) as ExtractedFields;
  }

  it('passes a coherent, valid document', () => {
    expect(checkDocumentConsistency(fields({}), null, today)).toMatchObject({ outcome: 'pass', critical: false });
  });

  it('fails critically on an expired document', () => {
    const result = checkDocumentConsistency(fields({ expiry_date: '2026-10-31' }), null, today);
    expect(result).toMatchObject({ outcome: 'fail', critical: true, details: { problems: ['document_expired'] } });
  });

  it('fails critically when the document CPF differs from the one the company sent', () => {
    const result = checkDocumentConsistency(fields({}), '11144477735', today);
    expect(result.details.problems).toEqual(['cpf_differs_from_partner']);
    expect(result.critical).toBe(true);
  });

  it('accepts an unreadable CPF when the company provided one', () => {
    expect(checkDocumentConsistency(fields({ cpf: null }), '52998224725', today).outcome).toBe('pass');
  });

  it('fails critically when no CPF is available from any source', () => {
    const result = checkDocumentConsistency(fields({ cpf: null }), null, today);
    expect(result).toMatchObject({ critical: true, details: { problems: ['cpf_unavailable'] } });
  });

  it('flags incoherent dates without making them critical', () => {
    const result = checkDocumentConsistency(fields({ issue_date: '1985-01-01' }), null, today);
    expect(result).toMatchObject({ outcome: 'fail', critical: false, details: { problems: ['issue_date_before_birth'] } });
  });
});
