import { resolve } from 'node:path';

import type { Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, vi } from 'vitest';

import {
  CLAUDE_DISALLOWED_TOOLS,
  ClaudeAgentAdapter,
  sanitizeClaudeEnvironment,
  type ClaudeQueryFactory,
} from '../src/claude.js';
import type { CommandRunner } from '../src/process.js';
import { mcpConnection, runRequest, validRawResult } from './helpers.js';

function fakeQuery(messages: readonly SDKMessage[], close = vi.fn()): Query {
  const generator = (async function* () {
    for (const message of messages) yield message;
  })();
  return Object.assign(generator, { close }) as unknown as Query;
}

function resultMessage(result: unknown = validRawResult): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    result: JSON.stringify(result),
    structured_output: result,
    permission_denials: [],
  } as unknown as SDKMessage;
}

const installedWithCliAuth: CommandRunner = vi.fn(async (_command, args) => {
  if (args[0] === '--version') return { exitCode: 0, stdout: '2.1.0 (Claude Code)\n', stderr: '' };
  if (args.join(' ') === 'auth status --json') {
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        loggedIn: true,
        email: 'founder@example.com',
        subscriptionType: 'max',
      }),
      stderr: '',
    };
  }
  return { exitCode: 0, stdout: '', stderr: '' };
});
const resolvedWorkspaceDirectory = resolve('/tmp/outreachr-agent');

