# Outreachr user guide

Outreachr is a single-founder, local-first fundraising workspace for pre-seed, seed, and Series A rounds. It does not create a hosted account. The canonical workspace is an SQLite file owned by the founder.

## First launch

1. Enter the founder and company identity.
2. Define the round stage, target amount, useful check range, sectors, geographies, and narrative.
3. Optionally enter the sender postal address now. Setup can finish without it, but email approval and sending remain blocked until it is saved under **Communication safety**.
4. Outreachr imports the pinned investor research seed into a new private vault.
5. Review **Up next** for the highest-priority local tasks and safety reviews.

The bundled seed is explicitly marked research-grade. A source count is not proof of correctness. Exact claim sources retain their URLs, observation dates, confidence, and rights metadata; assertions without field-level evidence remain visibly unattributed instead of borrowing an unrelated entity source.

## Investor universe

Use **Investors** to search firms and people, filter by founder-specific fit, switch between firm and person views, add private records, and export founder-owned CSV data. Multi-type investors are represented by a primary kind plus tags and sourced claims.

An investor detail page contains:

- investor type, geography, stage, sectors, check evidence, and explainable fit;
- relevant partners and sourced professional contact methods;
- thesis, selected portfolio examples, source ledger, and private activity;
- target state, current pipeline stage, expected check, next action, and conflict signal.

Unknown values remain unknown. Outreachr does not infer that missing portfolio, check, or partner evidence means “none.”

## Pipeline and round economics

Add an investor to the active round from its detail page, then move it through research, ready, introduction requested, contacted, meeting, diligence, partner meeting, soft circle, committed, passed, or not now.

Record a private expected check on a targeted investor. Expected checks count toward round progress only in the soft-circle or committed stage. Published check evidence is displayed separately from the founder’s private expectation.

## Introductions and direct outreach

**Introductions** creates founder-owned research tasks and a forwardable request template. A warm path is treated as a claim requiring evidence, not as an automatically inferred relationship.

Direct email follows this enforced flow:

1. Add or verify a professional recipient address.
2. Create and edit a person-specific draft.
3. Confirm that the exact configured sender postal address and opt-out wording are visible in the body, then approve the recipient, sender context, subject, body, and unthreaded/attachment-free initial structure.
4. Select **Send now**.
5. The database atomically reserves the canonical person and normalized address before the provider request.
6. A definitive result is recorded as sent. An uncertain result is recorded as ambiguous and is never retried; a later mailbox sync can confirm only that original reservation when the provider's authoritative sent-mail stream contains an exact Outreachr operation key plus matching provider, sole recipient, subject, and bounded timestamp.

A second unsolicited initial to the same canonical person or email is blocked across rounds and providers. Outreachr does not run unattended sequences.

The current send ledger is intentionally stricter than a sequencer: it permits at most one provider send to a canonical person or normalized address. Later replies and follow-ups can be reviewed and planned in Outreachr, but the app does not send a second message. This removes an entire accidental-spam path for the initial open-source release.

Settings → Mail & calendar also provides database-enforced communication controls:

- pause every send without disconnecting a provider;
- set a daily hard limit from 1 to 50 founder-approved reservations;
- set an hourly hard limit from 1 to 20 reservations;
- set a per-recipient-domain daily limit and a 1–1,440 minute domain cooldown;
- configure the exact sender postal address and opt-out wording that must remain visible in an approved body;
- suppress everyone, one email, domain, canonical person, or investor firm;
- retain non-deactivatable automatic person suppressions created from attributed hard bounces, complaints, or unsubscribe requests.

New drafts append the configured sender footer automatically. A migrated or newly created vault may leave the postal address unset, but approval and sending then fail closed while the draft remains editable. Changing any communication-policy or footer value revokes active approvals. SQLite checks the exact body again, requires stock 0.1 initials to be unthreaded with no attachments, and enforces all time/domain limits when it reserves a send. Changing the interface cannot bypass these controls.

These controls are safety mechanisms, not legal certification. The founder must review applicable local requirements, use an address they are permitted to publish, and confirm provider/domain deliverability configuration such as SPF, DKIM, and DMARC.

## Optional mailbox relationship sync

