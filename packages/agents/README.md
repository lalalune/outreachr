# `@outreachr/agents`

Local, proposal-only Codex and Claude adapters for Outreachr. This package never operates an Outreachr cloud service, never proxies credentials, and never applies a proposal. The desktop host is responsible for presenting every proposal to the founder and applying an approved change through its ordinary audited command path.

## Security boundary

- Agent authority comes from a versioned `DurableAgentAllowlist`. Grants can be scoped to providers, rounds, or investors and are revoked in place for an auditable history.
- The authority vocabulary contains reads and proposals only. There is no send, schedule, publish, delete, connector-write, or arbitrary mutation capability.
- Context records are filtered before prompting. Content inside CRM records is explicitly treated as untrusted data.
- Structured output is validated again after generation. Executable actions and fields such as `send`, `dispatch`, `provider_message_id`, and `delete` fail closed.
- Codex uses `codex app-server` over local JSONL stdio. Runs clear inherited MCP/app configuration, disable web search, use `approvalPolicy: "never"`, a restricted read-only sandbox, an ephemeral thread, and an isolated host-provided directory. The only permitted tool items are exact names from the current run's scope-derived, authenticated loopback Outreachr MCP connection; every other tool item or app-server approval request is denied.
- Claude Agent SDK runs with `tools: []`, no plugins or settings sources, `permissionMode: "dontAsk"`, no transcript persistence, and an isolated directory. `strictMcpConfig` injects only the authenticated loopback Outreachr server; `allowedTools` and `canUseTool` permit only the current run's exact scope-derived read and safe-proposal names and interrupt everything else.
- Both child runtimes receive an explicit environment allowlist containing only required platform paths, locale/proxy settings, provider auth variables, and provider-home overrides. Unrelated GitHub, cloud, database, and shell secrets are never inherited.
- Provider processes make their normal direct connection to the provider. Outreachr adds no relay, telemetry service, or credential backend.

These controls are defense in depth. The host should use a new, empty directory for each adapter; keep all credentials in the OS credential store; and never put private founder activity into public seed exports.

## Codex setup (ChatGPT subscription or API key)

1. Install the official [Codex CLI](https://learn.chatgpt.com/docs/codex/cli).
2. In Outreachr, choose **Sign in with ChatGPT** or the device-code flow. The adapter calls the official local `account/login/start` app-server method and the frontend opens the returned OpenAI URL.
3. The adapter first writes `cli_auth_credentials_store = "keyring"`. It deliberately will not fall back to plaintext `~/.codex/auth.json`.
4. An API-key user can set `OPENAI_API_KEY` locally and run the official `printenv OPENAI_API_KEY | codex login --with-api-key` flow. Outreachr does not persist that value in this package.

The ChatGPT browser callback is hosted locally by `codex app-server`; token refresh and logout are also owned by Codex. See the official [Codex authentication guide](https://learn.chatgpt.com/docs/auth) and [app-server protocol](https://learn.chatgpt.com/docs/app-server).

## Claude setup (API key or explicitly approved subscription access)

Claude authentication is API-key-only by default. Outreachr does **not** embed a Claude.ai login page, proxy credentials, or accept `CLAUDE_CODE_OAUTH_TOKEN` setup tokens.

- Create an API key in the [Anthropic Console](https://console.anthropic.com/settings/keys).
- In Outreachr, open **Settings → Agents**, paste the key into the write-only password field, and save it. The desktop host encrypts the value with the operating-system credential facility before storing only ciphertext in the local vault; the renderer cannot read it back and clears the field after every attempt.
- `ANTHROPIC_API_KEY` remains an optional founder-controlled launch-environment override for developers. API-key mode passes that key and strips `CLAUDE_CODE_OAUTH_TOKEN` and unrelated secrets from every child environment.
- Removing the saved key clears the in-memory adapter immediately after the encrypted vault update succeeds. Outreachr never logs, exports, contributes, or returns the plaintext key.

If Anthropic has approved this third-party integration, the founder can explicitly enable the separate approved-subscription mode:

1. Run `claude auth login --claudeai` in a local terminal and complete the official Claude Code sign-in.
2. Enable **Anthropic-approved subscription authentication** in Outreachr, then detect Claude again.
3. Outreachr relies on the official local Claude Code keychain/config session. It does not receive, persist, export, or log the session token, and it never logs out or otherwise changes the founder's independent Claude Code session.

The two modes are mutually exclusive at runtime. Approved-subscription mode strips both `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN`; switching back restores the locally saved API key without exposing it to the renderer. Authentication mode and credentials cannot change during an active run. All proposal-only tool restrictions are identical in both modes.

This opt-in does not represent blanket Anthropic approval and is not legal advice. Review Anthropic's current [authentication guide](https://code.claude.com/docs/en/authentication), [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview), and [legal/compliance guide](https://code.claude.com/docs/en/legal-and-compliance) before distribution; if those terms or an integration's approval change, disable the setting and update the fail-closed policy and tests.

## Minimal host usage

```ts
import {
  AgentRuntime,
  ClaudeAgentAdapter,
  CodexAgentAdapter,
  createAllowlist,
  grantCapability,
} from '@outreachr/agents';

const isolated = '/absolute/path/to/an/empty/runtime-directory';
const runtime = new AgentRuntime({
  adapters: [
    new CodexAgentAdapter({ workspaceDirectory: isolated }),
    new ClaudeAgentAdapter({ workspaceDirectory: isolated }),
  ],
});

let allowlist = createAllowlist();
allowlist = grantCapability(allowlist, { capability: 'read.investors' });
allowlist = grantCapability(allowlist, { capability: 'propose.draft' });

const handle = runtime.run({
  provider: 'codex',
  intent: 'Propose a concise follow-up draft for the supplied investor.',
  allowlist,
  context: [
    {
      id: 'investor-1',
      capability: 'read.investors',
      investorId: 'investor-1',
      data: { name: 'Example Ventures' },
    },
  ],
});

const result = await handle.result; // still proposals only; nothing was sent or written
```

Packaged Electron builds can resolve the release sidecars without guessing:

```ts
import { join } from 'node:path';
import { resolvePackagedAgentExecutables } from '@outreachr/agents';

const sidecars = resolvePackagedAgentExecutables(join(process.resourcesPath, 'resources'));
// sidecars.codex  -> resources/sidecars/codex/bin/codex(.exe)
// sidecars.claude -> resources/sidecars/claude/claude(.exe)
// sidecars.manifest -> resources/sidecars/manifest.json
```

Pass `sidecars.codex` / `sidecars.claude` through each adapter’s `executable` option. Development installations can inject `codex` and `claude` from `PATH` instead.

## Testing

`ClaudeQueryFactory`, `CodexRpcClient`, `CommandRunner`, and `ProcessSpawner` are injectable. Tests use fakes and in-memory streams; they never contact OpenAI, Anthropic, or a real local login.

```bash
pnpm --filter @outreachr/agents typecheck
pnpm --filter @outreachr/agents test
pnpm --filter @outreachr/agents build
```

Licensed under Apache-2.0. See `LICENSE`.
