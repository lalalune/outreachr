/** Verifies durable app intents across actual PostgreSQL commits and SDK transport failures. */
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { closeTestDatabase } from '../disposable-database';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type {
  AppBillingMember,
  SynchronizeAppBillingMemberRequest,
} from '@elizaos/cloud-sdk/app-billing-membership';
import { CloudMembershipSync } from '../../src/billing-memberships';
import { CloudBillingAccounts } from '../../src/billing-accounts';
import { ElizaClient } from '../../src/eliza';
import { migrate } from '../../src/schema';
import { WorkspaceStore, memberOrganization, entitlement } from '../../src/workspaces';

const url = new URL(
  process.env.TEST_DATABASE_URL ?? 'postgres://outreachr@127.0.0.1:55439/postgres',
);
if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
  throw new Error('Membership tests require disposable local PostgreSQL.');
const admin = new Pool({ connectionString: url.href });
const database = `outreachr_members_${randomUUID().replaceAll('-', '')}`;
url.pathname = `/${database}`;
const pool = new Pool({ connectionString: url.href, max: 10 });
beforeAll(async () => {
  await admin.query(`CREATE DATABASE "${database}"`);
  await migrate(pool);
});
afterAll(() => closeTestDatabase(pool, admin, database));
const principal = () => ({
  id: randomUUID(),
  email: `${randomUUID()}@example.test`,
  name: 'Membership fixture',
  emailVerified: true,
});

