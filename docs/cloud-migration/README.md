# Product integration ownership

## SDK account-resolution contract

The app vendors Cloud SDK source `d3159a0b1e7bddb90a48b511a700bf656344b67b`
with SHA-256 `e31e49735adf879b39fc8eb5080afbdca37f9ff4316d6a4f1db1f6474893a886`.
The SDK resolves workspaces through `/api/v1/apps/{appId}/billing/accounts/resolve`.
The consumer fixtures use that same route. The previous SDK and fixtures both
used `/billing/accounts`, which is absent from the generic API route tree.

Typed billing and inference helpers reject missing response data. First sign-in
still creates one pending workspace, persists the original trial intent before
dispatch, and grants access only after Cloud confirms the subscription and editing
membership. Retries preserve the workspace, trial history and command identity.

This artifact is a local release candidate. Matching generic API deployment,
registered client credentials and real provider acceptance remain required.

Outreachr product configuration, consumer adapters, business assertions and release
evidence belong in `lalalune/outreachr`. Eliza Cloud owns generic app registration,
identity delegation, connector authorization, app subscriptions, Stripe handling,
allowance accounting and developer infrastructure funding.

| Former Cloud responsibility                                              | Product-owned destination                                                           | Cloud replacement                                                           |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Sol/Astra prices and allowance choices in the named billing service/test | `apps/cloud/src/plans.ts`; consumer catalog acceptance tests during billing cutover | Immutable generic app plan revisions                                        |
| Named app origin and callback assumptions                                | `apps/cloud/src/delegation.ts` and its contract tests                               | Registered app origins and exact delegation-client redirect URIs            |
| Named mailbox scope assumptions                                          | `apps/cloud/src/mailboxes.ts`, `runtime.ts` and delegated Gmail integration test    | Generic app/provider capability intersection and Google proxy authorization |
| Product customer/workspace Stripe metadata                               | Workspace to app-billing-account mapping and durable generic purchaser adapter      | Generic account membership and app/environment isolation                    |
| Product integration and shipping evidence                                | This directory and Outreachr verification report                                    | Generic two-app security and lifecycle tests only                           |

The old named billing test contains provider-level Stripe fixtures. Do not copy
that Stripe SDK implementation or merchant secrets into Outreachr. Its generic
customer isolation, webhook verification, price immutability and subscription
revision checks belong in the Cloud generic suite. Preserve product assertions
about $49 Sol / $200 Astra monthly plans, chosen allowances, seat quantities,
reviewed checkout and fixed product return URLs in the consumer acceptance suite.

The old named delegation tests cover reusable authorization, replay, revocation,
rotation and Google endpoint isolation. Their replacement belongs in Cloud's
generic app suite. Outreachr's adapter tests cover its specific requested
capabilities, verified-email requirement, exact registered callbacks and returned
app/environment binding without implementing a second delegation server.

Applied historical database migrations are provenance, not active product code.
Do not rewrite an applied migration or its checksum. Import or retire old rows
through the platform's append-only generic migration path. Record that transition
here when the platform migration is finalized.

Current receiving checkout: `/tmp/outreachr-generic-consumer-20260905`. The local SDK
tarball dependency is for verification only. Final integration into the Outreachr
release must use the immutable published SDK and finish buyer billing/inference
cutover before the draft PR is marked ready or deployed.

## Received legacy migration input

Source commit: `39dfa7d5783c9759a00f2fb8238e75fd8b526883`. The nine-file archive and
all individual hashes were verified. Archive SHA-256:
`e8b8441c1bb850c2617292b02b6a47aa5d657bf30e5b8e57fc56659a383830e5`.
Temporary source input is retained under ignored `artifacts/cloud-migration/`;
no duplicate Cloud implementation is part of the product release source.

The previous billing assertions translate to these consumer acceptance requirements
when the purchaser routes arrive: selected plan and exact seat quantity appear in
review; a price from a different app is unusable; expired/canceled access is reflected
without inventing seats; transformed or missing quantities cannot grant editing
capacity; a reviewed upgrade preserves the minimum assigned-seat count. Provider
signature verification, Stripe object validation and portal configuration enforcement
remain generic platform responsibilities. The final consumer should only consume
signed app notifications and authoritative app-billing snapshots.

## Product catalog checks and allowance clarification

`apps/cloud/src/billing-catalog.ts` now validates registered catalog authority,
immutable selected revisions, exact product prices and recurring interval, no-card
trial terms, fixed account allowances, read-only expired access, and assigned-seat
minimums. Its 20 tests cover foreign apps/environments/families, changed prices and
allowances, duplicate revisions, malformed responses and invalid seat counts.
This selector is prepared for the forthcoming purchaser review integration; it is
not yet wired into a runnable generic checkout.

