# Outreachr Cloud validation — 2026-09-06

This record separates consumer verification from deployed provider acceptance. The current consumer uses generic Cloud APIs; historical tests of the original product-specific bridge do not establish the generic integration.

## Verified consumer revision

[PR #47](https://github.com/lalalune/outreachr/pull/47), head `9262e5b6f644df36f55942319a39570dce11939a`, corrects billing account resolution to `/billing/accounts/resolve` and pins the SDK artifact from Cloud source `58cbb4cae02dc578ca0197850818d7710ceb5b4b`. Its adjacent vendor manifest records the artifact hash and source provenance.

The vendored SDK is built from Cloud source `d3159a0b1e7bddb90a48b511a700bf656344b67b`. Its generated route catalog removes the retired product-specific endpoints while preserving generic account resolution. See the adjacent vendor manifest for source and artifact hashes. The package does not establish that matching Cloud APIs are deployed.

Changing the provider fixtures to the canonical route exposed nine provisioning failures with the previous SDK. The corrected artifact passes:

- 76 integration tests against disposable local PostgreSQL databases.
- 67 cloud unit tests.
- The complete browser fixture scenario, including identity, trial recovery, CRM and draft persistence, reviewed proposals, billing command recovery, payment actions, checkout cancellation, invitations, viewer isolation, export and mobile checks.
- Cloud type checking, frontend build, focused lint and formatting, frozen-lockfile installation, and Cloudflare Worker deployment dry run.

Direct computer-use verification also confirmed pending trial restrictions, recovery of the existing trial, Sol seat pricing, recovery after a lost checkout response, payment setup without granting paid access, and checkout cancellation recovery with one cancellation receipt. The browser fixtures implement a one-seat payment scenario; the three-seat review display is not proof of a three-seat provider purchase.

Use GitHub's current checks for terminal hosted verification of this exact revision. Local checks, a source commit, and a Worker dry run are not deployment evidence.

## Infrastructure and provider boundaries

Railway CLI authentication is confirmed. The configured Outreachr service has no deployment and still requires app registration, issued delegation credentials, billing environment and notification configuration, and a funded product-owned inference credential. Cloudflare publication and final frontend/BFF revision readback remain outstanding.

Earlier database verification established a separate `outreachr` schema and restricted runtime role, including denial of reads from `public.users`. Recheck the deployed runtime permissions and migrations at cutover. Do not give the BFF the database administrator credential.

The user designated `shawmakesmagic@gmail.com` as billing owner. After clearing a stale session, browser readback confirmed that account in the Cloud dashboard. App registration and organization ownership still need provider readback; signing in alone does not assign app ownership. The generic Cloud integration is undergoing separate central verification and deployment; the pinned SDK does not prove that its production routes are available.

A prior generic Cloud Stripe sandbox exercise verified one paid fixture invoice. It did not use the deployed Outreachr Sol/Astra plans and does not establish complete lifecycle acceptance. Managed Gmail results in the consumer suite are fixtures; no live Outreachr email has been sent.

## Remaining deployed acceptance

Complete generic Cloud integration and deployment; app/client registration; catalog and notification setup; Railway and Cloudflare deployment; actual login and delegated Google consent; both exact model executions and app-funded allowance accounting; subscription independence from personal Eliza plans; and Stripe test-mode purchase, renewal, failure recovery, seat/plan changes, refunds and cancellation against the final integrated revision.

Verify the controlled Gmail send with a provider receipt, sent-mail readback and duplicate-send rejection after the sender postal address is supplied. Keep fixture evidence and actual provider results distinct. Follow [the shipping plan](app-billing-and-shipping-plan.md) and [deployment instructions](../apps/cloud/README.md#deployment).
