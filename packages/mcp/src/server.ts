import { randomUUID } from 'node:crypto';

import { McpServer, type RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { z } from 'zod';

import {
  accessGrantSchema,
  activityListInputSchema,
  activityPageSchema,
  envelopeSchema,
  investorGetInputSchema,
  investorListInputSchema,
  investorPageSchema,
  investorRecordSchema,
  investorSearchInputSchema,
  knowledgeListInputSchema,
  knowledgePageSchema,
  meetingListInputSchema,
  meetingPageSchema,
  personGetInputSchema,
  personListInputSchema,
  personPageSchema,
  personRecordSchema,
  personSearchInputSchema,
  pipelineInputSchema,
  pipelineResultSchema,
  proposalResultSchema,
  proposeDraftInputSchema,
  proposeKnowledgeInputSchema,
  proposeMeetingInputSchema,
  proposeSourceReviewInputSchema,
  proposeStageInputSchema,
  proposeTargetInputSchema,
  proposeTaskInputSchema,
  roundInputSchema,
  roundRecordSchema,
  taskListInputSchema,
  taskPageSchema,
  type AccessGrant,
  type AccessRequest,
  type AuditContext,
} from './schemas.js';
import {
  accessGrantHasAnyPrivateAccess,
  redactActivity,
  redactInvestor,
  redactInvestorPage,
  redactKnowledge,
  redactMeetings,
  redactPerson,
  redactPersonPage,
  redactPipeline,
  redactRound,
  redactTasks,
  type Redacted,
} from './redaction.js';
import type {
  AuditEvent,
  OutreachrMcpServerOptions,
  OutreachrMcpService,
  RiskLevel,
  ServiceInvocationContext,
} from './types.js';

export const OUTREACHR_MCP_TOOL_NAMES = [
  'outreachr_search_investors',
  'outreachr_list_investors',
  'outreachr_get_investor',
  'outreachr_search_people',
  'outreachr_list_people',
  'outreachr_get_person',
  'outreachr_get_pipeline',
  'outreachr_get_round',
  'outreachr_list_tasks',
  'outreachr_list_meetings',
  'outreachr_list_knowledge',
  'outreachr_list_activity',
  'outreachr_propose_target',
  'outreachr_propose_stage',
  'outreachr_propose_task',
  'outreachr_propose_meeting',
  'outreachr_propose_knowledge',
  'outreachr_propose_draft',
  'outreachr_propose_source_review',
] as const;

export type OutreachrMcpToolName = (typeof OUTREACHR_MCP_TOOL_NAMES)[number];

class SafeToolError extends Error {
  constructor(
    readonly code:
      'AUDIT_FAILURE' | 'AUTHORIZATION_FAILURE' | 'SERVICE_FAILURE' | 'OUTPUT_REJECTED',
  ) {
    super(code);
    this.name = 'SafeToolError';
  }
}

const readAnnotations: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const proposalAnnotations: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

function toolMetadata(riskLevel: RiskLevel): Record<string, unknown> {
  return {
    'outreachr/riskLevel': riskLevel,
    'outreachr/effect': riskLevel === 'read' ? 'none' : 'create_pending_proposal_only',
    'outreachr/founderApprovalRequired': riskLevel === 'proposal',
    'outreachr/auditContextRequired': true,
    'outreachr/privateDataDefault': 'redacted',
    'outreachr/dataBoundary': 'local_vault',
    'outreachr/forbiddenCapabilities': [
      'message_send',
      'oauth_access',
      'token_access',
      'backup',
      'export',
      'raw_sql',
      'filesystem',
      'shell',
    ],
  };
}

function errorResult(code: SafeToolError['code']): CallToolResult {
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: `Outreachr rejected this tool invocation (${code}). No action was applied.`,
      },
    ],
  };
}

function validateGrant(value: unknown, requested: AccessRequest, audit: AuditContext): AccessGrant {
  const parsed = accessGrantSchema.safeParse(value);
  if (!parsed.success) throw new SafeToolError('AUTHORIZATION_FAILURE');

  const requestedIds = new Set(requested.recordIds);
  const disclosedIds = new Set(audit.disclosedContextIds);
  const requestedFields = new Set(requested.fields);
  if (
    parsed.data.recordIds.some((id) => !requestedIds.has(id) || !disclosedIds.has(id)) ||
    parsed.data.fields.some((field) => !requestedFields.has(field))
  ) {
    throw new SafeToolError('AUTHORIZATION_FAILURE');
  }
  return parsed.data;
}

