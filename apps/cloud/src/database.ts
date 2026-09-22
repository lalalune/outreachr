/** Provides transaction and workspace serialization boundaries for PostgreSQL. */
import type { Pool, PoolClient } from 'pg';
import { CloudError } from './errors';
import { admitWorkspace } from './workspace-admission';

export async function transaction<T>(
  pool: Pool | PoolClient,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const ownsClient = !('release' in pool);
  const client = 'release' in pool ? pool : await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '2s'");
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    if (error && typeof error === 'object' && 'code' in error && error.code === '55P03')
      throw new CloudError(
        409,
        'workspace_busy',
        'This workspace is busy. Try again after the current operation finishes.',
      );
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
  const releaseAdmission = await admitWorkspace(pool, orgId);
  let client: PoolClient;
  try {
    client = await pool.connect();
  } catch (error) {
    releaseAdmission();
    throw error;
  }
  let locked = false;
  let broken = false;
  try {
    const result = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock(hashtextextended('outreachr:vault:' || $1, 0)) AS locked",
      [orgId],
    );
    locked = result.rows[0]?.locked === true;
    if (!locked)
      throw new CloudError(
        409,
        'workspace_busy',
        'This workspace is busy on another worker. Try again after the current operation finishes.',
      );
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
    releaseAdmission();
  }
}
