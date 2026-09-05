/** Exercises real PostgreSQL transactions, competing sessions, and durable tenant boundaries. */
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { migrate } from '../../src/schema';
import { WorkspaceStore, entitlement, memberOrganization } from '../../src/workspaces';
import { UsageStore } from '../../src/usage';
import { withWorkspaceLock } from '../../src/database';
import { postgresVaultPersistence } from '../../src/vault-persistence';
import { CredentialCipher, SessionStore } from '../../src/sessions';
import { ElizaClient } from '../../src/eliza';
import { createApp } from '../../src/app';
import { BillingStore } from '../../src/billing';
import { FileStore } from '../../src/files';
import { CloudRuntime } from '../../src/runtime';
import { CloudAgent, AgentRuns } from '../../src/agent';
import { InferenceClient } from '../../src/inference';
import type { AgentEvent } from '../../../desktop/src/shared/contracts';

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
afterAll(async () => {
  await pool.end();
  // pg's pool shutdown can resolve before PostgreSQL observes the final socket close.
  // Wait for that boundary instead of terminating clients during Vitest teardown.
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const connections = await admin.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=$1',
      [database],
    );
    if (connections.rows[0]!.count === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await admin.query(`DROP DATABASE IF EXISTS "${database}"`);
  await admin.end();
});

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
    await expect(store.acceptInvite(guest.id, invitation.token)).rejects.toMatchObject({
      code: 'invite_expired',
    });
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

