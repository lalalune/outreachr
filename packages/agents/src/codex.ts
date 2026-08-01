import { isAbsolute, resolve } from 'node:path';

import { AgentRuntimeError, asAgentError } from './errors.js';
import { JsonlRpcTransport, type CodexRpcClient, type RpcNotification } from './jsonl-transport.js';
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

interface CodexAccountResult {
  readonly account?: null | {
    readonly type?: string;
    readonly email?: string | null;
    readonly planType?: string | null;
  };
  readonly requiresOpenaiAuth?: boolean;
}

interface ThreadStartResult {
  readonly thread?: { readonly id?: string };
}

interface TurnStartResult {
  readonly turn?: { readonly id?: string };
}

interface ActiveCodexRun {
  threadId?: string;
  turnId?: string;
  cancelled: boolean;
  reject?: (error: Error) => void;
}

export interface CodexAgentOptions {
  /** Dedicated, non-sensitive empty directory. Codex receives read-only access to only this root. */
  readonly workspaceDirectory: string;
  readonly executable?: string;
  readonly rpc?: CodexRpcClient;
  readonly commandRunner?: CommandRunner;
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
  readonly defaultModel?: string;
  readonly requestTimeoutMs?: number;
  /** Ephemeral credential for the host's loopback-only Outreachr MCP bridge. */
  readonly mcpBearerToken?: string;
}

export class CodexAgentAdapter implements AgentProviderAdapter {
  readonly provider = 'codex' as const;
  readonly #workspaceDirectory: string;
  readonly #executable: string;
  readonly #rpc: CodexRpcClient;
  readonly #commandRunner: CommandRunner;
  readonly #environment: Readonly<NodeJS.ProcessEnv>;
  readonly #defaultModel?: string;
  readonly #requestTimeoutMs: number;
  readonly #mcpBearerToken?: string;
  readonly #active = new Map<string, ActiveCodexRun>();
  #initialize?: Promise<void>;
  #disposed = false;

  constructor(options: CodexAgentOptions) {
    if (!isAbsolute(options.workspaceDirectory)) {
      throw new AgentRuntimeError(
        'POLICY_DENIED',
        'Codex workspaceDirectory must be an absolute path.',
      );
    }
    this.#workspaceDirectory = resolve(options.workspaceDirectory);
    this.#executable = options.executable ?? 'codex';
    this.#mcpBearerToken = options.mcpBearerToken;
    if (this.#mcpBearerToken !== undefined && this.#mcpBearerToken.length < 32) {
      throw new AgentRuntimeError('POLICY_DENIED', 'Codex MCP bearer token is too short.');
    }
    this.#environment = {
      ...sanitizeCodexEnvironment(options.environment ?? process.env),
      ...(this.#mcpBearerToken ? { [OUTREACHR_MCP_TOKEN_ENV]: this.#mcpBearerToken } : {}),
    };
    this.#rpc =
      options.rpc ??
      new JsonlRpcTransport({
        executable: this.#executable,
        args: [
          'app-server',
          '--config',
          'mcp_servers={}',
          '--config',
          'apps={}',
          '--config',
          'web_search="disabled"',
          '--listen',
          'stdio://',
        ],
        env: this.#environment,
      });
    this.#commandRunner = options.commandRunner ?? nodeCommandRunner;
    this.#defaultModel = options.defaultModel;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 120_000;
  }

  async detect(): Promise<ProviderDetection> {
    const command = await this.#probe();
    if (!command.installed) return command;
    try {
      const account = await this.#readAccount(false);
      return detectionFromAccount(command, account);
    } catch (error) {
      return {
        ...command,
        authenticated: false,
        authSource: 'unknown',
        detail: `Codex is installed but account state could not be read: ${asAgentError(error).message}`,
      };
    }
  }

  async status(): Promise<ProviderDetection> {
    const command = await this.#probe();
    if (!command.installed) return command;
    const account = await this.#readAccount(true);
    return detectionFromAccount(command, account);
  }

