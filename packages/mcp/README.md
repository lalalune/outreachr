# `@outreachr/mcp`

A local, fail-closed [Model Context Protocol](https://modelcontextprotocol.io/) server for Outreachr. The package uses `@modelcontextprotocol/sdk` `1.30.0` and exposes a deliberately narrow interface between a founder-authorized agent and the local fundraising vault.

## Safety boundary

The server registers only bounded reads and pending-proposal creation. There is no tool for:

- sending, approving, queuing, or retrying a message;
- OAuth, tokens, credentials, or connector configuration;
- backups, imports, exports, or contribution packages;
- raw SQL, database handles, files, directories, network fetching, or shell execution.

Proposal tools do not apply their proposed operation. Every successful proposal result is schema-enforced to have `status: "pending_founder_approval"`. The host application must show the exact proposal to the founder and use a separate, non-MCP approval path.

## Registered tools

Read tools:

- `outreachr_search_investors`, `outreachr_list_investors`, `outreachr_get_investor`
- `outreachr_search_people`, `outreachr_list_people`, `outreachr_get_person`
- `outreachr_get_pipeline`, `outreachr_get_round`
- `outreachr_list_tasks`, `outreachr_list_meetings`, `outreachr_list_knowledge`, `outreachr_list_activity`

Proposal tools:

- `outreachr_propose_target`, `outreachr_propose_stage`
- `outreachr_propose_task`, `outreachr_propose_meeting`, `outreachr_propose_knowledge`
- `outreachr_propose_draft`, `outreachr_propose_source_review`

Tool definitions include standard MCP safety annotations and namespaced machine-readable metadata: risk level, side effect, founder-approval requirement, local data boundary, default redaction, required audit context, and the explicit forbidden-capability list.

## Host integration

The Electron main process implements `OutreachrMcpService`; the package never imports Electron or `@outreachr/core` and never receives a database or secret-store handle.

```ts
import { serveOutreachrMcpOverStdio } from '@outreachr/mcp';
import { createDesktopMcpAdapter } from './mcp-adapter.js';

const service = createDesktopMcpAdapter();
const running = await serveOutreachrMcpOverStdio(service, {
  name: 'outreachr-desktop',
  version: app.getVersion(),
});

app.once('before-quit', () => {
  void running.close();
});
```

The desktop build also emits `out/main/mcp-stdio.js` for trusted local Codex clients. It accepts only explicit vault and packaged-resource directories, creates the same desktop adapter in process, verifies SQLite and audit-chain integrity on startup, and exposes the desktop tool allowlist. It does not load arbitrary adapter modules.

Build and register the local server with Codex:

```sh
pnpm --filter @outreachr/desktop build
codex mcp add outreachr -- \
  "$(command -v node)" \
  "$PWD/apps/desktop/out/main/mcp-stdio.js" \
  --data-directory "$HOME/Library/Application Support/@outreachr/desktop" \
  --resource-directory "$PWD/apps/desktop/resources/generated"
```

The standalone stdio server and desktop UI should not edit the same SQL.js vault concurrently. Close Outreachr before starting a Codex task that uses the standalone server, then reopen the app to review any pending proposals. The MCP still cannot approve or send messages.

## Authorization and redaction

Every call carries bounded audit context and a requested access subset. The adapter's `authorizeAccess` method must check the session's current, revocable disclosure allowlist. The server rejects grants that exceed both the request and `audit.disclosedContextIds`.

Public investor and person facts remain readable. These workspace fields are redacted unless the adapter grants the exact records and fields:

- contact details;
- workflow state and round-specific fit scoring;
- notes and narrative;
- knowledge content;
- activity detail;
- meeting attendees;
- round financials.

Pipeline, round, task, meeting, knowledge, and activity records are omitted entirely unless one of their scoped IDs is authorized. The server validates untrusted adapter output before and after redaction. A malformed or oversized response becomes a generic error; raw validation or service errors are never returned to the client.

Every service method receives `ServiceInvocationContext`, including a UUID invocation ID, tool/risk identity, bounded audit fields, requested access, and the host grant. The server records `requested` and `succeeded`/`failed` audit events. If the initial or final audit write fails, the operation fails closed.

## Limits

- list and search page size: 1–50 records (knowledge: 1–25);
- cursor: 512 characters;
- disclosure IDs: 100;
- draft or knowledge body: 20,000 characters;
- every ID, URL, string, enum, timestamp, service output, redacted output, and proposal result is validated with Zod.

## Verify

```sh
npm install
npm run verify
```

The Vitest suite connects a real SDK client to the server over linked in-memory MCP transports. It checks discovery metadata, public redaction, scoped private disclosure, authorization overreach, proposal-only behavior, service-output rejection, size and schema limits, audit failure behavior, and negative calls for message-send and raw-SQL tool names.

`npm run test:coverage` enforces at least 90% statements, 90% functions, 90% lines, and 65% branches. The current suite has 42 passing MCP integration tests.

## License

Apache-2.0. See `LICENSE`.
