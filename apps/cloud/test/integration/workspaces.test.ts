import { CloudBillingAccounts } from '../../src/billing-accounts';
import { createAppNotificationSignature } from '@elizaos/cloud-sdk/app-notifications';
import { DELEGATION_SCOPES, GOOGLE_CAPABILITIES } from '../../src/delegation';
/** Exercises real PostgreSQL transactions, competing sessions, and durable tenant boundaries. */
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { closeTestDatabase } from '../disposable-database';
import { migrate } from '../../src/schema';
import { WorkspaceStore, entitlement, memberOrganization } from '../../src/workspaces';
import { UsageStore } from '../../src/usage';
import { withWorkspaceLock } from '../../src/database';
import { postgresVaultPersistence } from '../../src/vault-persistence';
import { CredentialCipher, SessionStore } from '../../src/sessions';
import { ElizaClient } from '../../src/eliza';
import { createApp } from '../../src/app';
import { FileStore } from '../../src/files';
import { CloudRuntime } from '../../src/runtime';
import { CloudAgent, AgentRuns } from '../../src/agent';
import { InferenceClient } from '../../src/inference';
import type { AgentEvent } from '../../../desktop/src/shared/contracts';

const testAppId = randomUUID();
const delegationConfig = (apiOrigin: string) => ({
  appId: testAppId,
  apiOrigin,
  clientId: randomUUID(),
  clientSecret: 'fixture-client-secret',
  billingEnvironment: 'test' as const,
  publicOrigin: 'http://localhost:4444',
  loginOrigin: 'https://eliza.test',
});
const database = `outreachr_test_${randomUUID().replaceAll('-', '')}`;
const url = new URL(
  process.env.TEST_DATABASE_URL ?? 'postgres://outreachr@127.0.0.1:55439/postgres',
);
if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
  throw new Error('Integration tests require a local disposable PostgreSQL server.');
const admin = new Pool({ connectionString: url.href });
url.pathname = `/${database}`;
const pool = new Pool({ connectionString: url.href, max: 10 });
let clock = new Date('2026-09-04T12:00:00Z');
const store = new WorkspaceStore(pool, () => clock);
const usage = new UsageStore(pool, () => clock);
const identity = (email = `${randomUUID()}@example.com`) => ({
  id: randomUUID(),
  email,
  name: 'Test account',
  emailVerified: true,
});

beforeAll(async () => {
  await admin.query(`CREATE DATABASE "${database}"`);
  await migrate(pool);
});
afterAll(() => closeTestDatabase(pool, admin, database));

