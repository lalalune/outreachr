# Independent app billing and Outreachr shipping plan

Decision updated 2026-09-05 following the product boundary correction. This supersedes the Outreachr-specific Cloud integration sections of `cloud-implementation-plan.md`.

## Separate the three commercial relationships

| Relationship | Payer | Product and authority |
| --- | --- | --- |
| Outreachr subscription | Outreachr workspace owner | Outreachr editing seats, seven-day trial, Sol/Astra plan, app entitlements |
| Eliza Cloud usage | Outreachr operator / app developer | App infrastructure and inference usage, attributed to the registered app and billed to its operator |
| Eliza personal app/agent subscription | A customer choosing that separate product | Eliza personal-agent features and capacity; never an Outreachr prerequisite or entitlement |

One identity may participate in all three. Sharing login does not share subscriptions, credits, workspaces, customer records, or billing portals. Cancelling Eliza personal-agent service must not cancel Outreachr. Paying Eliza must not unlock Outreachr. Outreachr users should not buy Cloud credits to use the AI included in their Outreachr plan.

## Decision for Outreachr now

Outreachr owns Stripe Billing in its Railway backend: Checkout, dedicated customers and prices, portal configuration, webhook signature verification, and subscription reconciliation. Its own database owns workspace memberships, trials, seat capacity, and derived access. Its Stripe webhook terminates directly in Outreachr; billing must continue working when the Eliza API is unavailable.

Keep the agreed seven-day no-card trial, $49 per editing seat/month for Sol, $200 for Astra, and free viewers. Invitations do not buy seats. Owners approve seat purchases; preserve read/export access after expiry. Keep existing usage reservations and bounded AI allowances; the app operator pays the actual Cloud usage bill.

Use the merchant Stripe account configured for Outreachr. If the same business operates Eliza and Outreachr, distinct products/customers/portal settings and app/workspace metadata can isolate the subscriptions within its existing Stripe account. Never reuse the personal Eliza subscription customer or present its products in Outreachr's portal. An unrelated app builder supplies its own Stripe merchant account. Do not create an additional financial account merely to ship this first-party app.

A future Cloud-managed billing option can use Stripe Connect, scoped by app and connected merchant account, so builders can sell subscriptions to their customers while Cloud separately bills builders. That is generic platform work, not an Outreachr launch dependency. Do not build a marketplace, payout system, or shared entitlement engine for this release.

## Code research

- Eliza `packages/cloud/api/v1/app-auth/connect/route.ts` and `session/route.ts` already implement registered-app authorization and a one-time identity-code exchange. Those handlers do not check a personal-agent subscription.
- Eliza `packages/cloud/api/v1/apps/[id]/charges/route.ts` and `shared/src/lib/services/app-charge-requests.ts` sell app credits using Stripe `mode: payment`. This is not recurring app SaaS billing.
- Eliza `shared/src/lib/services/app-credits.ts` states that app purchases and app inference use the shared organization credit ledger. Routing Outreachr seat payments through that path would conflate product access and Cloud consumption.
- Outreachr `apps/cloud/src/billing.ts` already owns workspace entitlement projections, checkout attempt persistence, idempotency and locking, but calls `ElizaClient.billing`. Replace that transport with an app-owned Stripe billing client.
- The recently added Eliza `v1/outreachr` routes, service modules, bindings and delegation schema violate the desired generic platform boundary. Their removal/replacement is required; they are not an acceptable final state.
- Generic Google OAuth exists, but a registered-app login code currently proves identity only. It does not authorize an arbitrary app to use the user's managed mailbox. Raw provider-token export is deliberately removed. Never substitute an operator API key for the customer's mailbox authority.

## Implementation order

1. Move the existing scoped Stripe operations and their behavioral tests into Outreachr. Separate the billing interface from Eliza identity/Google transport. Configure app Stripe key, Sol/Astra price IDs and webhook secret in the BFF. Retain exact price/customer/workspace checks and durable reconciliation.
2. Keep login, inference and Gmail behind explicit provider interfaces in Outreachr. Use existing generic registered-app login and app-attributed inference wherever sufficient. No Eliza personal-agent onboarding or subscription requirement may enter the customer flow.
3. Remove the bespoke Outreachr addition from Eliza. The only permissible companion feature, if needed for managed Gmail, is a small generic registered-app delegation contract: app-scoped client authentication, explicit user consent to named connector capabilities, owner-bound connection access, expiry/revocation and replay rejection. Resolve registrations from app records, not OUTREACHR_* environment variables. No prices, plan names, workspace rules, or product-specific code belongs there. Do not represent a simple rename of hardcoded behavior as generic functionality.
4. Keep app-specific implementation and deployment work in Outreachr. Update the two draft PRs or supersede them after the revised boundaries are implemented and tested. No additional Outreachr-specific Cloud route should merge.
5. Configure and deploy the reviewed app revision to Railway and Cloudflare. Verify actual identity, both models, billing test-mode lifecycle and controlled Gmail delivery through the deployed URLs. Source completion and green fixtures do not prove this stage.

## Tests that decide whether it can ship

- Billing works with Eliza billing unavailable. Assert that checkout, portal, reconciliation and webhooks never call Eliza's billing APIs.
- A user with no paid Eliza personal-agent plan can sign in, start the Outreachr trial and buy Outreachr. Cancelling or changing Eliza does not alter Outreachr access; the reverse also holds.
- Wrong merchant/app/workspace/customer/price/portal references fail. Separate app/Eliza subscription events cannot grant access. No personal Eliza subscriptions appear in Outreachr's portal.
- Real Stripe SDK tests plus Stripe test-mode Checkout and portal: correct seat totals, pending payment, renewal, payment failure, cancellation at period end, plan/seat changes, retry recovery, duplicate/reordered webhooks and invalid signatures. The returned browser URL is not proof of payment.
- Real PostgreSQL: one trial per verified identity, expiry boundaries, concurrent invite acceptance/seat capacity, last-owner protection, tenant isolation, durable subscription projections and restart behavior.
- Auth/Google: exact app/redirect binding, code replay, expired/revoked credentials, explicit per-user mailbox selection, rejected cross-user/cross-app access, real consent and the existing approval/send-receipt/duplicate-send invariants.
- Inference: both exact requested models execute using the operator's app credential and the workspace's allowance; an end user's unrelated Eliza balance or plan must not be the payer.
- Final inspection of Eliza's active routes/services/config must show no Outreachr-specific code. Handle any already-applied migration history safely rather than rewriting a deployed schema blindly.
- Browser/mobile, existing desktop regressions, full verification, hosted exact-head checks, production container startup, revision readback and actual provider results remain required.

## Source references

- Stripe Billing for independent subscriptions: https://docs.stripe.com/billing/subscriptions/build-subscriptions
- A SaaS business selling its own subscription does not need Connect: https://docs.stripe.com/connect/saas
- Optional platform-managed merchant subscriptions: https://docs.stripe.com/connect/subscriptions

The normal CLI sign-in reached the final authorization page; creation of its persistent key is still awaiting user confirmation. A Stripe test key and an actual sender postal address remain live test prerequisites. No email or charge has been sent as evidence.
