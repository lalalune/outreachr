/** Persists each canonical vault on the PostgreSQL connection holding its workspace lock. */
import type { PoolClient } from 'pg';
import type { VaultPersistence } from '../../desktop/src/main/vault-service';

export function postgresVaultPersistence(client: PoolClient, orgId: string): VaultPersistence {
  return {
    async load() {
      const result = await client.query<{ snapshot: Buffer }>(
        'SELECT snapshot FROM outreachr.vaults WHERE org_id=$1',
        [orgId],
      );
      return result.rows[0]?.snapshot;
    },
    async save(snapshot) {
      await client.query(
        `INSERT INTO outreachr.vaults(org_id,snapshot) VALUES($1,$2)
        ON CONFLICT(org_id) DO UPDATE SET snapshot=EXCLUDED.snapshot,version=outreachr.vaults.version+1,updated_at=now()`,
        [orgId, Buffer.from(snapshot)],
      );
    },
  };
}
