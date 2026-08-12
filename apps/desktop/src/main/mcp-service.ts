import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  OUTREACHR_AGENT_MCP_PROPOSAL_TOOLS,
  OUTREACHR_AGENT_MCP_READ_TOOLS,
  type AgentMcpConnection,
  type AgentProposal,
  type OutreachrAgentMcpToolName,
} from '@outreachr/agents';
import { appendAuditEntry, type CoreVault } from '@outreachr/core';
import {
  createOutreachrMcpServer,
  privateFieldSchema,
  recordIdSchema,
  type AccessGrant,
  type AccessRequest,
  type ActivityListQuery,
  type ActivityPage,
  type ActivityRecord,
  type AuditEvent,
  type InvestorGetQuery,
  type InvestorListQuery,
  type InvestorPage,
  type InvestorRecord,
  type InvestorSearchQuery,
  type KnowledgeListQuery,
  type KnowledgePage,
  type MeetingListQuery,
  type MeetingPage,
  type OutreachrMcpService,
  type Page,
  type PersonGetQuery,
  type PersonListQuery,
  type PersonPage,
  type PersonRecord,
  type PipelinePage,
  type PipelineQuery,
  type PrivateField,
  type ProposalResult,
  type ProposeDraftInput,
  type ProposeKnowledgeInput,
  type ProposeMeetingInput,
  type ProposeSourceReviewInput,
  type ProposeStageInput,
  type ProposeTargetInput,
  type ProposeTaskInput,
  type RoundQuery,
  type RoundRecord,
  type ServiceInvocationContext,
  type TaskListQuery,
  type TaskPage,
} from '@outreachr/mcp';

import type {
  AppBootstrap,
  InvestorDetail,
  InvestorSummary,
  PersonSummary,
} from '../shared/contracts';
import type {
  DesktopMcpController,
  DesktopMcpReadScope,
  DesktopMcpSessionRegistration,
} from './mcp-controller';

const LOOPBACK_HOST = '127.0.0.1';
const MCP_PATH = '/mcp';
const SESSION_HEADER = 'x-outreachr-session';
const MAX_REQUEST_BYTES = 512 * 1024;
const ALLOWED_JSON_RPC_METHODS = new Set([
  'initialize',
  'notifications/initialized',
  'notifications/cancelled',
  'ping',
  'tools/list',
  'tools/call',
]);
const READ_SCOPES = new Set<DesktopMcpReadScope>(['round', 'company', 'investors', 'activity']);

interface McpVault {
  readonly vault: CoreVault;
  bootstrap(): Promise<AppBootstrap>;
  investorDetail(id: string): Promise<InvestorDetail>;
  persist(): Promise<void>;
}

interface ActiveSession {
  readonly runId: string;
  readonly provider: 'codex' | 'claude';
  readonly purpose: string;
  readonly readScopes: ReadonlySet<DesktopMcpReadScope>;
  readonly enabledTools: readonly OutreachrAgentMcpToolName[];
  readonly enabledToolSet: ReadonlySet<OutreachrAgentMcpToolName>;
  readonly disclosedRecordIds: ReadonlySet<string>;
  readonly allowedPrivateFields: ReadonlySet<PrivateField>;
  readonly onProposal: DesktopMcpSessionRegistration['onProposal'];
  readonly requests: Map<string, string>;
}

export interface DesktopMcpBridgeOptions {
  vault: McpVault;
  appVersion: string;
  now?: () => Date;
  createId?: () => string;
}

/**
 * In-process MCP adapter and loopback HTTP boundary. The bearer credential is
 * ephemeral, requests are additionally bound to an active run header, and
 * AsyncLocalStorage carries that authenticated run into every service method.
 */
export class DesktopMcpBridge implements DesktopMcpController, OutreachrMcpService {
  readonly #vault: McpVault;
  readonly #appVersion: string;
  readonly #now: () => Date;
  readonly #createId: () => string;
  readonly #http: Server;
  readonly #sessions = new Map<string, ActiveSession>();
  readonly #requestSession = new AsyncLocalStorage<string>();
  readonly #bearerToken = randomBytes(32).toString('base64url');
  #endpoint = '';
  #disposed = false;
  #persistQueue: Promise<void> = Promise.resolve();

