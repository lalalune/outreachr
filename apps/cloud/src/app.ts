/** Routes browser sessions and workspace operations behind same-origin and membership checks. */
import { Hono, type MiddlewareHandler } from 'hono';
import { stream } from 'hono/streaming';
import { isCommandName } from '../../desktop/src/main/command-service';
import type { CloudRuntime } from './runtime';
import type { AgentRuns } from './agent';
import { FileStore, MAX_FILE_BYTES } from './files';
import { bodyLimit } from 'hono/body-limit';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import type { Pool } from 'pg';
import { CloudError, requireCondition } from './errors';
import type { ElizaClient } from './eliza';
import { PLANS, TRIAL_DAYS } from './plans';
import { constantTimeEqual, type SessionStore, type Session } from './sessions';
import {
  WorkspaceStore,
  memberOrganization,
  entitlement,
  type Organization,
  type Identity,
} from './workspaces';
import { CloudBillingAccounts } from './billing-accounts';
import { BillingNotifications } from './billing-notifications';
import { CloudMembershipSync } from './billing-memberships';
import { CloudOwnership } from './billing-ownership';
import { CloudProvisioning } from './billing-provisioning';
import { BillingStore } from './billing';
import { UsageStore } from './usage';
import { cloudAllowanceSummary } from './billing-allowance';

export interface CloudConfig {
  publicOrigin: string;
  elizaOrigin: string;
  elizaLoginOrigin: string;
  elizaAppId: string;
  productFamilyKey: string;
  billingNotificationKeys?: Record<string, string>;
  edgeSecret: string;
  production: boolean;
  revision: string;
}
interface CloudEnv {
  Variables: { session: Session; organization: Organization; identity: Identity };
}
const uuid = z.string().uuid();
const role = z.enum(['owner', 'admin', 'member', 'viewer']);
const name = z.string().trim().min(1).max(100);

