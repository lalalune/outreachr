import type { AgentEvent, AgentProvider, AgentStatus } from '../shared/contracts';

export interface AgentRunRequest {
  runId: string;
  provider: AgentProvider;
  prompt: string;
  context: Record<string, unknown>;
  disclosedContextIds: string[];
  onEvent: (event: AgentEvent) => void | Promise<void>;
}

export interface AgentRuntimeController {
  statuses(): Promise<AgentStatus[]>;
  detect(provider: AgentProvider): Promise<AgentStatus>;
  login(provider: AgentProvider): Promise<AgentStatus>;
  logout(provider: AgentProvider): Promise<AgentStatus>;
  setCredential(provider: 'claude', credential: string): Promise<AgentStatus>;
  removeCredential(provider: 'claude'): Promise<AgentStatus>;
  setSubscriptionAuthApproved(provider: 'claude', approved: boolean): Promise<AgentStatus>;
  /**
   * Acquire a synchronous lease before the first asynchronous restore step.
   * The returned idempotent callback releases it after vault rehydration.
   */
  beginVaultRestore(): () => void;
  /** Reload device-local approval and encrypted credentials from the replacement vault. */
  reloadAfterVaultRestore(): Promise<AgentStatus[]>;
  run(request: AgentRunRequest): Promise<{ runId: string }>;
  cancel(runId: string): Promise<{ cancelled: boolean }>;
  dispose(): Promise<void>;
}