The platform confirmed that catalog `allowanceUsd` is a fixed total for each
billing account and period. Outreachr now enforces and displays $15 per Sol
workspace/month or $70 per Astra workspace/month, with $2 per trial. The $49/$200
subscription prices remain per editing seat. Both paid-model PostgreSQL workflows
now buy three seats while preserving one account allowance; all 15 integration
tests passed. Seat changes and proration must not refill the allowance.

## Model result recovery

Cloud's app inference ledger retains accounting receipts rather than model text.
Outreachr now stores the validated completion in PostgreSQL at the same time as
local usage settlement, before emitting proposals. The additive `response_json`
column preserves existing usage rows. Recorded completions are immutable; the
original requesting member can retrieve the result through the authenticated,
non-cacheable organization agent-result endpoint. Recovery never dispatches a new
model operation, and ambiguous requests retain a null response and their pending
reservation. This is product-owned persistence, not a second funding service.

## Delegated inference transport verification

Built a verification SDK package from exact Cloud commit
`87e2cc74bebee6a5ffd97e3b99ee54ba51f7704d`, using `git archive`, its pinned
`build.ts`, and `bun pm pack --ignore-scripts`. Package SHA-256:
`5bfa5b41c581f9a35b10f7d39dc54e797a23310c0a07a628e975e7467226030e`.
The manifest is `/tmp/outreachr-sdk-inference-87e2cc74bebee/manifest.json`.
This temporary package is not a public release dependency.

Outreachr now requests explicit `inference` consent and uses the SDK's root
`AppInferenceClient` export. Requests go to the registered app's inference route
with confidential Basic client authentication, user delegation and a separate
app-scoped developer API key. They carry the persisted operation ID and the Cloud
billing account and product family. There is no general-chat or legacy-markup
fallback.

The additive organization mapping fields must be populated by authoritative
Cloud purchaser account resolution. Outreachr never equates its workspace UUID
with a Cloud billing-account UUID. Missing mappings or a different app/environment
stop the operation before catalog lookup, reservation or provider dispatch.
Fixtures seed explicit independent account IDs only in disposable databases.

Verification passed: 46 cloud unit tests, 16 PostgreSQL integration tests and full
browser E2E using controlled providers. Tests verify both exact model plans,
separate credentials, operation identity, app route, account scope, no automatic
retry, durable results, and viewer isolation. Actual Cloud purchaser-account
resolution, authoritative billing/usage projections and production checks remain
required before release.

## Authoritative workspace account resolution

`CloudBillingAccounts` now resolves a workspace through the packaged Cloud SDK.
The authenticated `POST /api/organizations/:orgId/billing/account` route accepts
an empty body and requires the current workspace owner. It derives the external
reference from the authorized workspace, never browser-supplied identifiers.
The returned app ID, external reference and administrator role must match before
Outreachr stores the mapping. Existing account, app, environment and family
bindings cannot be silently replaced. Concurrent requests are serialized and
lost responses retry the same external reference. No trial or subscription is
started by this operation, and existing trial dates remain unchanged.

The deployment now requires `ELIZA_PRODUCT_FAMILY_KEY` matching the registered
Cloud offer family. Team membership synchronization and preservation of migrated
trial claims still require the platform's completed purchaser contract before
this route can be used as part of a finished subscription flow.

Also fixed Settings loading so optional Google account setup errors do not hide
successfully loaded member or billing data. The browser regression simulates the
free-account setup error, verifies owner and review controls remain visible, then
reconnects and completes the ordinary mailbox, export and viewer workflow.

## Scoped billing status reads

The authenticated `GET /api/organizations/:orgId/billing/snapshot` endpoint now
reads through the generic Cloud SDK using the current member's delegation. It
requires the persisted workspace/account/app/environment/family binding and
checks all returned scopes, including nested subscriptions and pending commands.
It validates revisions, period ordering, exact allowance decimal strings and
Stripe action destinations. Responses older than five minutes or more than one
minute ahead of the app clock fail; an entitlement that expires in transit loses
editing access immediately. Deployments must keep their clocks synchronized.

The response contains a validated `snapshot` and an effective `access` value.
Consumers must use `access` for the deadline check and must refresh before billing
mutations. This read does not create trials, replace account bindings, mutate the
legacy entitlement projection, or authorize model dispatch by itself. Provider
failure and authoritative absence never fall back to a local trial grant.

Verification: 60 Cloud unit tests and all 18 PostgreSQL integration tests passed,
including the authenticated, non-cacheable HTTP route, missing mappings, tenant
isolation, removed membership, Cloud outages and preservation of original trial
dates. Cloud type checking and focused lint passed. The new endpoint is ready for
the remaining purchaser UI and authoritative access cutover.

Purchaser commands were reviewed at Cloud commit `6e612092f225d`. One remaining
contract dependency was historical subscription plan identity. This is now
resolved in the next SDK artifact below: subscriptions expose their persisted
`planKey`, independently of currently published offers.

