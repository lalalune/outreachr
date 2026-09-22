# SaaS completion implementation and acceptance plan

Source baseline: `23b7dcc5f731e3abc47c66dd6c09e69df4427d99`.
The September 22 product review is the acceptance inventory. Implementation stays in Outreachr; Eliza Cloud supplies generic identity, billing and provider services.

## Work packages, in dependency order

1. **Customer trust and entry:** hosted storage disclosures and file inventory/lifecycle; invite-first onboarding; explicit hosted product definition; support and accurate research/introduction descriptions. Verify tenant/role boundaries and browser journeys.
2. **Complete conversations:** threaded approved follow-ups/replies, durable calendar operations, mailbox freshness and reconnect/reconciliation. Verify lost responses, suppression, wrong mailbox and process restart with controlled provider fixtures before real recipients.
3. **Data ownership:** complete encrypted cloud archive/restore; leave, archive and deletion lifecycle tied to billing state; retention and cleanup. Verify archive contents, corrupt input, isolation and restoration without resurrecting credentials or authority.
4. **Reliability:** bounded workspace contention, durable/recoverable AI results, resource controls, correlation IDs, operational metrics, diagnostics and runbooks. Verify concurrency, slow providers, cancellation and recovery.
5. **Product completion:** activation queue, lifecycle notices, data freshness/correction, privacy-preserving funnel and accessibility/mobile browser journeys. Keep later demand-led features explicitly scoped rather than representing them as delivered.
6. **Dependencies and integrated verification:** resolve overlapping update PRs, audit, full repository gate, desktop regression and independent cloud browser journeys; retain failures with causes and rechecks.
7. **Deployment and service acceptance:** verify registration under the user-designated operator, deploy tested revision, sandbox full Cloud/Stripe lifecycle, real Google consent, exact models, controlled mail send/reply, restore and rollback drill. Record actual results separately from fixture proof.

## Release conditions

- Every P0 finding resolved or the unsupported promise explicitly removed.
- Every P1 has implementation/tests or a concrete external dependency, with no unsupported completion claim.
- Cloud billing remains app/environment/workspace scoped; no parallel Stripe integration.
- Sending remains human approved, content bound, suppressed where required and safe against duplicate requests.
- Deployment and live acceptance cannot be inferred from local tests, manifests or green CI.
- Real outbound mail requires the real sender postal address. A fixture address is never used live.

## Evidence log

Implementation in progress. Completed first slice:

- Invite-first sign-in creates no unrelated workspace, preserves trial eligibility and selects the accepted workspace.
- Hosted Documents discloses uploads and workspace visibility, preserves filenames, displays quota, and removes files/references with confirmation.
- Unlinked uploads expire after 24 hours; periodic cleanup removes expired files, login states and sessions. Editing roles can remove stored files after subscription expiry.
- API request limits cover streamed bodies; diagnostics include generated request identifiers and redacted route/status/timing.
- Cloud and desktop type checks passed; 78 Cloud PostgreSQL integration tests passed; expanded Chromium journey passed on its first run (30.6 seconds), covering file upload/reload/removal and invitation landing.
- Remaining work packages and external service acceptance are still open.

Second slice:

- Reviewed Gmail replies and follow-ups bind the original mailbox, recipient, thread, subject and RFC Message-ID into approval. Duplicate parent sends, unrelated threads and a second initial contact are rejected. Existing approvals are revoked by the schema upgrade.
- Calendar creation persists its operation before provider dispatch and reconciles uncertain results after restart without another create request.
- Workspace admission bounds same-workspace waiting outside the PostgreSQL pool; concurrent workers reject contention without holding provider calls in a database transaction.
- Connector integration: 22 tests passed, including threaded sends and restart recovery. Cloud integration: 78 passed, including bounded contention and retried writes.