describe('ClaudeAgentAdapter', () => {
  it('detects but does not route an independently authenticated Claude subscription', async () => {
    const adapter = new ClaudeAgentAdapter({
      workspaceDirectory: '/tmp/outreachr-agent',
      commandRunner: installedWithCliAuth,
      environment: { PATH: '/bin', HOME: '/tmp/home' },
    });
    await expect(adapter.detect()).resolves.toMatchObject({
      provider: 'claude',
      installed: true,
      authenticated: false,
      authSource: 'claude-code',
      subscriptionAuthApproved: false,
      accountLabel: 'founder@example.com',
      plan: 'max',
      detail: expect.stringContaining('Enable Anthropic-approved subscription authentication'),
    });
  });

  it('routes an explicitly approved official Claude Code session through local keychain/config', async () => {
    let captured: Options | undefined;
    const adapter = new ClaudeAgentAdapter({
      workspaceDirectory: '/tmp/outreachr-agent',
      queryFactory: ({ options }) => {
        captured = options;
        return fakeQuery([resultMessage()]);
      },
      commandRunner: installedWithCliAuth,
      environment: {
        PATH: '/bin',
        HOME: '/tmp/founder-home',
        ANTHROPIC_API_KEY: 'must-not-pass-in-subscription-mode',
        CLAUDE_CODE_OAUTH_TOKEN: 'setup-token-must-never-pass',
      },
      allowSubscriptionAuth: true,
    });

    await expect(adapter.status()).resolves.toMatchObject({
      authenticated: true,
      authSource: 'claude-code',
      subscriptionAuthApproved: true,
      accountLabel: 'founder@example.com',
      plan: 'max',
      detail: expect.stringContaining('official local Claude Code keychain/config session'),
    });
    await expect(
      adapter.run('run-subscription', runRequest('claude'), vi.fn()),
    ).resolves.toMatchObject({
      summary: 'One draft proposed.',
    });
    expect(captured?.env).toMatchObject({
      PATH: '/bin',
      HOME: '/tmp/founder-home',
    });
    expect(captured?.env?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(captured?.env?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  it('ignores subscription setup tokens and recognizes founder-controlled API keys', async () => {
    const runner: CommandRunner = async (_command, args) =>
      args[0] === '--version'
        ? { exitCode: 0, stdout: 'Claude Code 2', stderr: '' }
        : { exitCode: 0, stdout: '{"loggedIn":false}', stderr: '' };
    const setup = new ClaudeAgentAdapter({
      workspaceDirectory: '/tmp/outreachr-agent',
      commandRunner: runner,
      environment: { PATH: '/bin', CLAUDE_CODE_OAUTH_TOKEN: 'token' },
    });
    await expect(setup.status()).resolves.toMatchObject({
      authenticated: false,
      authSource: 'none',
      subscriptionAuthApproved: false,
    });
    const api = new ClaudeAgentAdapter({
      workspaceDirectory: '/tmp/outreachr-agent',
      commandRunner: runner,
      environment: { CLAUDE_CODE_OAUTH_TOKEN: 'token', ANTHROPIC_API_KEY: 'key' },
    });
    await expect(api.status()).resolves.toMatchObject({
      authenticated: true,
      authSource: 'anthropic-api-key',
      subscriptionAuthApproved: false,
    });
  });

  it('offers API-key setup and gates official CLI login behind explicit approval', async () => {
    const adapter = new ClaudeAgentAdapter({
      workspaceDirectory: '/tmp/outreachr-agent',
      commandRunner: installedWithCliAuth,
    });
    await expect(adapter.login({ provider: 'claude', mode: 'official-cli' })).rejects.toThrow(
      'subscription authentication is disabled',
    );
    await expect(adapter.login({ provider: 'claude', mode: 'setup-token' })).rejects.toThrow(
      'never accepts or passes CLAUDE_CODE_OAUTH_TOKEN',
    );
    await expect(adapter.login({ provider: 'claude', mode: 'api-key' })).resolves.toMatchObject({
      kind: 'environment',
      environmentVariable: 'ANTHROPIC_API_KEY',
      instructions: expect.stringContaining('Settings → Agents'),
    });
    await expect(adapter.login({ provider: 'claude', mode: 'device-code' })).rejects.toThrow(
      'requires a founder-controlled Anthropic API key',
    );
    await expect(adapter.login({ provider: 'codex', mode: 'browser' })).rejects.toThrow('mismatch');

    adapter.setSubscriptionAuthApproved(true);
    await expect(adapter.login({ provider: 'claude', mode: 'official-cli' })).resolves.toEqual({
      provider: 'claude',
      kind: 'external-command',
      command: 'claude auth login --claudeai',
      instructions: expect.stringContaining('official Claude Code command'),
    });
    await expect(adapter.login({ provider: 'claude', mode: 'browser' })).resolves.toMatchObject({
      kind: 'external-command',
      command: 'claude auth login --claudeai',
    });
    await expect(adapter.login({ provider: 'claude', mode: 'setup-token' })).rejects.toThrow(
      'never accepts or passes CLAUDE_CODE_OAUTH_TOKEN',
    );
  });

  it('hot-swaps only valid API keys and refuses credential changes during a run', async () => {
    let captured: Options | undefined;
    let release!: () => void;
    const queryFactory: ClaudeQueryFactory = ({ options }) => {
      captured = options;
      const generator = (async function* () {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        yield resultMessage();
      })();
      return Object.assign(generator, { close: vi.fn() }) as unknown as Query;
    };
    const adapter = new ClaudeAgentAdapter({
      workspaceDirectory: '/tmp/outreachr-agent',
      queryFactory,
      commandRunner: async (_command, args) =>
        args[0] === '--version'
          ? { exitCode: 0, stdout: 'Claude Code', stderr: '' }
          : { exitCode: 0, stdout: '{"loggedIn":false}', stderr: '' },
      environment: {},
    });
    expect(() => adapter.setApiKey('too-short')).toThrow('format is invalid');
    adapter.setApiKey('  sk-ant-founder-controlled-credential  ');
    await expect(adapter.status()).resolves.toMatchObject({
      authenticated: true,
      authSource: 'anthropic-api-key',
    });
    const pending = adapter.run('run-key-swap', runRequest('claude'), vi.fn());
    await vi.waitFor(() =>
      expect(captured?.env?.ANTHROPIC_API_KEY).toBe('sk-ant-founder-controlled-credential'),
    );
    expect(() => adapter.setApiKey('sk-ant-replacement-credential')).toThrow(
      'cannot change while a run is active',
    );
    expect(() => adapter.setSubscriptionAuthApproved(true)).toThrow(
      'cannot change while a run is active',
    );
    release();
    await expect(pending).resolves.toMatchObject({ summary: 'One draft proposed.' });

    adapter.setSubscriptionAuthApproved(true);
    await expect(adapter.status()).resolves.toMatchObject({
      authenticated: false,
      authSource: 'none',
      subscriptionAuthApproved: true,
    });
    adapter.setSubscriptionAuthApproved(false);
    await expect(adapter.status()).resolves.toMatchObject({
      authenticated: true,
      authSource: 'anthropic-api-key',
      subscriptionAuthApproved: false,
    });
    adapter.setApiKey(null);
    await expect(adapter.status()).resolves.toMatchObject({
      authenticated: false,
      authSource: 'none',
    });
  });

  it('invokes the SDK with every tool surface disabled and parses structured proposals', async () => {
    let captured: { prompt: string; options: Options } | undefined;
    const close = vi.fn();
    const queryFactory: ClaudeQueryFactory = (params) => {
      captured = params;
      return fakeQuery(
        [
          {
            type: 'assistant',
            message: { content: [{ type: 'text', text: '{"stream":"delta"}' }] },
          } as unknown as SDKMessage,
          resultMessage(),
        ],
        close,
      );
    };
    const adapter = new ClaudeAgentAdapter({
      workspaceDirectory: '/tmp/outreachr-agent',
      queryFactory,
      commandRunner: async () => ({ exitCode: 0, stdout: 'Claude Code', stderr: '' }),
      environment: { PATH: '/bin', ANTHROPIC_API_KEY: 'secret', UNRELATED_SECRET: 'must-not-pass' },
      defaultModel: 'claude-safe',
    });
    const emit = vi.fn();
    const result = await adapter.run('run-claude', runRequest('claude'), emit);
    expect(result.proposals[0]).toMatchObject({ kind: 'draft', executable: false });
    expect(captured?.options).toMatchObject({
      cwd: resolvedWorkspaceDirectory,
      tools: [],
      allowedTools: [],
      permissionMode: 'dontAsk',
      settingSources: [],
      strictMcpConfig: true,
      mcpServers: {},
      plugins: [],
      agents: {},
      skills: [],
      additionalDirectories: [],
      persistSession: false,
      maxTurns: 1,
      model: 'claude-safe',
    });
    expect(captured?.options.disallowedTools).toEqual(CLAUDE_DISALLOWED_TOOLS);
    expect(captured?.options.env?.UNRELATED_SECRET).toBeUndefined();
    expect(captured?.options.env?.ANTHROPIC_API_KEY).toBe('secret');
    expect(captured?.options.env?.CLAUDE_AGENT_SDK_CLIENT_APP).toBe('outreachr/0.1.2');
    await expect(
      captured?.options.canUseTool?.(
        'Bash',
        {},
        {
          signal: new AbortController().signal,
          toolUseID: 'tool-test',
          requestId: 'request-test',
        },
      ),
    ).resolves.toMatchObject({
      behavior: 'deny',
      interrupt: true,
    });
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'run.output_delta' }));
    expect(close).toHaveBeenCalled();
  });

  it('aborts immediately if Claude emits any tool use or reports a denied tool', async () => {
    const toolQuery: ClaudeQueryFactory = () =>
      fakeQuery([
        {
          type: 'assistant',
          message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'WebFetch', input: {} }] },
        } as unknown as SDKMessage,
      ]);
    const adapter = new ClaudeAgentAdapter({
      workspaceDirectory: '/tmp/outreachr-agent',
      queryFactory: toolQuery,
      commandRunner: async () => ({ exitCode: 0, stdout: 'Claude', stderr: '' }),
      environment: { ANTHROPIC_API_KEY: 'key' },
    });
    await expect(adapter.run('run-tool', runRequest('claude'), vi.fn())).rejects.toThrow(
      'forbidden tool',
    );

    const denied = new ClaudeAgentAdapter({
      workspaceDirectory: '/tmp/outreachr-agent',
      queryFactory: () =>
        fakeQuery([
          {
            type: 'result',
            subtype: 'success',
            result: JSON.stringify(validRawResult),
            permission_denials: [{ tool_name: 'Read' }],
          } as unknown as SDKMessage,
        ]),
      commandRunner: async () => ({ exitCode: 0, stdout: 'Claude', stderr: '' }),
      environment: { ANTHROPIC_API_KEY: 'key' },
    });
    await expect(denied.run('run-denied', runRequest('claude'), vi.fn())).rejects.toThrow(
      'attempted a tool',
    );
  });

  it('uses strict loopback MCP config and allows only exact Outreachr read/safe-proposal tools', async () => {
    let captured: Options | undefined;
    const adapter = new ClaudeAgentAdapter({
      workspaceDirectory: '/tmp/outreachr-agent',
      queryFactory: (params) => {
        captured = params.options;
        return fakeQuery([
          {
            type: 'assistant',
            message: {
              content: [
                {
                  type: 'tool_use',
                  id: 'tool-allowed',
                  name: 'mcp__outreachr__outreachr_get_round',
                  input: {},
                },
              ],
            },
          } as unknown as SDKMessage,
          resultMessage(),
        ]);
      },
      commandRunner: async () => ({ exitCode: 0, stdout: 'Claude', stderr: '' }),
      environment: { ANTHROPIC_API_KEY: 'key' },
    });
    const connection = {
      ...mcpConnection('run-mcp'),
      enabledTools: [
        'outreachr_get_round',
        'outreachr_propose_stage',
        'outreachr_propose_task',
        'outreachr_propose_draft',
      ] as const,
    };
    await expect(
      adapter.run('run-mcp', { ...runRequest('claude'), mcp: connection, maxTurns: 4 }, vi.fn()),
    ).resolves.toMatchObject({ summary: 'One draft proposed.' });
    expect(captured).toMatchObject({
      tools: [],
      maxTurns: 4,
      strictMcpConfig: true,
      settingSources: [],
      mcpServers: {
        outreachr: {
          type: 'http',
          url: 'http://127.0.0.1:43123/mcp',
          headers: {
            Authorization: expect.stringMatching(/^Bearer .{32,}$/u),
            'X-Outreachr-Session': 'run-mcp',
          },
          alwaysLoad: true,
        },
      },
    });
    expect(captured?.allowedTools).toEqual([
      'mcp__outreachr__outreachr_get_round',
      'mcp__outreachr__outreachr_propose_stage',
      'mcp__outreachr__outreachr_propose_task',
      'mcp__outreachr__outreachr_propose_draft',
    ]);
    expect(captured?.allowedTools).not.toContain('mcp__outreachr__outreachr_search_investors');
    expect(captured?.allowedTools).not.toContain('mcp__outreachr__outreachr_propose_target');
    await expect(
      captured?.canUseTool?.(
        'mcp__outreachr__outreachr_propose_task',
        {},
        {
          signal: new AbortController().signal,
          toolUseID: 'allowed',
          requestId: 'request-allowed',
        },
      ),
    ).resolves.toEqual({ behavior: 'allow' });
    await expect(
      captured?.canUseTool?.(
        'mcp__outreachr__outreachr_propose_target',
        {},
        {
          signal: new AbortController().signal,
          toolUseID: 'denied',
          requestId: 'request-denied',
        },
      ),
    ).resolves.toMatchObject({ behavior: 'deny', interrupt: true });
  });

  it('supports cancellation without contacting a real SDK service', async () => {
    const queryFactory: ClaudeQueryFactory = ({ options }) => {
      const generator = (async function* () {
        await new Promise<void>((_resolve, reject) => {
          options.abortController?.signal.addEventListener(
            'abort',
            () => reject(new Error('aborted')),
            { once: true },
          );
        });
        yield resultMessage();
      })();
      return Object.assign(generator, { close: vi.fn() }) as unknown as Query;
    };
    const adapter = new ClaudeAgentAdapter({
      workspaceDirectory: '/tmp/outreachr-agent',
      queryFactory,
      commandRunner: async () => ({ exitCode: 0, stdout: 'Claude', stderr: '' }),
      environment: { ANTHROPIC_API_KEY: 'key' },
    });
    const pending = adapter.run('run-cancel', runRequest('claude'), vi.fn());
    expect(await adapter.cancel('run-cancel')).toBe(true);
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(await adapter.cancel('missing')).toBe(false);
    await adapter.dispose();
  });

  it('clears only API-key auth and never modifies an independent subscription login', async () => {
    const clear = vi.fn(async () => undefined);
    const envAdapter = new ClaudeAgentAdapter({
      workspaceDirectory: '/tmp/outreachr-agent',
      commandRunner: installedWithCliAuth,
      environment: { ANTHROPIC_API_KEY: 'key' },
      clearEnvironmentCredential: clear,
    });
    await envAdapter.logout();
    expect(clear).toHaveBeenCalledWith('anthropic-api-key');

    const cliRunner = vi.fn(installedWithCliAuth);
    const cli = new ClaudeAgentAdapter({
      workspaceDirectory: '/tmp/outreachr-agent',
      commandRunner: cliRunner,
      environment: { PATH: '/bin' },
    });
    await expect(cli.logout()).rejects.toThrow('will not modify an independent Claude');
    expect(cliRunner).not.toHaveBeenCalledWith('claude', ['auth', 'logout'], expect.any(Object));

    const approvedCliRunner = vi.fn(installedWithCliAuth);
    const approvedCli = new ClaudeAgentAdapter({
      workspaceDirectory: '/tmp/outreachr-agent',
      commandRunner: approvedCliRunner,
      environment: { PATH: '/bin' },
      allowSubscriptionAuth: true,
    });
    await expect(approvedCli.logout()).rejects.toThrow(
      'will not modify or log out the independent official Claude Code session',
    );
    expect(approvedCliRunner).not.toHaveBeenCalledWith(
      'claude',
      ['auth', 'logout'],
      expect.any(Object),
    );

    const noClear = new ClaudeAgentAdapter({
      workspaceDirectory: '/tmp/outreachr-agent',
      commandRunner: installedWithCliAuth,
      environment: { ANTHROPIC_API_KEY: 'key' },
    });
    await expect(noClear.logout()).rejects.toThrow(
      'Remove ANTHROPIC_API_KEY from the founder-controlled launch environment and restart Outreachr',
    );
    await expect(noClear.logout()).rejects.toThrow('never persists plaintext credentials');
  });

  it('sanitizes subprocess environment and fails closed for missing or unrecognized auth', async () => {
    const clean = sanitizeClaudeEnvironment({
      PATH: '/bin',
      HOME: '/home/founder',
      DATABASE_PASSWORD: 'private',
      ANTHROPIC_API_KEY: 'allowed',
      CLAUDE_CODE_OAUTH_TOKEN: 'must-not-pass',
    });
    expect(clean).toMatchObject({
      PATH: '/bin',
      HOME: '/home/founder',
      ANTHROPIC_API_KEY: 'allowed',
    });
    expect(clean.DATABASE_PASSWORD).toBeUndefined();
    expect(clean.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();

    const subscriptionClean = sanitizeClaudeEnvironment(
      {
        PATH: '/bin',
        HOME: '/home/founder',
        ANTHROPIC_API_KEY: 'must-not-pass',
        CLAUDE_CODE_OAUTH_TOKEN: 'must-not-pass',
      },
      true,
    );
    expect(subscriptionClean).toMatchObject({ PATH: '/bin', HOME: '/home/founder' });
    expect(subscriptionClean.ANTHROPIC_API_KEY).toBeUndefined();
    expect(subscriptionClean.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();

    const missing = new ClaudeAgentAdapter({
      workspaceDirectory: '/tmp/outreachr-agent',
      commandRunner: async () => ({ exitCode: 127, stdout: '', stderr: 'not found' }),
      environment: {},
    });
    await expect(missing.detect()).resolves.toMatchObject({
      installed: false,
      authenticated: false,
    });

    const unknown = new ClaudeAgentAdapter({
      workspaceDirectory: '/tmp/outreachr-agent',
      commandRunner: async (_command, args) =>
        args[0] === '--version'
          ? { exitCode: 0, stdout: 'Claude', stderr: '' }
          : { exitCode: 0, stdout: '{"newSchema":true}', stderr: '' },
      environment: {},
    });
    await expect(unknown.status()).resolves.toMatchObject({
      authenticated: false,
      authSource: 'none',
    });
    await expect(unknown.run('no-auth', runRequest('claude'), vi.fn())).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
    });
    expect(() => new ClaudeAgentAdapter({ workspaceDirectory: 'relative' })).toThrow('absolute');
  });

  it('normalizes CLI auth failures without assuming authentication', async () => {
    const notLoggedIn = new ClaudeAgentAdapter({
      workspaceDirectory: '/tmp/outreachr-agent',
      commandRunner: async (_command, args) =>
        args[0] === '--version'
          ? { exitCode: 0, stdout: 'Claude', stderr: '' }
          : { exitCode: 1, stdout: '', stderr: 'not logged in' },
      environment: {},
    });
    await expect(notLoggedIn.detect()).resolves.toMatchObject({
      authenticated: false,
      authSource: 'none',
    });
    await expect(notLoggedIn.logout()).rejects.toThrow('no supported Claude API-key session');

    const invalidJson = new ClaudeAgentAdapter({
      workspaceDirectory: '/tmp/outreachr-agent',
      commandRunner: async (_command, args) =>
        args[0] === '--version'
          ? { exitCode: 0, stdout: 'Claude', stderr: '' }
          : { exitCode: 0, stdout: 'not-json', stderr: '' },
      environment: {},
    });
    await expect(invalidJson.detect()).resolves.toMatchObject({ authSource: 'unknown' });

    const throwing = new ClaudeAgentAdapter({
      workspaceDirectory: '/tmp/outreachr-agent',
      commandRunner: async () => {
        throw new Error('cannot spawn');
      },
      environment: {},
    });
    await expect(throwing.detect()).resolves.toMatchObject({
      installed: false,
      detail: 'cannot spawn',
    });
  });

  it('surfaces SDK result errors, accepts JSON result fallback, and enforces lifecycle state', async () => {
    const failed = new ClaudeAgentAdapter({
      workspaceDirectory: '/tmp/outreachr-agent',
      queryFactory: () =>
        fakeQuery([
          {
            type: 'result',
            subtype: 'error_max_turns',
            errors: ['turn ceiling reached'],
            permission_denials: [],
          } as unknown as SDKMessage,
        ]),
      commandRunner: async () => ({ exitCode: 0, stdout: 'Claude', stderr: '' }),
      environment: { ANTHROPIC_API_KEY: 'key' },
    });
    await expect(failed.run('run-sdk-error', runRequest('claude'), vi.fn())).rejects.toThrow(
      'turn ceiling reached',
    );
    await expect(failed.run('run-provider-mismatch', runRequest('codex'), vi.fn())).rejects.toThrow(
      'mismatch',
    );

    let captured: Options | undefined;
    const fallback = new ClaudeAgentAdapter({
      workspaceDirectory: '/tmp/outreachr-agent',
      executable: '/absolute/sidecars/claude',
      queryFactory: (params) => {
        captured = params.options;
        return fakeQuery([
          {
            type: 'result',
            subtype: 'success',
            result: JSON.stringify(validRawResult),
            permission_denials: [],
          } as unknown as SDKMessage,
        ]);
      },
      commandRunner: async () => ({ exitCode: 0, stdout: 'Claude', stderr: '' }),
      environment: { ANTHROPIC_API_KEY: 'key' },
    });
    await expect(
      fallback.run(
        'run-fallback',
        { ...runRequest('claude'), maxTurns: 99, model: 'override' },
        vi.fn(),
      ),
    ).resolves.toMatchObject({ summary: 'One draft proposed.' });
    expect(captured).toMatchObject({
      maxTurns: 4,
      model: 'override',
      pathToClaudeCodeExecutable: '/absolute/sidecars/claude',
    });
    await fallback.dispose();
    await fallback.dispose();
    await expect(fallback.run('after-dispose', runRequest('claude'), vi.fn())).rejects.toThrow(
      'disposed',
    );
  });
});
