/** Preserves product-owned billing assertions formerly embedded in the Cloud bridge. */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { selectCheckoutPlan } from '../../src/billing-catalog';

const binding = {
  appId: randomUUID(),
  environment: 'test' as const,
  productFamilyKey: 'workspace',
};
function terms(overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    appId: binding.appId,
    productFamilyKey: 'workspace',
    planKey: 'sol',
    revision: '1',
    amountCents: 4900,
    currency: 'usd',
    interval: 'month',
    intervalCount: 1,
    seats: { minimum: 1, maximum: 1000 },
    trial: { days: 7, paymentMethodRequired: false, allowanceUsd: '2.000000' },
    allowanceUsd: '15.000000',
    featureKeys: [],
    expiredAccess: 'read_only',
    ...overrides,
  };
}
const envelope = (plans: unknown[]) => ({ success: true, data: { ...binding, plans } });
const choice = { plan: 'sol' as const, seats: 3, assignedSeats: 2 };

describe('Outreachr checkout catalog', () => {
  it('resolves the immutable revision and reviewed $147 three-seat monthly total', () => {
    const selected = terms();
    expect(selectCheckoutPlan(envelope([selected]), binding, choice)).toEqual({
      planRevisionId: selected.id,
      plan: 'sol',
      seats: 3,
      monthlyTotalCents: 14700,
      currency: 'usd',
      model: 'openai/gpt-5.6-sol',
    });
  });
  it('resolves Astra at $200 per editing seat with its own model and fixed workspace allowance', () => {
    const selected = terms({ planKey: 'astra', amountCents: 20000, allowanceUsd: '70' });
    expect(
      selectCheckoutPlan(envelope([terms(), selected]), binding, { ...choice, plan: 'astra' }),
    ).toMatchObject({
      planRevisionId: selected.id,
      monthlyTotalCents: 60000,
      model: 'openai/gpt-6-astra',
    });
  });
  it.each([
    { appId: randomUUID() },
    { amountCents: 3000 },
    { currency: 'eur' },
    { interval: 'year' },
    { intervalCount: 2 },
    { allowanceUsd: '14.999999' },
    { expiredAccess: 'denied' },
    { trial: { days: 8, paymentMethodRequired: false, allowanceUsd: '2' } },
    { trial: { days: 7, paymentMethodRequired: true, allowanceUsd: '2' } },
    { trial: { days: 7, paymentMethodRequired: false, allowanceUsd: '1.999999' } },
  ])('rejects altered product terms before purchasing: %j', (overrides) => {
    expect(() => selectCheckoutPlan(envelope([terms(overrides)]), binding, choice)).toThrow(
      expect.objectContaining({ code: 'billing_terms_changed' }),
    );
  });
  it.each([{ environment: 'live' }, { appId: randomUUID() }])(
    'rejects foreign catalog authority %j',
    (change) => {
      const response = envelope([terms()]);
      expect(() =>
        selectCheckoutPlan({ ...response, data: { ...response.data, ...change } }, binding, choice),
      ).toThrow(expect.objectContaining({ code: 'billing_catalog_scope' }));
    },
  );
  it('rejects ambiguous revisions and excludes personal Eliza plans', () => {
    for (const plans of [[terms(), terms()], [terms({ productFamilyKey: 'personal-agent' })]])
      expect(() => selectCheckoutPlan(envelope(plans), binding, choice)).toThrow(
        expect.objectContaining({ code: 'billing_plan_unavailable' }),
      );
  });
  it.each([0, 1, 2.5, 1001])('rejects invalid or insufficient seat count %s', (seats) => {
    expect(() => selectCheckoutPlan(envelope([terms()]), binding, { ...choice, seats })).toThrow(
      expect.objectContaining({ code: 'billing_seats_invalid' }),
    );
  });
  it('rejects malformed money and false success', () => {
    for (const response of [
      envelope([terms({ allowanceUsd: '1.5e1' })]),
      { ...envelope([terms()]), success: false },
    ])
      expect(() => selectCheckoutPlan(response, binding, choice)).toThrow(
        expect.objectContaining({ code: 'billing_catalog_invalid' }),
      );
  });
});