function requireProposalRecords(
  grant: AccessGrant,
  recordIds: Array<string | null | undefined>,
): void {
  const allowed = new Set(grant.recordIds);
  if (recordIds.some((id) => id !== null && id !== undefined && !allowed.has(id))) {
    throw new SafeToolError('AUTHORIZATION_FAILURE');
  }
}

function toAuditEvent(
  context: Omit<ServiceInvocationContext, 'accessGrant'>,
  phase: AuditEvent['phase'],
  occurredAt: string,
  details: Pick<AuditEvent, 'redactedRecordCount' | 'errorCode'> = {},
): AuditEvent {
  return {
    invocationId: context.invocationId,
    toolName: context.toolName,
    riskLevel: context.riskLevel,
    phase,
    actor: context.audit.actor,
    sessionId: context.audit.sessionId,
    requestId: context.audit.requestId,
    purpose: context.audit.purpose,
    occurredAt,
    ...(details.redactedRecordCount === undefined
      ? {}
      : { redactedRecordCount: details.redactedRecordCount }),
    ...(details.errorCode === undefined ? {} : { errorCode: details.errorCode }),
  };
}

interface InvokeOptions<ServiceSchema extends z.ZodTypeAny, FinalSchema extends z.ZodTypeAny> {
  service: OutreachrMcpService;
  toolName: OutreachrMcpToolName;
  riskLevel: RiskLevel;
  audit: AuditContext;
  access: AccessRequest;
  serviceOutputSchema: ServiceSchema;
  finalOutputSchema: FinalSchema;
  invoke: (context: ServiceInvocationContext) => Promise<unknown>;
  redact: (
    value: z.output<ServiceSchema>,
    grant: AccessGrant,
  ) => Redacted<z.input<FinalSchema> | z.output<FinalSchema>>;
  requiredProposalRecordIds?: Array<string | null | undefined>;
  now: () => Date;
  createInvocationId: () => string;
}

async function invokeTool<ServiceSchema extends z.ZodTypeAny, FinalSchema extends z.ZodTypeAny>(
  options: InvokeOptions<ServiceSchema, FinalSchema>,
): Promise<CallToolResult> {
  const baseContext: Omit<ServiceInvocationContext, 'accessGrant'> = {
    invocationId: options.createInvocationId(),
    toolName: options.toolName,
    riskLevel: options.riskLevel,
    audit: options.audit,
    requestedAccess: options.access,
  };
  let initialAuditRecorded = false;

  try {
    try {
      await options.service.recordAuditEvent(
        toAuditEvent(baseContext, 'requested', options.now().toISOString()),
      );
      initialAuditRecorded = true;
    } catch {
      throw new SafeToolError('AUDIT_FAILURE');
    }

    let grant: AccessGrant;
    try {
      const authorized = await options.service.authorizeAccess(options.access, baseContext);
      grant = validateGrant(authorized, options.access, options.audit);
    } catch (error) {
      if (error instanceof SafeToolError) throw error;
      throw new SafeToolError('AUTHORIZATION_FAILURE');
    }

    if (options.requiredProposalRecordIds !== undefined) {
      requireProposalRecords(grant, options.requiredProposalRecordIds);
    }

    const context: ServiceInvocationContext = { ...baseContext, accessGrant: grant };
    let untrustedOutput: unknown;
    try {
      untrustedOutput = await options.invoke(context);
    } catch {
      throw new SafeToolError('SERVICE_FAILURE');
    }

    const parsed = options.serviceOutputSchema.safeParse(untrustedOutput);
    if (!parsed.success) throw new SafeToolError('OUTPUT_REJECTED');

    const redacted = options.redact(parsed.data, grant);
    const validated = options.finalOutputSchema.safeParse(redacted.value);
    if (!validated.success) throw new SafeToolError('OUTPUT_REJECTED');

    const envelope = envelopeSchema(options.finalOutputSchema).parse({
      ok: true,
      tool: options.toolName,
      audit: {
        invocationId: baseContext.invocationId,
        requestId: options.audit.requestId,
        actor: options.audit.actor,
        riskLevel: options.riskLevel,
        redaction: accessGrantHasAnyPrivateAccess(grant) ? 'authorized_subset' : 'public_only',
        redactedRecordCount: redacted.redactedRecordCount,
      },
      // Zod has validated the final envelope payload immediately above.
      data: validated.data,
    });

    try {
      await options.service.recordAuditEvent(
        toAuditEvent(baseContext, 'succeeded', options.now().toISOString(), {
          redactedRecordCount: redacted.redactedRecordCount,
        }),
      );
    } catch {
      throw new SafeToolError('AUDIT_FAILURE');
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(envelope) }],
      structuredContent: envelope,
    };
  } catch (error) {
    const safeError = error instanceof SafeToolError ? error : new SafeToolError('OUTPUT_REJECTED');
    if (initialAuditRecorded) {
      try {
        await options.service.recordAuditEvent(
          toAuditEvent(baseContext, 'failed', options.now().toISOString(), {
            errorCode: safeError.code,
          }),
        );
      } catch {
        // Fail closed. Audit transport errors must never expose the original error or allow the action.
      }
    }
    return errorResult(safeError.code);
  }
}

