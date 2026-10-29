import { CheckResult, ExtractedFields } from '../domain/types';

/**
 * Vendor-neutral contracts. Each vendor (AWS Rekognition, CAF, Regula, Serpro, a CPF bureau...)
 * gets an adapter implementing one of these; the rest of the platform never imports a vendor SDK.
 */

/** Thrown by adapters when the vendor is unreachable or errors; becomes a technical_error, never a rejection. */
export class ProviderUnavailableError extends Error {}

export interface ProviderContext {
  verificationId: string;
  /** Sandbox-only scenario that mock adapters use to simulate outcomes. Real adapters ignore it. */
  scenario?: string;
}

export abstract class LivenessProvider {
  abstract readonly name: string;
  /** Starts a vendor liveness session; clientConfig is handed to the SDK to render the vendor's capture UI. */
  abstract createSession(ctx: ProviderContext): Promise<{ sessionId: string; clientConfig: Record<string, unknown> }>;
  abstract getResult(ctx: ProviderContext, sessionId: string): Promise<CheckResult>;
}

export interface DocumentAnalysis {
  documentType: string | null;
  fields: ExtractedFields;
  /** One result each for document_type, data_extraction and document_tampering. */
  results: CheckResult[];
}

export abstract class DocumentProvider {
  abstract readonly name: string;
  abstract analyze(ctx: ProviderContext, front: Buffer, back: Buffer | null): Promise<DocumentAnalysis>;
}

export abstract class FaceMatchProvider {
  abstract readonly name: string;
  abstract compare(ctx: ProviderContext, selfie: Buffer, documentFront: Buffer): Promise<CheckResult>;
}

export interface CpfQuery {
  cpf: string;
  fullName: string | null;
  birthDate: string | null;
}

export abstract class CpfProvider {
  abstract readonly name: string;
  abstract validate(ctx: ProviderContext, query: CpfQuery): Promise<CheckResult>;
}

export function sandboxScenario(verification: { environment: string; metadata: Record<string, unknown> }) {
  const scenario = verification.metadata?.mock_scenario;
  return verification.environment === 'sandbox' && typeof scenario === 'string' ? scenario : undefined;
}
