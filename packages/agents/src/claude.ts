import { isAbsolute, resolve } from 'node:path';

import type { Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';

import { AgentRuntimeError, asAgentError } from './errors.js';
import { AGENT_RESULT_JSON_SCHEMA, parseAgentResult } from './output.js';
import {
  firstNonEmptyLine,
  nodeCommandRunner,
  redactSecrets,
  type CommandRunner,
} from './process.js';
import { prepareAgentPrompt } from './prompt.js';
import { OUTREACHR_AGENT_MCP_TOOLS } from './types.js';
import type {
  AgentAuthSource,
  AgentMcpConnection,
  AgentEventListener,
  AgentProviderAdapter,
  AgentResult,
  AgentRunRequest,
  LoginChallenge,
  LoginRequest,
  ProviderDetection,
} from './types.js';

export type ClaudeQueryFactory = (params: {
  readonly prompt: string;
  readonly options: Options;
}) => Query;

interface ActiveClaudeRun {
  readonly abortController: AbortController;
  query?: Query;
  cancelled: boolean;
  timedOut: boolean;
}

export interface ClaudeAgentOptions {
  /** Dedicated, non-sensitive empty directory; filesystem tools are disabled regardless. */
  readonly workspaceDirectory: string;
  readonly executable?: string;
  readonly queryFactory?: ClaudeQueryFactory;
  readonly commandRunner?: CommandRunner;
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
  readonly defaultModel?: string;
  readonly requestTimeoutMs?: number;
  readonly clearEnvironmentCredential?: (source: 'anthropic-api-key') => Promise<void>;
  readonly onDiagnostic?: (message: string) => void;
}

export class ClaudeAgentAdapter implements AgentProviderAdapter {
  readonly provider = 'claude' as const;
  readonly #workspaceDirectory: string;
  readonly #executable: string;
  readonly #queryFactory?: ClaudeQueryFactory;
  readonly #commandRunner: CommandRunner;
  #environment: Readonly<NodeJS.ProcessEnv>;
  readonly #defaultModel?: string;
  readonly #requestTimeoutMs: number;
  readonly #clearEnvironmentCredential?: ClaudeAgentOptions['clearEnvironmentCredential'];
  readonly #onDiagnostic?: ClaudeAgentOptions['onDiagnostic'];
  readonly #active = new Map<string, ActiveClaudeRun>();
  #disposed = false;

  constructor(options: ClaudeAgentOptions) {
    if (!isAbsolute(options.workspaceDirectory)) {
      throw new AgentRuntimeError(
        'POLICY_DENIED',
        'Claude workspaceDirectory must be an absolute path.',
      );
    }
    this.#workspaceDirectory = resolve(options.workspaceDirectory);
    this.#executable = options.executable ?? 'claude';
    // Loading the SDK eagerly executes its large CLI bootstrap graph during
    // Electron startup. Keep it behind the first actual Claude run so the app
    // can initialize its local vault and render even when Claude is unused.
    this.#queryFactory = options.queryFactory;
    this.#commandRunner = options.commandRunner ?? nodeCommandRunner;
    this.#environment = sanitizeClaudeEnvironment(options.environment ?? process.env);
    this.#defaultModel = options.defaultModel;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 120_000;
    this.#clearEnvironmentCredential = options.clearEnvironmentCredential;
    this.#onDiagnostic = options.onDiagnostic;
  }

  async detect(): Promise<ProviderDetection> {
    const authFromEnvironment = environmentAuthSource(this.#environment);
    try {
      const version = await this.#commandRunner(this.#executable, ['--version'], {
        env: this.#environment,
        timeoutMs: 8_000,
      });
      if (version.exitCode !== 0) {
        return {
          provider: 'claude',
          installed: false,
          authenticated: false,
          authSource: 'none',
          detail:
            firstNonEmptyLine(version.stderr) ??
            'Install the official Claude Code runtime and configure a founder-controlled Anthropic API key.',
        };
      }
      const base: ProviderDetection = {
        provider: 'claude',
        installed: true,
        executable: this.#executable,
        version: firstNonEmptyLine(version.stdout),
        authenticated: authFromEnvironment !== 'none',
        authSource: authFromEnvironment,
      };
      if (authFromEnvironment !== 'none') return base;
      return await this.#readCliAuth(base);
    } catch (error) {
      return {
        provider: 'claude',
        installed: false,
        authenticated: false,
        authSource: 'none',
        detail: asAgentError(error).message,
      };
    }
  }

  async status(): Promise<ProviderDetection> {
    return this.detect();
  }

  setApiKey(value: string | null): void {
    if (this.#active.size > 0) {
      throw new AgentRuntimeError(
        'POLICY_DENIED',
        'Claude credentials cannot change while a run is active.',
      );
    }
    const environment: NodeJS.ProcessEnv = { ...this.#environment };
    if (value === null) {
      delete environment.ANTHROPIC_API_KEY;
    } else {
      const normalized = value.trim();
      if (normalized.length < 20 || normalized.length > 1_000 || /\s/u.test(normalized)) {
        throw new AgentRuntimeError('POLICY_DENIED', 'Anthropic API key format is invalid.');
      }
      environment.ANTHROPIC_API_KEY = normalized;
    }
    this.#environment = sanitizeClaudeEnvironment(environment);
  }

  login(request: LoginRequest): Promise<LoginChallenge> {
    if (request.provider !== 'claude')
      return Promise.reject(new AgentRuntimeError('POLICY_DENIED', 'Provider/login mismatch.'));
    if (
      request.mode === 'official-cli' ||
      request.mode === 'browser' ||
      request.mode === 'setup-token'
    ) {
      return Promise.reject(
        new AgentRuntimeError(
          'POLICY_DENIED',
          'Anthropic currently requires third-party Agent SDK products to use API-key or supported cloud-provider authentication. Outreachr does not route Claude subscription or setup-token credentials.',
        ),
      );
    }
    if (request.mode === 'api-key') {
      return Promise.resolve({
        provider: 'claude',
        kind: 'environment',
        environmentVariable: 'ANTHROPIC_API_KEY',
        instructions:
          'Create a founder-controlled Anthropic API key in the official console, then save it in Settings → Agents. Outreachr encrypts it with the operating-system credential facility and never returns it to the renderer after saving. ANTHROPIC_API_KEY remains available as an optional launch-environment override.',
      });
    }
    return Promise.reject(
      new AgentRuntimeError(
        'POLICY_DENIED',
        'Claude setup in Outreachr requires a founder-controlled Anthropic API key.',
      ),
    );
  }

  async logout(): Promise<void> {
    const source = environmentAuthSource(this.#environment);
    if (source === 'anthropic-api-key') {
      if (!this.#clearEnvironmentCredential) {
        throw new AgentRuntimeError(
          'POLICY_DENIED',
          'Remove ANTHROPIC_API_KEY from the founder-controlled launch environment and restart Outreachr to log out. This adapter never persists plaintext credentials.',
        );
      }
      await this.#clearEnvironmentCredential(source);
      this.setApiKey(null);
      return;
    }
    throw new AgentRuntimeError(
      'POLICY_DENIED',
      'Outreachr has no supported Claude API-key session to log out. It will not modify an independent Claude subscription login.',
    );
  }

  async run(
    runId: string,
    request: AgentRunRequest,
    emit: AgentEventListener,
  ): Promise<AgentResult> {
    if (this.#disposed)
      throw new AgentRuntimeError('PROVIDER_ERROR', 'Claude adapter is disposed.');
    if (request.provider !== 'claude')
      throw new AgentRuntimeError('POLICY_DENIED', 'Provider/request mismatch.');
    if (this.#active.has(runId))
      throw new AgentRuntimeError('POLICY_DENIED', `Duplicate run id: ${runId}`);
    const prepared = prepareAgentPrompt(request);
    const mcp = request.mcp ? validateMcpConnection(request.mcp, runId) : undefined;
    const allowedMcpTools = new Set(
      mcp?.enabledTools.map((toolName) => claudeMcpToolName(mcp.serverName, toolName)) ?? [],
    );
    const abortController = new AbortController();
    const active: ActiveClaudeRun = { abortController, cancelled: false, timedOut: false };
    this.#active.set(runId, active);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const status = await this.status();
      if (active.cancelled) throw new AgentRuntimeError('CANCELLED', 'Claude run was cancelled.');
      if (!status.authenticated) {
        throw new AgentRuntimeError(
          'AUTH_REQUIRED',
          status.detail ?? 'Configure a founder-controlled Anthropic API key for Claude.',
        );
      }
      const timeoutMs = clampTimeout(request.timeoutMs ?? this.#requestTimeoutMs);
      timer = setTimeout(() => {
        active.timedOut = true;
        abortController.abort();
        active.query?.close();
      }, timeoutMs);
      timer.unref?.();

      const queryFactory =
        this.#queryFactory ?? (await import('@anthropic-ai/claude-agent-sdk')).query;
      const query = queryFactory({
        prompt: prepared.prompt,
        options: {
          abortController,
          cwd: this.#workspaceDirectory,
          env: { ...this.#environment, CLAUDE_AGENT_SDK_CLIENT_APP: 'outreachr/0.1.1' },
          systemPrompt: prepared.system,
          tools: [],
          allowedTools: [...allowedMcpTools],
          disallowedTools: [...CLAUDE_DISALLOWED_TOOLS],
          permissionMode: 'dontAsk',
          canUseTool: (toolName) =>
            Promise.resolve(
              allowedMcpTools.has(toolName)
                ? { behavior: 'allow' as const }
                : {
                    behavior: 'deny' as const,
                    message: `Outreachr proposal-only policy forbids tool ${toolName}.`,
                    interrupt: true,
                  },
            ),
          settingSources: [],
          strictMcpConfig: true,
          mcpServers: mcp
            ? {
                outreachr: {
                  type: 'http',
                  url: mcp.url,
                  headers: {
                    Authorization: `Bearer ${mcp.bearerToken}`,
                    [OUTREACHR_MCP_SESSION_HEADER]: mcp.sessionId,
                  },
                  tools: mcp.enabledTools.map((name) => ({
                    name,
                    permission_policy: 'always_allow' as const,
                    org_max_permission: 'allow' as const,
                  })),
                  timeout: 30_000,
                  alwaysLoad: true,
                },
              }
            : {},
          plugins: [],
          agents: {},
          skills: [],
          additionalDirectories: [],
          persistSession: false,
          includePartialMessages: false,
          maxTurns: clampMaxTurns(request.maxTurns),
          outputFormat: { type: 'json_schema', schema: AGENT_RESULT_JSON_SCHEMA },
          ...((request.model ?? this.#defaultModel)
            ? { model: request.model ?? this.#defaultModel }
            : {}),
          ...(this.#executable === 'claude'
            ? {}
            : { pathToClaudeCodeExecutable: this.#executable }),
          ...(this.#onDiagnostic
            ? { stderr: (data: string) => this.#onDiagnostic?.(redactSecrets(data)) }
            : {}),
        },
      });
      active.query = query;

      let rawResult: unknown;
      let assistantText = '';
      for await (const message of query) {
        if (active.cancelled || active.timedOut) break;
        const toolName = findToolUse(message);
        if (toolName && !allowedMcpTools.has(toolName)) {
          abortController.abort();
          query.close();
          throw new AgentRuntimeError(
            'POLICY_DENIED',
            `Claude attempted a forbidden tool: ${toolName}`,
          );
        }
        const text = extractAssistantText(message);
        if (text) {
          assistantText += text;
          emit({ type: 'run.output_delta', runId, text, at: new Date().toISOString() });
        }
        if (message.type === 'result') {
          if (message.subtype !== 'success') {
            throw new AgentRuntimeError(
              message.subtype === 'error_max_turns' ? 'PROVIDER_ERROR' : 'PROVIDER_ERROR',
              `Claude run failed: ${message.errors.join('; ') || message.subtype}`,
            );
          }
          if (message.permission_denials.length > 0) {
            throw new AgentRuntimeError(
              'POLICY_DENIED',
              'Claude attempted a tool that the proposal-only policy denied.',
            );
          }
          rawResult = message.structured_output ?? message.result;
        }
      }
      if (active.cancelled) throw new AgentRuntimeError('CANCELLED', 'Claude run was cancelled.');
      if (active.timedOut)
        throw new AgentRuntimeError('TIMEOUT', `Claude run exceeded ${timeoutMs} ms.`);
      if (rawResult === undefined) rawResult = assistantText;
      return parseAgentResult(rawResult, request.allowlist, 'claude');
    } catch (error) {
      if (active.cancelled)
        throw new AgentRuntimeError('CANCELLED', 'Claude run was cancelled.', error);
      if (active.timedOut) throw new AgentRuntimeError('TIMEOUT', 'Claude run timed out.', error);
      throw asAgentError(error);
    } finally {
      if (timer) clearTimeout(timer);
      active.query?.close();
      this.#active.delete(runId);
    }
  }

  cancel(runId: string): Promise<boolean> {
    const active = this.#active.get(runId);
    if (!active) return Promise.resolve(false);
    active.cancelled = true;
    active.abortController.abort();
    active.query?.close();
    return Promise.resolve(true);
  }

  dispose(): Promise<void> {
    if (this.#disposed) return Promise.resolve();
    this.#disposed = true;
    for (const active of this.#active.values()) {
      active.cancelled = true;
      active.abortController.abort();
      active.query?.close();
    }
    this.#active.clear();
    return Promise.resolve();
  }

  async #readCliAuth(base: ProviderDetection): Promise<ProviderDetection> {
    const result = await this.#commandRunner(this.#executable, ['auth', 'status', '--json'], {
      env: this.#environment,
      timeoutMs: 10_000,
    });
    if (result.exitCode !== 0) {
      return {
        ...base,
        authenticated: false,
        authSource: 'none',
        detail: 'Claude Code is installed but not authenticated.',
      };
    }
    try {
      const value = JSON.parse(result.stdout) as unknown;
      if (!isRecord(value) || !isAuthenticatedStatus(value)) {
        return {
          ...base,
          authenticated: false,
          authSource: 'none',
          detail: 'Claude Code is not authenticated.',
        };
      }
      return {
        ...base,
        authenticated: false,
        authSource: 'claude-code',
        ...(readString(value, 'email', 'account')
          ? { accountLabel: readString(value, 'email', 'account') }
          : {}),
        ...(readString(value, 'subscriptionType', 'plan', 'subscription')
          ? { plan: readString(value, 'subscriptionType', 'plan', 'subscription') }
          : {}),
        detail:
          'Claude subscription credentials were detected but are not used. Anthropic currently directs third-party Agent SDK products to API-key or supported cloud-provider authentication.',
      };
    } catch {
      return {
        ...base,
        authenticated: false,
        authSource: 'unknown',
        detail:
          'Claude Code returned an unrecognized authentication status; Outreachr failed closed.',
      };
    }
  }
}

const OUTREACHR_MCP_SESSION_HEADER = 'X-Outreachr-Session';

export const CLAUDE_DISALLOWED_TOOLS = [
  'Agent',
  'Bash',
  'Edit',
  'EnterPlanMode',
  'ExitPlanMode',
  'Glob',
  'Grep',
  'KillShell',
  'NotebookEdit',
  'Read',
  'Skill',
  'Task',
  'TaskCreate',
  'TaskGet',
  'TaskList',
  'TaskOutput',
  'TaskStop',
  'TaskUpdate',
  'TodoWrite',
  'WebFetch',
  'WebSearch',
  'Write',
] as const;

export function sanitizeClaudeEnvironment(
  source: Readonly<NodeJS.ProcessEnv>,
): Readonly<NodeJS.ProcessEnv> {
  const names = [
    'HOME',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'PATH',
    'PATHEXT',
    'SystemRoot',
    'COMSPEC',
    'TMPDIR',
    'TMP',
    'TEMP',
    'LANG',
    'LC_ALL',
    'ANTHROPIC_API_KEY',
  ] as const;
  const clean: NodeJS.ProcessEnv = {};
  for (const name of names) if (source[name] !== undefined) clean[name] = source[name];
  clean.CLAUDE_AGENT_SDK_CLIENT_APP = 'outreachr/0.1.1';
  return clean;
}

function environmentAuthSource(environment: Readonly<NodeJS.ProcessEnv>): AgentAuthSource {
  if (environment.ANTHROPIC_API_KEY) return 'anthropic-api-key';
  return 'none';
}

function isAuthenticatedStatus(value: Record<string, unknown>): boolean {
  if (value.loggedIn === true || value.authenticated === true) return true;
  return value.status === 'authenticated' || value.status === 'logged_in';
}

function readString(
  value: Record<string, unknown>,
  ...keys: readonly string[]
): string | undefined {
  for (const key of keys) if (typeof value[key] === 'string' && value[key]) return value[key];
  return undefined;
}

function extractAssistantText(message: SDKMessage): string {
  if (message.type !== 'assistant') return '';
  return message.message.content.map((block) => (block.type === 'text' ? block.text : '')).join('');
}

function findToolUse(message: SDKMessage): string | undefined {
  if (message.type !== 'assistant') return undefined;
  for (const block of message.message.content) {
    if (block.type === 'tool_use') return block.name;
  }
  return undefined;
}

function claudeMcpToolName(serverName: string, toolName: string): string {
  return `mcp__${serverName}__${toolName}`;
}

function validateMcpConnection(connection: AgentMcpConnection, runId: string): AgentMcpConnection {
  let url: URL;
  try {
    url = new URL(connection.url);
  } catch {
    throw new AgentRuntimeError('POLICY_DENIED', 'Claude MCP URL is invalid.');
  }
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    url.pathname !== '/mcp' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new AgentRuntimeError('POLICY_DENIED', 'Claude MCP must use the loopback HTTP bridge.');
  }
  if (
    connection.serverName !== 'outreachr' ||
    connection.sessionId !== runId ||
    connection.bearerToken.length < 32 ||
    connection.enabledTools.length === 0 ||
    new Set(connection.enabledTools).size !== connection.enabledTools.length ||
    connection.enabledTools.some((tool) => !OUTREACHR_AGENT_MCP_TOOLS.includes(tool))
  ) {
    throw new AgentRuntimeError('POLICY_DENIED', 'Claude MCP connection is invalid.');
  }
  return connection;
}

function clampTimeout(value: number): number {
  if (!Number.isFinite(value)) return 120_000;
  return Math.min(30 * 60_000, Math.max(5_000, Math.floor(value)));
}

function clampMaxTurns(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 1;
  return Math.min(4, Math.max(1, Math.floor(value)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