  async login(request: LoginRequest): Promise<LoginChallenge> {
    this.#assertProvider(request);
    await this.#ensureInitialized();
    // Never permit the app-server or official CLI login to fall back to plaintext auth.json.
    await this.#rpc.request('config/value/write', {
      keyPath: 'cli_auth_credentials_store',
      value: 'keyring',
      mergeStrategy: 'replace',
    });
    if (request.mode === 'api-key') {
      return {
        provider: 'codex',
        kind: 'environment',
        environmentVariable: 'OPENAI_API_KEY',
        instructions:
          'Set OPENAI_API_KEY locally, then run the official `printenv OPENAI_API_KEY | codex login --with-api-key` flow. Codex stores the credential in the OS keyring; Outreachr never proxies it.',
      };
    }
    if (request.mode !== 'browser' && request.mode !== 'device-code') {
      throw new AgentRuntimeError(
        'POLICY_DENIED',
        'Codex login supports browser, device-code, or API-key guidance.',
      );
    }

    if (request.mode === 'device-code') {
      const result = await this.#rpc.request<{
        readonly loginId?: string;
        readonly verificationUrl?: string;
        readonly userCode?: string;
      }>('account/login/start', { type: 'chatgptDeviceCode' });
      if (!result.loginId || !result.verificationUrl || !result.userCode) {
        throw new AgentRuntimeError(
          'PROTOCOL_ERROR',
          'Codex did not return a complete device-code challenge.',
        );
      }
      return {
        provider: 'codex',
        kind: 'device-code',
        loginId: result.loginId,
        url: result.verificationUrl,
        userCode: result.userCode,
        instructions:
          'Open the official OpenAI verification page and enter the displayed code. Codex stores the resulting session in the OS keyring.',
      };
    }

    const result = await this.#rpc.request<{
      readonly loginId?: string;
      readonly authUrl?: string;
    }>('account/login/start', {
      type: 'chatgpt',
      useHostedLoginSuccessPage: true,
      appBrand: 'chatgpt',
    });
    if (!result.loginId || !result.authUrl) {
      throw new AgentRuntimeError(
        'PROTOCOL_ERROR',
        'Codex did not return a complete browser login challenge.',
      );
    }
    return {
      provider: 'codex',
      kind: 'browser',
      loginId: result.loginId,
      url: result.authUrl,
      instructions:
        'Complete the official ChatGPT sign-in in your browser. Codex handles the loopback callback and keeps the session in the OS keyring.',
    };
  }

  async logout(): Promise<void> {
    await this.#ensureInitialized();
    await this.#rpc.request('account/logout', {});
  }

  async run(
    runId: string,
    request: AgentRunRequest,
    emit: AgentEventListener,
  ): Promise<AgentResult> {
    if (request.provider !== 'codex')
      throw new AgentRuntimeError('POLICY_DENIED', 'Provider/request mismatch.');
    if (this.#active.has(runId))
      throw new AgentRuntimeError('POLICY_DENIED', `Duplicate run id: ${runId}`);
    const prepared = prepareAgentPrompt(request);
    const mcp = request.mcp ? validateMcpConnection(request.mcp, runId) : undefined;
    if (mcp && this.#mcpBearerToken !== mcp.bearerToken) {
      throw new AgentRuntimeError(
        'POLICY_DENIED',
        'Codex MCP connection does not match the runtime credential.',
      );
    }
    const active: ActiveCodexRun = { cancelled: false };
    this.#active.set(runId, active);
    let unsubscribe: () => void = () => undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const status = await this.status();
      if (active.cancelled) throw new AgentRuntimeError('CANCELLED', 'Codex run was cancelled.');
      if (!status.authenticated)
        throw new AgentRuntimeError('AUTH_REQUIRED', 'Sign in to Codex before running the agent.');
      await this.#ensureInitialized();
      let deltas = '';
      let finalText = '';
      const completion = new Promise<string>((resolveCompletion, rejectCompletion) => {
        active.reject = rejectCompletion;
        unsubscribe = this.#rpc.subscribe((notification) => {
          if (!active.threadId || !belongsToThread(notification, active.threadId)) return;
          if (notification.method === 'item/started') {
            const itemType = extractItemType(notification.params);
            const allowedMcpCall =
              itemType === 'mcpToolCall' && isAllowedMcpItem(notification.params, mcp);
            if (itemType && !SAFE_ITEM_TYPES.has(itemType) && !allowedMcpCall) {
              void this.#interrupt(active);
              rejectCompletion(
                new AgentRuntimeError(
                  'POLICY_DENIED',
                  `Codex attempted a forbidden tool item: ${itemType}`,
                ),
              );
            }
            return;
          }
          if (notification.method === 'item/agentMessage/delta') {
            const delta = extractString(notification.params, ['delta', 'text']);
            if (delta) {
              deltas += delta;
              emit({ type: 'run.output_delta', runId, text: delta, at: new Date().toISOString() });
            }
            return;
          }
          if (notification.method === 'item/completed') {
            const text = extractCompletedAgentText(notification.params);
            if (text) finalText = text;
            return;
          }
          if (notification.method === 'turn/completed') {
            const statusValue = extractTurnStatus(notification.params);
            if (active.cancelled || statusValue === 'interrupted') {
              rejectCompletion(new AgentRuntimeError('CANCELLED', 'Codex run was cancelled.'));
            } else if (statusValue && statusValue !== 'completed') {
              const detail = extractTurnError(notification.params);
              rejectCompletion(
                new AgentRuntimeError(
                  'PROVIDER_ERROR',
                  `Codex turn ended with status ${statusValue}${detail ? `: ${detail}` : '.'}`,
                ),
              );
            } else {
              resolveCompletion(finalText || deltas);
            }
          }
        });
      });

      const thread = await this.#rpc.request<ThreadStartResult>('thread/start', {
        cwd: this.#workspaceDirectory,
        runtimeWorkspaceRoots: [this.#workspaceDirectory],
        approvalPolicy: 'never',
        sandbox: 'read-only',
        ephemeral: true,
        serviceName: 'outreachr',
        environments: [],
        dynamicTools: [],
        selectedCapabilityRoots: [],
        config: {
          web_search: 'disabled',
          apps: {},
          mcp_servers: mcp
            ? {
                outreachr: {
                  url: mcp.url,
                  bearer_token_env_var: OUTREACHR_MCP_TOKEN_ENV,
                  http_headers: { [OUTREACHR_MCP_SESSION_HEADER]: mcp.sessionId },
                  enabled_tools: [...mcp.enabledTools],
                  disabled_tools: [],
                  required: true,
                  default_tools_approval_mode: 'auto',
                  startup_timeout_sec: 5,
                  tool_timeout_sec: 30,
                },
              }
            : {},
        },
        ...((request.model ?? this.#defaultModel)
          ? { model: request.model ?? this.#defaultModel }
          : {}),
      });
      const threadId = thread.thread?.id;
      if (!threadId)
        throw new AgentRuntimeError('PROTOCOL_ERROR', 'Codex did not return a thread id.');
      active.threadId = threadId;
      if (active.cancelled) throw new AgentRuntimeError('CANCELLED', 'Codex run was cancelled.');

      const turn = await this.#rpc.request<TurnStartResult>('turn/start', {
        threadId,
        input: [{ type: 'text', text: `${prepared.system}\n\n${prepared.prompt}` }],
        cwd: this.#workspaceDirectory,
        runtimeWorkspaceRoots: [this.#workspaceDirectory],
        approvalPolicy: 'never',
        sandboxPolicy: {
          type: 'readOnly',
          networkAccess: false,
        },
        outputSchema: AGENT_RESULT_JSON_SCHEMA,
        ...((request.model ?? this.#defaultModel)
          ? { model: request.model ?? this.#defaultModel }
          : {}),
      });
      active.turnId = turn.turn?.id;
      if (!active.turnId)
        throw new AgentRuntimeError('PROTOCOL_ERROR', 'Codex did not return a turn id.');

      const timeoutMs = clampTimeout(request.timeoutMs ?? this.#requestTimeoutMs);
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          void this.#interrupt(active);
          reject(new AgentRuntimeError('TIMEOUT', `Codex run exceeded ${timeoutMs} ms.`));
        }, timeoutMs);
        timer.unref?.();
      });
      const output = await Promise.race([completion, timeout]);
      if (!output.trim())
        throw new AgentRuntimeError('INVALID_OUTPUT', 'Codex returned no final output.');
      return parseAgentResult(output, request.allowlist, 'codex');
    } finally {
      if (timer) clearTimeout(timer);
      unsubscribe();
      this.#active.delete(runId);
    }
  }

  async cancel(runId: string): Promise<boolean> {
    const active = this.#active.get(runId);
    if (!active) return false;
    active.cancelled = true;
    await this.#interrupt(active);
    active.reject?.(new AgentRuntimeError('CANCELLED', 'Codex run was cancelled.'));
    return true;
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const active of this.#active.values()) {
      active.cancelled = true;
      await this.#interrupt(active);
      active.reject?.(new AgentRuntimeError('CANCELLED', 'Codex runtime was disposed.'));
    }
    this.#active.clear();
    this.#rpc.close();
  }

  async #probe(): Promise<ProviderDetection> {
    try {
      const result = await this.#commandRunner(this.#executable, ['--version'], {
        env: this.#environment,
        timeoutMs: 8_000,
      });
      if (result.exitCode !== 0) {
        return {
          provider: 'codex',
          installed: false,
          authenticated: false,
          authSource: 'none',
          detail: firstNonEmptyLine(result.stderr) ?? 'The Codex executable was not available.',
        };
      }
      return {
        provider: 'codex',
        installed: true,
        executable: this.#executable,
        version: firstNonEmptyLine(result.stdout),
        authenticated: false,
        authSource: 'unknown',
      };
    } catch (error) {
      return {
        provider: 'codex',
        installed: false,
        authenticated: false,
        authSource: 'none',
        detail: asAgentError(error).message,
      };
    }
  }

  async #readAccount(refreshToken: boolean): Promise<CodexAccountResult> {
    await this.#ensureInitialized();
    return this.#rpc.request<CodexAccountResult>('account/read', { refreshToken });
  }

  #ensureInitialized(): Promise<void> {
    if (this.#disposed) throw new AgentRuntimeError('PROTOCOL_ERROR', 'Codex adapter is disposed.');
    this.#initialize ??= (async () => {
      await this.#rpc.request('initialize', {
        clientInfo: { name: 'outreachr', title: 'Outreachr', version: '0.1.1' },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
          mcpServerOpenaiFormElicitation: false,
          optOutNotificationMethods: [],
        },
      });
      this.#rpc.notify('initialized', {});
    })();
    return this.#initialize;
  }

  async #interrupt(active: ActiveCodexRun): Promise<void> {
    if (!active.threadId || !active.turnId) return;
    try {
      await this.#rpc.request(
        'turn/interrupt',
        { threadId: active.threadId, turnId: active.turnId },
        10_000,
      );
    } catch {
      // Cancellation is best effort; the sandbox remains read-only and no provider tool is approved.
    }
  }

  #assertProvider(request: LoginRequest): void {
    if (request.provider !== 'codex')
      throw new AgentRuntimeError('POLICY_DENIED', 'Provider/login mismatch.');
  }
}

