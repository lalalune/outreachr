/** Starts the cloud BFF with explicit credentials and an already-migrated database. */
import { serve } from '@hono/node-server';
import { Pool } from 'pg';
import { z } from 'zod';
import { createApp } from './app';
import { ElizaClient } from './eliza';
import { CredentialCipher, SessionStore } from './sessions';
import { CloudRuntime } from './runtime';
import { AgentRuns, CloudAgent } from './agent';
import { InferenceClient } from './inference';

const env = z
  .object({
    NODE_ENV: z.enum(['production', 'development', 'test']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(4174),
    DATABASE_URL: z.string().url(),
    DATABASE_SSL: z.enum(['verify', 'railway-public-proxy', 'disable']).default('verify'),
    PUBLIC_ORIGIN: z.string().url(),
    ELIZA_API_ORIGIN: z.string().url().default('https://api.eliza.app'),
    ELIZA_LOGIN_ORIGIN: z.string().url().default('https://cloud.eliza.app'),
    ELIZA_APP_ID: z.string().uuid(),
    ELIZA_CLIENT_SECRET: z.string().min(32),
    ELIZA_INFERENCE_API_KEY: z.string().min(20),
    SESSION_ENCRYPTION_KEY: z.string(),
    EDGE_SECRET: z.string().min(32),
    RAILWAY_GIT_COMMIT_SHA: z.string().optional(),
    REVISION: z.string().default('development'),
  })
  .parse(process.env);
if (
  env.NODE_ENV === 'production' &&
  [env.PUBLIC_ORIGIN, env.ELIZA_API_ORIGIN, env.ELIZA_LOGIN_ORIGIN].some(
    (value) => new URL(value).protocol !== 'https:',
  )
)
  throw new Error('Production origins must use HTTPS.');
if (new URL(env.PUBLIC_ORIGIN).origin !== env.PUBLIC_ORIGIN)
  throw new Error('PUBLIC_ORIGIN must be an exact origin.');
const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 12,
  connectionTimeoutMillis: 15_000,
  idleTimeoutMillis: 30_000,
  ssl:
    env.DATABASE_SSL === 'disable' ? false : { rejectUnauthorized: env.DATABASE_SSL === 'verify' },
});
pool.on('error', () => process.stderr.write('PostgreSQL connection failed.\n'));
await pool.query('SELECT id FROM outreachr.users LIMIT 0');
const eliza = new ElizaClient(env.ELIZA_API_ORIGIN, env.ELIZA_CLIENT_SECRET);
const sessions = new SessionStore(pool, new CredentialCipher(env.SESSION_ENCRYPTION_KEY));
const inference = new InferenceClient(env.ELIZA_API_ORIGIN, env.ELIZA_INFERENCE_API_KEY);
const runs = new AgentRuns();
const revision = env.RAILWAY_GIT_COMMIT_SHA ?? env.REVISION;
const runtime = new CloudRuntime({
  pool,
  eliza,
  revision,
  agentFactory: (context) => new CloudAgent(context, inference, runs),
});
const app = createApp({
  config: {
    publicOrigin: env.PUBLIC_ORIGIN,
    elizaOrigin: env.ELIZA_API_ORIGIN,
    elizaLoginOrigin: env.ELIZA_LOGIN_ORIGIN,
    elizaAppId: env.ELIZA_APP_ID,
    edgeSecret: env.EDGE_SECRET,
    production: env.NODE_ENV === 'production',
    revision,
  },
  pool,
  sessions,
  eliza,
  runtime,
  agentRuns: runs,
});
const server = serve({ fetch: app.fetch, port: env.PORT, hostname: '0.0.0.0' });
process.stdout.write(`Outreachr cloud listening on port ${env.PORT}, revision ${revision}.\n`);
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    server.close(() => {
      void pool.end().then(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 200_000).unref();
  });
