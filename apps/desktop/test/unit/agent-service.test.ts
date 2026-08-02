import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentEvent as RuntimeEvent,
  AgentMcpConnection,
  AgentResult,
  AgentRunRequest as RuntimeRunRequest,
  DurableAgentAllowlist,
  LoginChallenge,
  LoginRequest,
  ProviderDetection,
} from '@outreachr/agents';
import type { AgentEvent } from '../../src/shared/contracts';
import type { AgentRunRequest } from '../../src/main/agent-controller';
import type {
  DesktopMcpController,
  DesktopMcpSessionRegistration,
} from '../../src/main/mcp-controller';

interface RuntimeOptions {
  adapters: Array<{ provider: 'codex' | 'claude' }>;
  ids: { next(prefix: string): string };
}

interface FakeRuntime {
  options: RuntimeOptions;
  detections: ProviderDetection[];
  detectAllResult: Promise<ProviderDetection[]> | null;
  loginChallenge: LoginChallenge;
  loginRequests: LoginRequest[];
  logoutRequests: Array<'codex' | 'claude'>;
  runRequests: RuntimeRunRequest[];
  runResult: Promise<AgentResult>;
  runError: Error | null;
  cancelRequests: string[];
  cancelResult: boolean;
  disposed: boolean;
  unsubscribed: boolean;
  emit(event: RuntimeEvent): void;
}

interface FakeAdapter {
  provider: 'codex' | 'claude';
  apiKeyUpdates: Array<string | null>;
  subscriptionAuthUpdates: boolean[];
  options: {
    workspaceDirectory: string;
    executable: string;
    environment?: NodeJS.ProcessEnv;
    mcpBearerToken?: string;
    allowSubscriptionAuth?: boolean;
  };
}

interface FakeMcpController extends DesktopMcpController {
  registrations: DesktopMcpSessionRegistration[];
  unregistered: string[];
}

const agentMocks = vi.hoisted(() => ({
  runtimes: [] as unknown[],
  adapters: [] as unknown[],
}));

