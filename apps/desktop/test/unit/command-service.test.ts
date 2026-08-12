import { access, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentStatus, ConnectorStatus } from '../../src/shared/contracts';
import type { AgentRuntimeController } from '../../src/main/agent-controller';
import type { ConnectorService } from '../../src/main/connector-service';
import type { VaultService } from '../../src/main/vault-service';
import { CommandService } from '../../src/main/command-service';
import {
  firstPersonWithoutEmail,
  initializedVault,
  removeTemporaryDirectory,
  temporaryDirectory,
} from '../helpers/vault';

const CONNECTORS: ConnectorStatus[] = [
  {
    provider: 'google',
    state: 'not_configured',
    accountEmail: null,
    scopes: [],
    relationshipSync: false,
    lastSyncAt: null,
    error: null,
    encryptionAvailable: true,
  },
  {
    provider: 'microsoft',
    state: 'not_configured',
    accountEmail: null,
    scopes: [],
    relationshipSync: false,
    lastSyncAt: null,
    error: null,
    encryptionAvailable: true,
  },
];

const AGENTS: AgentStatus[] = [
  {
    provider: 'codex',
    state: 'ready',
    version: 'test',
    accountLabel: 'ChatGPT test',
    mode: 'embedded',
    subscriptionAuthApproved: false,
    error: null,
  },
  {
    provider: 'claude',
    state: 'signed_out',
    version: 'test',
    accountLabel: null,
    mode: 'embedded',
    subscriptionAuthApproved: false,
    error: null,
  },
];

