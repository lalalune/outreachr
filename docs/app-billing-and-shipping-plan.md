# App subscriptions on Eliza Cloud: Outreachr shipping plan

Decision updated 2026-09-05 after clarifying the platform boundary. This supersedes the product-specific Cloud API design in `cloud-implementation-plan.md` and the earlier proposal to move Stripe into Outreachr.

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

## Source findings and implementation scope

The generic `app-auth/connect` and `app-auth/session` routes already support registered-app identity without a personal-agent subscription check. Existing app charge requests create one-time Stripe payments for credits; those payments do not implement recurring SaaS app subscriptions. The Cloud billing task is implementing the generic recurring subscription and delegation contracts.

Outreachr's existing `apps/cloud/src/billing.ts` persists checkout attempts and reconciles paid state under PostgreSQL locks. Adapt it to Cloud's generic subscription authority, retaining timeout recovery, tenant checks, and fail-closed reconciliation. Remove old product-specific paths, client headers, and token assumptions from `apps/cloud/src/eliza.ts`. Keep provider credentials out of browser bundles and store delegated grants encrypted at rest.

The already-merged product-specific Cloud bridge is temporary and must be replaced. Coordinate consumer adoption before removing its routes. The final Cloud source must contain no Outreachr-specific implementation, price names, environment bindings, or runtime schema dependencies. Handle applied database migration history safely; never rewrite a deployed migration without checking its state.

## Implementation and release sequence

1. Freeze the two draft Google onboarding PRs while the Cloud task settles the typed generic contract. Remove the unmerged direct-Stripe edits from Outreachr.
2. Adopt app registration, scoped credentials, delegation, Google operations, and subscription APIs in Outreachr. Declare the app's plans using Cloud's built-in provisioning path. Verify which credential pays for inference.
3. Update local billing projections and trial migration to match the authoritative contract. Preserve existing data, trial timestamps, in-flight checkout recovery, and duplicate-send protection.
4. Exercise the consumer against the real generic handlers as well as controlled failure fixtures. Confirm that a second app and a personal Eliza subscription cannot affect Outreachr entitlements.
5. Complete repository verification and terminal hosted checks for the final commit, merge reviewed changes, then deploy through the existing Cloud and app release gates.
6. Verify the deployed app using actual login, managed Google consent, both models, Stripe test-mode lifecycle, and a controlled approved email. A healthy container or mocked browser test is only intermediate evidence.

## Acceptance tests

- Independent subscription scopes: a customer with no paid Eliza personal-agent plan can sign in, start an Outreachr trial, and purchase Outreachr. Personal Eliza plan changes do not alter Outreachr access. Another registered app's customer, checkout, portal, price, event, or entitlement cannot cross scopes.
- Cloud-managed billing: Outreachr sends requests only to the generic authenticated Cloud API. It never receives Stripe secret keys. Provider failures cannot create paid access or duplicate subscriptions. Display a recoverable billing error when Cloud cannot verify payment.
- Subscription lifecycle: exact plan/seat totals, payment pending, renewal, payment failure, cancellation, period boundaries, plan and seat changes, timeout recovery, duplicate and reordered notifications. Reconcile current authoritative state instead of trusting browser redirects or old events.
- Trial and tenancy: preserve exact migrated trial dates; reject repeat trials; isolate workspaces; serialize invitation acceptance and seat changes; protect the last owner; retain durable state across restarts.
- Delegation and Google: app and redirect binding, code replay rejection, expiry/revocation, explicit capabilities, mailbox ownership, cross-app denial, actual consent, exact-content approval, send receipt, and duplicate-send rejection.
- Inference: execute both exact plan models with the operator's app credential; meter the workspace allowance and hold ambiguous reservations. The end user's personal plan or credit balance is not the payer.
- Delivery: desktop regressions, full HTTP/browser/mobile flow, actual Linux container startup with least-privilege PostgreSQL, final revision readback, and confirmed provider results.

## Current live prerequisites

App registration and inference credentials have not been provisioned. The normal CLI login reached its authorization screen, but creation of its persistent key still awaits confirmation. Cloud Stripe test-mode access and a real sender postal address remain prerequisites for the final billing and email exercises. No live charge or email has been made as test evidence.

## Generic delegation consumer verification, September 5

An isolated consumer checkout now integrates the built generic Cloud SDK from
source commit `d01cbcd49c0b2`. Artifact SHA-256:
`960c10f3d76ff9a76bc2cd36ab173602ab0eabcaecc1f2391ba5c3b285387785`.
The SDK is temporarily installed from a local tarball for verification only.
Replace that dependency with an immutable released package before committing or deploying.

Implemented consumer behavior:

- Explicit app consent and registered auth and Google callback URIs.
- Confidential Basic client authentication with server-only `X-App-Delegation` grants.
- Verification of app ID, registration-pinned test/live environment, credential expiry,
  identity capability and verified email. Free users need no Cloud organization for login.
- Managed Google connection capabilities drive local connector permissions; no raw
  provider scopes or credentials are assumed. Cloud checks every proxied operation.
- Provider responses preserve receipts and pagination; ambiguous sends are not retried.

Verification passed: 14 packaged-SDK contract tests through actual local HTTP,
24 total cloud unit tests, 15 PostgreSQL integration tests and the complete browser
fixture flow. The browser flow includes login, CRM and draft persistence, proposal
review, Google connection and mailbox selection, export, and invited viewer isolation.
Type checking and focused lint passed. These are controlled provider fixtures, not
production or real email/payment acceptance.

This is an intermediate migration. Generic delegated inference, signed Cloud
notifications and authoritative snapshot refresh are now integrated. The
purchaser adapter now uses the generic SDK with persisted review, explicit consent, and recovery of the original command. The old named billing endpoint is removed.
Durable ordinary membership and seat activation are now integrated; owner
transfers and original trial import remain incomplete. Authoritative usage
reporting and Cloud allowance enforcement are now integrated locally. Existing trial deadlines and the explicit
Review subscription flow must remain intact. No production deployment or release
claim is valid until those pieces, immutable SDK packaging, hosted checks and live
acceptance are complete.

Cloud catalog allowance is fixed per billing account and period. Editing seat quantity affects recurring price and capacity only; proration and seat changes do not refill or multiply the allowance.
