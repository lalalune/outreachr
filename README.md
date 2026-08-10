# Outreachr

**Run your fundraising round from a private desktop workspace.**

[![CI](https://github.com/lalalune/outreachr/actions/workflows/verify.yml/badge.svg)](https://github.com/lalalune/outreachr/actions/workflows/verify.yml)
[![CodeQL](https://github.com/lalalune/outreachr/actions/workflows/codeql.yml/badge.svg)](https://github.com/lalalune/outreachr/actions/workflows/codeql.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-0b7285.svg)](LICENSE)

Outreachr is a free, open-source fundraising operating system for founders raising pre-seed, seed, or Series A. It brings investor research, target ranking, introductions, one-to-one outreach, meetings, diligence, and committed capital into one founder-owned SQLite workspace—without an Outreachr-hosted account or Outreachr subscription.

![Outreachr outreach queue showing founder-approved messages for a sample VC round](docs/assets/readme/outreach.png)

<sub>Investor names and public research come from the bundled seed. Pipeline stages, expected checks, tasks, meetings, commitments, communication outcomes, and non-routable <code>.example</code> addresses are illustrative demo state; they do not represent contact with or commitments from the people or firms shown.</sub>

[Download the packaged v0.1.1 release](https://github.com/lalalune/outreachr/releases/tag/v0.1.1) · [Build the current v0.1.2 source](#install-or-build) · [Read the user guide](docs/user-guide.md) · [See the architecture](docs/architecture.md)

<sub>This README documents the current source tree. Packaged releases can trail it; use each release's notes as the feature record for that binary.</sub>

## What it does

- **Find investors that fit this round.** Search 192 bundled investor targets across VC firms, angels, scouts, solo GPs, accelerators, crypto funds, and other investor types. Rank them against stage, sector, geography, and published check evidence, with the reasons shown beside every score.
- **Inspect the evidence, not just a score.** Review selected portfolio examples, partner records, check ranges, source URLs, observation dates, confidence, source-review status, and redistribution rights where available; unknown provenance remains visible.
- **Run the whole fundraising pipeline.** Move firms from research through introductions, meetings, diligence, soft circle, commitment, pass, or not-now. Add private expected checks and watch round coverage update locally.
- **Send deliberate one-to-one outreach.** Draft, edit, approve, and send one initial message through Gmail or Outlook. Outreachr does not dispatch a second message; follow-ups can only be planned and reviewed locally.
- **Reconcile existing relationships.** Optional mailbox-history reconciliation retains only attributed relationship headers and unmatched outbound metadata while discarding unrelated inbound mail, bodies, and attachments.
- **Prepare investor meetings and diligence.** Create local or provider-backed meetings, select exact attendees, manage agendas and notes, track document links, and control what is safe to disclose.
- **Use Codex or Claude as a constrained collaborator.** Choose which local context an agent may read, then review typed proposals for drafts, research, tasks, and pipeline changes. Agents cannot send email or bypass founder approval.
- **Contribute better public research safely.** Export an allowlisted seed contribution while keeping outreach history, credentials, meetings, notes, and other private activity out of the package.

## One round, end to end

1. Define the company, round, target check, sectors, and fundraising narrative.
2. Review explainable investor matches and the evidence behind each one.
3. Build focused lists and move selected firms into the round pipeline.
4. Plan a warm introduction or approve one exact initial email to a canonical person.
5. Track delivery, replies, meetings, diligence, soft circles, and commitments.

### See the pipeline at a glance

![Outreachr demo pipeline with bundled investor profiles in synthetic fundraising stages](docs/assets/readme/pipeline.png)

<sub>Demo workspace: investor research comes from the bundled seed; pipeline placement, expected checks, and relationship outcomes are synthetic.</sub>

### Understand why an investor fits

![AIX Ventures research profile showing fit reasons, check range, thesis, and partner](docs/assets/readme/investor-detail.png)

<sub>Demo workspace: this is bundled public research, not a claim of an Outreachr relationship.</sub>

### Work from the next decision

![Outreachr demo workspace showing synthetic round momentum, meetings, approvals, and high-fit investors](docs/assets/readme/hero.png)

<sub>Demo workspace: all tasks, meetings, approvals, pipeline states, communication outcomes, and commitments shown here are synthetic.</sub>

## Local-first, with hard sending boundaries

The canonical workspace lives in one local SQLite vault. Outreachr has no application server and no product account. Secrets are encrypted with the operating-system credential facility, and private backups are password-encrypted.

Data leaves the device only for a founder-initiated integration action: sending an approved email, creating or syncing a calendar event, reconciling mailbox history, opening an external source, or sharing explicitly selected context with Codex or Claude. During mailbox reconciliation, only attributed relationship headers and unmatched outbound metadata are retained.

The send path is enforced below the interface:

- One unsolicited initial message per canonical person, including aliases and merged identities.
- Exact-content approval bound to recipient, sender, subject, and body. Initial outreach is deliberately attachment-free and unthreaded.
- Founder pause switch, hourly/daily limits, domain pacing, suppressions, and visible sender footer.
- Ambiguous provider outcomes are never retried automatically.
- Append-only, SHA-256 hash-chained security activity for local verification and export.

## Integrations

- Gmail and Google Calendar through founder-created desktop OAuth credentials.
- Outlook and Microsoft Calendar through founder-created public-client credentials.
- OpenAI Codex through the official local ChatGPT sign-in flow.
- Anthropic Claude through a founder-owned API key, or an existing local subscription session when Anthropic has approved that third-party deployment.

Every integration is optional. The investor workspace, pipeline, lists, tasks, knowledge base, documents, backups, and contribution tools work without a connected provider. See [credential setup](docs/credentials.md) and [agent setup](docs/agents.md).

## Install or build

Current desktop artifacts are published on the [Releases page](https://github.com/lalalune/outreachr/releases). Each release includes SHA-256 manifests and GitHub provenance attestations; native publisher-signing status is disclosed with the artifacts. The release matrix builds and tests macOS, Windows, and Linux on x64 and arm64 targets.

To run from source:

```bash
corepack enable
corepack prepare pnpm@11.18.0 --activate
pnpm install
pnpm dev
```

Run the complete local verification gates:

```bash
pnpm verify
pnpm test:e2e
```

Tests use isolated local vaults and mock mail/calendar providers; they never require production credentials.

## Repository map

- `apps/desktop` — Electron shell, secure preload bridge, React UI, and Playwright Electron tests.
- `packages/core` — SQLite schema, repositories, migrations, seed handling, and safety invariants.
- `packages/connectors` — Gmail, Google Calendar, Outlook, and Microsoft Calendar adapters.
- `packages/agents` — Codex and Claude Agent SDK adapters with proposal-only external actions.
- `packages/mcp` — typed, host-filterable local MCP server.
- `resources` — immutable investor seed and machine-readable rights metadata.

Start with the [user guide](docs/user-guide.md), [testing guide](docs/testing.md), [privacy and threat model](docs/privacy-and-threat-model.md), or [release runbook](docs/release.md). Investor-data contributions are documented in [docs/data-contributions.md](docs/data-contributions.md).

## License and data rights

First-party code and project-authored documentation are licensed under [Apache-2.0](LICENSE). Investor data retains source-specific rights recorded in its package manifest and is not automatically Apache-licensed. Portfolio records are selected research examples, not complete investment histories.
