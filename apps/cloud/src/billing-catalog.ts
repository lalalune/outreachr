/** Checks Cloud plan revisions against the product terms shown before checkout. */
import { z } from 'zod';
import { CloudError, requireCondition } from './errors';
import { PLANS, TRIAL_AI_CENTS, TRIAL_DAYS, type Plan } from './plans';

const usd = z.string().regex(/^(0|[1-9]\d*)(\.\d{1,6})?$/);
const planRevision = z.object({
  id: z.uuid(),
  appId: z.uuid(),
  productFamilyKey: z.string().min(1),
  planKey: z.string().min(1),
  revision: z.string().regex(/^[1-9]\d*$/),
  amountCents: z.number().int().nonnegative().safe(),
  currency: z.string(),
  interval: z.enum(['day', 'week', 'month', 'year']),
  intervalCount: z.number().int().positive(),
  seats: z.object({ minimum: z.number().int().positive(), maximum: z.number().int().positive() }),
  trial: z.object({
    days: z.number().int(),
    paymentMethodRequired: z.boolean(),
    allowanceUsd: usd,
  }),
  allowanceUsd: usd,
  featureKeys: z.array(z.string()),
  expiredAccess: z.enum(['read_only', 'denied']),
});
const catalog = z.object({
  success: z.literal(true),
  data: z.object({
    appId: z.uuid(),
    environment: z.enum(['test', 'live']),
    plans: z.array(planRevision),
  }),
});

function microUsd(value: string): bigint {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
}

export interface ProductBillingBinding {
  appId: string;
  environment: 'test' | 'live';
  productFamilyKey: string;
}

export function selectCheckoutPlan(
  response: unknown,
  binding: ProductBillingBinding,
  choice: { plan: Plan; seats: number; assignedSeats: number },
) {
  const parsed = catalog.safeParse(response);
  if (!parsed.success)
    throw new CloudError(
      502,
      'billing_catalog_invalid',
      'Cloud returned an invalid app billing catalog.',
    );
  const { data } = parsed.data;
  requireCondition(
    data.appId === binding.appId && data.environment === binding.environment,
    502,
    'billing_catalog_scope',
    'Cloud returned billing terms for a different app or environment.',
  );
  const matches = data.plans.filter(
    (plan) => plan.productFamilyKey === binding.productFamilyKey && plan.planKey === choice.plan,
  );
  requireCondition(
    matches.length === 1,
    503,
    'billing_plan_unavailable',
    'The selected plan is not currently available.',
  );
  const selected = matches[0]!;
  const expected = PLANS[choice.plan];
  requireCondition(
    selected.appId === binding.appId &&
      selected.amountCents === expected.monthlyCents &&
      selected.currency === 'usd' &&
      selected.interval === 'month' &&
      selected.intervalCount === 1 &&
      selected.trial.days === TRIAL_DAYS &&
      !selected.trial.paymentMethodRequired &&
      microUsd(selected.trial.allowanceUsd) === BigInt(TRIAL_AI_CENTS) * 10_000n &&
      microUsd(selected.allowanceUsd) === BigInt(expected.aiAllowanceCents) * 10_000n &&
      selected.expiredAccess === 'read_only' &&
      selected.seats.minimum <= selected.seats.maximum,
    503,
    'billing_terms_changed',
    'The available billing terms differ from the displayed plan. Refresh before subscribing.',
  );
  requireCondition(
    Number.isSafeInteger(choice.seats) &&
      choice.seats >= selected.seats.minimum &&
      choice.seats <= Math.min(selected.seats.maximum, 1000) &&
      Number.isSafeInteger(choice.assignedSeats) &&
      choice.assignedSeats >= 0 &&
      choice.seats >= choice.assignedSeats,
    409,
    'billing_seats_invalid',
    'Choose enough seats for all editing members within the plan limit.',
  );
  return {
    planRevisionId: selected.id,
    plan: choice.plan,
    seats: choice.seats,
    monthlyTotalCents: selected.amountCents * choice.seats,
    currency: 'usd' as const,
    model: expected.model,
  };
}
