/** Waits for PostgreSQL to observe client shutdown before removing a disposable test database. */
import type { Pool } from 'pg';

export async function closeTestDatabase(pool: Pool, admin: Pool, database: string) {
  if (!/^outreachr_[a-z0-9_]+$/.test(database))
    throw new Error('Refusing to remove a database outside the disposable test namespace.');
  try {
    await pool.end();
    // pool.end() can resolve before PostgreSQL observes the final socket close.
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const connections = await admin.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=$1',
        [database],
      );
      if (connections.rows[0]!.count === 0) {
        await admin.query(`DROP DATABASE IF EXISTS "${database}"`);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('Disposable database still has clients after pool shutdown.');
  } finally {
    await admin.end();
  }
}
