/** Guards expiry and paid access against stale checkout and canceled subscription state. */
import { describe, expect, it } from 'vitest';
import { entitlement, type Organization } from '../../src/workspaces';

const now = new Date('2026-09-04T12:00:00Z');
const org: Organization = {
  id: 'workspace',
  name: 'Workspace',
  plan: 'astra',
  role: 'owner',
  seat_capacity: 2,
  trial_ends_at: new Date(now.getTime() + 1000),
  subscription_id: null,
  subscription_status: 'none',
  subscription_period_start: null,
  subscription_period_end: null,
  stripe_customer_id: null,
  cancel_at_period_end: false,
};
describe('entitlements', () => {
  it('expires the trial at the exact boundary without deleting read access', () => {
    expect(entitlement(org, now).canEdit).toBe(true);
    expect(entitlement(org, org.trial_ends_at!).canEdit).toBe(false);
    expect(entitlement({ ...org, role: 'viewer' }, now).canEdit).toBe(false);
  });
  it('does not accept a checkout, unpaid, or canceled subscription as paid access', () => {
    for (const status of ['incomplete', 'past_due', 'canceled', 'unpaid', 'paused']) {
      expect(
        entitlement(
          {
            ...org,
            subscription_id: 'sub_1',
            subscription_status: status,
            subscription_period_end: new Date(now.getTime() + 1000),
          },
          now,
        ).canEdit,
      ).toBe(false);
    }
  });
  it('permits a paid cancellation scheduled at period end only until that boundary', () => {
    const paid = {
      ...org,
      subscription_id: 'sub_1',
      subscription_status: 'active',
      subscription_period_start: now,
      subscription_period_end: new Date(now.getTime() + 1000),
      cancel_at_period_end: true,
    };
    expect(entitlement(paid, now).canEdit).toBe(true);
    expect(entitlement(paid, paid.subscription_period_end).canEdit).toBe(false);
  });
});
