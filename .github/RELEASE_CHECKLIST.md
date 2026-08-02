# Outreachr release checklist

The zero-cost release path is intentionally complete: all six native packages must pass tests, installed-package smoke checks, resource validation, hardened Electron-fuse verification, SHA-256 manifests, SBOM generation, and GitHub OIDC build attestations. Apple Developer ID/notarization and Windows Authenticode credentials are optional trust upgrades. When either credential group is absent, the corresponding files and machine-readable status are prominently labeled **UNSIGNED** (and **UNNOTARIZED** on macOS). The macOS baseline uses only a free ad-hoc signature so the arm64 app and agent executables can run; it provides no publisher identity or Gatekeeper trust. A partial credential group always fails the release.

## One-time repository setup

- [ ] Keep the canonical repository public so GitHub’s public-good artifact attestations remain available without a paid plan.
- [ ] Enable Actions with full-length SHA pinning required, allow GitHub-owned actions plus only `softprops/action-gh-release`, and keep the default `GITHUB_TOKEN` permission read-only with pull-request approval disabled.
- [ ] Push the initial `main` commit and wait for the verification workflow’s stable **All native targets** check and the CodeQL check context **JavaScript and TypeScript** to register and pass.
- [ ] Create the protected GitHub environment `production-release` with a custom tag deployment policy matching `v*`; use required reviewers only if the repository plan and maintainer workflow support them.
- [ ] Add an active `v*` tag ruleset that restricts creation, deletion, and retargeting to the explicit maintainer bypass actor.
- [ ] Protect `main` with the exact **All native targets** and **JavaScript and TypeScript** required checks, deletion protection, and non-fast-forward protection.
- [ ] Enable GitHub immutable releases **before the first release tag is pushed**. Drafts remain editable until publication, so the workflow can upload and compare every asset before the release becomes immutable; enabling this after v0.1.0 would protect only future releases.
- [ ] Read back the environment, deployment policy, rulesets, and immutable-release setting through the GitHub API before creating any release tag.
- [ ] Confirm all six GitHub-hosted runner labels are enabled for the repository.

## Optional platform-signing upgrades

No paid credential is required to build or publish a verified Outreachr release. A complete group automatically upgrades that platform’s artifacts; an absent group selects the disclosed unsigned path.

Optional macOS Developer ID and notarization secrets:

- `OUTREACHR_MAC_CERTIFICATE_BASE64` — base64-encoded `.p12` Developer ID certificate.
- `OUTREACHR_MAC_CERTIFICATE_PASSWORD`.
- `OUTREACHR_MAC_EXPECTED_TEAM_ID` — the exact Apple team identifier expected in the signed app.
- Either App Store Connect API notarization credentials:
  - `OUTREACHR_APPLE_API_KEY_BASE64`
  - `OUTREACHR_APPLE_API_KEY_ID`
  - `OUTREACHR_APPLE_API_ISSUER`
- Or Apple ID notarization credentials:
  - `OUTREACHR_APPLE_ID`
  - `OUTREACHR_APPLE_APP_SPECIFIC_PASSWORD`
  - `OUTREACHR_APPLE_TEAM_ID`

Optional Windows Authenticode secrets:

- `OUTREACHR_WINDOWS_CERTIFICATE_BASE64` — base64-encoded `.pfx` certificate.
- `OUTREACHR_WINDOWS_CERTIFICATE_PASSWORD`.
- `OUTREACHR_WINDOWS_EXPECTED_PUBLISHER` — a case-insensitive substring of the expected certificate subject.

Optional Linux detached-signature secrets:

- `OUTREACHR_LINUX_GPG_PRIVATE_KEY` — ASCII-armored private key.
- `OUTREACHR_LINUX_GPG_PASSPHRASE`.

Do not configure only part of a group. The optional policy rejects a partial macOS certificate/notary group or partial Windows group instead of silently downgrading it.

### Local macOS Keychain alternative

For a signed/notarized native-architecture build on a maintainer Mac, the local Keychain path avoids exporting the Developer ID private key. It does not replace the portable `.p12` group used by GitHub-hosted runners.

