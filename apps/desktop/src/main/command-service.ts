import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AgentEvent, CommandMap, CommandResultMap } from '../shared/contracts';
import type { AgentRuntimeController } from './agent-controller';
import type { ConnectorService } from './connector-service';
import type { VaultService } from './vault-service';

const id = z.string().trim().min(1).max(300);
const nullableIso = z.string().datetime({ offset: true }).nullable();
const provider = z.enum(['google', 'microsoft']);
const agentProvider = z.enum(['codex', 'claude']);
const publicSourceUrl = z.string().trim().url().max(4_096).optional();

function professionalProfileUrl(hostnames: readonly string[], label: string): z.ZodType<string> {
  return z
    .string()
    .trim()
    .url()
    .max(4_096)
    .refine((value) => {
      const url = new URL(value);
      return (
        url.protocol === 'https:' &&
        hostnames.some(
          (hostname) => url.hostname === hostname || url.hostname.endsWith(`.${hostname}`),
        )
      );
    }, `Use a secure ${label} profile URL`);
}

const commandSchemas: Record<keyof CommandMap, z.ZodType> = {
  'onboarding.complete': z.object({
    founderName: z.string().trim().min(1).max(300),
    founderEmail: z.string().email(),
    companyName: z.string().trim().min(1).max(300),
    companyOneLiner: z.string().trim().min(1).max(2_000),
    stage: z.enum(['pre_seed', 'seed', 'series_a']),
    targetAmount: z.number().int().positive(),
    targetCheckMinimum: z.number().int().nonnegative().nullable(),
    targetCheckMaximum: z.number().int().nonnegative().nullable(),
    sectors: z.array(z.string().trim().min(1).max(100)).max(30),
    geographies: z.array(z.string().trim().min(1).max(100)).max(30),
    narrative: z.string().max(50_000),
    postalAddress: z.string().trim().max(1_000).optional(),
  }),
  'investor.get': z.object({ id }),
  'investor.create': z.object({
    name: z.string().trim().min(1).max(500),
    kind: z.enum([
      'venture_capital',
      'micro_vc',
      'angel',
      'angel_network',
      'scout',
      'accelerator',
      'venture_studio',
      'corporate_vc',
      'family_office',
      'syndicate',
      'crypto_fund',
      'solo_gp',
    ]),
    website: z.string().url().optional(),
    headquarters: z.string().trim().max(1_000).optional(),
    description: z.string().max(100_000).optional(),
  }),
  'investor.target': z.object({ id, target: z.boolean() }),
  'person.contact.add': z.discriminatedUnion('kind', [
    z.object({
      personId: id,
      kind: z.literal('work_email'),
      value: z.string().trim().email().max(320),
      visibility: z.enum(['private', 'public']),
      sourceUrl: publicSourceUrl,
      contributionEligible: z.boolean(),
    }),
    z
      .object({
        personId: id,
        kind: z.literal('personal_email'),
        value: z.string().trim().email().max(320),
        visibility: z.literal('private'),
        contributionEligible: z.literal(false),
      })
      .strict(),
    z.object({
      personId: id,
      kind: z.literal('linkedin'),
      value: professionalProfileUrl(['linkedin.com'], 'LinkedIn'),
      visibility: z.enum(['private', 'public']),
      sourceUrl: publicSourceUrl,
      contributionEligible: z.boolean(),
    }),
    z.object({
      personId: id,
      kind: z.literal('x'),
      value: professionalProfileUrl(['x.com', 'twitter.com'], 'X'),
      visibility: z.enum(['private', 'public']),
      sourceUrl: publicSourceUrl,
      contributionEligible: z.boolean(),
    }),
  ]),
  'pipeline.move': z.object({
    investorId: id,
    stage: z.enum([
      'researching',
      'ready',
      'intro_requested',
      'contacted',
      'meeting',
      'diligence',
      'partner_meeting',
      'soft_circle',
      'committed',
      'passed',
      'not_now',
    ]),
  }),
  'pipeline.amount': z.object({
    investorId: id,
    expectedCheckUsd: z.number().int().nonnegative().nullable(),
  }),
  'pipeline.nextAction': z.object({
    investorId: id,
    nextAction: z.string().trim().max(500).nullable(),
    nextActionAt: z.string().datetime().nullable(),
  }),
  'round.update': z.object({
    stage: z.enum(['pre_seed', 'seed', 'series_a']),
    targetAmount: z.number().int().positive(),
    targetCheckMinimum: z.number().int().nonnegative().nullable(),
    targetCheckMaximum: z.number().int().nonnegative().nullable(),
    sectors: z.array(z.string().trim().min(1).max(100)).max(30),
    geographies: z.array(z.string().trim().min(1).max(100)).max(30),
    narrative: z.string().max(50_000),
    status: z.enum(['planning', 'active', 'paused', 'closed']),
  }),
  'task.create': z.object({
    title: z.string().trim().min(1).max(2_000),
    notes: z.string().max(50_000).nullable(),
    dueAt: nullableIso,
    status: z.enum(['open', 'done', 'dismissed']),
    investorId: id.nullable(),
    personId: id.nullable(),
  }),
  'task.update': z.object({
    id,
    status: z.enum(['open', 'done', 'dismissed']).optional(),
    title: z.string().trim().min(1).max(2_000).optional(),
    dueAt: nullableIso.optional(),
  }),
  'meeting.create': z
    .object({
      title: z.string().trim().min(1).max(2_000),
      startsAt: z.string().datetime({ offset: true }),
      endsAt: z.string().datetime({ offset: true }),
      provider: z.enum(['google', 'microsoft', 'manual']),
      investorId: id.nullable(),
      personIds: z.array(id).max(100),
      location: z.string().max(2_000).nullable(),
      agenda: z.string().max(50_000).nullable(),
      notes: z.string().max(100_000).nullable(),
      status: z.enum(['upcoming', 'completed', 'cancelled']),
    })
    .superRefine((meeting, context) => {
      if (Date.parse(meeting.endsAt) <= Date.parse(meeting.startsAt)) {
        context.addIssue({
          code: 'custom',
          path: ['endsAt'],
          message: 'Meeting must end after it starts',
        });
      }
      if (new Set(meeting.personIds).size !== meeting.personIds.length) {
        context.addIssue({
          code: 'custom',
          path: ['personIds'],
          message: 'Each attendee may be selected only once',
        });
      }
    }),
  'meeting.update': z.object({
    id,
    agenda: z.string().max(50_000).nullable(),
    notes: z.string().max(100_000).nullable(),
  }),
  'knowledge.save': z.object({
    id: id.optional(),
    title: z.string().trim().min(1).max(2_000),
    category: z.enum(['company', 'round', 'narrative', 'metrics', 'disclosure', 'other']),
    content: z.string().min(1).max(5_000_000),
    sharePolicy: z.enum(['internal', 'safe_for_outreach', 'meeting_only', 'diligence_only']),
  }),
  'list.create': z.object({
    name: z.string().trim().min(1).max(1_000),
    description: z.string().max(20_000).nullable(),
    memberFirmIds: z.array(id).max(1_000).optional(),
  }),
  'list.update': z.object({
    id,
    name: z.string().trim().min(1).max(1_000),
    description: z.string().max(20_000).nullable(),
    memberFirmIds: z.array(id).max(1_000),
  }),
  'draft.create': z.object({
    personId: id,
    provider,
    kind: z.enum(['initial', 'follow_up', 'intro_request', 'reply']),
    subject: z.string().trim().min(1).max(998),
    bodyText: z.string().min(1).max(500_000),
    threadId: z.string().trim().min(1).max(2_000).nullable().optional(),
  }),
  'draft.update': z.object({
    id,
    subject: z.string().trim().min(1).max(998).optional(),
    bodyText: z.string().min(1).max(500_000).optional(),
  }),
  'draft.approve': z.object({ id, expectedContentHash: z.string().regex(/^[a-f0-9]{64}$/u) }),
  'draft.send': z.object({ id, expectedContentHash: z.string().regex(/^[a-f0-9]{64}$/u) }),
  'source.review': z.object({ id, decision: z.enum(['accept', 'reject']) }),
  'connector.configure': z.object({
    provider,
    clientId: z.string().trim().min(1).max(1_000),
    tenantId: z.string().trim().max(500).optional(),
    relationshipSync: z.boolean(),
  }),
  'connector.connect': z.object({ provider }),
  'connector.disconnect': z.object({ provider }),
  'connector.test': z.object({ provider }),
  'connector.syncCalendar': z.object({ provider }),
  'connector.syncMail': z.object({ provider }),
  'mail.review': z.object({ id }),
  'communications.policy.update': z.object({
    sendingPaused: z.boolean(),
    dailySendLimit: z.number().int().min(1).max(50),
    hourlySendLimit: z.number().int().min(1).max(20),
    recipientDomainDailyLimit: z.number().int().min(1).max(20),
    recipientDomainCooldownMinutes: z.number().int().min(1).max(1_440),
    postalAddress: z.string().trim().min(1).max(1_000).nullable(),
    optOutText: z.string().trim().min(1).max(1_000),
  }),
  'suppression.add': z.object({
    scope: z.enum(['global', 'email', 'domain', 'person', 'firm']),
    value: z.string().trim().min(1).max(1_000),
    reason: z.string().trim().min(1).max(10_000),
  }),
  'suppression.remove': z.object({ id }),
  'agent.detect': z.object({ provider: agentProvider }),
  'agent.login': z.object({ provider: agentProvider }),
  'agent.logout': z.object({ provider: agentProvider }),
  'agent.credential.set': z
    .object({
      provider: z.literal('claude'),
      credential: z
        .string()
        .trim()
        .min(20)
        .max(1_000)
        .refine((value) => !/\s/u.test(value)),
    })
    .strict(),
  'agent.credential.remove': z.object({ provider: z.literal('claude') }).strict(),
  'agent.subscription.set': z.discriminatedUnion('approved', [
    z
      .object({
        provider: z.literal('claude'),
        approved: z.literal(true),
        approvalConfirmed: z.literal(true),
      })
      .strict(),
    z.object({ provider: z.literal('claude'), approved: z.literal(false) }).strict(),
  ]),
  'agent.contextGrant.set': z.object({
    provider: agentProvider,
    contextClass: z.enum(['round', 'company', 'investors', 'activity']),
    granted: z.boolean(),
  }),
  'agent.run': z.object({
    provider: agentProvider,
    prompt: z.string().trim().min(1).max(100_000),
    disclosedContextIds: z.array(z.enum(['round', 'company', 'investors', 'activity'])).max(4),
  }),
  'agent.cancel': z.object({ runId: id }),
  'agent.proposal.review': z.object({
    id,
    decision: z.enum(['apply', 'reject', 'convert_to_task']),
  }),
  'backup.export': z.object({
    directory: z.string().min(1).max(4_096),
    password: z.string().min(12).max(10_000),
  }),
  'backup.restore': z.object({
    path: z.string().min(1).max(4_096),
    password: z.string().min(12).max(10_000),
  }),
  'contribution.export': z.object({ directory: z.string().min(1).max(4_096) }),
  'data.importSeed': z.object({ path: z.string().min(1).max(4_096) }),
  'data.exportCsv': z.object({
    directory: z.string().min(1).max(4_096),
    kind: z.enum(['investors', 'people', 'pipeline', 'activity']),
  }),
  'data.reset': z.object({ confirmation: z.literal('DELETE') }),
  search: z.object({ query: z.string().max(1_000) }),
};

