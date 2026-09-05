/** Reserves AI allowance before requests and retains ambiguous costs until reconciled. */
import { completionSchema, type Completion } from './inference';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { lockOrganization, transaction } from './database';
import { requireCondition } from './errors';
import { entitlement, memberOrganization } from './workspaces';

interface UsageRow extends QueryResultRow {
  id: string;
  org_id: string;
  model: string;
  reserved_cents: number;
  settled_cents: number | null;
  response_json: Completion | null;
  status: 'reserved' | 'completed' | 'failed' | 'ambiguous';
}

export class UsageStore {
  constructor(
    readonly pool: Pool | PoolClient,
    readonly now: () => Date = () => new Date(),
  ) {}

  async reserve(
    userId: string,
    orgId: string,
    requestKey: string,
    cents: number,
  ): Promise<UsageRow> {
    requireCondition(
      Number.isSafeInteger(cents) && cents > 0,
      400,
      'invalid_reservation',
      'AI cost reservation must be a positive number of cents.',
    );
    requireCondition(
      requestKey.length >= 16 && requestKey.length <= 128,
      400,
      'request_key_required',
      'A stable request identifier is required.',
    );
    return transaction(this.pool, async (client) => {
      await lockOrganization(client, orgId);
      const org = await memberOrganization(client, userId, orgId);
      const access = entitlement(org, this.now());
      requireCondition(
        access.canEdit,
        403,
        'subscription_required',
        'An editing seat and active subscription or trial are required.',
      );
      const previous = await client.query<UsageRow>(
        'SELECT * FROM outreachr.usage WHERE org_id=$1 AND request_key=$2',
        [orgId, requestKey],
      );
      requireCondition(
        !previous.rows[0],
        409,
        'request_already_submitted',
        'This AI request was already submitted; review its recorded result before retrying.',
      );
      const used = (
        await client.query<{ cents: number }>(
          'SELECT COALESCE(sum(COALESCE(settled_cents,reserved_cents)),0)::int AS cents FROM outreachr.usage WHERE org_id=$1 AND period_key=$2',
          [orgId, access.periodKey],
        )
      ).rows[0]!.cents;
      // Cloud atomically reserves the app allowance and operator funding before inference.
      // The local ledger retains request/response recovery and estimates, never a second buyer balance.
      requireCondition(
        Boolean(org.cloud_billing_account_id) || used + cents <= access.allowanceCents,
        429,
        'ai_allowance_exhausted',
        'This request exceeds the workspace AI allowance. Reduce its scope or wait for the next billing period.',
      );
      const result = await client.query<UsageRow>(
        `INSERT INTO outreachr.usage(id,org_id,user_id,request_key,model,period_key,reserved_cents,status)
        VALUES($1,$2,$3,$4,$5,$6,$7,'reserved') RETURNING *`,
        [randomUUID(), orgId, userId, requestKey, access.model, access.periodKey, cents],
      );
      return result.rows[0]!;
    });
  }

  async settle(
    orgId: string,
    id: string,
    result:
      | { status: 'completed'; cents: number; response?: Completion }
      | { status: 'failed'; cents: number }
      | { status: 'ambiguous' },
  ): Promise<void> {
    if (result.status !== 'ambiguous')
      requireCondition(
        Number.isSafeInteger(result.cents) && result.cents >= 0,
        400,
        'invalid_cost',
        'Provider cost must be a nonnegative number of cents.',
      );
    const response =
      result.status === 'completed' && result.response
        ? completionSchema.parse(result.response)
        : null;
    const encodedResponse = response ? JSON.stringify(response) : null;
    requireCondition(
      !encodedResponse || Buffer.byteLength(encodedResponse, 'utf8') <= 2_000_000,
      413,
      'inference_response_too_large',
      'The model response is too large to retain.',
    );
    await transaction(this.pool, async (client) => {
      await lockOrganization(client, orgId);
      const row = (
        await client.query<UsageRow>(
          'SELECT * FROM outreachr.usage WHERE id=$1 AND org_id=$2 FOR UPDATE',
          [id, orgId],
        )
      ).rows[0];
      requireCondition(row, 404, 'usage_not_found', 'Usage reservation not found.');
      requireCondition(
        !response || response.model === row.model,
        409,
        'response_model_mismatch',
        'The response does not match the reserved model.',
      );
      const cents = result.status === 'ambiguous' ? null : result.cents;
      if (row.status === 'completed' || row.status === 'failed') {
        requireCondition(
          row.status === result.status && row.settled_cents === cents,
          409,
          'usage_already_settled',
          'Usage was already settled with a different result.',
        );
        if (encodedResponse) {
          const same = await client.query<{ matches: boolean }>(
            'SELECT response_json=$2::jsonb AS matches FROM outreachr.usage WHERE id=$1',
            [id, encodedResponse],
          );
          requireCondition(
            same.rows[0]?.matches,
            409,
            'response_already_recorded',
            'The original model response cannot be replaced.',
          );
        }
        return;
      }
      // Actual over-reservation cost remains chargeable against the allowance; never hide it.
      await client.query(
        'UPDATE outreachr.usage SET status=$3,settled_cents=$4,response_json=$5::jsonb WHERE id=$1 AND org_id=$2',
        [id, orgId, result.status, cents, encodedResponse],
      );
    });
  }

  /** Only the original requesting member can recover the model response; this never redispatches inference. */
  async recordedResult(userId: string, orgId: string, requestKey: string) {
    await memberOrganization(this.pool, userId, orgId);
    const row = (
      await this.pool.query<UsageRow>(
        'SELECT * FROM outreachr.usage WHERE org_id=$1 AND user_id=$2 AND request_key=$3',
        [orgId, userId, requestKey],
      )
    ).rows[0];
    requireCondition(
      row,
      404,
      'inference_result_not_found',
      'No model result was recorded for this request.',
    );
    return {
      status: row.status,
      response: row.response_json ? completionSchema.parse(row.response_json) : null,
    };
  }

  async summary(userId: string, orgId: string) {
    const org = await memberOrganization(this.pool, userId, orgId);
    const access = entitlement(org, this.now());
    const result = await this.pool.query<{ cents: number; pending: number }>(
      `SELECT COALESCE(sum(COALESCE(settled_cents,reserved_cents)),0)::int AS cents,
      count(*) FILTER (WHERE status IN ('reserved','ambiguous'))::int AS pending
      FROM outreachr.usage WHERE org_id=$1 AND period_key=$2`,
      [orgId, access.periodKey],
    );
    return { ...access, usedCents: result.rows[0]!.cents, pending: result.rows[0]!.pending };
  }
}
