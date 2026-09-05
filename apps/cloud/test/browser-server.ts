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
const codes = new Map<string, typeof owner>();
const grants = new Map<string, typeof owner>();
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
fixture.post('/api/v1/outreachr/token', async (c) => {
  const { code } = await c.req.json<{ code: string }>();
  const user = codes.get(code);
  codes.delete(code);
  if (!user) return c.json({ error: 'Invalid code' }, 401);
  const token = `outreachr_${randomBytes(24).toString('hex')}`;
  grants.set(token, user);
  return c.json({
    success: true,
    token,
    user,
    expiresAt: new Date(Date.now() + 86400_000).toISOString(),
  });
});
fixture.get('/api/v1/outreachr/identity', (c) => {
  const user = grants.get(c.req.header('Authorization')?.replace('Bearer ', '') ?? '');
  return user ? c.json({ success: true, user }) : c.json({ error: 'Signed out' }, 401);
});
fixture.post('/api/v1/outreachr/revoke', (c) => {
  grants.delete(c.req.header('Authorization')?.replace('Bearer ', '') ?? '');
  return c.json({ success: true });
});
fixture.get('/api/v1/outreachr/google/connections', (c) =>
  c.json({ success: true, connections: [] }),
);
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
fixture.post('/api/v1/chat/completions', async (c) => {
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
const eliza = new ElizaClient('http://127.0.0.1:4175', 'fixture-secret'.repeat(4), providerRequest);
const inference = new InferenceClient(
  'http://127.0.0.1:4175',
  'fixture-inference-key',
  providerRequest,
);
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
