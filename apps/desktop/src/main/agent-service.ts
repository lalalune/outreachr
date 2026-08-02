import { randomUUID } from 'node:crypto';
import { access, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  AgentRuntime,
  ClaudeAgentAdapter,
  CodexAgentAdapter,
  createAllowlist,
  grantCapability,
  resolvePackagedAgentExecutables,
  type AgentCapability,
  type AgentContextRecord,
  type AgentEvent as RuntimeEvent,
  type AgentMcpConnection,
  type AgentProposal,
  type DurableAgentAllowlist,
  type ProviderDetection,
} from '@outreachr/agents';
import type { PrivateField } from '@outreachr/mcp';
import type { AgentEvent, AgentProvider, AgentStatus } from '../shared/contracts';
import type { AgentRunRequest, AgentRuntimeController } from './agent-controller';
import type { DesktopMcpController } from './mcp-controller';

interface AgentServiceOptions {
  dataDirectory: string;
  resourcesRoot: string;
  openExternal: (url: string) => Promise<void>;
  mcp: DesktopMcpController;
  credentialStore: {
    status(): Promise<{ available: boolean }>;
    get<T>(key: string): Promise<T | null>;
    set(key: string, value: unknown): Promise<void>;
    delete(key: string): void;
  };
  preferenceStore: {
    getPreference<T>(key: string): T | null;
    setPreference(key: string, value: unknown): void;
    deletePreference(key: string): void;
  };
  persistVault: () => Promise<void>;
}

const CLAUDE_API_KEY_SECRET = 'agent/claude/api-key';
const CLAUDE_SUBSCRIPTION_APPROVAL = 'agent/claude/subscription-approval';

interface ClaudeSubscriptionApproval {
  approved: true;
  confirmedAt: string;
}

