/** Actual database commits around purchaser SDK calls, including ambiguous provider outcomes. */
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { BillingStore } from '../../src/billing';
import { ElizaClient } from '../../src/eliza';
import { migrate } from '../../src/schema';
import { WorkspaceStore, memberOrganization } from '../../src/workspaces';

const url = new URL(
  process.env.TEST_DATABASE_URL ?? 'postgres://outreachr@127.0.0.1:55439/postgres',
);
if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
  throw new Error('Purchaser tests require local disposable PostgreSQL.');
const admin = new Pool({ connectionString: url.href });
const database = `outreachr_purchases_${randomUUID().replaceAll('-', '')}`;
url.pathname = `/${database}`;
const pool = new Pool({ connectionString: url.href, max: 10 });
beforeAll(async () => {
  await admin.query(`CREATE DATABASE "${database}"`);
  await migrate(pool);
});
afterAll(async () => {
  await pool.end();
  await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
  await admin.end();
});
const identity = () => ({
  id: randomUUID(),
  email: `${randomUUID()}@example.test`,
  name: 'Buyer fixture',
  emailVerified: true,
});
async function fixture(active = false) {
  const owner = identity(),
    viewer = identity();
  const workspaces = new WorkspaceStore(pool);
  const org = (await workspaces.signIn(owner)).organizations[0]!;
  await workspaces.signIn(viewer);
  await workspaces.acceptInvite(
    viewer.id,
    (await workspaces.invite(owner.id, org.id, viewer.email, 'viewer')).token,
  );
  const config = {
    appId: randomUUID(),
    clientId: randomUUID(),
    clientSecret: 'billing-fixture-secret',
    billingEnvironment: 'test' as const,
    apiOrigin: 'https://billing.fixture.test',
    loginOrigin: 'https://login.fixture.test',
    publicOrigin: 'http://localhost:4444',
  };
  const accountId = randomUUID(),
    planRevisionId = randomUUID(),
    subscriptionId = randomUUID(),
    quoteId = randomUUID();
  await pool.query(
    "UPDATE outreachr.organizations SET cloud_app_id=$2,cloud_billing_account_id=$3,cloud_billing_environment='test',cloud_product_family_key='workspace' WHERE id=$1",
    [org.id, config.appId, accountId],
  );
  const state = {
    effects: 0,
    expiryEffects: 0,
    expiryLost: false,
    expiryForeign: false,
    expiryRejected: false,
    expired: false,
    payDuringExpiry: false,
    expiryBodies: [] as string[],
    externalOperation: null as Record<string, unknown> | null,
    reads: 0,
    quoteReads: 0,
    lost: false,
    foreign: false,
    unsafeUrl: false,
    reject: false,
    notApplied: false,
    quoteForeign: false,
    quoteExpired: false,
    settled: false,
    paymentExpired: false,
    linkExpired: false,
    bodies: [] as string[],
    operationId: randomUUID(),
  };
  const expiryOperationId = randomUUID();
  const expiryReceipts = new Map<string, { body: unknown; operation: Record<string, unknown> }>();
  const receipts = new Map<string, { body: unknown; operation: Record<string, unknown> }>();
  const scope = {
    appId: config.appId,
    billingAccountId: accountId,
    environment: 'test',
    productFamilyKey: 'workspace',
  };
  const cloud = new ElizaClient(config, async (input, init) => {
    const path = new URL(String(input));
    expect(path.origin).toBe(config.apiOrigin);
    expect(path.searchParams.get('clientId')).toBe(config.clientId);
    const headers = new Headers(init?.headers);
    if (!path.pathname.endsWith('/catalog')) {
      expect(headers.get('Authorization')).toBe(
        `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`,
      );
      expect(headers.get('X-App-Delegation')).toBe('buyer-grant');
    } else expect(headers.get('Authorization')).toBeNull();
    expect(headers.has('X-Eliza-Developer-Authorization')).toBe(false);
    const endsAt = new Date(Date.now() + 86400_000).toISOString();
    if (path.pathname.endsWith('/catalog'))
      return Response.json({
        success: true,
        data: {
          appId: config.appId,
          environment: 'test',
          plans: [
            {
              id: planRevisionId,
              appId: config.appId,
              productFamilyKey: 'workspace',
              planKey: 'sol',
              revision: '1',
              amountCents: 4900,
              currency: 'usd',
              interval: 'month',
              intervalCount: 1,
              seats: { minimum: 1, maximum: 1000 },
              trial: { days: 7, paymentMethodRequired: false, allowanceUsd: '2' },
              allowanceUsd: '15',
              featureKeys: [],
              expiredAccess: 'read_only',
            },
          ],
        },
      });
    if (
      path.pathname.endsWith('/subscriptions/workspace') &&
      (!init?.method || init.method === 'GET')
    ) {
      state.reads++;
      return Response.json({
        success: true,
        data: {
          account: {
            id: accountId,
            appId: config.appId,
            externalReference: org.id,
            displayName: org.name,
            role: 'administrator',
          },
          environment: 'test',
          productFamilyKey: 'workspace',
          observedAt: new Date().toISOString(),
          mutationRevision: active ? '8' : null,
          pendingOperation: state.externalOperation,
          subscription: active
            ? {
                ...scope,
                id: subscriptionId,
                planRevisionId,
                planKey: 'sol',
                revision: '8',
                status: 'active',
                quantity: 1,
                currentPeriodStart: new Date(Date.now() - 1000).toISOString(),
                currentPeriodEnd: endsAt,
                trial: null,
                cancelAtPeriodEnd: false,
                canceledAt: null,
              }
            : null,
          entitlement: active
            ? {
                sourceSubscriptionRevision: '8',
                access: 'granted',
                featureKeys: [],
                seatCapacity: 1,
                assignedSeats: 1,
                validUntil: endsAt,
              }
            : null,
          allowances: [],
          trialEligibility: { status: 'eligible' },
        },
      });
    }
    if (path.pathname.endsWith('/quote')) {
      state.quoteReads++;
      const body = JSON.parse(String(init?.body));
      expect(body.idempotencyKey).toMatch(/^quote:/);
      return Response.json({
        success: true,
        data: {
          id: quoteId,
          appId: config.appId,
          billingAccountId: state.quoteForeign ? randomUUID() : accountId,
          productFamilyKey: 'workspace',
          planRevisionId,
          quantity: body.quantity,
          subscriptionRevision: '8',
          dueNowCents: 1200,
          nextInvoiceAmountCents: 9800,
          recurringAmountCents: 4900 * body.quantity,
          currency: 'usd',
          trialEndsAt: null,
          expiresAt: new Date(Date.now() + (state.quoteExpired ? -1000 : 60_000)).toISOString(),
        },
      });
    }
    if (path.pathname.endsWith('/checkout/expire')) {
      const body = JSON.parse(String(init?.body));
      state.expiryBodies.push(JSON.stringify(body));
      const persisted = (
        await pool.query(
          'SELECT cancellation_request_json,cancellation_pending FROM outreachr.cloud_billing_intents WHERE org_id=$1 AND cancellation_pending=true',
          [org.id],
        )
      ).rows[0];
      expect(persisted?.cancellation_pending).toBe(true);
      expect(persisted?.cancellation_request_json).toEqual(body);
      expect(body.operationId).toBe(state.operationId);
      const prior = expiryReceipts.get(body.idempotencyKey);
      if (prior) {
        expect(body).toEqual(prior.body);
        return Response.json({ success: true, data: prior.operation });
      }
      if (state.expiryRejected)
        return Response.json(
          { success: false, code: 'APP_BILLING_COMMAND_NOT_APPLIED', error: 'Revision changed' },
          { status: 409 },
        );
      state.expiryEffects++;
      state.expired = !state.payDuringExpiry;
      if (state.payDuringExpiry) state.settled = true;
      const operation = {
        ...scope,
        id: expiryOperationId,
        status: 'succeeded',
        subscriptionRevision: null,
      };
      expiryReceipts.set(body.idempotencyKey, { body, operation });
      if (state.expiryLost) throw new Error('Lost expiry response after commit');
      return Response.json({
        success: true,
        data: state.expiryForeign ? { ...operation, billingAccountId: randomUUID() } : operation,
      });
    }
    if (path.pathname.includes('/operations/')) {
      if (path.pathname.endsWith(expiryOperationId))
        return Response.json({
          success: true,
          data: expiryReceipts.values().next().value!.operation,
        });
      if (state.expired)
        return Response.json({
          success: true,
          data: {
            ...scope,
            id: state.operationId,
            status: 'failed',
            error: {
              code: 'APP_BILLING_CHECKOUT_EXPIRED',
              message: 'Checkout canceled.',
              retryable: false,
            },
          },
        });
      if (state.externalOperation && !state.settled)
        return Response.json({ success: true, data: state.externalOperation });
      expect(path.pathname.endsWith(state.operationId)).toBe(true);
      return Response.json({
        success: true,
        data: state.paymentExpired
          ? {
              ...scope,
              id: state.operationId,
              status: 'failed',
              error: {
                code: 'APP_BILLING_PAYMENT_EXPIRED',
                message: 'The original invoice was voided.',
                retryable: false,
              },
            }
          : state.settled
            ? { ...scope, id: state.operationId, status: 'succeeded', subscriptionRevision: '9' }
            : receipts.values().next().value!.operation,
      });
    }
    if (['/checkout', '/update', '/portal'].some((suffix) => path.pathname.endsWith(suffix))) {
      const body = JSON.parse(String(init?.body));
      state.bodies.push(JSON.stringify(body));
      const saved = (
        await pool.query('SELECT * FROM outreachr.cloud_billing_intents WHERE id=$1', [
          body.idempotencyKey.slice(9),
        ])
      ).rows[0];
      expect(saved.confirmed_at).toBeInstanceOf(Date);
      expect(saved.state).toBe('pending');
      expect(saved.request_json).toEqual(body);
      if (state.reject)
        return Response.json(
          {
            success: false,
            code: state.notApplied
              ? 'APP_BILLING_COMMAND_NOT_APPLIED'
              : 'APP_BILLING_AUTHORITY_CONFLICT',
            error: 'Conflict',
          },
          { status: 409 },
        );
      const previous = receipts.get(body.idempotencyKey);
      if (previous) {
        expect(body).toEqual(previous.body);
        return Response.json({ success: true, data: previous.operation });
      }
      state.effects++;
      const operation = {
        ...scope,
        id: state.operationId,
        status: 'requires_action',
        action: {
          kind: path.pathname.endsWith('/portal') ? 'portal' : active ? 'payment' : 'checkout',
          url: path.pathname.endsWith('/portal')
            ? 'https://billing.stripe.com/p/session/fixture'
            : active
              ? 'https://invoice.stripe.com/i/fixture'
              : 'https://checkout.stripe.com/c/pay/fixture',
          expiresAt: state.linkExpired ? '2000-01-01T00:00:00Z' : endsAt,
        },
      };
      receipts.set(body.idempotencyKey, { body, operation });
      if (state.lost) throw new Error('Response lost after provider commit');
      return Response.json({
        success: true,
        data: state.foreign
          ? { ...operation, billingAccountId: randomUUID() }
          : state.unsafeUrl
            ? {
                ...operation,
                action: { ...operation.action, url: 'https://attacker.example/checkout' },
              }
            : operation,
      });
    }
    throw new Error(`Unexpected fixture route: ${path.pathname}`);
  });
  const store = () => new BillingStore(pool, cloud, 'workspace');
  const review = () => store().review(owner.id, org.id, 'buyer-grant', { plan: 'sol', seats: 2 });
  return { owner, viewer, org, state, config, cloud, store, review, scope };
}
it('reviews exact recurring terms without any purchase and denies viewers before network access', async () => {
  const f = await fixture();
  await expect(
    f.store().review(f.viewer.id, f.org.id, 'viewer-grant', { plan: 'sol', seats: 2 }),
  ).rejects.toMatchObject({ code: 'owner_required' });
  expect(f.state.reads).toBe(0);
  const result = await f.review();
  expect(result).toMatchObject({
    state: 'review',
    operation: null,
    review: { kind: 'checkout', plan: 'sol', seats: 2, monthlyTotalCents: 9800 },
  });
  expect(f.state.effects).toBe(0);
});
it('persists consent before dispatch and recovers one purchase after a lost response and server restart', async () => {
  const f = await fixture();
  const review = await f.review();
  f.state.lost = true;
  await expect(
    f.store().confirm(f.owner.id, f.org.id, 'buyer-grant', review.review.id),
  ).rejects.toMatchObject({ code: 'billing_result_unconfirmed' });
  expect(f.state.effects).toBe(1);
  const pending = await f.review();
  expect(pending.state).toBe('pending');
  expect(pending.review.id).toBe(review.review.id);
  const results = await Promise.all([
    f.store().current(f.owner.id, f.org.id, 'buyer-grant'),
    f.store().confirm(f.owner.id, f.org.id, 'buyer-grant', review.review.id),
  ]);
  expect(results[0]).toEqual(results[1]);
  expect(f.state.effects).toBe(1);
  expect(new Set(f.state.bodies).size).toBe(1);
  f.state.settled = true;
  expect(await f.store().current(f.owner.id, f.org.id, 'buyer-grant')).toMatchObject({
    state: 'complete',
    operation: { status: 'succeeded' },
  });
  const org = await memberOrganization(pool, f.owner.id, f.org.id);
  expect(org.subscription_status).toBe('none');
  expect(org.cloud_billing_invalidated).toBe(true);
});
it('uses and displays an immutable update quote before explicit confirmation', async () => {
  const f = await fixture(true);
  const result = await f.review();
  expect(result.review).toMatchObject({
    kind: 'update',
    dueNowCents: 1200,
    nextInvoiceAmountCents: 9800,
    monthlyTotalCents: 9800,
  });
  expect(f.state.effects).toBe(0);
  await f.store().confirm(f.owner.id, f.org.id, 'buyer-grant', result.review.id);
  expect(JSON.parse(f.state.bodies[0]!)).toMatchObject({
    expectedSubscriptionRevision: '8',
    quantity: 2,
    billingConsent: 'accepted',
  });
  expect(f.state.quoteReads).toBe(1);
  expect(f.state.effects).toBe(1);
});
it('rejects expired and foreign quotes before a purchaser command', async () => {
  const f = await fixture(true);
  f.state.quoteForeign = true;
  await expect(f.review()).rejects.toMatchObject({ code: 'billing_quote_scope' });
  f.state.quoteForeign = false;
  f.state.quoteExpired = true;
  await expect(f.review()).rejects.toMatchObject({ code: 'billing_quote_scope' });
  expect(f.state.effects).toBe(0);
});
it('requires a fresh review after expiry and rejects superseded review consent', async () => {
  const f = await fixture();
  const first = await f.review();
  const latest = await f.review();
  await expect(
    f.store().confirm(f.owner.id, f.org.id, 'buyer-grant', first.review.id),
  ).rejects.toMatchObject({ code: 'billing_review_superseded' });
  await pool.query(
    "UPDATE outreachr.cloud_billing_intents SET review_json=jsonb_set(review_json,'{expiresAt}',to_jsonb('2000-01-01T00:00:00Z'::text)) WHERE id=$1",
    [latest.review.id],
  );
  await expect(
    f.store().confirm(f.owner.id, f.org.id, 'buyer-grant', latest.review.id),
  ).rejects.toMatchObject({ code: 'billing_review_expired' });
  expect(f.state.effects).toBe(0);
});
it.each(['foreign', 'unsafeUrl'] as const)(
  'does not accept %s responses and recovers the original scoped operation',
  async (flag) => {
    const f = await fixture();
    const review = await f.review();
    f.state[flag] = true;
    await expect(
      f.store().confirm(f.owner.id, f.org.id, 'buyer-grant', review.review.id),
    ).rejects.toMatchObject({ status: 502 });
    expect(await f.store().current(f.owner.id, f.org.id, 'buyer-grant')).toMatchObject({
      state: 'pending',
      operation: { status: 'requires_action' },
    });
    expect(f.state.effects).toBe(1);
  },
);
it('does not discard an ambiguous conflict or rebind it to a new registration', async () => {
  const f = await fixture();
  const review = await f.review();
  f.state.reject = true;
  await expect(
    f.store().confirm(f.owner.id, f.org.id, 'buyer-grant', review.review.id),
  ).rejects.toMatchObject({ code: 'billing_result_unconfirmed' });
  await expect(f.store().current(f.owner.id, f.org.id, 'buyer-grant')).rejects.toMatchObject({
    code: 'billing_result_unconfirmed',
  });
  expect(new Set(f.state.bodies).size).toBe(1);
  expect(f.state.effects).toBe(0);
  f.config.clientId = randomUUID();
  await expect(f.store().current(f.owner.id, f.org.id, 'buyer-grant')).rejects.toMatchObject({
    code: 'billing_binding_changed',
  });
});
it('uses generic purchaser portal authority and preserves its confirmed URL across a lost app response', async () => {
  const f = await fixture(true);
  const review = await f.store().review(f.owner.id, f.org.id, 'buyer-grant');
  const result = await f.store().confirm(f.owner.id, f.org.id, 'buyer-grant', review.review.id);
  expect(result).toMatchObject({
    state: 'complete',
    operation: { status: 'requires_action', action: { kind: 'portal' } },
  });
  expect(await f.store().confirm(f.owner.id, f.org.id, 'buyer-grant', review.review.id)).toEqual(
    result,
  );
  expect(f.state.effects).toBe(1);
});