function identityRedaction<T>(value: T): Redacted<T> {
  return { value, redactedRecordCount: 0 };
}

function assertService(service: OutreachrMcpService): void {
  const required = [
    'authorizeAccess',
    'recordAuditEvent',
    'searchInvestors',
    'listInvestors',
    'getInvestor',
    'searchPeople',
    'listPeople',
    'getPerson',
    'getPipeline',
    'getRound',
    'listTasks',
    'listMeetings',
    'listKnowledge',
    'listActivity',
    'proposeTarget',
    'proposeStage',
    'proposeTask',
    'proposeMeeting',
    'proposeKnowledge',
    'proposeDraft',
    'proposeSourceReview',
  ] as const;
  const candidate = service as unknown as Record<string, unknown>;
  if (required.some((method) => typeof candidate[method] !== 'function')) {
    throw new TypeError('Outreachr MCP requires a complete, injected service adapter.');
  }
}

/**
 * Creates the local Outreachr MCP server. It deliberately registers only
 * bounded read tools and pending-proposal tools.
 */
export function createOutreachrMcpServer(
  service: OutreachrMcpService,
  options: OutreachrMcpServerOptions = {},
): McpServer {
  assertService(service);
  const now = options.now ?? (() => new Date());
  const createInvocationId = options.createInvocationId ?? randomUUID;
  const server = new McpServer(
    { name: options.name ?? 'outreachr-local', version: options.version ?? '0.1.2' },
    {
      instructions:
        'Outreachr is local-only. Use read tools for explicitly disclosed context and proposal tools to create founder-reviewable proposals. No tool can send a message, access OAuth credentials, run SQL, read files, or execute a shell. Never describe a proposal as applied.',
      capabilities: { tools: { listChanged: false } },
    },
  );
  const enabledTools = options.enabledTools ? new Set(options.enabledTools) : null;
  if (
    enabledTools &&
    [...enabledTools].some(
      (name) => !OUTREACHR_MCP_TOOL_NAMES.includes(name as OutreachrMcpToolName),
    )
  ) {
    throw new TypeError('Outreachr MCP enabledTools contains an unknown tool.');
  }
  if (enabledTools) {
    const registerTool = server.registerTool.bind(server) as unknown as (
      name: string,
      config: unknown,
      callback: unknown,
    ) => RegisteredTool;
    server.registerTool = ((name: string, config: unknown, callback: unknown) => {
      const registered = registerTool(name, config, callback);
      if (!enabledTools.has(name)) registered.disable();
      return registered;
    }) as typeof server.registerTool;
  }

  const common = {
    service,
    now,
    createInvocationId,
  };

  server.registerTool(
    'outreachr_search_investors',
    {
      title: 'Search investors',
      description:
        'Search bounded, evidence-backed investor records. Private workflow fields are redacted unless the host authorizes the exact disclosed records and fields.',
      inputSchema: investorSearchInputSchema,
      outputSchema: envelopeSchema(investorPageSchema),
      annotations: readAnnotations,
      _meta: toolMetadata('read'),
    },
    async (raw) => {
      const input = investorSearchInputSchema.parse(raw);
      const { audit, access, ...query } = input;
      return invokeTool({
        ...common,
        toolName: 'outreachr_search_investors',
        riskLevel: 'read',
        audit,
        access,
        serviceOutputSchema: investorPageSchema,
        finalOutputSchema: investorPageSchema,
        invoke: (context) => service.searchInvestors(query, context),
        redact: redactInvestorPage,
      });
    },
  );

  server.registerTool(
    'outreachr_list_investors',
    {
      title: 'List investors',
      description: 'List at most 50 investor records with bounded filters and cursor pagination.',
      inputSchema: investorListInputSchema,
      outputSchema: envelopeSchema(investorPageSchema),
      annotations: readAnnotations,
      _meta: toolMetadata('read'),
    },
    async (raw) => {
      const input = investorListInputSchema.parse(raw);
      const { audit, access, ...query } = input;
      return invokeTool({
        ...common,
        toolName: 'outreachr_list_investors',
        riskLevel: 'read',
        audit,
        access,
        serviceOutputSchema: investorPageSchema,
        finalOutputSchema: investorPageSchema,
        invoke: (context) => service.listInvestors(query, context),
        redact: redactInvestorPage,
      });
    },
  );

  server.registerTool(
    'outreachr_get_investor',
    {
      title: 'Get investor',
      description:
        'Get one investor record. Internal workflow and notes remain redacted by default.',
      inputSchema: investorGetInputSchema,
      outputSchema: envelopeSchema(investorRecordSchema),
      annotations: readAnnotations,
      _meta: toolMetadata('read'),
    },
    async (raw) => {
      const input = investorGetInputSchema.parse(raw);
      const { audit, access, ...query } = input;
      return invokeTool({
        ...common,
        toolName: 'outreachr_get_investor',
        riskLevel: 'read',
        audit,
        access,
        serviceOutputSchema: investorRecordSchema,
        finalOutputSchema: investorRecordSchema,
        invoke: (context) => service.getInvestor(query, context),
        redact: (value, grant) => {
          const redacted = redactInvestor(value, grant);
          const changed =
            redacted.fitScore !== value.fitScore ||
            redacted.fitReasons !== value.fitReasons ||
            redacted.target !== value.target ||
            redacted.pipelineStage !== value.pipelineStage ||
            redacted.nextAction !== value.nextAction ||
            redacted.privateNotes !== value.privateNotes;
          return { value: redacted, redactedRecordCount: changed ? 1 : 0 };
        },
      });
    },
  );

  server.registerTool(
    'outreachr_search_people',
    {
      title: 'Search investor people',
      description:
        'Search investor people. Contact details and private relationship state are redacted unless explicitly authorized by the host.',
      inputSchema: personSearchInputSchema,
      outputSchema: envelopeSchema(personPageSchema),
      annotations: readAnnotations,
      _meta: toolMetadata('read'),
    },
    async (raw) => {
      const input = personSearchInputSchema.parse(raw);
      const { audit, access, ...query } = input;
      return invokeTool({
        ...common,
        toolName: 'outreachr_search_people',
        riskLevel: 'read',
        audit,
        access,
        serviceOutputSchema: personPageSchema,
        finalOutputSchema: personPageSchema,
        invoke: (context) => service.searchPeople(query, context),
        redact: redactPersonPage,
      });
    },
  );

  server.registerTool(
    'outreachr_list_people',
    {
      title: 'List investor people',
      description: 'List at most 50 investor people with bounded filters and cursor pagination.',
      inputSchema: personListInputSchema,
      outputSchema: envelopeSchema(personPageSchema),
      annotations: readAnnotations,
      _meta: toolMetadata('read'),
    },
    async (raw) => {
      const input = personListInputSchema.parse(raw);
      const { audit, access, ...query } = input;
      return invokeTool({
        ...common,
        toolName: 'outreachr_list_people',
        riskLevel: 'read',
        audit,
        access,
        serviceOutputSchema: personPageSchema,
        finalOutputSchema: personPageSchema,
        invoke: (context) => service.listPeople(query, context),
        redact: redactPersonPage,
      });
    },
  );

  server.registerTool(
    'outreachr_get_person',
    {
      title: 'Get investor person',
      description:
        'Get one investor person. Contact and relationship fields are redacted by default.',
      inputSchema: personGetInputSchema,
      outputSchema: envelopeSchema(personRecordSchema),
      annotations: readAnnotations,
      _meta: toolMetadata('read'),
    },
    async (raw) => {
      const input = personGetInputSchema.parse(raw);
      const { audit, access, ...query } = input;
      return invokeTool({
        ...common,
        toolName: 'outreachr_get_person',
        riskLevel: 'read',
        audit,
        access,
        serviceOutputSchema: personRecordSchema,
        finalOutputSchema: personRecordSchema,
        invoke: (context) => service.getPerson(query, context),
        redact: (value, grant) => {
          const redacted = redactPerson(value, grant);
          const changed =
            redacted.workEmail !== value.workEmail ||
            redacted.contactConfidence !== value.contactConfidence ||
            redacted.target !== value.target ||
            redacted.contacted !== value.contacted ||
            redacted.replied !== value.replied ||
            redacted.privateNotes !== value.privateNotes;
          return { value: redacted, redactedRecordCount: changed ? 1 : 0 };
        },
      });
    },
  );

  server.registerTool(
    'outreachr_get_pipeline',
    {
      title: 'Get fundraising pipeline',
      description:
        'Read authorized pipeline entries. The default response contains no private pipeline records.',
      inputSchema: pipelineInputSchema,
      outputSchema: envelopeSchema(pipelineResultSchema),
      annotations: readAnnotations,
      _meta: toolMetadata('read'),
    },
    async (raw) => {
      const input = pipelineInputSchema.parse(raw);
      const { audit, access, ...query } = input;
      return invokeTool({
        ...common,
        toolName: 'outreachr_get_pipeline',
        riskLevel: 'read',
        audit,
        access,
        serviceOutputSchema: pipelineResultSchema,
        finalOutputSchema: pipelineResultSchema,
        invoke: (context) => service.getPipeline(query, context),
        redact: redactPipeline,
      });
    },
  );

  server.registerTool(
    'outreachr_get_round',
    {
      title: 'Get fundraising round',
      description:
        'Read the authorized active or selected round. Financials and narrative require separate field grants.',
      inputSchema: roundInputSchema,
      outputSchema: envelopeSchema(roundRecordSchema.nullable()),
      annotations: readAnnotations,
      _meta: toolMetadata('read'),
    },
    async (raw) => {
      const input = roundInputSchema.parse(raw);
      const { audit, access, ...query } = input;
      return invokeTool({
        ...common,
        toolName: 'outreachr_get_round',
        riskLevel: 'read',
        audit,
        access,
        serviceOutputSchema: roundRecordSchema.nullable(),
        finalOutputSchema: roundRecordSchema.nullable(),
        invoke: (context) => service.getRound(query, context),
        redact: redactRound,
      });
    },
  );

  server.registerTool(
    'outreachr_list_tasks',
    {
      title: 'List fundraising tasks',
      description: 'List authorized local tasks. Task notes remain redacted without a notes grant.',
      inputSchema: taskListInputSchema,
      outputSchema: envelopeSchema(taskPageSchema),
      annotations: readAnnotations,
      _meta: toolMetadata('read'),
    },
    async (raw) => {
      const input = taskListInputSchema.parse(raw);
      const { audit, access, ...query } = input;
      return invokeTool({
        ...common,
        toolName: 'outreachr_list_tasks',
        riskLevel: 'read',
        audit,
        access,
        serviceOutputSchema: taskPageSchema,
        finalOutputSchema: taskPageSchema,
        invoke: (context) => service.listTasks(query, context),
        redact: redactTasks,
      });
    },
  );

  server.registerTool(
    'outreachr_list_meetings',
    {
      title: 'List fundraising meetings',
      description:
        'List authorized local meetings. Attendees, agenda, and notes are independently gated.',
      inputSchema: meetingListInputSchema,
      outputSchema: envelopeSchema(meetingPageSchema),
      annotations: readAnnotations,
      _meta: toolMetadata('read'),
    },
    async (raw) => {
      const input = meetingListInputSchema.parse(raw);
      const { audit, access, ...query } = input;
      return invokeTool({
        ...common,
        toolName: 'outreachr_list_meetings',
        riskLevel: 'read',
        audit,
        access,
        serviceOutputSchema: meetingPageSchema,
        finalOutputSchema: meetingPageSchema,
        invoke: (context) => service.listMeetings(query, context),
        redact: redactMeetings,
      });
    },
  );

  server.registerTool(
    'outreachr_list_knowledge',
    {
      title: 'List fundraising knowledge',
      description:
        'List authorized knowledge records. Content is omitted unless separately authorized.',
      inputSchema: knowledgeListInputSchema,
      outputSchema: envelopeSchema(knowledgePageSchema),
      annotations: readAnnotations,
      _meta: toolMetadata('read'),
    },
    async (raw) => {
      const input = knowledgeListInputSchema.parse(raw);
      const { audit, access, ...query } = input;
      return invokeTool({
        ...common,
        toolName: 'outreachr_list_knowledge',
        riskLevel: 'read',
        audit,
        access,
        serviceOutputSchema: knowledgePageSchema,
        finalOutputSchema: knowledgePageSchema,
        invoke: (context) => service.listKnowledge(query, context),
        redact: redactKnowledge,
      });
    },
  );

  server.registerTool(
    'outreachr_list_activity',
    {
      title: 'List fundraising activity',
      description:
        'List authorized activity records. Activity detail is omitted unless separately authorized.',
      inputSchema: activityListInputSchema,
      outputSchema: envelopeSchema(activityPageSchema),
      annotations: readAnnotations,
      _meta: toolMetadata('read'),
    },
    async (raw) => {
      const input = activityListInputSchema.parse(raw);
      const { audit, access, ...query } = input;
      return invokeTool({
        ...common,
        toolName: 'outreachr_list_activity',
        riskLevel: 'read',
        audit,
        access,
        serviceOutputSchema: activityPageSchema,
        finalOutputSchema: activityPageSchema,
        invoke: (context) => service.listActivity(query, context),
        redact: redactActivity,
      });
    },
  );

  const proposalOutput = envelopeSchema(proposalResultSchema);

  server.registerTool(
    'outreachr_propose_target',
    {
      title: 'Propose target change',
      description:
        'Create a pending founder-review proposal to add or remove an investor target. Does not apply the change.',
      inputSchema: proposeTargetInputSchema,
      outputSchema: proposalOutput,
      annotations: proposalAnnotations,
      _meta: toolMetadata('proposal'),
    },
    async (raw) => {
      const input = proposeTargetInputSchema.parse(raw);
      const { audit, access, ...proposal } = input;
      return invokeTool({
        ...common,
        toolName: 'outreachr_propose_target',
        riskLevel: 'proposal',
        audit,
        access,
        serviceOutputSchema: proposalResultSchema,
        finalOutputSchema: proposalResultSchema,
        requiredProposalRecordIds: [proposal.investorId],
        invoke: (context) => service.proposeTarget(proposal, context),
        redact: identityRedaction,
      });
    },
  );

  server.registerTool(
    'outreachr_propose_stage',
    {
      title: 'Propose pipeline stage change',
      description:
        'Create a pending founder-review proposal for an investor stage. Does not move the pipeline item.',
      inputSchema: proposeStageInputSchema,
      outputSchema: proposalOutput,
      annotations: proposalAnnotations,
      _meta: toolMetadata('proposal'),
    },
    async (raw) => {
      const input = proposeStageInputSchema.parse(raw);
      const { audit, access, ...proposal } = input;
      return invokeTool({
        ...common,
        toolName: 'outreachr_propose_stage',
        riskLevel: 'proposal',
        audit,
        access,
        serviceOutputSchema: proposalResultSchema,
        finalOutputSchema: proposalResultSchema,
        requiredProposalRecordIds: [proposal.investorId],
        invoke: (context) => service.proposeStage(proposal, context),
        redact: identityRedaction,
      });
    },
  );

  server.registerTool(
    'outreachr_propose_task',
    {
      title: 'Propose task',
      description:
        'Create a pending founder-review task proposal. Does not create a task directly.',
      inputSchema: proposeTaskInputSchema,
      outputSchema: proposalOutput,
      annotations: proposalAnnotations,
      _meta: toolMetadata('proposal'),
    },
    async (raw) => {
      const input = proposeTaskInputSchema.parse(raw);
      const { audit, access, ...proposal } = input;
      return invokeTool({
        ...common,
        toolName: 'outreachr_propose_task',
        riskLevel: 'proposal',
        audit,
        access,
        serviceOutputSchema: proposalResultSchema,
        finalOutputSchema: proposalResultSchema,
        requiredProposalRecordIds: [proposal.investorId, proposal.personId],
        invoke: (context) => service.proposeTask(proposal, context),
        redact: identityRedaction,
      });
    },
  );

  server.registerTool(
    'outreachr_propose_meeting',
    {
      title: 'Propose meeting',
      description:
        'Create a pending founder-review meeting proposal. Does not write to a local or provider calendar.',
      inputSchema: proposeMeetingInputSchema,
      outputSchema: proposalOutput,
      annotations: proposalAnnotations,
      _meta: toolMetadata('proposal'),
    },
    async (raw) => {
      const input = proposeMeetingInputSchema.parse(raw);
      const { audit, access, ...proposal } = input;
      return invokeTool({
        ...common,
        toolName: 'outreachr_propose_meeting',
        riskLevel: 'proposal',
        audit,
        access,
        serviceOutputSchema: proposalResultSchema,
        finalOutputSchema: proposalResultSchema,
        requiredProposalRecordIds: [proposal.investorId, ...proposal.attendeePersonIds],
        invoke: (context) => service.proposeMeeting(proposal, context),
        redact: identityRedaction,
      });
    },
  );

  server.registerTool(
    'outreachr_propose_knowledge',
    {
      title: 'Propose knowledge change',
      description:
        'Create a pending founder-review knowledge proposal. Does not create or edit knowledge directly.',
      inputSchema: proposeKnowledgeInputSchema,
      outputSchema: proposalOutput,
      annotations: proposalAnnotations,
      _meta: toolMetadata('proposal'),
    },
    async (raw) => {
      const input = proposeKnowledgeInputSchema.parse(raw);
      const { audit, access, ...proposal } = input;
      return invokeTool({
        ...common,
        toolName: 'outreachr_propose_knowledge',
        riskLevel: 'proposal',
        audit,
        access,
        serviceOutputSchema: proposalResultSchema,
        finalOutputSchema: proposalResultSchema,
        requiredProposalRecordIds: [proposal.id],
        invoke: (context) => service.proposeKnowledge(proposal, context),
        redact: identityRedaction,
      });
    },
  );

  server.registerTool(
    'outreachr_propose_draft',
    {
      title: 'Propose outreach draft',
      description:
        'Create a pending founder-review message draft proposal. This tool cannot approve, send, queue, or retry a message.',
      inputSchema: proposeDraftInputSchema,
      outputSchema: proposalOutput,
      annotations: proposalAnnotations,
      _meta: toolMetadata('proposal'),
    },
    async (raw) => {
      const input = proposeDraftInputSchema.parse(raw);
      const { audit, access, ...proposal } = input;
      return invokeTool({
        ...common,
        toolName: 'outreachr_propose_draft',
        riskLevel: 'proposal',
        audit,
        access,
        serviceOutputSchema: proposalResultSchema,
        finalOutputSchema: proposalResultSchema,
        requiredProposalRecordIds: [proposal.personId],
        invoke: (context) => service.proposeDraft(proposal, context),
        redact: identityRedaction,
      });
    },
  );

  server.registerTool(
    'outreachr_propose_source_review',
    {
      title: 'Propose source-review decision',
      description:
        'Create a pending founder-review source decision proposal. Does not accept or reject source data directly.',
      inputSchema: proposeSourceReviewInputSchema,
      outputSchema: proposalOutput,
      annotations: proposalAnnotations,
      _meta: toolMetadata('proposal'),
    },
    async (raw) => {
      const input = proposeSourceReviewInputSchema.parse(raw);
      const { audit, access, ...proposal } = input;
      return invokeTool({
        ...common,
        toolName: 'outreachr_propose_source_review',
        riskLevel: 'proposal',
        audit,
        access,
        serviceOutputSchema: proposalResultSchema,
        finalOutputSchema: proposalResultSchema,
        requiredProposalRecordIds: [proposal.reviewId],
        invoke: (context) => service.proposeSourceReview(proposal, context),
        redact: identityRedaction,
      });
    },
  );

  return server;
}
