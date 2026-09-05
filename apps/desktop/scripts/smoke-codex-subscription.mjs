#!/usr/bin/env node
/* global window */
import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron } from '@playwright/test';
import { openNodeVault } from '@outreachr/core/node';

if (process.env.OUTREACHR_LIVE_CODEX_SMOKE !== '1') {
  throw new Error(
    'Live Codex smoke is opt-in because it uses the signed-in account. Set OUTREACHR_LIVE_CODEX_SMOKE=1.',
  );
}

const desktopRoot = resolve(import.meta.dirname, '..');
const withMcpProposal = process.argv.includes('--with-mcp-proposal');
const smokePrompt = withMcpProposal
  ? 'Use outreachr_propose_task exactly once to propose a task titled "Codex MCP smoke review" for founder review. Use no investor or person references, no due date, and no disclosed records or private fields. Do not call any other tools or apply the task. After the tool succeeds, return the exact summary "Codex subscription smoke passed" and an empty final proposals array.'
  : 'Verify that this local Codex integration is operational. Return a concise summary containing the exact words "Codex subscription smoke passed" and no proposals. Do not call tools.';
const packagedExecutable = process.env.OUTREACHR_PACKAGED_EXECUTABLE?.trim();
if (packagedExecutable) await access(packagedExecutable);
else {
  await access(join(desktopRoot, 'out', 'main', 'index.js'));
  await access(join(desktopRoot, 'resources', 'generated', 'sidecars', 'manifest.json'));
}

const dataDirectory = await mkdtemp(join(tmpdir(), 'outreachr-live-codex-'));
const logs = [];
let application;
let packagedProcess;