export function createApp(options: {
  config: CloudConfig;
  pool: Pool;
  sessions: SessionStore;
  eliza: ElizaClient;
  runtime?: CloudRuntime;
  agentRuns?: AgentRuns;
}) {
  const { config, pool, sessions, eliza } = options;
  const workspaces = new WorkspaceStore(pool, () => new Date(), 'cloud');
  const usage = new UsageStore(pool);
  const billing = new BillingStore(pool, eliza, config.productFamilyKey);
  const billingAccounts = new CloudBillingAccounts(pool, eliza, config.productFamilyKey);
  const membershipSync = new CloudMembershipSync(pool, eliza, config.productFamilyKey);
  const ownership = new CloudOwnership(pool, eliza, config.productFamilyKey);
  const provisioning = new CloudProvisioning(pool, eliza, config.productFamilyKey);
  const billingNotifications = new BillingNotifications(pool, {
    appId: eliza.config.appId,
    environment: eliza.config.billingEnvironment,
    productFamilyKey: config.productFamilyKey,
    keys: config.billingNotificationKeys ?? {},
  });
  const app = new Hono<CloudEnv>();
  const sessionCookie = config.production ? '__Host-outreachr_session' : 'outreachr_session';
  const stateCookie = config.production ? '__Host-outreachr_login' : 'outreachr_login';
  const cookie = { httpOnly: true, secure: config.production, sameSite: 'Lax' as const, path: '/' };

  app.use('/api/billing/notifications', bodyLimit({ maxSize: 65_536 }));
  app.use('*', bodyLimit({ maxSize: MAX_FILE_BYTES + 1024 }));
  app.use('*', async (c, next) => {
    if (!c.req.path.endsWith('/files') && Number(c.req.header('content-length') ?? 0) > 2_000_000)
      throw new CloudError(413, 'request_too_large', 'Request too large.');
    await next();
  });
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('X-Frame-Options', 'DENY');
    if (c.req.path === '/health') return await next();
    if (config.production)
      requireCondition(
        constantTimeEqual(c.req.header('X-Outreachr-Edge') ?? '', config.edgeSecret),
        403,
        'edge_required',
        'Use the Outreachr website to access this service.',
      );
    if (
      !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) &&
      c.req.path !== '/api/billing/notifications'
    ) {
      requireCondition(
        c.req.header('Origin') === config.publicOrigin &&
          c.req.header('X-Outreachr-Request') === '1',
        403,
        'origin_invalid',
        'This request must originate from your Outreachr session.',
      );
    }
    await next();
  });
  app.onError((error, c) => {
    if (error instanceof CloudError)
      return c.json({ error: error.message, code: error.code }, error.status);
    if (error instanceof z.ZodError)
      return c.json(
        {
          error: 'Request validation failed.',
          code: 'validation_error',
          fields: error.issues.map((issue) => ({ path: issue.path, message: issue.message })),
        },
        400,
      );
    // Server diagnostics omit request bodies, credentials, and raw provider errors.
    process.stderr.write(
      `${JSON.stringify({ event: 'request.failed', path: c.req.path, errorType: error.name })}\n`,
    );
    return c.json({ error: 'The request could not be completed.', code: 'internal_error' }, 500);
  });
  app.get('/health', async (c) => {
    await pool.query('SELECT 1 FROM outreachr.users LIMIT 0');
    return c.json({ status: 'ok', revision: config.revision });
  });
  app.get('/api/config', (c) =>
    c.json({ plans: PLANS, trialDays: TRIAL_DAYS, revision: config.revision }),
  );
  app.get('/api/auth/login', async (c) => {
    const state = await sessions.beginLogin(c.req.query('returnTo') ?? '/');
    setCookie(c, stateCookie, state, { ...cookie, maxAge: 600 });
    return c.redirect(eliza.authorizeUrl(state));
  });
  app.get('/api/auth/callback', async (c) => {
    const returnPath = await sessions.consumeLogin(
      c.req.query('state') ?? '',
      getCookie(c, stateCookie) ?? '',
    );
    deleteCookie(c, stateCookie, cookie);
    const code = z.string().startsWith('eac_').max(256).parse(c.req.query('code'));
    const grant = await eliza.exchange(code);
    await workspaces.signIn(grant.user);
    const oldToken = getCookie(c, sessionCookie);
    if (oldToken) await sessions.revoke(oldToken);
    const session = await sessions.create(grant.user.id, grant.token, new Date(grant.expiresAt));
    setCookie(c, sessionCookie, session.token, { ...cookie, expires: session.expiresAt });
    return c.redirect(returnPath);
  });
  app.get('/api/google/callback', (c) => c.redirect('/#/settings'));
  app.post('/api/billing/notifications', async (c) =>
    c.json(await billingNotifications.receive(await c.req.text(), c.req.raw.headers)),
  );
  const authenticate: MiddlewareHandler<CloudEnv> = async (c, next) => {
    const session = await sessions.get(getCookie(c, sessionCookie));
    const identity = await eliza.identity(session.grant);
    requireCondition(
      identity.id === session.userId && identity.emailVerified,
      401,
      'identity_changed',
      'Sign in again to confirm your account.',
    );
    c.set('session', session);
    c.set('identity', identity);
    await next();
  };
  app.use('/api/*', authenticate);
  app.post('/api/auth/logout', async (c) => {
    const session = c.get('session');
    await sessions.revoke(getCookie(c, sessionCookie)!);
    deleteCookie(c, sessionCookie, cookie);
    await eliza.revoke(session.grant);
    return c.json({ success: true });
  });
  app.get('/api/me', async (c) => {
    const session = c.get('session');
    const identity = c.get('identity');
    requireCondition(
      identity.id === session.userId,
      401,
      'identity_changed',
      'Sign in again to confirm your account.',
    );
    const result = await workspaces.signIn(identity);
    const organizations = await Promise.all(
      result.organizations.map(async (org) => {
        await provisioning.resume(session.userId, org.id, session.grant);
        await ownership.ensureCurrent(session.userId, org.id, session.grant);
        await membershipSync.runOrg(org.id, 20);
        return billingAccounts.ensureCurrent(session.userId, org.id, session.grant);
      }),
    );
    return c.json({
      user: {
        id: result.user.id,
        email: result.user.email,
        name: result.user.name,
        defaultOrgId: result.user.default_org_id,
      },
      organizations: organizations.map((org) => ({
        ...org,
        entitlement: entitlement(org, new Date()),
      })),
    });
  });
  app.post('/api/organizations', async (c) => {
    const input = z
      .object({ name })
      .strict()
      .parse(await c.req.json());
    return c.json(await workspaces.create(c.get('session').userId, input.name), 201);
  });
  app.post('/api/invites/accept', async (c) => {
    const input = z
      .object({ token: z.string().min(32).max(128) })
      .strict()
      .parse(await c.req.json());
    // Refresh verified email before resolving an invitation after an account email change.
    const session = c.get('session');
    const identity = c.get('identity');
    requireCondition(
      identity.id === session.userId,
      401,
      'identity_changed',
      'Sign in again to confirm your account.',
    );
    await workspaces.signIn(identity);
    const accepted = await workspaces.acceptInvite(session.userId, input.token);
    await membershipSync.runOrg(accepted.id);
    return c.json(await memberOrganization(pool, session.userId, accepted.id));
  });
  app.use('/api/organizations/:orgId/*', async (c, next) => {
    const orgId = uuid.parse(c.req.param('orgId'));
    const session = c.get('session');
    const sensitive = /\/(members|invites|billing)(?:\/|$)/.test(c.req.path);
    if (sensitive) {
      // Accepted members can inspect local membership during a provider outage.
      // Privileged reads and every mutation still require current Cloud authority.
      const memberList = c.req.method === 'GET' && c.req.path.endsWith('/members');
      await ownership.ensureCurrent(session.userId, orgId, session.grant, !memberList);
    }
    c.set(
      'organization',
      await billingAccounts.ensureCurrent(session.userId, orgId, session.grant),
    );
    await next();
  });
  app.post('/api/organizations/:orgId/setup/retry', async (c) => {
    z.object({})
      .strict()
      .parse(await c.req.json());
    const session = c.get('session');
    return c.json(
      await provisioning.retry(session.userId, c.get('organization').id, session.grant),
    );
  });
  app.post('/api/organizations/:orgId/ownership/change', async (c) => {
    const input = z
      .object({ action: z.enum(['grant', 'revoke', 'transfer']), targetId: uuid })
      .strict()
      .parse(await c.req.json());
    const session = c.get('session'),
      org = c.get('organization');
    const result = await ownership.change(
      session.userId,
      org.id,
      session.grant,
      input.action,
      input.targetId,
    );
    await membershipSync.runOrg(org.id, 20);
    return c.json(result);
  });
  app.post('/api/organizations/:orgId/ownership/recover', async (c) => {
    z.object({})
      .strict()
      .parse(await c.req.json());
    const session = c.get('session'),
      org = c.get('organization');
    const result = await ownership.recover(session.userId, org.id, session.grant);
    await membershipSync.runOrg(org.id, 20);
    return c.json(result);
  });
  app.get('/api/organizations/:orgId/members', async (c) =>
    c.json(await workspaces.members(c.get('session').userId, c.get('organization').id)),
  );
  app.get('/api/organizations/:orgId/invites', async (c) => {
    const org = c.get('organization');
    requireCondition(
      (org.role === 'owner' || org.role === 'admin') && org.cloud_membership_ready !== false,
      403,
      'admin_required',
      'Only workspace admins can view invitations.',
    );
    return c.json(
      (
        await pool.query(
          'SELECT id,email,role,expires_at FROM outreachr.invites WHERE org_id=$1 AND revoked_at IS NULL AND consumed_by IS NULL AND expires_at>now() ORDER BY created_at',
          [org.id],
        )
      ).rows,
    );
  });
  app.post('/api/organizations/:orgId/invites', async (c) => {
    const input = z
      .object({ email: z.email().max(320), role: z.enum(['admin', 'member', 'viewer']) })
      .strict()
      .parse(await c.req.json());
    const invite = await workspaces.invite(
      c.get('session').userId,
      c.get('organization').id,
      input.email,
      input.role,
    );
    return c.json(
      {
        id: invite.id,
        expiresAt: invite.expiresAt,
        url: `${config.publicOrigin}/?invite=${encodeURIComponent(invite.token)}`,
      },
      201,
    );
  });
  app.delete('/api/organizations/:orgId/invites/:inviteId', async (c) => {
    await workspaces.revokeInvite(
      c.get('session').userId,
      c.get('organization').id,
      uuid.parse(c.req.param('inviteId')),
    );
    return c.json({ success: true });
  });
  app.patch('/api/organizations/:orgId/members/:userId', async (c) => {
    const input = z
      .object({ role: role.nullable() })
      .strict()
      .parse(await c.req.json());
    await workspaces.changeMember(
      c.get('session').userId,
      c.get('organization').id,
      uuid.parse(c.req.param('userId')),
      input.role,
    );
    await membershipSync.runOrg(c.get('organization').id);
    return c.json({ success: true });
  });
  app.get('/api/organizations/:orgId/agent-results/:runId', async (c) =>
    c.json(
      await usage.recordedResult(
        c.get('session').userId,
        c.get('organization').id,
        z.string().min(16).max(128).parse(c.req.param('runId')),
      ),
    ),
  );
  app.get('/api/organizations/:orgId/usage', async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const org = c.get('organization'),
      session = c.get('session');
    if (org.cloud_billing_account_id)
      return c.json(
        cloudAllowanceSummary(
          await billingAccounts.snapshot(session.userId, org.id, session.grant),
        ),
      );
    return c.json({ ...(await usage.summary(session.userId, org.id)), source: 'local_estimate' });
  });
  app.get('/api/google/connections', async (c) =>
    c.json(await eliza.connections(c.get('session').grant)),
  );
  app.post('/api/google/connect', async (c) => {
    const input: unknown = await c.req.json().catch(() => {
      throw new CloudError(400, 'invalid_json', 'Invalid JSON body.');
    });
    z.object({}).strict().parse(input);
    return c.json(await eliza.connectGoogle(c.get('session').grant));
  });
  app.get('/api/organizations/:orgId/billing/snapshot', async (c) => {
    c.header('Cache-Control', 'private, no-store');
    return c.json(
      await billingAccounts.snapshot(
        c.get('session').userId,
        c.get('organization').id,
        c.get('session').grant,
      ),
    );
  });
  app.post('/api/organizations/:orgId/billing/account', async (c) => {
    z.object({})
      .strict()
      .parse(await c.req.json());
    return c.json(
      await billingAccounts.resolveOwner(
        c.get('session').userId,
        c.get('organization').id,
        c.get('session').grant,
      ),
    );
  });
  app.post('/api/organizations/:orgId/billing/checkout', async (c) => {
    const input = z
      .object({ plan: z.enum(['sol', 'astra']), seats: z.number().int().min(1).max(1000) })
      .strict()
      .parse(await c.req.json());
    return c.json(
      await billing.review(
        c.get('session').userId,
        c.get('organization').id,
        c.get('session').grant,
        input,
      ),
    );
  });
  app.post('/api/organizations/:orgId/billing/portal', async (c) =>
    c.json(
      await billing.review(
        c.get('session').userId,
        c.get('organization').id,
        c.get('session').grant,
      ),
    ),
  );
  app.post('/api/organizations/:orgId/billing/confirm', async (c) => {
    const input = z
      .object({ id: z.uuid(), billingConsent: z.literal('accepted') })
      .strict()
      .parse(await c.req.json());
    return c.json(
      await billing.confirm(
        c.get('session').userId,
        c.get('organization').id,
        c.get('session').grant,
        input.id,
      ),
    );
  });
  app.post('/api/organizations/:orgId/billing/recover', async (c) => {
    z.object({})
      .strict()
      .parse(await c.req.json());
    c.header('Cache-Control', 'private, no-store');
    return c.json(
      await billing.current(
        c.get('session').userId,
        c.get('organization').id,
        c.get('session').grant,
      ),
    );
  });
  app.post('/api/organizations/:orgId/billing/checkout/expire', async (c) => {
    const input = z
      .object({ id: z.uuid() })
      .strict()
      .parse(await c.req.json());
    return c.json(
      await billing.expireCheckout(
        c.get('session').userId,
        c.get('organization').id,
        c.get('session').grant,
        input.id,
      ),
    );
  });
  app.post('/api/organizations/:orgId/billing/refresh', async (c) => {
    await billingAccounts.snapshot(
      c.get('session').userId,
      c.get('organization').id,
      c.get('session').grant,
    );
    return c.json({ success: true });
  });
  const files = new FileStore(pool);
  app.post('/api/organizations/:orgId/files', async (c) => {
    const content = Buffer.from(await c.req.arrayBuffer());
    return c.json(
      {
        path: await files.save(
          c.get('session').userId,
          c.get('organization').id,
          c.req.header('X-File-Name') ?? 'upload',
          content,
          'upload',
        ),
      },
      201,
    );
  });
  app.get('/api/organizations/:orgId/files/:fileId', async (c) => {
    const file = await files.get(
      c.get('session').userId,
      c.get('organization').id,
      `cloud-file:${uuid.parse(c.req.param('fileId'))}`,
    );
    return new Response(new Uint8Array(file.content), {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${file.name}"`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  });
  app.delete('/api/organizations/:orgId/files/:fileId', async (c) => {
    await files.remove(
      c.get('session').userId,
      c.get('organization').id,
      `cloud-file:${uuid.parse(c.req.param('fileId'))}`,
    );
    return c.json({ success: true });
  });
  app.get('/api/organizations/:orgId/mailbox', async (c) => {
    requireCondition(
      options.runtime,
      503,
      'runtime_unavailable',
      'The workspace runtime is unavailable.',
    );
    return c.json(
      await options.runtime.mailboxes.current(
        c.get('session').userId,
        c.get('organization').id,
        c.get('session').grant,
      ),
    );
  });
  app.post('/api/organizations/:orgId/mailbox', async (c) => {
    requireCondition(
      options.runtime,
      503,
      'runtime_unavailable',
      'The workspace runtime is unavailable.',
    );
    const input = z
      .object({ connectionId: uuid.nullable() })
      .strict()
      .parse(await c.req.json());
    await options.runtime.mailboxes.select(
      c.get('session').userId,
      c.get('organization').id,
      c.get('session').grant,
      input.connectionId,
    );
    return c.json({ success: true });
  });
  app.get('/api/organizations/:orgId/bootstrap', async (c) => {
    requireCondition(
      options.runtime,
      503,
      'runtime_unavailable',
      'The workspace runtime is unavailable.',
    );
    return c.json(
      await options.runtime.bootstrap(
        c.get('session'),
        c.get('identity'),
        c.get('organization').id,
      ),
    );
  });
  app.post('/api/organizations/:orgId/commands', async (c) => {
    requireCondition(
      options.runtime,
      503,
      'runtime_unavailable',
      'The workspace runtime is unavailable.',
    );
    const input = z
      .object({ name: z.string(), payload: z.unknown() })
      .strict()
      .parse(await c.req.json());
    const commandName = input.name;
    requireCondition(
      isCommandName(commandName),
      400,
      'command_invalid',
      'Unknown workspace command.',
    );
    const session = c.get('session');
    const orgId = c.get('organization').id;
    if (commandName === 'agent.cancel') {
      const { runId } = z
        .object({ runId: z.string().max(100) })
        .strict()
        .parse(input.payload);
      return c.json(
        options.agentRuns?.cancel(runId, session.userId, orgId) ?? { cancelled: false },
      );
    }
    if (commandName === 'agent.run') {
      const runtime = options.runtime;
      const identity = c.get('identity');
      c.header('Content-Type', 'application/x-ndjson');
      return stream(c, async (output) => {
        let runId: string | undefined;
        let aborted = false;
        let pending = Promise.resolve();
        output.onAbort(() => {
          aborted = true;
          if (runId) options.agentRuns?.cancel(runId, session.userId, orgId);
        });
        try {
          const result = await runtime.execute(
            session,
            identity,
            orgId,
            commandName,
            input.payload,
            (event) => {
              runId = event.runId;
              if (aborted) options.agentRuns?.cancel(runId, session.userId, orgId);
              else
                pending = pending.then(async () => {
                  await output.write(`${JSON.stringify({ event })}\n`);
                });
            },
          );
          await pending;
          if (!aborted) await output.write(`${JSON.stringify({ result })}\n`);
        } catch (error) {
          await pending.catch(() => {});
          if (!aborted)
            await output.write(
              `${JSON.stringify({ error: error instanceof CloudError ? error.message : 'The AI request could not be completed.' })}\n`,
            );
        }
      });
    }
    return c.json(
      await options.runtime.execute(session, c.get('identity'), orgId, commandName, input.payload),
    );
  });
  return app;
}
