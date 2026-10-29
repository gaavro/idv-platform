import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { z } from 'zod';
import { CurrentSession, SessionAuth, SessionGuard } from '../auth/guards';
import { parse } from '../common/validation';
import { CAPTURE_KINDS } from '../domain/types';
import { SdkService } from './sdk.service';

const captureSchema = z.object({
  kind: z.enum(CAPTURE_KINDS),
  liveness_session_id: z.string().min(1).max(200).optional(),
});

@Controller('v1/sdk')
@UseGuards(SessionGuard)
export class SdkController {
  constructor(private readonly sdk: SdkService) {}

  @Get('session')
  getSession(@CurrentSession() session: SessionAuth) {
    return this.sdk.getSession(session);
  }

  @Post('liveness')
  startLiveness(@CurrentSession() session: SessionAuth) {
    return this.sdk.startLiveness(session);
  }

  @Post('captures')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 15 * 1024 * 1024 } }))
  uploadCapture(
    @CurrentSession() session: SessionAuth,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() body: unknown,
  ) {
    if (!file) throw new BadRequestException('file is required');
    const input = parse(captureSchema, body);
    return this.sdk.uploadCapture(session, input.kind, file.buffer, input.liveness_session_id);
  }

  @Post('submit')
  @HttpCode(200)
  submit(@CurrentSession() session: SessionAuth) {
    return this.sdk.submit(session);
  }
}
