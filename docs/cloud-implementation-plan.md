# Outreachr Cloud implementation plan

Research completed 2026-09-04. This plan precedes implementation.

The Cloud API and billing boundaries below are superseded by
[App subscriptions on Eliza Cloud](app-billing-and-shipping-plan.md).
Use generic Cloud app registration, delegation, and subscription APIs; do not
add product-specific Cloud routes or move Stripe processing into Outreachr.

## Product decisions

Keep the desktop application available. Add a hosted version of the same CRM,
including investor research, contacts, pipeline, tasks, documents, reviewed AI
proposals, exact-content draft approval, and the existing send ledger.

An account receives one default personal workspace on first login. Accounts can
belong to multiple workspaces without changing their existing Eliza Cloud
organization. Roles are owner, admin, member, and viewer. Owners manage billing;
admins manage members; members edit; viewers read without consuming a paid seat.
Protect the last owner and validate every resource against current membership.

Each workspace selects one plan. Sol costs **$49 per editing seat per month**;
Astra costs **$200 per editing seat per month**. One owner is the initial paid
seat. Pending invitations do not incur charges. Owners explicitly purchase seat
capacity before accepting more editing members; viewers are free. Never charge
as a side effect of opening or accepting an invite. Downgrades must fit existing
membership and clearly disclose their effective date.