describe('workspace authority', () => {
  it('concurrent first login creates exactly one default workspace and one trial', async () => {
    const account = identity();
    const results = await Promise.all([
      store.signIn(account),
      store.signIn(account),
      store.signIn(account),
    ]);
    expect(new Set(results.map((r) => r.user.default_org_id)).size).toBe(1);
    expect(await store.list(account.id)).toHaveLength(1);
    const org = results[0]!.organizations[0]!;
    expect(org.trial_ends_at!.getTime() - clock.getTime()).toBe(7 * 86_400_000);
    const second = await store.create(account.id, 'Second workspace');
    expect(entitlement(second, clock).active).toBe(false);
    clock = new Date(org.trial_ends_at!);
    expect(entitlement((await store.signIn(account)).organizations[0]!, clock).active).toBe(false);
  });

  it('requires verified identity and hides other tenant identifiers', async () => {
    await expect(store.signIn({ ...identity(), emailVerified: false })).rejects.toMatchObject({
      code: 'verified_email_required',
    });
    const a = identity();
    const b = identity();
    const org = (await store.signIn(a)).organizations[0]!;
    await store.signIn(b);
    await expect(memberOrganization(pool, b.id, org.id)).rejects.toMatchObject({
      code: 'workspace_not_found',
    });
    await expect(store.members(b.id, org.id)).rejects.toMatchObject({
      code: 'workspace_not_found',
    });
    await expect(store.invite(b.id, org.id, 'other@example.com', 'viewer')).rejects.toMatchObject({
      code: 'workspace_not_found',
    });
  });

  it('binds invites to verified email, consumes once, and keeps viewers read-only', async () => {
    const owner = identity();
    const guest = identity();
    const wrong = identity();
    const org = (await store.signIn(owner)).organizations[0]!;
    await store.signIn(guest);
    await store.signIn(wrong);
    const invitation = await store.invite(owner.id, org.id, guest.email.toUpperCase(), 'viewer');
    await expect(store.acceptInvite(wrong.id, invitation.token)).rejects.toMatchObject({
      code: 'invite_email_mismatch',
    });
    const joined = await store.acceptInvite(guest.id, invitation.token);
    expect(joined.role).toBe('viewer');
    expect(entitlement(joined, clock).canEdit).toBe(false);
    expect((await store.acceptInvite(guest.id, invitation.token)).id).toBe(joined.id);
    await expect(store.invite(guest.id, org.id, wrong.email, 'viewer')).rejects.toMatchObject({
      code: 'admin_required',
    });
    await expect(usage.reserve(guest.id, org.id, randomUUID(), 1)).rejects.toMatchObject({
      code: 'subscription_required',
    });
  });

  it('rejects revoked and expired invites even with the correct account', async () => {
    const owner = identity();
    const guest = identity();
    const org = (await store.signIn(owner)).organizations[0]!;
    await store.signIn(guest);
    const revoked = await store.invite(owner.id, org.id, guest.email, 'viewer');
    await store.revokeInvite(owner.id, org.id, revoked.id);
    await expect(store.acceptInvite(guest.id, revoked.token)).rejects.toMatchObject({
      code: 'invite_expired',
    });
    const expired = await store.invite(owner.id, org.id, guest.email, 'viewer');
    clock = new Date(expired.expiresAt);
    await expect(store.acceptInvite(guest.id, expired.token)).rejects.toMatchObject({
      code: 'invite_expired',
    });
  });

  it('serializes two invitation acceptances competing for one remaining paid seat', async () => {
    const owner = identity();
    const guests = [identity(), identity()];
    const org = (await store.signIn(owner)).organizations[0]!;
    await pool.query('UPDATE outreachr.organizations SET seat_capacity=2 WHERE id=$1', [org.id]);
    await Promise.all(guests.map((g) => store.signIn(g)));
    const invites = await Promise.all(
      guests.map((g) => store.invite(owner.id, org.id, g.email, 'member')),
    );
    const results = await Promise.allSettled(
      guests.map((g, i) => store.acceptInvite(g.id, invites[i]!.token)),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({
      reason: { code: 'seat_capacity' },
    });
    expect((await store.members(owner.id, org.id)).filter((m) => m.role !== 'viewer')).toHaveLength(
      2,
    );
  });

  it('protects the last owner and prevents viewer escalation', async () => {
    const owner = identity();
    const guest = identity();
    const org = (await store.signIn(owner)).organizations[0]!;
    await store.signIn(guest);
    const invitation = await store.invite(owner.id, org.id, guest.email, 'viewer');
    await store.acceptInvite(guest.id, invitation.token);
    await expect(store.changeMember(owner.id, org.id, owner.id, null)).rejects.toMatchObject({
      code: 'last_owner',
    });
    await expect(store.changeMember(owner.id, org.id, owner.id, 'viewer')).rejects.toMatchObject({
      code: 'last_owner',
    });
    await expect(store.changeMember(guest.id, org.id, guest.id, 'owner')).rejects.toMatchObject({
      code: 'admin_required',
    });
    await expect(store.changeMember(owner.id, org.id, guest.id, 'member')).rejects.toMatchObject({
      code: 'seat_capacity',
    });
  });

  it('reserves allowance atomically, rejects replay, and retains uncertain provider spend', async () => {
    const owner = identity();
    const org = (await store.signIn(owner)).organizations[0]!;
    const results = await Promise.allSettled([
      usage.reserve(owner.id, org.id, randomUUID(), 150),
      usage.reserve(owner.id, org.id, randomUUID(), 150),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const reservation = results.find((r) => r.status === 'fulfilled')!;
    if (reservation.status !== 'fulfilled') throw new Error('Expected reservation');
    await usage.settle(org.id, reservation.value.id, { status: 'ambiguous' });
    expect((await usage.summary(owner.id, org.id)).usedCents).toBe(150);
    const key = randomUUID();
    const second = await usage.reserve(owner.id, org.id, key, 20);
    await usage.settle(org.id, second.id, { status: 'failed', cents: 0 });
    await expect(usage.reserve(owner.id, org.id, key, 20)).rejects.toMatchObject({
      code: 'request_already_submitted',
    });
    await usage.settle(org.id, reservation.value.id, { status: 'completed', cents: 37 });
    await usage.settle(org.id, reservation.value.id, { status: 'completed', cents: 37 });
    expect((await usage.summary(owner.id, org.id)).usedCents).toBe(37);
    await expect(
      usage.settle(org.id, reservation.value.id, { status: 'completed', cents: 0 }),
    ).rejects.toMatchObject({ code: 'usage_already_settled' });
  });

  it('keeps recovery records for Cloud-funded requests without imposing a second estimated balance', async () => {
    const owner = identity();
    const org = (await store.signIn(owner)).organizations[0]!;
    await pool.query(
      `UPDATE outreachr.organizations SET cloud_app_id=$2,cloud_billing_account_id=$3,
      cloud_billing_environment='test',cloud_product_family_key='workspace',subscription_status='trialing',
      cloud_billing_access='granted',cloud_billing_observed_at=$4,cloud_billing_valid_until=$5 WHERE id=$1`,
      [org.id, randomUUID(), randomUUID(), clock, new Date(clock.getTime() + 60_000)],
    );
    const key = randomUUID();
    // Above the local trial estimate; the generic inference route owns atomic allowance/funding authorization.
    const record = await usage.reserve(owner.id, org.id, key, 300);
    expect(record.status).toBe('reserved');
    await expect(usage.reserve(owner.id, org.id, key, 300)).rejects.toMatchObject({
      code: 'request_already_submitted',
    });
    await pool.query(
      'UPDATE outreachr.organizations SET cloud_billing_invalidated=true WHERE id=$1',
      [org.id],
    );
    await expect(usage.reserve(owner.id, org.id, randomUUID(), 1)).rejects.toMatchObject({
      code: 'subscription_required',
    });
  });

  it('persists send checkpoints even when subsequent work fails and serializes independent connections', async () => {
    const owner = identity();
    const org = (await store.signIn(owner)).organizations[0]!;
    await expect(
      withWorkspaceLock(pool, org.id, async (client) => {
        await postgresVaultPersistence(client, org.id).save(
          Buffer.from('reserved-before-provider'),
        );
        throw new Error('Provider response lost');
      }),
    ).rejects.toThrow('Provider response lost');
    expect(
      await withWorkspaceLock(pool, org.id, async (client) =>
        Buffer.from((await postgresVaultPersistence(client, org.id).load())!).toString(),
      ),
    ).toBe('reserved-before-provider');
    await withWorkspaceLock(pool, org.id, (client) =>
      postgresVaultPersistence(client, org.id).save(Buffer.from('0')),
    );
    await Promise.all(
      Array.from({ length: 8 }, () =>
        withWorkspaceLock(pool, org.id, async (client) => {
          const persistence = postgresVaultPersistence(client, org.id);
          const count = Number(Buffer.from((await persistence.load())!).toString());
          await persistence.save(Buffer.from(String(count + 1)));
        }),
      ),
    );
    expect(
      await withWorkspaceLock(pool, org.id, async (client) =>
        Buffer.from((await postgresVaultPersistence(client, org.id).load())!).toString(),
      ),
    ).toBe('8');
  });
});

describe('generic purchaser account mapping', () => {
  it('accepts signed Cloud hints atomically, rejects tampering, and refreshes current authority instead of event order', async () => {
    const owner = identity();
    const workspaces = new WorkspaceStore(pool);
    const org = (await workspaces.signIn(owner)).organizations[0]!;
    const accountId = randomUUID();
    const keyId = randomUUID();
    const previousKeyId = randomUUID();
    const keys = {
      [keyId]: randomBytes(32).toString('hex'),
      [previousKeyId]: randomBytes(32).toString('hex'),
    };
    const current = new Date();
    const periodEnd = new Date(current.getTime() + 86_400_000).toISOString();
    const grant = `ead_${'n'.repeat(43)}`;
    let providerAvailable = true;
    let reads = 0;
    const cloud = new ElizaClient(
      delegationConfig('https://notifications.fixture.test'),
      async () => {
        reads += 1;
        if (!providerAvailable) throw new Error('Unconfirmed billing');
        return Response.json({
          success: true,
          data: {
            account: {
              id: accountId,
              appId: testAppId,
              externalReference: org.id,
              displayName: org.name,
              role: 'administrator',
            },
            environment: 'test',
            productFamilyKey: 'workspace',
            observedAt: new Date().toISOString(),
            mutationRevision: '9',
            pendingOperation: null,
            subscription: {
              appId: testAppId,
              environment: 'test',
              billingAccountId: accountId,
              productFamilyKey: 'workspace',
              id: accountId,
              planRevisionId: randomUUID(),
              planKey: 'astra',
              revision: '9',
              status: 'active',
              quantity: 2,
              currentPeriodStart: current.toISOString(),
              currentPeriodEnd: periodEnd,
              trial: null,
              cancelAtPeriodEnd: false,
              canceledAt: null,
            },
            entitlement: {
              sourceSubscriptionRevision: '9',
              access: 'granted',
              featureKeys: [],
              seatCapacity: 2,
              assignedSeats: 1,
              validUntil: periodEnd,
            },
            allowances: [],
            trialEligibility: {
              status: 'claimed',
              startedAt: current.toISOString(),
              endsAt: org.trial_ends_at!.toISOString(),
            },
          },
        });
      },
    );
    await pool.query(
      `UPDATE outreachr.organizations SET cloud_app_id=$2,cloud_billing_account_id=$3,
      cloud_billing_environment='test',cloud_product_family_key='workspace' WHERE id=$1`,
      [org.id, testAppId, accountId],
    );
    const accounts = new CloudBillingAccounts(pool, cloud, 'workspace');
    expect(entitlement(await memberOrganization(pool, owner.id, org.id), new Date()).canEdit).toBe(
      false,
    );
    await accounts.snapshot(owner.id, org.id, grant);
    expect(entitlement(await memberOrganization(pool, owner.id, org.id), new Date())).toMatchObject(
      { canEdit: true, plan: 'astra' },
    );
    const app = createApp({
      pool,
      sessions: new SessionStore(pool, new CredentialCipher(randomBytes(32).toString('base64'))),
      eliza: cloud,
      config: {
        publicOrigin: 'https://outreachr.fixture.test',
        elizaOrigin: cloud.config.apiOrigin,
        elizaLoginOrigin: cloud.config.loginOrigin,
        elizaAppId: testAppId,
        productFamilyKey: 'workspace',
        billingNotificationKeys: keys,
        edgeSecret: 'notification-edge-fixture',
        production: true,
        revision: 'notification-fixture',
      },
    });
    const event = {
      version: 1,
      id: randomUUID(),
      event: 'app.subscription.updated',
      appId: testAppId,
      environment: 'test',
      billingAccountId: accountId,
      productFamilyKey: 'workspace',
      subscriptionRevision: '8',
      occurredAt: current.toISOString(),
    };
    const signed = async (
      value = event,
      selectedKey = keyId,
      timestamp = new Date().toISOString(),
    ) => {
      const body = JSON.stringify(value);
      return {
        method: 'POST',
        body,
        headers: {
          'Content-Type': 'application/json',
          'X-Outreachr-Edge': 'notification-edge-fixture',
          'X-Eliza-Key-Id': selectedKey,
          'X-Eliza-Delivery': value.id,
          'X-Eliza-Event': value.event,
          'X-Eliza-Timestamp': timestamp,
          'X-Eliza-Signature': await createAppNotificationSignature(
            keys[selectedKey]!,
            timestamp,
            body,
          ),
        },
      };
    };
    const endpoint = '/api/billing/notifications';
    const good = await signed();
    expect(
      (
        await app.request(endpoint, {
          ...good,
          headers: { ...good.headers, 'X-Outreachr-Edge': 'wrong' },
        })
      ).status,
    ).toBe(403);
    expect((await app.request(endpoint, { ...good, body: `${good.body} ` })).status).toBe(401);
    expect(
      (await app.request(endpoint, await signed({ ...event, environment: 'live' }))).status,
    ).toBe(401);
    expect(
      (
        await app.request(
          endpoint,
          await signed(event, keyId, new Date(current.getTime() - 301_000).toISOString()),
        )
      ).status,
    ).toBe(401);
    expect(reads).toBe(1);
    const responses = await Promise.all(
      Array.from({ length: 4 }, () => app.request(endpoint, good)),
    );
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200]);
    expect(
      (
        await pool.query('SELECT id FROM outreachr.cloud_billing_notifications WHERE id=$1', [
          event.id,
        ])
      ).rowCount,
    ).toBe(1);
    expect(entitlement(await memberOrganization(pool, owner.id, org.id), new Date()).canEdit).toBe(
      false,
    );
    // A normal app request recovers revision 9/Astra after the revision 8 hint.
    await accounts.ensureCurrent(owner.id, org.id, grant);
    expect(entitlement(await memberOrganization(pool, owner.id, org.id), new Date())).toMatchObject(
      { canEdit: true, plan: 'astra' },
    );
    expect((await app.request(endpoint, await signed())).status).toBe(200);
    expect((await memberOrganization(pool, owner.id, org.id)).cloud_billing_invalidated).toBe(
      false,
    );
    expect(
      (await app.request(endpoint, await signed({ ...event, subscriptionRevision: '7' }))).status,
    ).toBe(409);
    expect((await memberOrganization(pool, owner.id, org.id)).cloud_billing_invalidated).toBe(
      false,
    );
    const delayed = { ...event, id: randomUUID(), subscriptionRevision: '6' };
    expect((await app.request(endpoint, await signed(delayed, previousKeyId))).status).toBe(200);
    providerAvailable = false;
    await expect(accounts.snapshot(owner.id, org.id, grant)).rejects.toMatchObject({
      code: 'billing_snapshot_unavailable',
    });
    const unavailable = await memberOrganization(pool, owner.id, org.id);
    expect(entitlement(unavailable, new Date()).canEdit).toBe(false);
    expect(unavailable.trial_ends_at).toEqual(org.trial_ends_at);
    expect(unavailable.plan).toBe('astra');
    expect(
      (
        await app.request('/api/billing/webhook', {
          method: 'POST',
          headers: good.headers,
          body: '{}',
        })
      ).status,
    ).toBe(403);
  });
  it('reads a bound snapshot with current membership, no fallback trial, and no provider access after removal', async () => {
    const owner = identity();
    const outsider = identity();
    const org = (await store.signIn(owner)).organizations[0]!;
    await store.signIn(outsider);
    const billingAccountId = randomUUID();
    const grant = `ead_${'r'.repeat(43)}`;
    const config = delegationConfig('https://snapshot.fixture.test');
    let calls = 0;
    let unavailable = false;
    const cloud = new ElizaClient(config, async (url, init) => {
      calls += 1;
      expect(String(url)).toBe(
        `https://snapshot.fixture.test/api/v1/apps/${testAppId}/billing/accounts/${billingAccountId}/subscriptions/workspace?clientId=${config.clientId}`,
      );
      expect(init?.method).toBe('GET');
      expect(new Headers(init?.headers).get('X-App-Delegation')).toBe(grant);
      if (unavailable) throw new Error('Cloud unavailable');
      return Response.json({
        success: true,
        data: {
          account: {
            id: billingAccountId,
            appId: testAppId,
            externalReference: org.id,
            displayName: org.name,
            role: 'administrator',
          },
          environment: 'test',
          productFamilyKey: 'workspace',
          observedAt: new Date().toISOString(),
          mutationRevision: null,
          pendingOperation: null,
          subscription: null,
          entitlement: null,
          allowances: [],
          trialEligibility: {
            status: 'claimed',
            startedAt: clock.toISOString(),
            endsAt: org.trial_ends_at!.toISOString(),
          },
        },
      });
    });
    const accounts = new CloudBillingAccounts(pool, cloud, 'workspace');
    await expect(accounts.snapshot(owner.id, org.id, grant)).rejects.toMatchObject({
      code: 'billing_account_unavailable',
    });
    expect(calls).toBe(0);
    await pool.query(
      `UPDATE outreachr.organizations SET cloud_app_id=$2,cloud_billing_account_id=$3,cloud_billing_environment='test',cloud_product_family_key='workspace' WHERE id=$1`,
      [org.id, testAppId, billingAccountId],
    );
    await expect(accounts.snapshot(outsider.id, org.id, grant)).rejects.toMatchObject({
      code: 'workspace_not_found',
    });
    expect(calls).toBe(0);
    const result = await accounts.snapshot(owner.id, org.id, grant);
    expect(result.access).toBe('read_only');
    expect(result.snapshot.subscription).toBeNull();
    expect((await memberOrganization(pool, owner.id, org.id)).trial_ends_at).toEqual(
      org.trial_ends_at,
    );
    unavailable = true;
    await expect(accounts.snapshot(owner.id, org.id, grant)).rejects.toMatchObject({
      code: 'billing_snapshot_unavailable',
    });
    expect(calls).toBe(2);
    await pool.query('DELETE FROM outreachr.memberships WHERE org_id=$1 AND user_id=$2', [
      org.id,
      owner.id,
    ]);
    await expect(accounts.snapshot(owner.id, org.id, grant)).rejects.toMatchObject({
      code: 'workspace_not_found',
    });
    expect(calls).toBe(2);
  });
  it('resolves only the owner workspace, recovers a lost response, and preserves trial/account identity', async () => {
    const owner = identity();
    const viewer = identity();
    const outsider = identity();
    const org = (await store.signIn(owner)).organizations[0]!;
    await store.signIn(viewer);
    await store.signIn(outsider);
    const invitation = await store.invite(owner.id, org.id, viewer.email, 'viewer');
    await store.acceptInvite(viewer.id, invitation.token);
    const cloudAccountId = randomUUID();
    const grant = `ead_${'q'.repeat(43)}`;
    const config = delegationConfig('https://account.fixture.test');
    const bodies: unknown[] = [];
    let mode: 'success' | 'lost' | 'foreign' | 'replacement' = 'lost';
    const cloud = new ElizaClient(config, async (url, init) => {
      expect(String(url)).toBe(
        `https://account.fixture.test/api/v1/apps/${testAppId}/billing/accounts?clientId=${config.clientId}`,
      );
      const headers = new Headers(init?.headers);
      expect(headers.get('Authorization')).toBe(
        `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`,
      );
      expect(headers.get('X-App-Delegation')).toBe(grant);
      expect(headers.has('X-Eliza-Developer-Authorization')).toBe(false);
      expect(headers.has('X-Outreachr-Client')).toBe(false);
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      expect(body).toEqual({ externalReference: org.id, displayName: org.name });
      if (mode === 'lost') throw new Error('Response lost after idempotent account creation');
      return Response.json({
        success: true,
        data: {
          id: mode === 'replacement' ? randomUUID() : cloudAccountId,
          appId: mode === 'foreign' ? randomUUID() : testAppId,
          externalReference: org.id,
          displayName: org.name,
          role: 'administrator',
        },
      });
    });
    const accounts = new CloudBillingAccounts(pool, cloud, 'workspace');
    await expect(accounts.resolveOwner(viewer.id, org.id, grant)).rejects.toMatchObject({
      code: 'owner_required',
    });
    await expect(accounts.resolveOwner(outsider.id, org.id, grant)).rejects.toMatchObject({
      code: 'workspace_not_found',
    });
    expect(bodies).toHaveLength(0);
    await expect(accounts.resolveOwner(owner.id, org.id, grant)).rejects.toMatchObject({
      code: 'billing_account_unavailable',
    });
    expect((await memberOrganization(pool, owner.id, org.id)).cloud_billing_account_id).toBeNull();
    mode = 'foreign';
    await expect(accounts.resolveOwner(owner.id, org.id, grant)).rejects.toMatchObject({
      code: 'billing_account_scope',
    });
    mode = 'success';
    const resolved = await Promise.all([
      accounts.resolveOwner(owner.id, org.id, grant),
      accounts.resolveOwner(owner.id, org.id, grant),
    ]);
    expect(resolved).toEqual(
      Array(2).fill({
        billingAccountId: cloudAccountId,
        productFamilyKey: 'workspace',
        environment: 'test',
      }),
    );
    const saved = await memberOrganization(pool, owner.id, org.id);
    expect(saved.cloud_billing_account_id).not.toBe(org.id);
    expect(saved.trial_ends_at).toEqual(org.trial_ends_at);
    mode = 'replacement';
    await expect(accounts.resolveOwner(owner.id, org.id, grant)).rejects.toMatchObject({
      code: 'billing_account_changed',
    });
    expect((await memberOrganization(pool, owner.id, org.id)).cloud_billing_account_id).toBe(
      cloudAccountId,
    );
    const calls = bodies.length;
    const anotherEnvironment = new CloudBillingAccounts(
      pool,
      new ElizaClient({ ...config, billingEnvironment: 'live' }),
      'workspace',
    );
    await expect(anotherEnvironment.resolveOwner(owner.id, org.id, grant)).rejects.toMatchObject({
      code: 'billing_binding_changed',
    });
    expect(bodies).toHaveLength(calls);
  });
});

describe('durable model response recovery', () => {
  it('retains the completed response across reopening, protects the author, and forbids replacement or redispatch', async () => {
    const owner = identity();
    const guest = identity();
    const outsider = identity();
    const org = (await store.signIn(owner)).organizations[0]!;
    await store.signIn(guest);
    await store.signIn(outsider);
    const invite = await store.invite(owner.id, org.id, guest.email, 'viewer');
    await store.acceptInvite(guest.id, invite.token);
    const operationId = randomUUID();
    const reserved = await usage.reserve(owner.id, org.id, operationId, 5);
    const response = {
      model: 'openai/gpt-5.6-sol',
      choices: [
        {
          finish_reason: 'stop',
          message: { content: '{"summary":"saved before delivery","proposals":[]}' },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 10 },
    };
    await expect(
      usage.settle(org.id, reserved.id, {
        status: 'completed',
        cents: 1,
        response: { ...response, model: 'other-model' },
      }),
    ).rejects.toMatchObject({ code: 'response_model_mismatch' });
    await usage.settle(org.id, reserved.id, { status: 'completed', cents: 1, response });
    // A new store reads the durable result even if proposal delivery never happened.
    const reopened = new UsageStore(pool, () => clock);
    expect(await reopened.recordedResult(owner.id, org.id, operationId)).toEqual({
      status: 'completed',
      response,
    });
    await reopened.settle(org.id, reserved.id, { status: 'completed', cents: 1, response });
    await expect(
      reopened.settle(org.id, reserved.id, {
        status: 'completed',
        cents: 1,
        response: {
          ...response,
          choices: [{ finish_reason: 'stop', message: { content: 'replacement' } }],
        },
      }),
    ).rejects.toMatchObject({ code: 'response_already_recorded' });
    await expect(reopened.recordedResult(guest.id, org.id, operationId)).rejects.toMatchObject({
      code: 'inference_result_not_found',
    });
    await expect(reopened.recordedResult(outsider.id, org.id, operationId)).rejects.toMatchObject({
      code: 'workspace_not_found',
    });
    await expect(reopened.reserve(owner.id, org.id, operationId, 5)).rejects.toMatchObject({
      code: 'request_already_submitted',
    });
    const pendingId = randomUUID();
    const pending = await reopened.reserve(owner.id, org.id, pendingId, 5);
    await reopened.settle(org.id, pending.id, { status: 'ambiguous' });
    expect(await reopened.recordedResult(owner.id, org.id, pendingId)).toEqual({
      status: 'ambiguous',
      response: null,
    });
  });
});

describe('HTTP login and workspace boundary', () => {
  it('exchanges once, keeps credentials server-side, rejects cross-origin writes, and revokes logout', async () => {
    const account = identity();
    const elizaPrincipal = { ...account, organizationId: randomUUID() };
    const grants = new Set<string>();
    const linkedAccountId = randomUUID();
    let linkedExternalReference = '';
    let exchanges = 0;
    let googleStarts = 0;
    let googleAuthUrl = 'https://accounts.google.com/o/oauth2/v2/auth?state=fixture';
    const provider: typeof fetch = async (input, init) => {
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
      if (path.endsWith('/token')) {
        exchanges += 1;
        const token = `ead_${randomBytes(32).toString('base64url')}`;
        grants.add(token);
        return Response.json({
          success: true,
          data: {
            token,
            appId: testAppId,
            billingEnvironment: 'test',
            scopes: DELEGATION_SCOPES,
            expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
            user: elizaPrincipal,
          },
        });
      }
      const token = new Headers(init?.headers).get('X-App-Delegation') ?? '';
      if (!grants.has(token)) return Response.json({ error: 'Revoked' }, { status: 401 });
      if (path.endsWith('/billing/accounts')) {
        const input = JSON.parse(String(init?.body));
        linkedExternalReference = input.externalReference;
        return Response.json({
          success: true,
          data: {
            id: linkedAccountId,
            appId: testAppId,
            externalReference: input.externalReference,
            displayName: input.displayName,
            role: 'administrator',
          },
        });
      }
      if (path.endsWith(`/billing/accounts/${linkedAccountId}/administrators`))
        return Response.json({
          success: true,
          data: {
            appId: testAppId,
            billingAccountId: linkedAccountId,
            environment: 'test',
            revision: '0',
            administrators: [elizaPrincipal.id],
          },
        });
      if (path.endsWith(`/billing/accounts/${linkedAccountId}/subscriptions/workspace`)) {
        return Response.json({
          success: true,
          data: {
            account: {
              id: linkedAccountId,
              appId: testAppId,
              externalReference: linkedExternalReference,
              displayName: 'Fixture workspace',
              role: 'administrator',
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
      }
      if (path.endsWith('/google/connect')) {
        googleStarts += 1;
        expect(JSON.parse(String(init?.body))).toEqual({
          redirectUri: 'http://localhost:4444/api/google/callback',
          capabilities: GOOGLE_CAPABILITIES,
        });
        return Response.json({
          success: true,
          data: {
            authUrl: googleAuthUrl,
            redirectUri: 'http://localhost:4444/api/google/callback',
            requestedCapabilities: GOOGLE_CAPABILITIES,
          },
        });
      }
      if (path.endsWith('/revoke')) {
        grants.delete(token);
        return Response.json({ success: true });
      }
      return Response.json({ success: true, data: elizaPrincipal });
    };
    const sessions = new SessionStore(
      pool,
      new CredentialCipher(randomBytes(32).toString('base64')),
    );
    const app = createApp({
      pool,
      sessions,
      eliza: new ElizaClient(delegationConfig('https://api.eliza.test'), provider),
      config: {
        publicOrigin: 'http://localhost:4444',
        elizaOrigin: 'https://api.eliza.test',
        elizaLoginOrigin: 'https://eliza.test',
        elizaAppId: testAppId,
        productFamilyKey: 'workspace',
        edgeSecret: 'edge-secret',
        production: false,
        revision: 'test-revision',
      },
    });
    expect((await app.request('/api/me')).status).toBe(401);
    expect((await app.request('/api/auth/login?returnTo=https://attacker.test')).status).toBe(400);
    const login = await app.request('/api/auth/login');
    const target = new URL(login.headers.get('location')!);
    expect(target.origin).toBe('https://eliza.test');
    const state = target.searchParams.get('state')!;
    const loginCookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const callback = `/api/auth/callback?state=${state}&code=eac_valid`;
    expect((await app.request(callback)).status).toBe(401);
    expect(exchanges).toBe(0);
    const loggedIn = await app.request(callback, { headers: { Cookie: loginCookie } });
    expect(loggedIn.status).toBe(302);
    const cookie = loggedIn.headers
      .getSetCookie()
      .find((value) => value.startsWith('outreachr_session='))!
      .split(';')[0]!;
    expect(cookie).not.toContain([...grants][0]!);
    expect((await app.request(callback, { headers: { Cookie: loginCookie } })).status).toBe(401);
    expect(exchanges).toBe(1);
    const me = await app.request('/api/me', { headers: { Cookie: cookie } });
    expect(me.status).toBe(200);
    const body = await me.json();
    expect(body.user.email).toBe(account.email);
    const ownOrg = body.organizations[0].id;
    const responseStore = new UsageStore(pool);
    const recoveryKey = `agent-run:${randomUUID()}`;
    await expect(responseStore.reserve(account.id, ownOrg, recoveryKey, 5)).rejects.toMatchObject({
      code: 'subscription_required',
    });
    // Historical results remain readable while new Cloud setup has no editing entitlement.
    const pendingResponse = { id: randomUUID() };
    await pool.query(
      `INSERT INTO outreachr.usage(id,org_id,user_id,request_key,model,period_key,reserved_cents,status)
      VALUES($1,$2,$3,$4,'openai/gpt-5.6-sol','historical-trial',5,'reserved')`,
      [pendingResponse.id, ownOrg, account.id, recoveryKey],
    );
    const recoveryPath = `/api/organizations/${ownOrg}/agent-results/${encodeURIComponent(recoveryKey)}`;
    expect((await app.request(recoveryPath)).status).toBe(401);
    const privateResponse = {
      model: 'openai/gpt-5.6-sol',
      choices: [{ finish_reason: 'stop', message: { content: 'Original result' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    };
    await responseStore.settle(ownOrg, pendingResponse.id, {
      status: 'completed',
      cents: 1,
      response: privateResponse,
    });
    const recovered = await app.request(recoveryPath, { headers: { Cookie: cookie } });
    expect(recovered.status).toBe(200);
    expect(recovered.headers.get('cache-control')).toBe('no-store');
    expect(await recovered.json()).toEqual({ status: 'completed', response: privateResponse });
    expect(
      (
        await app.request(recoveryPath.replace(ownOrg, randomUUID()), {
          headers: { Cookie: cookie },
        })
      ).status,
    ).toBe(404);

    expect(JSON.stringify(body)).not.toContain([...grants][0]!);
    const csrf = await app.request('/api/organizations', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        Origin: 'https://attacker.test',
        'Content-Type': 'application/json',
        'X-Outreachr-Request': '1',
      },
      body: JSON.stringify({ name: 'Attack' }),
    });
    expect(csrf.status).toBe(403);
    const mutationHeaders = {
      Cookie: cookie,
      Origin: 'http://localhost:4444',
      'Content-Type': 'application/json',
      'X-Outreachr-Request': '1',
    };
    const accountPath = `/api/organizations/${ownOrg}/billing/account`;
    expect(
      (
        await app.request(accountPath, {
          method: 'POST',
          headers: { ...mutationHeaders, Cookie: '' },
          body: '{}',
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await app.request(accountPath, {
          method: 'POST',
          headers: mutationHeaders,
          body: JSON.stringify({ externalReference: randomUUID() }),
        })
      ).status,
    ).toBe(400);
    const accountSetup = await app.request(accountPath, {
      method: 'POST',
      headers: mutationHeaders,
      body: '{}',
    });
    expect(accountSetup.status).toBe(200);
    expect(await accountSetup.json()).toEqual({
      billingAccountId: linkedAccountId,
      productFamilyKey: 'workspace',
      environment: 'test',
    });
    const snapshotPath = `/api/organizations/${ownOrg}/billing/snapshot`;
    expect((await app.request(snapshotPath)).status).toBe(401);
    const billingSnapshot = await app.request(snapshotPath, { headers: { Cookie: cookie } });
    expect(billingSnapshot.status).toBe(200);
    expect(billingSnapshot.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await billingSnapshot.json()).toMatchObject({
      access: 'read_only',
      snapshot: {
        subscription: null,
        account: { id: linkedAccountId, externalReference: ownOrg },
      },
    });
    const connect = (body = '{}', headers = mutationHeaders) =>
      app.request('/api/google/connect', {
        method: 'POST',
        headers,
        body,
      });
    expect((await connect('{}', { ...mutationHeaders, Cookie: '' })).status).toBe(401);
    expect(
      (await connect('{}', { ...mutationHeaders, Origin: 'https://attacker.test' })).status,
    ).toBe(403);
    expect((await connect(JSON.stringify({ userId: randomUUID() }))).status).toBe(400);
    expect((await connect('{')).status).toBe(400);
    expect(googleStarts).toBe(0);
    const authorization = await connect();
    expect(authorization.status).toBe(200);
    expect(await authorization.json()).toEqual({ authUrl: googleAuthUrl });
    expect(googleStarts).toBe(1);
    googleAuthUrl = 'https://attacker.test/authorize';
    const invalidRedirect = await connect();
    expect(invalidRedirect.status).toBe(502);
    expect((await invalidRedirect.json()).code).toBe('google_authorization_invalid');
    const inviter = identity();
    const invitedOrg = (await store.signIn(inviter)).organizations[0]!;
    const staleEmailInvite = await store.invite(inviter.id, invitedOrg.id, account.email, 'viewer');
    elizaPrincipal.email = `${randomUUID()}@example.test`;
    const staleAcceptance = await app.request('/api/invites/accept', {
      method: 'POST',
      headers: mutationHeaders,
      body: JSON.stringify({ token: staleEmailInvite.token }),
    });
    expect(staleAcceptance.status).toBe(403);
    expect((await staleAcceptance.json()).code).toBe('invite_email_mismatch');
    const currentEmailInvite = await store.invite(
      inviter.id,
      invitedOrg.id,
      elizaPrincipal.email,
      'viewer',
    );
    expect(
      (
        await app.request('/api/invites/accept', {
          method: 'POST',
          headers: mutationHeaders,
          body: JSON.stringify({ token: currentEmailInvite.token }),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await app.request('/api/organizations', {
          method: 'POST',
          headers: mutationHeaders,
          body: JSON.stringify({ name: 'Team' }),
        })
      ).status,
    ).toBe(201);
    expect(
      (await app.request('/api/auth/logout', { method: 'POST', headers: mutationHeaders })).status,
    ).toBe(200);
    expect(grants.size).toBe(0);
    expect((await app.request('/api/me', { headers: { Cookie: cookie } })).status).toBe(401);
    expect((await connect()).status).toBe(401);
    expect(googleStarts).toBe(2);
  });
});

describe('cloud CRM and file transport', () => {
  it('isolates files by workspace and author, rejects paths, and keeps viewer reads', async () => {
    const workspaces = new WorkspaceStore(pool);
    const owner = identity();
    const outsider = identity();
    const viewer = identity();
    const org = (await workspaces.signIn(owner)).organizations[0]!;
    await workspaces.signIn(outsider);
    await workspaces.signIn(viewer);
    const invitation = await workspaces.invite(owner.id, org.id, viewer.email, 'viewer');
    await workspaces.acceptInvite(viewer.id, invitation.token);
    const files = new FileStore(pool);
    const handle = await files.save(
      owner.id,
      org.id,
      '../../sensitive.csv',
      Buffer.from('name,email\nShaw,shaw@example.test'),
      'upload',
    );
    expect((await files.get(viewer.id, org.id, handle)).name).toBe('sensitive.csv');
    await expect(files.get(outsider.id, org.id, handle)).rejects.toMatchObject({
      code: 'workspace_not_found',
    });
    await expect(files.get(viewer.id, org.id, handle, true)).rejects.toMatchObject({
      code: 'file_not_found',
    });
    await expect(files.get(owner.id, org.id, '/etc/passwd')).rejects.toThrow();
    await expect(
      files.save(viewer.id, org.id, 'a.csv', Buffer.from('private'), 'upload'),
    ).rejects.toMatchObject({ code: 'editing_seat_required' });
    const output = await files.save(
      owner.id,
      org.id,
      'export.csv',
      Buffer.from('export'),
      'download',
    );
    await expect(files.get(viewer.id, org.id, output)).rejects.toMatchObject({
      code: 'file_not_found',
    });
    await files.remove(owner.id, org.id, handle);
    await expect(files.get(owner.id, org.id, handle)).rejects.toMatchObject({
      code: 'file_not_found',
    });
  });

  it.each([
    { label: 'Sol trial', plan: 'sol', model: 'openai/gpt-5.6-sol', paid: false },
    { label: 'Sol subscription', plan: 'sol', model: 'openai/gpt-5.6-sol', paid: true },
    { label: 'Astra subscription', plan: 'astra', model: 'openai/gpt-6-astra', paid: true },
  ])(
    'persists CRM, exports, and meters exact-model proposals for $label',
    async ({ plan, model, paid }) => {
      const workspaces = new WorkspaceStore(pool);
      const user = identity();
      const org = (await workspaces.signIn(user)).organizations[0]!;
      if (paid) {
        await pool.query(
          `UPDATE outreachr.organizations SET plan=$2,subscription_id=$3,
         subscription_status='active',subscription_period_start=now()-interval '1 hour',
         subscription_period_end=now()+interval '30 days',seat_capacity=3 WHERE id=$1`,
          [org.id, plan, `sub_fixture_${randomUUID()}`],
        );
      }
      const cloudAccountId = randomUUID();
      await pool.query(
        `UPDATE outreachr.organizations SET cloud_app_id=$2,cloud_billing_account_id=$3,cloud_billing_environment='test',cloud_product_family_key='workspace',
        cloud_billing_access='granted',cloud_billing_observed_at=now(),cloud_billing_valid_until=now()+interval '5 minutes',
        subscription_status=CASE WHEN subscription_id IS NULL THEN 'trialing' ELSE subscription_status END WHERE id=$1`,
        [org.id, testAppId, cloudAccountId],
      );
      const access = entitlement(await memberOrganization(pool, user.id, org.id), new Date());
      expect(access.trial).toBe(!paid);
      // Cloud grants a fixed account allowance, even when the workspace buys three seats.
      expect(access.model).toBe(model);
      expect(access.allowanceCents).toBe(paid ? (plan === 'astra' ? 7000 : 1500) : 200);
      const session = {
        userId: user.id,
        grant: `ead_${'b'.repeat(43)}`,
        expiresAt: new Date(Date.now() + 600_000),
      };
      let completions = 0;
      let inferenceMode: 'success' | 'disconnect' | 'cancel' = 'success';
      let providerStarted = () => {};
      const inference = new InferenceClient(
        {
          ...delegationConfig('https://fixture.eliza.test'),
          developerApiKey: 'fixture-key-not-real',
        },
        async (url, init) => {
          if (String(url).endsWith('/models'))
            return Response.json({
              data: [
                {
                  id: model,
                  context_length: 1_050_000,
                  pricing: { prompt: '0.000002', completion: '0.00001' },
                },
              ],
            });
          const input = JSON.parse(String(init!.body));
          expect(input.model).toBe(model);
          const headers = new Headers(init!.headers);
          expect(String(url)).toBe(
            `https://fixture.eliza.test/api/v1/apps/${testAppId}/inference/chat/completions`,
          );
          expect(headers.get('Authorization')).toMatch(/^Basic /);
          expect(headers.get('X-Eliza-Developer-Authorization')).toBe(
            'Bearer fixture-key-not-real',
          );
          expect(headers.get('X-App-Delegation')).toBe(session.grant);
          expect(headers.get('X-Eliza-Billing-Account-Id')).toBe(cloudAccountId);
          expect(headers.get('X-Eliza-Product-Family')).toBe('workspace');
          expect(headers.get('Idempotency-Key')).toMatch(/^agent-run:/);
          expect(headers.has('X-App-Id')).toBe(false);
          expect(input.messages[1].content).not.toContain(user.email);
          expect(input.tools).toBeUndefined();
          completions++;
          if (inferenceMode === 'disconnect')
            throw new Error('Provider disconnected after accepting the request');
          if (inferenceMode === 'cancel') {
            providerStarted();
            return await new Promise<Response>((_resolve, reject) => {
              const signal = init!.signal!;
              signal.addEventListener('abort', () => reject(signal.reason), { once: true });
              if (signal.aborted) reject(signal.reason);
            });
          }
          return Response.json({
            model: input.model,
            choices: [
              {
                finish_reason: 'stop',
                message: {
                  content: JSON.stringify({
                    summary: 'Review the proposed task.',
                    proposals: [
                      {
                        id: 'one',
                        kind: 'task',
                        title: 'Prepare follow-up',
                        rationale: 'Human review required.',
                        investorId: null,
                        payload: {
                          title: 'Prepare follow-up',
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
        },
      );
      const eliza = new ElizaClient(delegationConfig('https://fixture.eliza.test'));
      const runs = new AgentRuns();
      const runtime = () =>
        new CloudRuntime({
          pool,
          eliza,
          revision: 'test',
          agentFactory: (context) => new CloudAgent(context, inference, runs),
        });
      const initial = await runtime().bootstrap(session, user, org.id);
      expect(initial.isFirstRun).toBe(true);
      expect(initial.vaultPath).toBe('Cloud workspace');
      await runtime().execute(session, user, org.id, 'onboarding.complete', {
        founderName: 'Test Founder',
        founderEmail: user.email,
        companyName: 'Cloud Test',
        companyOneLiner: 'An integration fixture.',
        stage: 'seed',
        targetAmount: 1_000_000,
        targetCheckMinimum: null,
        targetCheckMaximum: null,
        sectors: ['AI'],
        geographies: ['United States'],
        narrative: 'Fixture only.',
      });
      const firm = await runtime().execute(session, user, org.id, 'investor.create', {
        name: 'Cloud Test Investor',
        kind: 'angel',
      });
      const person = await runtime().execute(session, user, org.id, 'person.create', {
        firmId: firm.id,
        name: 'Shaw Fixture',
        personalEmail: 'shaw@example.test',
      });
      const reopened = await runtime().bootstrap(session, user, org.id);
      expect(reopened.people.find((item) => item.id === person.id)?.personalEmail).toBe(
        'shaw@example.test',
      );
      const output = await runtime().execute(session, user, org.id, 'data.exportCsv', {
        directory: 'cloud-downloads',
        kind: 'people',
      });
      const file = await new FileStore(pool).get(user.id, org.id, output.path);
      expect(file.content.toString()).toContain('shaw@example.test');
      await expect(
        runtime().execute(session, user, org.id, 'data.exportCsv', {
          directory: '/tmp',
          kind: 'people',
        }),
      ).rejects.toMatchObject({ code: 'download_target_invalid' });
      const events: AgentEvent[] = [];
      const result = await runtime().execute(
        session,
        user,
        org.id,
        'agent.run',
        { provider: 'codex', prompt: 'Suggest one preparation task.', disclosedContextIds: [] },
        (event) => events.push(event),
      );
      expect(events.map((event) => event.type)).toEqual(['started', 'tool_proposal', 'completed']);
      expect(completions).toBe(1);
      const final = await runtime().bootstrap(session, user, org.id);
      expect(final.agentProposals.some((proposal) => proposal.agentRunId === result.runId)).toBe(
        true,
      );
      expect(final.tasks.some((task) => task.title === 'Prepare follow-up')).toBe(false);
      const charged = (
        await pool.query('SELECT status,model,settled_cents FROM outreachr.usage WHERE org_id=$1', [
          org.id,
        ])
      ).rows;
      expect(charged).toEqual([{ status: 'completed', model, settled_cents: 1 }]);
      const recorded = await new UsageStore(pool).recordedResult(user.id, org.id, result.runId);
      expect(recorded.status).toBe('completed');
      expect(recorded.response?.model).toBe(model);
      expect(recorded.response?.choices[0]?.message.content).toContain('Prepare follow-up');
      inferenceMode = 'disconnect';
      const failedEvents: AgentEvent[] = [];
      await runtime().execute(
        session,
        user,
        org.id,
        'agent.run',
        { provider: 'codex', prompt: 'Connection failure fixture.', disclosedContextIds: [] },
        (event) => failedEvents.push(event),
      );
      expect(failedEvents.map((event) => event.type)).toEqual(['started', 'error']);
      inferenceMode = 'cancel';
      const pending = new Promise<void>((resolve) => {
        providerStarted = resolve;
      });
      let cancelledRunId = '';
      const cancelledEvents: AgentEvent[] = [];
      const active = runtime().execute(
        session,
        user,
        org.id,
        'agent.run',
        { provider: 'codex', prompt: 'Cancellation fixture.', disclosedContextIds: [] },
        (event) => {
          cancelledRunId = event.runId;
          cancelledEvents.push(event);
        },
      );
      await pending;
      expect(runs.cancel(cancelledRunId, randomUUID(), org.id)).toEqual({ cancelled: false });
      expect(runs.cancel(cancelledRunId, user.id, randomUUID())).toEqual({ cancelled: false });
      expect(runs.cancel(cancelledRunId, user.id, org.id)).toEqual({ cancelled: true });
      await active;
      expect(cancelledEvents.map((event) => event.type)).toEqual(['started', 'error']);
      expect(runs.cancel(cancelledRunId, user.id, org.id)).toEqual({ cancelled: false });
      expect(completions).toBe(3);
      const uncertain = (
        await pool.query(
          "SELECT status,settled_cents,reserved_cents FROM outreachr.usage WHERE org_id=$1 AND status='ambiguous'",
          [org.id],
        )
      ).rows;
      expect(uncertain).toHaveLength(2);
      for (const item of uncertain) {
        expect(item.settled_cents).toBeNull();
        expect(item.reserved_cents).toBeGreaterThan(0);
      }
      expect((await runtime().bootstrap(session, user, org.id)).agentProposals).toHaveLength(
        final.agentProposals.length,
      );
    },
    120_000,
  );
});

describe('managed Gmail end-to-end command flow', () => {
  it('uses the selected mailbox with delegated Gmail capabilities, persists the receipt, and rejects a repeated send', async () => {
    const workspaces = new WorkspaceStore(pool);
    const user = identity();
    const org = (await workspaces.signIn(user)).organizations[0]!;
    const connectionId = randomUUID();
    const grant = 'outreachr_mail_fixture';
    const session = { userId: user.id, grant, expiresAt: new Date(Date.now() + 86400_000) };
    let sends = 0;
    let sentMime = '';
    const transport = new ElizaClient(
      delegationConfig('https://gmail.fixture.test'),
      async (url, init) => {
        expect(new Headers(init?.headers).get('X-App-Delegation')).toBe(grant);
        expect(new Headers(init?.headers).get('Authorization')).toMatch(/^Basic /);
        if (String(url).endsWith('/google/connections'))
          return Response.json({
            success: true,
            data: [
              {
                connectionId,
                connected: true,
                identity: { email: 'Mailbox@Example.Test' },
                grantedCapabilities: [
                  'google.basic_identity',
                  'google.gmail.triage',
                  'google.gmail.send',
                ],
                reason: 'connected',
              },
            ],
          });
        const operation = JSON.parse(String(init!.body));
        expect(operation.connectionId).toBe(connectionId);
        const endpoint = new URL(operation.url);
        if (endpoint.pathname.endsWith('/userinfo'))
          return Response.json({ email: 'Mailbox@Example.Test' });
        if (endpoint.pathname.endsWith('/messages') && operation.method === 'GET')
          return Response.json({ messages: [], resultSizeEstimate: 0 });
        if (endpoint.pathname.endsWith('/messages/send')) {
          sends++;
          const raw = JSON.parse(operation.body).raw;
          sentMime = Buffer.from(raw, 'base64url').toString();
          return Response.json({
            id: 'gmail-confirmed-receipt',
            threadId: 'gmail-confirmed-thread',
            labelIds: ['SENT'],
          });
        }
        throw new Error(`Unexpected Google fixture endpoint ${endpoint.pathname}`);
      },
    );
    const inference = new InferenceClient({
      ...delegationConfig('https://unused.example.test'),
      developerApiKey: 'fixture',
    });
    const runs = new AgentRuns();
    const runtime = () =>
      new CloudRuntime({
        pool,
        eliza: transport,
        revision: 'gmail-test',
        agentFactory: (context) => new CloudAgent(context, inference, runs),
      });
    await runtime().mailboxes.select(user.id, org.id, grant, connectionId);
    await runtime().execute(session, user, org.id, 'onboarding.complete', {
      founderName: 'Fixture Sender',
      founderEmail: user.email,
      companyName: 'Fixture Company',
      companyOneLiner: 'Controlled test only.',
      stage: 'seed',
      targetAmount: 1_000_000,
      targetCheckMinimum: null,
      targetCheckMaximum: null,
      sectors: ['AI'],
      geographies: [],
      narrative: '',
      postalAddress: '123 Fixture Street, Test City, NY 10001',
    });
    const firm = await runtime().execute(session, user, org.id, 'investor.create', {
      name: 'Mail Fixture',
      kind: 'angel',
    });
    const person = await runtime().execute(session, user, org.id, 'person.create', {
      firmId: firm.id,
      name: 'Fixture Recipient',
      personalEmail: 'recipient@example.test',
    });
    const draft = await runtime().execute(session, user, org.id, 'draft.create', {
      personId: person.id,
      provider: 'google',
      kind: 'initial',
      subject: 'Controlled Gmail fixture',
      bodyText: 'This stays inside the test provider.',
    });
    expect(draft.accountEmail).toBe('mailbox@example.test');
    await runtime().execute(session, user, org.id, 'connector.syncMail', { provider: 'google' });
    const approved = await runtime().execute(session, user, org.id, 'draft.approve', {
      id: draft.id,
      expectedContentHash: draft.contentHash,
    });
    const sent = await runtime().execute(session, user, org.id, 'draft.send', {
      id: draft.id,
      expectedContentHash: approved.contentHash,
    });
    expect(sent).toMatchObject({
      approvalState: 'sent',
      providerMessageId: 'gmail-confirmed-receipt',
    });
    await expect(
      runtime().execute(session, user, org.id, 'draft.send', {
        id: draft.id,
        expectedContentHash: approved.contentHash,
      }),
    ).rejects.toThrow();
    expect(sends).toBe(1);
    expect(sentMime).toContain('recipient@example.test');
    expect(sentMime).toContain('Controlled Gmail fixture');
    expect(
      (await runtime().bootstrap(session, user, org.id)).drafts.find((item) => item.id === draft.id)
        ?.providerMessageId,
    ).toBe('gmail-confirmed-receipt');
  }, 120_000);
});
