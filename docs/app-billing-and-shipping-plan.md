# App subscriptions on Eliza Cloud: Outreachr shipping plan

Decision and implementation status updated 2026-09-06. This supersedes the product-specific Cloud API design in `cloud-implementation-plan.md` and the earlier proposal to move Stripe into Outreachr.

## Commercial boundaries

| Relationship                             | Payer                          | Authority                                                                                          |
| ---------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------- |
| Outreachr subscription                   | Outreachr workspace owner      | Cloud app subscription scoped to Outreachr and its workspace; Outreachr enforces its product rules |
| Eliza Cloud infrastructure and inference | App developer/operator         | Cloud usage ledger attributed to the registered app and billed to its operator                     |
| Eliza personal app/agent subscription    | Customer choosing that product | Separate personal-agent subscription and entitlements                                              |

All three can use the same Cloud identity and Stripe infrastructure. They must retain separate subscriptions and billing scopes. Paying for the Eliza personal app must not unlock Outreachr; cancelling it must not cancel Outreachr. Outreachr customers must not buy personal Cloud credits to use AI included in their app plan.

## Platform and app responsibilities

Eliza Cloud owns the generic app registry, app credentials, declared subscription plans, Stripe products/prices, checkout, billing portals, subscription lifecycle, verified webhook processing, and authoritative app subscription state. These capabilities are available to registered applications. Resolve scope from authenticated app registration, not a product name or an `OUTREACHR_*` environment variable.

Outreachr declares its plans and trial configuration through that contract, requests checkout for its own workspace, and reads the resulting entitlement. Its backend owns product memberships, invitations, data, and a local projection of Cloud subscription state. Cloud owns paid seat authority and allowance accounting. It must not contain a parallel Stripe integration, Stripe secrets, or direct Stripe webhook verification. The existing Cloud app monetization approval rules still apply; registration must not silently bypass them.

Use the built-in Cloud Stripe infrastructure for launch. A separate Stripe account, bring-your-own Stripe integration, or new Stripe Connect setup is not a prerequisite in this plan. Broader merchant settlement policy belongs to the generic platform billing task.

Managed Google access also uses a generic registered-app delegation. The signed-in person explicitly authorizes connector capabilities; Cloud retains and refreshes provider credentials. App registration and a login code alone must not grant mailbox access. Never use the operator's inference API key as the end user's Google authority.

## Outreachr product configuration

- Sol: $49 per editing seat/month, `openai/gpt-5.6-sol`.
- Astra: $200 per editing seat/month, `openai/gpt-6-astra`.
- Seven-day no-card trial once per verified identity, applied to the default workspace. Preserve existing trial start and end dates when adopting Cloud authority; migration must not restart the clock.
- Owner, admin, and member consume editing seats. Viewers are free. Invitations do not purchase seats; owners explicitly approve purchases.
- Preserve read/export access after expiry. Enforce seat capacity and the selected model on the server.
- Current bounded AI allowance: $2 during trial, $15 per Sol workspace/month, $70 per Astra workspace/month, shared by its members with no automatic overage. These are app allowance settings, not representations of the operator's final Cloud invoice.

## Implemented consumer boundary

Outreachr uses the generic Cloud SDK for registered-app identity, delegated Google operations, app-scoped inference, and recurring subscriptions. It has no direct Stripe integration. Billing account resolution uses the generic `/billing/accounts/resolve` route.

The consumer persists reviews and exact command bodies before submission, requires explicit purchase consent, and recovers the original command after an ambiguous response. Checkout setup alone does not grant paid access. A subsequent payment action remains visible until Cloud confirms the command, and workspace access follows the current authoritative snapshot. Open checkout cancellation also persists and recovers its original command.

Cloud-signed notifications invalidate the local projection; they do not grant access. Trial adoption retains existing deadlines. Membership and owner changes synchronize with Cloud authority, and paid seat changes do not refill or multiply the workspace allowance. See [trial and ownership cutover](cloud-migration/trial-and-ownership-cutover.md) for migration requirements.