  private constructor(options: DesktopMcpBridgeOptions) {
    this.#vault = options.vault;
    this.#appVersion = options.appVersion;
    this.#now = options.now ?? (() => new Date());
    this.#createId = options.createId ?? randomUUID;
    this.#http = createServer((request, response) => {
      void this.#handleHttp(request, response).catch(() => {
        if (!response.headersSent) this.#jsonError(response, 500, 'Internal server error');
        else response.destroy();
      });
    });
    this.#http.maxHeadersCount = 32;
    this.#http.headersTimeout = 5_000;
    this.#http.requestTimeout = 35_000;
    this.#http.keepAliveTimeout = 1_000;
  }

  static async start(options: DesktopMcpBridgeOptions): Promise<DesktopMcpBridge> {
    const bridge = new DesktopMcpBridge(options);
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      bridge.#http.once('error', onError);
      bridge.#http.listen(0, LOOPBACK_HOST, () => {
        bridge.#http.off('error', onError);
        const address = bridge.#http.address();
        if (!address || typeof address === 'string') {
          reject(new Error('Outreachr MCP did not bind a loopback TCP address.'));
          return;
        }
        bridge.#endpoint = `http://${LOOPBACK_HOST}:${address.port}${MCP_PATH}`;
        resolve();
      });
    });
    return bridge;
  }

  get bearerToken(): string {
    return this.#bearerToken;
  }

  get endpoint(): string {
    return this.#endpoint;
  }

  registerSession(registration: DesktopMcpSessionRegistration): AgentMcpConnection {
    if (this.#disposed) throw new Error('Outreachr MCP bridge is disposed.');
    const runId = registration.runId.trim();
    const purpose = registration.purpose.trim();
    if (!runId || runId.length > 160 || runId !== registration.runId) {
      throw new Error('MCP run ID is invalid.');
    }
    if (this.#sessions.has(runId)) {
      throw new Error(`MCP session ${runId} is already active.`);
    }
    if (!purpose || purpose.length > 500) throw new Error('MCP audit purpose is invalid.');
    const disclosedRecordIds = new Set(
      registration.disclosedRecordIds.map((recordId) => recordIdSchema.parse(recordId)),
    );
    const allowedPrivateFields = new Set(
      registration.allowedPrivateFields.map((field) => privateFieldSchema.parse(field)),
    );
    const readScopes = new Set(registration.readScopes);
    if (registration.readScopes.some((scope) => !READ_SCOPES.has(scope))) {
      throw new Error('MCP read scope is invalid.');
    }
    const enabledTools = enabledToolsForReadScopes(readScopes);
    this.#sessions.set(runId, {
      runId,
      provider: registration.provider,
      purpose,
      readScopes,
      enabledTools,
      enabledToolSet: new Set(enabledTools),
      disclosedRecordIds,
      allowedPrivateFields,
      onProposal: registration.onProposal,
      requests: new Map(),
    });
    return Object.freeze({
      serverName: 'outreachr',
      url: this.#endpoint,
      bearerToken: this.#bearerToken,
      sessionId: runId,
      auditPurpose: purpose,
      enabledTools: Object.freeze([...enabledTools]),
    });
  }

  unregisterSession(runId: string): void {
    this.#sessions.delete(runId);
  }

  /**
   * Bind the service adapter to one already-registered session for transports
   * (such as stdio) that do not pass through the authenticated HTTP handler.
   * The returned adapter retains the exact same authorization and audit checks.
   */
  serviceForSession(runId: string): OutreachrMcpService {
    if (!this.#sessions.has(runId)) throw new Error('MCP session is not active.');
    const bound = <T>(operation: () => T): T => this.#requestSession.run(runId, operation);
    const service: OutreachrMcpService = {
      authorizeAccess: (request, context) => bound(() => this.authorizeAccess(request, context)),
      recordAuditEvent: (event) => bound(() => this.recordAuditEvent(event)),
      searchInvestors: (query, context) => bound(() => this.searchInvestors(query, context)),
      listInvestors: (query, context) => bound(() => this.listInvestors(query, context)),
      getInvestor: (query, context) => bound(() => this.getInvestor(query, context)),
      searchPeople: (query, context) => bound(() => this.searchPeople(query, context)),
      listPeople: (query, context) => bound(() => this.listPeople(query, context)),
      getPerson: (query, context) => bound(() => this.getPerson(query, context)),
      getPipeline: (query, context) => bound(() => this.getPipeline(query, context)),
      getRound: (query, context) => bound(() => this.getRound(query, context)),
      listTasks: (query, context) => bound(() => this.listTasks(query, context)),
      listMeetings: (query, context) => bound(() => this.listMeetings(query, context)),
      listKnowledge: (query, context) => bound(() => this.listKnowledge(query, context)),
      listActivity: (query, context) => bound(() => this.listActivity(query, context)),
      proposeTarget: (input, context) => bound(() => this.proposeTarget(input, context)),
      proposeStage: (input, context) => bound(() => this.proposeStage(input, context)),
      proposeTask: (input, context) => bound(() => this.proposeTask(input, context)),
      proposeMeeting: (input, context) => bound(() => this.proposeMeeting(input, context)),
      proposeKnowledge: (input, context) => bound(() => this.proposeKnowledge(input, context)),
      proposeDraft: (input, context) => bound(() => this.proposeDraft(input, context)),
      proposeSourceReview: (input, context) =>
        bound(() => this.proposeSourceReview(input, context)),
    };
    return Object.freeze(service);
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#sessions.clear();
    this.#http.closeAllConnections();
    await new Promise<void>((resolve) => this.#http.close(() => resolve()));
  }

  async authorizeAccess(
    request: AccessRequest,
    context: Omit<ServiceInvocationContext, 'accessGrant'>,
  ): Promise<AccessGrant> {
    const session = this.#assertReadInvocation(context);
    const disclosedByCall = new Set(context.audit.disclosedContextIds);
    if (
      context.audit.disclosedContextIds.some((id) => !session.disclosedRecordIds.has(id)) ||
      request.recordIds.some(
        (id) => !session.disclosedRecordIds.has(id) || !disclosedByCall.has(id),
      ) ||
      request.fields.some((field) => !session.allowedPrivateFields.has(field)) ||
      (request.fields.length > 0 && request.recordIds.length === 0)
    ) {
      throw new Error('MCP access is outside the active founder disclosure.');
    }
    return { recordIds: [...request.recordIds], fields: [...request.fields] };
  }

  async recordAuditEvent(event: AuditEvent): Promise<void> {
    const session = this.#assertAuditIdentity(event);
    const priorInvocation = session.requests.get(event.requestId);
    if (event.phase === 'requested') {
      if (priorInvocation !== undefined) throw new Error('MCP request ID was already used.');
      session.requests.set(event.requestId, event.invocationId);
    } else if (priorInvocation !== event.invocationId) {
      throw new Error('MCP terminal audit does not match its request.');
    }

    await this.#persistSerially(async () => {
      appendAuditEntry(this.#vault.vault, {
        occurredAt: event.occurredAt,
        actorType: 'agent',
        actorId: session.runId,
        action: `mcp.tool_${event.phase}`,
        entityType: 'mcp_invocation',
        entityId: event.invocationId,
        detail: {
          toolName: event.toolName,
          riskLevel: event.riskLevel,
          requestId: event.requestId,
          ...(event.redactedRecordCount === undefined
            ? {}
            : { redactedRecordCount: event.redactedRecordCount }),
          ...(event.errorCode === undefined ? {} : { errorCode: event.errorCode }),
        },
      });
    });
  }

  async searchInvestors(
    query: InvestorSearchQuery,
    _context: ServiceInvocationContext,
  ): Promise<InvestorPage> {
    this.#assertReadInvocation(_context);
    const snapshot = await this.#vault.bootstrap();
    const needle = normalize(query.query);
    return paginate(
      snapshot.investors
        .filter((investor) => investorMatchesFilters(investor, query.filters))
        .filter((investor) =>
          [
            investor.name,
            investor.headquarters ?? '',
            ...investor.geographies,
            ...investor.stages,
            ...investor.sectors,
          ].some((value) => normalize(value).includes(needle)),
        )
        .map(investorRecord),
      query,
    );
  }

  async listInvestors(
    query: InvestorListQuery,
    _context: ServiceInvocationContext,
  ): Promise<InvestorPage> {
    this.#assertReadInvocation(_context);
    const snapshot = await this.#vault.bootstrap();
    return paginate(
      snapshot.investors
        .filter((investor) => investorMatchesFilters(investor, query.filters))
        .map(investorRecord),
      query,
    );
  }

  async getInvestor(
    query: InvestorGetQuery,
    _context: ServiceInvocationContext,
  ): Promise<InvestorRecord> {
    this.#assertReadInvocation(_context);
    return investorRecord(await this.#vault.investorDetail(query.investorId));
  }

  async searchPeople(
    query: PersonListQuery & { query: string },
    _context: ServiceInvocationContext,
  ): Promise<PersonPage> {
    this.#assertReadInvocation(_context);
    const snapshot = await this.#vault.bootstrap();
    const needle = normalize(query.query);
    return paginate(
      snapshot.people
        .filter((person) => personMatchesFilters(person, query.filters))
        .filter((person) =>
          [person.name, person.firmName ?? '', person.title ?? '', ...person.sectors].some(
            (value) => normalize(value).includes(needle),
          ),
        )
        .map(personRecord),
      query,
    );
  }

  async listPeople(
    query: PersonListQuery,
    _context: ServiceInvocationContext,
  ): Promise<PersonPage> {
    this.#assertReadInvocation(_context);
    const snapshot = await this.#vault.bootstrap();
    return paginate(
      snapshot.people
        .filter((person) => personMatchesFilters(person, query.filters))
        .map(personRecord),
      query,
    );
  }

  async getPerson(
    query: PersonGetQuery,
    _context: ServiceInvocationContext,
  ): Promise<PersonRecord> {
    this.#assertReadInvocation(_context);
    const person = (await this.#vault.bootstrap()).people.find(
      (item) => item.id === query.personId,
    );
    if (!person) throw new Error('Person not found.');
    return personRecord(person);
  }

  async getPipeline(
    query: PipelineQuery,
    _context: ServiceInvocationContext,
  ): Promise<PipelinePage> {
    this.#assertReadInvocation(_context);
    const snapshot = await this.#vault.bootstrap();
    return paginate(
      snapshot.investors
        .filter(
          (investor) =>
            investor.target &&
            investor.pipelineStage !== null &&
            (query.stages.length === 0 || query.stages.includes(investor.pipelineStage)),
        )
        .map((investor) => ({
          id: investor.id,
          investorId: investor.id,
          investorName: investor.name,
          stage: investor.pipelineStage!,
          nextAction: investor.nextAction,
          owner: 'founder' as const,
        })),
      query,
    );
  }

  async getRound(
    query: RoundQuery,
    _context: ServiceInvocationContext,
  ): Promise<RoundRecord | null> {
    this.#assertReadInvocation(_context);
    const round = (await this.#vault.bootstrap()).round;
    if (!round || (query.roundId !== undefined && round.id !== query.roundId)) return null;
    return {
      id: round.id,
      companyName: round.companyName,
      companyOneLiner: round.companyOneLiner,
      stage: round.stage,
      sectors: round.sectors,
      geographies: round.geographies,
      status: round.status,
      targetAmount: round.targetAmount,
      committedAmount: round.committedAmount,
      softCircleAmount: round.softCircleAmount,
      targetCheck: round.targetCheck,
      launchDate: round.launchDate,
      targetCloseDate: round.targetCloseDate,
      narrative: round.narrative,
    };
  }

  async listTasks(query: TaskListQuery, _context: ServiceInvocationContext): Promise<TaskPage> {
    this.#assertReadInvocation(_context);
    const snapshot = await this.#vault.bootstrap();
    return paginate(
      snapshot.tasks.filter(
        (task) =>
          (query.status.length === 0 || query.status.includes(task.status)) &&
          (query.investorId === undefined || task.investorId === query.investorId) &&
          (query.personId === undefined || task.personId === query.personId),
      ),
      query,
    );
  }

  async listMeetings(
    query: MeetingListQuery,
    _context: ServiceInvocationContext,
  ): Promise<MeetingPage> {
    this.#assertReadInvocation(_context);
    const snapshot = await this.#vault.bootstrap();
    return paginate(
      snapshot.meetings
        .filter(
          (meeting) =>
            (query.status.length === 0 || query.status.includes(meeting.status)) &&
            (query.from === undefined || meeting.endsAt >= query.from) &&
            (query.to === undefined || meeting.startsAt <= query.to),
        )
        .map((meeting) => ({
          id: meeting.id,
          title: meeting.title,
          startsAt: meeting.startsAt,
          endsAt: meeting.endsAt,
          status: meeting.status,
          investorId: meeting.investorId,
          location: meeting.location,
          attendeePersonIds: meeting.personIds,
          agenda: meeting.agenda,
          notes: meeting.notes,
        })),
      query,
    );
  }

  async listKnowledge(
    query: KnowledgeListQuery,
    _context: ServiceInvocationContext,
  ): Promise<KnowledgePage> {
    this.#assertReadInvocation(_context);
    const snapshot = await this.#vault.bootstrap();
    return paginate(
      snapshot.knowledge.filter(
        (knowledge) =>
          query.categories.length === 0 || query.categories.includes(knowledge.category),
      ),
      query,
    );
  }

  async listActivity(
    query: ActivityListQuery,
    _context: ServiceInvocationContext,
  ): Promise<ActivityPage> {
    this.#assertReadInvocation(_context);
    const snapshot = await this.#vault.bootstrap();
    const records = activityRecords(snapshot)
      .filter((item) => query.kinds.length === 0 || query.kinds.includes(item.kind))
      .filter((item) => query.investorId === undefined || item.investorId === query.investorId)
      .filter((item) => query.personId === undefined || item.personId === query.personId)
      .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt));
    return paginate(records, query);
  }

  proposeTarget(
    _input: ProposeTargetInput,
    _context: ServiceInvocationContext,
  ): Promise<ProposalResult> {
    void _input;
    this.#assertInvocation(_context);
    return Promise.reject(new Error('Target proposals are not enabled for embedded agents.'));
  }

  async proposeStage(
    input: ProposeStageInput,
    context: ServiceInvocationContext,
  ): Promise<ProposalResult> {
    return this.#createProposal(context, {
      id: `proposal:${this.#createId()}`,
      kind: 'pipeline_move',
      title: `Move investor to ${input.stage.replaceAll('_', ' ')}`,
      rationale: input.reason,
      investorId: input.investorId,
      payload: { investorId: input.investorId, stage: input.stage },
      executable: false,
    });
  }

  async proposeTask(
    input: ProposeTaskInput,
    context: ServiceInvocationContext,
  ): Promise<ProposalResult> {
    return this.#createProposal(context, {
      id: `proposal:${this.#createId()}`,
      kind: 'task',
      title: input.title,
      rationale: input.reason,
      ...(input.investorId ? { investorId: input.investorId } : {}),
      payload: {
        title: input.title,
        notes: input.notes ?? null,
        dueAt: input.dueAt ?? null,
        investorId: input.investorId ?? null,
        ...(input.personId ? { personId: input.personId } : {}),
      },
      executable: false,
    });
  }

  proposeMeeting(
    _input: ProposeMeetingInput,
    _context: ServiceInvocationContext,
  ): Promise<ProposalResult> {
    void _input;
    this.#assertInvocation(_context);
    return Promise.reject(new Error('Meeting proposals are not enabled for embedded agents.'));
  }

  proposeKnowledge(
    _input: ProposeKnowledgeInput,
    _context: ServiceInvocationContext,
  ): Promise<ProposalResult> {
    void _input;
    this.#assertInvocation(_context);
    return Promise.reject(new Error('Knowledge proposals are not enabled for embedded agents.'));
  }

  async proposeDraft(
    input: ProposeDraftInput,
    context: ServiceInvocationContext,
  ): Promise<ProposalResult> {
    if (input.kind !== 'initial') {
      throw new Error('Embedded agents may propose only a new initial draft.');
    }
    const person = (await this.#vault.bootstrap()).people.find(
      (item) => item.id === input.personId,
    );
    if (!person) throw new Error('Draft recipient does not exist.');
    return this.#createProposal(context, {
      id: `proposal:${this.#createId()}`,
      kind: 'draft',
      title: `Draft initial outreach to ${person.name}`,
      rationale: input.reason,
      ...(person.firmId ? { investorId: person.firmId } : {}),
      payload: {
        personId: input.personId,
        provider: input.provider,
        subject: input.subject,
        bodyText: input.bodyText,
      },
      executable: false,
    });
  }

  proposeSourceReview(
    _input: ProposeSourceReviewInput,
    _context: ServiceInvocationContext,
  ): Promise<ProposalResult> {
    void _input;
    this.#assertInvocation(_context);
    return Promise.reject(
      new Error('Source-review proposals are not enabled for embedded agents.'),
    );
  }

  async #createProposal(
    context: ServiceInvocationContext,
    proposal: AgentProposal,
  ): Promise<ProposalResult> {
    const session = this.#assertInvocation(context);
    if (context.riskLevel !== 'proposal') throw new Error('MCP proposal risk identity is invalid.');
    await session.onProposal(proposal);
    return {
      proposalId: proposal.id,
      status: 'pending_founder_approval',
      summary: `${proposal.title} is pending founder approval.`,
      warnings: ['Nothing was applied, sent, scheduled, or written to a provider.'],
      createdAt: this.#now().toISOString(),
    };
  }

  #assertInvocation(context: Pick<ServiceInvocationContext, 'audit'>): ActiveSession {
    return this.#assertAuditIdentity(context.audit);
  }

  #assertReadInvocation(
    context: Pick<ServiceInvocationContext, 'audit' | 'toolName'>,
  ): ActiveSession {
    const session = this.#assertInvocation(context);
    const requiredReadScope = readScopeForTool(context.toolName);
    if (requiredReadScope && !session.readScopes.has(requiredReadScope)) {
      throw new Error('MCP read tool is outside the founder-disclosed context classes.');
    }
    return session;
  }

  #assertAuditIdentity(input: {
    actor: string;
    sessionId: string;
    purpose: string;
  }): ActiveSession {
    const authenticatedRunId = this.#requestSession.getStore();
    if (!authenticatedRunId) throw new Error('MCP request has no authenticated session.');
    const session = this.#sessions.get(authenticatedRunId);
    if (
      !session ||
      input.sessionId !== session.runId ||
      input.actor !== session.provider ||
      input.purpose !== session.purpose
    ) {
      throw new Error('MCP audit identity does not match the active run.');
    }
    return session;
  }

  async #persistSerially(mutate: () => void | Promise<void>): Promise<void> {
    const operation = this.#persistQueue.then(async () => {
      await mutate();
      await this.#vault.persist();
    });
    this.#persistQueue = operation.catch(() => undefined);
    await operation;
  }

  async #handleHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    this.#securityHeaders(response);
    const session = this.#authenticateHttp(request, response);
    if (!session) return;
    const body = await readJsonBody(request, response);
    if (body === undefined) return;
    if (!validateRpcEnvelope(body)) {
      this.#jsonError(response, 400, 'Invalid MCP request');
      return;
    }
    if (containsForbiddenToolCall(body, session.enabledToolSet)) {
      this.#jsonError(response, 403, 'MCP tool is not enabled');
      return;
    }

    await this.#requestSession.run(session.runId, async () => {
      const transport = new StreamableHTTPServerTransport();
      const server = createOutreachrMcpServer(this, {
        name: 'outreachr-desktop',
        version: this.#appVersion,
        enabledTools: session.enabledTools,
      });
      try {
        await server.connect(transport as Parameters<typeof server.connect>[0]);
        await transport.handleRequest(request, response, body);
      } finally {
        await transport.close().catch(() => undefined);
        await server.close().catch(() => undefined);
      }
    });
  }

  #authenticateHttp(request: IncomingMessage, response: ServerResponse): ActiveSession | null {
    if (this.#disposed) {
      this.#jsonError(response, 503, 'MCP bridge is unavailable');
      return null;
    }
    if (request.method !== 'POST') {
      response.setHeader('Allow', 'POST');
      this.#jsonError(response, 405, 'Method not allowed');
      return null;
    }
    let url: URL;
    try {
      url = new URL(request.url ?? '', this.#endpoint);
    } catch {
      this.#jsonError(response, 400, 'Invalid request URL');
      return null;
    }
    const address = this.#http.address();
    const expectedHost =
      address && typeof address !== 'string' ? `${LOOPBACK_HOST}:${address.port}` : '';
    if (
      url.pathname !== MCP_PATH ||
      url.search !== '' ||
      url.host !== expectedHost ||
      request.headers.host !== expectedHost ||
      !isLoopbackAddress(request.socket.remoteAddress) ||
      request.headers.origin !== undefined
    ) {
      this.#jsonError(response, 403, 'Request boundary rejected');
      return null;
    }
    const contentType = request.headers['content-type'];
    if (
      typeof contentType !== 'string' ||
      !contentType.toLowerCase().startsWith('application/json')
    ) {
      this.#jsonError(response, 415, 'JSON content type required');
      return null;
    }
    const contentLength = Number(request.headers['content-length'] ?? 0);
    if (!Number.isFinite(contentLength) || contentLength < 0 || contentLength > MAX_REQUEST_BYTES) {
      this.#jsonError(response, 413, 'Request too large');
      return null;
    }
    const authorization = request.headers.authorization;
    const suppliedToken =
      typeof authorization === 'string' && authorization.startsWith('Bearer ')
        ? authorization.slice('Bearer '.length)
        : '';
    if (!constantTimeEqual(suppliedToken, this.#bearerToken)) {
      response.setHeader('WWW-Authenticate', 'Bearer');
      this.#jsonError(response, 401, 'Unauthorized');
      return null;
    }
    const sessionHeader = request.headers[SESSION_HEADER];
    const sessionId = typeof sessionHeader === 'string' ? sessionHeader : '';
    const session = this.#sessions.get(sessionId);
    if (!session) {
      this.#jsonError(response, 401, 'Unauthorized');
      return null;
    }
    return session;
  }

  #securityHeaders(response: ServerResponse): void {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Pragma', 'no-cache');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
  }

  #jsonError(response: ServerResponse, status: number, message: string): void {
    if (response.writableEnded) return;
    response.statusCode = status;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(
      JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32_000, message },
        id: null,
      }),
    );
  }
}