async function fixture() {
  const workspaces = new WorkspaceStore(pool);
  const owner = principal(),
    guest = principal();
  const org = (await workspaces.signIn(owner)).organizations[0]!;
  await workspaces.signIn(guest);
  const appId = randomUUID(),
    accountId = randomUUID(),
    clientId = randomUUID();
  const subscriptionId = randomUUID(),
    planRevisionId = randomUUID();
  const startsAt = new Date().toISOString(),
    endsAt = new Date(Date.now() + 86_400_000).toISOString();
  const config = {
    appId,
    clientId,
    clientSecret: 'registered-backend-secret',
    billingEnvironment: 'test' as const,
    apiOrigin: 'https://members.fixture.test',
    loginOrigin: 'https://login.fixture.test',
    publicOrigin: 'http://localhost:4444',
  };
  const state = {
    mode: 'success' as 'success' | 'lost' | 'foreign' | 'conflict' | 'revision-conflict',
    revision: 0,
    effects: 0,
    requests: [] as string[],
  };
  const members = new Map<string, AppBillingMember>([
    [owner.id, { userId: owner.id, role: 'administrator', active: true }],
  ]);
  const seats = new Map<string, string>([[owner.id, randomUUID()]]);
  const receipts = new Map<string, { body: string; response: unknown }>();
  const cloud = new ElizaClient(config, async (input, init) => {
    const path = new URL(String(input)).pathname;
    expect(new URL(String(input)).searchParams.get('clientId')).toBe(clientId);
    const headers = new Headers(init?.headers);
    expect(headers.get('Authorization')).toBe(
      `Basic ${Buffer.from(`${clientId}:${config.clientSecret}`).toString('base64')}`,
    );
    expect(headers.has('X-Eliza-Developer-Authorization')).toBe(false);
    if (path.endsWith('/subscriptions/workspace'))
      return Response.json({
        success: true,
        data: {
          account: {
            id: accountId,
            appId,
            externalReference: org.id,
            displayName: org.name,
            role: 'administrator',
          },
          environment: 'test',
          productFamilyKey: 'workspace',
          observedAt: new Date().toISOString(),
          mutationRevision: '1',
          pendingOperation: null,
          subscription: {
            id: subscriptionId,
            appId,
            environment: 'test',
            billingAccountId: accountId,
            productFamilyKey: 'workspace',
            planRevisionId,
            planKey: 'sol',
            revision: '1',
            status: 'active',
            quantity: 3,
            currentPeriodStart: startsAt,
            currentPeriodEnd: endsAt,
            trial: null,
            cancelAtPeriodEnd: false,
            canceledAt: null,
          },
          entitlement: {
            sourceSubscriptionRevision: '1',
            access: 'granted',
            featureKeys: [],
            seatCapacity: 3,
            assignedSeats: seats.size,
            validUntil: endsAt,
          },
          allowances: [],
          trialEligibility: { status: 'eligible' },
        },
      });
    expect(headers.has('X-App-Delegation')).toBe(false);
    if (path.endsWith('/members'))
      return Response.json({
        success: true,
        data: {
          appId,
          billingAccountId: accountId,
          environment: 'test',
          revision: String(state.revision),
          members: [...members.values()],
        },
      });
    expect(path).toBe(`/api/v1/apps/${appId}/billing/accounts/${accountId}/members/sync`);
    const body = String(init?.body);
    const request = JSON.parse(body) as SynchronizeAppBillingMemberRequest;
    state.requests.push(body);
    // Another connection can see the immutable intent before Cloud can commit.
    const saved = await pool.query<{ request_json: unknown }>(
      'SELECT request_json FROM outreachr.cloud_membership_jobs WHERE id=$1',
      [request.idempotencyKey.slice('membership:'.length)],
    );
    expect(saved.rows[0]!.request_json).toEqual(request);
    const prior = receipts.get(request.idempotencyKey);
    if (prior) {
      expect(body).toBe(prior.body);
      return Response.json(prior.response);
    }
    if (state.mode === 'conflict' || state.mode === 'revision-conflict') {
      const code =
        state.mode === 'revision-conflict'
          ? 'APP_BILLING_MEMBERSHIP_REVISION_CONFLICT'
          : 'APP_BILLING_AUTHORITY_CONFLICT';
      state.mode = 'success';
      state.revision += 1;
      return Response.json(
        {
          success: false,
          code,
          error: 'Concurrent membership change',
        },
        { status: 409 },
      );
    }
    if (request.expectedRevision !== String(state.revision))
      return Response.json(
        {
          success: false,
          code: 'APP_BILLING_AUTHORITY_CONFLICT',
          error: 'Concurrent membership change',
        },
        { status: 409 },
      );
    const value: AppBillingMember = {
      userId: request.userId,
      role: members.get(request.userId)?.role ?? 'member',
      active: request.active,
    };
    members.set(request.userId, value);
    if (
      !request.active ||
      !request.seats.some((seat) => seat.productFamilyKey === 'workspace' && seat.assigned)
    )
      seats.delete(request.userId);
    else if (!seats.has(request.userId)) seats.set(request.userId, randomUUID());
    state.revision += 1;
    state.effects += 1;
    const response = {
      success: true,
      data: {
        appId,
        billingAccountId: accountId,
        environment: 'test',
        revision: String(state.revision),
        member: value,
        seats: seats.has(request.userId)
          ? [{ productFamilyKey: 'workspace', seatId: seats.get(request.userId)! }]
          : [],
      },
    };
    receipts.set(request.idempotencyKey, { body, response: structuredClone(response) });
    if (state.mode === 'lost') {
      state.mode = 'success';
      throw new Error('Response lost after remote commit');
    }
    if (state.mode === 'foreign') {
      state.mode = 'success';
      return Response.json({ ...response, data: { ...response.data, appId: randomUUID() } });
    }
    return Response.json(response);
  });
  await pool.query(
    `UPDATE outreachr.organizations SET cloud_app_id=$2,cloud_billing_account_id=$3,
    cloud_billing_environment='test',cloud_product_family_key='workspace' WHERE id=$1`,
    [org.id, appId, accountId],
  );
  const accounts = new CloudBillingAccounts(pool, cloud, 'workspace');
  const refresh = () => accounts.snapshot(owner.id, org.id, `ead_${'z'.repeat(43)}`);
  await refresh();
  const retry = () =>
    pool.query(
      "UPDATE outreachr.cloud_membership_jobs SET retry_after=now() WHERE org_id=$1 AND state='pending'",
      [org.id],
    );
  const accept = async (role: 'member' | 'viewer' = 'member') => {
    const invite = await workspaces.invite(owner.id, org.id, guest.email, role);
    expect(
      (await pool.query('SELECT id FROM outreachr.cloud_membership_jobs WHERE org_id=$1', [org.id]))
        .rowCount,
    ).toBe(0);
    await workspaces.acceptInvite(guest.id, invite.token);
    return invite.token;
  };
  return {
    owner,
    guest,
    org,
    config,
    workspaces,
    cloud,
    state,
    members,
    seats,
    retry,
    refresh,
    accept,
  };
}

