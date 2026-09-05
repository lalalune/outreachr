import { useEffect, useState } from 'react';
import { post } from './bridge';

export interface BillingProgress {
  review: {
    id: string;
    kind: 'checkout' | 'update' | 'portal' | 'external' | 'trial';
    plan: 'sol' | 'astra' | null;
    seats: number | null;
    monthlyTotalCents: number | null;
    dueNowCents: number | null;
    nextInvoiceAmountCents: number | null;
    trialEndsAt: string | null;
    expiresAt: string;
  };
  state: 'review' | 'pending' | 'complete' | 'superseded';
  rejectionCode?: string | null;
  cancellationPending?: boolean;
  operation: null | {
    status: 'pending' | 'outcome_unknown' | 'requires_action' | 'succeeded' | 'failed';
    action?: { kind: 'checkout' | 'portal' | 'payment'; url: string; expiresAt: string | null };
    error?: { message: string; retryable: boolean };
  };
}
export function BillingRequest({
  base,
  value,
  onChange,
  reload,
}: {
  base: string;
  value: BillingProgress | null;
  onChange: (next: BillingProgress | null) => void;
  reload: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!value) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [value]);
  async function request(action: 'confirm' | 'recover' | 'expire') {
    setBusy(true);
    setError('');
    if (action === 'expire' && value) onChange({ ...value, cancellationPending: true });
    try {
      const next = await post<BillingProgress | null>(
        `${base}/billing/${action === 'expire' ? 'checkout/expire' : action}`,
        action === 'confirm'
          ? { id: value!.review.id, billingConsent: 'accepted' }
          : action === 'expire'
            ? { id: value!.review.id }
            : {},
      );
      onChange(next);
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Billing is unavailable.');
    } finally {
      setBusy(false);
    }
  }
  const review = value?.review;
  const money = (cents: number) =>
    (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  const action = value?.operation?.action;
  return (
    <div>
      <button disabled={busy} onClick={() => void request('recover')}>
        Check billing request
      </button>
      {error && <p role="alert">{error}</p>}
      {value?.rejectionCode === 'APP_BILLING_COMMAND_NOT_APPLIED' && (
        <p role="alert">
          Cloud confirmed that this request was not applied. Review the current subscription terms
          again before continuing.
        </p>
      )}
      {review && value?.state === 'review' && (
        <div aria-label="Subscription review">
          <h3>{review.kind === 'portal' ? 'Manage billing' : 'Review subscription terms'}</h3>
          {review.kind === 'portal' ? (
            <p>Open Cloud’s billing portal to manage payment details and cancellation.</p>
          ) : (
            <>
              <p>
                {review.plan === 'sol' ? 'Sol' : 'Astra'} · {review.seats} editing seat
                {review.seats === 1 ? '' : 's'} · {money(review.monthlyTotalCents!)} per month
                before tax.
              </p>
              {review.dueNowCents !== null ? (
                <p>
                  Quoted amount due now: {money(review.dueNowCents)}. Next invoice:{' '}
                  {money(review.nextInvoiceAmountCents!)}.
                </p>
              ) : (
                <p>Review the amount due and any tax in Cloud’s checkout before paying.</p>
              )}
              {review.trialEndsAt && (
                <p>Your existing trial ends {new Date(review.trialEndsAt).toLocaleString()}.</p>
              )}
              <p>
                The subscription renews monthly until canceled. Viewers are free. The AI allowance
                belongs to the workspace and does not increase with seats.
              </p>
            </>
          )}
          <button
            disabled={busy || Date.parse(review.expiresAt) <= now}
            onClick={() => void request('confirm')}
          >
            {review.kind === 'portal' ? 'Open billing portal' : 'Agree and continue'}
          </button>
          <button disabled={busy} onClick={() => onChange(null)}>
            Dismiss review
          </button>
          {Date.parse(review.expiresAt) <= now && (
            <p>These terms expired. Review the subscription again.</p>
          )}
        </div>
      )}
      {value?.state === 'pending' && (
        <p role="status">
          This billing request is in progress. Check it before starting another purchase.
        </p>
      )}
      {value?.operation?.status === 'succeeded' && (
        <p role="status">
          Cloud confirmed the billing request. Workspace access follows the refreshed subscription
          status.
        </p>
      )}
      {value?.operation?.status === 'failed' && (
        <p role="alert">{value.operation.error?.message ?? 'The billing request failed.'}</p>
      )}
      {!value?.cancellationPending &&
        action &&
        (!action.expiresAt || Date.parse(action.expiresAt) > now) && (
          <a href={action.url} target="_blank" rel="noopener noreferrer">
            {action.kind === 'portal'
              ? 'Continue to billing portal'
              : action.kind === 'payment'
                ? 'Complete payment'
                : 'Continue to checkout'}
          </a>
        )}
      {value?.cancellationPending && (
        <p role="status">
          Checkout cancellation is being confirmed. Check this request before starting another
          purchase.
        </p>
      )}
      {value?.state === 'pending' && action?.kind === 'checkout' && !value.cancellationPending && (
        <button disabled={busy} onClick={() => void request('expire')}>
          Cancel open checkout
        </button>
      )}
      {action?.expiresAt && Date.parse(action.expiresAt) <= now && (
        <p>This link expired. Check the original billing request to confirm its status.</p>
      )}
    </div>
  );
}
