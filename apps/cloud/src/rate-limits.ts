import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { requireCondition } from './errors';
/** Shared across workers; stores an opaque bucket key and retains no request content. */
export class RateLimiter {
  constructor(
    readonly pool: Pool,
    readonly now: () => number = Date.now,
  ) {}
  async consume(scope: string, subject: string, limit: number) {
    const key = createHash('sha256').update(`${scope}:${subject}`).digest('hex');
    const result = await this.pool.query(
      `INSERT INTO outreachr.request_buckets(key,window_start,requests) VALUES($1,$2,1)
      ON CONFLICT(key,window_start) DO UPDATE SET requests=outreachr.request_buckets.requests+1
      WHERE outreachr.request_buckets.requests<$3 RETURNING requests`,
      [key, Math.floor(this.now() / 60000), limit],
    );
    requireCondition(
      result.rowCount,
      429,
      'rate_limit',
      'Too many requests. Wait one minute and try again.',
    );
  }
}
