import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { CheckResult, ExtractedFields, missingField } from '../../domain/types';
import {
  CpfProvider,
  CpfQuery,
  DocumentAnalysis,
  DocumentProvider,
  FaceMatchProvider,
  LivenessProvider,
  ProviderContext,
  ProviderUnavailableError,
} from '../providers';

/**
 * Stand-ins until vendors are contracted. In sandbox, set metadata.mock_scenario on the
 * verification to one of these to simulate an outcome; the default is a clean approval.
 */
export const MOCK_SCENARIOS = [
  'approve',
  'liveness_spoof',
  'face_mismatch',
  'face_borderline',
  'cpf_irregular',
  'unreadable_cpf',
  'tampered_document',
  'expired_document',
  'provider_down',
] as const;

const PROVIDER = 'mock';

function result(partial: Omit<CheckResult, 'provider' | 'critical' | 'details'> & Partial<CheckResult>): CheckResult {
  return { provider: PROVIDER, critical: false, details: {}, ...partial };
}

function failIfDown(ctx: ProviderContext) {
  if (ctx.scenario === 'provider_down') throw new ProviderUnavailableError('mock provider is down');
}

@Injectable()
export class MockLivenessProvider extends LivenessProvider {
  readonly name = PROVIDER;

  async createSession() {
    return { sessionId: `mock-liveness-${randomUUID()}`, clientConfig: { provider: PROVIDER } };
  }

  async getResult(ctx: ProviderContext): Promise<CheckResult> {
    failIfDown(ctx);
    if (ctx.scenario === 'liveness_spoof') {
      return result({ type: 'liveness', outcome: 'fail', score: 5, critical: true, details: { spoof_type: 'screen_replay' } });
    }
    return result({ type: 'liveness', outcome: 'pass', score: 98 });
  }
}

@Injectable()
export class MockDocumentProvider extends DocumentProvider {
  readonly name = PROVIDER;

  async analyze(ctx: ProviderContext): Promise<DocumentAnalysis> {
    failIfDown(ctx);
    const field = (value: string) => ({ value, confidence: 0.97 });
    const fields: ExtractedFields = {
      full_name: field('MARIA DE TESTE'),
      cpf: ctx.scenario === 'unreadable_cpf' ? missingField('illegible') : field('52998224725'),
      birth_date: field('1990-05-14'),
      mother_name: field('ANA DE TESTE'),
      father_name: missingField('not_present_on_document'),
      document_number: field('04512345678'),
      issue_date: field('2021-03-10'),
      expiry_date: field(ctx.scenario === 'expired_document' ? '2024-03-10' : '2031-03-10'),
      address: missingField('not_present_on_document'),
    };
    const extraction =
      ctx.scenario === 'unreadable_cpf'
        ? result({ type: 'data_extraction', outcome: 'inconclusive', score: 50, details: { unreadable: ['cpf'] } })
        : result({ type: 'data_extraction', outcome: 'pass', score: 95 });
    const tampering =
      ctx.scenario === 'tampered_document'
        ? result({ type: 'document_tampering', outcome: 'fail', score: 10, critical: true, details: { signal: 'font_mismatch' } })
        : result({ type: 'document_tampering', outcome: 'pass', score: 96 });

    return {
      documentType: 'cnh',
      fields,
      results: [result({ type: 'document_type', outcome: 'pass', score: 99, details: { document_type: 'cnh' } }), extraction, tampering],
    };
  }
}

@Injectable()
export class MockFaceMatchProvider extends FaceMatchProvider {
  readonly name = PROVIDER;

  async compare(ctx: ProviderContext): Promise<CheckResult> {
    failIfDown(ctx);
    if (ctx.scenario === 'face_mismatch') {
      return result({ type: 'face_match', outcome: 'fail', score: 12, critical: true, details: { similarity: 12 } });
    }
    if (ctx.scenario === 'face_borderline') {
      return result({ type: 'face_match', outcome: 'inconclusive', score: 72, details: { similarity: 72 } });
    }
    return result({ type: 'face_match', outcome: 'pass', score: 94, details: { similarity: 94 } });
  }
}

@Injectable()
export class MockCpfProvider extends CpfProvider {
  readonly name = PROVIDER;

  async validate(ctx: ProviderContext, query: CpfQuery): Promise<CheckResult> {
    failIfDown(ctx);
    if (ctx.scenario === 'cpf_irregular') {
      return result({ type: 'cpf_validation', outcome: 'fail', score: 0, critical: true, details: { status: 'cancelled' } });
    }
    return result({
      type: 'cpf_validation',
      outcome: 'pass',
      score: 100,
      details: { status: 'regular', name_match: query.fullName !== null, birth_date_match: query.birthDate !== null },
    });
  }
}
