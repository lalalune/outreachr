# Trial provisioning and ownership cutover

## Current release checkpoint: Cloud trial provisioning and portable SDK

PR #41 is merged at `c23bbcbb6f3717e764efd7ebf5a4c224badbe53c` after all required
hosted checks passed on head `76acba09b32ec44d94869eaf704617d48ab2457f`.
The consumer includes that main-branch performance fix.

First Cloud sign-in creates one pending default workspace without local access,
resolves its stable billing account, and persists the exact no-card trial command
before dispatch. Lost responses retain the original command and idempotency key.
A successful operation alone grants no access: a fresh Cloud subscription and
confirmed editing membership are required. Trial dates and the fixed allowance
come from Cloud. Additional workspaces do not start trials automatically, and
legacy unbound workspaces require reconciliation without resetting their dates.
An unpaid owner can review the first paid subscription without already owning an
editing seat. Explicit setup retry cannot restart a claimed or migrated trial.

Validation before the SDK replacement: 67 unit tests, 67 PostgreSQL integration
tests and the full browser flow passed. The browser begins unbound, injects a
lost trial response, recovers the exact command, checks canonical dates and
continues through CRM, model and Gmail fixtures, purchaser and ownership
recovery, read/export and mobile accessibility. This is local fixture evidence;
real provider acceptance remains outstanding.

The dependency now vendors the immutable SDK release candidate from source
`61bd46408cdec1c338f6b5cabe8f071258c1a5de`, SHA-256
`aadced56e98d108969c183fa7f808e2afe434d8151a623ca8edce7be75f4708b`,
with a repository-relative dependency and manifest. This replaces earlier notes
requiring an npm publication or a machine-local package path. Matching generic
API/schema deployment and registered app credentials still require verification.
The packaged SDK passed a clean frozen install, shared-package build, Cloud type
check, web production build, 67 unit and 67 PostgreSQL integration tests, and the
complete browser flow (24.0 seconds). Production-mode server startup, repeated
schema migration, health revision and private proxy checks passed from the clean
source snapshot. Worker deployment dry-run passed. The final package adds the MIT
license and source metadata; every runtime, declaration and documentation byte
matches the tested package. Docker itself remains a hosted CI check because the
local Docker daemon is unavailable.

The prepared production Outreachr schema was read on 2026-09-05 and contains no
users, workspaces, trials, subscriptions or pending checkouts. First release
therefore needs correct new-account provisioning; no live Outreachr rows need
an import. Existing Eliza personal subscriptions must stay separate.

## New account provisioning

1. Create the product user/default workspace once under the existing user lock.
   In Cloud mode, mark billing provisioning pending and grant no local trial.
   Additional workspaces do not claim another free trial.
2. Resolve the external workspace reference through the delegated Cloud billing
   account API. Persist its app/account/environment/family binding before the
   next step; use the existing durable membership queue for accepted members.
3. Read the canonical snapshot and exact Sol catalog revision. Persist the free
   trial command and stable idempotency key before dispatch. Continue the same
   command after timeout or restart; do not regenerate dates, keys or bodies.
4. Confirm access and allowance only from Cloud. Persist canonical trial start
   and end as the original product timestamps. Cloud owns eligibility across
   workspaces and the fixed $2 trial allowance. A completed operation alone does
   not grant editing; the authoritative snapshot and synchronized seat do.
5. Resume pending provisioning on authenticated app entry without retaining an
   unrevocable buyer credential. Expose pending/recoverable failure clearly and
   preserve read/export during provider failure. Never fall back to a local
   trial when Cloud is unavailable.

Legacy imports must use the generic operator-owned reviewed manifest. Preserve
source principal, provider identifiers, original seven-day bounds and consumed
or reserved allowance. Freeze changes to a source before hashing its import
manifest. Reject mismatched binding or trial history; do not silently adopt a
personal Eliza subscription or restart a trial. The generic importer currently
uses a canonical scope ID, so any import manifest requires verified platform
scope resolution rather than guessing it from a public account ID.

Test simultaneous first logins, response loss at each boundary, restart, repeat
entry, second workspace, existing/ineligible trial, stale quote/revision,
registration mismatch, Cloud outage, expired trial and allowance exhaustion.
Live acceptance still requires the published/deployed Cloud API and registered
Outreachr credentials.

## Ownership

Cloud SDK source 5ecc066ca12228510a6bb7dc5884ee47ab73ed5c supplies purchaser
administrator read/change methods. Artifact SHA-256 is
f001ddcecde0ecd5076337e012f795c0243a30e1b1ee277fafc12958efbc6d7b; received and
independently hash-verified and installed in the consumer. The dependency is still a
local verification tarball; replace it with a published immutable package before
merging or deployment.

Map Cloud administrators to product owners among accepted product members.
Ordinary product admins remain ordinary Cloud billing members. Multiple owners
are supported by the existing product policy. Backend member synchronization
must never confer purchaser authority.

Persist ownership commands before dispatch. Only the original actor/client may
replay an ambiguous exact command. Transfer grants an already active accepted
member and demotes the original actor while preserving seats, subscription and
trial principal. A current active member can read canonical administrators with
billing:read, even after demotion. Revoked membership or delegation cannot read
or recover. Use a current scoped administrator snapshot to reconcile product
ownership after an external transfer or a lost response, with shared membership
revision protection. Do not project ownership from a stale or foreign response.

Protect pending owner intents against conflicting local membership changes,
keep last-owner protection, and prevent an ownership change from stranding a
pending purchaser command that still needs its original actor. Test concurrent
role/seat changes, demotion response loss, exact replay, stale revision, revoked
grant/member, wrong actor/client, external transfer and last-administrator denial.

## Ownership consumer implementation checkpoint

`CloudOwnership` now stores the original actor, registration, exact command and
revision before dispatch. It reconciles roles only from a fresh administrator
read, not the mutation receipt. Ambiguous requests remain recoverable, including
a transfer whose original actor is now an ordinary active member. A later
canonical revision fences an unexecuted old compare-and-swap body; changed
registration or revoked grants cannot replay it.

Settings supports granting, revoking and transferring ownership among accepted
editing members. Pending state disables conflicting billing and membership
changes. Ownership projection enqueues seat synchronization and does not purchase
additional seats. Backend membership receipts confirm membership and seats only;
they cannot promote a product member to owner.

All 57 PostgreSQL integration tests and 67 unit tests passed. The complete
browser flow passed in 48.8 seconds, including a lost transfer response, a
temporary ownership-read outage, original-actor recovery, the current new owner,
exactly one transfer, retained seats and the original trial end. These tests use
explicit local provider fixtures and do not establish production Stripe or
Cloud acceptance.

The generic `startTrial(accountId, family, request)` SDK method accepts the
published `planRevisionId`, `quantity`, `idempotencyKey` and canonical
`expectedSubscriptionRevision`. It does not require a payment method or billing
consent. Resolve the account through the purchaser delegation and persist its
binding first. Exact retries and fresh canonical snapshots are required; the
operation receipt alone is not entitlement. The Cloud API remains responsible
for preventing repeated trials across recreated workspaces and billing accounts.
