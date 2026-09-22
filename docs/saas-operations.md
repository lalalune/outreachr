# Hosted operations and acceptance

The app uses generic Eliza Cloud identity, app billing, inference and Google delegation. Do not add Outreachr logic to Eliza or configure a separate Stripe account in this repository.

## Support evidence

An owner/admin can download Settings → Help and diagnostics. It includes revision, workspace ID, plan/status, billing observation time, pending billing/membership counts, unresolved AI costs, stale mailbox counts, and action-name counts over 30 days. It excludes message/document/prompt content, credentials, recipient addresses and payment details. Review the file before sharing. API errors carry generated request IDs for correlation with route/status/duration logs. Public bug reports must contain nonsensitive reproduction steps only.

Operational action records also provide the product funnel without a separate third-party tracking SDK: workspace.created, command.onboarding.complete, target/draft commands, command.draft.send, command.mail.review and billing receipts. Counts indicate actions, not customer outcomes or investor interest. Validate activation and repeat use with pilot interviews before setting growth targets.

## Incident procedures

- **Login/provider outage:** authorization fails closed. Preserve the browser's draft content, reconnect/sign in, then reload. Never replace a real user with a local fixture or grant access from a stale personal Eliza entitlement.
- **Pending billing:** inspect the saved operation and refresh/recover its receipt. Do not submit a new checkout or change its idempotency payload. Signed notifications invalidate the projection; authoritative Cloud snapshots establish current access.
- **Unconfirmed send:** keep its ledger reservation. Sync the same mailbox and inspect the provider operation marker. An absent response is not proof that mail was not sent; never reset the ledger to force a retry.
- **Unconfirmed meeting:** retry identical provider-facing details to reconcile the saved operation marker. The app will not create a second event when the original remains uncertain. Check the selected provider account before manual remediation.
- **AI response lost:** reopen the workspace as the initiating member. A stored completed response reconstructs pending proposals without another inference call. Unknown costs remain reserved. The member-scoped agent-results endpoint exposes the retained receipt; operators must reconcile unknown costs using Cloud/provider evidence before settlement.
- **Mailbox lag:** inspect opt-in state, session expiry, archived status, entitlement, selected-account identity and scopes. The worker checks up to four due mailboxes each minute, with a five-minute interval after completion and a ten-minute claim lease. Five minutes is a target, not a guarantee during provider throttling/backlog. Alert on >15-minute staleness. Sign-out-all removes eligible sessions; disabling sync stops future scheduling.
- **Exposed credential:** revoke the affected Cloud delegation/credential through its owner, rotate the server secret, invalidate Outreachr sessions and inspect operation receipts. Do not paste secrets into issues or diagnostic bundles.
- **Resource pressure:** per-workspace admission allows one active operation and three queued requests with a two-second wait. Other workers fail fast on contention. Inspect pool/memory, archive sizes and provider latency. Uploads are 25 MB; workspace file storage is 100 MB; encrypted archive transfers are bounded at 256 MB and uploaded in 25 MB chunks. Expiring transfer storage is separate from the document quota.

## Restore and rollback

Portable cloud archives contain a validated SQLite snapshot, saved documents and checksums inside authenticated encryption. Credentials, current approvals, context grants and connector authority are stripped. Membership/billing remain destination-owned. Restore remaps document identifiers and commits files plus snapshot in one PostgreSQL transaction. It refuses a destination with send/mail/calendar operation history to prevent rolling back duplicate-send protections. Wrong passwords, changed checksums, missing blobs, tenant violations and partial restore rollback are integration-tested.

A portable archive is not operational PostgreSQL disaster recovery. Before launch, enable and verify provider backups, record retention/RPO/RTO, restore PostgreSQL into an isolated environment, compare document hashes and canonical counts, verify permissions, and exercise login/receipts without sending live mail. Do not declare an RPO/RTO until measured. Before schema deployment take a provider snapshot and verify it. After a migration, rollback requires a compatible binary or a verified database restore; rolling back only the frontend is insufficient.

## Closing a workspace

Archive is reversible and disables editing/AI/sending; it does not cancel billing. A member can leave, but the last owner must transfer ownership through the existing Cloud authority flow. Departures remove mailbox selection immediately. Data deletion requires exact workspace-name confirmation, owner authority, no pending billing/ownership operation and a ended/canceled paid subscription confirmed with Cloud. It removes live CRM/files/mailboxes/invites/AI response content; minimal billing, membership and audit records remain. Shared Eliza identity and provider-sent mail/calendar records are unaffected. Infrastructure backup retention and private support/refund policy still require operator decisions.

## Required external launch proof

Record the public deployed revision and browser evidence for login, both model plans, Google consent/revocation, a controlled email/reply, billing test-clock lifecycle, owner transfer, portability, restart and rollback. Check worker custom domain and private BFF health independently. Verify app registration and billing ownership for shawmakesmagic@gmail.com; login identity alone is insufficient. Configure an uptime/alert destination and a private support contact, and perform an alert drill. Never treat fixture tests as live-service proof.
