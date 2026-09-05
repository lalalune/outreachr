/** A foreign, stale or inconsistent billing response must not grant workspace access. */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { readBillingSnapshot } from '../../src/billing-snapshot';
import { cloudAllowanceSummary } from '../../src/billing-allowance';

const now = new Date('2026-09-05T12:00:00Z');
const binding = {
  appId: randomUUID(),
  billingAccountId: randomUUID(),
  workspaceId: randomUUID(),
  productFamilyKey: 'workspace',
  environment: 'test' as const,
};
function response() {
  return {
    success: true,
    data: {
      account: {
        id: binding.billingAccountId,
        appId: binding.appId,
        externalReference: binding.workspaceId,
        displayName: 'My workspace',
        role: 'administrator',
      },
      environment: 'test',
      productFamilyKey: 'workspace',
      observedAt: now.toISOString(),
      mutationRevision: '2',
      pendingOperation: null as unknown,
      subscription: {
        ...binding,
        id: randomUUID(),
        planRevisionId: randomUUID(),
        planKey: 'sol',
        revision: '2',
        status: 'active',
        quantity: 3,
        currentPeriodStart: '2026-09-01T00:00:00Z',
        currentPeriodEnd: '2026-10-01T00:00:00Z',
        trial: null,
        cancelAtPeriodEnd: false,
        canceledAt: null,
      },
      entitlement: {
        sourceSubscriptionRevision: '2',
        access: 'granted',
        featureKeys: ['ai'],
        seatCapacity: 3,
        assignedSeats: 2,
        validUntil: '2026-10-01T00:00:00Z',
      },
      allowances: [
        {
          source: 'paid_invoice',
          amountUsd: '15.000000',
          usedUsd: '1.123456',
          reservedUsd: '2.000000',
          remainingUsd: '11.876544',
          expiresAt: '2026-10-01T00:00:00Z',
        },
      ],
      trialEligibility: {
        status: 'claimed',
        startedAt: '2026-08-01T00:00:00Z',
        endsAt: '2026-08-08T00:00:00Z',
      },
    },
  };
}
describe('Cloud workspace billing snapshots', () => {
  it('preserves exact allowance decimals, revisions and the original expired trial', () => {
    const input = response();
    const result = readBillingSnapshot(input, binding, now);
    expect(result.access).toBe('granted');
    expect(result.snapshot.allowances).toEqual(input.data.allowances);
    expect(result.snapshot.trialEligibility).toEqual(input.data.trialEligibility);
    expect(result.snapshot.mutationRevision).toBe('2');
    expect(result.snapshot.subscription?.planKey).toBe('sol');
  });
  it('requires historical product plan identity and consistent purchased seat quantity', () => {
    const unknown = response();
    unknown.data.subscription.planKey = 'personal-agent';
    const mixedSeats = response();
    mixedSeats.data.entitlement.seatCapacity = 100;
    for (const value of [unknown, mixedSeats])
      expect(() => readBillingSnapshot(value, binding, now)).toThrow();
    const future = response();
    future.data.subscription.currentPeriodStart = '2026-09-06T00:00:00Z';
    expect(readBillingSnapshot(future, binding, now).access).toBe('read_only');
  });
  it.each([
    { appId: randomUUID() },
    { billingAccountId: randomUUID() },
    { workspaceId: randomUUID() },
    { environment: 'live' as const },
    { productFamilyKey: 'personal-agent' },
  ])('rejects a different workspace binding %j', (change) => {
    expect(() => readBillingSnapshot(response(), { ...binding, ...change }, now)).toThrow(
      expect.objectContaining({ code: 'billing_snapshot_scope' }),
    );
  });
  it('checks nested subscription and operation scopes independently', () => {
    const foreignSubscription = response();
    foreignSubscription.data.subscription.appId = randomUUID();
    const foreignOperation = response();
    foreignOperation.data.pendingOperation = {
      ...binding,
      billingAccountId: randomUUID(),
      id: randomUUID(),
      status: 'outcome_unknown',
      retryAfterSeconds: 10,
    };
    for (const input of [foreignSubscription, foreignOperation])
      expect(() => readBillingSnapshot(input, binding, now)).toThrow(
        expect.objectContaining({ code: 'billing_snapshot_scope' }),
      );
  });
  it('retains an uncertain command for recovery without treating it as paid access', () => {
    const input = response();
    input.data.pendingOperation = {
      ...binding,
      id: randomUUID(),
      status: 'outcome_unknown',
      retryAfterSeconds: 10,
    };
    input.data.entitlement.access = 'read_only';
    const result = readBillingSnapshot(input, binding, now);
    expect(result.access).toBe('read_only');
    expect(result.snapshot.pendingOperation?.status).toBe('outcome_unknown');
  });
  it.each(['2026-09-05T11:54:59Z', '2026-09-05T12:01:01Z'])(
    'rejects stale or future observation %s',
    (observedAt) => {
      const input = response();
      input.data.observedAt = observedAt;
      expect(() => readBillingSnapshot(input, binding, now)).toThrow(
        expect.objectContaining({ code: 'billing_snapshot_stale' }),
      );
    },
  );
  it('stops editing at the entitlement deadline even when a response was just observed', () => {
    const input = response();
    input.data.entitlement.validUntil = now.toISOString();
    expect(readBillingSnapshot(input, binding, now).access).toBe('read_only');
  });
  it('rejects mixed entitlement revisions and invalid period ordering', () => {
    const mixed = response();
    mixed.data.entitlement.sourceSubscriptionRevision = '1';
    const inverted = response();
    inverted.data.subscription.currentPeriodEnd = '2026-08-01T00:00:00Z';
    for (const input of [mixed, inverted])
      expect(() => readBillingSnapshot(input, binding, now)).toThrow(
        expect.objectContaining({ code: 'billing_snapshot_inconsistent' }),
      );
  });
  it('accepts authoritative absence without starting or resetting a trial', () => {
    const input = response();
    const result = readBillingSnapshot(
      {
        ...input,
        data: {
          ...input.data,
          subscription: null,
          entitlement: null,
          allowances: [],
          mutationRevision: null,
        },
      },
      binding,
      now,
    );
    expect(result.access).toBe('read_only');
    expect(result.snapshot.trialEligibility).toEqual(input.data.trialEligibility);
  });
  it('rejects access without a subscription, malformed amounts and unsafe redirects', () => {
    const input = response();
    const malformed = response();
    malformed.data.allowances[0]!.remainingUsd = 'NaN';
    const unsafe = response();
    unsafe.data.pendingOperation = {
      ...binding,
      id: randomUUID(),
      status: 'requires_action',
      action: { kind: 'checkout', url: 'https://checkout.stripe.com.evil.test/', expiresAt: null },
    };
    for (const value of [
      { ...input, data: { ...input.data, subscription: null } },
      malformed,
      unsafe,
    ])
      expect(() => readBillingSnapshot(value, binding, now)).toThrow();
  });
});

