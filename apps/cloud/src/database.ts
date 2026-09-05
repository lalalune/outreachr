/** Provides transaction and workspace serialization boundaries for PostgreSQL. */
import type { Pool, PoolClient } from 'pg';

export async function transaction<T>(
  pool: Pool | PoolClient,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const ownsClient = !('release' in pool);
  const client = 'release' in pool ? pool : await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    if (ownsClient) client.release();
  }
}

export async function lockOrganization(client: PoolClient, orgId: string): Promise<void> {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended('outreachr:vault:' || $1, 0))",
    [orgId],
  );
  await client.query('SELECT id FROM outreachr.organizations WHERE id=$1 FOR UPDATE', [orgId]);
}

/** Session locks preserve commits before irreversible sends; transaction rollback cannot undo mail. */
export async function withWorkspaceLock<T>(
  pool: Pool,
  orgId: string,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let locked = false;
  let broken = false;
  try {
    await client.query("SELECT pg_advisory_lock(hashtextextended('outreachr:vault:' || $1, 0))", [
      orgId,
    ]);
    locked = true;
    return await work(client);
  } finally {
    if (locked) {
      try {
        await client.query(
          "SELECT pg_advisory_unlock(hashtextextended('outreachr:vault:' || $1, 0))",
          [orgId],
        );
      } catch {
        // Never return a possibly locked connection to the pool after a transport failure.
        broken = true;
      }
    }
    client.release(broken);
  }
}
