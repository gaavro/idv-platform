import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient, QueryResultRow } from 'pg';
import { config } from '../config';

/** A tenant sees only its own rows; platform staff (analysts, system sweeps) see all tenants. */
export type DbContext = { tenantId: string } | { platform: true };

export type Queryable = Pick<PoolClient, 'query'>;

@Injectable()
export class Db implements OnModuleDestroy {
  readonly pool = new Pool({ connectionString: config.databaseUrl });

  /** Queries tables without row-level security (auth lookups, jobs). */
  query<R extends QueryResultRow = any>(text: string, params?: unknown[]) {
    return this.pool.query<R>(text, params);
  }

  /** Runs fn in a transaction whose row-level security context is set to ctx. */
  async withContext<T>(ctx: DbContext, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if ('tenantId' in ctx) {
        await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [ctx.tenantId]);
      } else {
        await client.query(`SELECT set_config('app.platform_access', 'on', true)`);
      }
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async onModuleDestroy() {
    await this.pool.end();
  }
}
