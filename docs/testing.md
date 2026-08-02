# Testing and release gates

## Local gates

```bash
pnpm install --frozen-lockfile
pnpm verify
pnpm test:coverage
pnpm audit --prod
pnpm audit
pnpm test:e2e
pnpm prepare:resources
pnpm package
```

`pnpm verify` checks formatting, lint, fresh package builds, strict TypeScript, unit tests, integration tests, and the production renderer/main/preload build.

Desktop tests cover command validation, seed bootstrapping, legacy-to-v9 migration, bounded file reads, backup/restore, privacy-safe contribution export, secure storage, OAuth, exact approval, visible footer/readiness and approval revocation, initial-only sending, duplicate prevention, pause/daily/hourly/domain/cooldown/suppression triggers, hash-chain verification, Gmail history beyond ten pages, old alias sends, unmatched-outbound contact reconciliation, pagination-token-loop failure, incremental sync, exhaustive Google Calendar sync beyond twenty pages, canonical meeting relationships, attendee-email validation before provider I/O, legacy attendee compatibility, reply review, outbound-history deduplication, hard-bounce/complaint/unsubscribe handling, immutable automatic suppressions, renderer smoke, keyboard-accessible navigation, and axe checks. Gmail, Google Calendar, and Microsoft Calendar integration tests use MSW and assert that provider payloads contain selected attendee names/emails but no local person IDs; connector tests also prove Microsoft sent-folder direction. Integration coverage proves Gmail and Microsoft uncertain responses remain non-retryable, forged inbound operation headers cannot confirm a send, and an exact authoritative sent-mail observation confirms the original reservation without another provider request. Playwright also launches the actual built Electron main process and preload bridge against a loopback-only MSW provider server: the Settings UI completes a mock Google PKCE connection, exhausts paginated Gmail and Calendar data, stores encrypted test tokens, creates a Google Calendar invitation for the exact selected canonical person, performs one exact-approved Gmail provider send, and proves replay cannot make a second provider request. The credential E2E also exercises the founder-confirmed Claude subscription toggle and proves an inherited setup token never enters bootstrap data or plaintext SQLite. The seam requires an unpackaged app, `NODE_ENV=test`, a `127.0.0.1` endpoint, and a one-run encryption key; packaged applications reject it. The remaining Electron sweep visits every major route in both light and dark themes.

## Live Codex subscription smoke

The normal suite never consumes an account-backed model. To validate the complete embedded Codex path with the official CLI's existing ChatGPT sign-in, explicitly opt in on a developer machine:

```bash
OUTREACHR_LIVE_CODEX_SMOKE=1 pnpm smoke:codex
```

`smoke:codex` prepares development sidecars while preserving their vendor platform signatures so the operating system can execute them outside an app bundle. To exercise a final package instead, also set `OUTREACHR_PACKAGED_EXECUTABLE` to the final Outreachr executable (for example, the executable inside a mounted macOS DMG). Packaged mode uses a temporary loopback-only Chromium debugging port rather than the disabled Electron main-process inspector, so the production fuse configuration remains intact. The harness creates an isolated local profile, completes onboarding, confirms that Codex reports ready, executes one proposal-only/no-context turn, requires a successful terminal event, and deletes the temporary profile. It does not run in CI because it depends on a human-owned subscription session. Release packaging always uses the separate normalized-resource path and signs the complete app bundle.

## Live Claude subscription smoke

After Anthropic has approved the deployment and the official local CLI is signed in, validate the exact approved Agent SDK path with one isolated, tool-free turn:

```bash
claude auth login --claudeai
OUTREACHR_LIVE_CLAUDE_SMOKE=1 pnpm smoke:claude
```

The normal suite and CI never consume Claude plan credit. This opt-in harness uses an empty temporary workspace, no disclosed CRM context, no MCP connection, no built-in tools, one turn, and the same strict structured-output parser as the app. It requires official CLI subscription detection, removes both `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN` from the Agent SDK environment, verifies an exact completion phrase with no proposals, prints no account identity, and deletes the workspace.

## CI matrix

Every pull request and main-branch push runs target-native jobs for:

- macOS x64 and arm64;
- Windows x64 and arm64;
- Linux x64 and arm64.

Each job installs the frozen graph, verifies architecture, runs the full gate and Electron E2E (Xvfb on Linux), packages native artifacts, validates embedded resources and hardened Electron V1 fuses, launches every final distribution, generates CycloneDX SBOM and SLSA-format provenance, verifies SHA-256 manifests, and uploads an isolated artifact bundle.

## Release gate

Only a protected annotated semantic-version tag at current protected `main` starts a release. A GitHub-verified tag signature is recorded as a stronger free signal; a protected unsigned annotated tag is accepted. Complete environment-protected macOS and Windows signing groups automatically enable Developer ID/notarization/stapling or timestamped Authenticode. Absent groups produce filenames and status manifests labeled unsigned (and unnotarized on macOS); the macOS baseline's ad-hoc signature supplies execution integrity but no publisher identity. Partial groups fail. Linux signatures are optional.

Every mode remains blocked on final-distribution smoke tests, resource checks, SBOMs, local provenance, SHA-256 manifests, and GitHub OIDC attestations. The workflow uploads a private draft, downloads and compares every asset byte-for-byte, and publishes only after the comparison passes. No workflow may silently downgrade signing or hide unsigned status.
