import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { recordAudit } from '../common/audit';
import { config } from '../config';
import { Db } from '../db/db.service';
import { enqueueStatusWebhook } from '../jobs/job-queue';

/** Marks journeys the end user abandoned as expired. */
@Injectable()
export class ExpiryService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(ExpiryService.name);
  private timer?: NodeJS.Timeout;

  constructor(private readonly db: Db) {}

  onApplicationBootstrap() {
    if (config.workerEnabled) {
      this.timer = setInterval(() => this.sweep().catch((err) => this.logger.error(err)), 60_000);
    }
  }

  onApplicationShutdown() {
    clearInterval(this.timer);
  }

  async sweep(): Promise<number> {
    return this.db.withContext({ platform: true }, async (client) => {
      const { rows } = await client.query(
        `UPDATE verifications SET status = 'expired', updated_at = now()
         WHERE status IN ('created', 'capturing', 'resubmission_requested') AND expires_at <= now()
         RETURNING id, tenant_id`,
      );
      for (const row of rows) {
        await recordAudit(client, {
          tenantId: row.tenant_id,
          verificationId: row.id,
          actorType: 'system',
          action: 'verification.expired',
        });
        await enqueueStatusWebhook(client, row.tenant_id, row.id, 'expired');
      }
      return rows.length;
    });
  }
}
