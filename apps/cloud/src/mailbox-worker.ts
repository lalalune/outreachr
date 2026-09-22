/** Opt-in scheduled reconciliation; never sends mail and never retains a new credential. */
import type { Pool } from 'pg';
import type { SessionStore } from './sessions';
import type { CloudRuntime } from './runtime';
import { CloudBillingAccounts } from './billing-accounts';
import { CloudError, requireCondition } from './errors';

export class MailboxWorker {
  constructor(
    readonly pool: Pool,
    readonly sessions: SessionStore,
    readonly runtime: CloudRuntime,
    readonly productFamilyKey: string,
  ) {}
  async runPending() {
    const rows = await this.pool.query<{ org_id: string; user_id: string; connection_id: string }>(
      `UPDATE outreachr.mailboxes m SET next_sync_at=now()+interval '10 minutes'
       FROM (SELECT m.org_id,m.user_id FROM outreachr.mailboxes m
       JOIN outreachr.organizations o ON o.id=m.org_id JOIN outreachr.memberships member ON member.org_id=m.org_id AND member.user_id=m.user_id
       WHERE m.background_sync AND m.next_sync_at<=now() AND o.deleted_at IS NULL AND o.archived_at IS NULL AND member.role<>'viewer'
       ORDER BY m.next_sync_at LIMIT 4 FOR UPDATE OF m SKIP LOCKED) due
       WHERE m.org_id=due.org_id AND m.user_id=due.user_id RETURNING m.org_id,m.user_id,m.connection_id`,
    );
    for (const row of rows.rows) {
      let error: string | null = null;
      try {
        const session = await this.sessions.forBackground(row.user_id);
        const identity = await this.runtime.options.eliza.identity(session.grant);
        requireCondition(
          identity.id === row.user_id && identity.emailVerified,
          401,
          'session_expired',
          'Reconnect your account.',
        );
        const binding = await this.pool.query(
          'SELECT 1 FROM outreachr.organizations WHERE id=$1 AND cloud_billing_account_id IS NOT NULL',
          [row.org_id],
        );
        if (binding.rowCount)
          await new CloudBillingAccounts(
            this.pool,
            this.runtime.options.eliza,
            this.productFamilyKey,
          ).snapshot(row.user_id, row.org_id, session.grant);
        await this.runtime.execute(session, identity, row.org_id, 'connector.syncMail', {
          provider: 'google',
        });
      } catch (cause) {
        error = cause instanceof CloudError ? cause.code : 'provider_sync_failed';
      }
      await this.pool.query(
        `UPDATE outreachr.mailboxes SET next_sync_at=now()+interval '5 minutes',sync_error=$4,last_sync_at=CASE WHEN $4::text IS NULL THEN now() ELSE last_sync_at END WHERE org_id=$1 AND user_id=$2 AND connection_id=$3`,
        [row.org_id, row.user_id, row.connection_id, error],
      );
    }
    return rows.rowCount ?? 0;
  }
}