it('requires Cloud confirmation, preserves the exact timed-out intent across restart, and needs no owner grant', async () => {
  const f = await fixture();
  const token = await f.accept();
  f.state.mode = 'lost';
  expect(
    entitlement(await memberOrganization(pool, f.guest.id, f.org.id), new Date()).canEdit,
  ).toBe(false);
  await new CloudMembershipSync(pool, f.cloud, 'workspace').runOrg(f.org.id);
  expect(f.state.effects).toBe(1);
  expect((await f.workspaces.acceptInvite(f.guest.id, token)).id).toBe(f.org.id);
  expect(
    (await pool.query('SELECT id FROM outreachr.cloud_membership_jobs WHERE org_id=$1', [f.org.id]))
      .rowCount,
  ).toBe(1);
  expect((await memberOrganization(pool, f.guest.id, f.org.id)).cloud_membership_ready).toBe(false);
  f.state.revision += 2;
  await f.retry();
  const restarted = new CloudMembershipSync(pool, f.cloud, 'workspace');
  await Promise.all([restarted.runOrg(f.org.id), restarted.runOrg(f.org.id)]);
  expect(f.state.requests[1]).toBe(f.state.requests[0]);
  expect(f.state.effects).toBe(1);
  await f.refresh();
  expect(
    entitlement(await memberOrganization(pool, f.guest.id, f.org.id), new Date()).canEdit,
  ).toBe(true);
});

it('removes local access immediately and never resurrects it when an older ambiguous activation completes', async () => {
  const f = await fixture();
  const token = await f.accept();
  f.state.mode = 'lost';
  const sync = new CloudMembershipSync(pool, f.cloud, 'workspace');
  await sync.runOrg(f.org.id);
  await f.workspaces.changeMember(f.owner.id, f.org.id, f.guest.id, null);
  await expect(f.workspaces.acceptInvite(f.guest.id, token)).rejects.toMatchObject({
    code: 'workspace_not_found',
  });
  await expect(memberOrganization(pool, f.guest.id, f.org.id)).rejects.toMatchObject({
    code: 'workspace_not_found',
  });
  await f.retry();
  await sync.runOrg(f.org.id, 20);
  expect(f.members.get(f.guest.id)?.active).toBe(false);
  expect(f.seats.has(f.guest.id)).toBe(false);
  expect(f.state.effects).toBe(2);
  await expect(memberOrganization(pool, f.guest.id, f.org.id)).rejects.toMatchObject({
    code: 'workspace_not_found',
  });
});

it('skips an obsolete undispatched activation, while viewers never receive a paid seat', async () => {
  const f = await fixture();
  await f.accept('viewer');
  await f.workspaces.changeMember(f.owner.id, f.org.id, f.guest.id, null);
  await new CloudMembershipSync(pool, f.cloud, 'workspace').runOrg(f.org.id, 20);
  expect(f.state.effects).toBe(1);
  expect(JSON.parse(f.state.requests[0]!).active).toBe(false);
  expect(f.seats.has(f.guest.id)).toBe(false);
  const states = await pool.query<{ state: string }>(
    'SELECT state FROM outreachr.cloud_membership_jobs WHERE org_id=$1 ORDER BY position',
    [f.org.id],
  );
  expect(states.rows.map((row) => row.state)).toEqual(['superseded', 'confirmed']);
});

it('rejects a foreign confirmation and recovers only the original scoped operation', async () => {
  const f = await fixture();
  await f.accept();
  f.state.mode = 'foreign';
  const sync = new CloudMembershipSync(pool, f.cloud, 'workspace');
  await sync.runOrg(f.org.id);
  expect((await memberOrganization(pool, f.guest.id, f.org.id)).cloud_membership_ready).toBe(false);
  await f.retry();
  await sync.runOrg(f.org.id);
  expect(f.state.requests[1]).toBe(f.state.requests[0]);
  expect(f.state.effects).toBe(1);
  expect((await memberOrganization(pool, f.guest.id, f.org.id)).cloud_membership_ready).toBe(true);
});

