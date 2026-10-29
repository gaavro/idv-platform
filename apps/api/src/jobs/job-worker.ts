import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { config } from '../config';
import { Db } from '../db/db.service';

export interface JobHandler {
  run(payload: any): Promise<void>;
  /** Called once when the last attempt fails. */
  onExhausted?(payload: any, error: Error): Promise<void>;
  backoffSeconds?(attempt: number): number;
}

const STALE_LOCK = '5 minutes';

@Injectable()
export class JobWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(JobWorker.name);
  private readonly handlers = new Map<string, JobHandler>();
  private timer?: NodeJS.Timeout;
  private draining = false;

  constructor(private readonly db: Db) {}

  register(type: string, handler: JobHandler) {
    this.handlers.set(type, handler);
  }

  onApplicationBootstrap() {
    if (config.workerEnabled) this.timer = setInterval(() => void this.drain(), 1000);
  }

  onApplicationShutdown() {
    clearInterval(this.timer);
  }

  /** Runs due jobs until none are left. */
  async drain() {
    if (this.draining) return;
    this.draining = true;
    try {
      while (await this.runOnce());
    } catch (err) {
      this.logger.error(err);
    } finally {
      this.draining = false;
    }
  }

  /** Claims and runs one due job. Returns false when nothing is due. */
  async runOnce(): Promise<boolean> {
    const { rows } = await this.db.query(
      `UPDATE jobs SET locked_at = now(), attempts = attempts + 1
       WHERE id = (
         SELECT id FROM jobs
         WHERE done_at IS NULL AND failed_at IS NULL AND run_at <= now()
           AND (locked_at IS NULL OR locked_at < now() - interval '${STALE_LOCK}')
         ORDER BY run_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1)
       RETURNING id, type, payload, attempts, max_attempts`,
    );
    const job = rows[0];
    if (!job) return false;

    const handler = this.handlers.get(job.type);
    try {
      if (!handler) throw new Error(`No handler registered for job type ${job.type}`);
      await handler.run(job.payload);
      await this.db.query(`UPDATE jobs SET done_at = now(), locked_at = NULL WHERE id = $1`, [job.id]);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.logger.warn(`Job ${job.id} (${job.type}) attempt ${job.attempts} failed: ${error.message}`);
      if (job.attempts >= job.max_attempts) {
        await this.db.query(`UPDATE jobs SET failed_at = now(), locked_at = NULL, last_error = $2 WHERE id = $1`, [
          job.id,
          error.message,
        ]);
        await handler?.onExhausted?.(job.payload, error);
      } else {
        const delay = handler?.backoffSeconds?.(job.attempts) ?? 2 ** job.attempts;
        await this.db.query(
          `UPDATE jobs SET locked_at = NULL, last_error = $2, run_at = now() + make_interval(secs => $3) WHERE id = $1`,
          [job.id, error.message, delay],
        );
      }
    }
    return true;
  }
}
