import { Queryable } from '../db/db.service';

export interface AuditEvent {
  tenantId: string | null;
  verificationId?: string | null;
  actorType: 'api_key' | 'end_user' | 'analyst' | 'system';
  actorId?: string | null;
  action: string;
  details?: Record<string, unknown>;
}

/** Written in the same transaction as the change it describes. */
export async function recordAudit(client: Queryable, event: AuditEvent) {
  await client.query(
    `INSERT INTO audit_events (tenant_id, verification_id, actor_type, actor_id, action, details)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      event.tenantId,
      event.verificationId ?? null,
      event.actorType,
      event.actorId ?? null,
      event.action,
      JSON.stringify(event.details ?? {}),
    ],
  );
}