const SAFE_ITEM_TYPES = new Set([
  'userMessage',
  'agentMessage',
  'reasoning',
  'plan',
  'enteredReviewMode',
  'exitedReviewMode',
]);

const OUTREACHR_MCP_TOKEN_ENV = 'OUTREACHR_MCP_TOKEN';
const OUTREACHR_MCP_SESSION_HEADER = 'X-Outreachr-Session';

export function sanitizeCodexEnvironment(
  source: Readonly<NodeJS.ProcessEnv>,
): Readonly<NodeJS.ProcessEnv> {
  const names = [
    'HOME',
    'USERPROFILE',
    'HOMEDRIVE',
    'HOMEPATH',
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
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'NO_PROXY',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'CODEX_HOME',
    'OPENAI_API_KEY',
    OUTREACHR_MCP_TOKEN_ENV,
  ] as const;
  const clean: NodeJS.ProcessEnv = {};
  for (const name of names) if (source[name] !== undefined) clean[name] = source[name];
  return clean;
}

function validateMcpConnection(connection: AgentMcpConnection, runId: string): AgentMcpConnection {
  let url: URL;
  try {
    url = new URL(connection.url);
  } catch {
    throw new AgentRuntimeError('POLICY_DENIED', 'Codex MCP URL is invalid.');
  }
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    url.pathname !== '/mcp' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new AgentRuntimeError('POLICY_DENIED', 'Codex MCP must use the loopback HTTP bridge.');
  }
  if (connection.serverName !== 'outreachr' || connection.sessionId !== runId) {
    throw new AgentRuntimeError('POLICY_DENIED', 'Codex MCP session identity is invalid.');
  }
  if (
    connection.enabledTools.length === 0 ||
    new Set(connection.enabledTools).size !== connection.enabledTools.length ||
    connection.enabledTools.some((tool) => !OUTREACHR_AGENT_MCP_TOOLS.includes(tool))
  ) {
    throw new AgentRuntimeError('POLICY_DENIED', 'Codex MCP tool allowlist is invalid.');
  }
  return connection;
}

