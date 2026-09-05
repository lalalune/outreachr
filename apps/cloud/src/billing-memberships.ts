/** Durably mirrors app-owned roles to Cloud without granting purchaser authority. */
import { randomUUID } from 'node:crypto';
import { CloudApiError } from '@elizaos/cloud-sdk';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import type { OutreachrDelegation } from './delegation';
import { transaction, withWorkspaceLock } from './database';
import { CloudError, requireCondition } from './errors';
import { isEditor, type Role } from './plans';
import type { Organization } from './workspaces';

export async function enqueueMembershipChange(
  db: PoolClient,
  org: Organization,
  userId: string,
  role: Role | null,
) {
  if (!org.cloud_billing_account_id) return;
  requireCondition(
    org.cloud_app_id && org.cloud_billing_environment && org.cloud_product_family_key,
    503,
    'billing_binding_incomplete',
    'Workspace billing must be repaired before changing Cloud membership.',
  );
  const id = randomUUID();
  await db.query(
    `INSERT INTO outreachr.cloud_membership_jobs
    (id,org_id,user_id,desired_role,app_id,billing_account_id,environment,product_family_key)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      id,
      org.id,
      userId,
      role,
      org.cloud_app_id,
      org.cloud_billing_account_id,
      org.cloud_billing_environment,
      org.cloud_product_family_key,
    ],
  );
  await db.query(
    'UPDATE outreachr.memberships SET cloud_membership_ready=false,cloud_sync_job_id=$3 WHERE org_id=$1 AND user_id=$2',
    [org.id, userId, id],
  );
}

const revision = z.string().regex(/^(0|[1-9]\d*)$/);
const identity = {
  appId: z.uuid(),
  billingAccountId: z.uuid(),
  environment: z.enum(['test', 'live']),
};
const member = z.object({
  userId: z.uuid(),
  role: z.enum(['administrator', 'member']),
  active: z.boolean(),
});
const snapshotSchema = z.object({
  success: z.literal(true),
  data: z.object({ ...identity, revision, members: z.array(member) }),
});
const requestSchema = z.object({
  userId: z.uuid(),
  active: z.boolean(),
  expectedRevision: revision,
  idempotencyKey: z.string(),
  seats: z.array(z.object({ productFamilyKey: z.string(), assigned: z.boolean() })),
});
const changeSchema = z.object({
  success: z.literal(true),
  data: z.object({
    ...identity,
    revision,
    member,
    seats: z.array(z.object({ productFamilyKey: z.string(), seatId: z.uuid() })),
  }),
});
interface Job {
  id: string;
  org_id: string;
  user_id: string;
  desired_role: Role | null;
  app_id: string;
  billing_account_id: string;
  environment: 'test' | 'live';
  product_family_key: string;
  client_id: string | null;
  request_json: unknown;
  attempts: number;
  retry_after: Date;
}

export class CloudMembershipSync {
  constructor(
    readonly pool: Pool,
    readonly cloud: OutreachrDelegation,
    readonly productFamilyKey: string,
  ) {}

  async runOrg(orgId: string, limit = 1) {
    return withWorkspaceLock(this.pool, orgId, async (db) => {
      const batchDeadline = Date.now() + 5_000;
      for (let step = 0; step < limit; step += 1) {
        if (step > 0 && Date.now() >= batchDeadline) return;
        const job = (
          await db.query<Job>(
            "SELECT * FROM outreachr.cloud_membership_jobs WHERE org_id=$1 AND state='pending' ORDER BY position LIMIT 1",
            [orgId],
          )
        ).rows[0];
        if (!job || job.retry_after.getTime() > Date.now()) return;
        try {
          const org = (
            await db.query<Organization>('SELECT * FROM outreachr.organizations WHERE id=$1', [
              orgId,
            ])
          ).rows[0];
          const config = this.cloud.config;
          requireCondition(
            org &&
              job.app_id === config.appId &&
              job.environment === config.billingEnvironment &&
              job.product_family_key === this.productFamilyKey &&
              org.cloud_app_id === job.app_id &&
              org.cloud_billing_account_id === job.billing_account_id &&
              org.cloud_billing_environment === job.environment &&
              org.cloud_product_family_key === job.product_family_key &&
              (!job.client_id || job.client_id === config.clientId),
            503,
            'membership_registration_changed',
            'Drain pending membership changes before replacing the app registration.',
          );
          const local = (
            await db.query<{ cloud_sync_job_id: string | null }>(
              'SELECT cloud_sync_job_id FROM outreachr.memberships WHERE org_id=$1 AND user_id=$2',
              [orgId, job.user_id],
            )
          ).rows[0];
          const desired = job.desired_role === null ? !local : local?.cloud_sync_job_id === job.id;
          // Only undispatched (or authoritatively rejected) intents can be skipped.
          if (!desired && job.request_json === null) {
            await db.query(
              "UPDATE outreachr.cloud_membership_jobs SET state='superseded' WHERE id=$1",
              [job.id],
            );
            continue;
          }
          const api = this.cloud.appBillingBackend();
          if (job.request_json === null) {
            const parsed = snapshotSchema.safeParse(await api.listMembers(job.billing_account_id));
            requireCondition(
              parsed.success &&
                parsed.data.data.appId === job.app_id &&
                parsed.data.data.billingAccountId === job.billing_account_id &&
                parsed.data.data.environment === job.environment,
              502,
              'membership_scope_invalid',
              'Cloud returned membership for a different app account.',
            );
            if (job.desired_role === 'owner')
              requireCondition(
                parsed.data.data.members.some(
                  (value) =>
                    value.userId === job.user_id && value.active && value.role === 'administrator',
                ),
                409,
                'billing_owner_authority_required',
                'Billing owner changes require the current owner authorization.',
              );
            const request = {
              userId: job.user_id,
              active: job.desired_role !== null,
              expectedRevision: parsed.data.data.revision,
              idempotencyKey: `membership:${job.id}`,
              seats:
                job.desired_role === null
                  ? []
                  : [
                      {
                        productFamilyKey: job.product_family_key,
                        assigned: isEditor(job.desired_role),
                      },
                    ],
            };
            // Commit the exact body before dispatch. A timeout reuses this body and key.
            await db.query(
              'UPDATE outreachr.cloud_membership_jobs SET request_json=$2::jsonb,client_id=$3 WHERE id=$1',
              [job.id, JSON.stringify(request), config.clientId],
            );
            job.request_json = request;
          }
          const request = requestSchema.parse(job.request_json);
          requireCondition(
            request.userId === job.user_id &&
              request.active === (job.desired_role !== null) &&
              request.idempotencyKey === `membership:${job.id}` &&
              (job.desired_role === null
                ? request.seats.length === 0
                : request.seats.length === 1 &&
                  request.seats[0]!.productFamilyKey === job.product_family_key &&
                  request.seats[0]!.assigned === isEditor(job.desired_role)),
            409,
            'membership_intent_invalid',
            'The saved membership intent does not match its authorized target.',
          );
          const parsed = changeSchema.safeParse(
            await api.synchronizeMember(job.billing_account_id, request),
          );
          requireCondition(
            parsed.success,
            502,
            'membership_result_invalid',
            'Cloud did not confirm membership synchronization.',
          );
          const result = parsed.data.data;
          const assigned = result.seats.filter(
            (seat) => seat.productFamilyKey === job.product_family_key,
          );
          requireCondition(
            result.appId === job.app_id &&
              result.billingAccountId === job.billing_account_id &&
              result.environment === job.environment &&
              result.member.userId === job.user_id &&
              result.member.active === request.active &&
              // Administrator authority can change concurrently. This receipt only confirms membership and seats;
              // CloudOwnership separately projects current purchaser authority from the canonical admin read.
              BigInt(result.revision) === BigInt(request.expectedRevision) + 1n &&
              (job.desired_role === null
                ? result.seats.length === 0
                : isEditor(job.desired_role)
                  ? assigned.length === 1
                  : assigned.length === 0),
            502,
            'membership_result_scope',
            'Cloud did not confirm the requested membership and seat.',
          );
          await transaction(db, async (client) => {
            await client.query(
              "UPDATE outreachr.cloud_membership_jobs SET state='confirmed',error_code=NULL WHERE id=$1",
              [job.id],
            );
            await client.query(
              'UPDATE outreachr.memberships SET cloud_membership_ready=true WHERE org_id=$1 AND user_id=$2 AND cloud_sync_job_id=$3',
              [orgId, job.user_id, job.id],
            );
            await client.query(
              'UPDATE outreachr.organizations SET cloud_billing_invalidated=true WHERE id=$1',
              [orgId],
            );
          });
        } catch (error) {
          // Only this code is emitted after prior receipt lookup and guarantees no mutation.
          // All transport, authorization, receipt and undifferentiated conflicts retain the body.
          const revisionRejected =
            error instanceof CloudApiError &&
            error.statusCode === 409 &&
            error.errorBody.code === 'APP_BILLING_MEMBERSHIP_REVISION_CONFLICT';
          await db.query(
            `UPDATE outreachr.cloud_membership_jobs SET attempts=attempts+1,error_code=$2,
            request_json=CASE WHEN $3 THEN NULL ELSE request_json END,
            retry_after=now()+($4 * interval '1 second') WHERE id=$1`,
            [
              job.id,
              error instanceof CloudError ? error.code : 'membership_sync_unconfirmed',
              revisionRejected,
              Math.min(60, 2 ** Math.min(6, job.attempts + 1)),
            ],
          );
          return;
        }
      }
    });
  }

  async runPending() {
    const rows = await this.pool.query<{ org_id: string }>(`WITH first_jobs AS (
      SELECT DISTINCT ON(org_id) org_id,position,retry_after FROM outreachr.cloud_membership_jobs
      WHERE state='pending' ORDER BY org_id,position)
      SELECT org_id FROM first_jobs WHERE retry_after<=now() ORDER BY position LIMIT 20`);
    for (const row of rows.rows) await this.runOrg(row.org_id, 20);
  }
}