export class CommandService {
  readonly #vault: VaultService;
  readonly #connectors: ConnectorService;
  readonly #agents: AgentRuntimeController;
  readonly #emitAgentEvent: (event: AgentEvent) => void;
  #commandsInFlight = 0;
  #vaultRestoreInProgress = false;

  constructor(options: {
    vault: VaultService;
    connectors: ConnectorService;
    agents: AgentRuntimeController;
    emitAgentEvent: (event: AgentEvent) => void;
  }) {
    this.#vault = options.vault;
    this.#connectors = options.connectors;
    this.#agents = options.agents;
    this.#emitAgentEvent = options.emitAgentEvent;
  }

  async bootstrap(): Promise<CommandResultMap['onboarding.complete']> {
    if (this.#vaultRestoreInProgress) {
      throw new Error('Workspace refresh is unavailable while a backup restore is in progress');
    }
    this.#commandsInFlight += 1;
    try {
      const diagnostic = (stage: string): void => {
        if (process.env.OUTREACHR_STARTUP_DIAGNOSTICS === '1') {
          process.stderr.write(`[outreachr-startup] bootstrap ${stage}\n`);
        }
      };
      diagnostic('connector statuses started');
      const connectorStatuses = await this.#connectors.statuses();
      diagnostic('connector statuses finished');
      const agentStatuses = await this.#agents.statuses();
      diagnostic('agent statuses finished');
      this.#vault.setRuntimeStatuses(connectorStatuses, agentStatuses);
      diagnostic('vault snapshot started');
      const result = await this.#vault.bootstrap();
      diagnostic('vault snapshot finished');
      return result;
    } finally {
      this.#commandsInFlight -= 1;
    }
  }

