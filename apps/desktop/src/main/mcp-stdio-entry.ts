import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { serveOutreachrMcpOverStdio, privateFieldSchema } from '@outreachr/mcp';

import { DesktopMcpBridge } from './mcp-service';
import { VaultService } from './vault-service';

const APP_VERSION = '0.1.2';
const SESSION_ID = 'codex-local';
const PURPOSE = 'Manage Outreachr from Codex';

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith('--')) throw new Error(`${name} requires an explicit path.`);
  return resolve(value);
}

async function main(): Promise<void> {
  const vault = new VaultService({
    appVersion: APP_VERSION,
    platform: process.platform,
    dataDirectory: argument('--data-directory'),
    resourceDirectory: argument('--resource-directory'),
  });
  await vault.initialize();
  const integrity = vault.integrityCheck();
  if (!integrity.ok) {
    throw new Error(`Local SQLite integrity check failed: ${integrity.messages.join('; ')}`);
  }
  const auditIntegrity = vault.auditIntegrity();
  if (!auditIntegrity.ok) {
    throw new Error(
      `Local audit chain verification failed at ${auditIntegrity.errorAt ?? 'unknown'}.`,
    );
  }

  const runId = `agent-run:mcp:${randomUUID()}`;
  const startedAt = new Date().toISOString();
  vault.repository.createAgentRun({
    id: runId,
    provider: 'codex',
    model: null,
    purpose: PURPOSE,
    contextPolicy: { transport: 'stdio', sessionId: SESSION_ID },
    status: 'running',
    startedAt,
    completedAt: null,
    errorDetail: null,
    createdAt: startedAt,
  });
  await vault.persist();

  const snapshot = await vault.bootstrap();
  const disclosedRecordIds = [
    ...(snapshot.round ? [snapshot.round.id] : []),
    ...snapshot.investors.map((item) => item.id),
    ...snapshot.people.map((item) => item.id),
    ...snapshot.tasks.map((item) => item.id),
    ...snapshot.meetings.map((item) => item.id),
    ...snapshot.knowledge.map((item) => item.id),
    ...snapshot.drafts.map((item) => item.id),
  ];
  const bridge = await DesktopMcpBridge.start({ vault, appVersion: APP_VERSION });
  const connection = bridge.registerSession({
    runId: SESSION_ID,
    provider: 'codex',
    purpose: PURPOSE,
    readScopes: ['round', 'company', 'investors', 'activity'],
    disclosedRecordIds,
    allowedPrivateFields: [...privateFieldSchema.options],
    onProposal: async (proposal) => {
      vault.repository.createAgentProposal({
        id: proposal.id,
        agentRunId: runId,
        proposalType: proposal.kind,
        payload: proposal,
        status: 'pending',
        reviewedAt: null,
        createdAt: new Date().toISOString(),
      });
      await vault.persist();
    },
  });
  const running = await serveOutreachrMcpOverStdio(bridge.serviceForSession(SESSION_ID), {
    name: 'outreachr-codex',
    version: APP_VERSION,
    enabledTools: connection.enabledTools,
  });

  let closing = false;
  const close = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    const completedAt = new Date().toISOString();
    vault.vault.run(
      "UPDATE agent_runs SET status='completed',completed_at=? WHERE id=? AND status='running'",
      [completedAt, runId],
    );
    await vault.persist().catch(() => undefined);
    await running.close().catch(() => undefined);
    await bridge.dispose().catch(() => undefined);
    vault.vault.close();
  };
  process.once('SIGINT', () => void close().finally(() => process.exit(0)));
  process.once('SIGTERM', () => void close().finally(() => process.exit(0)));
  process.once('beforeExit', () => void close());
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `Outreachr MCP failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
