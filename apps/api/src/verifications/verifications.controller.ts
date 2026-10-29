import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { ApiKeyGuard, CurrentTenant, TenantAuth } from '../auth/guards';
import { isValidCpf, normalizeCpf } from '../checks/cpf';
import { parse } from '../common/validation';
import { JOURNEYS } from '../domain/types';
import { VerificationsService } from './verifications.service';

const createSchema = z.object({
  external_user_id: z.string().min(1).max(200),
  journey: z.enum(JOURNEYS),
  cpf: z.string().transform(normalizeCpf).refine(isValidCpf, 'Invalid CPF').optional(),
  metadata: z.record(z.unknown()).optional(),
});

@Controller('v1/verifications')
@UseGuards(ApiKeyGuard)
export class VerificationsController {
  constructor(private readonly verifications: VerificationsService) {}

  @Post()
  create(
    @CurrentTenant() tenant: TenantAuth,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.verifications.create(tenant, parse(createSchema, body), idempotencyKey ?? null);
  }

  @Get(':id')
  get(@CurrentTenant() tenant: TenantAuth, @Param('id', ParseUUIDPipe) id: string) {
    return this.verifications.get(tenant, id);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  cancel(@CurrentTenant() tenant: TenantAuth, @Param('id', ParseUUIDPipe) id: string) {
    return this.verifications.cancel(tenant, id);
  }

  @Post(':id/sessions')
  newSession(@CurrentTenant() tenant: TenantAuth, @Param('id', ParseUUIDPipe) id: string) {
    return this.verifications.newSession(tenant, id);
  }
}