## Signed notifications and confirmed access

The consumer now uses verification SDK source
`40c53566e257999a7d085c3deebf314d11beaa5b`. Tarball SHA-256:
`6d3eba465c3bd8b05899099c2732c602d3c134985f6606d8aa121b547febbb4f`.
The artifact and manifest live under `/tmp/eliza-billing-review-20260905/`.
This remains a temporary verification dependency, not a published release.

`POST /api/billing/notifications` replaces the old HTTP Stripe-forwarding webhook.
The edge preserves exact signed bytes and Cloud signature headers. The BFF uses
the SDK verifier with the configured key ID, app and environment, then checks
delivery and event headers and product family. Notification receipts and access
invalidation commit together in PostgreSQL. Duplicate delivery is acknowledged;
the same delivery ID with changed content is rejected. A delayed event can only
invalidate the current projection, never replace it with an old subscription.

The server secret `ELIZA_BILLING_NOTIFICATION_KEYS` is a JSON object mapping Cloud
notification key UUIDs to signing secrets. Install a pending key before activating
it in Cloud and retain the previous key while deliveries remain in flight. A
production BFF cannot start without a configured key. No Stripe signing material
belongs in this app.

Mapped accounts require a recent confirmed Cloud projection. Missing, invalidated
or expired authority cannot fall back to the old local trial. The snapshot read
persists current subscription identity, historical product plan, status and seat
capacity without resetting stored trial dates. Ordinary authenticated requests
refresh invalidated projections, or projections older than one minute. A failed
refresh preserves read/export access while denying editing. Five minutes is the
maximum confirmation lifetime, further bounded by the entitlement deadline.
The UI also refreshes the account on window focus after billing navigation.

The old purchaser adapter remains in `billing.ts`/`eliza.ts` for the incomplete
checkout migration; it is not used by the new notification or refresh routes.
Its remaining product-specific Cloud path must be removed before release.
Purchaser-authorized owner transfers, original trial import, complete checkout
and usage-authority integration, a normal SDK release, and live deployment/provider
acceptance still remain. Ordinary member synchronization is implemented below.

## Durable membership and seat synchronization

The current verification SDK is built from
`b43d632fa7d6324a4dfd8000e876f2dce94c6092`, SHA-256
`1430fbacf8c4c57724038dcd5d6e6edaa6d2f3f95f886e30ad758b5940aab13d`.
Every billing request carries its registered client selection. The Cloud server
resolves the stored app/environment; the selection does not grant purchaser
authority. This fixes the hosted test-catalog/live-snapshot mismatch discovered
during consumer review. The package remains local verification input only.

Accepted invitations and role changes now enqueue a durable membership intent in
the same PostgreSQL transaction as the product change. Pending members can read
but cannot edit or exercise admin controls. Removals revoke local access
immediately. The backend mirrors accepted Cloud identity IDs and editing-seat
requirements through `listMembers` and `synchronizeMember`, using confidential
app credentials without borrowing the owner's delegation. Viewers consume no
editing seat. Merely creating an invitation enqueues no activation.

The exact request body and operation ID commit before dispatch. Lost responses
recover the original receipt even after later membership revisions. Local
confirmation is conditional on the job still being the member's current desired
change, so an older activation cannot resurrect a removed member. Only an
undispatched obsolete intent can be skipped. A Cloud confirmation invalidates the
workspace billing projection so the next authenticated read verifies capacity.

The server drains pending work every 15 seconds, in serialized, bounded batches
per workspace. A restarted process can recover from the durable queue. Client
registration and account/environment bindings are retained with prepared work;
drain those jobs before replacing a registered client. The UI shows pending
access and refreshes while synchronization is outstanding. Retrying an accepted
invitation as the same verified account returns the existing membership and never
creates another seat or restores removed membership.

Cloud commit `61791aebc297a` supplies the distinct HTTP 409 code
`APP_BILLING_MEMBERSHIP_REVISION_CONFLICT`, validated through its actual SDK,
HTTP handler and PostgreSQL transaction. Only that code permits the consumer to
read the current revision and persist an updated body under the original
operation ID. Undifferentiated 409s, authorization failures, timeouts and invalid
responses retain the exact original request. The server checks prior receipts
before issuing the distinct code. API type checking and Worker dry-run validation
were confirmed by the platform task at `4bf1fb671a504`.

Backend synchronization cannot change billing administrators. Bound workspace
owner promotion and transfer use the separate purchaser-authorized Cloud
administrator API. The last owner stays protected; ordinary backend membership
synchronization never grants purchaser authority.

## Generic purchaser review and recovery