function statusFromDetection(
  detection: ProviderDetection,
  running = false,
  subscriptionFallback = false,
): AgentStatus {
  return {
    provider: detection.provider,
    state: !detection.installed
      ? 'not_installed'
      : running
        ? 'running'
        : detection.authenticated
          ? 'ready'
          : 'signed_out',
    version: detection.version ?? null,
    accountLabel: detection.accountLabel ?? detection.plan ?? null,
    mode: 'embedded',
    subscriptionAuthApproved:
      detection.provider === 'claude'
        ? (detection.subscriptionAuthApproved ?? subscriptionFallback)
        : false,
    error: detection.authenticated ? null : (detection.detail ?? null),
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeClaudeApiKey(value: string): string {
  const normalized = value.trim();
  if (normalized.length < 20 || normalized.length > 1_000 || /\s/u.test(normalized)) {
    throw new Error('Anthropic API key format is invalid');
  }
  return normalized;
}

export class DesktopAgentService implements AgentRuntimeController {
  readonly #runtime: AgentRuntime;
  readonly #claude: ClaudeAgentAdapter;
  readonly #openExternal: (url: string) => Promise<void>;
  readonly #mcp: DesktopMcpController;
  readonly #credentialStore: AgentServiceOptions['credentialStore'];
  readonly #preferenceStore: AgentServiceOptions['preferenceStore'];
  readonly #persistVault: () => Promise<void>;
  readonly #launchClaudeApiKey: string | undefined;
  readonly #active = new Map<string, AgentRunRequest>();
  readonly #pendingDeliveries = new Map<string, Set<Promise<void>>>();
  readonly #cachedStatuses = new Map<AgentProvider, AgentStatus>([
    [
      'codex',
      {
        provider: 'codex',
        state: 'signed_out',
        version: null,
        accountLabel: null,
        mode: 'embedded',
        subscriptionAuthApproved: false,
        error: null,
      },
    ],
    [
      'claude',
      {
        provider: 'claude',
        state: 'signed_out',
        version: null,
        accountLabel: null,
        mode: 'embedded',
        subscriptionAuthApproved: false,
        error: null,
      },
    ],
  ]);
  readonly #statusRevisions = new Map<AgentProvider, number>([
    ['codex', 0],
    ['claude', 0],
  ]);
  #statusRefresh: Promise<void> | null = null;
  #lastStatusRefreshAt = 0;
  #nextRunId: string | null = null;
  #claudeSubscriptionAuthApproved: boolean;
  #vaultRestoreInProgress = false;
  readonly #unsubscribe: () => void;

  private constructor(
    runtime: AgentRuntime,
    claude: ClaudeAgentAdapter,
    openExternal: (url: string) => Promise<void>,
    mcp: DesktopMcpController,
    credentialStore: AgentServiceOptions['credentialStore'],
    preferenceStore: AgentServiceOptions['preferenceStore'],
    persistVault: () => Promise<void>,
    claudeSubscriptionAuthApproved: boolean,
    launchClaudeApiKey: string | undefined,
  ) {
    this.#runtime = runtime;
    this.#claude = claude;
    this.#openExternal = openExternal;
    this.#mcp = mcp;
    this.#credentialStore = credentialStore;
    this.#preferenceStore = preferenceStore;
    this.#persistVault = persistVault;
    this.#claudeSubscriptionAuthApproved = claudeSubscriptionAuthApproved;
    this.#launchClaudeApiKey = launchClaudeApiKey;
    this.#unsubscribe = runtime.subscribe((event) => this.#handleEvent(event));
  }

  static async create(options: AgentServiceOptions): Promise<DesktopAgentService> {
    const workspaceDirectory = join(options.dataDirectory, 'agent-workspace');
    await mkdir(workspaceDirectory, { recursive: true, mode: 0o700 });
    const packaged = resolvePackagedAgentExecutables(options.resourcesRoot);
    const codexExecutable = (await exists(packaged.codex)) ? packaged.codex : 'codex';
    const claudeExecutable = (await exists(packaged.claude)) ? packaged.claude : 'claude';
    const claudeEnvironment: NodeJS.ProcessEnv = { ...process.env };
    // Setup tokens are intentionally unsupported. Subscription mode delegates
    // authentication to the official local Claude runtime and its OS keychain.
    delete claudeEnvironment.CLAUDE_CODE_OAUTH_TOKEN;
    const launchClaudeApiKey = claudeEnvironment.ANTHROPIC_API_KEY;
    let claudeSubscriptionAuthApproved = false;
    try {
      const approval = options.preferenceStore.getPreference<ClaudeSubscriptionApproval>(
        CLAUDE_SUBSCRIPTION_APPROVAL,
      );
      claudeSubscriptionAuthApproved =
        approval?.approved === true &&
        typeof approval.confirmedAt === 'string' &&
        approval.confirmedAt.length > 0;
    } catch {
      // Invalid local preference data fails closed without blocking startup.
    }
    try {
      if ((await options.credentialStore.status()).available) {
        const stored = await options.credentialStore.get<{ apiKey?: unknown }>(
          CLAUDE_API_KEY_SECRET,
        );
        if (typeof stored?.apiKey === 'string') {
          claudeEnvironment.ANTHROPIC_API_KEY = normalizeClaudeApiKey(stored.apiKey);
        }
      }
    } catch {
      // A locked/unavailable OS secret backend must not block the local workspace.
      // Claude remains signed out and Settings exposes the credential-storage state.
    }
    const claude = new ClaudeAgentAdapter({
      workspaceDirectory,
      executable: claudeExecutable,
      environment: claudeEnvironment,
      allowSubscriptionAuth: claudeSubscriptionAuthApproved,
      clearEnvironmentCredential: async () => {
        options.credentialStore.delete(CLAUDE_API_KEY_SECRET);
        await options.persistVault();
      },
    });
    const holder: { service?: DesktopAgentService } = {};
    const runtime = new AgentRuntime({
      adapters: [
        new CodexAgentAdapter({
          workspaceDirectory,
          executable: codexExecutable,
          mcpBearerToken: options.mcp.bearerToken,
        }),
        claude,
      ],
      ids: {
        next: () =>
          holder.service
            ? (holder.service.#nextRunId ?? `run:${randomUUID()}`)
            : `run:${randomUUID()}`,
      },
    });
    const service = new DesktopAgentService(
      runtime,
      claude,
      options.openExternal,
      options.mcp,
      options.credentialStore,
      options.preferenceStore,
      options.persistVault,
      claudeSubscriptionAuthApproved,
      launchClaudeApiKey,
    );
    holder.service = service;
    return service;
  }

  async statuses(): Promise<AgentStatus[]> {
    const refresh = this.#refreshStatuses();
    // Provider CLIs can legitimately wait on account/keyring state. Give already-resolved
    // test and cached probes one microtask turn, but never couple first paint to a sidecar.
    await Promise.race([refresh, new Promise<void>((resolve) => setTimeout(resolve, 0))]);
    return this.#statusSnapshot();
  }

  async detect(provider: AgentProvider): Promise<AgentStatus> {
    const revision = this.#beginStatusUpdate(provider);
    const status = statusFromDetection(
      await this.#runtime.detect(provider),
      false,
      this.#claudeSubscriptionAuthApproved,
    );
    this.#cacheStatus(provider, revision, status);
    return this.#withRunningState(status);
  }

  async login(provider: AgentProvider): Promise<AgentStatus> {
    const revision = this.#beginStatusUpdate(provider);
    const challenge = await this.#runtime.login({
      provider,
      mode:
        provider === 'codex'
          ? 'browser'
          : this.#claudeSubscriptionAuthApproved
            ? 'official-cli'
            : 'api-key',
    });
    if (challenge.url) await this.#openExternal(challenge.url);
    const detected = await this.#runtime.detect(provider);
    const status: AgentStatus = {
      ...statusFromDetection(detected, false, this.#claudeSubscriptionAuthApproved),
      error: detected.authenticated ? null : challenge.instructions,
    };
    this.#cacheStatus(provider, revision, status);
    return this.#withRunningState(status);
  }

  async logout(provider: AgentProvider): Promise<AgentStatus> {
    this.#beginStatusUpdate(provider);
    await this.#runtime.logout(provider);
    return this.detect(provider);
  }

  async setCredential(provider: 'claude', credential: string): Promise<AgentStatus> {
    if (provider !== 'claude') throw new Error('Unsupported agent credential provider');
    if (this.#vaultRestoreInProgress) {
      throw new Error('Claude credentials cannot change while a backup restore is in progress');
    }
    if ([...this.#active.values()].some((run) => run.provider === 'claude')) {
      throw new Error('Claude credentials cannot change while a run is active');
    }
    const apiKey = normalizeClaudeApiKey(credential);
    await this.#credentialStore.set(CLAUDE_API_KEY_SECRET, { apiKey });
    this.#preferenceStore.deletePreference(CLAUDE_SUBSCRIPTION_APPROVAL);
    await this.#persistVault();
    this.#claude.setApiKey(apiKey);
    this.#claude.setSubscriptionAuthApproved(false);
    this.#claudeSubscriptionAuthApproved = false;
    return this.detect('claude');
  }

  async removeCredential(provider: 'claude'): Promise<AgentStatus> {
    if (provider !== 'claude') throw new Error('Unsupported agent credential provider');
    if (this.#vaultRestoreInProgress) {
      throw new Error('Claude credentials cannot change while a backup restore is in progress');
    }
    if ([...this.#active.values()].some((run) => run.provider === 'claude')) {
      throw new Error('Claude credentials cannot change while a run is active');
    }
    this.#credentialStore.delete(CLAUDE_API_KEY_SECRET);
    await this.#persistVault();
    this.#claude.setApiKey(null);
    return this.detect('claude');
  }

  async setSubscriptionAuthApproved(provider: 'claude', approved: boolean): Promise<AgentStatus> {
    if (provider !== 'claude') throw new Error('Unsupported subscription-auth provider');
    if (this.#vaultRestoreInProgress) {
      throw new Error(
        'Claude authentication mode cannot change while a backup restore is in progress',
      );
    }
    if ([...this.#active.values()].some((run) => run.provider === 'claude')) {
      throw new Error('Claude authentication mode cannot change while a run is active');
    }
    if (approved) {
      this.#preferenceStore.setPreference(CLAUDE_SUBSCRIPTION_APPROVAL, {
        approved: true,
        confirmedAt: new Date().toISOString(),
      } satisfies ClaudeSubscriptionApproval);
    } else {
      this.#preferenceStore.deletePreference(CLAUDE_SUBSCRIPTION_APPROVAL);
    }
    await this.#persistVault();
    this.#claude.setSubscriptionAuthApproved(approved);
    this.#claudeSubscriptionAuthApproved = approved;
    return this.detect('claude');
  }

  beginVaultRestore(): () => void {
    if (this.#vaultRestoreInProgress) {
      throw new Error('A backup restore is already in progress');
    }
    if (this.#active.size > 0) {
      throw new Error('A backup cannot be restored while an agent run is active');
    }
    this.#vaultRestoreInProgress = true;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#vaultRestoreInProgress = false;
    };
  }

  async reloadAfterVaultRestore(): Promise<AgentStatus[]> {
    if (!this.#vaultRestoreInProgress) {
      throw new Error('Agent authentication can reload only while a backup restore lease is held');
    }
    if (this.#active.size > 0) {
      throw new Error('Agent authentication cannot reload while an agent run is active');
    }
    let approved = false;
    try {
      const approval = this.#preferenceStore.getPreference<ClaudeSubscriptionApproval>(
        CLAUDE_SUBSCRIPTION_APPROVAL,
      );
      approved =
        approval?.approved === true &&
        typeof approval.confirmedAt === 'string' &&
        approval.confirmedAt.length > 0;
    } catch {
      // A malformed replacement preference fails closed.
    }

    let apiKey = this.#launchClaudeApiKey;
    try {
      if ((await this.#credentialStore.status()).available) {
        const stored = await this.#credentialStore.get<{ apiKey?: unknown }>(CLAUDE_API_KEY_SECRET);
        if (typeof stored?.apiKey === 'string') apiKey = normalizeClaudeApiKey(stored.apiKey);
      }
    } catch {
      // An unavailable or device-bound restored secret falls back to the explicit
      // launch environment; if none exists, Claude API-key mode is signed out.
    }

    try {
      this.#claude.setApiKey(apiKey ?? null);
    } catch {
      // Invalid inherited launch configuration must not preserve the pre-restore key.
      this.#claude.setApiKey(null);
    }
    this.#claude.setSubscriptionAuthApproved(approved);
    this.#claudeSubscriptionAuthApproved = approved;
    await this.detect('claude');
    return this.#statusSnapshot();
  }

  async run(request: AgentRunRequest): Promise<{ runId: string }> {
    if (this.#vaultRestoreInProgress) {
      throw new Error('An agent run cannot start while a backup restore is in progress');
    }
    if (this.#active.has(request.runId))
      throw new Error(`Agent run ${request.runId} already exists`);
    this.#active.set(request.runId, request);
    this.#nextRunId = request.runId;
    let mcpConnection: AgentMcpConnection | undefined;
    try {
      const disclosure = mcpDisclosure(request.context);
      mcpConnection = this.#mcp.registerSession({
        runId: request.runId,
        provider: request.provider,
        purpose: auditPurpose(request.prompt),
        readScopes: disclosure.readScopes,
        disclosedRecordIds: disclosure.recordIds,
        allowedPrivateFields: disclosure.privateFields,
        onProposal: (proposal) => request.onEvent(this.#proposalEvent(request.runId, proposal)),
      });
      const runtimeRequest = { ...this.#runtimeRequest(request), mcp: mcpConnection };
      const handle = this.#runtime.run(runtimeRequest);
      void handle.result
        .catch(() => undefined)
        .then(() => this.#waitForDeliveries(request.runId))
        .finally(() => {
          this.#active.delete(request.runId);
          this.#mcp.unregisterSession(request.runId);
        });
    } catch (error) {
      this.#active.delete(request.runId);
      if (mcpConnection) this.#mcp.unregisterSession(request.runId);
      throw error;
    } finally {
      this.#nextRunId = null;
    }
    return { runId: request.runId };
  }

  async cancel(runId: string): Promise<{ cancelled: boolean }> {
    const cancelled = await this.#runtime.cancel(runId);
    if (cancelled) this.#mcp.unregisterSession(runId);
    return { cancelled };
  }

  async dispose(): Promise<void> {
    this.#unsubscribe();
    for (const runId of this.#active.keys()) this.#mcp.unregisterSession(runId);
    await this.#runtime.dispose();
  }

  #refreshStatuses(): Promise<void> {
    if (this.#statusRefresh) return this.#statusRefresh;
    if (Date.now() - this.#lastStatusRefreshAt < 30_000) return Promise.resolve();
    const revisions = new Map(this.#statusRevisions);
    const refresh = this.#runtime
      .detectAll()
      .then((detections) => {
        for (const detection of detections) {
          this.#cacheStatus(
            detection.provider,
            revisions.get(detection.provider) ?? 0,
            statusFromDetection(detection, false, this.#claudeSubscriptionAuthApproved),
          );
        }
      })
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : 'Agent detection failed.';
        for (const provider of ['codex', 'claude'] as const) {
          this.#cacheStatus(provider, revisions.get(provider) ?? 0, {
            provider,
            state: 'error',
            version: null,
            accountLabel: null,
            mode: 'embedded',
            subscriptionAuthApproved: provider === 'claude' && this.#claudeSubscriptionAuthApproved,
            error: detail,
          });
        }
      })
      .finally(() => {
        this.#lastStatusRefreshAt = Date.now();
        if (this.#statusRefresh === refresh) this.#statusRefresh = null;
      });
    this.#statusRefresh = refresh;
    return refresh;
  }

  #statusSnapshot(): AgentStatus[] {
    return (['codex', 'claude'] as const).map((provider) => {
      const status = this.#cachedStatuses.get(provider)!;
      return this.#withRunningState(status);
    });
  }

  #beginStatusUpdate(provider: AgentProvider): number {
    const revision = (this.#statusRevisions.get(provider) ?? 0) + 1;
    this.#statusRevisions.set(provider, revision);
    return revision;
  }

  #cacheStatus(provider: AgentProvider, revision: number, status: AgentStatus): void {
    if (this.#statusRevisions.get(provider) === revision) {
      this.#cachedStatuses.set(provider, status);
    }
  }

  #withRunningState(status: AgentStatus): AgentStatus {
    return [...this.#active.values()].some((run) => run.provider === status.provider)
      ? { ...status, state: 'running' }
      : status;
  }

  #runtimeRequest(request: AgentRunRequest): Parameters<AgentRuntime['run']>[0] {
    const records: AgentContextRecord[] = [];
    const capabilities = new Set<AgentCapability>();
    const add = (id: string, capability: AgentContextRecord['capability'], data: unknown): void => {
      if (data === undefined) return;
      records.push({ id, capability, data });
      capabilities.add(capability);
    };
    add('context:round', 'read.round', request.context.round);
    add('context:knowledge', 'read.knowledge', request.context.company);
    add(
      'context:investors',
      'read.investors',
      request.context.people === undefined
        ? request.context.investors
        : { investors: request.context.investors, people: request.context.people },
    );
    add('context:pipeline', 'read.pipeline', request.context.investors);
    const activity = asRecord(request.context.activity);
    add('context:interactions', 'read.interactions', request.context.activity);
    add('context:meetings', 'read.meetings', activity.meetings);
    add('context:tasks', 'read.tasks', activity.tasks);
    add('context:drafts', 'read.drafts', activity.drafts);
    for (const capability of [
      'propose.draft',
      'propose.task',
      'propose.pipeline_move',
      'propose.note',
      'propose.research',
    ] as const)
      capabilities.add(capability);
    let allowlist: DurableAgentAllowlist = createAllowlist();
    for (const capability of capabilities)
      allowlist = grantCapability(allowlist, { capability, provider: request.provider });
    return {
      provider: request.provider,
      intent: request.prompt,
      allowlist,
      context: records,
      // Claude needs a follow-up conversation turn after an MCP tool result;
      // each adapter still applies its own strict upper bound.
      maxTurns: 4,
      timeoutMs: 5 * 60_000,
    };
  }

  #handleEvent(event: RuntimeEvent): void {
    if (!('runId' in event)) return;
    const request = this.#active.get(event.runId);
    if (!request) return;
    let translated: AgentEvent | null = null;
    if (event.type === 'run.started')
      translated = {
        runId: event.runId,
        type: 'started',
        text: `${event.provider} started locally.`,
      };
    else if (event.type === 'run.output_delta')
      translated = { runId: event.runId, type: 'message', text: event.text };
    else if (event.type === 'run.proposal')
      translated = this.#proposalEvent(event.runId, {
        ...event.proposal,
        // Final structured-output IDs are model-controlled and may repeat
        // across runs. MCP proposals bypass this path and retain the stable
        // host-generated ID returned by their tool call.
        id: `proposal:agent:${randomUUID()}`,
      });
    else if (event.type === 'run.completed')
      translated = { runId: event.runId, type: 'completed', text: event.result.summary };
    else if (event.type === 'run.cancelled')
      translated = { runId: event.runId, type: 'error', text: 'Agent run cancelled.' };
    else if (event.type === 'run.failed')
      translated = { runId: event.runId, type: 'error', text: event.message };
    if (translated) this.#deliverEvent(request, translated);
  }

  #deliverEvent(request: AgentRunRequest, event: AgentEvent): void {
    let delivery: Promise<void>;
    try {
      delivery = Promise.resolve(request.onEvent(event));
    } catch (error) {
      delivery = Promise.reject(
        error instanceof Error ? error : new Error('Unknown local persistence error.'),
      );
    }
    const handled = delivery.catch(async (error: unknown) => {
      if (event.type === 'error') return;
      const detail = error instanceof Error ? error.message : 'Unknown local persistence error.';
      try {
        await request.onEvent({
          runId: event.runId,
          type: 'error',
          text: `Outreachr could not persist an agent ${event.type} event: ${detail}`,
        });
      } catch {
        // The original rejection is handled. A failed error reporter must not
        // recurse or become an unhandled rejection.
      }
    });
    const pending = this.#pendingDeliveries.get(event.runId) ?? new Set<Promise<void>>();
    this.#pendingDeliveries.set(event.runId, pending);
    pending.add(handled);
    void handled.finally(() => {
      pending.delete(handled);
      if (pending.size === 0) this.#pendingDeliveries.delete(event.runId);
    });
  }

  async #waitForDeliveries(runId: string): Promise<void> {
    while (true) {
      const pending = this.#pendingDeliveries.get(runId);
      if (!pending?.size) return;
      await Promise.allSettled([...pending]);
    }
  }

  #proposalEvent(runId: string, proposal: AgentProposal): AgentEvent {
    return {
      runId,
      type: 'tool_proposal',
      text: `${proposal.title}\n${proposal.rationale}`,
      proposalId: proposal.id,
      proposal: {
        kind: proposal.kind,
        title: proposal.title,
        rationale: proposal.rationale,
        investorId: proposal.investorId ?? null,
        payload: { ...proposal.payload },
      },
    };
  }
}

