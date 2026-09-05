/** Maps canonical Cloud billing administrators to product owners without backend purchaser authority. */
import { randomUUID } from 'node:crypto';
import { CloudApiError } from '@elizaos/cloud-sdk';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import type { OutreachrDelegation } from './delegation';
import { transaction, withWorkspaceLock } from './database';
import { CloudError, requireCondition } from './errors';
import { enqueueMembershipChange } from './billing-memberships';
import { memberOrganization, type Organization } from './workspaces';
import type { Role } from './plans';

const revision = z.string().regex(/^(0|[1-9]\d*)$/);
const responseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    appId: z.uuid(),
    billingAccountId: z.uuid(),
    environment: z.enum(['test', 'live']),
    revision,
    administrators: z.array(z.uuid()).min(1),
  }),
});
const requestSchema = z
  .object({
    action: z.enum(['grant', 'revoke', 'transfer']),
    userId: z.uuid(),
    expectedRevision: revision,
    idempotencyKey: z.string(),
  })
  .strict();
type Snapshot = z.infer<typeof responseSchema>['data'];
interface Job {
  id: string;
  org_id: string;
  actor_id: string;
  target_id: string;
  action: 'grant' | 'revoke' | 'transfer';
  app_id: string;
  client_id: string;
  billing_account_id: string;
  environment: 'test' | 'live';
  request_json: unknown;
  response_json: unknown;
  state: 'pending' | 'confirmed' | 'reconciled' | 'superseded';
}
const desired = (job: Job, admins: string[]) =>
  job.action === 'grant'
    ? admins.includes(job.target_id)
    : job.action === 'revoke'
      ? !admins.includes(job.target_id)
      : admins.includes(job.target_id) && !admins.includes(job.actor_id);

