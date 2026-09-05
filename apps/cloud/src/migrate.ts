/** Applies the isolated product schema; production use requires an explicit database identity. */
import { Pool } from 'pg';
import { z } from 'zod';
import { migrate } from './schema';
const env = z
  .object({
    MIGRATION_DATABASE_URL: z.string().url(),
    MIGRATION_EXPECT_DATABASE: z.string().min(1),
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
  await migrate(pool);
  process.stdout.write('Outreachr schema migration completed.\n');
} finally {
  await pool.end();
}
