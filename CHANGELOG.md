# Changelog

## 0.1.1 - 2026-08-01

- Replaced backtracking-prone address, fenced-JSON, and trailing-slash parsing with bounded deterministic implementations; hardened structured logging and architecture validation.
- Restricted CodeQL to maintained production source and resolved every resulting alert without dismissals or generated-code exclusions hiding first-party runtime code.
- Removed shell-based Windows package execution, constrained fixed release commands, and validated materialized sidecar, installer, and uninstaller executables before launch.
- Restored credential-free ad-hoc signing in macOS pull-request verification so mounted DMGs and ZIPs receive valid copy-and-launch smoke coverage on both architectures.

## 0.1.0 - 2026-07-31

- Initial local-first Electron application for macOS, Windows, and Linux on x64 and arm64.
- Evidence-backed investor seed with 192 targetable investors (167 institutional firms plus 25 independent angels, solo GPs, scouts, and family offices), 192 linked people, 1,010 sources, 622 portfolio examples, and 420 named-partner rows.
- Founder onboarding, round strategy and economics, investor/partner research, explainable fit, targets, pipeline, introductions, tasks, meetings, calendar sync, knowledge, document references, review, lists, and local search.
- Founder-owned Google and Microsoft desktop OAuth, Gmail/Outlook sending, Google/Microsoft calendars, OS-encrypted credentials, exact-content approval, founder-controlled sender/opt-out footer, database-enforced daily/hourly/domain pacing, suppression, and one-initial duplicate prevention.
- Local Codex ChatGPT-subscription adapter, Claude Agent SDK adapter with founder-controlled API-key authentication, and a proposal-only MCP surface.
- Encrypted backup/restore, CSV export, validated seed import, and privacy-safe public contribution extraction.
- Strict TypeScript, unit/integration/Electron E2E, MSW provider mocks, accessibility checks, native packaging, signing/notarization gates, SBOM, provenance, checksums, and GitHub attestations.
