#!/usr/bin/env node
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ClaudeAgentAdapter, createAllowlist } from '../packages/agents/dist/index.js';

if (process.env.OUTREACHR_LIVE_CLAUDE_SMOKE !== '1') {
  throw new Error(
    'Live Claude smoke is opt-in because it consumes subscription credit. Set OUTREACHR_LIVE_CLAUDE_SMOKE=1.',
  );
}

const workspaceDirectory = await mkdtemp(join(tmpdir(), 'outreachr-live-claude-'));
const adapter = new ClaudeAgentAdapter({
  workspaceDirectory,
  allowSubscriptionAuth: true,
  requestTimeoutMs: 5 * 60_000,
});

try {
  const detection = await adapter.detect();
  if (!detection.installed || !detection.authenticated) {
    throw new Error(
      `Claude subscription is not ready: ${detection.detail ?? 'run claude auth login --claudeai'}`,
    );
  }
  if (!detection.subscriptionAuthApproved || detection.authSource !== 'claude-code') {
    throw new Error('Claude detection did not select the approved official CLI subscription path.');
  }

  const runId = `live-claude-smoke:${Date.now()}`;
  const result = await adapter.run(
    runId,
    {
      provider: 'claude',
      intent:
        'Return a concise summary containing the exact words "Claude subscription smoke passed" and no proposals. Do not call tools.',
      allowlist: createAllowlist(),
      context: [],
      timeoutMs: 5 * 60_000,
      maxTurns: 1,
    },
    () => undefined,
  );
  if (!result.summary.includes('Claude subscription smoke passed')) {
    throw new Error(`Claude returned an unexpected completion summary: ${result.summary}`);
  }
  if (result.proposals.length !== 0) {
    throw new Error('Claude subscription smoke returned an unexpected proposal.');
  }
  console.log(
    JSON.stringify(
      {
        result: 'passed',
        provider: detection.provider,
        state: 'ready',
        version: detection.version,
        authSource: detection.authSource,
        runId,
        summary: result.summary,
      },
      null,
      2,
    ),
  );
} finally {
  await adapter.dispose();
  await rm(workspaceDirectory, { recursive: true, force: true, maxRetries: 3 });
}
