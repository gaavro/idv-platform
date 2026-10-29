import { Controller, Get, Module, Provider } from '@nestjs/common';
import { AnalysisService } from './analysis/analysis.service';
import { AnalystGuard, ApiKeyGuard, SessionGuard } from './auth/guards';
import { config } from './config';
import { Db } from './db/db.service';
import { JobWorker } from './jobs/job-worker';
import {
  MockCpfProvider,
  MockDocumentProvider,
  MockFaceMatchProvider,
  MockLivenessProvider,
} from './providers/mock/mock-providers';
import { CpfProvider, DocumentProvider, FaceMatchProvider, LivenessProvider } from './providers/providers';
import { ReviewController } from './review/review.controller';
import { ReviewService } from './review/review.service';
import { SdkController } from './sdk/sdk.controller';
import { SdkService } from './sdk/sdk.service';
import { LocalMediaStorage, MediaStorage } from './storage/media-storage';
import { ExpiryService } from './verifications/expiry.service';
import { VerificationsController } from './verifications/verifications.controller';
import { VerificationsService } from './verifications/verifications.service';
import { WebhookService } from './webhooks/webhook.service';

/** Binds each provider contract to an adapter. Real vendor adapters get added here as they are contracted. */
function providerAdapters(): Provider[] {
  if (config.providers !== 'mock') {
    throw new Error(`PROVIDERS=${config.providers} is not available yet; only "mock" adapters exist`);
  }
  return [
    { provide: LivenessProvider, useClass: MockLivenessProvider },
    { provide: DocumentProvider, useClass: MockDocumentProvider },
    { provide: FaceMatchProvider, useClass: MockFaceMatchProvider },
    { provide: CpfProvider, useClass: MockCpfProvider },
  ];
}

@Controller()
class HealthController {
  @Get('health')
  health() {
    return { status: 'ok' };
  }
}

@Module({
  controllers: [HealthController, VerificationsController, SdkController, ReviewController],
  providers: [
    Db,
    JobWorker,
    { provide: MediaStorage, useClass: LocalMediaStorage },
    ...providerAdapters(),
    ApiKeyGuard,
    SessionGuard,
    AnalystGuard,
    VerificationsService,
    ExpiryService,
    SdkService,
    AnalysisService,
    ReviewService,
    WebhookService,
  ],
})
export class AppModule {}
