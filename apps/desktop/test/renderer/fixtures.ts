import type { AppBootstrap, OutreachrBridge } from '../../src/shared/contracts';
import { vi } from 'vitest';

export function bootstrapFixture(firstRun = false): AppBootstrap {
  return {
    appVersion: '0.1.0-test',
    platform: 'darwin',
    vaultPath: '/tmp/outreachr-test/outreachr.sqlite',
    isFirstRun: firstRun,
    seedVersion: '0.1.0',
    seedSignatureStatus: 'pinned unsigned research',
    round: firstRun
      ? null
      : {
          id: 'round:test',
          companyName: 'Local Labs',
          companyOneLiner: 'Local-first infrastructure for trustworthy AI teams.',
          stage: 'seed',
          targetAmount: 3_000_000,
          committedAmount: 0,
          softCircleAmount: 0,
          targetCheck: {
            currency: 'USD',
            minimum: 250_000,
            maximum: 1_000_000,
            typical: null,
          },
          sectors: ['AI', 'Agentic'],
          geographies: ['United States'],
          leadRequired: false,
          launchDate: '2026-07-31',
          targetCloseDate: null,
          narrative: 'Truthful founder narrative.',
          status: 'active',
        },
    investors: [
      {
        id: 'firm:test',
        name: 'Calm Capital',
        kind: 'venture_capital',
        additionalKinds: [],
        headquarters: 'San Francisco, CA',
        geographies: ['United States'],
        stages: ['Seed'],
        sectors: ['AI'],
        check: {
          currency: 'USD',
          minimum: 250_000,
          maximum: 1_000_000,
          typical: 625_000,
        },
        fitScore: 90,
        fitReasons: ['Invests at seed.'],
        confidence: 'verified',
        sourceCount: 3,
        peopleCount: 1,
        portfolioCount: 1,
        target: false,
        pipelineStage: null,
        nextAction: null,
        nextActionAt: null,
        conflict: 'none',
        updatedAt: '2026-07-31T19:00:00.000Z',
      },
    ],
    people: [
      {
        id: 'person:test',
        name: 'Pat Partner',
        firmId: 'firm:test',
        firmName: 'Calm Capital',
        title: 'Partner',
        investorKinds: ['venture_capital'],
        sectors: ['AI'],
        workEmail: null,
        personalEmail: null,
        email: null,
        emailConfidence: 'unknown',
        linkedinUrl: 'https://linkedin.com/in/pat-partner',
        xUrl: null,
        target: false,
        contacted: false,
        replied: false,
        canSendInitial: false,
        suppressionReason: null,
        lastInteractionAt: null,
        nextAction: null,
      },
    ],
    pipeline: [
      { stage: 'researching', label: 'Researching', targetIds: [] },
      { stage: 'ready', label: 'Ready', targetIds: [] },
      { stage: 'intro_requested', label: 'Intro Requested', targetIds: [] },
      { stage: 'contacted', label: 'Contacted', targetIds: [] },
      { stage: 'meeting', label: 'Meeting', targetIds: [] },
      { stage: 'diligence', label: 'Diligence', targetIds: [] },
      { stage: 'partner_meeting', label: 'Partner Meeting', targetIds: [] },
      { stage: 'soft_circle', label: 'Soft Circle', targetIds: [] },
      { stage: 'committed', label: 'Committed', targetIds: [] },
      { stage: 'passed', label: 'Passed', targetIds: [] },
      { stage: 'not_now', label: 'Not Now', targetIds: [] },
    ],
    workItems: [],
    tasks: [],
    meetings: [],
    mailEvents: [],
    drafts: [],
    knowledge: [],
    lists: [],
    sourceReview: [],
    connectors: [
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
    ],
    agents: [
      {
        provider: 'codex',
        state: 'signed_out',
        version: null,
        accountLabel: null,
        mode: 'embedded',
        subscriptionAuthApproved: false,
        error: null,
      },
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
    agentContextGrants: [],
    agentProposals: [],
    suppressions: [],
    communicationPolicy: {
      sendingPaused: false,
      dailySendLimit: 10,
      reservedToday: 0,
      hourlySendLimit: 3,
      reservedThisHour: 0,
      recipientDomainDailyLimit: 2,
      recipientDomainCooldownMinutes: 30,
      postalAddress: '123 Founder Way\nSan Francisco, CA 94107\nUnited States',
      optOutText:
        'If you prefer no further email from me, reply "opt out" and I will not contact you again.',
    },
    auditIntegrity: { ok: true, entries: 0, errorAt: null },
    counts: {
      firms: 192,
      people: 192,
      targeted: 0,
      contacted: 0,
      meetings: 0,
      commitments: 0,
    },
  };
}

export function installBridge(
  initial: AppBootstrap,
  commandImplementation?: OutreachrBridge['command'],
): OutreachrBridge {
  const command =
    commandImplementation ??
    (vi.fn(async (name: string) => {
      if (name === 'onboarding.complete') return { ...initial, isFirstRun: false };
      if (name === 'search') {
        return [
          {
            id: 'firm:test',
            kind: 'investor',
            title: 'Calm Capital',
            subtitle: '90 fit · AI',
            href: '/investors/firm:test',
          },
        ];
      }
      throw new Error(`Unexpected renderer test command: ${name}`);
    }) as unknown as OutreachrBridge['command']);
  const bridge: OutreachrBridge = {
    bootstrap: vi.fn(async () => initial),
    command,
    selectFile: vi.fn(async () => null),
    selectDirectory: vi.fn(async () => null),
    openExternal: vi.fn(async () => undefined),
    revealPath: vi.fn(async () => undefined),
    copyText: vi.fn(async () => undefined),
    onAgentEvent: vi.fn(() => () => undefined),
  };
  Object.defineProperty(window, 'outreachr', {
    configurable: true,
    writable: true,
    value: bridge,
  });
  return bridge;
}
