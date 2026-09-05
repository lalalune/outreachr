/** Validates Cloud authority before exposing a workspace's subscription and allowance. */
import { z } from 'zod';
import type { ProductBillingBinding } from './billing-catalog';
import { requireCondition } from './errors';

const revision = z.string().regex(/^[1-9]\d*$/);
const instant = z.iso.datetime({ offset: true });
const usd = z.string().regex(/^(0|[1-9]\d*)(\.\d{1,6})?$/);
const scope = {
  appId: z.uuid(),
  environment: z.enum(['test', 'live']),
  billingAccountId: z.uuid(),
  productFamilyKey: z.string().min(1),
};
const actionUrl = z.url().refine((value) => {
  const url = new URL(value);
  return (
    url.protocol === 'https:' &&
    ['checkout.stripe.com', 'billing.stripe.com', 'invoice.stripe.com'].includes(url.hostname) &&
    !url.username &&
    !url.password &&
    !url.port
  );
});
export const billingOperation = z.intersection(
  z.object({ ...scope, id: z.uuid() }),
  z.discriminatedUnion('status', [
    z.object({ status: z.literal('pending'), retryAfterSeconds: z.number().int().nonnegative() }),
    z.object({
      status: z.literal('outcome_unknown'),
      retryAfterSeconds: z.number().int().nonnegative(),
    }),
    z.object({
      status: z.literal('requires_action'),
      action: z
        .object({
          kind: z.enum(['checkout', 'portal', 'payment']),
          url: actionUrl,
          expiresAt: instant.nullable(),
        })
        .refine(
          (action) =>
            new URL(action.url).hostname ===
            {
              checkout: 'checkout.stripe.com',
              portal: 'billing.stripe.com',
              payment: 'invoice.stripe.com',
            }[action.kind],
        ),
    }),
    z.object({ status: z.literal('succeeded'), subscriptionRevision: revision.nullable() }),
    z.object({
      status: z.literal('failed'),
      error: z.object({ code: z.string(), message: z.string(), retryable: z.boolean() }),
    }),
  ]),
);
const trial = z.object({ startedAt: instant, endsAt: instant });
const snapshot = z.object({
  success: z.literal(true),
  data: z.object({
    mutationRevision: revision.nullable(),
    pendingOperation: billingOperation.nullable(),
    account: z.object({
      id: z.uuid(),
      appId: z.uuid(),
      externalReference: z.string().nullable(),
      displayName: z.string(),
      role: z.enum(['administrator', 'member']),
    }),
    environment: scope.environment,
    productFamilyKey: scope.productFamilyKey,
    observedAt: instant,
    subscription: z
      .object({
        ...scope,
        id: z.uuid(),
        planRevisionId: z.uuid(),
        planKey: z.enum(['sol', 'astra']),
        revision,
        status: z.enum([
          'incomplete',
          'incomplete_expired',
          'trialing',
          'active',
          'past_due',
          'canceled',
          'unpaid',
          'paused',
        ]),
        quantity: z.number().int().positive().safe(),
        currentPeriodStart: instant,
        currentPeriodEnd: instant,
        trial: trial.nullable(),
        cancelAtPeriodEnd: z.boolean(),
        canceledAt: instant.nullable(),
      })
      .nullable(),
    entitlement: z
      .object({
        sourceSubscriptionRevision: revision,
        access: z.enum(['granted', 'read_only', 'denied']),
        featureKeys: z.array(z.string()),
        seatCapacity: z.number().int().nonnegative().safe(),
        assignedSeats: z.number().int().nonnegative().safe(),
        validUntil: instant,
      })
      .nullable(),
    allowances: z.array(
      z.object({
        source: z.enum(['trial', 'paid_invoice']),
        amountUsd: usd,
        usedUsd: usd,
        reservedUsd: usd,
        remainingUsd: usd,
        expiresAt: instant,
      }),
    ),
    trialEligibility: z.discriminatedUnion('status', [
      z.object({ status: z.literal('eligible') }),
      trial.extend({ status: z.literal('claimed') }),
    ]),
  }),
});

export interface WorkspaceBillingBinding extends ProductBillingBinding {
  billingAccountId: string;
  workspaceId: string;
}

export function readBillingSnapshot(
  response: unknown,
  binding: WorkspaceBillingBinding,
  now = new Date(),
) {
  const parsed = snapshot.safeParse(response);
  requireCondition(
    parsed.success,
    502,
    'billing_snapshot_invalid',
    'Cloud returned invalid workspace billing data.',
  );
  const data = parsed.data.data;
  const sameScope = (
    value: z.infer<typeof billingOperation> | NonNullable<typeof data.subscription>,
  ) =>
    value.appId === binding.appId &&
    value.environment === binding.environment &&
    value.billingAccountId === binding.billingAccountId &&
    value.productFamilyKey === binding.productFamilyKey;
  requireCondition(
    data.account.appId === binding.appId &&
      data.account.id === binding.billingAccountId &&
      data.account.externalReference === binding.workspaceId &&
      data.environment === binding.environment &&
      data.productFamilyKey === binding.productFamilyKey &&
      (!data.subscription || sameScope(data.subscription)) &&
      (!data.pendingOperation || sameScope(data.pendingOperation)),
    502,
    'billing_snapshot_scope',
    'Cloud returned billing data for a different workspace or app.',
  );
  const observedAt = Date.parse(data.observedAt);
  requireCondition(
    observedAt <= now.getTime() + 60_000 && observedAt >= now.getTime() - 300_000,
    503,
    'billing_snapshot_stale',
    'Refresh workspace billing to obtain current access.',
  );
  const ordered = (value: z.infer<typeof trial>) =>
    Date.parse(value.endsAt) > Date.parse(value.startedAt);
  requireCondition(
    (!data.subscription ||
      (Date.parse(data.subscription.currentPeriodEnd) >
        Date.parse(data.subscription.currentPeriodStart) &&
        (!data.subscription.trial || ordered(data.subscription.trial)))) &&
      (data.trialEligibility.status !== 'claimed' || ordered(data.trialEligibility)) &&
      (!data.entitlement ||
        (data.subscription &&
          data.entitlement.sourceSubscriptionRevision === data.subscription.revision &&
          data.entitlement.seatCapacity === data.subscription.quantity)) &&
      (data.subscription !== null || (data.entitlement === null && data.allowances.length === 0)),
    502,
    'billing_snapshot_inconsistent',
    'Cloud billing requires reconciliation before access can be confirmed.',
  );
  // A delayed response cannot extend a grant past its authoritative deadline.
  // Preserve the raw snapshot for revision-based commands; consumers use this explicit access result.
  const access =
    data.entitlement?.access === 'granted' &&
    (Date.parse(data.entitlement.validUntil) <= now.getTime() ||
      (data.subscription && Date.parse(data.subscription.currentPeriodStart) > now.getTime()))
      ? ('read_only' as const)
      : (data.entitlement?.access ?? ('read_only' as const));
  return { snapshot: data, access };
}
