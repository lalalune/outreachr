import {
  ArrowRight,
  CalendarClock,
  Check,
  MailCheck,
  RefreshCw,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from '../lib/router';
import { InvestorTable } from '../components/InvestorTable';
import {
  Badge,
  Button,
  EmptyState,
  formatDate,
  PageHeader,
  Section,
  titleCase,
} from '../components/ui';
import { useWorkspace } from '../state/WorkspaceContext';

export function UpNextPage(): React.JSX.Element {
  const { data, command, refresh, refreshing, notify } = useWorkspace();
  const navigate = useNavigate();
  const [completingId, setCompletingId] = useState<string | null>(null);
  if (!data) return <></>;

  const urgent = data.workItems.filter((item) => item.status === 'open').slice(0, 8);
  const recommended = [...data.investors]
    .filter((investor) => !investor.target && investor.fitScore >= 70)
    .sort((a, b) => b.fitScore - a.fitScore)
    .slice(0, 5);

  const complete = async (item: (typeof data.workItems)[number]): Promise<void> => {
    setCompletingId(item.id);
    try {
      if (item.kind === 'follow_up') {
        await command('mail.review', { id: item.id });
        notify({ tone: 'success', title: 'Mailbox event reviewed' });
        return;
      }
      await command('task.update', { id: item.id, status: 'done' });
      notify({ tone: 'success', title: 'Task completed' });
    } finally {
      setCompletingId(null);
    }
  };

  return (
    <div className="page">
      <PageHeader
        title="Up next"
        description="The smallest set of actions that keeps your round moving today."
        actions={
          <>
            <Button
              tone="secondary"
              icon={<RefreshCw aria-hidden="true" />}
              loading={refreshing}
              onClick={() => void refresh()}
            >
              Refresh
            </Button>
            <Button
              tone="primary"
              icon={<Sparkles aria-hidden="true" />}
              onClick={() => navigate('/agent')}
            >
              Plan my day
            </Button>
          </>
        }
      />

      {data.hosting === 'cloud' && (
        <Section title="Workspace setup">
          <p>
            Complete these steps before your first send. Every message still requires your review
            and approval.
          </p>
          <ul>
            <li>
              {data.knowledge.length ? '✓ Company context saved' : 'Add company context'} —{' '}
              <a href="#/knowledge">Company knowledge</a>
            </li>
            <li>
              {data.counts.targeted
                ? '✓ Shortlist started'
                : 'Choose investors and verify their sources'}{' '}
              — <a href="#/investors">Investors</a>
            </li>
            <li>
              {data.communicationPolicy.postalAddress
                ? '✓ Sender address configured'
                : 'Connect Gmail and enter your real sender postal address'}{' '}
              — <a href="#/settings">Configure sending</a>
            </li>
            <li>
              {data.drafts.length ? '✓ Draft prepared' : 'Prepare your first draft'} —{' '}
              <a href="#/outreach">Review outreach</a>
            </li>
          </ul>
        </Section>
      )}
      <div className="momentum-strip" aria-label="Round momentum">
        <div>
          <span>Targeted</span>
          <strong>{data.counts.targeted}</strong>
          <small>of {data.counts.firms} researched</small>
        </div>
        <div>
          <span>Contacted</span>
          <strong>{data.counts.contacted}</strong>
          <small>
            {data.drafts.filter((draft) => draft.approvalState === 'approved').length} ready to send
          </small>
        </div>
        <div>
          <span>Meetings</span>
          <strong>{data.counts.meetings}</strong>
          <small>
            {data.meetings.filter((meeting) => meeting.status === 'upcoming').length} upcoming
          </small>
        </div>
        <div>
          <span>Committed</span>
          <strong>{data.counts.commitments}</strong>
          <small>investors in the round</small>
        </div>
      </div>

      <Section
        title="Today’s queue"
        description="Approvals and commitments come first; research fills the remaining space."
        action={
          <Button tone="quiet" onClick={() => navigate('/tasks')}>
            All tasks <ArrowRight aria-hidden="true" />
          </Button>
        }
      >
        {urgent.length ? (
          <div className="work-queue">
            {urgent.map((item) => (
              <article className="work-row" key={item.id}>
                <button
                  className="work-row__complete"
                  disabled={!['task', 'follow_up'].includes(item.kind) || completingId === item.id}
                  aria-busy={completingId === item.id || undefined}
                  aria-label={
                    item.kind === 'task' ? `Complete ${item.title}` : `Mark ${item.title} reviewed`
                  }
                  onClick={() =>
                    ['task', 'follow_up'].includes(item.kind) ? void complete(item) : undefined
                  }
                >
                  <Check aria-hidden="true" />
                </button>
                <span className={`work-row__icon work-row__icon--${item.kind}`} aria-hidden="true">
                  {item.kind === 'approval' ? (
                    <MailCheck />
                  ) : item.kind === 'meeting' ? (
                    <CalendarClock />
                  ) : (
                    <ShieldCheck />
                  )}
                </span>
                <div className="work-row__copy">
                  <div>
                    <strong>{item.title}</strong>
                    <Badge
                      tone={
                        item.priority === 'urgent'
                          ? 'danger'
                          : item.priority === 'high'
                            ? 'warning'
                            : 'neutral'
                      }
                    >
                      {item.priority}
                    </Badge>
                  </div>
                  <p>{item.detail}</p>
                </div>
                <div className="work-row__meta">
                  <span>{item.dueAt ? formatDate(item.dueAt, true) : 'No due date'}</span>
                  <Button
                    tone="quiet"
                    size="small"
                    onClick={() =>
                      navigate(
                        item.investorId
                          ? `/investors/${item.investorId}`
                          : item.kind === 'approval'
                            ? '/outreach'
                            : '/tasks',
                      )
                    }
                  >
                    Review <ArrowRight aria-hidden="true" />
                  </Button>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <EmptyState
            title="The queue is clear"
            detail="No overdue follow-ups, unsent approvals, or unresolved source changes remain."
          />
        )}
      </Section>

      <Section
        title="High-fit investors not yet targeted"
        description="Recommendations are decomposable and source-linked. Open any row to inspect why."
        action={
          <Button tone="quiet" onClick={() => navigate('/investors')}>
            Explore universe <ArrowRight aria-hidden="true" />
          </Button>
        }
      >
        {recommended.length ? (
          <InvestorTable investors={recommended} compact />
        ) : (
          <EmptyState
            title="No unreviewed matches"
            detail="You have reviewed every currently eligible high-fit investor."
          />
        )}
      </Section>

      <Section
        title="Round health"
        description="Signals are descriptive, not a promise that the round will close."
      >
        <div className="health-grid">
          <div className="health-narrative">
            <strong>Momentum is {data.counts.meetings > 2 ? 'building' : 'early'}.</strong>
            <p>
              {data.counts.targeted} investors are active in the round, {data.counts.contacted} have
              been contacted, and {data.counts.meetings} meetings are recorded. The most important
              constraint is currently{' '}
              {data.drafts.some((draft) => draft.approvalState === 'approved')
                ? 'moving approved outreach into provider delivery'
                : 'building partner-level conversations'}
              .
            </p>
          </div>
          <dl className="health-facts">
            <div>
              <dt>Seed</dt>
              <dd>{data.seedVersion}</dd>
            </div>
            <div>
              <dt>Connectors</dt>
              <dd>
                {data.connectors.filter((item) => item.state === 'connected').length} connected
              </dd>
            </div>
            <div>
              <dt>Source review</dt>
              <dd>
                {data.sourceReview.filter((item) => item.status === 'pending').length} pending
              </dd>
            </div>
            <div>
              <dt>Round stage</dt>
              <dd>{data.round ? titleCase(data.round.stage) : 'Not configured'}</dd>
            </div>
          </dl>
        </div>
      </Section>
    </div>
  );
}