function investorRecord(investor: InvestorSummary | InvestorDetail): InvestorRecord {
  const detail = 'sources' in investor ? investor : undefined;
  return {
    id: investor.id,
    name: investor.name,
    kind: investor.kind,
    additionalKinds: investor.additionalKinds,
    headquarters: investor.headquarters,
    geographies: investor.geographies,
    stages: investor.stages,
    sectors: investor.sectors,
    check: investor.check,
    fitScore: investor.fitScore,
    fitReasons: investor.fitReasons,
    confidence: investor.confidence,
    sourceIds: detail?.sources.map((source) => source.id) ?? [],
    target: investor.target,
    pipelineStage: investor.pipelineStage,
    nextAction: investor.nextAction,
    ...(detail
      ? {
          website: detail.website,
          description: detail.description,
          thesis: detail.thesis,
        }
      : {}),
  };
}

function personRecord(person: PersonSummary): PersonRecord {
  return {
    id: person.id,
    name: person.name,
    firmId: person.firmId,
    firmName: person.firmName,
    title: person.title,
    investorKinds: person.investorKinds,
    sectors: person.sectors,
    linkedinUrl: person.linkedinUrl,
    xUrl: person.xUrl,
    sourceIds: [],
    workEmail: person.workEmail,
    contactConfidence: person.emailConfidence,
    target: person.target,
    contacted: person.contacted,
    replied: person.replied,
  };
}