it('tracks pending invoice authentication without issuing another paid update when its link expires', async () => {
  const f = await fixture(true);
  f.state.linkExpired = true;
  const reviewed = await f.review();
  const first = await f.store().confirm(f.owner.id, f.org.id, 'buyer-grant', reviewed.review.id);
  expect(first).toMatchObject({
    state: 'pending',
    operation: { status: 'requires_action', action: { kind: 'payment' } },
  });
  await f.store().current(f.owner.id, f.org.id, 'buyer-grant');
  await f.store().current(f.owner.id, f.org.id, 'buyer-grant');
  expect(f.state.bodies).toHaveLength(1);
  expect(f.state.effects).toBe(1);
  expect((await f.review()).review.id).toBe(reviewed.review.id);
  f.state.paymentExpired = true;
  expect(await f.store().current(f.owner.id, f.org.id, 'buyer-grant')).toMatchObject({
    state: 'complete',
    operation: { status: 'failed', error: { code: 'APP_BILLING_PAYMENT_EXPIRED' } },
  });
  expect((await f.review()).review.id).not.toBe(reviewed.review.id);
  expect(f.state.effects).toBe(1);
});

it('releases only a proven unexecuted command and requires a fresh review and consent', async () => {
  const f = await fixture(true);
  f.state.reject = true;
  f.state.notApplied = true;
  const original = await f.review();
  const rejected = await f.store().confirm(f.owner.id, f.org.id, 'buyer-grant', original.review.id);
  expect(rejected).toMatchObject({
    state: 'complete',
    rejectionCode: 'APP_BILLING_COMMAND_NOT_APPLIED',
    operation: null,
  });
  expect(f.state.effects).toBe(0);
  f.state.reject = false;
  expect(await f.store().confirm(f.owner.id, f.org.id, 'buyer-grant', original.review.id)).toEqual(
    rejected,
  );
  const refreshed = await f.review();
  expect(refreshed.review.id).not.toBe(original.review.id);
  expect(f.state.effects).toBe(0);
  await f.store().confirm(f.owner.id, f.org.id, 'buyer-grant', refreshed.review.id);
  expect(f.state.effects).toBe(1);
});

