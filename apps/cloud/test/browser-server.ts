import type { AppBillingOperation } from '@elizaos/cloud-sdk/app-billing';
import { WorkspaceStore } from '../src/workspaces';
import { DELEGATION_SCOPES, GOOGLE_CAPABILITIES } from '../src/delegation';
/** Runs disposable PostgreSQL-backed browser tests with an explicitly local identity/provider fixture. */
import { randomBytes, randomUUID } from 'node:crypto';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { Pool } from 'pg';
import { migrate } from '../src/schema';
import { createApp } from '../src/app';
import { ElizaClient } from '../src/eliza';
import { CredentialCipher, SessionStore } from '../src/sessions';
import { CloudRuntime } from '../src/runtime';
import { AgentRuns, CloudAgent } from '../src/agent';
import { InferenceClient } from '../src/inference';

if (process.env.NODE_ENV === 'production')
  throw new Error('Browser fixtures cannot run in production.');
const database = `outreachr_browser_${randomUUID().replaceAll('-', '')}`;
const databaseUrl = new URL(
  process.env.TEST_DATABASE_URL ?? 'postgres://outreachr@127.0.0.1:55439/postgres',
);
if (!['localhost', '127.0.0.1', '[::1]'].includes(databaseUrl.hostname))
  throw new Error('Browser fixtures require local PostgreSQL.');