try {
  let result;
  if (packagedExecutable) {
    result = await runPackagedSmoke(packagedExecutable, dataDirectory, logs);
  } else {
    application = await electron.launch({
      args: [desktopRoot, `--user-data-dir=${dataDirectory}`],
      env: liveSmokeEnvironment(),
      timeout: 60_000,
    });
    application.process().stdout?.on('data', (chunk) => logs.push(String(chunk)));
    application.process().stderr?.on('data', (chunk) => logs.push(String(chunk)));
    const page = await application.firstWindow({ timeout: 60_000 });
    await page.waitForLoadState('domcontentloaded');

    const bootstrap = await page.evaluate(() => window.outreachr.bootstrap());
    if (bootstrap.isFirstRun) {
      await page.evaluate(() =>
        window.outreachr.command('onboarding.complete', {
          founderName: 'Live Smoke Founder',
          founderEmail: 'live-smoke@local.invalid',
          companyName: 'Outreachr Live Smoke',
          companyOneLiner:
            'An isolated local workspace used to verify the Codex subscription path.',
          stage: 'pre_seed',
          targetAmount: 1_000_000,
          targetCheckMinimum: 50_000,
          targetCheckMaximum: 250_000,
          sectors: ['Developer Tools'],
          geographies: ['United States'],
          narrative: 'Synthetic local smoke-test context.',
          postalAddress: '1 Local Test Way\nSan Francisco, CA 94107\nUnited States',
        }),
      );
    }

    const detection = await page.evaluate(() =>
      window.outreachr.command('agent.detect', { provider: 'codex' }),
    );
    if (detection.state !== 'ready') {
      throw new Error(`Codex is not ready: ${detection.error ?? detection.state}`);
    }

    await page.evaluate(() => {
      window.__outreachrLiveCodexEvents = [];
      window.__outreachrStopLiveCodexEvents = window.outreachr.onAgentEvent((event) => {
        window.__outreachrLiveCodexEvents.push(event);
      });
    });
    const { runId } = await page.evaluate(
      (prompt) =>
        window.outreachr.command('agent.run', {
          provider: 'codex',
          prompt,
          disclosedContextIds: [],
        }),
      smokePrompt,
    );

    await page.waitForFunction(
      (expectedRunId) =>
        window.__outreachrLiveCodexEvents?.some(
          (event) =>
            event.runId === expectedRunId && (event.type === 'completed' || event.type === 'error'),
        ),
      runId,
      { timeout: 5 * 60_000 },
    );
    const events = await page.evaluate((expectedRunId) => {
      window.__outreachrStopLiveCodexEvents?.();
      return (window.__outreachrLiveCodexEvents ?? []).filter(
        (event) => event.runId === expectedRunId,
      );
    }, runId);
    result = assertCompletion(detection, runId, events);
  }
  if (withMcpProposal) result.mcp = await assertPendingMcpProposal(dataDirectory, result.runId);
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  const detail = logs.join('').slice(-40_000);
  throw new Error(
    `${error instanceof Error ? error.message : String(error)}${detail ? `\nElectron logs:\n${detail}` : ''}`,
    { cause: error },
  );
} finally {
  if (application) {
    let timer;
    const closed = await Promise.race([
      application.close().then(
        () => true,
        () => false,
      ),
      new Promise((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout(false), 5_000);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (!closed && !application.process().killed) application.process().kill('SIGKILL');
  }
  if (packagedProcess?.pid) await terminateTree(packagedProcess.pid);
  await rm(dataDirectory, { recursive: true, force: true, maxRetries: 3 });
}

function liveSmokeEnvironment() {
  return {
    ...process.env,
    NODE_ENV: 'production',
    OUTREACHR_STARTUP_DIAGNOSTICS: '1',
    OUTREACHR_SMOKE_TEST: '1',
    ELECTRON_ENABLE_LOGGING: '1',
    ELECTRON_DISABLE_SECURITY_WARNINGS: 'false',
  };
}

async function runPackagedSmoke(executable, profile, output) {
  const debuggingPort = await availablePort();
  packagedProcess = spawn(
    executable,
    [
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${debuggingPort}`,
      '--remote-debugging-address=127.0.0.1',
      '--outreachr-smoke-test',
      '--disable-gpu',
    ],
    {
      env: liveSmokeEnvironment(),
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  packagedProcess.stdout?.on('data', (chunk) => output.push(String(chunk)));
  packagedProcess.stderr?.on('data', (chunk) => output.push(String(chunk)));
  const earlyExit = new Promise((_, reject) => {
    packagedProcess.once('error', reject);
    packagedProcess.once('exit', (code, signal) => {
      reject(new Error(`Packaged app exited before readiness (code=${code}, signal=${signal})`));
    });
  });
  const webSocketUrl = await Promise.race([waitForPageTarget(debuggingPort, 60_000), earlyExit]);
  const result = await evaluateCdp(webSocketUrl, packagedSmokeExpression(), 6 * 60_000);
  if (result?.error) throw new Error(result.error);
  return assertCompletion(result.detection, result.runId, result.events);
}

function packagedSmokeExpression() {
  return String.raw`(async () => {
    const bootstrap = await window.outreachr.bootstrap();
    if (bootstrap.isFirstRun) {
      await window.outreachr.command('onboarding.complete', {
        founderName: 'Live Smoke Founder',
        founderEmail: 'live-smoke@local.invalid',
        companyName: 'Outreachr Live Smoke',
        companyOneLiner: 'An isolated local workspace used to verify the Codex subscription path.',
        stage: 'pre_seed',
        targetAmount: 1000000,
        targetCheckMinimum: 50000,
        targetCheckMaximum: 250000,
        sectors: ['Developer Tools'],
        geographies: ['United States'],
        narrative: 'Synthetic local smoke-test context.',
        postalAddress: '1 Local Test Way\nSan Francisco, CA 94107\nUnited States'
      });
    }
    const detection = await window.outreachr.command('agent.detect', { provider: 'codex' });
    if (detection.state !== 'ready') {
      return { error: 'Codex is not ready: ' + (detection.error ?? detection.state) };
    }
    const events = [];
    const stop = window.outreachr.onAgentEvent((event) => events.push(event));
    const { runId } = await window.outreachr.command('agent.run', {
      provider: 'codex',
      prompt: ${JSON.stringify(smokePrompt)},
      disclosedContextIds: []
    });
    const deadline = Date.now() + 300000;
    while (Date.now() < deadline && !events.some((event) =>
      event.runId === runId && (event.type === 'completed' || event.type === 'error'))) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    stop();
    return { detection, runId, events: events.filter((event) => event.runId === runId) };
  })()`;
}

function assertCompletion(detection, runId, events) {
  const terminal = events.findLast((event) => event.type === 'completed' || event.type === 'error');
  if (!terminal || terminal.type !== 'completed') {
    throw new Error(`Codex run failed: ${terminal?.text ?? 'no terminal event'}`);
  }
  if (!terminal.text.includes('Codex subscription smoke passed')) {
    throw new Error(`Codex returned an unexpected completion summary: ${terminal.text}`);
  }
  return {
    result: 'passed',
    provider: detection.provider,
    state: detection.state,
    version: detection.version,
    runId,
    eventTypes: events.map((event) => event.type),
    summary: terminal.text,
  };
}

async function assertPendingMcpProposal(directory, runId) {
  // Inspect only the synthetic profile's persisted snapshot; never export or write it.
  const vault = await openNodeVault({ bytes: await readFile(join(directory, 'outreachr.sqlite')) });
  try {
    const completedCalls = Number(
      vault.scalar(
        "SELECT COUNT(*) FROM audit_log WHERE actor_id=? AND action='mcp.tool_succeeded' AND json_extract(detail_json,'$.toolName')='outreachr_propose_task'",
        [runId],
      ),
    );
    const pendingProposals = Number(
      vault.scalar(
        "SELECT COUNT(*) FROM agent_proposals WHERE agent_run_id=? AND status='pending' AND proposal_type='task' AND json_extract(payload_json,'$.title')='Codex MCP smoke review'",
        [runId],
      ),
    );
    const appliedTasks = Number(
      vault.scalar("SELECT COUNT(*) FROM tasks WHERE title='Codex MCP smoke review'"),
    );
    const sendReservations = Number(vault.scalar('SELECT COUNT(*) FROM send_ledger'));
    if (
      completedCalls !== 1 ||
      pendingProposals !== 1 ||
      appliedTasks !== 0 ||
      sendReservations !== 0
    )
      throw new Error(
        `MCP proposal boundary failed: ${JSON.stringify({ completedCalls, pendingProposals, appliedTasks, sendReservations })}`,
      );
    return { completedCalls, pendingProposals, appliedTasks, sendReservations };
  } finally {
    vault.close();
  }
}

async function waitForPageTarget(port, timeout) {
  const deadline = Date.now() + timeout;
  let lastError = 'DevTools endpoint not available';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (!response.ok) throw new Error(`DevTools HTTP ${response.status}`);
      const targets = await response.json();
      const target = targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
      if (target) return target.webSocketDebuggerUrl;
      lastError = 'No page target is ready';
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`Timed out waiting for packaged renderer: ${lastError}`);
}

async function evaluateCdp(webSocketUrl, expression, timeoutMs) {
  return await new Promise((resolveValue, reject) => {
    const socket = new WebSocket(webSocketUrl);
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error('Packaged Codex CDP evaluation timed out'));
    }, timeoutMs);
    socket.addEventListener('open', () => {
      socket.send(
        JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: { expression, returnByValue: true, awaitPromise: true },
        }),
      );
    });
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== 1) return;
      clearTimeout(timeout);
      socket.close();
      if (message.error || message.result?.exceptionDetails) {
        reject(
          new Error(
            `CDP evaluation failed: ${JSON.stringify(message.error ?? message.result.exceptionDetails)}`,
          ),
        );
      } else {
        resolveValue(message.result?.result?.value);
      }
    });
    socket.addEventListener('error', () => {
      clearTimeout(timeout);
      reject(new Error('Packaged Codex CDP WebSocket failed'));
    });
  });
}

async function availablePort() {
  return await new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : null;
      server.close((error) => {
        if (error) reject(error);
        else if (port) resolvePort(port);
        else reject(new Error('Could not allocate a renderer-debugging port'));
      });
    });
  });
}

async function terminateTree(pid) {
  if (process.platform === 'win32') {
    await new Promise((resolveExit) => {
      const killer = spawn('taskkill.exe', ['/pid', String(pid), '/t', '/f'], {
        windowsHide: true,
      });
      killer.once('close', resolveExit);
      killer.once('error', resolveExit);
    });
    return;
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      return;
    }
  }
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // The process tree exited cleanly after SIGTERM.
  }
}
