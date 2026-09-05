/** Projects verified Stripe subscriptions into workspace access under the workspace lock. */
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import type { ElizaClient } from './eliza';
import { withWorkspaceLock } from './database';
import { requireCondition } from './errors';
import { memberOrganization, type Organization } from './workspaces';
import type { Plan } from './plans';

const url = z.url().refine((value) => {
  const parsed = new URL(value);
  return (
    parsed.protocol === 'https:' &&
    ['checkout.stripe.com', 'billing.stripe.com'].includes(parsed.hostname) &&
    !parsed.username &&
    !parsed.password
  );
});
const checkout = z.object({
  sessionId: z.string().startsWith('cs_'),
  url: url.nullable(),
  status: z.enum(['open', 'complete', 'expired']),
});
const subscriptions = z.object({
  subscriptions: z.array(
    z.object({
      id: z.string().startsWith('sub_'),
      status: z.string(),
      plan: z.enum(['sol', 'astra']),
      seats: z.number().int().min(1).max(1000),
      periodStart: z.number().int().positive(),
      periodEnd: z.number().int().positive(),
      cancelAtPeriodEnd: z.boolean(),
      created: z.number().int(),
    }),
  ),
});
interface Attempt {
  id: string;
  plan: Plan;
  seats: number;
  session_id: string | null;
  status: string;
}

export class BillingStore {
  constructor(
    readonly pool: Pool,
    readonly eliza: ElizaClient,
  ) {}

  private async reconcileLocked(client: PoolClient, orgId: string) {
    const org = (
      await client.query<Organization>('SELECT * FROM outreachr.organizations WHERE id=$1', [orgId])
    ).rows[0];
    if (!org?.stripe_customer_id) return;
    const response = await this.eliza.billing(
      { action: 'subscriptions', workspaceId: orgId, customerId: org.stripe_customer_id },
      subscriptions,
    );
    const live = response.subscriptions.filter(
      (sub) => !['canceled', 'incomplete_expired'].includes(sub.status),
    );
    if (live.length > 1)
      await client.query(
        "UPDATE outreachr.organizations SET subscription_status='unavailable' WHERE id=$1",
        [orgId],
      );
    requireCondition(
      live.length <= 1,
      409,
      'duplicate_subscriptions',
      'Multiple active subscriptions require billing reconciliation.',
    );
    const selected =
      live[0] ?? [...response.subscriptions].sort((a, b) => b.created - a.created)[0];
    if (selected) {
      if (selected.periodEnd <= selected.periodStart)
        await client.query(
          "UPDATE outreachr.organizations SET subscription_status='unavailable' WHERE id=$1",
          [orgId],
        );
      requireCondition(
        selected.periodEnd > selected.periodStart,
        502,
        'billing_period_invalid',
        'The billing provider returned an invalid period.',
      );
      await client.query(
        `UPDATE outreachr.organizations SET subscription_id=$2,subscription_status=$3,plan=$4,seat_capacity=$5,subscription_period_start=$6,subscription_period_end=$7,cancel_at_period_end=$8 WHERE id=$1`,
        [
          orgId,
          selected.id,
          selected.status,
          selected.plan,
          selected.seats,
          new Date(selected.periodStart * 1000),
          new Date(selected.periodEnd * 1000),
          selected.cancelAtPeriodEnd,
        ],
      );
    } else if (org.subscription_id) {
      // Missing provider authority must never preserve paid access from a stale projection.
      await client.query(
        "UPDATE outreachr.organizations SET subscription_status='unavailable' WHERE id=$1",
        [orgId],
      );
    }
  }

  async reconcile(orgId: string) {
    return withWorkspaceLock(this.pool, orgId, (client) => this.reconcileLocked(client, orgId));
  }

  async reconcileMember(userId: string, orgId: string) {
    await memberOrganization(this.pool, userId, orgId);
    await this.reconcile(orgId);
  }

  async webhook(payload: string, signature: string) {
    const event = await this.eliza.billing(
      { action: 'event', payload, signature },
      z.object({ eventId: z.string(), workspaceId: z.string().uuid().nullable() }),
    );
    if (!event.workspaceId) return;
    await withWorkspaceLock(this.pool, event.workspaceId, async (client) => {
      const recorded = await client.query('SELECT id FROM outreachr.billing_events WHERE id=$1', [
        event.eventId,
      ]);
      if (recorded.rowCount) return;
      const exists = await client.query('SELECT id FROM outreachr.organizations WHERE id=$1', [
        event.workspaceId,
      ]);
      if (!exists.rowCount) return;
      await this.reconcileLocked(client, event.workspaceId!);
      // Retrying after a crash before this write re-reads current Stripe state, never the old event.
      await client.query(
        'INSERT INTO outreachr.billing_events(id) VALUES($1) ON CONFLICT DO NOTHING',
        [event.eventId],
      );
    });
  }