const admin = new Pool({ connectionString: databaseUrl.href });
await admin.query(`CREATE DATABASE "${database}"`);
databaseUrl.pathname = `/${database}`;
const pool = new Pool({ connectionString: databaseUrl.href });
await migrate(pool);
const appId = randomUUID();
const billingAccountId = randomUUID();
const billingSubscriptionId = randomUUID();
const billingPlanRevisionId = randomUUID();
let externalCheckout: AppBillingOperation | null = null;
const owner = {
  id: randomUUID(),
  organizationId: randomUUID(),
  email: 'owner@example.test',
  name: 'Test Owner',
  emailVerified: true,
};
const viewer = {
  id: randomUUID(),
  organizationId: randomUUID(),
  email: 'viewer@example.test',
  name: 'Test Viewer',
  emailVerified: true,
};
let membershipRevision = 0;
const billingMembers = new Set<string>([owner.id]);
const billingAdmins = new Set<string>([owner.id]);
const editingSeats = new Map<string, string>();
let seatCapacity = 1;
let fixtureTrial: { startedAt: string; endsAt: string } | null = null;
let trialRecoveryBlocked = true;
let trialEffects = 0;
const trialBodies: string[] = [];
const trialReceipts = new Map<string, { body: string; operation: AppBillingOperation }>();
let ownershipReadsBlocked = false;
let loseOwnershipResponse = false;
let ownershipEffects = 0;
const ownershipReceipts = new Map<string, { body: string; actor: string; response: unknown }>();
const membershipReceipts = new Map<string, { body: string; response: unknown }>();
const codes = new Map<string, typeof owner>();
const grants = new Map<string, typeof owner>();
const googleStates = new Map<string, typeof owner>();
const googleAccounts = new Map<string, { id: string; email: string }>();
const fixture = new Hono();
fixture.get('/app-auth/authorize', (c) => {
  if (
    c.req.query('app_id') !== appId ||
    c.req.query('redirect_uri') !== 'http://127.0.0.1:4173/api/auth/callback'
  )
    return c.text('Invalid fixture app', 400);
  const state = encodeURIComponent(c.req.query('state') ?? '');
  return c.html(
    `<html lang="en"><title>Local identity fixture</title><body><h1>Local identity fixture</h1><a href="/complete?actor=owner&state=${state}">Sign in as Owner</a><a href="/complete?actor=viewer&state=${state}">Sign in as Viewer</a></body></html>`,
  );
});
fixture.get('/complete', (c) => {
  const code = `eac_${randomBytes(24).toString('hex')}`;
  codes.set(code, c.req.query('actor') === 'viewer' ? viewer : owner);
  const target = new URL('http://127.0.0.1:4173/api/auth/callback');
  target.searchParams.set('code', code);
  target.searchParams.set('state', c.req.query('state') ?? '');
  return c.redirect(target.href);
});
fixture.post('/api/v1/app-auth/delegations/token', async (c) => {
  const { code } = await c.req.json<{ code: string }>();
  const user = codes.get(code);
  codes.delete(code);
  if (!user) return c.json({ error: 'Invalid code' }, 401);
  const token = `ead_${randomBytes(32).toString('base64url')}`;
  grants.set(token, user);
  return c.json({
    success: true,
    data: {
      token,
      user,
      appId,
      billingEnvironment: 'test',
      scopes: DELEGATION_SCOPES,
      expiresAt: new Date(Date.now() + 86400_000).toISOString(),
    },
  });
});
fixture.get('/api/v1/app-auth/delegations/identity', (c) => {
  const user = grants.get(c.req.header('X-App-Delegation') ?? '');
  return user ? c.json({ success: true, data: user }) : c.json({ error: 'Signed out' }, 401);
});
fixture.post('/api/v1/app-auth/delegations/revoke', (c) => {
  grants.delete(c.req.header('X-App-Delegation') ?? '');
  return c.json({ success: true });
});
fixture.use('/api/v1/apps/:appId/billing/*', async (c, next) => {
  if (c.req.query('clientId') !== eliza.config.clientId)
    return c.json({ error: 'Registered billing mode required' }, 403);
  await next();
});
fixture.post(`/api/v1/apps/${appId}/billing/accounts`, async (c) => {
  const actor = grants.get(c.req.header('X-App-Delegation') ?? '');
  const request = await c.req.json<{ externalReference: string; displayName: string }>();
  if (actor?.id !== owner.id || request.externalReference !== fixtureOwnerWorkspace.id)
    return c.json({ error: 'This fixture only provisions the primary workspace' }, 403);
  return c.json({
    success: true,
    data: {
      id: billingAccountId,
      appId,
      externalReference: fixtureOwnerWorkspace.id,
      displayName: fixtureOwnerWorkspace.name,
      role: 'administrator',
    },
  });
});
fixture.post(
  `/api/v1/apps/${appId}/billing/accounts/${billingAccountId}/subscriptions/workspace/trial`,
  async (c) => {
    if (grants.get(c.req.header('X-App-Delegation') ?? '')?.id !== owner.id)
      return c.json({ error: 'Owner required' }, 403);
    const body = await c.req.text();
    const request = JSON.parse(body) as {
      idempotencyKey: string;
      expectedSubscriptionRevision: string | null;
      planRevisionId: string;
      quantity: number;
      billingConsent?: string;
    };
    if (
      request.planRevisionId !== billingPlanRevisionId ||
      request.quantity !== 1 ||
      request.expectedSubscriptionRevision !== null ||
      request.billingConsent
    )
      return c.json({ error: 'Invalid free trial intent' }, 400);
    trialBodies.push(body);
    const prior = trialReceipts.get(request.idempotencyKey);
    if (prior) {
      if (prior.body !== body) return c.json({ error: 'Changed retry' }, 409);
      if (trialRecoveryBlocked) return c.json({ error: 'Trial response unavailable' }, 503);
      return c.json({ success: true, data: prior.operation });
    }
    if (fixtureTrial) return c.json({ error: 'Trial already used' }, 409);
    const startedAt = new Date(Date.now() - 60_000).toISOString();
    fixtureTrial = {
      startedAt,
      endsAt: new Date(Date.parse(startedAt) + 7 * 86400_000).toISOString(),
    };
    trialEffects++;
    const operation: AppBillingOperation = {
      id: randomUUID(),
      appId,
      billingAccountId,
      environment: 'test',
      productFamilyKey: 'workspace',
      status: 'succeeded',
      subscriptionRevision: '1',
    };
    trialReceipts.set(request.idempotencyKey, { body, operation });
    return c.json({ error: 'Trial committed but response lost' }, 503);
  },
);
fixture.post('/test/billing/trial-unblock', (c) => {
  trialRecoveryBlocked = false;
  return c.json({ success: true });
});
fixture.get('/test/billing/trial', (c) =>
  c.json({
    effects: trialEffects,
    exactRetry: trialBodies.length > 1 && new Set(trialBodies).size === 1,
    trial: fixtureTrial,
  }),
);
fixture.get('/api/v1/apps/:appId/billing/accounts/:accountId/members', (c) => {
  if (
    c.req.param('appId') !== appId ||
    c.req.param('accountId') !== billingAccountId ||
    c.req.header('Authorization') !==
      `Basic ${Buffer.from(`${eliza.config.clientId}:${eliza.config.clientSecret}`).toString('base64')}`
  )
    return c.json({ error: 'Invalid backend registration' }, 403);
  return c.json({
    success: true,
    data: {
      appId,
      billingAccountId,
      environment: 'test',
      revision: String(membershipRevision),
      members: [...billingMembers].map((userId) => ({
        userId,
        active: true,
        role: billingAdmins.has(userId) ? 'administrator' : 'member',
      })),
    },
  });
});
fixture.post('/api/v1/apps/:appId/billing/accounts/:accountId/members/sync', async (c) => {
  if (
    c.req.param('appId') !== appId ||
    c.req.param('accountId') !== billingAccountId ||
    c.req.header('Authorization') !==
      `Basic ${Buffer.from(`${eliza.config.clientId}:${eliza.config.clientSecret}`).toString('base64')}` ||
    c.req.header('X-App-Delegation')
  )
    return c.json({ error: 'Invalid backend registration' }, 403);
  const body = await c.req.text();
  const input = JSON.parse(body) as {
    userId: string;
    active: boolean;
    expectedRevision: string;
    idempotencyKey: string;
    seats: { assigned: boolean; productFamilyKey: string }[];
  };
  const previous = membershipReceipts.get(input.idempotencyKey);
  if (previous)
    return previous.body === body
      ? Response.json(previous.response)
      : c.json({ error: 'Changed retry' }, 409);
  if (
    (input.userId !== owner.id && input.userId !== viewer.id) ||
    input.expectedRevision !== String(membershipRevision) ||
    input.seats.some((seat) => seat.productFamilyKey !== 'workspace')
  )
    return c.json(
      { error: 'Invalid membership', code: 'APP_BILLING_MEMBERSHIP_REVISION_CONFLICT' },
      409,
    );
  if (input.active) billingMembers.add(input.userId);
  else billingMembers.delete(input.userId);
  if (input.active && input.seats.some((seat) => seat.assigned)) {
    if (!editingSeats.has(input.userId) && editingSeats.size >= seatCapacity)
      return c.json({ error: 'No editing seat available' }, 409);
    if (!editingSeats.has(input.userId)) editingSeats.set(input.userId, randomUUID());
  } else editingSeats.delete(input.userId);
  membershipRevision += 1;
  const response = {
    success: true,
    data: {
      appId,
      billingAccountId,
      environment: 'test',
      revision: String(membershipRevision),
      member: {
        userId: input.userId,
        role: billingAdmins.has(input.userId) ? 'administrator' : 'member',
        active: input.active,
      },
      seats: editingSeats.has(input.userId)
        ? [{ productFamilyKey: 'workspace', seatId: editingSeats.get(input.userId)! }]
        : [],
    },
  };
  membershipReceipts.set(input.idempotencyKey, { body, response });
  return c.json(response);
});
const administratorResponse = () => ({
  success: true,
  data: {
    appId,
    billingAccountId,
    environment: 'test',
    revision: String(membershipRevision),
    administrators: [...billingAdmins],
  },
});
fixture.get('/api/v1/apps/:appId/billing/accounts/:accountId/administrators', (c) => {
  const actor = grants.get(c.req.header('X-App-Delegation') ?? '');
  if (!actor || !billingMembers.has(actor.id)) return c.json({ error: 'Membership required' }, 403);
  if (ownershipReadsBlocked) return c.json({ error: 'Ownership temporarily unavailable' }, 503);
  return c.json(administratorResponse());
});
fixture.post('/api/v1/apps/:appId/billing/accounts/:accountId/administrators', async (c) => {
  const actor = grants.get(c.req.header('X-App-Delegation') ?? '');
  if (!actor || !billingMembers.has(actor.id)) return c.json({ error: 'Membership required' }, 403);
  const body = await c.req.text();
  const input = JSON.parse(body) as {
    action: 'grant' | 'revoke' | 'transfer';
    userId: string;
    expectedRevision: string;
    idempotencyKey: string;
  };
  const prior = ownershipReceipts.get(input.idempotencyKey);
  if (prior)
    return prior.body === body && prior.actor === actor.id
      ? Response.json(prior.response)
      : c.json({ error: 'Changed retry' }, 409);
  if (!billingAdmins.has(actor.id) || !billingMembers.has(input.userId))
    return c.json({ error: 'Owner and accepted target required' }, 403);
  if (input.expectedRevision !== String(membershipRevision))
    return c.json(
      { error: 'Stale revision', code: 'APP_BILLING_MEMBERSHIP_REVISION_CONFLICT' },
      409,
    );
  if (input.action === 'revoke') {
    if (billingAdmins.size === 1 && billingAdmins.has(input.userId))
      return c.json({ error: 'Last owner' }, 409);
    billingAdmins.delete(input.userId);
  } else {
    billingAdmins.add(input.userId);
    if (input.action === 'transfer') billingAdmins.delete(actor.id);
  }
  membershipRevision += 1;
  ownershipEffects += 1;
  const response = administratorResponse();
  ownershipReceipts.set(input.idempotencyKey, { body, actor: actor.id, response });
  if (loseOwnershipResponse) {
    loseOwnershipResponse = false;
    ownershipReadsBlocked = true;
    return c.json({ error: 'Response lost after ownership commit' }, 503);
  }
  return c.json(response);
});
fixture.post('/test/billing/ownership-prepare', (c) => {
  seatCapacity = 2;
  loseOwnershipResponse = true;
  return c.json({ success: true });
});
fixture.post('/test/billing/ownership-unblock', (c) => {
  ownershipReadsBlocked = false;
  return c.json({ success: true });
});
fixture.get('/test/billing/ownership', (c) =>
  c.json({
    effects: ownershipEffects,
    administrators: [...billingAdmins],
    seats: editingSeats.size,
  }),
);
fixture.get('/api/v1/apps/:appId/billing/accounts/:accountId/subscriptions/workspace', (c) => {
  const user = grants.get(c.req.header('X-App-Delegation') ?? '');
  if (
    !user ||
    !billingMembers.has(user.id) ||
    c.req.param('appId') !== appId ||
    c.req.param('accountId') !== billingAccountId
  )
    return c.json({ error: 'Billing membership required' }, 403);
  if (!fixtureTrial || trialRecoveryBlocked)
    return c.json({
      success: true,
      data: {
        account: {
          id: billingAccountId,
          appId,
          displayName: fixtureOwnerWorkspace.name,
          externalReference: fixtureOwnerWorkspace.id,
          role: billingAdmins.has(user.id) ? 'administrator' : 'member',
        },
        environment: 'test',
        productFamilyKey: 'workspace',
        observedAt: new Date().toISOString(),
        mutationRevision: null,
        pendingOperation: null,
        subscription: null,
        entitlement: null,
        allowances: [],
        trialEligibility: { status: 'eligible' },
      },
    });
  const { startedAt, endsAt } = fixtureTrial;
  return c.json({
    success: true,
    data: {
      account: {
        id: billingAccountId,
        appId,
        displayName: fixtureOwnerWorkspace.name,
        externalReference: fixtureOwnerWorkspace.id,
        role: billingAdmins.has(user.id) ? 'administrator' : 'member',
      },
      environment: 'test',
      productFamilyKey: 'workspace',
      observedAt: new Date().toISOString(),
      mutationRevision: '1',
      pendingOperation: externalCheckout?.status === 'requires_action' ? externalCheckout : null,
      subscription: {
        id: billingSubscriptionId,
        appId,
        environment: 'test',
        billingAccountId,
        productFamilyKey: 'workspace',
        planRevisionId: billingPlanRevisionId,
        planKey: 'sol',
        revision: '1',
        status: 'trialing',
        quantity: seatCapacity,
        currentPeriodStart: startedAt,
        currentPeriodEnd: endsAt,
        trial: { startedAt, endsAt },
        cancelAtPeriodEnd: false,
        canceledAt: null,
      },
      entitlement: {
        sourceSubscriptionRevision: '1',
        access: 'granted',
        featureKeys: [],
        seatCapacity,
        assignedSeats: editingSeats.size,
        validUntil: endsAt,
      },
      allowances: [
        {
          source: 'trial',
          amountUsd: '2',
          usedUsd: '0.012345',
          reservedUsd: '0',
          remainingUsd: '1.987655',
          expiresAt: endsAt,
        },
      ],
      trialEligibility: { status: 'claimed', startedAt, endsAt },
    },
  });
});
// Exercise purchaser review and ambiguous recovery with generic Cloud SDK routes.
const purchaseReceipts = new Map<string, { body: string; operation: unknown }>();
fixture.get(`/api/v1/apps/${appId}/billing/catalog`, (c) =>
  c.json({
    success: true,
    data: {
      appId,
      environment: 'test',
      plans: [
        {
          id: billingPlanRevisionId,
          appId,
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
  }),
);
fixture.post(
  `/api/v1/apps/${appId}/billing/accounts/${billingAccountId}/subscriptions/workspace/quote`,
  async (c) => {
    if (grants.get(c.req.header('X-App-Delegation') ?? '')?.id !== owner.id)
      return c.json({ error: 'Owner required' }, 403);
    const input = await c.req.json<{
      planRevisionId: string;
      quantity: number;
      expectedSubscriptionRevision: string;
    }>();
    if (
      input.planRevisionId !== billingPlanRevisionId ||
      input.expectedSubscriptionRevision !== '1'
    )
      return c.json({ error: 'Invalid quote scope' }, 409);
    return c.json({
      success: true,
      data: {
        id: randomUUID(),
        appId,
        billingAccountId,
        productFamilyKey: 'workspace',
        planRevisionId: billingPlanRevisionId,
        quantity: input.quantity,
        subscriptionRevision: '1',
        dueNowCents: 0,
        nextInvoiceAmountCents: 4900 * input.quantity,
        recurringAmountCents: 4900 * input.quantity,
        currency: 'usd',
        trialEndsAt: fixtureTrial!.endsAt,
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      },
    });
  },
);
fixture.post(
  `/api/v1/apps/${appId}/billing/accounts/${billingAccountId}/subscriptions/workspace/update`,
  async (c) => {
    if (grants.get(c.req.header('X-App-Delegation') ?? '')?.id !== owner.id)
      return c.json({ error: 'Owner required' }, 403);
    const body = await c.req.text();
    const input = JSON.parse(body) as {
      idempotencyKey: string;
      billingConsent: string;
      quantity: number;
      planRevisionId: string;
    };
    if (
      input.billingConsent !== 'accepted' ||
      input.quantity !== 1 ||
      input.planRevisionId !== billingPlanRevisionId
    )
      return c.json({ error: 'Review required' }, 400);
    const prior = purchaseReceipts.get(input.idempotencyKey);
    if (prior)
      return prior.body === body
        ? c.json({ success: true, data: prior.operation })
        : c.json({ error: 'Changed retry' }, 409);
    purchaseReceipts.set(input.idempotencyKey, {
      body,
      operation: {
        id: randomUUID(),
        appId,
        billingAccountId,
        productFamilyKey: 'workspace',
        environment: 'test',
        status: 'succeeded',
        subscriptionRevision: '1',
      },
    });
    return c.json({ error: 'Fixture lost response after commit' }, 503);
  },
);
// Local-only fixture controls; providerRequest forbids external network use.
const expiryReceipts = new Map<string, { body: string; operation: AppBillingOperation }>();
fixture.post('/test/billing/external-checkout', (c) => {
  externalCheckout = {
    id: randomUUID(),
    appId,
    billingAccountId,
    environment: 'test',
    productFamilyKey: 'workspace',
    status: 'requires_action',
    action: {
      kind: 'checkout',
      url: 'https://checkout.stripe.com/c/pay/external-fixture',
      expiresAt: null,
    },
  };
  return c.json({ success: true });
});
fixture.get('/test/billing/expiry-count', (c) => c.json({ count: expiryReceipts.size }));
fixture.get(
  `/api/v1/apps/${appId}/billing/accounts/${billingAccountId}/operations/:operationId`,
  (c) => {
    if (grants.get(c.req.header('X-App-Delegation') ?? '')?.id !== owner.id)
      return c.json({ error: 'Owner required' }, 403);
    const id = c.req.param('operationId');
    for (const receipt of trialReceipts.values())
      if (receipt.operation.id === id) return c.json({ success: true, data: receipt.operation });
    if (externalCheckout?.id === id) return c.json({ success: true, data: externalCheckout });
    for (const receipt of expiryReceipts.values())
      if (receipt.operation.id === id) return c.json({ success: true, data: receipt.operation });
    return c.json({ error: 'Operation missing' }, 404);
  },
);
fixture.post(
  `/api/v1/apps/${appId}/billing/accounts/${billingAccountId}/subscriptions/workspace/checkout/expire`,
  async (c) => {
    if (grants.get(c.req.header('X-App-Delegation') ?? '')?.id !== owner.id)
      return c.json({ error: 'Owner required' }, 403);
    const body = await c.req.text();
    const input = JSON.parse(body) as { operationId: string; idempotencyKey: string };
    const prior = expiryReceipts.get(input.idempotencyKey);
    if (prior)
      return body === prior.body
        ? c.json({ success: true, data: prior.operation })
        : c.json({ error: 'Changed expiry' }, 409);
    if (
      !externalCheckout ||
      input.operationId !== externalCheckout.id ||
      externalCheckout.status !== 'requires_action' ||
      externalCheckout.action.kind !== 'checkout'
    )
      return c.json({ error: 'Open checkout required' }, 409);
    externalCheckout = {
      ...externalCheckout,
      status: 'failed',
      error: {
        code: 'APP_BILLING_CHECKOUT_EXPIRED',
        message: 'Checkout canceled.',
        retryable: false,
      },
    };
    const operation: AppBillingOperation = {
      id: randomUUID(),
      appId,
      billingAccountId,
      environment: 'test',
      productFamilyKey: 'workspace',
      status: 'succeeded',
      subscriptionRevision: '1',
    };
    expiryReceipts.set(input.idempotencyKey, { body, operation });
    return c.json({ error: 'Fixture lost expiry response after commit' }, 503);
  },
);
fixture.post('/api/v1/app-auth/delegations/google/connect', (c) => {
  const user = grants.get(c.req.header('X-App-Delegation') ?? '');
  if (!user) return c.json({ error: 'Signed out' }, 401);
  const state = randomUUID();
  googleStates.set(state, user);
  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('state', state);
  return c.json({
    success: true,
    data: {
      authUrl: authUrl.href,
      redirectUri: 'http://127.0.0.1:4173/api/google/callback',
      requestedCapabilities: GOOGLE_CAPABILITIES,
    },
  });
});
fixture.get('/google-complete', (c) => {
  const state = c.req.query('state') ?? '';
  const user = googleStates.get(state);
  googleStates.delete(state);
  if (!user) return c.text('Invalid fixture authorization', 400);
  googleAccounts.set(user.id, { id: randomUUID(), email: user.email });
  return c.html(
    '<html lang="en"><title>Local Google fixture</title><h1>Fixture Google account connected</h1><p>Close this tab and return to Outreachr.</p></html>',
  );
});
fixture.get('/api/v1/app-auth/delegations/google/connections', (c) => {
  const user = grants.get(c.req.header('X-App-Delegation') ?? '');
  if (!user) return c.json({ error: 'Signed out' }, 401);
  const account = googleAccounts.get(user.id);
  return c.json({
    success: true,
    data: account
      ? [
          {
            connectionId: account.id,
            connected: true,
            identity: { email: account.email },
            reason: 'connected',
            grantedCapabilities: [
              'google.basic_identity',
              'google.gmail.triage',
              'google.gmail.send',
              'google.calendar.read',
              'google.calendar.write',
            ],
          },
        ]
      : [],
  });
});
fixture.get('/api/v1/models', (c) =>
  c.json({
    data: [
      {
        id: 'openai/gpt-5.6-sol',
        context_length: 1050000,
        pricing: { prompt: '0.000002', completion: '0.00001' },
      },
    ],
  }),
);
fixture.post(`/api/v1/apps/${appId}/inference/chat/completions`, async (c) => {
  const input = await c.req.json<{ model: string }>();
  return c.json({
    model: input.model,
    choices: [
      {
        finish_reason: 'stop',
        message: {
          content: JSON.stringify({
            summary: 'Review the prepared follow-up task.',
            proposals: [
              {
                id: 'fixture-proposal',
                kind: 'task',
                title: 'Prepare a follow-up',
                rationale: 'Keep the next step explicit.',
                investorId: null,
                payload: {
                  title: 'Prepare a follow-up',
                  notes: null,
                  dueAt: null,
                  investorId: null,
                  personId: null,
                },
              },
            ],
          }),
        },
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 100 },
  });
});
const providerRequest: typeof fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin !== 'http://127.0.0.1:4175')
    throw new Error('External network requests are forbidden in browser fixtures.');
  return fixture.request(url.href, init);
};
const eliza = new ElizaClient(
  {
    appId,
    clientId: randomUUID(),
    clientSecret: 'fixture-secret'.repeat(4),
    billingEnvironment: 'test',
    apiOrigin: 'http://127.0.0.1:4175',
    loginOrigin: 'http://127.0.0.1:4175',
    publicOrigin: 'http://127.0.0.1:4173',
  },
  providerRequest,
);
const inference = new InferenceClient(
  { ...eliza.config, developerApiKey: 'fixture-inference-key' },
  providerRequest,
);
const fixtureOwnerWorkspace = (
  await new WorkspaceStore(pool, () => new Date(), 'cloud').signIn(owner)
).organizations[0]!;
const runs = new AgentRuns();
const sessions = new SessionStore(pool, new CredentialCipher(randomBytes(32).toString('base64')));
const runtime = new CloudRuntime({
  pool,
  eliza,
  revision: 'browser-fixture',
  agentFactory: (context) => new CloudAgent(context, inference, runs),
});
const app = createApp({
  config: {
    publicOrigin: 'http://127.0.0.1:4173',
    elizaOrigin: 'http://127.0.0.1:4175',
    elizaLoginOrigin: 'http://127.0.0.1:4175',
    elizaAppId: appId,
    productFamilyKey: 'workspace',
    edgeSecret: 'fixture-edge'.repeat(4),
    production: false,
    revision: 'browser-fixture',
  },
  pool,
  sessions,
  eliza,
  runtime,
  agentRuns: runs,
});
const bff = serve({ fetch: app.fetch, port: 4174, hostname: '127.0.0.1' });
const oauth = serve({ fetch: fixture.fetch, port: 4175, hostname: '127.0.0.1' });
process.stdout.write('Local browser fixture ready.\n');
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await Promise.all([
    new Promise<void>((resolve) => bff.close(() => resolve())),
    new Promise<void>((resolve) => oauth.close(() => resolve())),
  ]);
  await pool.end();
  for (let i = 0; i < 100; i++) {
    const result = await admin.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=$1',
      [database],
    );
    if (!result.rows[0]!.count) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await admin.query(`DROP DATABASE "${database}"`);
  await admin.end();
  process.exit(0);
}
process.once('SIGTERM', () => {
  void stop();
});
process.once('SIGINT', () => {
  void stop();
});
