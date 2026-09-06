/** Purchaser review and durable commands through generic Eliza Cloud app billing. */
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { CloudApiError } from '@elizaos/cloud-sdk';
import type { OutreachrDelegation } from './delegation';
import { transaction, withWorkspaceLock } from './database';
import { CloudError, requireCondition } from './errors';
import { memberOrganization, type Organization } from './workspaces';
import { selectCheckoutPlan } from './billing-catalog';
import { billingOperation, readBillingSnapshot } from './billing-snapshot';
import type { Plan } from './plans';

const command = z.object({
  idempotencyKey: z.string(),
  expectedSubscriptionRevision: z
    .string()
    .regex(/^[1-9]\d*$/)
    .nullable(),
});
const trial = command.extend({
  planRevisionId: z.uuid(),
  quantity: z.number().int().min(1).max(1000),
});
const purchase = command.extend({
  planRevisionId: z.uuid(),
  quantity: z.number().int().min(1).max(1000),
  billingConsent: z.literal('accepted'),
});
const update = purchase.extend({ quoteId: z.uuid() });
const quoteSchema = z.object({
  success: z.literal(true),
  data: z.object({
    id: z.uuid(),
    appId: z.uuid(),
    billingAccountId: z.uuid(),
    productFamilyKey: z.string(),
    planRevisionId: z.uuid(),
    quantity: z.number().int().positive(),
    subscriptionRevision: z.string().regex(/^[1-9]\d*$/),
    dueNowCents: z.number().int().safe(),
    currency: z.literal('usd'),
    nextInvoiceAmountCents: z.number().int().safe(),
    recurringAmountCents: z.number().int().nonnegative().safe(),
    trialEndsAt: z.iso.datetime({ offset: true }).nullable(),
    expiresAt: z.iso.datetime({ offset: true }),
  }),
});
export interface BillingReview {
  id: string;
  kind: 'checkout' | 'update' | 'portal' | 'external' | 'trial';
  plan: Plan | null;
  seats: number | null;
  monthlyTotalCents: number | null;
  dueNowCents: number | null;
  nextInvoiceAmountCents: number | null;
  trialEndsAt: string | null;
  expiresAt: string;
}
type Operation = z.infer<typeof billingOperation>;
interface Intent {
  id: string;
  org_id: string;
  user_id: string;
  app_id: string;
  client_id: string;
  billing_account_id: string;
  environment: 'test' | 'live';
  product_family_key: string;
  kind: BillingReview['kind'];
  request_json: unknown;
  review_json: BillingReview;
  operation_json: Operation | null;
  state: 'review' | 'pending' | 'complete' | 'superseded';
  confirmed_at: Date | null;
  rejection_code: string | null;
  cancellation_request_json: unknown;
  cancellation_operation_json: Operation | null;
  cancellation_pending: boolean;
}
export interface BillingProgress {
  review: BillingReview;
  state: Intent['state'];
  operation: Operation | null;
  rejectionCode: string | null;
  cancellationPending: boolean;
}