describe('authoritative Cloud allowance reporting', () => {
  it('reports micro-dollar usage and pending reservations independently of three purchased seats', () => {
    const result = cloudAllowanceSummary(readBillingSnapshot(response(), binding, now), now);
    expect(result).toMatchObject({
      source: 'cloud',
      allowanceCents: 1500,
      usedCents: 112.3456,
      reservedCents: 200,
      remainingCents: 1187.6544,
    });
  });
  it('does not restore available funds when Cloud reports read-only access or expiry', () => {
    const input = response();
    input.data.entitlement.access = 'read_only';
    expect(
      cloudAllowanceSummary(readBillingSnapshot(input, binding, now), now).remainingCents,
    ).toBe(0);
    input.data.allowances[0]!.expiresAt = '2026-09-05T12:00:00Z';
    expect(cloudAllowanceSummary(readBillingSnapshot(input, binding, now), now)).toMatchObject({
      allowanceCents: 0,
      usedCents: 0,
      remainingCents: 0,
    });
  });
  it('rejects inconsistent or unrepresentable balances instead of showing invented credit', () => {
    const input = response();
    input.data.allowances[0]!.remainingUsd = '15';
    expect(() => cloudAllowanceSummary(readBillingSnapshot(input, binding, now), now)).toThrow(
      expect.objectContaining({ code: 'billing_allowance_invalid' }),
    );
    input.data.allowances[0]!.remainingUsd = '0';
    input.data.allowances[0]!.amountUsd = '999999999999';
    expect(() => cloudAllowanceSummary(readBillingSnapshot(input, binding, now), now)).toThrow(
      expect.objectContaining({ code: 'billing_allowance_invalid' }),
    );
  });
});