- [ ] Confirm `security find-identity -v -p codesigning` lists the intended `Developer ID Application` certificate as valid.
- [ ] Store notarization credentials interactively with `xcrun notarytool store-credentials PROFILE --apple-id APPLE_ID --team-id TEAM_ID`; for a custom Keychain add `--keychain /absolute/path/to/custom.keychain-db`. Do not pass the app-specific password on the command line.
- [ ] Set `OUTREACHR_MAC_KEYCHAIN_IDENTITY`, `OUTREACHR_MAC_EXPECTED_TEAM_ID`, and `OUTREACHR_APPLE_KEYCHAIN_PROFILE`. For a custom Keychain, also set `OUTREACHR_APPLE_KEYCHAIN` to its absolute path.
- [ ] Unset the portable `OUTREACHR_MAC_CERTIFICATE_*`, `OUTREACHR_APPLE_API_KEY_*`, and `OUTREACHR_APPLE_ID`/password/team credential groups; local and portable modes are mutually exclusive.
- [ ] Run `pnpm release:mac:local`, then `node scripts/verify-code-signing.mjs --expect signed --release-dir apps/desktop/release`.
- [ ] Confirm the exact Team ID, Gatekeeper assessment, app/DMG signatures, notarization tickets, and staples all pass before distributing the local artifacts.
- [ ] Remember that this local command never publishes and cannot sign on an isolated hosted runner without separately configured portable secrets.

## Per release

- [ ] Start from a clean, reviewed `main` commit with all required checks green.
- [ ] Confirm the root and desktop `package.json` versions are the intended semantic version.
- [ ] Run `pnpm run licenses` from the frozen install and review the generated dependency report.
- [ ] Review database migrations and verify an older encrypted vault upgrades on a disposable copy.
- [ ] Review seed-data source rights, pinned hashes, and contribution-export privacy tests.
- [ ] Exercise the Gmail/Google Calendar and Microsoft mock suites. If maintainers provide dedicated sandbox accounts, optionally repeat a draft-only real-provider smoke without storing those credentials in CI.
- [ ] Exercise the Codex ChatGPT-subscription flow and the Claude founder-controlled API-key flow when authorized maintainer credentials are available; the deterministic SDK/MCP contract suites remain mandatory and credential-free in CI. Do not route Claude Free/Pro/Max or setup-token credentials through Outreachr.
- [ ] Confirm duplicate-recipient, suppression, approval-hash, and send-ledger invariants remain release-blocking.
- [ ] Create an annotated tag at protected `main`. A GitHub-verified SSH/GPG signature is a free defense-in-depth upgrade, but the baseline may use a protected unsigned annotated tag:

  ```bash
  git tag -a v0.1.0 -m "Outreachr v0.1.0"
  # Stronger when a GitHub-recognized signing key is configured:
  # git tag -s v0.1.0 -m "Outreachr v0.1.0"
  git push origin v0.1.0
  ```

- [ ] Confirm the preflight recorded the exact tag-verification status, proved the tag is protected and annotated, and proved it references current protected `main`.
- [ ] Watch all six target-native release jobs finish:
  - macOS x64 on `macos-15-intel`
  - macOS arm64 on `macos-15`
  - Windows x64 on `windows-2025`
  - Windows arm64 on `windows-11-arm`
  - Linux x64 on `ubuntu-24.04`
  - Linux arm64 on `ubuntu-24.04-arm`
- [ ] For a configured macOS upgrade, confirm Developer ID, Gatekeeper, notarization, and stapling passed. Otherwise confirm the app has only an ad-hoc signature, filenames contain `UNSIGNED-UNNOTARIZED`, and Gatekeeper rejection was expected and recorded.
- [ ] For a configured Windows upgrade, confirm the expected publisher and timestamped Authenticode signatures passed. Otherwise confirm filenames contain `UNSIGNED` and SmartScreen disclosure is present.
- [ ] Confirm all six hardened Electron V1 fuses passed: RunAsNode, NODE_OPTIONS, and inspector arguments disabled; cookie encryption, embedded-ASAR integrity, and ASAR-only loading enabled.
- [ ] Confirm each package launched from every final installer/archive and that the unpacked package contained the seed, notices, and working Claude and Codex executables with matching normalized hashes.
- [ ] Confirm every bundle includes `SIGNING-STATUS-<target>.json`, installers, SHA-256 manifests, legal notices, CycloneDX SBOMs, local provenance statements, and GitHub OIDC attestations.
- [ ] Confirm the workflow created a private draft, downloaded every asset, compared it byte-for-byte, made the release public, proved GitHub marked it immutable, and downloaded and compared every immutable public asset again.
- [ ] Download public assets on clean machines, verify checksums and attestations, install, create a test vault, restart, and uninstall without removing unrelated user data.

The workflow will not publish when a target fails, a credential group is partial, the tag is lightweight/unprotected/not at current `main`, a bundle is incomplete, or an uploaded draft asset differs. Asset overwrites are disabled. A failed upload remains a private draft for maintainer inspection rather than a partial public release.