describe('HTTP login and workspace boundary', () => {
  it('exchanges once, keeps credentials server-side, rejects cross-origin writes, and revokes logout', async () => {
    const account = identity();
    const elizaPrincipal = { ...account, organizationId: randomUUID() };
    const grants = new Set<string>();
    let exchanges = 0;
    const provider: typeof fetch = async (input, init) => {
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
      if (path.endsWith('/token')) {
        exchanges += 1;
        const token = `outreachr_${randomBytes(32).toString('base64url')}`;
        grants.add(token);
        return Response.json({
          success: true,
          token,
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
          user: elizaPrincipal,
        });
      }
      const token = new Headers(init?.headers).get('Authorization')?.slice(7) ?? '';
      if (!grants.has(token)) return Response.json({ error: 'Revoked' }, { status: 401 });
      if (path.endsWith('/revoke')) {
        grants.delete(token);
        return Response.json({ success: true });
      }
      return Response.json({ success: true, user: elizaPrincipal });
    };
    const sessions = new SessionStore(
      pool,
      new CredentialCipher(randomBytes(32).toString('base64')),
    );
    const app = createApp({
      pool,
      sessions,
      eliza: new ElizaClient('https://api.eliza.test', 'test-client-secret', provider),
      config: {
        publicOrigin: 'http://localhost:4444',
        elizaOrigin: 'https://api.eliza.test',
        elizaLoginOrigin: 'https://eliza.test',
        elizaAppId: randomUUID(),
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

  it('persists CRM commands across runtime instances, exports bytes, and meters an exact model proposal', async () => {
    const workspaces = new WorkspaceStore(pool);
    const user = identity();
    const org = (await workspaces.signIn(user)).organizations[0]!;
    const session = {
      userId: user.id,
      grant: 'outreachr_fixture',
      expiresAt: new Date(Date.now() + 600_000),
    };
    let completions = 0;
    const inference = new InferenceClient(
      'https://fixture.eliza.test',
      'fixture-key-not-real',
      async (url, init) => {
        if (String(url).endsWith('/models'))
          return Response.json({
            data: [
              {
                id: 'openai/gpt-5.6-sol',
                context_length: 1_050_000,
                pricing: { prompt: '0.000002', completion: '0.00001' },
              },
            ],
          });
        const input = JSON.parse(String(init!.body));
        expect(input.model).toBe('openai/gpt-5.6-sol');
        expect(input.messages[1].content).not.toContain(user.email);
        expect(input.tools).toBeUndefined();
        completions++;
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
    const eliza = new ElizaClient('https://fixture.eliza.test', 'fixture-client-secret');
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
    expect(charged).toEqual([
      { status: 'completed', model: 'openai/gpt-5.6-sol', settled_cents: 1 },
    ]);
  }, 120_000);
});

describe('workspace subscription authority', () => {
  it('serializes checkout, verifies events, and applies current Stripe state including seat deficits', async () => {
    const workspaces = new WorkspaceStore(pool);
    const owner = identity();
    const viewer = identity();
    const org = (await workspaces.signIn(owner)).organizations[0]!;
    await workspaces.signIn(viewer);
    const invitation = await workspaces.invite(owner.id, org.id, viewer.email, 'viewer');
    await workspaces.acceptInvite(viewer.id, invitation.token);
    let current: Array<{
      id: string;
      status: string;
      plan: string;
      seats: number;
      periodStart: number;
      periodEnd: number;
      cancelAtPeriodEnd: boolean;
      created: number;
    }> = [];
    let checkoutCalls = 0;
    let reads = 0;
    const requests: Record<string, unknown>[] = [];
    const provider = new ElizaClient(
      'https://billing.fixture.test',
      'fixture-client-secret',
      async (_url, init) => {
        const input = JSON.parse(String(init!.body));
        requests.push(input);
        if (input.action === 'customer') return Response.json({ customerId: 'cus_fixture' });
        if (input.action === 'subscriptions') {
          reads++;
          return Response.json({ subscriptions: current });
        }
        if (input.action === 'checkout') {
          checkoutCalls++;
          return Response.json({
            sessionId: 'cs_fixture',
            url: 'https://checkout.stripe.com/c/pay/fixture',
            status: 'open',
          });
        }
        if (input.action === 'checkoutStatus')
          return Response.json({
            sessionId: 'cs_fixture',
            url: 'https://checkout.stripe.com/c/pay/fixture',
            status: 'open',
          });
        if (input.action === 'event')
          return input.signature === 'valid-fixture-signature'
            ? Response.json({ eventId: input.payload, workspaceId: org.id })
            : Response.json({ error: 'signature invalid' }, { status: 403 });
        throw new Error('Unexpected billing operation');
      },
    );
    const billing = new BillingStore(pool, provider);
    await expect(billing.open(viewer.id, org.id, { plan: 'sol', seats: 1 })).rejects.toMatchObject({
      code: 'owner_required',
    });
    expect(requests).toHaveLength(0);
    const urls = await Promise.all([
      billing.open(owner.id, org.id, { plan: 'sol', seats: 2 }),
      billing.open(owner.id, org.id, { plan: 'sol', seats: 2 }),
    ]);
    expect(urls[0]).toEqual(urls[1]);
    expect(checkoutCalls).toBe(1);
    expect((await memberOrganization(pool, owner.id, org.id)).subscription_status).toBe('none');
    const now = Math.floor(Date.now() / 1000);
    current = [
      {
        id: 'sub_fixture',
        status: 'active',
        plan: 'sol',
        seats: 2,
        periodStart: now - 10,
        periodEnd: now + 86400,
        cancelAtPeriodEnd: false,
        created: now,
      },
    ];
    await expect(billing.webhook('evt_forged', 'invalid')).rejects.toThrow();
    expect((await memberOrganization(pool, owner.id, org.id)).subscription_status).toBe('none');
    await billing.webhook('evt_paid', 'valid-fixture-signature');
    expect(entitlement(await memberOrganization(pool, owner.id, org.id), new Date()).canEdit).toBe(
      true,
    );
    const priorReads = reads;
    await billing.webhook('evt_paid', 'valid-fixture-signature');
    expect(reads).toBe(priorReads);
    current.push({ ...current[0]!, id: 'sub_duplicate' });
    await expect(billing.webhook('evt_duplicate', 'valid-fixture-signature')).rejects.toMatchObject(
      { code: 'duplicate_subscriptions' },
    );
    expect((await memberOrganization(pool, owner.id, org.id)).subscription_status).toBe(
      'unavailable',
    );
    current.pop();
    await billing.webhook('evt_duplicate', 'valid-fixture-signature');
    expect((await memberOrganization(pool, owner.id, org.id)).subscription_status).toBe('active');
    await workspaces.changeMember(owner.id, org.id, viewer.id, 'member');
    current[0]!.seats = 1;
    await billing.webhook('evt_quantity_changed', 'valid-fixture-signature');
    expect(entitlement(await memberOrganization(pool, owner.id, org.id), new Date()).canEdit).toBe(
      false,
    );
    await workspaces.changeMember(owner.id, org.id, viewer.id, 'viewer');
    expect(entitlement(await memberOrganization(pool, owner.id, org.id), new Date()).canEdit).toBe(
      true,
    );
    current[0]!.status = 'past_due';
    // An old event still fetches the current provider state; it cannot restore an old paid state.
    await billing.webhook('evt_old_active_delayed', 'valid-fixture-signature');
    expect(entitlement(await memberOrganization(pool, owner.id, org.id), new Date()).canEdit).toBe(
      false,
    );
  });
});

describe('managed Gmail end-to-end command flow', () => {
  it('uses the selected mailbox with gmail.modify, persists the receipt, and rejects a repeated send', async () => {
    const workspaces = new WorkspaceStore(pool);
    const user = identity();
    const org = (await workspaces.signIn(user)).organizations[0]!;
    const connectionId = randomUUID();
    const grant = 'outreachr_mail_fixture';
    const session = { userId: user.id, grant, expiresAt: new Date(Date.now() + 86400_000) };
    let sends = 0;
    let sentMime = '';
    const transport = new ElizaClient(
      'https://gmail.fixture.test',
      'fixture-client-secret',
      async (url, init) => {
        expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${grant}`);
        if (String(url).endsWith('/google/connections'))
          return Response.json({
            success: true,
            connections: [
              {
                connectionId,
                connected: true,
                configured: true,
                identity: { email: 'Mailbox@Example.Test' },
                grantedScopes: ['https://www.googleapis.com/auth/gmail.modify'],
                grantedCapabilities: ['gmail.read', 'gmail.send'],
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
    const inference = new InferenceClient('https://unused.example.test', 'fixture');
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
