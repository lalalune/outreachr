# Codex and Claude agents

Outreachr does not bundle a model or proxy a vendor login. Agents are optional: the rest of the desktop app works without either provider. Codex supports the vendor-owned ChatGPT sign-in flow. Claude uses either a founder-owned Anthropic API key or an existing local Claude subscription session when Anthropic has approved the third-party integration and the founder explicitly enables that mode.

## Codex

Outreachr detects the packaged or installed Codex executable and starts its local app-server protocol. In **Settings → Agents**, select **Sign in**, complete the official ChatGPT/Codex browser flow, return to Outreachr, and select **Detect** if the state has not refreshed. The Codex process owns its authentication and stores it in the operating-system keyring; Outreachr does not receive or store the ChatGPT credential. See [Codex authentication](https://learn.chatgpt.com/docs/auth) and the [Codex CLI guide](https://learn.chatgpt.com/docs/codex/cli).

The integration sends a bounded prompt and selected local context. Codex app-server starts with inherited MCP servers and apps cleared, web search disabled, an empty environment/capability selection, `approvalPolicy: "never"`, and a restricted read-only sandbox. A run receives only Outreachr's authenticated loopback MCP endpoint and its exact tool allowlist. Any unexpected built-in, app, or MCP tool item interrupts the turn.

## Claude

Outreachr uses the official Claude Agent SDK with the packaged or installed Claude Code executable. Anthropic's current [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview) says third-party subscription authentication requires prior approval. Outreachr therefore leaves subscription access off by default and never enables it merely because a local Claude login is detected. See [Claude Code authentication](https://code.claude.com/docs/en/authentication), [API authentication](https://platform.claude.com/docs/en/manage-claude/authentication), and [Anthropic legal and compliance](https://code.claude.com/docs/en/legal-and-compliance).

### API-key mode

1. Create a founder-owned key in the [Anthropic Console](https://console.anthropic.com/settings/keys). API usage is billed by Anthropic, so this integration is optional.
2. Open **Settings → Agents** and paste the key into **Anthropic API key**. Do not paste a Claude subscription token or setup token.
3. Select **Save encrypted API key**. The write-only field clears after every attempt. The key crosses the typed preload command once, is encrypted in the main process with Electron's operating-system credential facility, and only ciphertext is stored in the local SQLite vault. Bootstrap/status responses never return it, and production diagnostics must never log it.
4. Select **Detect** if Claude does not show **Ready**. Use **Remove stored API key** to delete the local ciphertext. Credentials are single-device; a restored vault still requires the operating-system credential context that encrypted it.

Saving an API key makes API-key mode active. A previously saved key may remain encrypted as a fallback while subscription mode is enabled, but it is removed from the Agent SDK child environment in that mode.

### Anthropic-approved subscription mode

1. Confirm that Anthropic has approved this Outreachr deployment for third-party subscription authentication. Approval for one distributor or deployment may not transfer to a fork.
2. Run `claude auth login --claudeai` in a local terminal and complete the official Claude Code sign-in.
3. In **Settings → Agents**, check the founder attestation and select **Enable subscription access**, then select **Detect**.
4. To stop using the subscription in Outreachr, select **Disable subscription access**. Outreachr does not log out or alter the independent Claude Code session.

The approval choice and timestamp are non-secret device-local preferences in SQLite. OAuth credentials remain owned by the official Claude runtime and its OS keychain/config; Outreachr never asks for, copies, stores, returns, exports, or logs them. `CLAUDE_CODE_OAUTH_TOKEN` setup tokens are unsupported and stripped. Subscription mode also strips `ANTHROPIC_API_KEY`, making the two billing/authentication paths mutually exclusive. Anthropic currently describes subscription Agent SDK usage as drawing from separate plan credit and applying current plan limits.

Outreachr identifies the local subprocess as `outreachr/0.1.2` and disables built-in tools, plugins, skills, subagents, settings sources, filesystem additions, and persistent sessions. `strictMcpConfig` permits only Outreachr's authenticated loopback MCP server. The permission callback allows only exact `mcp__outreachr__…` names from the run allowlist and interrupts every other tool attempt. These restrictions are identical in API-key and approved-subscription modes, and authentication cannot change during an active run.

Anthropic's product and legal guidance can change. Distributors must re-check the official authentication and Agent SDK terms before each release; this document is an implementation constraint, not legal advice.

## Disclosure model

Each run lists exactly which context classes may be disclosed: round, company knowledge, selected investors, or private activity. Checking a class is explicit authorization for that run only. Private activity includes local tasks, meetings, drafts, synchronized mail observations, and pending agent proposals; it is omitted unless selected. Durable, provider-specific defaults are visible and revocable, but are not required for a one-time selection. The desktop host expands the run selection into the exact record IDs actually present in the filtered prompt. Every MCP call must repeat the active provider, run ID, purpose, a unique request ID, and the minimum requested record/field subset. Host authorization binds those values to the authenticated active run rather than trusting model-supplied audit fields. Sensitive values are not placed in command-line arguments or logs.

## Proposal-only boundary

Embedded Codex and Claude runs can use the following read-tool families, but each run advertises and configures only the families selected in its founder-disclosed context classes:

- investors: `outreachr_search_investors`, `outreachr_list_investors`, `outreachr_get_investor`, `outreachr_search_people`, `outreachr_list_people`, `outreachr_get_person`, `outreachr_get_pipeline`
- round: `outreachr_get_round`
- company knowledge: `outreachr_list_knowledge`
- private activity: `outreachr_list_tasks`, `outreachr_list_meetings`, `outreachr_list_activity`

Read tools outside the active classes are absent from MCP discovery, the provider configuration, and pre-dispatch HTTP authorization; the service layer repeats the same check as defense in depth. Runs enable only three proposal tools: `outreachr_propose_stage`, `outreachr_propose_task`, and `outreachr_propose_draft`. Each creates a durable `pending` proposal through the ordinary agent event path. It cannot approve or apply the proposal. Draft proposals are limited to a new initial message; no MCP method can send, queue, retry, schedule, or write to a provider.

The bridge binds only `127.0.0.1` on an ephemeral port, requires an ephemeral 256-bit bearer credential plus an active run header, rejects non-POST/oversized/non-JSON requests, and unregisters a run on completion, cancellation, launch failure, or disposal. Unsafe MCP calls fail before dispatch. There is no raw SQL, browser, open-network, arbitrary filesystem, shell, credential, email-send, or calendar-send tool. SQLite validation, founder review, communication deduplication, and connector safety checks remain authoritative even if an agent produces malformed or adversarial output.

## External Codex MCP

The desktop build includes a local stdio MCP entrypoint so the same vault can be operated from the Codex app. Build the desktop app, then register `apps/desktop/out/main/mcp-stdio.js` with `codex mcp add outreachr`, passing explicit `--data-directory` and `--resource-directory` arguments. The host validates SQLite integrity and the append-only audit chain before serving tools.

This entrypoint exposes the same 12 read tools and three founder-reviewable proposal tools as embedded agents. It cannot approve or dispatch outreach. Because SQL.js persists whole-vault snapshots, do not keep the desktop UI and standalone MCP process open against the same vault at the same time; close the app while Codex is using the server and reopen it to review proposals.