Relationship sync is off by default and requires an additional read-only provider scope. Research and planning still work without it, but provider sending fails closed until the selected account has completed reconciliation. The first **Sync mail history** exhausts the account's available history with resumable page progress; it has no one-year or ten-page cutoff. Later reconciliations use an overlap cursor, while any contact-email identity change forces a new full scan. A provider error or pagination-token loop leaves the completion cursor unchanged and keeps sending blocked.

Outreachr stores sender/recipient headers, subject, timestamps, provider/thread IDs, provider direction evidence, and classification; it never stores bodies or attachments. It discards unrelated inbound mail. It retains minimal unmatched outbound header observations so that adding a professional contact later can reconcile an older send. Gmail's `SENT` system label and Microsoft's sent-items folder are authoritative for outbound direction, including send-as aliases.

Attributed outbound history blocks another initial even when the original message was sent outside Outreachr. It can also move an ambiguous Outreachr reservation to sent, but only from an authoritative provider sent-mail item with the exact operation key and matching send identity; forged inbound headers, partial matches, or manual guesses cannot do so, and no second provider request is made. Inbound replies enter **Up next** and **Outreach** for founder review. Hard bounces, complaints, and unsubscribe requests create a non-deactivatable suppression before any later send can be reserved. Sync is idempotent by provider message ID. Stock 0.1 sends initial outreach only; follow-ups and replies may be drafted and reviewed locally but cannot be dispatched.

## Meetings and calendars

Manual meetings remain local. For any new meeting, select an investor and the exact associated people who should attend; only canonical people with a valid saved work or individual email can be selected. Choosing an investor that is not yet in the active round adds that investor to the round so the relationship remains durable. A meeting can instead be created in a connected Google or Microsoft calendar when the founder explicitly selects that provider before saving. In that mode, saving creates the provider event and sends its calendar invitations to the selected attendees.

**Sync calendars** imports the previous 30 days and next year from each connected account, upserts provider events by stable external ID, links attendees to canonical people when professional emails match, and preserves explicit local investor/person associations plus private notes. Canonical person IDs stay in SQLite; Google and Microsoft receive only the attendee name and email required for the invitation. Meeting agendas and outcomes are stored in SQLite and can be used only in agent runs whose disclosure selection permits them.

## Knowledge and documents

Knowledge items are company, round, narrative, metrics, disclosure, or other facts. Every item has one disclosure policy:

- internal only;
- safe for outreach;
- meeting only;
- diligence only.

Documents are founder-controlled links or references to local files. Outreachr stores the reference and disclosure state; it does not silently copy, upload, or grant access to the underlying file. Encrypted SQLite backups do not include external files.

## Local agents

Outreachr runs bundled local Codex and Claude agent sidecars. Codex uses the official CLI's existing ChatGPT sign-in. Claude can use a founder-entered Anthropic API key stored as operating-system-encrypted ciphertext, or an existing official local Claude subscription session after the founder confirms Anthropic approved that deployment and explicitly enables it. Outreachr never receives or stores the subscription token, and the modes are mutually exclusive at runtime. A run receives only the checked data classes plus any explicit, revocable durable grants. Agents can research, summarize, and produce structured proposals, but they cannot directly send email, mutate arbitrary files, execute shell commands through Outreachr tools, or bypass founder approval.

## Backup, restore, import, and contribution

- **Encrypted backup** produces an authenticated, password-protected vault using memory-hard key derivation. Outreachr cannot recover the password.
- **Restore** decrypts into memory, migrates a replacement vault, and requires integrity and foreign-key checks before replacement.
- **Seed import** validates the expected database shape and package digest before merging public research.
- **Private CSV export** is for the founder’s own use.
- **Public contribution export** uses a strict allowlist. It excludes messages, approvals, send receipts, meetings, tasks, notes, connector configuration, secrets, audit history, and all private activity.
- **Audit CSV export** includes the append-only event sequence, prior hash, and entry hash. Settings verifies the chain before presenting it as healthy.

## Local deletion

Settings → Privacy & security offers a typed-confirmation reset. The app writes a narrow reset marker, restarts, deletes only its exact SQLite vault, and creates a fresh seeded workspace. Create an encrypted backup first if the data may be needed.
