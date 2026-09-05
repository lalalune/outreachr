/** Accepts Cloud-signed invalidation hints; a notification never grants product access. */
import { createHash } from 'node:crypto';
import { verifyAppBillingNotification } from '@elizaos/cloud-sdk/app-notifications';
import type { Pool } from 'pg';
import { lockOrganization, transaction } from './database';
import { CloudError, requireCondition } from './errors';

export class BillingNotifications {
  constructor(
    readonly pool: Pool,
    readonly config: {
      appId: string;
      environment: 'test' | 'live';
      productFamilyKey: string;
      keys: Readonly<Record<string, string>>;
    },
    readonly now: () => Date = () => new Date(),
  ) {}

  async receive(body: string, headers: Headers) {
    requireCondition(
      Buffer.byteLength(body, 'utf8') <= 65_536,
      413,
      'notification_too_large',
      'Billing notification is too large.',
    );
    requireCondition(
      Object.keys(this.config.keys).length > 0,
      503,
      'notification_unavailable',
      'Billing notifications are not configured.',
    );
    const keyId = headers.get('X-Eliza-Key-Id') ?? '';
    const secret = Object.hasOwn(this.config.keys, keyId) ? this.config.keys[keyId] : undefined;
    requireCondition(
      secret,
      401,
      'notification_invalid',
      'Billing notification could not be verified.',
    );
    let notification;
    try {
      notification = await verifyAppBillingNotification({
        secret,
        expectedAppId: this.config.appId,
        expectedEnvironment: this.config.environment,
        timestamp: headers.get('X-Eliza-Timestamp') ?? '',
        signature: headers.get('X-Eliza-Signature') ?? '',
        body,
        now: this.now(),
      });
    } catch {
      throw new CloudError(
        401,
        'notification_invalid',
        'Billing notification could not be verified.',
      );
    }
    requireCondition(
      notification.productFamilyKey === this.config.productFamilyKey &&
        headers.get('X-Eliza-Delivery') === notification.id &&
        headers.get('X-Eliza-Event') === notification.event,
      401,
      'notification_invalid',
      'Billing notification could not be verified.',
    );
    const digest = createHash('sha256').update(body, 'utf8').digest('hex');
    await transaction(this.pool, async (db) => {
      const found = await db.query<{ id: string }>(
        `SELECT id FROM outreachr.organizations WHERE
        cloud_app_id=$1 AND cloud_billing_environment=$2 AND cloud_billing_account_id=$3 AND cloud_product_family_key=$4`,
        [
          notification.appId,
          notification.environment,
          notification.billingAccountId,
          notification.productFamilyKey,
        ],
      );
      const orgId = found.rows[0]?.id;
      if (orgId) await lockOrganization(db, orgId);
      const inserted = await db.query(
        `INSERT INTO outreachr.cloud_billing_notifications
        (id,app_id,environment,billing_account_id,product_family_key,payload_hash) VALUES($1,$2,$3,$4,$5,$6)
        ON CONFLICT(id) DO NOTHING RETURNING id`,
        [
          notification.id,
          notification.appId,
          notification.environment,
          notification.billingAccountId,
          notification.productFamilyKey,
          digest,
        ],
      );
      if (!inserted.rowCount) {
        const recorded = await db.query<{ payload_hash: string }>(
          'SELECT payload_hash FROM outreachr.cloud_billing_notifications WHERE id=$1',
          [notification.id],
        );
        requireCondition(
          recorded.rows[0]?.payload_hash === digest,
          409,
          'notification_changed',
          'A previously accepted notification cannot change.',
        );
        return;
      }
      // The invalidation and receipt commit together. A delayed older revision can
      // request another read, but cannot overwrite a newer subscription projection.
      if (orgId)
        await db.query(
          'UPDATE outreachr.organizations SET cloud_billing_invalidated=true WHERE id=$1',
          [orgId],
        );
    });
    return { received: true as const };
  }
}
