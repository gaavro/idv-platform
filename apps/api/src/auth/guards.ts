import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { Db } from '../db/db.service';
import { hashToken } from './tokens';

export interface TenantAuth {
  tenantId: string;
  environment: 'sandbox' | 'live';
  apiKeyId: string;
}

export interface SessionAuth {
  tenantId: string;
  verificationId: string;
}

export interface AnalystAuth {
  analystId: string;
  role: 'analyst' | 'supervisor';
}

type AuthedRequest = Request & { tenant?: TenantAuth; session?: SessionAuth; analyst?: AnalystAuth };

function bearer(req: Request): string | null {
  const header = req.headers.authorization;
  return header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
}

/** Partner companies, server to server: `Authorization: Bearer <api key>`. */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly db: Db) {}

  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const token = bearer(req);
    if (!token) throw new UnauthorizedException();
    const { rows } = await this.db.query(
      `SELECT id, tenant_id, environment FROM api_keys WHERE key_hash = $1 AND revoked_at IS NULL`,
      [hashToken(token)],
    );
    if (!rows[0]) throw new UnauthorizedException();
    req.tenant = { tenantId: rows[0].tenant_id, environment: rows[0].environment, apiKeyId: rows[0].id };
    return true;
  }
}

/** The SDK in the end user's browser: `X-Session-Token`, scoped to one verification. */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly db: Db) {}

  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const token = req.headers['x-session-token'];
    if (typeof token !== 'string') throw new UnauthorizedException();
    const { rows } = await this.db.query(
      `SELECT verification_id, tenant_id FROM verification_sessions WHERE token_hash = $1 AND expires_at > now()`,
      [hashToken(token)],
    );
    if (!rows[0]) throw new UnauthorizedException();
    req.session = { tenantId: rows[0].tenant_id, verificationId: rows[0].verification_id };
    return true;
  }
}

/**
 * Review dashboard: `Authorization: Bearer <analyst token>`.
 * TODO: replace static tokens with OIDC + MFA before production.
 */
@Injectable()
export class AnalystGuard implements CanActivate {
  constructor(private readonly db: Db) {}

  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const token = bearer(req);
    if (!token) throw new UnauthorizedException();
    const { rows } = await this.db.query(`SELECT id, role FROM analysts WHERE token_hash = $1`, [hashToken(token)]);
    if (!rows[0]) throw new UnauthorizedException();
    req.analyst = { analystId: rows[0].id, role: rows[0].role };
    return true;
  }
}

export const CurrentTenant = createParamDecorator(
  (_: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest<AuthedRequest>().tenant as TenantAuth,
);
export const CurrentSession = createParamDecorator(
  (_: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest<AuthedRequest>().session as SessionAuth,
);
export const CurrentAnalyst = createParamDecorator(
  (_: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest<AuthedRequest>().analyst as AnalystAuth,
);
