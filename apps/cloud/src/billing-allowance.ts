/** Displays Cloud's allowance ledger without treating local token estimates as billed usage. */
import type { readBillingSnapshot } from './billing-snapshot';
import { requireCondition } from './errors';

function microUsd(value: string): bigint {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
}
export function cloudAllowanceSummary(
  result: ReturnType<typeof readBillingSnapshot>,
  now = new Date(),
) {
  const totals = { amount: 0n, used: 0n, reserved: 0n, remaining: 0n };
  for (const period of result.snapshot.allowances) {
    if (Date.parse(period.expiresAt) <= now.getTime()) continue;
    const amount = microUsd(period.amountUsd),
      used = microUsd(period.usedUsd),
      reserved = microUsd(period.reservedUsd),
      remaining = microUsd(period.remainingUsd);
    const available = amount > used + reserved ? amount - used - reserved : 0n;
    requireCondition(
      remaining <= available,
      502,
      'billing_allowance_invalid',
      'Cloud returned an inconsistent allowance balance. Refresh billing before continuing.',
    );
    totals.amount += amount;
    totals.used += used;
    totals.reserved += reserved;
    totals.remaining += result.access === 'granted' ? remaining : 0n;
  }
  requireCondition(
    Object.values(totals).every((value) => value <= BigInt(Number.MAX_SAFE_INTEGER)),
    502,
    'billing_allowance_invalid',
    'Cloud returned an allowance balance outside the supported range.',
  );
  return {
    source: 'cloud' as const,
    allowanceCents: Number(totals.amount) / 10_000,
    usedCents: Number(totals.used) / 10_000,
    reservedCents: Number(totals.reserved) / 10_000,
    remainingCents: Number(totals.remaining) / 10_000,
    observedAt: result.snapshot.observedAt,
  };
}