function auditPurpose(prompt: string): string {
  return prompt.trim().slice(0, 500);
}

function mcpDisclosure(context: Record<string, unknown>): {
  recordIds: string[];
  privateFields: PrivateField[];
  readScopes: Array<'round' | 'company' | 'investors' | 'activity'>;
} {
  const recordIds = new Set<string>();
  const privateFields = new Set<PrivateField>();
  const readScopes = new Set<'round' | 'company' | 'investors' | 'activity'>();
  const addId = (value: unknown): void => {
    if (typeof value === 'string' && value.trim()) recordIds.add(value);
  };
  const addEntity = (value: unknown): void => {
    const entity = asRecord(value);
    addId(entity.id);
    addId(entity.investorId);
    addId(entity.personId);
    addId(entity.firmId);
    if (Array.isArray(entity.personIds)) entity.personIds.forEach(addId);
  };
  const addEntities = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(addEntity);
  };

  if (context.round !== undefined) {
    readScopes.add('round');
    addEntity(context.round);
    privateFields.add('round_financials');
    privateFields.add('notes');
  }
  if (context.company !== undefined) {
    readScopes.add('company');
    addEntities(context.company);
    privateFields.add('knowledge_content');
  }
  if (context.investors !== undefined || context.people !== undefined) {
    readScopes.add('investors');
    addEntities(context.investors);
    addEntities(context.people);
    privateFields.add('workflow');
  }
  if (context.activity !== undefined) {
    readScopes.add('activity');
    const activity = asRecord(context.activity);
    addEntities(activity.tasks);
    addEntities(activity.meetings);
    addEntities(activity.drafts);
    addEntities(activity.mailEvents);
    addEntities(activity.agentProposals);
    privateFields.add('activity_detail');
    privateFields.add('meeting_attendees');
    privateFields.add('notes');
  }
  return {
    recordIds: [...recordIds],
    privateFields: [...privateFields],
    readScopes: [...readScopes],
  };
}
