/** Tests ownership authority, durable requests and current projections with real PostgreSQL. */
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { CloudOwnership } from '../../src/billing-ownership';
import { ElizaClient } from '../../src/eliza';
import { WorkspaceStore, memberOrganization } from '../../src/workspaces';
import { migrate } from '../../src/schema';

const url = new URL(
  process.env.TEST_DATABASE_URL ?? 'postgres://outreachr@127.0.0.1:55439/postgres',
);
if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
  throw new Error('Ownership tests require disposable local PostgreSQL.');
const admin = new Pool({ connectionString: url.href });
const database = `outreachr_owners_${randomUUID().replaceAll('-', '')}`;
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
  name: 'Ownership fixture',
  emailVerified: true,
});
async function fixture() {
  const workspaces = new WorkspaceStore(pool),
    owner = identity(),
    target = identity(),
    outsider = identity();
  const org = (await workspaces.signIn(owner)).organizations[0]!;
  await workspaces.signIn(target);
  await workspaces.signIn(outsider);
  await pool.query('UPDATE outreachr.organizations SET seat_capacity=2 WHERE id=$1', [org.id]);
  await workspaces.acceptInvite(
    target.id,
    (await workspaces.invite(owner.id, org.id, target.email, 'member')).token,
  );
  const config = {
    appId: randomUUID(),
    clientId: randomUUID(),
    clientSecret: 'owner-fixture-secret',
    billingEnvironment: 'test' as const,
    apiOrigin: 'https://owners.fixture.test',
    loginOrigin: 'https://login.fixture.test',
    publicOrigin: 'http://localhost:4444',
  };
  const accountId = randomUUID();
  await pool.query(
    "UPDATE outreachr.organizations SET cloud_app_id=$2,cloud_billing_account_id=$3,cloud_billing_environment='test',cloud_product_family_key='workspace' WHERE id=$1",
    [org.id, config.appId, accountId],
  );
  const admins = new Set([owner.id]);
  const active = new Set([owner.id, target.id]);
  const seats = new Set([owner.id, target.id]);
  const state = {
    revision: 0,
    effects: 0,
    reads: 0,
    readUnavailable: false,
    lost: false,
    foreign: false,
    conflict: false,
    genericConflict: false,
    supersede: false,
    revokedOwner: false,
    bodies: [] as string[],
  };
  const receipts = new Map<string, { body: unknown; result: unknown; actor: string }>();
  const scope = { appId: config.appId, billingAccountId: accountId, environment: 'test' };
  const snapshot = () => ({
    ...scope,
    revision: String(state.revision),
    administrators: [...admins],
  });
  const cloud = new ElizaClient(config, async (input, init) => {
    const path = new URL(String(input));
    expect(path.searchParams.get('clientId')).toBe(config.clientId);
    expect(path.pathname).toBe(
      `/api/v1/apps/${config.appId}/billing/accounts/${accountId}/administrators`,
    );
    const headers = new Headers(init?.headers);
    expect(headers.get('Authorization')).toBe(
      `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`,
    );
    expect(headers.has('X-Eliza-Developer-Authorization')).toBe(false);
    const grant = headers.get('X-App-Delegation');
    const actor = grant === 'owner-grant' ? owner.id : grant === 'target-grant' ? target.id : null;
    if (!actor || !active.has(actor) || (actor === owner.id && state.revokedOwner))
      return Response.json({ error: 'Revoked' }, { status: 401 });
    if (!init?.method || init.method === 'GET') {
      state.reads++;
      if (state.readUnavailable) throw new Error('Read unavailable');
      return Response.json({ success: true, data: snapshot() });
    }
    const body = JSON.parse(String(init?.body));
    state.bodies.push(JSON.stringify(body));
    const job = (
      await pool.query(
        'SELECT request_json,state FROM outreachr.cloud_ownership_jobs WHERE id=$1',
        [body.idempotencyKey.slice(6)],
      )
    ).rows[0];
    expect(job?.state).toBe('pending');
    expect(job?.request_json).toEqual(body);
    const previous = receipts.get(body.idempotencyKey);
    if (previous) {
      expect(previous.actor).toBe(actor);
      expect(body).toEqual(previous.body);
      return Response.json({ success: true, data: previous.result });
    }
    if (state.conflict) {
      state.conflict = false;
      state.revision++;
      return Response.json(
        { error: 'Revision changed', code: 'APP_BILLING_MEMBERSHIP_REVISION_CONFLICT' },
        { status: 409 },
      );
    }
    if (state.genericConflict)
      return Response.json(
        { error: 'Conflict', code: 'APP_BILLING_AUTHORITY_CONFLICT' },
        { status: 409 },
      );
    if (!admins.has(actor))
      return Response.json({ error: 'Administrator required' }, { status: 403 });
    if (body.expectedRevision !== String(state.revision))
      return Response.json(
        { error: 'Revision changed', code: 'APP_BILLING_MEMBERSHIP_REVISION_CONFLICT' },
        { status: 409 },
      );
    if (body.action === 'grant') admins.add(body.userId);
    if (body.action === 'revoke') admins.delete(body.userId);
    if (body.action === 'transfer') {
      admins.add(body.userId);
      admins.delete(actor);
    }
    state.revision++;
    state.effects++;
    const result = snapshot();
    receipts.set(body.idempotencyKey, { body, result, actor });
    if (state.supersede) {
      admins.clear();
      admins.add(owner.id);
      state.revision++;
    }
    if (state.lost) {
      state.readUnavailable = true;
      throw new Error('Mutation response lost');
    }
    return Response.json({
      success: true,
      data: state.foreign ? { ...result, billingAccountId: randomUUID() } : result,
    });
  });
  const service = () => new CloudOwnership(pool, cloud, 'workspace');
  return {
    org,
    owner,
    target,
    outsider,
    workspaces,
    config,
    accountId,
    admins,
    active,
    seats,
    state,
    service,
  };
}
it('grants ownership only after Cloud confirmation without changing seats or trial history', async () => {
  const f = await fixture();
  expect(
    await f.service().change(f.owner.id, f.org.id, 'owner-grant', 'grant', f.target.id),
  ).toEqual({ confirmed: true, pending: false });
  const next = await memberOrganization(pool, f.target.id, f.org.id);
  expect(next.role).toBe('owner');
  expect(next.cloud_membership_ready).toBe(false);
  expect(next.trial_ends_at).toEqual(f.org.trial_ends_at);
  expect(f.seats.size).toBe(2);
  expect(f.state.effects).toBe(1);
});
it('recovers the exact lost transfer as its now ordinary original actor after reopening', async () => {
  const f = await fixture();
  f.state.lost = true;
  expect(
    await f.service().change(f.owner.id, f.org.id, 'owner-grant', 'transfer', f.target.id),
  ).toEqual({ confirmed: false, pending: true });
  expect((await memberOrganization(pool, f.owner.id, f.org.id)).role).toBe('owner');
  await expect(
    f.workspaces.changeMember(f.owner.id, f.org.id, f.target.id, null),
  ).rejects.toMatchObject({ code: 'ownership_change_pending' });
  f.state.readUnavailable = false;
  expect(await f.service().recover(f.owner.id, f.org.id, 'owner-grant')).toEqual({
    confirmed: true,
    pending: false,
  });
  expect((await memberOrganization(pool, f.owner.id, f.org.id)).role).toBe('member');
  expect((await memberOrganization(pool, f.target.id, f.org.id)).role).toBe('owner');
  expect(new Set(f.state.bodies).size).toBe(1);
  expect(f.state.effects).toBe(1);
});
it('never projects a foreign receipt but can recover its original operation', async () => {
  const f = await fixture();
  f.state.foreign = true;
  await expect(
    f.service().change(f.owner.id, f.org.id, 'owner-grant', 'transfer', f.target.id),
  ).rejects.toMatchObject({ code: 'ownership_snapshot_scope' });
  expect((await memberOrganization(pool, f.target.id, f.org.id)).role).toBe('member');
  expect(await f.service().recover(f.owner.id, f.org.id, 'owner-grant')).toEqual({
    confirmed: true,
    pending: false,
  });
  expect(f.state.effects).toBe(1);
});
it('projects the current administrator set instead of an older successful receipt', async () => {
  const f = await fixture();
  f.state.supersede = true;
  await f.service().change(f.owner.id, f.org.id, 'owner-grant', 'transfer', f.target.id);
  expect((await memberOrganization(pool, f.owner.id, f.org.id)).role).toBe('owner');
  expect((await memberOrganization(pool, f.target.id, f.org.id)).role).toBe('member');
  expect((await memberOrganization(pool, f.owner.id, f.org.id)).cloud_administrator_revision).toBe(
    '2',
  );
});
it('reprepares only a proven membership revision conflict using the same intent key', async () => {
  const f = await fixture();
  f.state.conflict = true;
  expect(
    (await f.service().change(f.owner.id, f.org.id, 'owner-grant', 'grant', f.target.id)).pending,
  ).toBe(true);
  await f.service().recover(f.owner.id, f.org.id, 'owner-grant');
  const requests = f.state.bodies.map((body) => JSON.parse(body));
  expect(requests.map((body) => body.expectedRevision)).toEqual(['0', '1']);
  expect(requests[0].idempotencyKey).toBe(requests[1].idempotencyKey);
  expect(f.state.effects).toBe(1);
});
it('retains generic conflicts and rejects a changed app client before redispatch', async () => {
  const f = await fixture();
  f.state.genericConflict = true;
  await f.service().change(f.owner.id, f.org.id, 'owner-grant', 'grant', f.target.id);
  await f.service().recover(f.owner.id, f.org.id, 'owner-grant');
  expect(new Set(f.state.bodies).size).toBe(1);
  expect(f.state.effects).toBe(0);
  f.config.clientId = randomUUID();
  await expect(f.service().recover(f.owner.id, f.org.id, 'owner-grant')).rejects.toMatchObject({
    code: 'ownership_binding_changed',
  });
});
it('allows an authenticated current member to project an external transfer without writing Cloud roles', async () => {
  const f = await fixture();
  f.admins.clear();
  f.admins.add(f.target.id);
  f.state.revision++;
  await f.service().ensureCurrent(f.target.id, f.org.id, 'target-grant', true);
  expect((await memberOrganization(pool, f.target.id, f.org.id)).role).toBe('owner');
  expect((await memberOrganization(pool, f.owner.id, f.org.id)).role).toBe('member');
  expect(f.state.bodies).toHaveLength(0);
  expect(f.seats.size).toBe(2);
});
it('revoked delegation cannot replay but a current member can reconcile canonical authority', async () => {
  const f = await fixture();
  f.state.lost = true;
  await f.service().change(f.owner.id, f.org.id, 'owner-grant', 'transfer', f.target.id);
  f.state.revokedOwner = true;
  f.state.readUnavailable = false;
  expect(await f.service().recover(f.owner.id, f.org.id, 'owner-grant')).toEqual({
    confirmed: false,
    pending: true,
  });
  expect(f.state.effects).toBe(1);
  expect((await memberOrganization(pool, f.target.id, f.org.id)).role).toBe('member');
  expect(await f.service().recover(f.target.id, f.org.id, 'target-grant')).toEqual({
    confirmed: true,
    pending: false,
  });
  expect((await memberOrganization(pool, f.target.id, f.org.id)).role).toBe('owner');
  expect(f.state.effects).toBe(1);
});
it('preserves last-owner and accepted editing-seat requirements', async () => {
  const f = await fixture();
  await expect(
    f.service().change(f.owner.id, f.org.id, 'owner-grant', 'revoke', f.owner.id),
  ).rejects.toMatchObject({ code: 'last_owner' });
  await pool.query(
    "UPDATE outreachr.memberships SET role='viewer' WHERE org_id=$1 AND user_id=$2",
    [f.org.id, f.target.id],
  );
  await expect(
    f.service().change(f.owner.id, f.org.id, 'owner-grant', 'grant', f.target.id),
  ).rejects.toMatchObject({ code: 'ownership_seat_required' });
  await expect(
    f.service().change(f.target.id, f.org.id, 'target-grant', 'grant', f.owner.id),
  ).rejects.toMatchObject({ code: 'owner_required' });
  expect(f.state.effects).toBe(0);
});
it('rejects stale/conflicting authority and never recreates removed members from Cloud administrator IDs', async () => {
  const f = await fixture();
  await f.service().ensureCurrent(f.owner.id, f.org.id, 'owner-grant', true);
  f.admins.add(f.target.id);
  await expect(
    f.service().ensureCurrent(f.owner.id, f.org.id, 'owner-grant', true),
  ).rejects.toMatchObject({ code: 'ownership_snapshot_conflict' });
  f.admins.clear();
  f.admins.add(f.outsider.id);
  f.state.revision++;
  await expect(
    f.service().ensureCurrent(f.owner.id, f.org.id, 'owner-grant', true),
  ).rejects.toMatchObject({ code: 'ownership_member_missing' });
  expect((await memberOrganization(pool, f.owner.id, f.org.id)).cloud_ownership_confirmed).toBe(
    false,
  );
  await expect(memberOrganization(pool, f.outsider.id, f.org.id)).rejects.toMatchObject({
    code: 'workspace_not_found',
  });
});
it('does not transfer ownership while an original purchaser command still needs its actor', async () => {
  const f = await fixture();
  await pool.query(
    `INSERT INTO outreachr.cloud_billing_intents(id,org_id,user_id,app_id,client_id,billing_account_id,environment,product_family_key,kind,request_json,review_json,state)
    VALUES($1,$2,$3,$4,$5,$6,'test','workspace','portal','{}','{}','pending')`,
    [randomUUID(), f.org.id, f.owner.id, f.config.appId, f.config.clientId, f.accountId],
  );
  await expect(
    f.service().change(f.owner.id, f.org.id, 'owner-grant', 'transfer', f.target.id),
  ).rejects.toMatchObject({ code: 'ownership_dependencies_pending' });
  expect(f.state.effects).toBe(0);
});