function investorMatchesFilters(
  investor: InvestorSummary,
  filters: InvestorListQuery['filters'],
): boolean {
  return (
    (filters.kinds.length === 0 ||
      filters.kinds.some(
        (kind) => investor.kind === kind || investor.additionalKinds.includes(kind),
      )) &&
    (filters.stages.length === 0 ||
      filters.stages.some((stage) => investor.stages.includes(stage))) &&
    (filters.sectors.length === 0 ||
      filters.sectors.some((sector) => investor.sectors.includes(sector))) &&
    (filters.geographies.length === 0 ||
      filters.geographies.some((geography) => investor.geographies.includes(geography))) &&
    (!filters.targetOnly || investor.target)
  );
}

function personMatchesFilters(person: PersonSummary, filters: PersonListQuery['filters']): boolean {
  return (
    (filters.firmIds.length === 0 ||
      (person.firmId !== null && filters.firmIds.includes(person.firmId))) &&
    (filters.sectors.length === 0 ||
      filters.sectors.some((sector) => person.sectors.includes(sector))) &&
    (!filters.targetOnly || person.target)
  );
}

function activityRecords(snapshot: AppBootstrap): ActivityRecord[] {
  return [
    ...snapshot.tasks.map((task) => ({
      id: task.id,
      kind: 'task' as const,
      title: task.title,
      detail: task.notes,
      occurredAt: task.createdAt,
      actor: 'founder' as const,
      investorId: task.investorId,
      personId: task.personId,
    })),
    ...snapshot.meetings.map((meeting) => ({
      id: meeting.id,
      kind: 'meeting' as const,
      title: meeting.title,
      detail: meeting.notes ?? meeting.agenda,
      occurredAt: meeting.startsAt,
      actor: 'founder' as const,
      investorId: meeting.investorId,
    })),
    ...snapshot.mailEvents.map((event) => ({
      id: event.id,
      kind: 'email' as const,
      title: `${event.direction === 'inbound' ? 'Inbound' : 'Outbound'} email · ${event.subject}`,
      detail: event.subject,
      occurredAt: event.occurredAt,
      actor: 'provider' as const,
      investorId: event.investorId,
      personId: event.personId,
    })),
    ...snapshot.agentProposals.map((proposal) => ({
      id: proposal.id,
      kind: 'agent' as const,
      title: proposal.title,
      detail: proposal.rationale,
      occurredAt: proposal.createdAt,
      actor: 'agent' as const,
      investorId: proposal.investorId,
    })),
  ];
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase('en-US');
}