function isAllowedMcpItem(params: unknown, connection: AgentMcpConnection | undefined): boolean {
  if (!connection || !isRecord(params) || !isRecord(params.item)) return false;
  return (
    params.item.type === 'mcpToolCall' &&
    params.item.server === connection.serverName &&
    typeof params.item.tool === 'string' &&
    connection.enabledTools.includes(params.item.tool as AgentMcpConnection['enabledTools'][number])
  );
}

function detectionFromAccount(
  base: ProviderDetection,
  result: CodexAccountResult,
): ProviderDetection {
  const account = result.account;
  if (!account) {
    return { ...base, authenticated: false, authSource: 'none', detail: 'Codex is not signed in.' };
  }
  const authSource = codexAuthSource(account.type);
  return {
    ...base,
    authenticated: true,
    authSource,
    ...(account.email ? { accountLabel: account.email } : {}),
    ...(account.planType ? { plan: account.planType } : {}),
  };
}

function codexAuthSource(type: string | undefined): AgentAuthSource {
  if (type === 'chatgpt') return 'chatgpt';
  if (type === 'apiKey') return 'openai-api-key';
  return 'unknown';
}

function belongsToThread(notification: RpcNotification, threadId: string): boolean {
  if (!isRecord(notification.params)) return false;
  const direct = notification.params.threadId;
  if (direct === threadId) return true;
  const thread = notification.params.thread;
  return isRecord(thread) && thread.id === threadId;
}