The vendored SDK is pinned to a source commit with a SHA-256 manifest in `vendor/`. That establishes artifact provenance, not availability of those APIs in production. The generic Cloud integration must complete its own migration, verification and deployment gates before the app can use it live. Historical product-specific migrations remain migration history; the final Cloud runtime must not depend on Outreachr-specific code.

## Remaining release sequence

1. Complete the generic Cloud subscription and delegation integration, including lifecycle validation and its deployment gates. Confirm the deployed contract against the pinned consumer SDK.
2. Resolve the operator account and app owner organization. Register the app and separate test/live confidential delegation clients using [the registration manifest](../apps/cloud/registration.manifest.json). Store issued credentials and notification keys in deployment secret stores. A locally generated secret is not a registered client credential.
3. Provision the declared Sol and Astra plans through Cloud's generic billing setup, and configure a funded app-owned inference credential. Cloud owns the Stripe catalog and provider events.
4. Apply the app schema and runtime-role permissions, deploy the verified BFF revision to Railway, and deploy the matching frontend and API proxy to Cloudflare. Follow [the deployment instructions](../apps/cloud/README.md#deployment).
5. Exercise actual login, managed Google consent, both exact models, workspace isolation, and the Stripe test-mode lifecycle through the deployed app. Verify revision readback and provider outcomes. Complete the controlled email test once the sender postal address is supplied.

## Acceptance tests

- Independent subscription scopes: a customer with no paid Eliza personal-agent plan can sign in, start an Outreachr trial, and purchase Outreachr. Personal Eliza plan changes do not alter Outreachr access. Another registered app's customer, checkout, portal, price, event, or entitlement cannot cross scopes.
- Cloud-managed billing: Outreachr sends requests only to the generic authenticated Cloud API. It never receives Stripe secret keys. Provider failures cannot create paid access or duplicate subscriptions. Display a recoverable billing error when Cloud cannot verify payment.
- Subscription lifecycle: exact plan/seat totals, payment pending, renewal, payment failure, cancellation, period boundaries, plan and seat changes, timeout recovery, duplicate and reordered notifications. Reconcile current authoritative state instead of trusting browser redirects or old events.
- Trial and tenancy: preserve exact migrated trial dates; reject repeat trials; isolate workspaces; serialize invitation acceptance and seat changes; protect the last owner; retain durable state across restarts.
- Delegation and Google: app and redirect binding, code replay rejection, expiry/revocation, explicit capabilities, mailbox ownership, cross-app denial, actual consent, exact-content approval, send receipt, and duplicate-send rejection.
- Inference: execute both exact plan models with the operator's app credential; meter the workspace allowance and hold ambiguous reservations. The end user's personal plan or credit balance is not the payer.
- Delivery: desktop regressions, full HTTP/browser/mobile flow, actual Linux container startup with least-privilege PostgreSQL, final revision readback, and confirmed provider results.

## Current verification and live prerequisites

The September 6 consumer validation passed 76 PostgreSQL integration tests, 67 unit tests, the complete browser fixture flow, type checking, the web build, lint, and the Worker deployment dry run. Direct computer-use checks additionally exercised trial recovery, subscription review, lost checkout response recovery, the setup-to-payment transition, and checkout cancellation recovery. These use local provider fixtures. See [the validation record](cloud-validation.md) for the evidence boundaries.

Actual app registration, issued delegation credentials, notification keys and a funded inference credential remain outstanding. Railway CLI sign-in is confirmed, but the Outreachr service has no deployment. The Cloud dashboard restored an account different from the attempted sign-in account; ownership must be resolved before registration. A later browser readback reached a Cloud session gate whose offered reopen link returned the same gate; no current operator dashboard was recovered. The generic Cloud API integration is still undergoing central validation and is not asserted deployed here.

A prior generic Cloud Stripe sandbox exercise confirmed one paid fixture invoice. It does not establish the deployed Outreachr plans, renewal, seat changes, refunds or cancellation. Those lifecycle outcomes still require acceptance against the final integrated Cloud revision. No live Outreachr email has been sent; the sender postal address remains required.
