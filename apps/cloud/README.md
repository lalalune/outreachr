# Outreachr Cloud

The browser CRM is in `apps/cloud-web`. This Node BFF reuses the desktop command,
connector, and vault services. Every workspace mutation takes a PostgreSQL
advisory lock; vault checkpoints commit before provider sends. Gmail credentials
stay in Eliza Cloud. The BFF stores only encrypted, revocable delegated grants.

## Local verification

Use PostgreSQL 16 on localhost. The integration and browser test servers create
and drop their own databases; they reject nonlocal database addresses.

```sh
pnpm install --frozen-lockfile
pnpm build:packages
TEST_DATABASE_URL=postgres://outreachr@127.0.0.1:55439/postgres pnpm --filter @outreachr/cloud test:integration
TEST_DATABASE_URL=postgres://outreachr@127.0.0.1:55439/postgres pnpm --filter @outreachr/cloud-web test:e2e
pnpm --filter @outreachr/cloud-web build
pnpm --filter @outreachr/cloud-web exec wrangler deploy --dry-run
```

These tests use local identity, Google, inference, and billing fixtures where
specified. They do not demonstrate a live provider login, charge, or email.

## Deployment

The app is being migrated from the original product-specific bridge to generic
Cloud app APIs. Do not deploy the old bridge configuration. The intended
contract and remaining acceptance checks are in
[App subscriptions on Eliza Cloud](../../docs/app-billing-and-shipping-plan.md).

1. Merge and deploy the generic Cloud app subscription and delegation APIs
   through that repository's migration, staging certification, and production
   approval workflow. Adopt the finalized consumer contract before cutover.
2. Register Outreachr with its exact HTTPS origin and requested Google
   capabilities. Use app-scoped credentials issued by Cloud. Provider tokens
   remain in Cloud; the BFF stores only encrypted delegated grants.
3. Declare the Sol and Astra plans through Cloud's generic app billing setup:
   $49 and $200 per editing seat/month, with the agreed seven-day no-card trial.
   Cloud owns Stripe provisioning, intake, and payment verification. Outreachr
   consumes Cloud's signed notifications and authoritative entitlement snapshots.
   Keep app subscriptions separate from personal Eliza plans and developer usage.
4. Apply `src/migrate.ts` with an administrative `MIGRATION_DATABASE_URL` and
   explicit `MIGRATION_EXPECT_DATABASE`. Set `MIGRATION_RUNTIME_ROLE` to the existing
   restricted application login role to apply current and future table/sequence
   permissions within `outreachr`. It creates only the `outreachr` schema.
   Give the runtime role usage on that schema, DML on its tables, and sequence
   usage. Verify that it cannot read or write existing Cloud tables. Never give
   the BFF the administrative database credential.
5. Deploy `apps/cloud/Dockerfile` to Railway with the settings in
   `apps/cloud/railway.toml` and variables listed in `.env.example`. Use a random
   32-byte base64 session encryption key and independent random client and edge
   secrets. `ELIZA_INFERENCE_API_KEY` must be a funded product-owned Cloud key.
   There is deliberately one BFF replica while cancellation uses an in-process
   run registry. Workspace persistence and send serialization are in PostgreSQL.
6. Build the frontend and set Cloudflare Worker secrets `BFF_ORIGIN` and
   `EDGE_SECRET`; the edge secret must match Railway. Deploy the exact tested
   source revision. The Worker forwards only to the configured HTTPS BFF and
   never caches private API responses.
7. Verify the frontend revision, BFF health revision, actual Eliza login,
   workspace isolation, both exact model executions, Stripe test-mode purchase
   and webhook lifecycle, and a controlled Gmail send with provider receipt and
   mailbox readback. A deployment status or HTTP 200 alone is not acceptance.

The seven-day no-card trial is claimed once per verified Cloud account. Editing
seats are billed per workspace plan; viewers are free. Invitations never buy
seats. Paid access comes only from verified Cloud app subscription state, never a
checkout return URL. If a stale billing portal reduces seats below current
editors, editing pauses until capacity or membership is corrected. AI allowance
uses provider-reported token counts at uncached catalog prices plus the Cloud
service markup; uncertain requests retain their reserved allowance.