it('recovers an operation started in Cloud without manufacturing local purchase consent', async () => {
  const f = await fixture();
  f.state.externalOperation = {
    ...f.scope,
    id: f.state.operationId,
    status: 'requires_action',
    action: {
      kind: 'checkout',
      url: 'https://checkout.stripe.com/c/pay/external',
      expiresAt: null,
    },
  };
  const found = await f.store().current(f.owner.id, f.org.id, 'buyer-grant');
  expect(found).toMatchObject({
    state: 'pending',
    review: { kind: 'external' },
    operation: { id: f.state.operationId },
  });
  const row = (
    await pool.query(
      'SELECT request_json,confirmed_at FROM outreachr.cloud_billing_intents WHERE id=$1',
      [found!.review.id],
    )
  ).rows[0];
  expect(row).toEqual({ request_json: null, confirmed_at: null });
  expect((await f.review()).review.id).toBe(found!.review.id);
  f.state.externalOperation = {
    ...f.scope,
    id: f.state.operationId,
    status: 'failed',
    error: { code: 'RETRYABLE', message: 'Retry in Cloud', retryable: true },
  };
  await f.store().current(f.owner.id, f.org.id, 'buyer-grant');
  await f.store().current(f.owner.id, f.org.id, 'buyer-grant');
  expect(f.state.bodies).toHaveLength(0);
  expect(f.state.effects).toBe(0);
});
it('retains and recovers an exact checkout expiry after commit/response loss across competing requests', async () => {
  const f = await fixture();
  const review = await f.review();
  await f.store().confirm(f.owner.id, f.org.id, 'buyer-grant', review.review.id);
  f.state.expiryLost = true;
  expect(
    await f.store().expireCheckout(f.owner.id, f.org.id, 'buyer-grant', review.review.id),
  ).toMatchObject({ cancellationPending: true, state: 'pending' });
  const results = await Promise.all([
    f.store().current(f.owner.id, f.org.id, 'buyer-grant'),
    f.store().expireCheckout(f.owner.id, f.org.id, 'buyer-grant', review.review.id),
  ]);
  expect(results[0]).toEqual(results[1]);
  expect(results[0]).toMatchObject({
    state: 'complete',
    cancellationPending: false,
    operation: { status: 'failed', error: { code: 'APP_BILLING_CHECKOUT_EXPIRED' } },
  });
  expect(new Set(f.state.expiryBodies).size).toBe(1);
  expect(f.state.expiryEffects).toBe(1);
  expect(f.state.effects).toBe(1);
  expect(
    (
      await pool.query(
        "SELECT count(*)::int AS count FROM outreachr.audit WHERE org_id=$1 AND action='billing.checkout_cancellation_requested'",
        [f.org.id],
      )
    ).rows[0].count,
  ).toBe(1);
  expect((await f.review()).review.id).not.toBe(review.review.id);
});
it('does not expire an invoice payment operation as a checkout', async () => {
  const f = await fixture(true);
  const review = await f.review();
  await f.store().confirm(f.owner.id, f.org.id, 'buyer-grant', review.review.id);
  await expect(
    f.store().expireCheckout(f.owner.id, f.org.id, 'buyer-grant', review.review.id),
  ).rejects.toMatchObject({ code: 'checkout_not_open' });
  expect(f.state.expiryBodies).toHaveLength(0);
});
it('reconciles payment completed during checkout cancellation before accepting a new purchase', async () => {
  const f = await fixture();
  const review = await f.review();
  await f.store().confirm(f.owner.id, f.org.id, 'buyer-grant', review.review.id);
  f.state.payDuringExpiry = true;
  expect(
    await f.store().expireCheckout(f.owner.id, f.org.id, 'buyer-grant', review.review.id),
  ).toMatchObject({ state: 'complete', operation: { status: 'succeeded' } });
  expect(f.state.effects).toBe(1);
  expect((await memberOrganization(pool, f.owner.id, f.org.id)).subscription_status).toBe('none');
});
it('retains foreign expiry responses and recovers the original cancellation receipt', async () => {
  const f = await fixture();
  const review = await f.review();
  await f.store().confirm(f.owner.id, f.org.id, 'buyer-grant', review.review.id);
  f.state.expiryForeign = true;
  await expect(
    f.store().expireCheckout(f.owner.id, f.org.id, 'buyer-grant', review.review.id),
  ).rejects.toMatchObject({ code: 'billing_cancellation_scope' });
  expect(await f.store().current(f.owner.id, f.org.id, 'buyer-grant')).toMatchObject({
    state: 'complete',
    cancellationPending: false,
  });
  expect(f.state.expiryEffects).toBe(1);
});
it('requires a new explicit cancellation after a proven unexecuted expiry rejection', async () => {
  const f = await fixture();
  const review = await f.review();
  await f.store().confirm(f.owner.id, f.org.id, 'buyer-grant', review.review.id);
  f.state.expiryRejected = true;
  expect(
    await f.store().expireCheckout(f.owner.id, f.org.id, 'buyer-grant', review.review.id),
  ).toMatchObject({
    state: 'pending',
    cancellationPending: false,
    rejectionCode: 'APP_BILLING_COMMAND_NOT_APPLIED',
  });
  f.state.expiryRejected = false;
  await f.store().current(f.owner.id, f.org.id, 'buyer-grant');
  expect(f.state.expiryEffects).toBe(0);
  await f.store().expireCheckout(f.owner.id, f.org.id, 'buyer-grant', review.review.id);
  expect(f.state.expiryEffects).toBe(1);
});