export class BillingStore {
  constructor(
    readonly pool: Pool,
    readonly cloud: OutreachrDelegation,
    readonly productFamilyKey: string,
  ) {}
  private async owner(db: PoolClient, userId: string, orgId: string) {
    const org = await memberOrganization(db, userId, orgId);
    requireCondition(
      org.role === 'owner',
      403,
      'owner_required',
      'Only workspace owners can purchase or manage a subscription.',
    );
    requireCondition(
      !org.cloud_ownership_pending,
      409,
      'ownership_change_pending',
      'Finish the pending ownership change before managing billing.',
    );
    requireCondition(
      org.cloud_billing_account_id &&
        org.cloud_app_id === this.cloud.config.appId &&
        org.cloud_billing_environment === this.cloud.config.billingEnvironment &&
        org.cloud_product_family_key === this.productFamilyKey,
      503,
      'billing_account_unavailable',
      'Connect this workspace to Cloud app billing first.',
    );
    return org;
  }
  private verifyIntent(intent: Intent, userId: string, accountId: string) {
    requireCondition(
      intent.user_id === userId,
      403,
      'billing_purchaser_required',
      'The owner who started this billing request must finish it.',
    );
    requireCondition(
      intent.app_id === this.cloud.config.appId &&
        intent.client_id === this.cloud.config.clientId &&
        intent.environment === this.cloud.config.billingEnvironment &&
        intent.billing_account_id === accountId &&
        intent.product_family_key === this.productFamilyKey,
      409,
      'billing_binding_changed',
      'The billing registration changed. This request needs reconciliation.',
    );
  }
  private progress(intent: Intent): BillingProgress {
    return {
      review: intent.review_json,
      state: intent.state,
      operation: intent.operation_json,
      rejectionCode: intent.rejection_code,
      cancellationPending: intent.cancellation_pending,
    };
  }
  private async pending(db: PoolClient, orgId: string) {
    return (
      await db.query<Intent>(
        "SELECT * FROM outreachr.cloud_billing_intents WHERE org_id=$1 AND state='pending'",
        [orgId],
      )
    ).rows[0];
  }
  private async snapshot(org: Organization, grant: string) {
    const snapshot = readBillingSnapshot(
      await this.cloud
        .appBilling(grant)
        .getSubscription(org.cloud_billing_account_id!, this.productFamilyKey),
      {
        appId: this.cloud.config.appId,
        environment: this.cloud.config.billingEnvironment,
        productFamilyKey: this.productFamilyKey,
        billingAccountId: org.cloud_billing_account_id!,
        workspaceId: org.id,
      },
    ).snapshot;
    requireCondition(
      snapshot.account.role === 'administrator',
      403,
      'billing_owner_required',
      'Cloud billing administrator access is required.',
    );
    return snapshot;
  }
  private async adopt(db: PoolClient, org: Organization, userId: string, operation: Operation) {
    const previous = (
      await db.query<Intent>(
        "SELECT * FROM outreachr.cloud_billing_intents WHERE org_id=$1 AND operation_json->>'id'=$2",
        [org.id, operation.id],
      )
    ).rows[0];
    if (previous) {
      this.verifyIntent(previous, userId, org.cloud_billing_account_id!);
      return previous;
    }
    const id = randomUUID();
    const review: BillingReview = {
      id,
      kind: 'external',
      plan: null,
      seats: null,
      monthlyTotalCents: null,
      dueNowCents: null,
      nextInvoiceAmountCents: null,
      trialEndsAt: null,
      expiresAt: new Date().toISOString(),
    };
    // There is no local purchase body or consent to reconstruct. Recovery only reads the authorized remote operation.
    const intent = (
      await db.query<Intent>(
        `INSERT INTO outreachr.cloud_billing_intents
      (id,org_id,user_id,app_id,client_id,billing_account_id,environment,product_family_key,kind,request_json,review_json,operation_json,state)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'external','null'::jsonb,$9,$10,'pending') RETURNING *`,
        [
          id,
          org.id,
          userId,
          this.cloud.config.appId,
          this.cloud.config.clientId,
          org.cloud_billing_account_id,
          this.cloud.config.billingEnvironment,
          this.productFamilyKey,
          JSON.stringify(review),
          JSON.stringify(operation),
        ],
      )
    ).rows[0]!;
    return intent;
  }
  async startTrial(userId: string, orgId: string, grant: string) {
    return withWorkspaceLock(this.pool, orgId, async (db) => {
      const org = await this.owner(db, userId, orgId);
      const pending = await this.pending(db, orgId);
      if (pending) {
        this.verifyIntent(pending, userId, org.cloud_billing_account_id!);
        // Signup may recover its own free-trial intent, never an unrelated purchase.
        return pending.kind === 'trial' ? this.execute(db, pending, grant) : this.progress(pending);
      }
      const previous = (
        await db.query<Intent>(
          "SELECT * FROM outreachr.cloud_billing_intents WHERE org_id=$1 AND kind='trial' ORDER BY created_at DESC LIMIT 1",
          [orgId],
        )
      ).rows[0];
      if (
        previous &&
        (org.cloud_provisioning_state === 'failed' ||
          previous.operation_json?.status === 'succeeded')
      ) {
        this.verifyIntent(previous, userId, org.cloud_billing_account_id!);
        return this.progress(previous);
      }
      const snapshot = await this.snapshot(org, grant);
      if (snapshot.pendingOperation)
        return this.progress(await this.adopt(db, org, userId, snapshot.pendingOperation));
      if (snapshot.subscription || snapshot.trialEligibility.status === 'claimed') return null;
      const selected = selectCheckoutPlan(
        await this.cloud.appBilling(grant).getCatalog(),
        {
          appId: this.cloud.config.appId,
          environment: this.cloud.config.billingEnvironment,
          productFamilyKey: this.productFamilyKey,
        },
        { plan: 'sol', seats: 1, assignedSeats: org.editing_members ?? 1 },
      );
      const id = randomUUID();
      const request = {
        idempotencyKey: `purchase:${id}`,
        expectedSubscriptionRevision: snapshot.mutationRevision,
        planRevisionId: selected.planRevisionId,
        quantity: selected.seats,
      };
      const review: BillingReview = {
        id,
        kind: 'trial',
        plan: 'sol',
        seats: 1,
        monthlyTotalCents: 0,
        dueNowCents: 0,
        nextInvoiceAmountCents: null,
        trialEndsAt: null,
        expiresAt: new Date().toISOString(),
      };
      const intent = await transaction(db, async (client) => {
        const saved = (
          await client.query<Intent>(
            `INSERT INTO outreachr.cloud_billing_intents
          (id,org_id,user_id,app_id,client_id,billing_account_id,environment,product_family_key,kind,request_json,review_json,state)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,'trial',$9,$10,'pending') RETURNING *`,
            [
              id,
              orgId,
              userId,
              this.cloud.config.appId,
              this.cloud.config.clientId,
              org.cloud_billing_account_id,
              this.cloud.config.billingEnvironment,
              this.productFamilyKey,
              JSON.stringify(request),
              JSON.stringify(review),
            ],
          )
        ).rows[0]!;
        await client.query(
          'INSERT INTO outreachr.audit(org_id,user_id,action,detail) VALUES($1,$2,$3,$4)',
          [orgId, userId, 'billing.trial_requested', JSON.stringify({ intentId: id, request })],
        );
        return saved;
      });
      // No card or recurring billing consent is requested or recorded for a free trial.
      return this.execute(db, intent, grant);
    });
  }
  async review(
    userId: string,
    orgId: string,
    grant: string,
    choice?: { plan: Plan; seats: number },
  ) {
    return withWorkspaceLock(this.pool, orgId, async (db) => {
      const org = await this.owner(db, userId, orgId);
      const pending = await this.pending(db, orgId);
      if (pending) {
        this.verifyIntent(pending, userId, org.cloud_billing_account_id!);
        return this.progress(pending);
      }
      requireCondition(
        org.cloud_provisioning_state !== 'pending',
        409,
        'workspace_setup_pending',
        'Finish the original Cloud workspace setup before starting a paid subscription.',
      );
      const legacy = await db.query(
        "SELECT id FROM outreachr.checkout_attempts WHERE org_id=$1 AND status='pending'",
        [orgId],
      );
      requireCondition(
        !legacy.rowCount,
        409,
        'billing_migration_pending',
        'An earlier checkout must be reconciled before starting a new purchase.',
      );
      const api = this.cloud.appBilling(grant);
      const binding = {
        appId: this.cloud.config.appId,
        environment: this.cloud.config.billingEnvironment,
        productFamilyKey: this.productFamilyKey,
        billingAccountId: org.cloud_billing_account_id!,
        workspaceId: org.id,
      };
      const snapshot = await this.snapshot(org, grant);
      if (snapshot.pendingOperation)
        return this.execute(
          db,
          await this.adopt(db, org, userId, snapshot.pendingOperation),
          grant,
        );
      const id = randomUUID();
      const base = {
        idempotencyKey: `purchase:${id}`,
        expectedSubscriptionRevision: snapshot.mutationRevision,
      };
      const review: BillingReview = {
        id,
        kind: 'portal',
        plan: null,
        seats: null,
        monthlyTotalCents: null,
        dueNowCents: null,
        nextInvoiceAmountCents: null,
        trialEndsAt: null,
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      };
      let request: unknown = base;
      if (choice) {
        const editors = (
          await db.query<{ count: number }>(
            "SELECT count(*)::int AS count FROM outreachr.memberships WHERE org_id=$1 AND role!='viewer'",
            [orgId],
          )
        ).rows[0]!.count;
        const selected = selectCheckoutPlan(await api.getCatalog(), binding, {
          ...choice,
          assignedSeats: Math.max(editors, snapshot.entitlement?.assignedSeats ?? 0),
        });
        Object.assign(review, {
          kind: 'checkout',
          plan: selected.plan,
          seats: selected.seats,
          monthlyTotalCents: selected.monthlyTotalCents,
        });
        const selection = {
          ...base,
          planRevisionId: selected.planRevisionId,
          quantity: selected.seats,
        };
        request = { ...selection, billingConsent: 'accepted' };
        const subscription = snapshot.subscription;
        const paymentSetup =
          subscription !== null &&
          (subscription.status === 'trialing' || subscription.status === 'paused') &&
          subscription.planRevisionId === selected.planRevisionId &&
          subscription.quantity === selected.seats;
        requireCondition(
          subscription?.status !== 'paused' || paymentSetup,
          409,
          'billing_resume_terms_required',
          'Resume the existing plan with its current seat count before changing the subscription.',
        );
        if (paymentSetup && subscription.status === 'trialing')
          review.trialEndsAt = subscription.trial?.endsAt ?? null;
        // Adding a card uses the existing trial's setup Checkout; quotes change its plan or seats.
        if (snapshot.mutationRevision !== null && !paymentSetup) {
          const parsed = quoteSchema.safeParse(
            await api.quoteSubscriptionUpdate(binding.billingAccountId, this.productFamilyKey, {
              ...selection,
              idempotencyKey: `quote:${id}`,
            }),
          );
          requireCondition(
            parsed.success,
            502,
            'billing_quote_invalid',
            'Cloud returned invalid subscription terms.',
          );
          const quote = parsed.data.data;
          requireCondition(
            quote.appId === binding.appId &&
              quote.billingAccountId === binding.billingAccountId &&
              quote.productFamilyKey === binding.productFamilyKey &&
              quote.planRevisionId === selected.planRevisionId &&
              quote.quantity === selected.seats &&
              quote.subscriptionRevision === snapshot.mutationRevision &&
              quote.recurringAmountCents === selected.monthlyTotalCents &&
              Date.parse(quote.expiresAt) > Date.now(),
            502,
            'billing_quote_scope',
            'Cloud could not confirm these subscription terms.',
          );
          Object.assign(review, {
            kind: 'update',
            dueNowCents: quote.dueNowCents,
            nextInvoiceAmountCents: quote.nextInvoiceAmountCents,
            trialEndsAt: quote.trialEndsAt,
            expiresAt: new Date(
              Math.min(Date.parse(quote.expiresAt), Date.parse(review.expiresAt)),
            ).toISOString(),
          });
          request = { ...selection, billingConsent: 'accepted', quoteId: quote.id };
        }
      }
      await db.query(
        "UPDATE outreachr.cloud_billing_intents SET state='superseded' WHERE org_id=$1 AND state='review'",
        [orgId],
      );
      const intent = (
        await db.query<Intent>(
          `INSERT INTO outreachr.cloud_billing_intents
        (id,org_id,user_id,app_id,client_id,billing_account_id,environment,product_family_key,kind,request_json,review_json)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
          [
            id,
            orgId,
            userId,
            binding.appId,
            this.cloud.config.clientId,
            binding.billingAccountId,
            binding.environment,
            this.productFamilyKey,
            review.kind,
            JSON.stringify(request),
            JSON.stringify(review),
          ],
        )
      ).rows[0]!;
      return this.progress(intent);
    });
  }
  private async execute(db: PoolClient, intent: Intent, grant: string): Promise<BillingProgress> {
    if (intent.cancellation_pending) return this.advanceCancellation(db, intent, grant);
    const api = this.cloud.appBilling(grant);
    let raw: unknown;
    try {
      if (
        intent.operation_json &&
        (intent.kind === 'external' ||
          !(intent.operation_json.status === 'failed' && intent.operation_json.error.retryable))
      ) {
        raw = await api.getOperation(intent.billing_account_id, intent.operation_json.id);
      } else {
        requireCondition(
          intent.kind !== 'external',
          409,
          'billing_operation_missing',
          'The original Cloud operation is required for recovery.',
        );
        const body = (
          intent.kind === 'trial'
            ? trial
            : intent.kind === 'update'
              ? update
              : intent.kind === 'checkout'
                ? purchase
                : command
        ).parse(intent.request_json);
        requireCondition(
          body.idempotencyKey === `purchase:${intent.id}`,
          409,
          'billing_intent_invalid',
          'The saved billing request is inconsistent.',
        );
        if (intent.kind !== 'portal') {
          const selected = (intent.kind === 'trial' ? trial : purchase).parse(body);
          requireCondition(
            selected.quantity === intent.review_json.seats,
            409,
            'billing_intent_invalid',
            'The saved seat quantity differs from the reviewed terms.',
          );
        }
        raw =
          intent.kind === 'trial'
            ? await api.startTrial(
                intent.billing_account_id,
                intent.product_family_key,
                trial.parse(body),
              )
            : intent.kind === 'checkout'
              ? await api.createCheckout(
                  intent.billing_account_id,
                  intent.product_family_key,
                  purchase.parse(body),
                )
              : intent.kind === 'update'
                ? await api.updateSubscription(
                    intent.billing_account_id,
                    intent.product_family_key,
                    update.parse(body),
                  )
                : await api.createPortal(
                    intent.billing_account_id,
                    intent.product_family_key,
                    command.parse(body),
                  );
      }
    } catch (error) {
      if (error instanceof CloudError) throw error;
      if (
        !intent.operation_json &&
        error instanceof CloudApiError &&
        error.statusCode === 409 &&
        error.errorBody.code === 'APP_BILLING_COMMAND_NOT_APPLIED'
      ) {
        // Cloud proves preparation rolled back before dispatch. A replacement still needs fresh review and consent.
        await db.query(
          "UPDATE outreachr.cloud_billing_intents SET state='complete',rejection_code=$2 WHERE id=$1",
          [intent.id, 'APP_BILLING_COMMAND_NOT_APPLIED'],
        );
        return this.progress({
          ...intent,
          state: 'complete',
          rejection_code: 'APP_BILLING_COMMAND_NOT_APPLIED',
        });
      }
      // No provider failure proves absence. Keep the durable request for the same purchaser's recovery.
      throw new CloudError(
        503,
        'billing_result_unconfirmed',
        'Cloud has not confirmed this request. Use Check billing request to recover the same operation.',
      );
    }
    const parsed = z.object({ success: z.literal(true), data: billingOperation }).safeParse(raw);
    requireCondition(
      parsed.success,
      502,
      'billing_operation_invalid',
      'Cloud returned an invalid billing operation. Check the same request again.',
    );
    const operation = parsed.data.data;
    requireCondition(
      operation.appId === intent.app_id &&
        operation.environment === intent.environment &&
        operation.billingAccountId === intent.billing_account_id &&
        operation.productFamilyKey === intent.product_family_key &&
        (!intent.operation_json || operation.id === intent.operation_json.id) &&
        (operation.status !== 'requires_action' ||
          intent.kind === 'external' ||
          (intent.kind === 'portal'
            ? operation.action.kind === 'portal'
            : intent.kind === 'checkout'
              ? operation.action.kind === 'checkout'
              : intent.kind === 'update' && operation.action.kind === 'payment')),
      502,
      'billing_operation_scope',
      'Cloud returned an operation for a different billing request.',
    );
    const state =
      operation.status === 'succeeded' ||
      (operation.status === 'failed' && !operation.error.retryable) ||
      (operation.status === 'requires_action' && operation.action.kind === 'portal')
        ? 'complete'
        : 'pending';
    // A receipt is not entitlement; the next authoritative snapshot decides workspace access.
    await db.query(
      'UPDATE outreachr.organizations SET cloud_billing_invalidated=true WHERE id=$1',
      [intent.org_id],
    );
    await db.query(
      'UPDATE outreachr.cloud_billing_intents SET operation_json=$2,state=$3 WHERE id=$1',
      [intent.id, JSON.stringify(operation), state],
    );
    if (intent.kind === 'trial' && operation.status === 'failed' && !operation.error.retryable)
      await db.query(
        "UPDATE outreachr.organizations SET cloud_provisioning_state='failed',cloud_provisioning_error=$2 WHERE id=$1 AND cloud_provisioning_state='pending'",
        [intent.org_id, operation.error.code],
      );
    return this.progress({ ...intent, operation_json: operation, state });
  }
  private async advanceCancellation(
    db: PoolClient,
    intent: Intent,
    grant: string,
  ): Promise<BillingProgress> {
    const request = command
      .extend({ operationId: z.uuid() })
      .strict()
      .parse(intent.cancellation_request_json);
    requireCondition(
      /^cancel:[0-9a-f-]{36}$/.test(request.idempotencyKey) &&
        request.operationId === intent.operation_json?.id,
      409,
      'billing_cancellation_invalid',
      'The saved cancellation does not match the original checkout.',
    );
    const api = this.cloud.appBilling(grant);
    let raw: unknown;
    try {
      const prior = intent.cancellation_operation_json;
      raw =
        prior && !(prior.status === 'failed' && prior.error.retryable)
          ? await api.getOperation(intent.billing_account_id, prior.id)
          : await api.expireCheckout(
              intent.billing_account_id,
              intent.product_family_key,
              request.operationId,
              {
                idempotencyKey: request.idempotencyKey,
                expectedSubscriptionRevision: request.expectedSubscriptionRevision,
              },
            );
    } catch (error) {
      if (
        !intent.cancellation_operation_json &&
        error instanceof CloudApiError &&
        error.statusCode === 409 &&
        error.errorBody.code === 'APP_BILLING_COMMAND_NOT_APPLIED'
      ) {
        await db.query(
          "UPDATE outreachr.cloud_billing_intents SET cancellation_pending=false,rejection_code='APP_BILLING_COMMAND_NOT_APPLIED' WHERE id=$1",
          [intent.id],
        );
        return this.execute(
          db,
          {
            ...intent,
            cancellation_pending: false,
            rejection_code: 'APP_BILLING_COMMAND_NOT_APPLIED',
          },
          grant,
        );
      }
      // Keep the cancellation pending and hide its checkout link until the same operation is confirmed.
      return this.progress(intent);
    }
    const parsed = z.object({ success: z.literal(true), data: billingOperation }).safeParse(raw);
    requireCondition(
      parsed.success,
      502,
      'billing_cancellation_invalid',
      'Cloud could not confirm the original checkout cancellation.',
    );
    const operation = parsed.data.data;
    requireCondition(
      operation.appId === intent.app_id &&
        operation.environment === intent.environment &&
        operation.billingAccountId === intent.billing_account_id &&
        operation.productFamilyKey === intent.product_family_key &&
        operation.id !== request.operationId &&
        (!intent.cancellation_operation_json ||
          operation.id === intent.cancellation_operation_json.id) &&
        operation.status !== 'requires_action',
      502,
      'billing_cancellation_scope',
      'Cloud returned a different checkout cancellation.',
    );
    const pending = !(
      operation.status === 'succeeded' ||
      (operation.status === 'failed' && !operation.error.retryable)
    );
    await db.query(
      'UPDATE outreachr.cloud_billing_intents SET cancellation_operation_json=$2,cancellation_pending=$3 WHERE id=$1',
      [intent.id, JSON.stringify(operation), pending],
    );
    const saved = {
      ...intent,
      cancellation_operation_json: operation,
      cancellation_pending: pending,
    };
    // Expiry must be followed by a read of the original checkout. It may have completed payment during the race.
    return pending ? this.progress(saved) : this.execute(db, saved, grant);
  }
  async expireCheckout(userId: string, orgId: string, grant: string, id: string) {
    return withWorkspaceLock(this.pool, orgId, async (db) => {
      const org = await this.owner(db, userId, orgId);
      let intent = (
        await db.query<Intent>(
          'SELECT * FROM outreachr.cloud_billing_intents WHERE id=$1 AND org_id=$2',
          [id, orgId],
        )
      ).rows[0];
      requireCondition(intent, 404, 'billing_request_missing', 'Billing request not found.');
      this.verifyIntent(intent, userId, org.cloud_billing_account_id!);
      if (intent.cancellation_pending) return this.advanceCancellation(db, intent, grant);
      requireCondition(
        intent.state !== 'review' && intent.state !== 'superseded',
        409,
        'checkout_not_open',
        'Only a confirmed open checkout can be canceled.',
      );
      const refreshed = await this.execute(db, intent, grant);
      if (refreshed.state === 'complete') return refreshed;
      requireCondition(
        refreshed.operation?.status === 'requires_action' &&
          refreshed.operation.action.kind === 'checkout',
        409,
        'checkout_not_open',
        'Check the billing request until Cloud confirms an open checkout. Pending invoice payments cannot be expired as checkout.',
      );
      intent = (
        await db.query<Intent>('SELECT * FROM outreachr.cloud_billing_intents WHERE id=$1', [id])
      ).rows[0]!;
      const snapshot = await this.snapshot(org, grant);
      const request = {
        idempotencyKey: `cancel:${randomUUID()}`,
        expectedSubscriptionRevision: snapshot.mutationRevision,
        operationId: refreshed.operation.id,
      };
      // This commit survives lost responses and process restarts. Never replace an ambiguous expiry body.
      await transaction(db, async (client) => {
        await client.query(
          'INSERT INTO outreachr.audit(org_id,user_id,action,detail) VALUES($1,$2,$3,$4)',
          [
            orgId,
            userId,
            'billing.checkout_cancellation_requested',
            JSON.stringify({ intentId: intent.id, request }),
          ],
        );
        await client.query(
          'UPDATE outreachr.cloud_billing_intents SET cancellation_request_json=$2,cancellation_operation_json=null,cancellation_pending=true,rejection_code=null WHERE id=$1',
          [intent.id, JSON.stringify(request)],
        );
      });
      return this.advanceCancellation(
        db,
        {
          ...intent,
          cancellation_request_json: request,
          cancellation_operation_json: null,
          cancellation_pending: true,
          rejection_code: null,
        },
        grant,
      );
    });
  }
  async confirm(userId: string, orgId: string, grant: string, id: string) {
    return withWorkspaceLock(this.pool, orgId, async (db) => {
      const org = await this.owner(db, userId, orgId);
      const intent = (
        await db.query<Intent>(
          'SELECT * FROM outreachr.cloud_billing_intents WHERE id=$1 AND org_id=$2',
          [id, orgId],
        )
      ).rows[0];
      requireCondition(intent, 404, 'billing_request_missing', 'Billing request not found.');
      this.verifyIntent(intent, userId, org.cloud_billing_account_id!);
      requireCondition(
        intent.state !== 'superseded',
        409,
        'billing_review_superseded',
        'Review the latest subscription terms.',
      );
      if (intent.state === 'complete') return this.progress(intent);
      if (intent.state === 'review') {
        requireCondition(
          Date.parse(intent.review_json.expiresAt) > Date.now(),
          409,
          'billing_review_expired',
          'Subscription terms expired. Review them again.',
        );
        requireCondition(
          !(await this.pending(db, orgId)),
          409,
          'billing_operation_pending',
          'Finish the pending billing request first.',
        );
        // Commit consent and immutable command before any network mutation, including a response lost after payment creation.
        await db.query(
          "UPDATE outreachr.cloud_billing_intents SET state='pending',confirmed_at=now() WHERE id=$1",
          [intent.id],
        );
        intent.state = 'pending';
      }
      return this.execute(db, intent, grant);
    });
  }
  async current(userId: string, orgId: string, grant: string) {
    return withWorkspaceLock(this.pool, orgId, async (db) => {
      const org = await this.owner(db, userId, orgId);
      let intent = await this.pending(db, orgId);
      if (!intent) {
        const snapshot = await this.snapshot(org, grant);
        if (!snapshot.pendingOperation) return null;
        intent = await this.adopt(db, org, userId, snapshot.pendingOperation);
      }
      this.verifyIntent(intent, userId, org.cloud_billing_account_id!);
      return intent.confirmed_at || intent.kind === 'external' || intent.kind === 'trial'
        ? this.execute(db, intent, grant)
        : this.progress(intent);
    });
  }
}
