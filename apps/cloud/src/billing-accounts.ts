/** Resolves product workspaces through Cloud's generic purchaser account authority. */
import type { Pool } from 'pg';
import { z } from 'zod';
import type { OutreachrDelegation } from './delegation';
import { transaction, withWorkspaceLock } from './database';
import { enqueueMembershipChange } from './billing-memberships';
import type { Role } from './plans';
import { CloudError, requireCondition } from './errors';
import { memberOrganization } from './workspaces';
import { readBillingSnapshot } from './billing-snapshot';

const accountResponse = z.object({
  success: z.literal(true),
  data: z.object({
    id: z.uuid(),
    appId: z.uuid(),
    externalReference: z.string().nullable(),
    displayName: z.string(),
    role: z.enum(['administrator', 'member']),
  }),
});

export class CloudBillingAccounts {
  constructor(
    readonly pool: Pool,
    readonly cloud: OutreachrDelegation,
    readonly productFamilyKey: string,
  ) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(productFamilyKey))
      throw new Error('A valid registered app product family is required.');
  }
  async ensureCurrent(userId: string, orgId: string, grant: string) {
    const org = await memberOrganization(this.pool, userId, orgId);
    if (!org.cloud_billing_account_id) return org;
    if (org.cloud_membership_ready === false && org.role !== 'owner') return org;
    if (
      !org.cloud_billing_invalidated &&
      org.cloud_billing_observed_at &&
      org.cloud_billing_observed_at.getTime() > Date.now() - 60_000 &&
      org.cloud_app_id === this.cloud.config.appId &&
      org.cloud_billing_environment === this.cloud.config.billingEnvironment &&
      org.cloud_product_family_key === this.productFamilyKey
    )
      return org;
    try {
      await this.snapshot(userId, orgId, grant);
    } catch (error) {
      // Preserve read/export during a Cloud outage. snapshot persists invalidation
      // before its remote read, so this cannot restore stale editing privileges.
      if (!(error instanceof CloudError) || ![502, 503].includes(error.status)) throw error;
    }
    return memberOrganization(this.pool, userId, orgId);
  }
  snapshot(userId: string, orgId: string, grant: string) {
    return withWorkspaceLock(this.pool, orgId, async (db) => {
      const org = await memberOrganization(db, userId, orgId);
      const config = this.cloud.config;
      requireCondition(
        org.cloud_membership_ready !== false || org.role === 'owner',
        403,
        'membership_pending',
        'Cloud membership is still synchronizing.',
      );
      if (org.cloud_billing_account_id)
        await db.query(
          'UPDATE outreachr.organizations SET cloud_billing_invalidated=true WHERE id=$1',
          [org.id],
        );
      requireCondition(
        org.cloud_billing_account_id &&
          org.cloud_app_id === config.appId &&
          org.cloud_billing_environment === config.billingEnvironment &&
          org.cloud_product_family_key === this.productFamilyKey,
        503,
        'billing_account_unavailable',
        'The workspace owner must connect app billing first.',
      );
      // The invalidation commit above survives any provider failure below.
      let raw: unknown;
      try {
        raw = await this.cloud
          .appBilling(grant)
          .getSubscription(org.cloud_billing_account_id, this.productFamilyKey);
      } catch {
        throw new CloudError(
          503,
          'billing_snapshot_unavailable',
          'Cloud could not confirm current workspace billing. Try again.',
        );
      }
      const result = readBillingSnapshot(raw, {
        appId: config.appId,
        environment: config.billingEnvironment,
        productFamilyKey: this.productFamilyKey,
        billingAccountId: org.cloud_billing_account_id,
        workspaceId: org.id,
      });
      const { snapshot } = result;
      const subscription = snapshot.subscription;
      const originalTrial = subscription?.trial;
      requireCondition(
        !originalTrial ||
          ((!org.trial_ends_at ||
            org.trial_ends_at.getTime() === Date.parse(originalTrial.endsAt)) &&
            (!org.trial_started_at ||
              org.trial_started_at.getTime() === Date.parse(originalTrial.startedAt))),
        409,
        'billing_trial_history_changed',
        'The original workspace trial differs from Cloud. Reconcile its history before granting access.',
      );
      await db.query(
        `UPDATE outreachr.organizations SET
        cloud_billing_access=$2,cloud_billing_valid_until=$3,cloud_billing_observed_at=$4,
        cloud_billing_invalidated=false,subscription_id=$5,subscription_status=$6,
        subscription_period_start=$7,subscription_period_end=$8,cancel_at_period_end=$9,
        plan=COALESCE($10,plan),seat_capacity=$11,
        trial_started_at=COALESCE($12,trial_started_at),trial_ends_at=COALESCE($13,trial_ends_at) WHERE id=$1`,
        [
          org.id,
          result.access,
          snapshot.entitlement?.validUntil ?? null,
          snapshot.observedAt,
          subscription?.id ?? null,
          subscription?.status ?? 'none',
          subscription?.currentPeriodStart ?? null,
          subscription?.currentPeriodEnd ?? null,
          subscription?.cancelAtPeriodEnd ?? false,
          subscription?.planKey ?? null,
          Math.min(1000, Math.max(1, snapshot.entitlement?.seatCapacity ?? 1)),
          originalTrial?.startedAt ?? null,
          originalTrial?.endsAt ?? null,
        ],
      );
      return result;
    });
  }
  resolveOwner(userId: string, orgId: string, grant: string) {
    return withWorkspaceLock(this.pool, orgId, async (db) => {
      const org = await memberOrganization(db, userId, orgId);
      requireCondition(
        org.role === 'owner',
        403,
        'owner_required',
        'Only workspace owners can connect workspace billing.',
      );
      const config = this.cloud.config;
      if (org.cloud_billing_account_id)
        requireCondition(
          org.cloud_app_id === config.appId &&
            org.cloud_billing_environment === config.billingEnvironment &&
            org.cloud_product_family_key === this.productFamilyKey,
          409,
          'billing_binding_changed',
          'This workspace is bound to a different app billing registration.',
        );
      let raw: unknown;
      try {
        raw = await this.cloud.appBilling(grant).resolveAccount({
          externalReference: org.id,
          displayName: org.name,
        });
      } catch {
        throw new CloudError(
          503,
          'billing_account_unavailable',
          'Cloud could not confirm this workspace billing account. Try again with the same workspace.',
        );
      }
      const parsed = accountResponse.safeParse(raw);
      requireCondition(
        parsed.success,
        502,
        'billing_account_invalid',
        'Cloud returned an invalid billing account.',
      );
      const account = parsed.data.data;
      requireCondition(
        account.appId === config.appId &&
          account.externalReference === org.id &&
          account.role === 'administrator',
        502,
        'billing_account_scope',
        'Cloud did not confirm ownership of this workspace billing account.',
      );
      requireCondition(
        !org.cloud_billing_account_id || org.cloud_billing_account_id === account.id,
        409,
        'billing_account_changed',
        'The established workspace billing account cannot be replaced.',
      );
      await transaction(db, async (client) => {
        await client.query(
          `UPDATE outreachr.organizations SET cloud_app_id=$2,cloud_billing_account_id=$3,
        cloud_billing_environment=$4,cloud_product_family_key=$5 WHERE id=$1`,
          [org.id, config.appId, account.id, config.billingEnvironment, this.productFamilyKey],
        );
        const linked = {
          ...org,
          cloud_app_id: config.appId,
          cloud_billing_account_id: account.id,
          cloud_billing_environment: config.billingEnvironment,
          cloud_product_family_key: this.productFamilyKey,
        };
        const pending = await client.query<{ user_id: string; role: Role }>(
          'SELECT user_id,role FROM outreachr.memberships WHERE org_id=$1 AND cloud_sync_job_id IS NULL',
          [org.id],
        );
        for (const member of pending.rows)
          await enqueueMembershipChange(client, linked, member.user_id, member.role);
      });
      return {
        billingAccountId: account.id,
        productFamilyKey: this.productFamilyKey,
        environment: config.billingEnvironment,
      };
    });
  }
}