vi.mock('@outreachr/agents', () => {
  class FakeAdapterImplementation {
    readonly provider: 'codex' | 'claude';
    readonly options: FakeAdapter['options'];
    readonly apiKeyUpdates: Array<string | null> = [];
    readonly subscriptionAuthUpdates: boolean[] = [];

    constructor(provider: 'codex' | 'claude', options: FakeAdapter['options']) {
      this.provider = provider;
      this.options = options;
      agentMocks.adapters.push(this);
    }

    setApiKey(value: string | null): void {
      this.apiKeyUpdates.push(value);
    }

    setSubscriptionAuthApproved(approved: boolean): void {
      this.subscriptionAuthUpdates.push(approved);
    }
  }

  class CodexAgentAdapter extends FakeAdapterImplementation {
    constructor(options: FakeAdapter['options']) {
      super('codex', options);
    }
  }

  class ClaudeAgentAdapter extends FakeAdapterImplementation {
    constructor(options: FakeAdapter['options']) {
      super('claude', options);
    }
  }

  class AgentRuntime implements FakeRuntime {
    readonly options: RuntimeOptions;
    detections: ProviderDetection[] = [
      {
        provider: 'codex',
        installed: true,
        authenticated: true,
        authSource: 'chatgpt',
        version: 'codex-test',
        accountLabel: 'ChatGPT test account',
        subscriptionAuthApproved: false,
      },
      {
        provider: 'claude',
        installed: true,
        authenticated: false,
        authSource: 'none',
        version: 'claude-test',
        subscriptionAuthApproved: false,
      },
    ];
    detectAllResult: Promise<ProviderDetection[]> | null = null;
    loginChallenge: LoginChallenge = {
      provider: 'codex',
      kind: 'browser',
      url: 'https://auth.example.test/codex',
      instructions: 'Complete sign-in in the browser.',
    };
    readonly loginRequests: LoginRequest[] = [];
    readonly logoutRequests: Array<'codex' | 'claude'> = [];
    readonly runRequests: RuntimeRunRequest[] = [];
    runResult: Promise<AgentResult> = Promise.resolve({ summary: 'Done', proposals: [] });
    runError: Error | null = null;
    readonly cancelRequests: string[] = [];
    cancelResult = true;
    disposed = false;
    unsubscribed = false;
    #listener: ((event: RuntimeEvent) => void) | null = null;

    constructor(options: RuntimeOptions) {
      this.options = options;
      agentMocks.runtimes.push(this);
    }

    subscribe(listener: (event: RuntimeEvent) => void): () => void {
      this.#listener = listener;
      return () => {
        this.unsubscribed = true;
        this.#listener = null;
      };
    }

    async detectAll(): Promise<ProviderDetection[]> {
      return this.detectAllResult ?? this.detections;
    }

    async detect(provider: 'codex' | 'claude'): Promise<ProviderDetection> {
      const detection = this.detections.find((item) => item.provider === provider);
      if (!detection) throw new Error(`No ${provider} detection fixture`);
      return detection;
    }

    async login(request: LoginRequest): Promise<LoginChallenge> {
      this.loginRequests.push(request);
      return this.loginChallenge;
    }

    async logout(provider: 'codex' | 'claude'): Promise<void> {
      this.logoutRequests.push(provider);
    }

    run(request: RuntimeRunRequest): {
      id: string;
      provider: 'codex' | 'claude';
      result: Promise<AgentResult>;
    } {
      if (this.runError) throw this.runError;
      this.runRequests.push(request);
      return {
        id: this.options.ids.next('run'),
        provider: request.provider,
        result: this.runResult,
      };
    }

    async cancel(runId: string): Promise<boolean> {
      this.cancelRequests.push(runId);
      return this.cancelResult;
    }

    async dispose(): Promise<void> {
      this.disposed = true;
    }

    emit(event: RuntimeEvent): void {
      this.#listener?.(event);
    }
  }

  return {
    AgentRuntime,
    CodexAgentAdapter,
    ClaudeAgentAdapter,
    resolvePackagedAgentExecutables: (resourcesRoot: string) => ({
      codex: `${resourcesRoot}/missing-codex-sidecar`,
      claude: `${resourcesRoot}/missing-claude-sidecar`,
    }),
    createAllowlist: (): DurableAgentAllowlist => ({
      version: 1,
      revision: 0,
      updatedAt: '2026-07-31T19:00:00.000Z',
      grants: [],
    }),
    grantCapability: (
      allowlist: DurableAgentAllowlist,
      input: { capability: string; provider: 'codex' | 'claude' },
    ): DurableAgentAllowlist => ({
      ...allowlist,
      revision: allowlist.revision + 1,
      grants: [
        ...allowlist.grants,
        {
          id: `grant:${input.capability}`,
          capability: input.capability,
          provider: input.provider,
          createdAt: '2026-07-31T19:00:00.000Z',
          createdBy: 'founder',
        },
      ],
    }),
  };
});

import { DesktopAgentService } from '../../src/main/agent-service';
import { removeTemporaryDirectory, temporaryDirectory } from '../helpers/vault';

function runtime(): FakeRuntime {
  const value = agentMocks.runtimes.at(-1);
  if (!value) throw new Error('DesktopAgentService did not create a runtime');
  return value as FakeRuntime;
}