  async execute<K extends keyof CommandMap>(
    name: K,
    untrustedPayload: unknown,
  ): Promise<CommandResultMap[K]> {
    const schema = commandSchemas[name];
    if (!schema) throw new Error(`Unsupported command: ${String(name)}`);
    const payload = schema.parse(untrustedPayload) as CommandMap[K];
    if (this.#vaultRestoreInProgress) {
      throw new Error('Another command cannot start while a backup restore is in progress');
    }
    const restoring = name === 'backup.restore';
    if (restoring) {
      if (this.#commandsInFlight > 0) {
        throw new Error('A backup cannot be restored while another command is in progress');
      }
      this.#vaultRestoreInProgress = true;
    } else {
      this.#commandsInFlight += 1;
    }
    try {
      let result: unknown;
      switch (name) {
        case 'onboarding.complete':
          result = await this.#vault.completeOnboarding(
            payload as CommandMap['onboarding.complete'],
          );
          break;
        case 'investor.get':
          result = await this.#vault.investorDetail((payload as CommandMap['investor.get']).id);
          break;
        case 'investor.create':
          result = await this.#vault.createInvestor(payload as CommandMap['investor.create']);
          break;
        case 'investor.target': {
          const value = payload as CommandMap['investor.target'];
          result = await this.#vault.targetInvestor(value.id, value.target);
          break;
        }
        case 'person.contact.add':
          result = await this.#vault.addPersonContact(payload as CommandMap['person.contact.add']);
          break;
        case 'pipeline.move': {
          const value = payload as CommandMap['pipeline.move'];
          result = await this.#vault.moveInvestor(value.investorId, value.stage);
          break;
        }
        case 'pipeline.amount': {
          const value = payload as CommandMap['pipeline.amount'];
          result = await this.#vault.updateExpectedCheck(value.investorId, value.expectedCheckUsd);
          break;
        }
        case 'pipeline.nextAction': {
          const value = payload as CommandMap['pipeline.nextAction'];
          result = await this.#vault.updateNextAction(
            value.investorId,
            value.nextAction,
            value.nextActionAt,
          );
          break;
        }
        case 'round.update':
          result = await this.#vault.updateRound(payload as CommandMap['round.update']);
          break;
        case 'task.create':
          result = await this.#vault.createTask(payload as CommandMap['task.create']);
          break;
        case 'task.update':
          result = await this.#vault.updateTask(payload as CommandMap['task.update']);
          break;
        case 'meeting.create': {
          const value = payload as CommandMap['meeting.create'];
          // Resolve every selected canonical person before any provider side effect.
          // This rejects missing or malformed attendee email records instead of
          // silently creating a partially addressed calendar event.
          this.#vault.calendarAttendees(value.personIds);
          result = await this.#connectors.createMeeting(value);
          break;
        }
        case 'meeting.update':
          result = await this.#vault.updateMeeting(payload as CommandMap['meeting.update']);
          break;
        case 'knowledge.save':
          result = await this.#vault.saveKnowledge(payload as CommandMap['knowledge.save']);
          break;
        case 'list.create':
          result = await this.#vault.createList(payload as CommandMap['list.create']);
          break;
        case 'list.update':
          result = await this.#vault.updateList(payload as CommandMap['list.update']);
          break;
        case 'draft.create':
          result = await this.#vault.createDraft(payload as CommandMap['draft.create']);
          break;
        case 'draft.update': {
          const { id: messageId, ...values } = payload as CommandMap['draft.update'];
          result = await this.#vault.updateDraft(messageId, values);
          break;
        }
        case 'draft.approve': {
          const value = payload as CommandMap['draft.approve'];
          result = await this.#vault.approveDraft(value.id, value.expectedContentHash);
          break;
        }
        case 'draft.send': {
          const value = payload as CommandMap['draft.send'];
          result = await this.#connectors.sendApprovedDraft(value.id, value.expectedContentHash);
          break;
        }
        case 'source.review': {
          const value = payload as CommandMap['source.review'];
          result = await this.#vault.reviewSource(value.id, value.decision);
          break;
        }
        case 'connector.configure':
          result = await this.#connectors.configure(payload as CommandMap['connector.configure']);
          break;
        case 'connector.connect':
          result = await this.#connectors.connect(
            (payload as CommandMap['connector.connect']).provider,
          );
          break;
        case 'connector.disconnect':
          result = await this.#connectors.disconnect(
            (payload as CommandMap['connector.disconnect']).provider,
          );
          break;
        case 'connector.test':
          result = await this.#connectors.test((payload as CommandMap['connector.test']).provider);
          break;
        case 'connector.syncCalendar':
          result = await this.#connectors.syncCalendar(
            (payload as CommandMap['connector.syncCalendar']).provider,
          );
          break;
        case 'connector.syncMail':
          result = await this.#connectors.syncMail(
            (payload as CommandMap['connector.syncMail']).provider,
          );
          break;
        case 'mail.review':
          result = await this.#vault.reviewMailEvent((payload as CommandMap['mail.review']).id);
          break;
        case 'communications.policy.update':
          result = await this.#vault.updateCommunicationPolicy(
            payload as CommandMap['communications.policy.update'],
          );
          break;
        case 'suppression.add':
          result = await this.#vault.addSuppression(payload as CommandMap['suppression.add']);
          break;
        case 'suppression.remove':
          result = await this.#vault.removeSuppression(
            (payload as CommandMap['suppression.remove']).id,
          );
          break;
        case 'agent.detect':
          result = await this.#agents.detect((payload as CommandMap['agent.detect']).provider);
          break;
        case 'agent.login':
          result = await this.#agents.login((payload as CommandMap['agent.login']).provider);
          break;
        case 'agent.logout':
          result = await this.#agents.logout((payload as CommandMap['agent.logout']).provider);
          break;
        case 'agent.credential.set': {
          const value = payload as CommandMap['agent.credential.set'];
          result = await this.#agents.setCredential(value.provider, value.credential);
          break;
        }
        case 'agent.credential.remove':
          result = await this.#agents.removeCredential(
            (payload as CommandMap['agent.credential.remove']).provider,
          );
          break;
        case 'agent.subscription.set': {
          const value = payload as CommandMap['agent.subscription.set'];
          result = await this.#agents.setSubscriptionAuthApproved(value.provider, value.approved);
          break;
        }
        case 'agent.contextGrant.set':
          result = await this.#vault.setAgentContextGrant(
            payload as CommandMap['agent.contextGrant.set'],
          );
          break;
        case 'agent.run': {
          const value = payload as CommandMap['agent.run'];
          const runId = `agent-run:${randomUUID()}`;
          const createdAt = new Date().toISOString();
          this.#vault.repository.createAgentRun({
            id: runId,
            provider: value.provider,
            model: null,
            purpose: value.prompt,
            contextPolicy: { disclosedContextIds: value.disclosedContextIds },
            status: 'running',
            startedAt: createdAt,
            completedAt: null,
            errorDetail: null,
            createdAt,
          });
          await this.#vault.persist();
          result = await this.#agents.run({
            runId,
            provider: value.provider,
            prompt: value.prompt,
            context: await this.#vault.agentContext(value.disclosedContextIds),
            disclosedContextIds: value.disclosedContextIds,
            onEvent: async (event) => {
              if (event.type === 'tool_proposal' && event.proposalId && event.proposal) {
                this.#vault.repository.createAgentProposal({
                  id: event.proposalId,
                  agentRunId: runId,
                  proposalType: event.proposal.kind,
                  payload: event.proposal,
                  status: 'pending',
                  reviewedAt: null,
                  createdAt: new Date().toISOString(),
                });
              }
              if (event.type === 'completed' || event.type === 'error') {
                this.#vault.vault.run(
                  'UPDATE agent_runs SET status=?,completed_at=?,error_detail=? WHERE id=?',
                  [
                    event.type === 'completed' ? 'completed' : 'failed',
                    new Date().toISOString(),
                    event.type === 'error' ? event.text : null,
                    runId,
                  ],
                );
              }
              await this.#vault.persist();
              this.#emitAgentEvent(event);
            },
          });
          break;
        }
        case 'agent.cancel':
          result = await this.#agents.cancel((payload as CommandMap['agent.cancel']).runId);
          break;
        case 'agent.proposal.review':
          result = await this.#vault.reviewAgentProposal(
            payload as CommandMap['agent.proposal.review'],
          );
          break;
        case 'backup.export': {
          const value = payload as CommandMap['backup.export'];
          result = { path: await this.#vault.exportBackup(value.directory, value.password) };
          break;
        }
        case 'backup.restore': {
          const value = payload as CommandMap['backup.restore'];
          const releaseAgentRestore = this.#agents.beginVaultRestore();
          try {
            await this.#vault.restoreBackup(value.path, value.password);
            // Rehydrate agent authorization first so any later status failure
            // cannot leave pre-restore credentials active against the new vault.
            const agentStatuses = await this.#agents.reloadAfterVaultRestore();
            const connectorStatuses = await this.#connectors.statuses();
            this.#vault.setRuntimeStatuses(connectorStatuses, agentStatuses);
            result = await this.#vault.bootstrap();
          } finally {
            releaseAgentRestore();
          }
          break;
        }
        case 'contribution.export':
          result = await this.#vault.exportContribution(
            (payload as CommandMap['contribution.export']).directory,
          );
          break;
        case 'data.importSeed':
          result = await this.#vault.importSeedFile(
            (payload as CommandMap['data.importSeed']).path,
          );
          break;
        case 'data.exportCsv': {
          const value = payload as CommandMap['data.exportCsv'];
          result = { path: await this.#vault.exportCsv(value.directory, value.kind) };
          break;
        }
        case 'data.reset':
          result = await this.#vault.scheduleReset();
          break;
        case 'search':
          result = this.#vault.search((payload as CommandMap['search']).query);
          break;
        default:
          throw new Error(`Unsupported command: ${String(name)}`);
      }
      return result as CommandResultMap[K];
    } finally {
      if (restoring) this.#vaultRestoreInProgress = false;
      else this.#commandsInFlight -= 1;
    }
  }
}
