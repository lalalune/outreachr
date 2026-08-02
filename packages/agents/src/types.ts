export const AGENT_PROVIDERS = ['codex', 'claude'] as const;
export type AgentProvider = (typeof AGENT_PROVIDERS)[number];

/**
 * The complete authority surface available to an agent. There is intentionally
 * no send, delete, publish, external-write, or connector-management authority.
 */
export const AGENT_CAPABILITIES = [
  'read.round',
  'read.investors',
  'read.pipeline',
  'read.interactions',
  'read.meetings',
  'read.tasks',
  'read.knowledge',
  'read.drafts',
  'propose.draft',
  'propose.task',
  'propose.pipeline_move',
  'propose.note',
  'propose.research',
] as const;
export type AgentCapability = (typeof AGENT_CAPABILITIES)[number];

export type ReadCapability = Extract<AgentCapability, `read.${string}`>;
export type ProposalCapability = Extract<AgentCapability, `propose.${string}`>;

export interface AgentGrantScope {
  /** Empty or omitted means any record in the local founder workspace. */
  readonly roundIds?: readonly string[];
  readonly investorIds?: readonly string[];
}

export interface AgentGrant {
  readonly id: string;
  readonly capability: AgentCapability;
  readonly provider: AgentProvider | 'all';
  readonly scope?: AgentGrantScope;
  readonly createdAt: string;
  readonly createdBy: 'founder';
  readonly revokedAt?: string;
  readonly revokedBy?: 'founder';
  readonly revokeReason?: string;
}

/**
 * Persist this object in the local SQLite vault. Revocation appends state to a
 * grant instead of deleting it, so authority remains auditable and portable.
 */
export interface DurableAgentAllowlist {
  readonly version: 1;
  readonly revision: number;
  readonly updatedAt: string;
  readonly grants: readonly AgentGrant[];
}

export interface AgentContextRecord {
  readonly id: string;
  readonly capability: ReadCapability;
  readonly roundId?: string;
  readonly investorId?: string;
  /** JSON-compatible, already-redacted local CRM data. It is treated as untrusted text. */
  readonly data: unknown;
}

export type ProposalKind = 'draft' | 'task' | 'pipeline_move' | 'note' | 'research';

export interface AgentProposal {
  readonly id: string;
  readonly kind: ProposalKind;
  readonly title: string;
  readonly rationale: string;
  readonly investorId?: string;
  readonly payload: Readonly<Record<string, unknown>>;
  /** Always false: a separate founder approval path applies proposals. */
  readonly executable: false;
}

export interface AgentResult {
  readonly summary: string;
  readonly proposals: readonly AgentProposal[];
}

/**
 * The only MCP tools an embedded provider may discover or invoke. The MCP
 * server has additional proposal methods for other trusted hosts, but the
 * desktop agent runtime deliberately enables only proposal kinds its current
 * founder-review UI can apply without changing semantics.
 */
export const OUTREACHR_AGENT_MCP_READ_TOOLS = [
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
] as const;

export const OUTREACHR_AGENT_MCP_PROPOSAL_TOOLS = [
  'outreachr_propose_stage',
  'outreachr_propose_task',
  'outreachr_propose_draft',
] as const;

export const OUTREACHR_AGENT_MCP_TOOLS = [
  ...OUTREACHR_AGENT_MCP_READ_TOOLS,
  ...OUTREACHR_AGENT_MCP_PROPOSAL_TOOLS,
] as const;

export type OutreachrAgentMcpToolName = (typeof OUTREACHR_AGENT_MCP_TOOLS)[number];

/** A short-lived, loopback-only MCP connection created by the desktop host. */
export interface AgentMcpConnection {
  readonly serverName: 'outreachr';
  readonly url: string;
  readonly bearerToken: string;
  readonly sessionId: string;
  readonly auditPurpose: string;
  readonly enabledTools: readonly OutreachrAgentMcpToolName[];
}

export interface AgentRunRequest {
  readonly provider: AgentProvider;
  readonly intent: string;
  readonly allowlist: DurableAgentAllowlist;
  readonly context: readonly AgentContextRecord[];
  /** Omitted for hosts that intentionally run the legacy context-only mode. */
  readonly mcp?: AgentMcpConnection;
  /** Maximum run time; the runtime clamps this to a safe range. */
  readonly timeoutMs?: number;
  readonly model?: string;
  readonly maxTurns?: number;
}

export type AgentAuthSource =
  'chatgpt' | 'openai-api-key' | 'claude-code' | 'anthropic-api-key' | 'none' | 'unknown';

export interface ProviderDetection {
  readonly provider: AgentProvider;
  readonly installed: boolean;
  readonly executable?: string;
  readonly version?: string;
  readonly authenticated: boolean;
  readonly authSource: AgentAuthSource;
  readonly accountLabel?: string;
  readonly plan?: string;
  readonly detail?: string;
  /**
   * Claude only: true when the founder has explicitly enabled an
   * Anthropic-approved third-party subscription-authentication path.
   */
  readonly subscriptionAuthApproved?: boolean;
}

export type LoginMode = 'browser' | 'device-code' | 'official-cli' | 'setup-token' | 'api-key';

export interface LoginRequest {
  readonly provider: AgentProvider;
  readonly mode: LoginMode;
}

export interface LoginChallenge {
  readonly provider: AgentProvider;
  readonly kind: 'browser' | 'device-code' | 'external-command' | 'environment';
  readonly loginId?: string;
  readonly url?: string;
  readonly userCode?: string;
  readonly command?: string;
  readonly environmentVariable?: string;
  readonly instructions: string;
}

export type AgentEvent =
  | {
      readonly type: 'run.started';
      readonly runId: string;
      readonly provider: AgentProvider;
      readonly at: string;
    }
  | {
      readonly type: 'run.output_delta';
      readonly runId: string;
      readonly text: string;
      readonly at: string;
    }
  | {
      readonly type: 'run.proposal';
      readonly runId: string;
      readonly proposal: AgentProposal;
      readonly at: string;
    }
  | {
      readonly type: 'run.completed';
      readonly runId: string;
      readonly result: AgentResult;
      readonly at: string;
    }
  | { readonly type: 'run.cancelled'; readonly runId: string; readonly at: string }
  | {
      readonly type: 'run.failed';
      readonly runId: string;
      readonly code: string;
      readonly message: string;
      readonly at: string;
    }
  | {
      readonly type: 'auth.challenge';
      readonly provider: AgentProvider;
      readonly challenge: LoginChallenge;
      readonly at: string;
    }
  | {
      readonly type: 'auth.changed';
      readonly provider: AgentProvider;
      readonly authenticated: boolean;
      readonly at: string;
    };

export type AgentEventListener = (event: AgentEvent) => void;

export interface AgentRunHandle {
  readonly id: string;
  readonly provider: AgentProvider;
  readonly result: Promise<AgentResult>;
}

export interface AgentProviderAdapter {
  readonly provider: AgentProvider;
  detect(): Promise<ProviderDetection>;
  status(): Promise<ProviderDetection>;
  login(request: LoginRequest): Promise<LoginChallenge>;
  logout(): Promise<void>;
  run(runId: string, request: AgentRunRequest, emit: AgentEventListener): Promise<AgentResult>;
  cancel(runId: string): Promise<boolean>;
  dispose(): Promise<void>;
}

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  next(prefix: string): string;
}
