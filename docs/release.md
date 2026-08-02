# Release runbook

1. Confirm the working tree contains only intended source, generated legal notices, lockfile, seed manifest, icons, tests, and documentation.
2. Run `pnpm install --frozen-lockfile`, `pnpm verify`, `pnpm test:e2e`, `pnpm prepare:resources`, the native package command, hardened Electron-fuse verification, and packaged smoke/resource verification.
3. Verify `package.json` and `apps/desktop/package.json` versions match the intended semantic tag.
4. Review `CHANGELOG.md`, `THIRD_PARTY_NOTICES.md`, seed rights status, SBOM, and release checklist.
5. For a new repository, enable Actions with full-length SHA pinning required, allow GitHub-owned actions plus only the pinned `softprops/action-gh-release` community action, set the default `GITHUB_TOKEN` permission to read-only, and disable workflow pull-request approvals. Then push the initial `main` commit and wait for the hosted verification and CodeQL workflows to register and pass the exact `All native targets` and `JavaScript and TypeScript` check contexts.
6. Before pushing a release tag, create the `production-release` environment with a custom `v*` tag deployment policy, activate the maintainer-bypass `v*` tag ruleset, activate `main` protection with both exact required checks, enable immutable releases, and read every setting back through the GitHub API. Immutable releases must be enabled before v0.1.0 because the setting applies only to future releases; private drafts remain editable until publication.
7. Optional complete hosted macOS Developer ID/notarization or Windows Authenticode secret groups in `production-release` automatically upgrade that platform. Absent groups produce conspicuously labeled unsigned artifacts; the macOS baseline has only a free ad-hoc execution signature and no publisher trust. Partial groups fail.
8. Create an annotated semantic tag such as `v0.1.0` at protected current `main`, and push it. A GitHub-verified SSH/GPG signature is stronger but is not required for the zero-cost path.
9. Watch all six target-native jobs. Do not approve publication when any package, trust disclosure, resource, checksum, provenance, attestation, or smoke check fails.
10. Confirm the workflow uploaded a private draft, downloaded and compared every asset byte-for-byte, published it, proved GitHub marked the release immutable, and downloaded and compared every immutable public asset again.
11. Download the public assets on each operating system, inspect `SIGNING-STATUS-<target>.json`, verify the corresponding SHA-256 manifest and GitHub attestation, install, complete a clean-vault launch, and record the result. Expect Gatekeeper/SmartScreen warnings only for explicitly unsigned files.

Release automation cannot create vendor certificates, a GitHub remote, repository protections, or a hosted release without the maintainer’s external accounts. Paid publisher certificates are optional distribution-trust upgrades, never application runtime requirements.

## Local macOS Developer ID release

An eligible `Developer ID Application` certificate installed by Xcode can sign Outreachr on that Mac. The Xcode account is not itself a signing credential: the certificate’s private key lives in that Mac’s Keychain, and a GitHub-hosted runner has a separate, temporary Keychain. The local route therefore uses the installed identity directly; the hosted route above continues to require the portable `.p12` secret group.

Configure notarization once with Apple’s interactive credential prompt. The command stores the resulting credentials in Keychain; it does not put the app-specific password in shell history:

```bash
xcrun notarytool store-credentials "outreachr-notary" \
  --apple-id "YOUR_APPLE_ID" \
  --team-id "ABCDE12345"
```

Then select the exact Developer ID identity and expected Team ID for each local release:

```bash
export OUTREACHR_MAC_KEYCHAIN_IDENTITY="Developer ID Application: YOUR NAME (ABCDE12345)"
export OUTREACHR_MAC_EXPECTED_TEAM_ID="ABCDE12345"
export OUTREACHR_APPLE_KEYCHAIN_PROFILE="outreachr-notary"
pnpm release:mac:local
node scripts/verify-code-signing.mjs --expect signed --release-dir apps/desktop/release
```

Use the identity’s 40-character SHA-1 fingerprint instead of its name if more than one valid certificate has the same name. For a non-default Keychain, add `--keychain "/absolute/path/to/custom.keychain-db"` to `notarytool store-credentials` and set `OUTREACHR_APPLE_KEYCHAIN` to that same absolute path; the same Keychain must contain both the signing private key and the named notarization profile.

The preflight calls `security find-identity -v -p codesigning`, requires an exact identity match, rejects Apple Development certificates, and verifies the certificate name’s Team ID against `OUTREACHR_MAC_EXPECTED_TEAM_ID` before building. The DMG and app are submitted with the named `notarytool` profile and stapled. Local Keychain mode is deliberately mutually exclusive with `OUTREACHR_MAC_CERTIFICATE_*`, App Store Connect API-key variables, and Apple ID/password release variables; mixed configuration fails instead of choosing credentials implicitly.

`release:mac:local` creates and notarizes native-architecture artifacts only and never publishes them. Publishing all desktop targets still goes through the protected tag workflow. To let hosted macOS runners sign, a maintainer must separately export a password-protected Developer ID `.p12` and configure the existing protected environment secrets; do not upload a local Keychain or an unencrypted private key.
