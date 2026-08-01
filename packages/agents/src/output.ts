import { AgentRuntimeError } from './errors.js';
import { proposalCapability, requireCapability } from './policy.js';
import type {
  AgentProvider,
  AgentProposal,
  AgentResult,
  DurableAgentAllowlist,
  ProposalKind,
} from './types.js';

const PROPOSAL_KINDS = new Set<ProposalKind>([
  'draft',
  'task',
  'pipeline_move',
  'note',
  'research',
]);
const FORBIDDEN_KEY_TOKENS = new Set([
  'send',
  'sent',
  'schedule',
  'scheduled',
  'deliver',
  'dispatch',
  'publish',
  'delete',
  'execute',
]);
const FORBIDDEN_ACTION_VALUES = new Set([
  'send',
  'send_email',
  'send_message',
  'deliver',
  'dispatch',
  'schedule',
  'schedule_email',
  'publish',
  'delete',
  'execute',
]);

export const AGENT_RESULT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'proposals'],
  properties: {
    summary: { type: 'string', minLength: 1, maxLength: 8_000 },
    proposals: {
      type: 'array',
      maxItems: 100,
      items: {
        anyOf: [
          proposalSchema('draft', {
            personId: { type: 'string', minLength: 1, maxLength: 300 },
            provider: { type: 'string', enum: ['google', 'microsoft'] },
            subject: { type: 'string', minLength: 1, maxLength: 998 },
            bodyText: { type: 'string', minLength: 1, maxLength: 500_000 },
          }),
          proposalSchema('task', {
            title: { type: 'string', minLength: 1, maxLength: 2_000 },
            notes: { type: ['string', 'null'], maxLength: 50_000 },
            dueAt: { type: ['string', 'null'] },
            investorId: { type: ['string', 'null'], maxLength: 300 },
            personId: { type: ['string', 'null'], maxLength: 300 },
          }),
          proposalSchema('pipeline_move', {
            investorId: { type: 'string', minLength: 1, maxLength: 300 },
            stage: {
              type: 'string',
              enum: [
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
              ],
            },
          }),
          proposalSchema('note', {}),
          proposalSchema('research', {}),
        ],
      },
    },
  },
} as const;

function proposalSchema(kind: ProposalKind, payloadProperties: Record<string, object>) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'kind', 'title', 'rationale', 'investorId', 'payload'],
    properties: {
      id: { type: 'string', minLength: 1, maxLength: 200 },
      kind: { type: 'string', const: kind },
      title: { type: 'string', minLength: 1, maxLength: 500 },
      rationale: { type: 'string', minLength: 1, maxLength: 4_000 },
      investorId: { type: ['string', 'null'], minLength: 1, maxLength: 200 },
      payload: {
        type: 'object',
        additionalProperties: false,
        required: Object.keys(payloadProperties),
        properties: payloadProperties,
      },
    },
  } as const;
}

export function parseAgentResult(
  input: unknown,
  allowlist: DurableAgentAllowlist,
  provider: AgentProvider,
): AgentResult {
  const candidate = typeof input === 'string' ? parseJsonText(input) : input;
  if (!isRecord(candidate) || typeof candidate.summary !== 'string' || !candidate.summary.trim()) {
    throw new AgentRuntimeError('INVALID_OUTPUT', 'Agent output must contain a non-empty summary.');
  }
  if (candidate.summary.length > 8_000) {
    throw new AgentRuntimeError(
      'INVALID_OUTPUT',
      'Agent output summary is longer than 8,000 characters.',
    );
  }
  assertOnlyKeys(candidate, new Set(['summary', 'proposals']), 'result');
  if (!Array.isArray(candidate.proposals) || candidate.proposals.length > 100) {
    throw new AgentRuntimeError(
      'INVALID_OUTPUT',
      'Agent output must contain at most 100 proposals.',
    );
  }
  const ids = new Set<string>();
  const proposals = candidate.proposals.map((value, index) =>
    parseProposal(value, index, ids, allowlist, provider),
  );
  return { summary: candidate.summary.trim(), proposals };
}

