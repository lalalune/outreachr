/** Real PostgreSQL commits with an explicitly simulated generic Cloud provider. */
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { WorkspaceStore, entitlement, memberOrganization } from '../../src/workspaces';
import { CloudProvisioning } from '../../src/billing-provisioning';
import { ElizaClient } from '../../src/eliza';
import { migrate } from '../../src/schema';
const url = new URL(
  process.env.TEST_DATABASE_URL ?? 'postgres://outreachr@127.0.0.1:55439/postgres',
);
if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
  throw new Error('Provisioning tests require local PostgreSQL.');
const admin = new Pool({ connectionString: url.href });
const database = `outreachr_signup_${randomUUID().replaceAll('-', '')}`;
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
  name: 'Signup fixture',
  emailVerified: true,
});
async function fixture() {
  const owner = identity();
  const workspaces = new WorkspaceStore(pool, () => new Date(), 'cloud');
  const org = (await workspaces.signIn(owner)).organizations[0]!;
  const config = {
    appId: randomUUID(),
    clientId: randomUUID(),
    clientSecret: 'fixture-only',
    billingEnvironment: 'test' as const,
    apiOrigin: 'https://signup.fixture.test',
    loginOrigin: 'https://login.fixture.test',
    publicOrigin: 'http://localhost:4444',
  };
  const startsAt = new Date(Date.now() - 90_000).toISOString();
  const endsAt = new Date(Date.parse(startsAt) + 7 * 86400_000).toISOString();
  const planId = randomUUID();
  type Account = {
    id: string;
    ref: string;
    name: string;
    trial: boolean;
    rev: number;
    seat: string | null;
    subscriptionId: string;
  };
  const accounts = new Map<string, Account>();
  const receipts = new Map<string, { body: string; response: unknown }>();
  const memberReceipts = new Map<string, { body: string; response: unknown }>();
  const state = {
    claimed: false,
    resolveLost: false,
    trialLost: false,
    foreign: false,
    offline: false,
    snapshotLag: false,
    pendingReceipt: false,
    reject: false,
    terminalFailure: false,
    accountEffects: 0,
    trialEffects: 0,
    bodies: [] as string[],
    operationReads: 0,
  };
  const scope = (a: Account) => ({
    appId: config.appId,
    billingAccountId: a.id,
    environment: 'test',
    productFamilyKey: 'workspace',
  });
  const operationId = randomUUID();
  const cloud = new ElizaClient(config, async (input, init) => {
    if (state.offline) throw new Error('Cloud unavailable');
    const path = new URL(String(input));
    expect(path.searchParams.get('clientId')).toBe(config.clientId);
    const headers = new Headers(init?.headers);
    expect(headers.has('X-Eliza-Developer-Authorization')).toBe(false);
    if (path.pathname.endsWith('/catalog'))
      return Response.json({
        success: true,
        data: {
          appId: config.appId,
          environment: 'test',
          plans: [
            {
              id: planId,
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
    expect(headers.get('Authorization')).toBe(
      `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`,
    );
    const backend = path.pathname.endsWith('/members') || path.pathname.endsWith('/members/sync');
    expect(headers.get('X-App-Delegation')).toBe(backend ? null : 'owner-grant');
    if (path.pathname.endsWith('/billing/accounts')) {
      const request = JSON.parse(String(init?.body));
      let a = accounts.get(request.externalReference);
      if (!a) {
        a = {
          id: randomUUID(),
          ref: request.externalReference,
          name: request.displayName,
          trial: false,
          rev: 0,
          seat: null,
          subscriptionId: randomUUID(),
        };
        accounts.set(a.ref, a);
        state.accountEffects++;
      }
      if (state.resolveLost) {
        state.resolveLost = false;
        throw new Error('Resolved account response lost');
      }
      return Response.json({
        success: true,
        data: {
          id: a.id,
          appId: config.appId,
          externalReference: a.ref,
          displayName: a.name,
          role: 'administrator',
        },
      });
    }
    const a = [...accounts.values()].find((a) => path.pathname.includes(`/accounts/${a.id}/`));
    expect(a).toBeDefined();
    if (!a) throw new Error('Unknown fixture account');
    if (path.pathname.endsWith('/subscriptions/workspace')) {
      const visible = a.trial && !state.snapshotLag;
      return Response.json({
        success: true,
        data: {
          account: {
            id: a.id,
            appId: config.appId,
            externalReference: a.ref,
            displayName: a.name,
            role: 'administrator',
          },
          environment: 'test',
          productFamilyKey: 'workspace',
          observedAt: new Date().toISOString(),
          mutationRevision: visible ? '1' : null,
          pendingOperation: null,
          subscription: visible
            ? {
                ...scope(a),
                id: a.subscriptionId,
                planRevisionId: planId,
                planKey: 'sol',
                revision: '1',
                status: 'trialing',
                quantity: 1,
                currentPeriodStart: startsAt,
                currentPeriodEnd: endsAt,
                trial: { startedAt: startsAt, endsAt },
                cancelAtPeriodEnd: false,
                canceledAt: null,
              }
            : null,
          entitlement: visible
            ? {
                sourceSubscriptionRevision: '1',
                access: 'granted',
                featureKeys: [],
                seatCapacity: 1,
                assignedSeats: a.seat ? 1 : 0,
                validUntil: endsAt,
              }
            : null,
          allowances: visible
            ? [
                {
                  source: 'trial',
                  amountUsd: '2',
                  usedUsd: '0.1',
                  reservedUsd: '0.02',
                  remainingUsd: '1.88',
                  expiresAt: endsAt,
                },
              ]
            : [],
          trialEligibility:
            state.claimed && !state.snapshotLag
              ? { status: 'claimed', startedAt: startsAt, endsAt }
              : { status: 'eligible' },
        },
      });
    }
    if (path.pathname.endsWith('/trial')) {
      const body = String(init?.body);
      const request = JSON.parse(body);
      state.bodies.push(body);
      const saved = (
        await pool.query(
          'SELECT request_json,confirmed_at FROM outreachr.cloud_billing_intents WHERE id=$1',
          [request.idempotencyKey.slice('purchase:'.length)],
        )
      ).rows[0];
      expect(saved.request_json).toEqual(request);
      expect(saved.confirmed_at).toBeNull();
      expect(request).not.toHaveProperty('billingConsent');
      const previous = receipts.get(request.idempotencyKey);
      if (previous) {
        expect(previous.body).toBe(body);
        return Response.json(previous.response);
      }
      if (state.reject) {
        state.reject = false;
        return Response.json(
          { success: false, code: 'APP_BILLING_COMMAND_NOT_APPLIED', error: 'Not applied' },
          { status: 409 },
        );
      }
      const response = {
        success: true,
        data: state.terminalFailure
          ? {
              ...scope(a),
              id: operationId,
              status: 'failed',
              error: {
                code: 'FIXTURE_TERMINAL_FAILURE',
                message: 'No trial started',
                retryable: false,
              },
            }
          : { ...scope(a), id: operationId, status: 'succeeded', subscriptionRevision: '1' },
      };
      receipts.set(request.idempotencyKey, { body, response });
      if (!state.terminalFailure) {
        expect(state.claimed).toBe(false);
        state.claimed = true;
        a.trial = true;
        state.trialEffects++;
      }
      if (state.trialLost) {
        state.trialLost = false;
        throw new Error('Trial committed but response lost');
      }
      if (state.foreign) {
        state.foreign = false;
        return Response.json({
          ...response,
          data: { ...response.data, billingAccountId: randomUUID() },
        });
      }
      if (state.pendingReceipt) {
        state.pendingReceipt = false;
        return Response.json({
          success: true,
          data: { ...scope(a), id: operationId, status: 'pending', retryAfterSeconds: 0 },
        });
      }
      return Response.json(response);
    }
    if (path.pathname.includes('/operations/')) {
      state.operationReads++;
      return Response.json([...receipts.values()].at(-1)!.response);
    }
    if (path.pathname.endsWith('/members'))
      return Response.json({
        success: true,
        data: {
          ...scope(a),
          revision: String(a.rev),
          members: [{ userId: owner.id, role: 'administrator', active: true }],
        },
      });
    if (path.pathname.endsWith('/members/sync')) {
      const body = String(init?.body);
      const request = JSON.parse(body);
      const prior = memberReceipts.get(request.idempotencyKey);
      if (prior) {
        expect(prior.body).toBe(body);
        return Response.json(prior.response);
      }
      if (request.expectedRevision !== String(a.rev))
        return Response.json(
          { code: 'APP_BILLING_MEMBERSHIP_REVISION_CONFLICT', error: 'Stale revision' },
          { status: 409 },
        );
      if (!a.trial) return Response.json({ error: 'No seat entitlement' }, { status: 409 });
      expect(request.userId).toBe(owner.id);
      expect(request.seats).toEqual([{ productFamilyKey: 'workspace', assigned: true }]);
      a.seat ??= randomUUID();
      a.rev++;
      const response = {
        success: true,
        data: {
          ...scope(a),
          revision: String(a.rev),
          member: { userId: owner.id, role: 'administrator', active: true },
          seats: [{ productFamilyKey: 'workspace', seatId: a.seat }],
        },
      };
      memberReceipts.set(request.idempotencyKey, { body, response });
      return Response.json(response);
    }
    throw new Error(`Unexpected provider request ${path.pathname}`);
  });
  const provisioning = new CloudProvisioning(pool, cloud, 'workspace');
  const resume = () => provisioning.resume(owner.id, org.id, 'owner-grant');
  return {
    owner,
    org,
    workspaces,
    cloud,
    config,
    provisioning,
    state,
    accounts,
    startsAt,
    endsAt,
    resume,
  };
}
it('creates one Cloud-backed default workspace under concurrent signup and grants only the canonical trial and seat', async () => {
  const f = await fixture();
  const entries = await Promise.all([f.workspaces.signIn(f.owner), f.workspaces.signIn(f.owner)]);
  expect(new Set(entries.map((e) => e.user.default_org_id)).size).toBe(1);
  expect(f.org.trial_ends_at).toBeNull();
  expect(entitlement(f.org, new Date()).canEdit).toBe(false);
  await Promise.all([f.resume(), f.resume(), f.resume()]);
  const ready = await memberOrganization(pool, f.owner.id, f.org.id);
  expect(ready.cloud_provisioning_state).toBe('ready');
  expect(ready.cloud_membership_ready).toBe(true);
  expect(ready.trial_started_at?.toISOString()).toBe(f.startsAt);
  expect(ready.trial_ends_at?.toISOString()).toBe(f.endsAt);
  expect(entitlement(ready, new Date()).canEdit).toBe(true);
  expect(entitlement(ready, new Date(f.endsAt)).canEdit).toBe(false);
  expect(f.state.accountEffects).toBe(1);
  expect(f.state.trialEffects).toBe(1);
  await f.resume();
  expect(f.state.trialEffects).toBe(1);
});
it('recovers account and trial response loss with the same workspace and exact saved trial body after restart', async () => {
  const f = await fixture();
  f.state.resolveLost = true;
  await f.resume();
  expect(f.state.accountEffects).toBe(1);
  expect(f.state.trialEffects).toBe(0);
  f.state.trialLost = true;
  const pending = await f.resume();
  expect(pending.cloud_provisioning_state).toBe('pending');
  expect(entitlement(pending, new Date()).canEdit).toBe(false);
  const reopened = new CloudProvisioning(pool, f.cloud, 'workspace');
  const ready = await reopened.resume(f.owner.id, f.org.id, 'owner-grant');
  expect(ready.cloud_provisioning_state).toBe('ready');
  expect(f.state.accountEffects).toBe(1);
  expect(f.state.trialEffects).toBe(1);
  expect(f.state.bodies[1]).toBe(f.state.bodies[0]);
});
it('polls an acknowledged pending trial operation without resubmitting it', async () => {
  const f = await fixture();
  f.state.pendingReceipt = true;
  await f.resume();
  await f.resume();
  expect(f.state.bodies).toHaveLength(1);
  expect(f.state.operationReads).toBe(1);
  expect(f.state.trialEffects).toBe(1);
});
it('does not grant access or submit another trial from a success receipt while the snapshot still lacks the subscription', async () => {
  const f = await fixture();
  f.state.snapshotLag = true;
  expect((await f.resume()).cloud_provisioning_state).toBe('pending');
  const pending = await f.resume();
  expect(entitlement(pending, new Date()).canEdit).toBe(false);
  expect(f.state.bodies).toHaveLength(1);
  f.state.snapshotLag = false;
  expect((await f.resume()).cloud_provisioning_state).toBe('ready');
  expect(f.state.trialEffects).toBe(1);
});
it('preserves an ambiguous foreign receipt and rejects changed registration during recovery', async () => {
  const f = await fixture();
  f.state.foreign = true;
  const pending = await f.resume();
  expect(entitlement(pending, new Date()).canEdit).toBe(false);
  const changed = new CloudProvisioning(
    pool,
    new ElizaClient({ ...f.config, clientId: randomUUID() }, async () => {
      throw new Error('Must not dispatch changed identity');
    }),
    'workspace',
  );
  expect((await changed.resume(f.owner.id, f.org.id, 'owner-grant')).cloud_provisioning_state).toBe(
    'pending',
  );
  expect(f.state.bodies).toHaveLength(1);
  expect((await f.resume()).cloud_provisioning_state).toBe('ready');
  expect(f.state.trialEffects).toBe(1);
});
it('allows a new free-trial intent only after confirmed unexecuted rejection', async () => {
  const f = await fixture();
  f.state.reject = true;
  await f.resume();
  expect(f.state.trialEffects).toBe(0);
  expect((await f.resume()).cloud_provisioning_state).toBe('ready');
  expect(f.state.bodies[0]).not.toBe(f.state.bodies[1]);
  expect(f.state.trialEffects).toBe(1);
});
it('stops terminal failures until explicit retry and never substitutes a local trial during outages', async () => {
  const f = await fixture();
  f.state.offline = true;
  const unavailable = await f.resume();
  expect(unavailable.cloud_billing_account_id).toBeNull();
  expect(unavailable.trial_ends_at).toBeNull();
  expect(entitlement(unavailable, new Date()).active).toBe(false);
  f.state.offline = false;
  f.state.terminalFailure = true;
  expect((await f.resume()).cloud_provisioning_state).toBe('failed');
  await f.resume();
  expect(f.state.bodies).toHaveLength(1);
  f.state.terminalFailure = false;
  expect(
    (await f.provisioning.retry(f.owner.id, f.org.id, 'owner-grant')).cloud_provisioning_state,
  ).toBe('ready');
  expect(f.state.trialEffects).toBe(1);
});
it('honors Cloud claimed eligibility and does not start automatic trials on additional workspaces', async () => {
  const f = await fixture();
  f.state.claimed = true;
  const ineligible = await f.resume();
  expect(ineligible.cloud_provisioning_state).toBe('ineligible');
  expect(f.state.trialEffects).toBe(0);
  expect(entitlement(ineligible, new Date()).canEdit).toBe(false);
  const second = await f.workspaces.create(f.owner.id, 'Another workspace');
  expect(second.cloud_trial_requested).toBe(false);
  expect(
    (await f.provisioning.resume(f.owner.id, second.id, 'owner-grant')).cloud_provisioning_state,
  ).toBe('ready');
  expect(f.state.bodies).toHaveLength(0);
  // Purchaser authority does not require buying an editing seat beforehand.
  const review = await f.provisioning.billing.review(f.owner.id, second.id, 'owner-grant', {
    plan: 'sol',
    seats: 1,
  });
  expect(review.state).toBe('review');
  expect(review.review).toMatchObject({ kind: 'checkout', monthlyTotalCents: 4900, seats: 1 });
  expect(f.state.trialEffects).toBe(0);
});
it('preserves legacy trial history for explicit reconciliation instead of claiming a new Cloud trial', async () => {
  const owner = identity();
  const oldStore = new WorkspaceStore(pool);
  const original = (await oldStore.signIn(owner)).organizations[0]!;
  const migrated = (await new WorkspaceStore(pool, () => new Date(), 'cloud').signIn(owner))
    .organizations[0]!;
  expect(migrated.cloud_provisioning_state).toBe('migration_required');
  expect(migrated.trial_ends_at).toEqual(original.trial_ends_at);
  expect(entitlement(migrated, new Date()).canEdit).toBe(false);
});

it('invalidates editing instead of overwriting conflicting original trial history', async () => {
  const f = await fixture();
  await f.resume();
  const originalEnd = new Date(Date.parse(f.endsAt) - 60_000);
  await pool.query('UPDATE outreachr.organizations SET trial_ends_at=$2 WHERE id=$1', [
    f.org.id,
    originalEnd,
  ]);
  await expect(
    f.provisioning.accounts.snapshot(f.owner.id, f.org.id, 'owner-grant'),
  ).rejects.toMatchObject({ code: 'billing_trial_history_changed' });
  const denied = await memberOrganization(pool, f.owner.id, f.org.id);
  expect(denied.trial_ends_at).toEqual(originalEnd);
  expect(denied.cloud_billing_invalidated).toBe(true);
  expect(entitlement(denied, new Date()).canEdit).toBe(false);
});
