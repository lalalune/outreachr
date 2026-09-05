/** Records each member's explicit mailbox choice without sharing access with the workspace. */
import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { hasRelationshipReadScope } from '@outreachr/connectors';
import type { ElizaClient, GoogleConnection } from './eliza';
import { requireCondition } from './errors';
import { lockOrganization, transaction } from './database';
import { entitlement, memberOrganization } from './workspaces';

export const mailboxConnectorId = (email: string): string =>
  `connector:cloud:google:${createHash('sha256').update(email.trim().toLowerCase()).digest('hex')}`;

export class MailboxStore {
  constructor(
    readonly pool: Pool,
    readonly eliza: ElizaClient,
  ) {}

  async select(
    userId: string,
    orgId: string,
    grant: string,
    connectionId: string | null,
  ): Promise<void> {
    const available = connectionId ? await this.eliza.connections(grant) : [];
    const connection = available.find(
      (item) => item.connectionId === connectionId && item.connected,
    );
    if (connectionId) {
      requireCondition(
        connection,
        403,
        'mailbox_not_available',
        'Choose a connected Gmail account belonging to your Eliza account.',
      );
      requireCondition(
        hasRelationshipReadScope('google', connection.grantedScopes),
        403,
        'mailbox_read_scope_required',
        'Reconnect Gmail in Eliza with mail reading enabled so Outreachr can check for previous contact.',
      );
    }
    await transaction(this.pool, async (client) => {
      await lockOrganization(client, orgId);
      const org = await memberOrganization(client, userId, orgId);
      requireCondition(
        entitlement(org, new Date()).canEdit,
        403,
        'editing_seat_required',
        'An active editing seat is required to connect Gmail.',
      );
      if (!connectionId) {
        await client.query('DELETE FROM outreachr.mailboxes WHERE org_id=$1 AND user_id=$2', [
          orgId,
          userId,
        ]);
      } else {
        const email = z.email().parse(connection!.identity?.email).toLowerCase();
        await client.query(
          `INSERT INTO outreachr.mailboxes(org_id,user_id,connection_id,email) VALUES($1,$2,$3,$4)
          ON CONFLICT(org_id,user_id) DO UPDATE SET connection_id=EXCLUDED.connection_id,email=EXCLUDED.email,selected_at=now()`,
          [orgId, userId, connectionId, email],
        );
      }
      await client.query(
        'INSERT INTO outreachr.audit(org_id,user_id,action,detail) VALUES($1,$2,$3,$4)',
        [
          orgId,
          userId,
          connectionId ? 'mailbox.selected' : 'mailbox.disconnected',
          JSON.stringify({ connectionId }),
        ],
      );
    });
  }

  async current(
    userId: string,
    orgId: string,
    grant: string,
    database: Pool | PoolClient = this.pool,
  ): Promise<(GoogleConnection & { email: string; connectionId: string }) | null> {
    const row = (
      await database.query<{ connection_id: string; email: string }>(
        'SELECT connection_id,email FROM outreachr.mailboxes WHERE org_id=$1 AND user_id=$2',
        [orgId, userId],
      )
    ).rows[0];
    if (!row) return null;
    const connections = await this.eliza.connections(grant);
    const connection = connections.find(
      (item) => item.connectionId === row.connection_id && item.connected,
    );
    requireCondition(
      connection &&
        typeof connection.identity?.email === 'string' &&
        connection.identity.email.toLowerCase() === row.email,
      409,
      'mailbox_changed',
      'Your selected Gmail account changed or disconnected. Choose it again in workspace settings.',
    );
    return { ...connection, email: row.email, connectionId: row.connection_id };
  }
}
