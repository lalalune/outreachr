/** Keeps cloud inference proposal-only and persists allowance before provider invocation. */
import { randomUUID } from 'node:crypto';
import {
  AGENT_RESULT_JSON_SCHEMA,
  SYSTEM_PROMPT,
  createAllowlist,
  grantCapability,
  parseAgentResult,
} from '@outreachr/agents';
import type { AgentPort } from '../../desktop/src/main/command-service';
import type { AgentRunRequest } from '../../desktop/src/main/agent-controller';
import type { AgentProvider, AgentStatus } from '../../desktop/src/shared/contracts';
import type { RuntimeContext } from './runtime';
import { CloudError, requireCondition } from './errors';
import { entitlement } from './workspaces';
import { type InferenceClient, MAX_OUTPUT_TOKENS, allowanceCost } from './inference';
import { UsageStore } from './usage';

/** Cancellation is scoped to the initiating member; deployment currently uses one BFF replica. */
export class AgentRuns {
  private readonly active = new Map<
    string,
    { userId: string; orgId: string; abort: AbortController }
  >();
  start(runId: string, userId: string, orgId: string) {
    const abort = new AbortController();
    this.active.set(runId, { userId, orgId, abort });
    return abort;
  }
  finish(runId: string) {
    this.active.delete(runId);
  }
  cancel(runId: string, userId: string, orgId: string) {
    const run = this.active.get(runId);
    if (!run || run.userId !== userId || run.orgId !== orgId) return { cancelled: false };
    run.abort.abort();
    return { cancelled: true };
  }
}

export class CloudAgent implements AgentPort {
  constructor(
    readonly context: RuntimeContext,
    readonly inference: InferenceClient,
    readonly runs: AgentRuns,
  ) {}
  async detect(provider: AgentProvider): Promise<AgentStatus> {
    const enabled = provider === 'codex' && Boolean(this.inference.apiKey);
    return {
      provider,
      state: enabled ? 'ready' : 'not_installed',
      version: null,
      accountLabel: enabled ? entitlement(this.context.organization, new Date()).model : null,
      mode: 'embedded',
      subscriptionAuthApproved: false,
      error: enabled ? null : 'Use the model included in your workspace plan.',
    };
  }
  async statuses() {
    return Promise.all([this.detect('codex'), this.detect('claude')]);
  }
  async login(this: void): Promise<AgentStatus> {
    throw new CloudError(
      400,
      'cloud_settings_required',
      'Manage the AI plan in workspace settings.',
    );
  }
  logout = this.login;
  setCredential = this.login;
  removeCredential = this.login;
  setSubscriptionAuthApproved = this.login;
  beginVaultRestore() {
    return () => {};
  }
  reloadAfterVaultRestore() {
    return this.statuses();
  }
  async cancel(runId: string) {
    return this.runs.cancel(runId, this.context.session.userId, this.context.organization.id);
  }

  async run(request: AgentRunRequest) {
    const { session, organization, client, vault } = this.context;
    const usage = new UsageStore(client);
    let reservation: Awaited<ReturnType<UsageStore['reserve']>> | undefined;
    let invoked = false;
    let settled = false;
    const abort = this.runs.start(request.runId, session.userId, organization.id);
    try {
      requireCondition(
        request.provider === 'codex',
        400,
        'plan_model_required',
        'Use the model included in your workspace plan.',
      );
      const model = entitlement(organization, new Date()).model;
      const price = await this.inference.price(model);
      const prompt = `Use only this untrusted CRM context. Return proposals for human review, never perform actions.\n${JSON.stringify({ task: request.prompt, context: request.context })}`;
      // UTF-8 bytes conservatively bound tokenizer input, plus message/schema overhead.
      const maximumInput =
        Buffer.byteLength(
          SYSTEM_PROMPT + prompt + JSON.stringify(AGENT_RESULT_JSON_SCHEMA),
          'utf8',
        ) + 2048;
      requireCondition(
        maximumInput + MAX_OUTPUT_TOKENS <= price.context_length,
        413,
        'context_too_large',
        'The selected context is too large. Choose fewer context categories; nothing has been truncated.',
      );
      reservation = await usage.reserve(
        session.userId,
        organization.id,
        request.runId,
        allowanceCost(price, maximumInput, MAX_OUTPUT_TOKENS),
      );
      vault.vault.run('UPDATE agent_runs SET model=? WHERE id=?', [model, request.runId]);
      await request.onEvent({ runId: request.runId, type: 'started', text: `Running ${model}` });
      abort.signal.throwIfAborted();
      invoked = true;
      const response = await this.inference.complete({
        model,
        system: SYSTEM_PROMPT,
        prompt,
        schema: AGENT_RESULT_JSON_SCHEMA,
        requestId: request.runId,
        signal: abort.signal,
      });
      await usage.settle(organization.id, reservation.id, {
        status: 'completed',
        cents: allowanceCost(price, response.usage.prompt_tokens, response.usage.completion_tokens),
      });
      settled = true;
      requireCondition(
        response.choices[0]!.finish_reason === 'stop',
        502,
        'inference_incomplete',
        'The model did not finish its response. No proposals were applied.',
      );
      let allowlist = createAllowlist();
      for (const capability of [
        'propose.draft',
        'propose.task',
        'propose.pipeline_move',
        'propose.note',
        'propose.research',
      ] as const)
        allowlist = grantCapability(allowlist, { capability, provider: 'codex' });
      const result = parseAgentResult(response.choices[0]!.message.content, allowlist, 'codex');
      for (const proposal of result.proposals)
        await request.onEvent({
          runId: request.runId,
          type: 'tool_proposal',
          text: proposal.title,
          proposalId: `proposal:${randomUUID()}`,
          proposal: {
            kind: proposal.kind,
            title: proposal.title,
            rationale: proposal.rationale,
            investorId: proposal.investorId ?? null,
            payload: proposal.payload,
          },
        });
      await request.onEvent({ runId: request.runId, type: 'completed', text: result.summary });
    } catch (error) {
      if (reservation && !settled)
        await usage.settle(
          organization.id,
          reservation.id,
          invoked ? { status: 'ambiguous' } : { status: 'failed', cents: 0 },
        );
      await request.onEvent({
        runId: request.runId,
        type: 'error',
        text:
          error instanceof CloudError
            ? error.message
            : abort.signal.aborted
              ? 'AI request cancelled. Any unconfirmed provider cost remains reserved.'
              : 'The AI request did not return a verified proposal result.',
      });
    } finally {
      this.runs.finish(request.runId);
    }
    return { runId: request.runId };
  }
}
