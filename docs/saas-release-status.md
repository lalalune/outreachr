# SaaS release status — September 22, 2026

This is a release checklist, not a claim that the public service is deployed. Outreachr uses generic Eliza Cloud identity, app subscriptions, Google delegation and app-funded inference. All code in this change belongs to Outreachr.

## Implemented in this change

| Review area       | Delivered                                                                                               | Acceptance evidence                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Invitation entry  | Invite-first sign-in, no unrelated workspace/trial, selected destination                                | PostgreSQL and browser tests                                           |
| Hosted documents  | Honest upload disclosure, filenames, quota, inventory, remove, temporary cleanup                        | File isolation tests and browser upload/remove/restore                 |
| Conversations     | Content-approved Gmail replies and follow-ups bound to recipient, account, thread and parent            | Provider-boundary tests and browser initial-send/reply-draft flow      |
| Provider recovery | Persisted calendar operation before dispatch; reconcile uncertain creates                               | Restart/lost-response integration tests                                |
| Account isolation | Mail and calendar identifiers scoped to account; sender-bound uncertain-send recovery                   | Matching-ID regression tests; v11 migration preservation test          |
| Portability       | Encrypted complete cloud archive, saved document checksums, stripped authority, atomic restore          | Corruption, wrong-password, isolation, rollback and browser round trip |
| Offboarding       | Archive/reopen, member leave, owner content purge after billing ends, local sign-out-all                | Role, entitlement, purge and no-resurrection tests                     |
| AI recovery       | Rehydrate stored paid responses as pending proposals without another inference call                     | Recorded-response restart and idempotence test                         |
| Mailbox freshness | Opt-in scheduled reconciliation and visible status/reconnect errors                                     | Concurrent worker claim, expired-session and opt-out tests             |
| Resource controls | Bounded vault admission, PostgreSQL timeouts, authenticated upload limits, rate/workspace/invite quotas | Concurrency and limiter tests                                          |
| Product guidance  | Setup queue, source freshness warning, research limits, hosted guide/data-handling disclosure           | Browser accessibility/mobile checks                                    |
| Operations        | Request IDs, redacted diagnostic export and incident/restore procedures                                 | Type/lint checks and documented external drills                        |
| Dependencies      | Integrates PRs 55, 56, 59, 60 and 61; patched transitive dependencies                                   | Final repository/CI and dependency audit required                      |

The browser uses local identity, billing, inference and Gmail fixtures. No fixture message goes to a real mailbox. The fixture address is never a substitute for the real sender address.

## Required before a paid public launch

1. **Generic Cloud cutover and registration.** Register the app and test/live clients under the operator organization designated by `shawmakesmagic@gmail.com`; verify actual ownership. Railway lacks issued app/client identifiers, an inference credential, billing mode and notification verification keys. An arbitrary generated secret is not proof of client registration. The live Cloud sign-in currently reaches a personal Dedicated-agent setup gate; this is not an independent app registration flow.
2. **Remove the central product-specific implementation.** Readback of Eliza's default branch on September 22 still found `packages/cloud/api/v1/outreachr/route.ts` with product-specific delegation, Google and billing services. Outreachr no longer calls that route. Removal/cutover belongs to the generic Cloud integration; it has not been completed by this repository change. See the [central integration dependency](https://github.com/elizaOS/eliza/issues/30638).
3. **Deploy and prove the final revision.** The public domain returned Cloudflare 1016 during computer-use verification. Apply migrations with the migration role, deploy the BFF/Worker, read back the same source revision and exercise private-edge authorization. Preserve a compatible rollback and validate a database restore before replacing production data.
4. **Actual billing/provider acceptance.** Verify independent no-personal-plan entry, app catalog, Stripe test-mode purchase/renewal/failure/recovery/cancel/refund, owner transfer and both exact model plans. Complete real Google consent, revocation, account switching, provider receipt/readback and duplicate-send rejection. Local tests are not this evidence.
5. **Seller and customer policies.** Supply the legal seller, private support contact, refund policy and infrastructure backup retention. Publish final hosted terms/privacy and support routing after those decisions. The technical data-handling page deliberately makes no invented legal or retention promise.
6. **Lifecycle communication delivery.** Trial/billing/setup/reconnect status is visible in-app; invitations are explicit copyable links. Transactional email delivery for invitations, trial ending and billing attention still needs an approved service sender/domain and a generic Cloud delivery capability. Do not send these from the operator's personal Gmail or silently add another payment system. Verify delivery, unsubscribe/category rules where applicable, retry/idempotency and sensitive-data minimization before enabling it.
7. **Operational acceptance.** Choose an alert destination and uptime monitor, test a real alert, measure backup restore/RPO/RTO and archive memory use at the configured hosting limit, and rehearse provider outage and owner-account recovery. The diagnostic endpoint and runbook support these drills; they do not constitute a staffed support operation.
8. **Data and market validation.** Current source and contact validity, source rights, a refresh/correction process, pilot retention and willingness to pay require product/data operations. The app exposes dated evidence and human review; it does not claim a verified current contact feed, live research or warm-introduction graph. Existing action counts are diagnostic funnel signals, not an attribution or retention analytics product.
9. **Controlled live email.** The authorized recipient is `shawmakesmagic@gmail.com`. A real sender postal address remains unanswered; the earlier response “yes” did not supply one.

Do not label the product fully shipped until these acceptance items have evidence. No production purchase, real outbound message, or unverified credential registration is implied by this change.