function readScopeForTool(toolName: string): DesktopMcpReadScope | undefined {
  if (
    [
      'outreachr_search_investors',
      'outreachr_list_investors',
      'outreachr_get_investor',
      'outreachr_search_people',
      'outreachr_list_people',
      'outreachr_get_person',
      'outreachr_get_pipeline',
    ].includes(toolName)
  ) {
    return 'investors';
  }
  if (toolName === 'outreachr_get_round') return 'round';
  if (toolName === 'outreachr_list_knowledge') return 'company';
  if (
    ['outreachr_list_tasks', 'outreachr_list_meetings', 'outreachr_list_activity'].includes(
      toolName,
    )
  ) {
    return 'activity';
  }
  return undefined;
}

function enabledToolsForReadScopes(
  readScopes: ReadonlySet<DesktopMcpReadScope>,
): OutreachrAgentMcpToolName[] {
  return [
    ...OUTREACHR_AGENT_MCP_READ_TOOLS.filter((toolName) => {
      const requiredScope = readScopeForTool(toolName);
      return requiredScope !== undefined && readScopes.has(requiredScope);
    }),
    ...OUTREACHR_AGENT_MCP_PROPOSAL_TOOLS,
  ];
}

function paginate<T>(
  items: readonly T[],
  query: { limit: number; cursor?: string | undefined },
): Page<T> {
  const offset = decodeCursor(query.cursor);
  if (offset > items.length) throw new Error('MCP cursor is outside the result set.');
  const page = items.slice(offset, offset + query.limit);
  const nextOffset = offset + page.length;
  return {
    items: page,
    nextCursor: nextOffset < items.length ? `offset:${nextOffset}` : null,
    total: items.length,
  };
}

function decodeCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const match = /^offset:(0|[1-9]\d{0,9})$/u.exec(cursor);
  if (!match) throw new Error('MCP cursor is invalid.');
  return Number(match[1]);
}

async function readJsonBody(request: IncomingMessage, response: ServerResponse): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += bytes.byteLength;
    if (size > MAX_REQUEST_BYTES) {
      response.statusCode = 413;
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      response.end(
        JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32_000, message: 'Request too large' },
          id: null,
        }),
      );
      return undefined;
    }
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    response.statusCode = 400;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(
      JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32_700, message: 'Invalid JSON' },
        id: null,
      }),
    );
    return undefined;
  }
}

function validateRpcEnvelope(body: unknown): boolean {
  const messages = Array.isArray(body) ? body : [body];
  return (
    messages.length > 0 &&
    messages.length <= 20 &&
    messages.every((message) => {
      if (!isRecord(message) || message.jsonrpc !== '2.0') return false;
      if (typeof message.method !== 'string' || !ALLOWED_JSON_RPC_METHODS.has(message.method)) {
        return false;
      }
      return true;
    })
  );
}

function containsForbiddenToolCall(
  body: unknown,
  enabledTools: ReadonlySet<OutreachrAgentMcpToolName>,
): boolean {
  const messages = Array.isArray(body) ? body : [body];
  return messages.some((message) => {
    if (!isRecord(message) || message.method !== 'tools/call' || !isRecord(message.params)) {
      return false;
    }
    return (
      typeof message.params.name !== 'string' ||
      !enabledTools.has(message.params.name as OutreachrAgentMcpToolName)
    );
  });
}

function constantTimeEqual(candidate: string, expected: string): boolean {
  const candidateBytes = Buffer.from(candidate);
  const expectedBytes = Buffer.from(expected);
  return (
    candidateBytes.byteLength === expectedBytes.byteLength &&
    timingSafeEqual(candidateBytes, expectedBytes)
  );
}

function isLoopbackAddress(address: string | undefined): boolean {
  return address === LOOPBACK_HOST || address === `::ffff:${LOOPBACK_HOST}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