function adapters(): FakeAdapter[] {
  return agentMocks.adapters as FakeAdapter[];
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('DesktopAgentService', () => {
  const directories: string[] = [];
  const originalClaudeToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const originalAnthropicKey = process.env.ANTHROPIC_API_KEY;

  afterEach(async () => {
    agentMocks.runtimes.length = 0;
    agentMocks.adapters.length = 0;
    if (originalClaudeToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = originalClaudeToken;
    if (originalAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
    await Promise.all(directories.splice(0).map(removeTemporaryDirectory));
  });

  async function fixture(
    options: { storedApiKey?: string; subscriptionApproved?: boolean } = {},
  ): Promise<{
    service: DesktopAgentService;
    openExternal: ReturnType<typeof vi.fn>;
    mcp: FakeMcpController;
    credentialStore: {
      status: ReturnType<typeof vi.fn>;
      get: ReturnType<typeof vi.fn>;
      set: ReturnType<typeof vi.fn>;
      delete: ReturnType<typeof vi.fn>;
    };
    preferenceStore: {
      getPreference: ReturnType<typeof vi.fn>;
      setPreference: ReturnType<typeof vi.fn>;
      deletePreference: ReturnType<typeof vi.fn>;
    };
    persistVault: ReturnType<typeof vi.fn>;
  }> {
    const dataDirectory = await temporaryDirectory('desktop-agents');
    directories.push(dataDirectory);
    const openExternal = vi.fn(async () => undefined);
    const storedCredentials = new Map<string, unknown>();
    if (options.storedApiKey) {
      storedCredentials.set('agent/claude/api-key', { apiKey: options.storedApiKey });
    }
    const storedPreferences = new Map<string, unknown>();
    if (options.subscriptionApproved) {
      storedPreferences.set('agent/claude/subscription-approval', {
        approved: true,
        confirmedAt: '2026-08-01T18:00:00.000Z',
      });
    }
    const credentialStore = {
      status: vi.fn(async () => ({ available: true })),
      get: vi.fn(async (key: string) => storedCredentials.get(key) ?? null),
      set: vi.fn(async (key: string, value: unknown) => {
        storedCredentials.set(key, value);
      }),
      delete: vi.fn((key: string) => {
        storedCredentials.delete(key);
      }),
    };
    const preferenceStore = {
      getPreference: vi.fn((key: string) => storedPreferences.get(key) ?? null),
      setPreference: vi.fn((key: string, value: unknown) => {
        storedPreferences.set(key, value);
      }),
      deletePreference: vi.fn((key: string) => {
        storedPreferences.delete(key);
      }),
    };
    const persistVault = vi.fn(async () => undefined);
    const mcp: FakeMcpController = {
      bearerToken: 'desktop-test-mcp-token-0123456789abcdef',
      registrations: [],
      unregistered: [],
      registerSession(registration): AgentMcpConnection {
        this.registrations.push(registration);
        return {
          serverName: 'outreachr',
          url: 'http://127.0.0.1:43123/mcp',
          bearerToken: this.bearerToken,
          sessionId: registration.runId,
          auditPurpose: registration.purpose,
          enabledTools: [
            'outreachr_search_investors',
            'outreachr_propose_stage',
            'outreachr_propose_task',
            'outreachr_propose_draft',
          ],
        };
      },
      unregisterSession(runId): void {
        this.unregistered.push(runId);
      },
    };
    const service = await DesktopAgentService.create({
      dataDirectory,
      resourcesRoot: `${dataDirectory}/resources`,
      openExternal,
      mcp,
      credentialStore,
      preferenceStore,
      persistVault,
    });
    return { service, openExternal, mcp, credentialStore, preferenceStore, persistVault };
  }

  it('uses API-key authentication safely and maps detection/login/logout states', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'founder-established-token';
    process.env.ANTHROPIC_API_KEY = 'founder-controlled-api-key';
    const { service, openExternal } = await fixture();
    const createdAdapters = adapters();
    expect(createdAdapters.map((adapter) => adapter.provider).sort()).toEqual(['claude', 'codex']);
    const codex = createdAdapters.find((adapter) => adapter.provider === 'codex');
    const claude = createdAdapters.find((adapter) => adapter.provider === 'claude');
    expect(codex?.options.executable).toBe('codex');
    expect(claude?.options.executable).toBe('claude');
    expect(codex?.options.workspaceDirectory).toMatch(/agent-workspace$/u);
    expect(codex?.options.mcpBearerToken).toBe('desktop-test-mcp-token-0123456789abcdef');
    expect(claude?.options.environment).toMatchObject({
      ANTHROPIC_API_KEY: 'founder-controlled-api-key',
    });
    expect(claude?.options.environment).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');
    expect(claude?.options.allowSubscriptionAuth).toBe(false);

    const fake = runtime();
    fake.detections = [
      {
        provider: 'codex',
        installed: false,
        authenticated: false,
        authSource: 'none',
        detail: 'Codex sidecar not found',
      },
      {
        provider: 'claude',
        installed: true,
        authenticated: false,
        authSource: 'none',
        version: '1.2.3',
        plan: 'Claude subscription',
      },
    ];
    await expect(service.statuses()).resolves.toEqual([
      {
        provider: 'codex',
        state: 'not_installed',
        version: null,
        accountLabel: null,
        mode: 'embedded',
        subscriptionAuthApproved: false,
        error: 'Codex sidecar not found',
      },
      {
        provider: 'claude',
        state: 'signed_out',
        version: '1.2.3',
        accountLabel: 'Claude subscription',
        mode: 'embedded',
        subscriptionAuthApproved: false,
        error: null,
      },
    ]);

    fake.loginChallenge = {
      provider: 'codex',
      kind: 'browser',
      url: 'https://auth.example.test/codex',
      instructions: 'Finish browser login.',
    };
    await expect(service.login('codex')).resolves.toMatchObject({
      state: 'not_installed',
      error: 'Finish browser login.',
    });
    expect(fake.loginRequests).toEqual([{ provider: 'codex', mode: 'browser' }]);
    expect(openExternal).toHaveBeenCalledOnce();
    expect(openExternal).toHaveBeenCalledWith('https://auth.example.test/codex');

    fake.loginChallenge = {
      provider: 'claude',
      kind: 'environment',
      environmentVariable: 'ANTHROPIC_API_KEY',
      instructions: 'Configure the founder-controlled API key.',
    };
    fake.detections[1] = {
      provider: 'claude',
      installed: true,
      authenticated: true,
      authSource: 'anthropic-api-key',
      accountLabel: 'Founder API key',
    };
    await expect(service.login('claude')).resolves.toMatchObject({
      state: 'ready',
      accountLabel: 'Founder API key',
      error: null,
    });
    expect(fake.loginRequests.at(-1)).toEqual({ provider: 'claude', mode: 'api-key' });
    await service.logout('claude');
    expect(fake.logoutRequests).toEqual(['claude']);

    await service.dispose();
    expect(fake.unsubscribed).toBe(true);
    expect(fake.disposed).toBe(true);
  });

  it('loads, replaces, and removes the encrypted Claude key without returning it in status', async () => {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;
    const storedKey = 'sk-ant-stored-credential-0000000001';
    const replacementKey = 'sk-ant-replacement-credential-0002';
    const { service, credentialStore, persistVault } = await fixture({ storedApiKey: storedKey });
    const claude = adapters().find((adapter) => adapter.provider === 'claude')!;
    expect(claude.options.environment?.ANTHROPIC_API_KEY).toBe(storedKey);

    const saved = await service.setCredential('claude', replacementKey);
    expect(credentialStore.set).toHaveBeenCalledWith('agent/claude/api-key', {
      apiKey: replacementKey,
    });
    expect(claude.apiKeyUpdates).toEqual([replacementKey]);
    expect(JSON.stringify(saved)).not.toContain(replacementKey);

    const removed = await service.removeCredential('claude');
    expect(credentialStore.delete).toHaveBeenCalledWith('agent/claude/api-key');
    expect(claude.apiKeyUpdates).toEqual([replacementKey, null]);
    expect(JSON.stringify(removed)).not.toContain(storedKey);
    expect(persistVault).toHaveBeenCalledTimes(2);
  });

  it('persists explicit approved subscription mode and keeps it separate from API-key mode', async () => {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;
    const storedKey = 'sk-ant-encrypted-fallback-credential-0001';
    const { service, preferenceStore, persistVault } = await fixture({
      storedApiKey: storedKey,
      subscriptionApproved: true,
    });
    const claude = adapters().find((adapter) => adapter.provider === 'claude')!;
    expect(claude.options.allowSubscriptionAuth).toBe(true);
    expect(claude.options.environment?.ANTHROPIC_API_KEY).toBe(storedKey);
    expect(claude.options.environment).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');

    const fake = runtime();
    fake.detections[1] = {
      provider: 'claude',
      installed: true,
      authenticated: true,
      authSource: 'claude-code',
      version: '2.1.220',
      accountLabel: 'founder@example.test',
      plan: 'Max',
      subscriptionAuthApproved: true,
    };
    fake.loginChallenge = {
      provider: 'claude',
      kind: 'external-command',
      command: 'claude auth login --claudeai',
      instructions: 'Run the official Claude sign-in command, then select Detect.',
    };
    await expect(service.login('claude')).resolves.toMatchObject({
      provider: 'claude',
      state: 'ready',
      subscriptionAuthApproved: true,
    });
    expect(fake.loginRequests.at(-1)).toEqual({ provider: 'claude', mode: 'official-cli' });

    fake.detections[1] = {
      ...fake.detections[1]!,
      authenticated: false,
      authSource: 'none',
      subscriptionAuthApproved: false,
    };
    await expect(service.setSubscriptionAuthApproved('claude', false)).resolves.toMatchObject({
      subscriptionAuthApproved: false,
    });
    expect(preferenceStore.deletePreference).toHaveBeenCalledWith(
      'agent/claude/subscription-approval',
    );
    expect(claude.subscriptionAuthUpdates).toEqual([false]);

    fake.detections[1] = {
      ...fake.detections[1]!,
      authenticated: true,
      authSource: 'claude-code',
      subscriptionAuthApproved: true,
    };
    await expect(service.setSubscriptionAuthApproved('claude', true)).resolves.toMatchObject({
      subscriptionAuthApproved: true,
    });
    expect(preferenceStore.setPreference).toHaveBeenCalledWith(
      'agent/claude/subscription-approval',
      expect.objectContaining({ approved: true, confirmedAt: expect.any(String) }),
    );
    expect(claude.subscriptionAuthUpdates).toEqual([false, true]);
    expect(persistVault).toHaveBeenCalledTimes(2);
  });

  it('rehydrates both Claude authentication modes from a replacement backup vault', async () => {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;
    const oldKey = 'sk-ant-before-restore-credential-000001';
    const restoredKey = 'sk-ant-restored-credential-00000002';
    const { service, credentialStore, preferenceStore } = await fixture({
      storedApiKey: oldKey,
      subscriptionApproved: true,
    });
    const claude = adapters().find((adapter) => adapter.provider === 'claude')!;
    const fake = runtime();

    preferenceStore.getPreference.mockReturnValue(null);
    credentialStore.get.mockResolvedValue(null);
    fake.detections[1] = {
      provider: 'claude',
      installed: true,
      authenticated: false,
      authSource: 'none',
      version: 'claude-restored-disabled',
      subscriptionAuthApproved: false,
    };
    const releaseDisabledRestore = service.beginVaultRestore();
    await expect(
      service.run({
        runId: 'run:during-restore',
        provider: 'claude',
        prompt: 'This must not start.',
        disclosedContextIds: [],
        context: {},
        onEvent: vi.fn(),
      }),
    ).rejects.toThrow('cannot start while a backup restore is in progress');
    await expect(service.reloadAfterVaultRestore()).resolves.toContainEqual(
      expect.objectContaining({
        provider: 'claude',
        state: 'signed_out',
        subscriptionAuthApproved: false,
      }),
    );
    expect(claude.apiKeyUpdates).toEqual([null]);
    expect(claude.subscriptionAuthUpdates).toEqual([false]);
    releaseDisabledRestore();
    releaseDisabledRestore();

    preferenceStore.getPreference.mockReturnValue({
      approved: true,
      confirmedAt: '2026-08-01T21:00:00.000Z',
    });
    credentialStore.get.mockResolvedValue({ apiKey: restoredKey });
    fake.detections[1] = {
      provider: 'claude',
      installed: true,
      authenticated: true,
      authSource: 'claude-code',
      version: 'claude-restored-approved',
      subscriptionAuthApproved: true,
    };
    const releaseApprovedRestore = service.beginVaultRestore();
    await expect(service.reloadAfterVaultRestore()).resolves.toContainEqual(
      expect.objectContaining({
        provider: 'claude',
        state: 'ready',
        subscriptionAuthApproved: true,
      }),
    );
    expect(claude.apiKeyUpdates).toEqual([null, restoredKey]);
    expect(claude.subscriptionAuthUpdates).toEqual([false, true]);
    releaseApprovedRestore();
  });

  it('returns fail-closed cached states without waiting for slow provider detection', async () => {
    const { service } = await fixture();
    const fake = runtime();
    const detection = deferred<ProviderDetection[]>();
    fake.detectAllResult = detection.promise;

    await expect(service.statuses()).resolves.toEqual([
      expect.objectContaining({ provider: 'codex', state: 'signed_out' }),
      expect.objectContaining({ provider: 'claude', state: 'signed_out' }),
    ]);

    fake.detections = [
      {
        provider: 'codex',
        installed: true,
        authenticated: true,
        authSource: 'chatgpt',
        version: 'codex-background',
      },
      {
        provider: 'claude',
        installed: true,
        authenticated: false,
        authSource: 'none',
        version: 'claude-background',
      },
    ];
    detection.resolve(fake.detections);
    await detection.promise;
    await Promise.resolve();

    await expect(service.statuses()).resolves.toEqual([
      expect.objectContaining({ provider: 'codex', state: 'ready', version: 'codex-background' }),
      expect.objectContaining({
        provider: 'claude',
        state: 'signed_out',
        version: 'claude-background',
      }),
    ]);
  });

  it('does not let an older background probe overwrite a newer login result', async () => {
    const { service } = await fixture();
    const fake = runtime();
    const background = deferred<ProviderDetection[]>();
    fake.detectAllResult = background.promise;
    await service.statuses();

    const stale = fake.detections;
    fake.detections = [
      {
        provider: 'codex',
        installed: true,
        authenticated: true,
        authSource: 'chatgpt',
        version: 'codex-new-login',
        accountLabel: 'Founder plan',
      },
      stale[1]!,
    ];
    await expect(service.login('codex')).resolves.toMatchObject({
      state: 'ready',
      version: 'codex-new-login',
      accountLabel: 'Founder plan',
    });

    background.resolve(stale);
    await background.promise;
    await Promise.resolve();
    await expect(service.statuses()).resolves.toContainEqual(
      expect.objectContaining({
        provider: 'codex',
        state: 'ready',
        version: 'codex-new-login',
        accountLabel: 'Founder plan',
      }),
    );
  });

  it('discloses only supplied context, grants proposal-only authority, and translates events', async () => {
    const { service, mcp } = await fixture();
    const fake = runtime();
    const completion = deferred<AgentResult>();
    fake.runResult = completion.promise;
    const events: AgentEvent[] = [];
    const request: AgentRunRequest = {
      runId: 'run:founder-reviewed',
      provider: 'codex',
      prompt: 'Research high-fit investors and propose next steps.',
      disclosedContextIds: ['round', 'company', 'investors', 'activity'],
      context: {
        round: { id: 'round:seed', stage: 'seed' },
        company: [{ id: 'knowledge:one', content: 'Approved context' }],
        investors: [{ id: 'investor:one', name: 'Example Ventures' }],
        activity: {
          meetings: [{ id: 'meeting:one' }],
          tasks: [{ id: 'task:one' }],
          drafts: [{ id: 'draft:one', approvalState: 'draft' }],
          mailEvents: [{ id: 'mail:one', subject: 'Founder-private thread' }],
          agentProposals: [{ id: 'proposal:pending', status: 'pending' }],
        },
      },
      onEvent: (event) => events.push(event),
    };

    await expect(service.run(request)).resolves.toEqual({ runId: request.runId });
    await expect(service.run(request)).rejects.toThrow('already exists');
    expect(fake.runRequests).toHaveLength(1);
    const runtimeRequest = fake.runRequests[0]!;
    expect(runtimeRequest).toMatchObject({
      provider: 'codex',
      intent: request.prompt,
      maxTurns: 4,
      timeoutMs: 300_000,
      mcp: {
        serverName: 'outreachr',
        sessionId: request.runId,
        auditPurpose: request.prompt,
      },
    });
    expect(mcp.registrations).toHaveLength(1);
    expect(mcp.registrations[0]).toMatchObject({
      runId: request.runId,
      provider: 'codex',
      purpose: request.prompt,
      readScopes: ['round', 'company', 'investors', 'activity'],
      disclosedRecordIds: expect.arrayContaining([
        'round:seed',
        'knowledge:one',
        'investor:one',
        'meeting:one',
        'task:one',
        'draft:one',
        'mail:one',
        'proposal:pending',
      ]),
      allowedPrivateFields: expect.arrayContaining([
        'round_financials',
        'knowledge_content',
        'workflow',
        'meeting_attendees',
      ]),
    });
    expect(runtimeRequest.context.map((record) => [record.id, record.capability])).toEqual([
      ['context:round', 'read.round'],
      ['context:knowledge', 'read.knowledge'],
      ['context:investors', 'read.investors'],
      ['context:pipeline', 'read.pipeline'],
      ['context:interactions', 'read.interactions'],
      ['context:meetings', 'read.meetings'],
      ['context:tasks', 'read.tasks'],
      ['context:drafts', 'read.drafts'],
    ]);
    const capabilities = runtimeRequest.allowlist.grants.map((grant) => grant.capability);
    expect(capabilities).toEqual(
      expect.arrayContaining([
        'read.round',
        'read.knowledge',
        'read.investors',
        'read.pipeline',
        'read.interactions',
        'read.meetings',
        'read.tasks',
        'read.drafts',
        'propose.draft',
        'propose.task',
        'propose.pipeline_move',
        'propose.note',
        'propose.research',
      ]),
    );
    expect(capabilities.some((capability) => capability.includes('send'))).toBe(false);
    expect(runtimeRequest.allowlist.grants.every((grant) => grant.provider === 'codex')).toBe(true);
    await expect(service.statuses()).resolves.toContainEqual(
      expect.objectContaining({ provider: 'codex', state: 'running' }),
    );
    await expect(service.detect('codex')).resolves.toMatchObject({
      provider: 'codex',
      state: 'running',
    });

    const at = '2026-07-31T19:00:00.000Z';
    fake.emit({
      type: 'run.started',
      runId: request.runId,
      provider: 'codex',
      at,
    });
    fake.emit({ type: 'run.output_delta', runId: request.runId, text: 'Researching.', at });
    fake.emit({
      type: 'run.proposal',
      runId: request.runId,
      proposal: {
        id: 'proposal:one',
        kind: 'task',
        title: 'Review investor fit',
        rationale: 'Evidence needs founder review.',
        payload: {},
        executable: false,
      },
      at,
    });
    fake.emit({
      type: 'run.completed',
      runId: request.runId,
      result: { summary: 'One proposal prepared.', proposals: [] },
      at,
    });
    fake.emit({
      type: 'auth.changed',
      provider: 'codex',
      authenticated: true,
      at,
    });
    fake.emit({
      type: 'run.completed',
      runId: 'run:not-active',
      result: { summary: 'Must be ignored.', proposals: [] },
      at,
    });
    expect(events).toEqual([
      { runId: request.runId, type: 'started', text: 'codex started locally.' },
      { runId: request.runId, type: 'message', text: 'Researching.' },
      {
        runId: request.runId,
        type: 'tool_proposal',
        text: 'Review investor fit\nEvidence needs founder review.',
        proposalId: expect.stringMatching(/^proposal:agent:[0-9a-f-]{36}$/u),
        proposal: {
          kind: 'task',
          title: 'Review investor fit',
          rationale: 'Evidence needs founder review.',
          investorId: null,
          payload: {},
        },
      },
      { runId: request.runId, type: 'completed', text: 'One proposal prepared.' },
    ]);
    expect(events[2]?.proposalId).not.toBe('proposal:one');
    await expect(service.cancel(request.runId)).resolves.toEqual({ cancelled: true });
    expect(fake.cancelRequests).toEqual([request.runId]);
    expect(mcp.unregistered).toContain(request.runId);

    completion.resolve({ summary: 'One proposal prepared.', proposals: [] });
    await completion.promise;
    await vi.waitFor(async () => {
      await expect(service.statuses()).resolves.toContainEqual(
        expect.objectContaining({ provider: 'codex', state: 'ready' }),
      );
    });
  });

  it('cleans up active state on synchronous launch failure and translates terminal errors', async () => {
    const { service } = await fixture();
    const fake = runtime();
    const events: AgentEvent[] = [];
    const baseRequest: AgentRunRequest = {
      runId: 'run:launch-failure',
      provider: 'claude',
      prompt: 'Prepare research only.',
      disclosedContextIds: [],
      context: {},
      onEvent: (event) => events.push(event),
    };
    fake.runError = new Error('Agent executable failed to launch');
    await expect(service.run(baseRequest)).rejects.toThrow('failed to launch');
    await expect(service.statuses()).resolves.toContainEqual(
      expect.objectContaining({ provider: 'claude', state: 'signed_out' }),
    );

    fake.runError = null;
    const completion = deferred<AgentResult>();
    fake.runResult = completion.promise;
    const request = { ...baseRequest, runId: 'run:terminal-events' };
    await service.run(request);
    expect(() => service.beginVaultRestore()).toThrow(
      'cannot be restored while an agent run is active',
    );
    await expect(service.setSubscriptionAuthApproved('claude', true)).rejects.toThrow(
      'cannot change while a run is active',
    );
    const at = '2026-07-31T19:00:00.000Z';
    fake.emit({ type: 'run.cancelled', runId: request.runId, at });
    fake.emit({
      type: 'run.failed',
      runId: request.runId,
      code: 'PROVIDER_ERROR',
      message: 'Provider returned an error.',
      at,
    });
    expect(events).toEqual([
      { runId: request.runId, type: 'error', text: 'Agent run cancelled.' },
      { runId: request.runId, type: 'error', text: 'Provider returned an error.' },
    ]);
    completion.reject(new Error('Provider returned an error.'));
    await expect(completion.promise).rejects.toThrow('Provider returned an error.');
    await Promise.resolve();
    const releaseRestore = service.beginVaultRestore();
    releaseRestore();
  });

  it('keeps the restore lease unavailable until asynchronous event persistence drains', async () => {
    const { service } = await fixture();
    const fake = runtime();
    const completion = deferred<AgentResult>();
    const persisted = deferred<void>();
    fake.runResult = completion.promise;
    const request: AgentRunRequest = {
      runId: 'run:pending-persistence',
      provider: 'claude',
      prompt: 'Prepare one local proposal.',
      disclosedContextIds: [],
      context: {},
      onEvent: (event) => (event.type === 'completed' ? persisted.promise : undefined),
    };

    await service.run(request);
    fake.emit({
      type: 'run.completed',
      runId: request.runId,
      result: { summary: 'Persist this before restoring.', proposals: [] },
      at: '2026-08-01T22:00:00.000Z',
    });
    completion.resolve({ summary: 'Persist this before restoring.', proposals: [] });
    await completion.promise;
    await Promise.resolve();
    expect(() => service.beginVaultRestore()).toThrow(
      'cannot be restored while an agent run is active',
    );

    persisted.resolve();
    await persisted.promise;
    await vi.waitFor(() => {
      const releaseRestore = service.beginVaultRestore();
      releaseRestore();
    });
  });

  it('rekeys repeated model proposal IDs per run and reports async event persistence failures', async () => {
    const { service } = await fixture();
    const fake = runtime();
    const completion = deferred<AgentResult>();
    fake.runResult = completion.promise;
    const firstEvents: AgentEvent[] = [];
    const secondEvents: AgentEvent[] = [];
    const request = (runId: string, onEvent: AgentRunRequest['onEvent']): AgentRunRequest => ({
      runId,
      provider: 'codex',
      prompt: 'Prepare one founder-reviewed task.',
      disclosedContextIds: [],
      context: {},
      onEvent,
    });
    await service.run(request('run:repeated-id:first', (event) => firstEvents.push(event)));
    await service.run(request('run:repeated-id:second', (event) => secondEvents.push(event)));
    const at = '2026-07-31T19:00:00.000Z';
    const repeatedProposal = {
      id: 'proposal-1',
      kind: 'task' as const,
      title: 'Review evidence',
      rationale: 'The founder must approve this.',
      payload: { title: 'Review evidence' },
      executable: false as const,
    };
    fake.emit({
      type: 'run.proposal',
      runId: 'run:repeated-id:first',
      proposal: repeatedProposal,
      at,
    });
    fake.emit({
      type: 'run.proposal',
      runId: 'run:repeated-id:second',
      proposal: repeatedProposal,
      at,
    });
    const firstId = firstEvents[0]?.proposalId;
    const secondId = secondEvents[0]?.proposalId;
    expect(firstId).toMatch(/^proposal:agent:[0-9a-f-]{36}$/u);
    expect(secondId).toMatch(/^proposal:agent:[0-9a-f-]{36}$/u);
    expect(firstId).not.toBe(secondId);
    expect(firstId).not.toBe(repeatedProposal.id);

    const reported: AgentEvent[] = [];
    await service.run(
      request('run:event-failure', async (event) => {
        if (event.type === 'tool_proposal') throw new Error('local proposal insert failed');
        reported.push(event);
      }),
    );
    fake.emit({
      type: 'run.proposal',
      runId: 'run:event-failure',
      proposal: repeatedProposal,
      at,
    });
    await vi.waitFor(() =>
      expect(reported).toContainEqual({
        runId: 'run:event-failure',
        type: 'error',
        text: expect.stringContaining(
          'could not persist an agent tool_proposal event: local proposal insert failed',
        ),
      }),
    );

    completion.resolve({ summary: 'Done', proposals: [] });
    await completion.promise;
    await Promise.resolve();
  });
});