export class CloudOwnership {
  constructor(
    readonly pool: Pool,
    readonly cloud: OutreachrDelegation,
    readonly productFamilyKey: string,
  ) {}
  private scope(org: Organization) {
    requireCondition(
      org.cloud_app_id === this.cloud.config.appId &&
        org.cloud_billing_account_id &&
        org.cloud_billing_environment === this.cloud.config.billingEnvironment &&
        org.cloud_product_family_key === this.productFamilyKey,
      503,
      'ownership_binding_unavailable',
      'Cloud ownership is not connected to this workspace.',
    );
  }
  private validate(raw: unknown, org: Organization) {
    const parsed = responseSchema.safeParse(raw);
    requireCondition(
      parsed.success,
      502,
      'ownership_snapshot_invalid',
      'Cloud returned invalid ownership information.',
    );
    const snapshot = parsed.data.data;
    requireCondition(
      snapshot.appId === org.cloud_app_id &&
        snapshot.billingAccountId === org.cloud_billing_account_id &&
        snapshot.environment === org.cloud_billing_environment &&
        new Set(snapshot.administrators).size === snapshot.administrators.length,
      502,
      'ownership_snapshot_scope',
      'Cloud returned ownership for a different workspace.',
    );
    return snapshot;
  }
  private async pending(db: PoolClient, orgId: string) {
    return (
      await db.query<Job>(
        "SELECT * FROM outreachr.cloud_ownership_jobs WHERE org_id=$1 AND state='pending'",
        [orgId],
      )
    ).rows[0];
  }
  private async read(db: PoolClient, org: Organization, grant: string) {
    this.scope(org);
    await db.query(
      'UPDATE outreachr.organizations SET cloud_ownership_confirmed=false WHERE id=$1',
      [org.id],
    );
    let raw: unknown;
    try {
      raw = await this.cloud.appBilling(grant).listAdministrators(org.cloud_billing_account_id!);
    } catch {
      throw new CloudError(
        503,
        'ownership_unconfirmed',
        'Cloud ownership could not be confirmed. Read and export remain available.',
      );
    }
    return this.validate(raw, org);
  }
  private async project(db: PoolClient, org: Organization, snapshot: Snapshot) {
    const admins = [...snapshot.administrators].sort();
    requireCondition(
      !org.cloud_administrator_revision ||
        BigInt(snapshot.revision) >= BigInt(org.cloud_administrator_revision),
      502,
      'ownership_snapshot_stale',
      'Cloud returned an older ownership revision.',
    );
    if (snapshot.revision === org.cloud_administrator_revision)
      requireCondition(
        JSON.stringify(admins) === JSON.stringify([...(org.cloud_administrators ?? [])].sort()),
        502,
        'ownership_snapshot_conflict',
        'Cloud ownership changed without a new revision.',
      );
    const members = (
      await db.query<{ user_id: string; role: Role }>(
        'SELECT user_id,role FROM outreachr.memberships WHERE org_id=$1',
        [org.id],
      )
    ).rows;
    requireCondition(
      admins.every((id) => members.some((member) => member.user_id === id)),
      503,
      'ownership_member_missing',
      'Cloud has an owner who is not an accepted workspace member. Reconcile ownership in Cloud.',
    );
    await transaction(db, async (client) => {
      for (const member of members) {
        const role: Role = admins.includes(member.user_id)
          ? 'owner'
          : member.role === 'owner'
            ? 'member'
            : member.role;
        if (role === member.role) continue;
        await client.query(
          'UPDATE outreachr.memberships SET role=$3 WHERE org_id=$1 AND user_id=$2',
          [org.id, member.user_id, role],
        );
        // Ownership does not purchase a seat. Cloud must confirm the accepted member's desired editing access.
        await enqueueMembershipChange(client, org, member.user_id, role);
        await client.query('INSERT INTO outreachr.audit(org_id,action,detail) VALUES($1,$2,$3)', [
          org.id,
          'ownership.projected',
          JSON.stringify({ userId: member.user_id, role, revision: snapshot.revision }),
        ]);
      }
      const pending = await this.pending(client, org.id);
      if (pending && !pending.request_json && !admins.includes(pending.actor_id))
        await client.query(
          "UPDATE outreachr.cloud_ownership_jobs SET state='superseded' WHERE id=$1",
          [pending.id],
        );
      if (pending?.request_json) {
        const request = requestSchema.parse(pending.request_json);
        if (BigInt(snapshot.revision) > BigInt(request.expectedRevision)) {
          // A later canonical revision fences any unexecuted old CAS body. Project current authority, never an old receipt.
          if (desired(pending, admins))
            await client.query(
              "UPDATE outreachr.cloud_ownership_jobs SET state='reconciled' WHERE id=$1",
              [pending.id],
            );
          else if (!admins.includes(pending.actor_id))
            await client.query(
              "UPDATE outreachr.cloud_ownership_jobs SET state='superseded' WHERE id=$1",
              [pending.id],
            );
        }
      }
      await client.query(
        `UPDATE outreachr.organizations SET cloud_ownership_confirmed=true,cloud_ownership_observed_at=now(),
        cloud_administrator_revision=$2,cloud_administrators=$3,
        cloud_ownership_pending=EXISTS(SELECT 1 FROM outreachr.cloud_ownership_jobs WHERE org_id=$1 AND state='pending') WHERE id=$1`,
        [org.id, snapshot.revision, JSON.stringify(admins)],
      );
    });
  }
  async ensureCurrent(userId: string, orgId: string, grant: string, force = false) {
    return withWorkspaceLock(this.pool, orgId, async (db) => {
      const org = await memberOrganization(db, userId, orgId);
      if (
        !org.cloud_billing_account_id ||
        (org.cloud_membership_ready === false && org.role !== 'owner')
      )
        return org;
      this.scope(org);
      if (
        !force &&
        org.cloud_ownership_confirmed &&
        !org.cloud_ownership_pending &&
        org.cloud_ownership_observed_at &&
        org.cloud_ownership_observed_at.getTime() > Date.now() - 60_000
      )
        return org;
      try {
        await this.project(db, org, await this.read(db, org, grant));
      } catch (error) {
        if (force || !(error instanceof CloudError)) throw error;
      }
      return memberOrganization(db, userId, orgId);
    });
  }
  private verify(job: Job, org: Organization, userId: string) {
    this.scope(org);
    requireCondition(
      job.actor_id === userId,
      403,
      'ownership_actor_required',
      'The original requester must recover this ownership change.',
    );
    requireCondition(
      job.app_id === this.cloud.config.appId &&
        job.client_id === this.cloud.config.clientId &&
        job.billing_account_id === org.cloud_billing_account_id &&
        job.environment === this.cloud.config.billingEnvironment,
      409,
      'ownership_binding_changed',
      'The registered app changed. Reconcile the original ownership request.',
    );
  }
  private async run(db: PoolClient, org: Organization, userId: string, grant: string, job: Job) {
    this.verify(job, org, userId);
    if (!job.request_json) {
      const current = await this.read(db, org, grant);
      await this.project(db, org, current);
      if (desired(job, current.administrators)) {
        await db.query("UPDATE outreachr.cloud_ownership_jobs SET state='reconciled' WHERE id=$1", [
          job.id,
        ]);
        await db.query(
          'UPDATE outreachr.organizations SET cloud_ownership_pending=false WHERE id=$1',
          [org.id],
        );
        return;
      }
      requireCondition(
        current.administrators.includes(userId),
        403,
        'owner_required',
        'A current Cloud owner must request this ownership change.',
      );
      const request = {
        action: job.action,
        userId: job.target_id,
        expectedRevision: current.revision,
        idempotencyKey: `owner:${job.id}`,
      };
      await db.query('UPDATE outreachr.cloud_ownership_jobs SET request_json=$2 WHERE id=$1', [
        job.id,
        JSON.stringify(request),
      ]);
      job.request_json = request;
    }
    const request = requestSchema.parse(job.request_json);
    requireCondition(
      request.action === job.action &&
        request.userId === job.target_id &&
        request.idempotencyKey === `owner:${job.id}`,
      409,
      'ownership_intent_invalid',
      'The saved ownership request is inconsistent.',
    );
    let raw: unknown;
    try {
      raw = await this.cloud.appBilling(grant).changeAdministrator(job.billing_account_id, request);
    } catch (error) {
      if (
        error instanceof CloudApiError &&
        error.statusCode === 409 &&
        error.errorBody.code === 'APP_BILLING_MEMBERSHIP_REVISION_CONFLICT'
      )
        await db.query('UPDATE outreachr.cloud_ownership_jobs SET request_json=null WHERE id=$1', [
          job.id,
        ]);
      // Preserve ambiguous requests. A current canonical read may prove their effect without replaying a revoked grant.
      try {
        await this.project(
          db,
          await memberOrganization(db, userId, org.id),
          await this.read(db, org, grant),
        );
      } catch {
        /* The pending row remains durable. */
      }
      return;
    }
    const receipt = this.validate(raw, org);
    requireCondition(
      BigInt(receipt.revision) === BigInt(request.expectedRevision) + 1n &&
        desired(job, receipt.administrators),
      502,
      'ownership_receipt_invalid',
      'Cloud did not confirm the requested ownership change.',
    );
    await db.query(
      "UPDATE outreachr.cloud_ownership_jobs SET state='confirmed',response_json=$2 WHERE id=$1",
      [job.id, JSON.stringify(receipt)],
    );
    // A replayed receipt can be older than a later external transfer. Only a fresh read establishes product ownership.
    await this.project(
      db,
      await memberOrganization(db, userId, org.id),
      await this.read(db, org, grant),
    );
  }
  async change(
    userId: string,
    orgId: string,
    grant: string,
    action: Job['action'],
    targetId: string,
  ) {
    return withWorkspaceLock(this.pool, orgId, async (db) => {
      let org = await memberOrganization(db, userId, orgId);
      this.scope(org);
      const existing = await this.pending(db, orgId);
      if (existing) {
        requireCondition(
          existing.actor_id === userId &&
            existing.target_id === targetId &&
            existing.action === action,
          409,
          'ownership_change_pending',
          'Finish the pending ownership change first.',
        );
        await this.run(db, org, userId, grant, existing);
        return this.status(db, userId, orgId);
      }
      requireCondition(
        org.cloud_provisioning_state !== 'pending',
        409,
        'workspace_setup_pending',
        'Finish the original Cloud workspace setup before changing ownership.',
      );
      await this.project(db, org, await this.read(db, org, grant));
      org = await memberOrganization(db, userId, orgId);
      const target = await memberOrganization(db, targetId, orgId);
      requireCondition(
        org.role === 'owner' && org.cloud_membership_ready !== false,
        403,
        'owner_required',
        'Only a synchronized owner can change workspace ownership.',
      );
      requireCondition(
        action !== 'transfer' || userId !== targetId,
        400,
        'ownership_target_invalid',
        'Choose a different member to receive ownership.',
      );
      requireCondition(
        target.cloud_membership_ready !== false &&
          (action === 'revoke' || target.role !== 'viewer'),
        409,
        'ownership_seat_required',
        'Give this accepted member an editing seat and wait for Cloud synchronization before making them an owner.',
      );
      const blocked = (
        await db.query<{ blocked: boolean }>(
          `SELECT EXISTS(SELECT 1 FROM outreachr.cloud_billing_intents WHERE org_id=$1 AND state='pending') OR
        EXISTS(SELECT 1 FROM outreachr.cloud_membership_jobs WHERE org_id=$1 AND state='pending') AS blocked`,
          [orgId],
        )
      ).rows[0]!.blocked;
      requireCondition(
        !blocked,
        409,
        'ownership_dependencies_pending',
        'Finish pending billing and member synchronization before changing ownership.',
      );
      if (
        (action === 'grant' && target.role === 'owner') ||
        (action === 'revoke' && target.role !== 'owner')
      )
        return this.status(db, userId, orgId);
      requireCondition(
        action !== 'revoke' || (org.cloud_administrators?.length ?? 0) > 1,
        409,
        'last_owner',
        'Transfer ownership or add another owner before removing the last owner.',
      );
      const job = await transaction(db, async (client) => {
        const inserted = (
          await client.query<Job>(
            `INSERT INTO outreachr.cloud_ownership_jobs
          (id,org_id,actor_id,target_id,action,app_id,client_id,billing_account_id,environment)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
            [
              randomUUID(),
              orgId,
              userId,
              targetId,
              action,
              this.cloud.config.appId,
              this.cloud.config.clientId,
              org.cloud_billing_account_id,
              this.cloud.config.billingEnvironment,
            ],
          )
        ).rows[0]!;
        await client.query(
          'UPDATE outreachr.organizations SET cloud_ownership_pending=true WHERE id=$1',
          [orgId],
        );
        return inserted;
      });
      await this.run(db, org, userId, grant, job);
      return this.status(db, userId, orgId);
    });
  }
  private async status(db: PoolClient, userId: string, orgId: string) {
    const org = await memberOrganization(db, userId, orgId);
    return {
      confirmed: org.cloud_ownership_confirmed === true,
      pending: org.cloud_ownership_pending === true,
    };
  }
  async recover(userId: string, orgId: string, grant: string) {
    return withWorkspaceLock(this.pool, orgId, async (db) => {
      const org = await memberOrganization(db, userId, orgId);
      this.scope(org);
      const pending = await this.pending(db, orgId);
      if (pending?.actor_id === userId) await this.run(db, org, userId, grant, pending);
      else await this.project(db, org, await this.read(db, org, grant));
      return this.status(db, userId, orgId);
    });
  }
}