function parseProposal(
  input: unknown,
  index: number,
  ids: Set<string>,
  allowlist: DurableAgentAllowlist,
  provider: AgentProvider,
): AgentProposal {
  if (!isRecord(input)) throw invalid(index, 'must be an object');
  assertOnlyKeys(
    input,
    new Set(['id', 'kind', 'title', 'rationale', 'investorId', 'payload']),
    `proposal ${index + 1}`,
  );
  if (typeof input.kind !== 'string' || !PROPOSAL_KINDS.has(input.kind as ProposalKind)) {
    throw invalid(index, 'has an unsupported kind');
  }
  const kind = input.kind as ProposalKind;
  const id = requiredString(input.id, index, 'id', 200);
  if (ids.has(id)) throw invalid(index, 'has a duplicate id');
  ids.add(id);
  const investorId = optionalString(input.investorId, index, 'investorId', 200);
  requireCapability(
    allowlist,
    provider,
    proposalCapability(kind),
    investorId ? { investorId } : undefined,
  );
  if (!isRecord(input.payload)) throw invalid(index, 'payload must be an object');
  assertProposalOnly(input.payload, 'payload');
  return {
    id,
    kind,
    title: requiredString(input.title, index, 'title', 500),
    rationale: requiredString(input.rationale, index, 'rationale', 4_000),
    ...(investorId ? { investorId } : {}),
    payload: structuredClone(input.payload),
    executable: false,
  };
}

function assertProposalOnly(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertProposalOnly(entry, `${path}[${index}]`));
    return;
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new AgentRuntimeError('INVALID_OUTPUT', `${path} contains a non-finite number.`);
    return;
  }
  if (!isRecord(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new AgentRuntimeError(
      'INVALID_OUTPUT',
      `${path} must contain only JSON-compatible values.`,
    );
  }
  for (const [key, entry] of Object.entries(value)) {
    const keyTokens = key
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      .toLowerCase()
      .split(/[^a-z0-9]+/u)
      .filter(Boolean);
    if (
      keyTokens.some((token) => FORBIDDEN_KEY_TOKENS.has(token)) ||
      keyTokens.join('_') === 'message_id' ||
      keyTokens.join('_') === 'provider_message_id'
    ) {
      throw new AgentRuntimeError(
        'POLICY_DENIED',
        `Executable field is forbidden in agent output: ${path}.${key}`,
      );
    }
    if (typeof entry === 'string' && (key === 'action' || key === 'operation')) {
      if (FORBIDDEN_ACTION_VALUES.has(entry.toLowerCase())) {
        throw new AgentRuntimeError(
          'POLICY_DENIED',
          `Executable action is forbidden in agent output: ${entry}`,
        );
      }
    }
    assertProposalOnly(entry, `${path}.${key}`);
  }
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
): void {
  const unexpected = Object.keys(value).find((key) => !allowed.has(key));
  if (unexpected) {
    throw new AgentRuntimeError('INVALID_OUTPUT', `Unexpected field in ${path}: ${unexpected}`);
  }
}

function parseJsonText(text: string): unknown {
  const trimmed = text.trim();
  const json = unwrapJsonFence(trimmed);
  try {
    return JSON.parse(json) as unknown;
  } catch (error) {
    throw new AgentRuntimeError('INVALID_OUTPUT', 'Agent output was not valid JSON.', error);
  }
}

function unwrapJsonFence(value: string): string {
  if (!value.startsWith('```') || !value.endsWith('```') || value.length < 6) return value;
  let start = 3;
  const language = value.slice(start, start + 4);
  if (language.toLocaleLowerCase('en-US') === 'json') start += 4;
  else if (start < value.length - 3 && !value[start]?.trim()) {
    // A fence with no language starts directly with whitespace/newline.
  } else {
    return value;
  }
  let end = value.length - 3;
  while (start < end && !value[start]?.trim()) start += 1;
  while (end > start && !value[end - 1]?.trim()) end -= 1;
  return value.slice(start, end);
}

function requiredString(value: unknown, index: number, name: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw invalid(index, `${name} must be a non-empty string no longer than ${max} characters`);
  }
  return value.trim();
}

function optionalString(
  value: unknown,
  index: number,
  name: string,
  max: number,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requiredString(value, index, name, max);
}

function invalid(index: number, detail: string): AgentRuntimeError {
  return new AgentRuntimeError('INVALID_OUTPUT', `Proposal ${index + 1} ${detail}.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