it('activates a viewer without consuming an editing seat', async () => {
  const f = await fixture();
  await f.accept('viewer');
  await new CloudMembershipSync(pool, f.cloud, 'workspace').runPending();
  expect(f.members.get(f.guest.id)?.active).toBe(true);
  expect(f.seats.has(f.guest.id)).toBe(false);
  expect((await memberOrganization(pool, f.guest.id, f.org.id)).cloud_membership_ready).toBe(true);
  await f.refresh();
  expect(
    entitlement(await memberOrganization(pool, f.guest.id, f.org.id), new Date()).canEdit,
  ).toBe(false);
});

it('accepts a previously issued invitation while the owner is offline and the local billing cache is stale', async () => {
  const f = await fixture();
  const invitation = await f.workspaces.invite(f.owner.id, f.org.id, f.guest.email, 'member');
  await pool.query(
    "UPDATE outreachr.organizations SET cloud_billing_observed_at=now()-interval '1 day' WHERE id=$1",
    [f.org.id],
  );
  await f.workspaces.acceptInvite(f.guest.id, invitation.token);
  await new CloudMembershipSync(pool, f.cloud, 'workspace').runOrg(f.org.id);
  expect(f.state.effects).toBe(1);
  expect((await memberOrganization(pool, f.guest.id, f.org.id)).cloud_membership_ready).toBe(true);
});

it('refuses to dispatch a stored request whose target no longer matches the authorized job', async () => {
  const f = await fixture();
  await f.accept();
  f.state.mode = 'lost';
  const sync = new CloudMembershipSync(pool, f.cloud, 'workspace');
  await sync.runOrg(f.org.id);
  await pool.query(
    `UPDATE outreachr.cloud_membership_jobs SET request_json=jsonb_set(request_json,'{userId}',to_jsonb($2::text)),retry_after=now() WHERE org_id=$1`,
    [f.org.id, randomUUID()],
  );
  await sync.runOrg(f.org.id);
  expect(f.state.requests).toHaveLength(1);
  expect((await memberOrganization(pool, f.guest.id, f.org.id)).cloud_membership_ready).toBe(false);
});

it('preserves the exact intent on an undifferentiated conflict and cannot promote billing owners', async () => {
  const f = await fixture();
  await f.accept();
  f.state.mode = 'conflict';
  const sync = new CloudMembershipSync(pool, f.cloud, 'workspace');
  await sync.runOrg(f.org.id);
  expect(f.state.effects).toBe(0);
  await f.retry();
  await sync.runOrg(f.org.id);
  expect(f.state.effects).toBe(0);
  expect(f.state.requests[1]).toBe(f.state.requests[0]);
  expect((await memberOrganization(pool, f.guest.id, f.org.id)).cloud_membership_ready).toBe(false);
  await expect(
    f.workspaces.changeMember(f.owner.id, f.org.id, f.guest.id, 'owner'),
  ).rejects.toMatchObject({ code: 'billing_owner_transfer_unavailable' });
  expect((await memberOrganization(pool, f.guest.id, f.org.id)).role).toBe('member');
});

it('reprepares only a typed unexecuted revision conflict, retaining the same operation identity', async () => {
  const f = await fixture();
  await f.accept();
  f.state.mode = 'revision-conflict';
  const sync = new CloudMembershipSync(pool, f.cloud, 'workspace');
  await sync.runOrg(f.org.id);
  expect(f.state.effects).toBe(0);
  await f.retry();
  await sync.runOrg(f.org.id);
  expect(f.state.effects).toBe(1);
  const first = JSON.parse(f.state.requests[0]!);
  const retried = JSON.parse(f.state.requests[1]!);
  expect(retried).toEqual({ ...first, expectedRevision: '1' });
  expect((await memberOrganization(pool, f.guest.id, f.org.id)).cloud_membership_ready).toBe(true);
});

it('confirms an ordinary editing seat without projecting administrator authority from its receipt', async () => {
  const f = await fixture();
  await f.accept();
  // Another Cloud surface has granted authority while the app still has a member role.
  // Membership receipt roles cannot replace the separate current-administrator read.
  f.members.set(f.guest.id, { userId: f.guest.id, role: 'administrator', active: true });
  await new CloudMembershipSync(pool, f.cloud, 'workspace').runOrg(f.org.id);
  const local = await memberOrganization(pool, f.guest.id, f.org.id);
  expect(local.cloud_membership_ready).toBe(true);
  expect(local.role).toBe('member');
  expect(f.seats.has(f.guest.id)).toBe(true);
  expect(f.state.effects).toBe(1);
});
