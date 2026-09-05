# Outreachr Cloud validation — 2026-09-05

The Cloud implementation is in the isolated `feat/outreachr-cloud` checkout. The companion Eliza integration is tracked by elizaOS/eliza#30598. This report records intermediate evidence, not completed live acceptance.

## Passing local checks

- Outreachr `pnpm verify`: formatting, lint, types, 358 tests, all package and application builds.
- Real PostgreSQL integration: 13 passing tests, covering concurrent first login, one-time trials, membership and invitation authority, sessions, usage reservation, vault durability, files, reviewed AI proposals, billing replay/current-state reconciliation, and Gmail sends.
- Browser E2E: real BFF and PostgreSQL with local identity and provider fixtures; sign-in, onboarding, Shaw fixture contact and draft persistence, AI proposal review, CSV download, viewer invitation acceptance, owner-only billing controls, and no serious/critical axe findings or renderer errors.
- Managed Gmail test: real command/connector/vault path with selected `gmail.modify` connection, normalized mailbox identity, approval, persisted provider receipt, restart readback, and duplicate-send rejection. The Google response is a fixture; no real message was sent.
- Stripe boundary: three tests use the real Stripe SDK with a controlled HTTP transport and actual webhook signing; wrong product/customer authority and tampered signatures fail.
- Eliza delegation and PGlite migration tests pass. Migration replay preserves revoked token replay protection.
- Frontend build and Cloudflare Worker deployment dry run pass.

## Live infrastructure readback

The existing Cloud PostgreSQL database now contains a separate `outreachr` schema. A new restricted `outreachr_runtime` role can perform product DML, cannot create schema objects, and receives PostgreSQL permission denied when attempting to read `public.users`. The BFF receives only this restricted credential. No Cloud user or billing records were changed.

Shaw's Google login reached Cloud's dedicated-agent join page, which reported insufficient account credits. A full authenticated app registration and managed Gmail readback remain outstanding.

## Remaining acceptance

Hosted PR checks and merges; companion Cloud staging certification and production deployment; app registration and funded inference credential; Stripe product/webhook setup and test-mode lifecycle; Railway service and Cloudflare domain deployment; real Sol and Astra inference; real Gmail send and sent-mail readback. The sender postal address is still required from the user. Desktop E2E and final post-sync checks are running.
