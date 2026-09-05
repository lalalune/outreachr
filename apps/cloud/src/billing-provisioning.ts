/** Resumes first-signup Cloud setup without storing purchaser credentials or inventing trial access. */
import type { Pool } from 'pg';
import type { OutreachrDelegation } from './delegation';
import { BillingStore } from './billing';
import { CloudBillingAccounts } from './billing-accounts';
import { CloudMembershipSync } from './billing-memberships';
import { CloudError, requireCondition } from './errors';
import { memberOrganization } from './workspaces';

export class CloudProvisioning {
  readonly accounts: CloudBillingAccounts;
  readonly billing: BillingStore;
  readonly memberships: CloudMembershipSync;
  constructor(
    readonly pool: Pool,
    readonly cloud: OutreachrDelegation,
    readonly productFamilyKey: string,
  ) {
    this.accounts = new CloudBillingAccounts(pool, cloud, productFamilyKey);
    this.billing = new BillingStore(pool, cloud, productFamilyKey);
    this.memberships = new CloudMembershipSync(pool, cloud, productFamilyKey);
  }
  async resume(userId: string, orgId: string, grant: string) {
    let org = await memberOrganization(this.pool, userId, orgId);
    if (
      org.cloud_provisioning_state !== 'pending' ||
      org.created_by !== userId ||
      org.role !== 'owner'
    )
      return org;
    try {
      if (!org.cloud_billing_account_id) await this.accounts.resolveOwner(userId, orgId, grant);
      if (org.cloud_trial_requested) {
        const progress = await this.billing.startTrial(userId, orgId, grant);
        if (progress?.operation?.status === 'failed' && !progress.operation.error.retryable) {
          await this.pool.query(
            "UPDATE outreachr.organizations SET cloud_provisioning_state='failed',cloud_provisioning_error=$2 WHERE id=$1 AND cloud_provisioning_state='pending'",
            [orgId, progress.operation.error.code],
          );
          return memberOrganization(this.pool, userId, orgId);
        }
        if (progress?.state === 'pending') return memberOrganization(this.pool, userId, orgId);
      }
      let { snapshot, access } = await this.accounts.snapshot(userId, orgId, grant);
      if (snapshot.entitlement) await this.memberships.runOrg(orgId, 20);
      org = await memberOrganization(this.pool, userId, orgId);
      if (org.cloud_billing_invalidated) {
        ({ snapshot, access } = await this.accounts.snapshot(userId, orgId, grant));
        org = await memberOrganization(this.pool, userId, orgId);
      }
      const state = !org.cloud_trial_requested
        ? 'ready'
        : snapshot.subscription
          ? access !== 'granted' || org.cloud_membership_ready !== false
            ? 'ready'
            : 'pending'
          : snapshot.trialEligibility.status === 'claimed'
            ? 'ineligible'
            : 'pending';
      await this.pool.query(
        "UPDATE outreachr.organizations SET cloud_provisioning_state=$2,cloud_provisioning_error=null WHERE id=$1 AND cloud_provisioning_state='pending'",
        [orgId, state],
      );
    } catch (error) {
      // An outage never falls back to a local trial. Pending exact intents remain recoverable.
      await this.pool.query(
        "UPDATE outreachr.organizations SET cloud_provisioning_error=$2 WHERE id=$1 AND cloud_provisioning_state='pending'",
        [orgId, error instanceof CloudError ? error.code : 'provisioning_unconfirmed'],
      );
    }
    return memberOrganization(this.pool, userId, orgId);
  }
  async retry(userId: string, orgId: string, grant: string) {
    const org = await memberOrganization(this.pool, userId, orgId);
    requireCondition(
      org.created_by === userId && org.role === 'owner',
      403,
      'setup_owner_required',
      'The workspace creator must finish its original Cloud setup.',
    );
    requireCondition(
      org.cloud_provisioning_state !== 'migration_required',
      409,
      'billing_migration_required',
      'Reconcile the original workspace billing history before completing Cloud setup.',
    );
    await this.pool.query(
      "UPDATE outreachr.organizations SET cloud_provisioning_state='pending',cloud_provisioning_error=null WHERE id=$1 AND cloud_provisioning_state='failed'",
      [orgId],
    );
    return this.resume(userId, orgId, grant);
  }
}