  async open(userId: string, orgId: string, change?: { plan: Plan; seats: number }) {
    return withWorkspaceLock(this.pool, orgId, async (client) => {
      let org = await memberOrganization(client, userId, orgId);
      requireCondition(
        org.role === 'owner',
        403,
        'owner_required',
        'Only workspace owners can purchase or manage a subscription.',
      );
      const editors = (
        await client.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM outreachr.memberships WHERE org_id=$1 AND role!='viewer'",
          [orgId],
        )
      ).rows[0]!.count;
      if (change)
        requireCondition(
          change.seats >= editors,
          409,
          'seats_in_use',
          'Choose at least as many seats as current editing members.',
        );
      if (!org.stripe_customer_id) {
        const customer = await this.eliza.billing(
          { action: 'customer', workspaceId: orgId },
          z.object({ customerId: z.string().startsWith('cus_') }),
        );
        await client.query('UPDATE outreachr.organizations SET stripe_customer_id=$2 WHERE id=$1', [
          orgId,
          customer.customerId,
        ]);
      }
      await this.reconcileLocked(client, orgId);
      org = await memberOrganization(client, userId, orgId);
      const customerId = org.stripe_customer_id!;
      if (
        !change ||
        (org.subscription_id &&
          !['canceled', 'incomplete_expired'].includes(org.subscription_status))
      ) {
        return this.eliza.billing(
          {
            action: 'portal',
            workspaceId: orgId,
            customerId,
            attemptId: randomUUID(),
            minimumSeats: Math.max(1, editors),
            ...(change && org.subscription_id
              ? { update: { subscriptionId: org.subscription_id, ...change } }
              : {}),
          },
          z.object({ url }),
        );
      }
      const attempt = (
        await client.query<Attempt>(
          "SELECT * FROM outreachr.checkout_attempts WHERE org_id=$1 AND status='pending' ORDER BY created_at DESC LIMIT 1",
          [orgId],
        )
      ).rows[0];
      if (attempt) {
        // Recover a timed-out create with identical arguments before changing or expiring it.
        let current = attempt.session_id
          ? await this.eliza.billing(
              {
                action: 'checkoutStatus',
                workspaceId: orgId,
                customerId,
                sessionId: attempt.session_id,
              },
              checkout,
            )
          : await this.eliza.billing(
              {
                action: 'checkout',
                workspaceId: orgId,
                customerId,
                attemptId: attempt.id,
                plan: attempt.plan,
                seats: attempt.seats,
              },
              checkout,
            );
        if (!attempt.session_id)
          await client.query('UPDATE outreachr.checkout_attempts SET session_id=$2 WHERE id=$1', [
            attempt.id,
            current.sessionId,
          ]);
        if (
          current.status === 'open' &&
          (attempt.plan !== change.plan || attempt.seats !== change.seats)
        )
          current = await this.eliza.billing(
            {
              action: 'expireCheckout',
              workspaceId: orgId,
              customerId,
              sessionId: current.sessionId,
            },
            checkout,
          );
        if (current.status === 'open') {
          requireCondition(
            current.url,
            502,
            'checkout_unavailable',
            'Checkout URL is unavailable.',
          );
          return { url: current.url };
        }
        await client.query('UPDATE outreachr.checkout_attempts SET status=$2 WHERE id=$1', [
          attempt.id,
          current.status,
        ]);
        if (current.status === 'complete') {
          await this.reconcileLocked(client, orgId);
          requireCondition(
            false,
            409,
            'checkout_completed',
            'Payment was submitted. Refresh billing before opening another checkout.',
          );
        }
      }
      const attemptId = randomUUID();
      await client.query(
        "INSERT INTO outreachr.checkout_attempts(id,org_id,plan,seats,status) VALUES($1,$2,$3,$4,'pending')",
        [attemptId, orgId, change.plan, change.seats],
      );
      const created = await this.eliza.billing(
        { action: 'checkout', workspaceId: orgId, customerId, attemptId, ...change },
        checkout,
      );
      await client.query('UPDATE outreachr.checkout_attempts SET session_id=$2 WHERE id=$1', [
        attemptId,
        created.sessionId,
      ]);
      requireCondition(
        created.status === 'open' && created.url,
        502,
        'checkout_unavailable',
        'A payable checkout was not returned.',
      );
      return { url: created.url };
    });
  }
}