This follows the per-user convention used by [Attio](https://attio.com/pricing)
and the separation of paid seats and free read-only collaborators documented by
[HubSpot](https://knowledge.hubspot.com/account-management/manage-seats). A flat
unlimited organization price would expose variable AI costs to unlimited users.

Offer a seven-day, no-card trial on the default workspace, once per verified
Eliza account. Trial expiry preserves access to read and export existing data;
editing, generation, and sending require an active entitlement. Creating another
workspace or accepting another invite does not reset a consumed trial. The trial
includes a bounded AI allowance. Paid allowances are fixed per workspace and shared by its members, shown
alongside remaining usage; editing seat quantity does not multiply them. No automatic paid overages.

## Verified reuse boundaries

- Eliza's production OIDC discovery and health endpoints respond successfully.
  Its existing `/app-auth/authorize` and one-time `/api/v1/app-auth/session`
  exchange support registered applications. Reuse that login and verify state,
  application binding, code expiry, and replay protection. Browser sessions use
  secure HttpOnly cookies, explicit CSRF defenses, and revocation.
- Managed Gmail already stores and refreshes credentials in Eliza Cloud. Its
  service selects connections by Cloud user, Cloud organization, role, and grant.
  An app login code currently grants identity only. Add a narrow, registered
  Outreachr delegation endpoint in Eliza Cloud; do not forward a broad user token
  or resolve Gmail from an application owner's API key. Gmail access requires
  the signed-in person's explicit connection choice. Workspace membership never
  grants access to another member's mailbox.
- Eliza's existing PostgreSQL lives on Railway. Use a dedicated `outreachr`
  schema and least-privilege database role on the existing service if available;
  provision a separate Railway database if isolation cannot be established.
  Existing Eliza users have one Cloud organization, so do not repurpose that
  field to represent Outreachr's many-to-many workspaces.
- Reuse Eliza's Stripe account and customer authority through a scoped Cloud
  billing boundary. Add separate Outreachr prices/subscriptions; leave existing
  Eliza $30/$100 plans unchanged. The live general subscription catalog currently
  returns 503 and must not be treated as launch-ready evidence.
- Eliza's live `/api/v1/models` catalog includes `openai/gpt-5.6-sol` and
  `openai/gpt-6-astra`. Enforce the workspace's exact model server-side and verify
  real inference on both before launch. Catalog presence is not execution proof.

## Architecture

Cloudflare serves the existing React interface and proxies same-origin API
requests to a Railway Node service. The origin requires a private edge token;
health can expose only version and readiness. Secrets stay in service bindings
or environment configuration, never in browser bundles.

The Railway service owns sessions, memberships, invitations, subscription
entitlements, usage reservations, uploads, and HTTP command dispatch. Adapt the
desktop bridge to HTTP and browser upload/download APIs. Reuse the core command
service with typed connector and agent ports. Cloud settings expose managed
connections, organization, billing, and usage instead of local CLI credentials.

Preserve the tested SQLite core for each workspace, with its snapshot stored
durably in PostgreSQL. Hold a PostgreSQL session advisory lock while loading and
mutating that workspace; persist every safety checkpoint before a provider call.
Use a persistence port rather than treating ephemeral disk as authority. This
is deliberately serialized per workspace and bounded by the existing vault size
limit. Record snapshot size and latency; a future relational migration must
preserve approval and send invariants. Do not import a user's desktop vault
without an explicit upload.

The Eliza patch provides registered-app code exchange and narrowly scoped,
revocable delegation for managed Gmail and product billing. It uses existing
Cloud services and current user ownership checks. Gmail sends include stable
RFC Message-ID and return provider message/thread receipts. Persist reservation
before sending; an ambiguous result remains blocked pending reconciliation.

Billing uses exact verified USD monthly Stripe prices, stable idempotency keys,
signed webhook verification, durable event deduplication, and reconciliation
against current subscription state to handle out-of-order delivery. Checkout
redirects are not payment evidence. A canceled, unpaid, or expired subscription
cannot authorize new paid work. Seat changes cannot remove the last owner or
silently displace existing members.

AI runs reserve bounded cost before inference, settle from actual usage, and
reject requests that exceed the model context or budget without silently
truncating prompts. Generation creates reviewable proposals; it never sends mail
or applies unreviewed changes. Document selection remains explicit.

## Implementation order

1. Add cloud package, PostgreSQL migrations, session/workspace/invite services,
   entitlement and usage rules, persistence port, and behavioral integration
   tests, preserving desktop behavior.
2. Add the scoped Eliza delegation and billing boundary with tests for code
   replay, application binding, ownership, revocation, and Gmail send receipts.
3. Connect the browser transport and full CRM to cloud commands; implement
   organization, invitation, plan, trial, usage, managed Gmail, and AI interfaces.
4. Add Cloudflare and Railway deployment configuration, secrets/bootstrap
   scripts, readiness checks, and version evidence. Register Outreachr in Eliza.
5. Run local integration/browser tests, existing desktop regressions, security
   review, builds, and hosted checks. Deploy reviewed revisions and verify live.

## Acceptance evidence

- Real Eliza login, logout, session expiry, default workspace, second workspace,
  switching, and tenant isolation. A forged workspace/resource identifier fails.
- Invite creation, expiry, revocation, wrong-email rejection, replay rejection,
  viewer restrictions, concurrent seat acceptance, and last-owner protection.
- Seven-day trial boundaries and anti-reset behavior; both exact Stripe plans;
  test-mode checkout, renewal, cancellation, payment failure, duplicate and
  reordered webhooks; live catalog and configured webhook readback. Never claim
  a mock payment proves a live charge. Do not charge a real user during testing.
- Both requested models execute through Eliza Cloud with recorded model and
  usage. Budget rejection and concurrent reservations cannot overspend.
- Real managed Gmail status, explicit mailbox choice, reviewed content, approval
  invalidation after edits, recipient suppression, one send to the authorized
  self-test recipient Shaw (`shawmakesmagic@gmail.com`), provider receipt, sent
  mailbox reconciliation, and duplicate-send rejection. Missing consent or
  required sender details must fail visibly rather than fabricate delivery.
- Browser tests cover onboarding, CRM CRUD, drafts, documents, organization and
  billing controls, reconnect/reload persistence, and mobile layouts. Uploaded
  paths cannot escape a workspace or reach server secrets.
- Restart and concurrent-process tests prove database persistence and locking.
  Production URLs must serve the recorded source revision, with no browser
  errors or leaked credentials. Record remaining external prerequisites honestly.

Technical references: [Stripe trials](https://docs.stripe.com/billing/subscriptions/trials),
[Stripe seat quantities](https://docs.stripe.com/billing/subscriptions/quantities),
[Cloudflare SPA assets](https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/),
[Railway monorepos](https://docs.railway.com/guides/deploying-a-monorepo),
[OpenAI Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol),
[OpenAI Astra](https://developers.openai.com/api/docs/models/gpt-6-astra).