describe('CommandService runtime boundary and workflows', () => {
  const directories: string[] = [];
  const vaults: VaultService[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const vault of vaults.splice(0)) vault.vault.close();
    await Promise.all(directories.splice(0).map(removeTemporaryDirectory));
  });

  async function fixture(options?: { runAgent?: AgentRuntimeController['run'] }): Promise<{
    vault: VaultService;
    service: CommandService;
    events: AgentEvent[];
    connectorMock: Record<string, ReturnType<typeof vi.fn>>;
    agentMock: AgentRuntimeController;
    directory: string;
  }> {
    const directory = await temporaryDirectory('commands');
    directories.push(directory);
    const vault = await initializedVault(directory);
    vaults.push(vault);
    const connectorMock = {
      statuses: vi.fn(async () => CONNECTORS),
      configure: vi.fn(async (input: { provider: 'google' | 'microsoft' }) =>
        CONNECTORS.find((item) => item.provider === input.provider)!,
      ),
      connect: vi.fn(
        async (provider: 'google' | 'microsoft') =>
          ({
            ...CONNECTORS.find((item) => item.provider === provider)!,
            state: 'connected',
            accountEmail: 'founder@example.test',
          }) satisfies ConnectorStatus,
      ),
      disconnect: vi.fn(async (provider: 'google' | 'microsoft') =>
        CONNECTORS.find((item) => item.provider === provider)!,
      ),
      test: vi.fn(async (provider: 'google' | 'microsoft') =>
        CONNECTORS.find((item) => item.provider === provider)!,
      ),
      createMeeting: vi.fn((input) => vault.createMeeting(input)),
      syncCalendar: vi.fn(async () => vault.bootstrap()),
      syncMail: vi.fn(async () => vault.bootstrap()),
      sendApprovedDraft: vi.fn(),
    };
    const agentMock: AgentRuntimeController = {
      statuses: vi.fn(async () => AGENTS),
      detect: vi.fn(async (provider) => AGENTS.find((item) => item.provider === provider)!),
      login: vi.fn(async (provider) => AGENTS.find((item) => item.provider === provider)!),
      logout: vi.fn(async (provider) => AGENTS.find((item) => item.provider === provider)!),
      setCredential: vi.fn(async (provider) => AGENTS.find((item) => item.provider === provider)!),
      removeCredential: vi.fn(async (provider) =>
        AGENTS.find((item) => item.provider === provider)!,
      ),
      setSubscriptionAuthApproved: vi.fn(async (provider) =>
        AGENTS.find((item) => item.provider === provider)!,
      ),
      beginVaultRestore: vi.fn(() => vi.fn()),
      reloadAfterVaultRestore: vi.fn(async () => AGENTS),
      run:
        options?.runAgent ??
        vi.fn(async (request) => {
          await request.onEvent({
            runId: request.runId,
            type: 'completed',
            text: 'No changes proposed.',
          });
          return { runId: request.runId };
        }),
      cancel: vi.fn(async () => ({ cancelled: true })),
      dispose: vi.fn(async () => undefined),
    };
    const events: AgentEvent[] = [];
    const service = new CommandService({
      vault,
      connectors: connectorMock as unknown as ConnectorService,
      agents: agentMock,
      emitAgentEvent: (event) => events.push(event),
    });
    return { vault, service, events, connectorMock, agentMock, directory };
  }

  const onboarding = {
    founderName: 'Ada Founder',
    founderEmail: 'ada@local.test',
    companyName: 'Local Labs',
    companyOneLiner: 'Local-first infrastructure for trustworthy AI teams.',
    stage: 'seed' as const,
    targetAmount: 3_000_000,
    targetCheckMinimum: 250_000,
    targetCheckMaximum: 1_000_000,
    sectors: ['AI', 'Agentic'],
    geographies: ['United States'],
    narrative: 'Founder-reviewed fixture narrative.',
    postalAddress: '123 Founder Way\nSan Francisco, CA 94107\nUnited States',
  };

  it('validates every untrusted command before any mutation', async () => {
    const { vault, service } = await fixture();

    await expect(
      service.execute('onboarding.complete', { ...onboarding, founderEmail: 'not-an-email' }),
    ).rejects.toMatchObject({ name: 'ZodError' });
    expect(Number(vault.vault.scalar('SELECT COUNT(*) FROM founder_profiles'))).toBe(0);

    await expect(
      service.execute('onboarding.complete', { ...onboarding, targetAmount: -1 }),
    ).rejects.toMatchObject({ name: 'ZodError' });
    await expect(
      service.execute('investor.create', {
        name: '',
        kind: 'venture_capital',
        website: 'not a URL',
      }),
    ).rejects.toMatchObject({ name: 'ZodError' });
    await expect(
      service.execute('person.contact.add', {
        personId: 'person:test',
        kind: 'work_email',
        value: 'not-an-email',
        visibility: 'private',
        contributionEligible: false,
      }),
    ).rejects.toMatchObject({ name: 'ZodError' });
    await expect(
      service.execute('person.contact.add', {
        personId: 'person:test',
        kind: 'personal_email',
        value: 'person@example.test',
        visibility: 'public',
        contributionEligible: true,
      }),
    ).rejects.toMatchObject({ name: 'ZodError' });
    await expect(
      service.execute('person.contact.add', {
        personId: 'person:test',
        kind: 'linkedin',
        value: 'https://lookalike.example/in/founder',
        visibility: 'public',
        sourceUrl: 'https://lookalike.example/in/founder',
        contributionEligible: true,
      }),
    ).rejects.toMatchObject({ name: 'ZodError' });
    await expect(
      service.execute('meeting.create', {
        title: 'Meeting',
        startsAt: 'tomorrow',
        endsAt: 'later',
        provider: 'manual',
        investorId: null,
        personIds: [],
        location: null,
        agenda: null,
        notes: null,
        status: 'upcoming',
      }),
    ).rejects.toMatchObject({ name: 'ZodError' });
    await expect(
      service.execute('draft.approve', { id: 'draft-1', expectedContentHash: 'not-a-hash' }),
    ).rejects.toMatchObject({ name: 'ZodError' });
    await expect(
      service.execute('communications.policy.update', {
        sendingPaused: false,
        dailySendLimit: 0,
        hourlySendLimit: 3,
        recipientDomainDailyLimit: 2,
        recipientDomainCooldownMinutes: 30,
        postalAddress: null,
        optOutText:
          'If you prefer no further email from me, reply "opt out" and I will not contact you again.',
      }),
    ).rejects.toMatchObject({ name: 'ZodError' });
    await expect(
      service.execute('communications.policy.update', {
        sendingPaused: false,
        dailySendLimit: 10,
        hourlySendLimit: 0,
        recipientDomainDailyLimit: 2,
        recipientDomainCooldownMinutes: 30,
        postalAddress: '123 Founder Way',
        optOutText: 'Reply opt out.',
      }),
    ).rejects.toMatchObject({ name: 'ZodError' });
    await expect(
      service.execute('suppression.add', {
        scope: 'domain',
        value: '',
        reason: 'Founder block',
      }),
    ).rejects.toMatchObject({ name: 'ZodError' });
    await expect(service.execute('system.destroy' as never, {})).rejects.toThrow(
      'Unsupported command',
    );
  });

  it('validates and routes agent detection, authentication, credentials, and cancellation', async () => {
    const { service, agentMock } = await fixture();

    await expect(
      service.execute('agent.detect', { provider: 'unsupported' } as never),
    ).rejects.toMatchObject({ name: 'ZodError' });
    await expect(service.execute('agent.cancel', { runId: '' })).rejects.toMatchObject({
      name: 'ZodError',
    });
    await expect(
      service.execute('agent.credential.set', { provider: 'claude', credential: 'too-short' }),
    ).rejects.toMatchObject({ name: 'ZodError' });
    await expect(
      service.execute('agent.credential.set', {
        provider: 'codex',
        credential: 'sk-ant-invalid-provider-00000001',
      } as never),
    ).rejects.toMatchObject({ name: 'ZodError' });
    await expect(
      service.execute('agent.subscription.set', {
        provider: 'claude',
        approved: true,
        approvalConfirmed: false,
      } as never),
    ).rejects.toMatchObject({ name: 'ZodError' });
    await expect(
      service.execute('agent.subscription.set', {
        provider: 'claude',
        approved: true,
      } as never),
    ).rejects.toMatchObject({ name: 'ZodError' });

    await expect(service.execute('agent.detect', { provider: 'codex' })).resolves.toMatchObject({
      provider: 'codex',
      state: 'ready',
    });
    await expect(service.execute('agent.login', { provider: 'claude' })).resolves.toMatchObject({
      provider: 'claude',
    });
    await expect(service.execute('agent.logout', { provider: 'codex' })).resolves.toMatchObject({
      provider: 'codex',
    });
    await expect(
      service.execute('agent.credential.set', {
        provider: 'claude',
        credential: 'sk-ant-command-credential-00000001',
      }),
    ).resolves.toMatchObject({ provider: 'claude' });
    await expect(
      service.execute('agent.credential.remove', { provider: 'claude' }),
    ).resolves.toMatchObject({ provider: 'claude' });
    await expect(
      service.execute('agent.subscription.set', {
        provider: 'claude',
        approved: true,
        approvalConfirmed: true,
      }),
    ).resolves.toMatchObject({ provider: 'claude' });
    await expect(
      service.execute('agent.subscription.set', { provider: 'claude', approved: false }),
    ).resolves.toMatchObject({ provider: 'claude' });
    await expect(
      service.execute('agent.cancel', { runId: 'agent-run:command-cancel' }),
    ).resolves.toEqual({ cancelled: true });

    expect(agentMock.detect).toHaveBeenCalledOnce();
    expect(agentMock.detect).toHaveBeenCalledWith('codex');
    expect(agentMock.login).toHaveBeenCalledOnce();
    expect(agentMock.login).toHaveBeenCalledWith('claude');
    expect(agentMock.logout).toHaveBeenCalledOnce();
    expect(agentMock.logout).toHaveBeenCalledWith('codex');
    expect(agentMock.setCredential).toHaveBeenCalledWith(
      'claude',
      'sk-ant-command-credential-00000001',
    );
    expect(agentMock.removeCredential).toHaveBeenCalledWith('claude');
    expect(agentMock.setSubscriptionAuthApproved).toHaveBeenNthCalledWith(1, 'claude', true);
    expect(agentMock.setSubscriptionAuthApproved).toHaveBeenNthCalledWith(2, 'claude', false);
    expect(agentMock.cancel).toHaveBeenCalledOnce();
    expect(agentMock.cancel).toHaveBeenCalledWith('agent-run:command-cancel');
  });

  it('validates canonical meeting attendees before any calendar side effect', async () => {
    const { vault, service, connectorMock } = await fixture();
    await service.execute('onboarding.complete', onboarding);
    const person = firstPersonWithoutEmail(vault);
    const meetingInput = {
      title: 'Canonical attendee check',
      startsAt: '2026-08-03T17:00:00.000Z',
      endsAt: '2026-08-03T17:30:00.000Z',
      provider: 'google' as const,
      investorId: person.firmId,
      personIds: [person.id],
      location: null,
      agenda: null,
      notes: null,
      status: 'upcoming' as const,
    };

    await expect(service.execute('meeting.create', meetingInput)).rejects.toThrow(
      'needs a valid email address',
    );
    expect(connectorMock.createMeeting).not.toHaveBeenCalled();

    await service.execute('person.contact.add', {
      personId: person.id,
      kind: 'work_email',
      value: 'canonical.attendee@example.test',
      visibility: 'private',
      contributionEligible: false,
    });
    await expect(
      service.execute('meeting.create', {
        ...meetingInput,
        personIds: [person.id, person.id],
      }),
    ).rejects.toMatchObject({ name: 'ZodError' });
    await expect(
      service.execute('meeting.create', {
        ...meetingInput,
        endsAt: meetingInput.startsAt,
      }),
    ).rejects.toMatchObject({ name: 'ZodError' });
    await expect(
      service.execute('meeting.create', {
        ...meetingInput,
        startsAt: '2026-08-03T10:00:00-08:00',
        endsAt: '2026-08-03T17:30:00Z',
      }),
    ).rejects.toMatchObject({ name: 'ZodError' });
    await expect(service.execute('meeting.create', meetingInput)).resolves.toMatchObject({
      investorId: person.firmId,
      personIds: [person.id],
    });
    expect(connectorMock.createMeeting).toHaveBeenCalledTimes(1);
  });

  it('saves one canonical LinkedIn and X profile without opting it into contribution export', async () => {
    const { vault, service } = await fixture();
    await service.execute('onboarding.complete', onboarding);
    const person = firstPersonWithoutEmail(vault);

    const withLinkedin = await service.execute('person.contact.add', {
      personId: person.id,
      kind: 'linkedin',
      value: 'https://www.linkedin.com/in/canonical-partner',
      visibility: 'public',
      sourceUrl: 'https://www.linkedin.com/in/canonical-partner',
      contributionEligible: false,
    });
    expect(withLinkedin.linkedinUrl).toBe('https://www.linkedin.com/in/canonical-partner');
    const withX = await service.execute('person.contact.add', {
      personId: person.id,
      kind: 'x',
      value: 'https://x.com/canonicalpartner',
      visibility: 'public',
      sourceUrl: 'https://x.com/canonicalpartner',
      contributionEligible: false,
    });
    expect(withX).toMatchObject({
      linkedinUrl: 'https://www.linkedin.com/in/canonical-partner',
      xUrl: 'https://x.com/canonicalpartner',
    });
    expect(
      Number(
        vault.vault.scalar(
          "SELECT COUNT(*) FROM contact_methods WHERE person_id=? AND kind='linkedin' AND is_primary=1",
          [person.id],
        ),
      ),
    ).toBe(1);
    expect(
      Number(
        vault.vault.scalar(
          "SELECT COUNT(*) FROM contact_methods WHERE person_id=? AND kind IN ('linkedin','x') AND contribution_eligible=1",
          [person.id],
        ),
      ),
    ).toBe(0);
  });

  it('executes the founder workflow and returns persisted, typed results', async () => {
    const { service } = await fixture();
    const first = await service.bootstrap();
    expect(first.isFirstRun).toBe(true);
    expect(first.connectors).toEqual(CONNECTORS);
    expect(first.agents).toEqual(AGENTS);

    const onboarded = await service.execute('onboarding.complete', onboarding);
    expect(onboarded).toMatchObject({
      isFirstRun: false,
      round: { companyName: 'Local Labs', stage: 'seed', targetAmount: 3_000_000 },
    });
    const investor = await service.execute('investor.create', {
      name: 'Command Boundary Capital',
      kind: 'micro_vc',
      website: 'https://command-boundary.example',
      headquarters: 'San Francisco, CA',
    });
    expect(investor).toMatchObject({
      name: 'Command Boundary Capital',
      kind: 'micro_vc',
      target: false,
    });
    await service.execute('investor.target', { id: investor.id, target: true });
    const moved = await service.execute('pipeline.move', {
      investorId: investor.id,
      stage: 'partner_meeting',
    });
    expect(moved.investors.find((item) => item.id === investor.id)).toMatchObject({
      target: true,
      pipelineStage: 'partner_meeting',
    });
    await expect(
      service.execute('pipeline.nextAction', {
        investorId: investor.id,
        nextAction: '  Share the security brief  ',
        nextActionAt: '2026-08-04T17:00:00.000Z',
      }),
    ).resolves.toMatchObject({
      nextAction: 'Share the security brief',
      nextActionAt: '2026-08-04T17:00:00.000Z',
    });

    const task = await service.execute('task.create', {
      title: 'Review round strategy',
      notes: 'Founder task',
      dueAt: '2026-08-02T17:00:00.000Z',
      status: 'open',
      investorId: investor.id,
      personId: null,
    });
    await expect(
      service.execute('task.update', { id: task.id, status: 'done' }),
    ).resolves.toMatchObject({ status: 'done' });
    await expect(
      service.execute('meeting.create', {
        title: 'Investor review',
        startsAt: '2026-08-03T17:00:00.000Z',
        endsAt: '2026-08-03T17:30:00.000Z',
        provider: 'manual',
        investorId: investor.id,
        personIds: [],
        location: 'Video',
        agenda: 'Fit',
        notes: null,
        status: 'upcoming',
      }),
    ).resolves.toMatchObject({ title: 'Investor review', provider: 'manual' });
    await expect(
      service.execute('knowledge.save', {
        title: 'Approved one-liner',
        category: 'narrative',
        content: 'An exact, truthful company description.',
        sharePolicy: 'safe_for_outreach',
      }),
    ).resolves.toMatchObject({ title: 'Approved one-liner' });
    const list = await service.execute('list.create', {
      name: 'Command test list',
      description: 'Deterministic fixture',
      memberFirmIds: [investor.id],
    });
    expect(list).toMatchObject({
      name: 'Command test list',
      count: 1,
      memberFirmIds: [investor.id],
    });
    await expect(
      service.execute('list.update', {
        id: list.id,
        name: 'Command test list — updated',
        description: null,
        memberFirmIds: [],
      }),
    ).resolves.toMatchObject({
      name: 'Command test list — updated',
      count: 0,
      memberFirmIds: [],
    });

    const search = await service.execute('search', { query: 'Command Boundary' });
    expect(search).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: investor.id, kind: 'investor' })]),
    );
  });

  it('enforces exact-content draft approval through the command boundary', async () => {
    const { vault, service } = await fixture();
    await service.execute('onboarding.complete', onboarding);
    const person = firstPersonWithoutEmail(vault);
    const contact = await service.execute('person.contact.add', {
      personId: person.id,
      kind: 'work_email',
      value: 'command.private@example.test',
      visibility: 'private',
      contributionEligible: false,
    });
    expect(contact).toMatchObject({ email: 'command.private@example.test', canSendInitial: true });

    const draft = await service.execute('draft.create', {
      personId: person.id,
      provider: 'google',
      kind: 'initial',
      subject: 'Initial subject',
      bodyText: 'Initial exact body.',
    });
    const edited = await service.execute('draft.update', {
      id: draft.id,
      bodyText: `${draft.bodyText}\nFounder-edited exact body.`,
    });
    await expect(
      service.execute('draft.approve', {
        id: edited.id,
        expectedContentHash: draft.contentHash,
      }),
    ).rejects.toThrow('Draft changed before approval');
    await expect(
      service.execute('draft.approve', {
        id: edited.id,
        expectedContentHash: edited.contentHash,
      }),
    ).resolves.toMatchObject({ approvalState: 'approved' });
  });

  it('routes mailbox, policy, review, and suppression commands through validated boundaries', async () => {
    const { connectorMock, service, vault } = await fixture();
    await service.execute('onboarding.complete', onboarding);
    const person = firstPersonWithoutEmail(vault);
    await service.execute('person.contact.add', {
      personId: person.id,
      kind: 'work_email',
      value: 'command.mail@example.test',
      visibility: 'private',
      contributionEligible: false,
    });

    await expect(
      service.execute('connector.syncMail', { provider: 'google' }),
    ).resolves.toMatchObject({ mailEvents: [], auditIntegrity: { ok: true } });
    expect(connectorMock.syncMail).toHaveBeenCalledOnce();
    expect(connectorMock.syncMail).toHaveBeenCalledWith('google');
    await expect(
      service.execute('communications.policy.update', {
        sendingPaused: true,
        dailySendLimit: 4,
        hourlySendLimit: 2,
        recipientDomainDailyLimit: 2,
        recipientDomainCooldownMinutes: 30,
        postalAddress: '123 Founder Way\nSan Francisco, CA 94107\nUnited States',
        optOutText:
          'If you prefer no further email from me, reply "opt out" and I will not contact you again.',
      }),
    ).resolves.toMatchObject({
      sendingPaused: true,
      dailySendLimit: 4,
      hourlySendLimit: 2,
      reservedToday: 0,
      reservedThisHour: 0,
    });

    const suppression = await service.execute('suppression.add', {
      scope: 'email',
      value: 'COMMAND.MAIL@example.test',
      reason: 'Founder command-boundary block.',
    });
    expect(suppression).toMatchObject({ scope: 'email', active: true, source: 'founder' });
    expect((await service.bootstrap()).people.find((item) => item.id === person.id)).toMatchObject({
      canSendInitial: false,
      suppressionReason: 'Founder command-boundary block.',
    });
    await expect(
      service.execute('suppression.remove', { id: suppression.id }),
    ).resolves.toMatchObject({ id: suppression.id, active: false });

    vault.vault.run(
      `INSERT INTO mail_events(
        id,provider,provider_message_id,person_id,direction,kind,sender_address,
        recipient_addresses_json,subject,occurred_at,metadata_json,created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        'mail:command-review',
        'google',
        'provider-command-review',
        person.id,
        'inbound',
        'reply',
        'command.mail@example.test',
        '[]',
        'Founder review required',
        '2026-07-31T18:30:00.000Z',
        '{}',
        '2026-07-31T19:00:00.000Z',
      ],
    );
    await expect(
      service.execute('mail.review', { id: 'mail:command-review' }),
    ).resolves.toMatchObject({ id: 'mail:command-review', reviewedAt: '2026-07-31T19:00:00.000Z' });
  });

  it('requires the exact typed DELETE confirmation and resets only on the next launch', async () => {
    const { directory, service, vault } = await fixture();
    await service.execute('onboarding.complete', onboarding);
    await service.execute('task.create', {
      title: 'Private task removed by reset',
      notes: 'Founder-private state',
      dueAt: null,
      status: 'open',
      investorId: null,
      personId: null,
    });
    const marker = join(directory, 'reset-on-next-launch');

    await expect(
      service.execute('data.reset', { confirmation: 'delete' } as never),
    ).rejects.toMatchObject({ name: 'ZodError' });
    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await service.bootstrap()).isFirstRun).toBe(false);

    await expect(service.execute('data.reset', { confirmation: 'DELETE' })).resolves.toEqual({
      scheduled: true,
    });
    expect(
      Number(
        vault.vault.scalar("SELECT COUNT(*) FROM audit_log WHERE action='data.reset_scheduled'"),
      ),
    ).toBe(1);
    expect(await readFile(marker, 'utf8')).toBe(
      'Delete the exact Outreachr SQLite vault on the next application launch.\n',
    );
    if (process.platform !== 'win32') expect((await stat(marker)).mode & 0o777).toBe(0o600);
    expect((await service.bootstrap()).tasks.some((task) => task.title.includes('removed'))).toBe(
      true,
    );

    vault.vault.close();
    vaults.splice(vaults.indexOf(vault), 1);
    const reopened = await initializedVault(directory, () => new Date('2026-08-01T00:00:00.000Z'));
    vaults.push(reopened);
    const bootstrap = await reopened.bootstrap();
    expect(bootstrap.isFirstRun).toBe(true);
    expect(bootstrap.tasks).toEqual([]);
    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(reopened.integrityCheck().ok).toBe(true);
  });

  it('blocks active agent runs and rehydrates runtime authentication after backup restore', async () => {
    const { directory, service, agentMock, connectorMock } = await fixture();
    await service.execute('onboarding.complete', onboarding);
    const backup = await service.execute('backup.export', {
      directory,
      password: 'correct horse battery staple',
    });

    const restored = await service.execute('backup.restore', {
      path: backup.path,
      password: 'correct horse battery staple',
    });

    expect(agentMock.beginVaultRestore).toHaveBeenCalledOnce();
    expect(agentMock.reloadAfterVaultRestore).toHaveBeenCalledOnce();
    expect(connectorMock.statuses).toHaveBeenCalled();
    expect(vi.mocked(agentMock.beginVaultRestore).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(agentMock.reloadAfterVaultRestore).mock.invocationCallOrder[0]!,
    );
    expect(restored.agents).toEqual(AGENTS);
    expect(restored.connectors).toEqual(CONNECTORS);
  });

  it('holds a restore barrier across asynchronous replacement and authentication rehydration', async () => {
    const { vault, service, agentMock } = await fixture();
    let signalEntered!: () => void;
    let releaseRestore!: () => void;
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    const paused = new Promise<void>((resolve) => {
      releaseRestore = resolve;
    });
    vi.spyOn(vault, 'restoreBackup').mockImplementation(async () => {
      signalEntered();
      await paused;
      return vault.bootstrap();
    });

    const restoring = service.execute('backup.restore', {
      path: '/tmp/deferred-valid-backup.outreachr-backup',
      password: 'correct horse battery staple',
    });
    await entered;

    await expect(
      service.execute('agent.run', {
        provider: 'claude',
        prompt: 'Must be rejected during restore.',
        disclosedContextIds: [],
      }),
    ).rejects.toThrow('while a backup restore is in progress');
    await expect(service.bootstrap()).rejects.toThrow('while a backup restore is in progress');
    expect(agentMock.run).not.toHaveBeenCalled();

    releaseRestore();
    await expect(restoring).resolves.toMatchObject({ agents: AGENTS, connectors: CONNECTORS });
    expect(agentMock.reloadAfterVaultRestore).toHaveBeenCalledOnce();

    await expect(service.execute('search', { query: '' })).resolves.toEqual(expect.any(Array));
  });

  it('records explicit agent context grants, runs, proposals, and completion events', async () => {
    const runAgent = vi.fn<AgentRuntimeController['run']>(async (request) => {
      if (request.prompt === 'Prepare the next founder action.') {
        await request.onEvent({
          runId: request.runId,
          type: 'tool_proposal',
          text: 'Create a founder-reviewable task',
          proposalId: 'proposal:test',
          proposal: {
            kind: 'task',
            title: 'Review the next founder action',
            rationale: 'The founder should verify the evidence before proceeding.',
            investorId: null,
            payload: {
              title: 'Review the next founder action',
              notes: 'Verify the underlying source evidence.',
              dueAt: null,
            },
          },
        });
      }
      await request.onEvent({
        runId: request.runId,
        type: 'completed',
        text: 'One proposal created.',
      });
      return { runId: request.runId };
    });
    const { vault, service, events } = await fixture({ runAgent });
    await service.execute('onboarding.complete', onboarding);
    await expect(
      service.execute('agent.contextGrant.set', {
        provider: 'codex',
        contextClass: 'round',
        granted: true,
      }),
    ).resolves.toEqual([expect.objectContaining({ provider: 'codex', contextClass: 'round' })]);

    const run = await service.execute('agent.run', {
      provider: 'codex',
      prompt: 'Prepare the next founder action.',
      disclosedContextIds: ['round'],
    });
    expect(run.runId).toMatch(/^agent-run:/u);
    expect(runAgent).toHaveBeenCalledOnce();
    expect(events).toEqual([
      expect.objectContaining({ type: 'tool_proposal', proposalId: 'proposal:test' }),
      expect.objectContaining({ type: 'completed' }),
    ]);
    expect(
      vault.vault.one<{ status: string; context_policy_json: string }>(
        'SELECT status,context_policy_json FROM agent_runs WHERE id=?',
        [run.runId],
      ),
    ).toMatchObject({ status: 'completed' });
    expect(
      vault.vault.one<{ status: string; proposal_type: string; payload_json: string }>(
        'SELECT status,proposal_type,payload_json FROM agent_proposals WHERE id=?',
        ['proposal:test'],
      ),
    ).toMatchObject({
      status: 'pending',
      proposal_type: 'task',
      payload_json: expect.stringContaining('Review the next founder action'),
    });
    expect((await service.bootstrap()).agentProposals).toEqual([
      expect.objectContaining({
        id: 'proposal:test',
        kind: 'task',
        provider: 'codex',
        payload: expect.objectContaining({ title: 'Review the next founder action' }),
      }),
    ]);

    await expect(
      service.execute('agent.proposal.review', {
        id: 'proposal:test',
        decision: 'apply',
      }),
    ).resolves.toMatchObject({
      id: 'proposal:test',
      status: 'accepted',
      operation: 'applied',
      appliedEntityType: 'task',
    });
    expect((await service.bootstrap()).agentProposals).toEqual([]);
    expect((await service.bootstrap()).tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: 'Review the next founder action', status: 'open' }),
      ]),
    );
    expect(
      Number(
        vault.vault.scalar(
          "SELECT COUNT(*) FROM audit_log WHERE action='agent.proposal_applied' AND entity_id='proposal:test'",
        ),
      ),
    ).toBe(1);

    await expect(
      service.execute('agent.contextGrant.set', {
        provider: 'codex',
        contextClass: 'round',
        granted: false,
      }),
    ).resolves.toEqual([]);
    await expect(
      service.execute('agent.run', {
        provider: 'codex',
        prompt: 'Use this explicitly selected one-time context.',
        disclosedContextIds: ['round'],
      }),
    ).resolves.toEqual({ runId: expect.stringMatching(/^agent-run:/u) });
    expect(runAgent).toHaveBeenCalledTimes(2);
    expect(runAgent.mock.calls[1]?.[0]).toMatchObject({
      provider: 'codex',
      disclosedContextIds: ['round'],
    });
    expect(Number(vault.vault.scalar('SELECT COUNT(*) FROM agent_runs'))).toBe(2);
  });
});