function extractItemType(params: unknown): string | undefined {
  if (!isRecord(params) || !isRecord(params.item)) return undefined;
  return typeof params.item.type === 'string' ? params.item.type : undefined;
}

function extractCompletedAgentText(params: unknown): string | undefined {
  if (!isRecord(params) || !isRecord(params.item) || params.item.type !== 'agentMessage')
    return undefined;
  if (typeof params.item.text === 'string') return params.item.text;
  if (!Array.isArray(params.item.content)) return undefined;
  return params.item.content
    .map((part) => (isRecord(part) && typeof part.text === 'string' ? part.text : ''))
    .join('');
}

function extractString(params: unknown, keys: readonly string[]): string | undefined {
  if (!isRecord(params)) return undefined;
  for (const key of keys) if (typeof params[key] === 'string') return params[key];
  return undefined;
}

function extractTurnStatus(params: unknown): string | undefined {
  if (!isRecord(params)) return undefined;
  if (isRecord(params.turn) && typeof params.turn.status === 'string') return params.turn.status;
  return typeof params.status === 'string' ? params.status : undefined;
}

function extractTurnError(params: unknown): string | undefined {
  if (!isRecord(params) || !isRecord(params.turn) || !isRecord(params.turn.error)) {
    return undefined;
  }
  const message = params.turn.error.message;
  if (typeof message !== 'string' || !message.trim()) return undefined;
  return redactSecrets(message.trim()).slice(0, 2_000);
}

function clampTimeout(value: number): number {
  if (!Number.isFinite(value)) return 120_000;
  return Math.min(30 * 60_000, Math.max(5_000, Math.floor(value)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
