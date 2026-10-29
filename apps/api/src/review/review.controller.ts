import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { AnalystAuth, AnalystGuard, CurrentAnalyst } from '../auth/guards';
import { parse } from '../common/validation';
import { ReviewService } from './review.service';

const decisionSchema = z.object({
  decision: z.enum(['approve', 'reject', 'request_resubmission']),
  reason: z.string().trim().min(10, 'Explain the decision in at least 10 characters').max(2000),
});

const queueSchema = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) });

@Controller('v1/review')
@UseGuards(AnalystGuard)
export class ReviewController {
  constructor(private readonly review: ReviewService) {}

  @Get('queue')
  queue(@Query() query: unknown) {
    return this.review.queue(parse(queueSchema, query).limit);
  }

  @Get('verifications/:id')
  detail(@CurrentAnalyst() analyst: AnalystAuth, @Param('id', ParseUUIDPipe) id: string) {
    return this.review.detail(analyst, id);
  }

  @Get('media/:captureId')
  async media(
    @CurrentAnalyst() analyst: AnalystAuth,
    @Param('captureId', ParseUUIDPipe) captureId: string,
    @Res() res: Response,
  ) {
    const media = await this.review.media(analyst, captureId);
    res.setHeader('content-type', media.mimeType);
    res.setHeader('cache-control', 'no-store');
    res.setHeader('content-disposition', 'inline');
    res.send(media.data);
  }

  @Post('verifications/:id/decision')
  @HttpCode(200)
  decide(@CurrentAnalyst() analyst: AnalystAuth, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const input = parse(decisionSchema, body);
    return this.review.decide(analyst, id, input.decision, input.reason);
  }
}