The consumer now uses the SDK artifact from exact Cloud source
`5ecc066ca12228510a6bb7dc5884ee47ab73ed5c`, SHA-256
`f001ddcecde0ecd5076337e012f795c0243a30e1b1ee277fafc12958efbc6d7b`.
The artifact is temporary validation input; an immutable published dependency is
still required before release.

`billing.ts` no longer calls an Outreachr-specific Cloud endpoint or parses raw
Stripe subscription/customer responses. The obsolete named HTTP adapter and
webhook implementation were removed. Generic signed notifications and confirmed
snapshots remain the only source of subscription access.

Purchaser reviews validate the exact catalog price, app/environment/account,
plan revision, editing-seat minimum and recurring total. Updates obtain an
immutable Cloud quote and display the amount due now, next invoice and preserved
trial end. No purchase is dispatched while reviewing. Confirmation persists the
original actor, registration, exact command, terms and consent timestamp to
PostgreSQL before dispatch. A lost response or ambiguous HTTP conflict retains
that request. Concurrent retries and process restarts recover the original
operation; they cannot submit a second purchase or silently refresh its quote.

Cloud checkout, payment authentication and portal URLs are separately restricted
to their expected HTTPS Stripe hosts. Pending invoice authentication is polled
using the same operation ID; link expiry alone does not authorize another
update. A confirmed terminal failure permits a new snapshot, quote and consent.
Cloud commit `c26d873a3c7fd` supplies
`APP_BILLING_COMMAND_NOT_APPLIED` only after preparation rolls back before
provider dispatch. The consumer releases an intent only for that HTTP 409 code
and only before it has recorded a remote operation ID. All other conflicts
retain the original command. A replacement requires fresh review and consent.

Open-checkout cancellation and recovery of operations started in Cloud are now
integrated and tested. Trial provisioning and any required legacy
trial/subscription authority migration remain separate release work. Owner transfer is integrated through the separate
purchaser-authorized platform capability; its browser recovery flow now passes. Ordinary backend membership sync
cannot confer billing administrator authority.

## Authoritative allowance reporting

The usage endpoint reads Cloud's current scoped snapshot and reports its exact
allowance, settled usage, reservations and remaining balance. It does not present
rounded local token estimates as billed usage. Read-only or expired periods
cannot restore available funds; inconsistent or unrepresentable balances fail
visibly. The workspace allowance remains independent of purchased seat count.

Cloud-bound inference retains local operation IDs and responses for recovery,
but Cloud's inference boundary atomically enforces buyer allowance and operator
funding. Outreachr no longer imposes a second estimated local balance on those
requests. Unbound legacy workspaces retain their existing local guard during
migration. Production testing must still prove operator-funded inference and
allowance exhaustion against the actual Cloud deployment.

## Open checkout cancellation and external operations

A current, scoped Cloud snapshot can introduce an operation that was started
outside Outreachr. The consumer persists its operation ID as an external intent
with no fabricated purchase body or consent. Recovery only reads that operation,
including retryable failures; it cannot construct and submit a replacement.

An owner can explicitly cancel an open checkout. Outreachr refreshes the original
operation, accepts only the checkout action kind, and commits the exact expiry
request plus an append-only user audit entry before dispatch. Response loss,
process restart and competing requests replay the same expiry intent. While
cancellation is unresolved, the UI hides the old checkout link. Confirmed expiry
is followed by a fresh read of the original operation to handle concurrent
payment completion. An invoice payment action is never expired as checkout.
Only the distinct confirmed-unexecuted rejection permits another explicit
cancellation request with a fresh revision.

Verification: 45 PostgreSQL integration tests passed; all 17 purchaser tests
passed again after adding atomic cancellation audit persistence. The complete
browser workflow passed with external checkout adoption, cancellation response
loss, reload, recovery and exactly one expiry. Type/lint/build checks passed.
The 67 unchanged unit tests were last verified in the preceding allowance batch.

A read-only check of the prepared production Outreachr schema on 2026-09-05 found
zero users, workspaces, trials, subscriptions and pending checkouts. There are no
existing rows in that schema requiring trial import before the first release.
This does not authorize adopting personal Eliza subscription records or resetting
future migrated trial history. New Cloud-backed signup provisioning is required.

## Current ownership verification

The verified SDK 5ecc consumer supports grant, revoke and transfer through the
purchaser-authorized administrator API. Saved commands survive response loss;
canonical current reads determine local roles. Member-list reads remain available
during ownership-provider failure, with authority marked unconfirmed and
conflicting controls disabled. Privileged reads and all mutations still require
current Cloud authority.

The final local ownership batch passed 67 unit tests, 57 real PostgreSQL tests,
and the complete browser flow (48.8 seconds). Recovery applied exactly one
transfer, preserved the trial end and both editing seats, and enabled purchaser
controls only for the new confirmed owner. These are local provider-fixture
results. Production deployment and real Stripe/inference/Gmail acceptance are
still required.
