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
import { BillingStore } from './billing';
import { UsageStore } from './usage';

export interface CloudConfig {
  publicOrigin: string;
  elizaOrigin: string;
  elizaLoginOrigin: string;
  elizaAppId: string;
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
  const workspaces = new WorkspaceStore(pool);
  const usage = new UsageStore(pool);
  const billing = new BillingStore(pool, eliza);
  const app = new Hono<CloudEnv>();
  const sessionCookie = config.production ? '__Host-outreachr_session' : 'outreachr_session';
  const stateCookie = config.production ? '__Host-outreachr_login' : 'outreachr_login';
  const cookie = { httpOnly: true, secure: config.production, sameSite: 'Lax' as const, path: '/' };

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
      c.req.path !== '/api/billing/webhook'
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
    const target = new URL('/app-auth/authorize', config.elizaLoginOrigin);
    target.searchParams.set('app_id', config.elizaAppId);
    target.searchParams.set('redirect_uri', `${config.publicOrigin}/api/auth/callback`);
    target.searchParams.set('state', state);
    return c.redirect(target.href);
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
  app.post('/api/billing/webhook', async (c) => {
    await billing.webhook(await c.req.text(), c.req.header('Stripe-Signature') ?? '');
    return c.json({ received: true });
  });
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
    return c.json({
      user: {
        id: result.user.id,
        email: result.user.email,
        name: result.user.name,
        defaultOrgId: result.user.default_org_id,
      },
      organizations: result.organizations.map((org) => ({
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
    return c.json(await workspaces.acceptInvite(session.userId, input.token));
  });
  app.use('/api/organizations/:orgId/*', async (c, next) => {
    const orgId = uuid.parse(c.req.param('orgId'));
    c.set('organization', await memberOrganization(pool, c.get('session').userId, orgId));
    await next();
  });
  app.get('/api/organizations/:orgId/members', async (c) =>
    c.json(await workspaces.members(c.get('session').userId, c.get('organization').id)),
  );
  app.get('/api/organizations/:orgId/invites', async (c) => {
    const org = c.get('organization');
    requireCondition(
      org.role === 'owner' || org.role === 'admin',
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
    return c.json({ success: true });
  });
  app.get('/api/organizations/:orgId/usage', async (c) =>
    c.json(await usage.summary(c.get('session').userId, c.get('organization').id)),
  );
  app.get('/api/google/connections', async (c) =>
    c.json(await eliza.connections(c.get('session').grant)),
  );
  app.post('/api/google/connect', async (c) => {
    const input = await c.req.json().catch(() => {
      throw new CloudError(400, 'invalid_json', 'Invalid JSON body.');
    });
    z.object({}).strict().parse(input);
    return c.json(await eliza.connectGoogle(c.get('session').grant));
  });
  app.post('/api/organizations/:orgId/billing/checkout', async (c) => {
    const input = z
      .object({ plan: z.enum(['sol', 'astra']), seats: z.number().int().min(1).max(1000) })
      .strict()
      .parse(await c.req.json());
    return c.json(await billing.open(c.get('session').userId, c.get('organization').id, input));
  });
  app.post('/api/organizations/:orgId/billing/portal', async (c) =>
    c.json(await billing.open(c.get('session').userId, c.get('organization').id)),
  );
  app.post('/api/organizations/:orgId/billing/refresh', async (c) => {
    await billing.reconcileMember(c.get('session').userId, c.get('organization').id);
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
