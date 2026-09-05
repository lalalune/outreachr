import { useEffect, useMemo, useState } from 'react';
import {
  Bot,
  Check,
  ChevronRight,
  CircleStop,
  Command,
  Send,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
} from 'lucide-react';
import type { AgentEvent, AgentProvider } from '../../../shared/contracts';
import {
  Badge,
  Button,
  EmptyState,
  PageHeader,
  Section,
  StateDot,
  titleCase,
} from '../components/ui';
import { useWorkspace } from '../state/WorkspaceContext';

export function AgentPage({ cloudModel }: { cloudModel?: string } = {}): React.JSX.Element {
  const { data, command, notify, refresh } = useWorkspace();
  const [provider, setProvider] = useState<AgentProvider>('codex');
  const [prompt, setPrompt] = useState(
    'Find five high-fit investors I have not contacted and explain each recommendation with the available local evidence.',
  );
  const [disclosure, setDisclosure] = useState<string[]>(['round', 'company', 'investors']);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [runId, setRunId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [updatingGrant, setUpdatingGrant] = useState<string | null>(null);
  const [selectedProposalId, setSelectedProposalId] = useState<string | null>(null);
  const [reviewingProposalId, setReviewingProposalId] = useState<string | null>(null);

  useEffect(
    () =>
      window.outreachr.onAgentEvent((event) => {
        setEvents((current) => [...current, event]);
        if (event.type === 'tool_proposal') void refresh();
        if (event.type === 'completed' || event.type === 'error') {
          setRunId(null);
          if (cloudModel) void refresh();
        }
      }),
    [refresh, cloudModel],
  );

  const currentStatus = data?.agents.find((item) => item.provider === provider);
  const durableGrants = useMemo(
    () =>
      (data?.agentContextGrants ?? [])
        .filter((grant) => grant.provider === provider)
        .map((grant) => grant.contextClass),
    [data?.agentContextGrants, provider],
  );
  const contextOptions = useMemo(
    () => [
      {
        id: 'round',
        label: 'Round strategy',
        detail: 'Stage, target, checks, sectors, timing, exclusions',
      },
      {
        id: 'company',
        label: 'Company knowledge',
        detail: 'Narrative, product, team, approved metrics',
      },
      {
        id: 'investors',
        label: 'Investor graph',
        detail: 'Public profiles, sources, fit, portfolio evidence',
      },
      {
        id: 'activity',
        label: 'Private activity',
        detail: 'Emails, meetings, notes, outcomes in this run only',
      },
    ],
    [],
  );

  useEffect(() => {
    setDisclosure(durableGrants.length ? durableGrants : ['round', 'company', 'investors']);
  }, [durableGrants]);

  useEffect(() => {
    if (!data?.agentProposals.length) {
      setSelectedProposalId(null);
      return;
    }
    if (!data.agentProposals.some((proposal) => proposal.id === selectedProposalId)) {
      setSelectedProposalId(data.agentProposals[0]!.id);
    }
  }, [data?.agentProposals, selectedProposalId]);

  if (!data) return <></>;

  const selectedProposal =
    data.agentProposals.find((proposal) => proposal.id === selectedProposalId) ?? null;

  const toggleContext = (id: string): void =>
    setDisclosure((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    );

  const toggleGrant = async (
    contextClass: 'round' | 'company' | 'investors' | 'activity',
  ): Promise<void> => {
    const granted = !durableGrants.includes(contextClass);
    setUpdatingGrant(contextClass);
    try {
      await command('agent.contextGrant.set', { provider, contextClass, granted });
      notify({
        tone: 'success',
        title: granted ? 'Durable context default saved' : 'Durable context default revoked',
        detail: `${titleCase(contextClass)} · ${titleCase(provider)}`,
      });
    } finally {
      setUpdatingGrant(null);
    }
  };

  const run = async (): Promise<void> => {
    setStarting(true);
    setEvents([]);
    try {
      const result = await command('agent.run', {
        provider,
        prompt,
        disclosedContextIds: disclosure,
      });
      setRunId(result.runId);
      notify({
        tone: 'info',
        title: `${titleCase(provider)} started`,
        detail: 'External actions remain proposals until you approve them.',
      });
    } finally {
      setStarting(false);
    }
  };

  const cancel = async (): Promise<void> => {
    if (!runId) return;
    await command('agent.cancel', { runId });
    setRunId(null);
  };

  const openProposal = async (proposalId: string): Promise<void> => {
    await refresh();
    setSelectedProposalId(proposalId);
  };

  const reviewProposal = async (
    decision: 'apply' | 'reject' | 'convert_to_task',
  ): Promise<void> => {
    if (!selectedProposal) return;
    setReviewingProposalId(selectedProposal.id);
    try {
      const result = await command('agent.proposal.review', {
        id: selectedProposal.id,
        decision,
      });
      notify({
        tone: decision === 'reject' ? 'info' : 'success',
        title: decision === 'reject' ? 'Proposal rejected' : 'Proposal applied locally',
        detail:
          result.operation === 'converted_to_task'
            ? 'The proposal became an open task. No external action was taken.'
            : result.operation === 'applied'
              ? `${titleCase(result.appliedEntityType ?? 'record')} created or updated. No external action was taken.`
              : 'The proposal was closed without changing local records.',
      });
    } finally {
      setReviewingProposalId(null);
    }
  };

  return (
    <div className="page agent-page">
      <PageHeader
        title="Agent"
        description={
          cloudModel
            ? `Research and prepare work with ${cloudModel}. Review proposals before applying changes.`
            : 'Research and prepare work with your installed Codex or Claude agent. Outreachr remains the authority for data and sends.'
        }
      />

      <div className="agent-provider-switcher" role="radiogroup" aria-label="Agent provider">
        {data.agents
          .filter((agent) => !cloudModel || agent.provider === 'codex')
          .map((agent) => (
            <button
              id={`agent-provider-${agent.provider}`}
              role="radio"
              aria-checked={provider === agent.provider}
              tabIndex={provider === agent.provider ? 0 : -1}
              key={agent.provider}
              onClick={() => setProvider(agent.provider)}
              onKeyDown={(event) => {
                if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key))
                  return;
                event.preventDefault();
                const currentIndex = data.agents.findIndex(
                  (item) => item.provider === agent.provider,
                );
                const offset = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1;
                const nextAgent =
                  data.agents[(currentIndex + offset + data.agents.length) % data.agents.length];
                if (!nextAgent) return;
                setProvider(nextAgent.provider);
                window.requestAnimationFrame(() =>
                  document.getElementById(`agent-provider-${nextAgent.provider}`)?.focus(),
                );
              }}
            >
              {agent.provider === 'codex' ? (
                <Command aria-hidden="true" />
              ) : (
                <TerminalSquare aria-hidden="true" />
              )}
              <span>
                <strong>{cloudModel ?? titleCase(agent.provider)}</strong>
                <small>
                  {cloudModel
                    ? 'Eliza Cloud'
                    : agent.mode === 'embedded'
                      ? 'Local Agent SDK'
                      : 'MCP companion'}
                </small>
              </span>
              <StateDot
                tone={
                  agent.state === 'ready'
                    ? 'success'
                    : agent.state === 'error'
                      ? 'danger'
                      : 'warning'
                }
                label={titleCase(agent.state)}
              />
            </button>
          ))}
      </div>

      <div className="agent-workbench">
        <div className="agent-composer">
          <label>
            <span>What should the agent do?</span>
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="Research, compare, summarize, or prepare a proposal…"
            />
          </label>
          <div className="agent-disclosure">
            <div className="agent-disclosure__header">
              <strong>Context for this run</strong>
              <small>Only checked data classes are disclosed to the selected agent.</small>
            </div>
            {contextOptions.map((option) => (
              <div className="agent-disclosure__option" key={option.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={disclosure.includes(option.id)}
                    onChange={() => toggleContext(option.id)}
                  />
                  <span>
                    <strong>{option.label}</strong>
                    <small>{option.detail}</small>
                  </span>
                </label>
                <button
                  type="button"
                  className="agent-grant-button"
                  disabled={updatingGrant === option.id}
                  aria-busy={updatingGrant === option.id || undefined}
                  onClick={() =>
                    void toggleGrant(option.id as 'round' | 'company' | 'investors' | 'activity')
                  }
                >
                  {updatingGrant === option.id
                    ? 'Saving…'
                    : durableGrants.includes(
                          option.id as 'round' | 'company' | 'investors' | 'activity',
                        )
                      ? 'Remembered · revoke'
                      : 'Remember as default'}
                </button>
              </div>
            ))}
          </div>
          <div className="agent-composer__footer">
            <span>
              <ShieldCheck aria-hidden="true" /> No agent tool can send email directly.
            </span>
            {runId ? (
              <Button
                tone="danger"
                icon={<CircleStop aria-hidden="true" />}
                onClick={() => void cancel()}
              >
                Stop
              </Button>
            ) : (
              <Button
                tone="primary"
                icon={<Send aria-hidden="true" />}
                loading={starting}
                disabled={!prompt.trim() || currentStatus?.state !== 'ready'}
                onClick={() => void run()}
              >
                Run with {cloudModel ?? titleCase(provider)}
              </Button>
            )}
          </div>
        </div>

        <aside className="agent-run" aria-label="Agent run output">
          <header>
            <div>
              <Sparkles aria-hidden="true" />
              <span>
                <strong>Run output</strong>
                <small>
                  {runId
                    ? cloudModel
                      ? 'Working'
                      : 'Working locally'
                    : events.length
                      ? 'Completed'
                      : 'Ready'}
                </small>
              </span>
            </div>
            {runId ? <Badge tone="info">Running</Badge> : null}
          </header>
          {events.length ? (
            <div className="agent-event-list" role="log" aria-live="polite">
              {events.map((event, index) => (
                <article
                  className={`agent-event agent-event--${event.type}`}
                  key={`${event.runId}-${index}`}
                >
                  <span>
                    {event.type === 'tool_proposal' ? (
                      <ShieldCheck />
                    ) : event.type === 'completed' ? (
                      <Check />
                    ) : (
                      <Bot />
                    )}
                  </span>
                  <div>
                    <strong>{titleCase(event.type)}</strong>
                    <p>{event.text}</p>
                    {event.proposalId ? (
                      <Button size="small" onClick={() => void openProposal(event.proposalId!)}>
                        Review proposal <ChevronRight aria-hidden="true" />
                      </Button>
                    ) : null}
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <EmptyState
              title="No run yet"
              detail="Choose the context this run may see, then ask for a specific research or drafting result."
            />
          )}
        </aside>
      </div>

      <Section
        title="Pending proposals"
        description="Inspect the exact durable payload before applying a bounded local change. Nothing here can send, schedule, or publish."
      >
        {data.agentProposals.length ? (
          <div className="agent-proposal-review">
            <ul className="agent-proposal-list" aria-label="Pending agent proposals">
              {data.agentProposals.map((proposal) => (
                <li key={proposal.id}>
                  <button
                    type="button"
                    aria-pressed={selectedProposal?.id === proposal.id}
                    onClick={() => setSelectedProposalId(proposal.id)}
                  >
                    <span>
                      <strong>{proposal.title}</strong>
                      <small>
                        {titleCase(proposal.kind)} · {titleCase(proposal.provider)}
                      </small>
                    </span>
                    <ChevronRight aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>

            {selectedProposal ? (
              <article className="agent-proposal-detail" aria-labelledby="agent-proposal-title">
                <header>
                  <div>
                    <Badge tone="warning">Founder review required</Badge>
                    <h3 id="agent-proposal-title">{selectedProposal.title}</h3>
                  </div>
                  <Badge>{titleCase(selectedProposal.kind)}</Badge>
                </header>
                <p className="agent-proposal-rationale">{selectedProposal.rationale}</p>
                <dl>
                  <div>
                    <dt>Provider</dt>
                    <dd>{titleCase(selectedProposal.provider)}</dd>
                  </div>
                  <div>
                    <dt>Investor</dt>
                    <dd>
                      {selectedProposal.investorId
                        ? (data.investors.find(
                            (investor) => investor.id === selectedProposal.investorId,
                          )?.name ?? selectedProposal.investorId)
                        : 'Not scoped'}
                    </dd>
                  </div>
                  <div>
                    <dt>Proposal ID</dt>
                    <dd>{selectedProposal.id}</dd>
                  </div>
                </dl>
                <div className="agent-proposal-payload">
                  <strong>Exact payload</strong>
                  <pre tabIndex={0} aria-label="Exact agent proposal payload">
                    <code>{JSON.stringify(selectedProposal.payload, null, 2)}</code>
                  </pre>
                </div>
                <p className="agent-proposal-effect">
                  {selectedProposal.kind === 'draft'
                    ? 'Apply creates an unapproved initial draft. You must review and approve it separately before any provider send.'
                    : selectedProposal.kind === 'pipeline_move'
                      ? 'Apply moves one existing local target after its investor ID and stage are validated.'
                      : selectedProposal.kind === 'task'
                        ? 'Apply creates one open local task after every payload field and investor reference are validated.'
                        : 'This proposal cannot mutate its suggested record. You may preserve it as one open local task.'}
                </p>
                <footer>
                  <Button
                    tone="danger"
                    loading={reviewingProposalId === selectedProposal.id}
                    onClick={() => void reviewProposal('reject')}
                  >
                    Reject proposal
                  </Button>
                  <Button
                    tone="primary"
                    loading={reviewingProposalId === selectedProposal.id}
                    onClick={() =>
                      void reviewProposal(
                        selectedProposal.kind === 'note' || selectedProposal.kind === 'research'
                          ? 'convert_to_task'
                          : 'apply',
                      )
                    }
                  >
                    {selectedProposal.kind === 'note' || selectedProposal.kind === 'research'
                      ? 'Convert to task'
                      : 'Apply local change'}
                  </Button>
                </footer>
              </article>
            ) : null}
          </div>
        ) : (
          <EmptyState
            title="No pending proposals"
            detail="Agent suggestions appear here as durable, founder-reviewable records."
          />
        )}
      </Section>

      <Section
        title="Execution boundaries"
        description="Agent convenience never weakens database and provider safety invariants."
      >
        <div className="agent-boundaries">
          <p>
            <strong>Read</strong> Search approved context and cited investor records.
          </p>
          <p>
            <strong>Propose</strong> Create draft changes, tasks, research candidates, and exact
            message proposals.
          </p>
          <p>
            <strong>Approve</strong> The founder accepts data mutations and exact external actions
            in Outreachr.
          </p>
          <p>
            <strong>Enforce</strong> SQLite constraints and connector guards make duplicate or
            unapproved sends impossible.
          </p>
        </div>
      </Section>
    </div>
  );
}
