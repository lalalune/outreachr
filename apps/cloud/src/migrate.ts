/** Applies the isolated product schema; production use requires an explicit database identity. */
import { Pool } from 'pg';
import { z } from 'zod';
import { migrate } from './schema';
const env = z
  .object({
    MIGRATION_DATABASE_URL: z.string().url(),
    MIGRATION_EXPECT_DATABASE: z.string().min(1),
    MIGRATION_RUNTIME_ROLE: z
      .string()
      .regex(/^[a-z_][a-z0-9_]{0,62}$/)
      .optional(),
    DATABASE_SSL: z.enum(['verify', 'railway-public-proxy', 'disable']).default('verify'),
  })
  .parse(process.env);
const pool = new Pool({
  connectionString: env.MIGRATION_DATABASE_URL,
  ssl:
    env.DATABASE_SSL === 'disable' ? false : { rejectUnauthorized: env.DATABASE_SSL === 'verify' },
  max: 1,
});
try {
  const identity = (await pool.query<{ database: string }>('SELECT current_database() AS database'))
    .rows[0]!;
  if (identity.database !== env.MIGRATION_EXPECT_DATABASE)
    throw new Error('Migration database identity does not match the explicit target.');
  if (env.MIGRATION_RUNTIME_ROLE) {
    const role = await pool.query<{ restricted: boolean }>(
      'SELECT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AS restricted FROM pg_roles WHERE rolname=$1',
      [env.MIGRATION_RUNTIME_ROLE],
    );
    if (!role.rows[0]?.restricted)
      throw new Error('Migration runtime role must be an existing restricted login role.');
  }
  await migrate(pool);
  if (env.MIGRATION_RUNTIME_ROLE) {
    // The validated identifier is explicit operator configuration, never request input.
    const role = `"${env.MIGRATION_RUNTIME_ROLE}"`;
    await pool.query(`BEGIN;
      GRANT USAGE ON SCHEMA outreachr TO ${role};
      GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA outreachr TO ${role};
      GRANT USAGE ON ALL SEQUENCES IN SCHEMA outreachr TO ${role};
      ALTER DEFAULT PRIVILEGES IN SCHEMA outreachr GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO ${role};
      ALTER DEFAULT PRIVILEGES IN SCHEMA outreachr GRANT USAGE ON SEQUENCES TO ${role};
      COMMIT;`);
  }
  process.stdout.write('Outreachr schema migration completed.\n');
} finally {
  await pool.end();
}
