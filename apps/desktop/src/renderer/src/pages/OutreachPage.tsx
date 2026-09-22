import { useMemo, useState } from 'react';
import { AlertTriangle, Check, Edit3, Lock, Mail, Send, ShieldCheck } from 'lucide-react';
import { useNavigate } from '../lib/router';
import type { DraftMessage } from '../../../shared/contracts';
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  formatDate,
  PageHeader,
  Section,
  TextField,
  titleCase,
} from '../components/ui';
import { useWorkspace } from '../state/WorkspaceContext';

export function OutreachPage(): React.JSX.Element {
  const { data, command, notify } = useWorkspace();
  const navigate = useNavigate();
  const [selected, setSelected] = useState<DraftMessage | null>(null);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [conversation, setConversation] = useState<{
    personId: string;
    threadId: string;
    subject: string;
    kind: 'reply' | 'follow_up';
  } | null>(null);
  const [conversationBody, setConversationBody] = useState('');
  const beginConversation = (
    personId: string,
    threadId: string,
    originalSubject: string,
    kind: 'reply' | 'follow_up',
  ) => {
    setSelected(null);
    setConversationBody('');
    setConversation({
      personId,
      threadId,
      subject: /^re:/i.test(originalSubject) ? originalSubject : `Re: ${originalSubject}`,
      kind,
    });
  };
  const [filter, setFilter] = useState<'all' | 'draft' | 'approved' | 'sent' | 'attention'>('all');

  const counts = useMemo(
    () => ({
      draft: (data?.drafts ?? []).filter((item) => item.approvalState === 'draft').length,
      approved: (data?.drafts ?? []).filter((item) => item.approvalState === 'approved').length,
      sent: (data?.drafts ?? []).filter((item) => item.approvalState === 'sent').length,
      blocked: (data?.drafts ?? []).filter(
        (item) =>
          ['blocked', 'failed', 'ambiguous'].includes(item.approvalState) ||
          Boolean(item.blockReason),
      ).length,
    }),
    [data?.drafts],
  );

  const visibleDrafts = useMemo(
    () =>
      (data?.drafts ?? []).filter((draft) => {
        if (filter === 'all') return true;
        if (filter === 'attention')
          return (
            ['blocked', 'failed', 'ambiguous'].includes(draft.approvalState) ||
            Boolean(draft.blockReason)
          );
        return draft.approvalState === filter;
      }),
    [data?.drafts, filter],
  );

  const liveApprovalBlockReasons = useMemo(() => {
    if (!selected) return [];
    const reasons = selected.approvalBlockReasons.filter(
      (reason) => !/sender postal address|opt-out wording|Configure opt-out/iu.test(reason),
    );
    const policy = data?.communicationPolicy;
    if (!policy?.postalAddress) {
      reasons.push('Add a complete sender postal address in Communication safety before approval.');
    } else if (!body.includes(policy.postalAddress)) {
      reasons.push('The message body must include the exact configured sender postal address.');
    }
    if (!policy?.optOutText) {
      reasons.push('Configure opt-out wording in Communication safety before approval.');
    } else if (!body.includes(policy.optOutText)) {
      reasons.push('The message body must include the exact configured opt-out wording.');
    }
    if (!subject.trim()) reasons.push('Add a subject before approval.');
    if (!body.trim()) reasons.push('Add a message body before approval.');
    return [...new Set(reasons)];
  }, [body, data?.communicationPolicy, selected, subject]);

  if (!data) return <></>;

  const open = (draft: DraftMessage): void => {
    setSelected(draft);
    setSubject(draft.subject);
    setBody(draft.bodyText);
  };

  const save = async (): Promise<DraftMessage | null> => {
    if (!selected) return null;
    const result = await command('draft.update', { id: selected.id, subject, bodyText: body });
    setSelected(result);
    return result;
  };

  const saveDraft = async (): Promise<void> => {
    setBusy(true);
    try {
      const saved = await save();
      if (saved) notify({ tone: 'success', title: 'Draft saved', detail: saved.recipientName });
    } finally {
      setBusy(false);
    }
  };

  const approve = async (): Promise<void> => {
    setBusy(true);
    try {
      const saved = await save();
      if (!saved) return;
      if (!saved.canApprove) {
        notify({
          tone: 'error',
          title: 'Draft is not ready for approval',
          detail: saved.approvalBlockReasons[0] ?? 'Review the communication safety requirements.',
        });
        return;
      }
      const result = await command('draft.approve', {
        id: saved.id,
        expectedContentHash: saved.contentHash,
      });
      setSelected(result);
      notify({
        tone: 'success',
        title: 'Exact message approved',
        detail: 'Any content edit will invalidate this approval.',
      });
    } finally {
      setBusy(false);
    }
  };

  const send = async (): Promise<void> => {
    if (!selected) return;
    setBusy(true);
    try {
      const result = await command('draft.send', {
        id: selected.id,
        expectedContentHash: selected.contentHash,
      });
      setSelected(result);
      if (result.approvalState === 'sent') {
        notify({
          tone: 'success',
          title: 'Message confirmed sent',
          detail: result.providerMessageId ?? 'Provider send receipt recorded.',
        });
      } else {
        notify({
          tone: 'error',
          title: 'Provider outcome is unconfirmed',
          detail:
            'Outreachr will not retry. A later sent-mail reconciliation may only confirm this original operation.',
        });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <PageHeader
        title="Outreach"
        description="Every external message is exact-content approved, provider-native, and reconciled against the canonical-person ledger."
        actions={
          <Button
            tone="primary"
            icon={<Mail aria-hidden="true" />}
            onClick={() => navigate('/investors')}
          >
            Choose a recipient
          </Button>
        }
      />

      <div
        className={`communication-stop ${data.communicationPolicy.sendingPaused ? 'communication-stop--paused' : ''}`}
      >
        <ShieldCheck aria-hidden="true" />
        <div>
          <strong>
            {data.communicationPolicy.sendingPaused
              ? 'All sending is paused'
              : 'Founder-controlled sending is active'}
          </strong>
          <p>
            {data.communicationPolicy.reservedToday} of {data.communicationPolicy.dailySendLimit}{' '}
            approved sends reserved today; {data.communicationPolicy.reservedThisHour} of{' '}
            {data.communicationPolicy.hourlySendLimit} in the last hour. SQLite also enforces
            per-domain pacing and the visible sender footer.
          </p>
        </div>
        <Button tone="quiet" onClick={() => navigate('/settings/connectors')}>
          Safety settings
        </Button>
      </div>

      <div className="outreach-status-row" aria-label="Outreach state summary">
        <button
          aria-pressed={filter === 'draft'}
          onClick={() => setFilter((current) => (current === 'draft' ? 'all' : 'draft'))}
        >
          <span>Drafts</span>
          <strong>{counts.draft}</strong>
        </button>
        <button
          aria-pressed={filter === 'approved'}
          onClick={() => setFilter((current) => (current === 'approved' ? 'all' : 'approved'))}
        >
          <span>Approved</span>
          <strong>{counts.approved}</strong>
        </button>
        <button
          aria-pressed={filter === 'sent'}
          onClick={() => setFilter((current) => (current === 'sent' ? 'all' : 'sent'))}
        >
          <span>Sent</span>
          <strong>{counts.sent}</strong>
        </button>
        <button
          aria-pressed={filter === 'attention'}
          onClick={() => setFilter((current) => (current === 'attention' ? 'all' : 'attention'))}
        >
          <span>Needs attention</span>
          <strong>{counts.blocked}</strong>
        </button>
      </div>

      {data.mailEvents.some((event) => event.direction === 'inbound' && !event.reviewedAt) ? (
        <Section
          title="Relationship events"
          description="Only attributed mailbox metadata is stored. Review replies, bounces, and complaints before planning another action."
        >
          <div className="relationship-event-list">
            {data.mailEvents
              .filter((event) => event.direction === 'inbound' && !event.reviewedAt)
              .map((event) => (
                <article key={event.id}>
                  <span
                    className={`message-state message-state--${event.kind === 'reply' ? 'approved' : 'blocked'}`}
                    aria-hidden="true"
                  >
                    {event.kind === 'reply' ? <Mail /> : <AlertTriangle />}
                  </span>
                  <span>
                    <strong>{event.personName}</strong>
                    <small>
                      {titleCase(event.kind)} · {event.subject || 'No subject'} ·{' '}
                      {formatDate(event.occurredAt, true)}
                    </small>
                  </span>
                  <div>
                    {event.kind === 'reply' && event.provider === 'google' && event.threadId && (
                      <Button
                        size="small"
                        onClick={() =>
                          beginConversation(event.personId, event.threadId!, event.subject, 'reply')
                        }
                      >
                        Draft reply
                      </Button>
                    )}
                    {event.investorId ? (
                      <Button
                        tone="quiet"
                        size="small"
                        onClick={() => navigate(`/investors/${event.investorId}`)}
                      >
                        Open investor
                      </Button>
                    ) : null}
                    <Button
                      size="small"
                      onClick={() => void command('mail.review', { id: event.id })}
                    >
                      Mark reviewed
                    </Button>
                  </div>
                </article>
              ))}
          </div>
        </Section>
      ) : null}

      <Section
        title="Message queue"
        description={
          filter === 'all'
            ? 'Outreachr never runs unattended sequences. Follow-ups require a fresh review.'
            : `Showing ${filter === 'attention' ? 'messages needing attention' : filter} messages. Select the active summary again to clear the filter.`
        }
      >
        {visibleDrafts.length ? (
          <div className="message-list">
            {visibleDrafts.map((draft) => (
              <button key={draft.id} onClick={() => open(draft)}>
                <span
                  className={`message-state message-state--${draft.approvalState}`}
                  aria-hidden="true"
                >
                  {draft.approvalState === 'sent' ? (
                    <Check />
                  ) : draft.approvalState === 'approved' ? (
                    <ShieldCheck />
                  ) : draft.approvalState === 'blocked' || draft.blockReason ? (
                    <Lock />
                  ) : (
                    <Mail />
                  )}
                </span>
                <span className="message-list__recipient">
                  <strong>{draft.recipientName}</strong>
                  <small>{draft.recipientEmail}</small>
                </span>
                <span className="message-list__subject">
                  <strong>{draft.subject}</strong>
                  <small>
                    {titleCase(draft.kind)} · {draft.provider}
                  </small>
                </span>
                <Badge
                  tone={
                    draft.approvalState === 'sent'
                      ? 'success'
                      : draft.approvalState === 'approved'
                        ? draft.canSend
                          ? 'accent'
                          : 'warning'
                        : ['blocked', 'failed', 'ambiguous'].includes(draft.approvalState)
                          ? 'danger'
                          : !draft.canApprove
                            ? 'warning'
                            : 'neutral'
                  }
                >
                  {draft.approvalState === 'approved' && !draft.canSend
                    ? 'Send blocked'
                    : draft.approvalState === 'draft' && !draft.canApprove
                      ? 'Needs setup'
                      : titleCase(draft.approvalState)}
                </Badge>
                <span className="message-list__date">
                  {formatDate(draft.sentAt ?? draft.approvedAt)}
                </span>
              </button>
            ))}
          </div>
        ) : (
          <EmptyState
            title={data.drafts.length ? 'No messages in this state' : 'No drafts yet'}
            detail={
              data.drafts.length
                ? 'Select another summary or clear the active filter.'
                : 'Open an investor person record to create a researched, recipient-specific first draft.'
            }
          />
        )}
      </Section>

      <Section
        title="Safety contract"
        description="These checks run in the database and provider adapter—not only in the interface."
      >
        <div className="safety-contract">
          <div>
            <ShieldCheck aria-hidden="true" />
            <strong>Exact-content approval</strong>
            <p>Recipient, sender, subject, body, attachments, and thread are bound to one hash.</p>
          </div>
          <div>
            <Lock aria-hidden="true" />
            <strong>One unsolicited initial</strong>
            <p>
              Canonical people, email aliases, merged identities, rounds, and connected mailboxes
              share one ledger.
            </p>
          </div>
          <div>
            <AlertTriangle aria-hidden="true" />
            <strong>Ambiguous sends stop</strong>
            <p>
              No retry is offered. Provider sent-mail history may only confirm the original
              operation.
            </p>
          </div>
        </div>
      </Section>

      <Dialog
        open={Boolean(conversation)}
        title="Draft conversation message"
        onClose={() => {
          if (!busy) setConversation(null);
        }}
        footer={
          <>
            <Button disabled={busy} onClick={() => setConversation(null)}>
              Cancel
            </Button>
            <Button
              loading={busy}
              disabled={!conversationBody.trim()}
              onClick={() => {
                if (!conversation || busy) return;
                setBusy(true);
                void command('draft.create', {
                  ...conversation,
                  provider: 'google',
                  bodyText: conversationBody,
                })
                  .then((draft) => {
                    setConversation(null);
                    setSelected(draft);
                    setSubject(draft.subject);
                    setBody(draft.bodyText);
                    notify({ tone: 'success', title: 'Conversation draft ready for review' });
                  })
                  .catch(() => {
                    /* WorkspaceContext displays command failures. */
                  })
                  .finally(() => setBusy(false));
              }}
            >
              Save conversation draft
            </Button>
          </>
        }
      >
        <p>
          This replies only to the selected person in their verified Gmail thread. Sync your mailbox
          first. Saving a draft does not send it.
        </p>
        <p>
          <strong>{conversation?.subject}</strong>
        </p>
        <label className="field">
          <span className="field__label">Conversation body</span>
          <textarea
            className="textarea message-body"
            value={conversationBody}
            onChange={(event) => setConversationBody(event.target.value)}
          />
        </label>
      </Dialog>
      <Dialog
        open={Boolean(selected)}
        onClose={() => {
          if (!busy) setSelected(null);
        }}
        title={selected ? `Message to ${selected.recipientName}` : 'Message'}
        {...(selected
          ? {
              description: `${selected.recipientEmail} · ${titleCase(selected.kind)} · ${selected.provider}`,
            }
          : {})}
        footer={
          selected ? (
            <>
              <Button tone="quiet" disabled={busy} onClick={() => setSelected(null)}>
                Close
              </Button>
              {selected.approvalState === 'sent' &&
                selected.provider === 'google' &&
                selected.threadId && (
                  <Button
                    onClick={() =>
                      beginConversation(
                        selected.personId,
                        selected.threadId!,
                        selected.subject,
                        'follow_up',
                      )
                    }
                  >
                    Draft follow-up
                  </Button>
                )}
              {selected.approvalState === 'draft' ? (
                <Button
                  icon={<Edit3 aria-hidden="true" />}
                  loading={busy}
                  disabled={!subject.trim() || !body.trim()}
                  onClick={() => void saveDraft()}
                >
                  Save draft
                </Button>
              ) : null}
              {selected.approvalState === 'draft' ? (
                <Button
                  tone="primary"
                  icon={<ShieldCheck aria-hidden="true" />}
                  loading={busy}
                  disabled={liveApprovalBlockReasons.length > 0}
                  title={liveApprovalBlockReasons[0]}
                  onClick={() => void approve()}
                >
                  Approve exact message
                </Button>
              ) : null}
              {selected.approvalState === 'approved' ? (
                <Button
                  tone="primary"
                  icon={<Send aria-hidden="true" />}
                  loading={busy}
                  disabled={!selected.canSend}
                  title={selected.sendBlockReasons[0]}
                  onClick={() => void send()}
                >
                  Send now
                </Button>
              ) : null}
            </>
          ) : null
        }
      >
        {selected ? (
          <div className="message-editor">
            <div className="approval-banner">
              {selected.approvalState === 'approved' ? (
                <ShieldCheck aria-hidden="true" />
              ) : selected.approvalState === 'sent' ? (
                <Check aria-hidden="true" />
              ) : (
                <Edit3 aria-hidden="true" />
              )}
              <div>
                <strong>{titleCase(selected.approvalState)}</strong>
                <p>
                  {selected.approvalState === 'approved'
                    ? 'This exact content is approved. Editing will require reapproval.'
                    : (selected.blockReason ?? 'Review every word before approval.')}
                </p>
              </div>
            </div>
            {(selected.approvalState === 'draft'
              ? liveApprovalBlockReasons
              : selected.sendBlockReasons
            ).length ? (
              <div className="message-readiness" role="status">
                <strong>
                  {selected.approvalState === 'draft' ? 'Before approval' : 'Before provider send'}
                </strong>
                <ul>
                  {(selected.approvalState === 'draft'
                    ? liveApprovalBlockReasons
                    : selected.sendBlockReasons
                  ).map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            <TextField label="From" value={selected.accountEmail} readOnly />
            <TextField
              label="To"
              value={`${selected.recipientName} <${selected.recipientEmail}>`}
              readOnly
            />
            <TextField
              label="Subject"
              value={subject}
              onChange={(event) => setSubject(event.target.value)}
              readOnly={selected.approvalState !== 'draft' || busy}
            />
            <label className="field">
              <span className="field__label">Body</span>
              <textarea
                className="textarea message-body"
                value={body}
                onChange={(event) => setBody(event.target.value)}
                readOnly={selected.approvalState !== 'draft' || busy}
              />
            </label>
            <dl className="message-proof">
              <div>
                <dt>Content hash</dt>
                <dd className="mono">{selected.contentHash.slice(0, 18)}…</dd>
              </div>
              <div>
                <dt>Recipient ledger</dt>
                <dd>{selected.blockReason ?? 'No conflicting initial send found'}</dd>
              </div>
            </dl>
          </div>
        ) : null}
      </Dialog>
    </div>
  );
}
