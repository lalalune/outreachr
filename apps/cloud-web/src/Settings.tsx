import { useCallback, useEffect, useState } from 'react';
import { useWorkspace } from '../../desktop/src/renderer/src/state/WorkspaceContext';
import { api, post } from './bridge';
import type { Account, Organization } from './types';

interface Connection {
  connectionId: string | null;
  connected: boolean;
  identity: Record<string, unknown> | null;
}
interface Member {
  id: string;
  name: string;
  email: string;
  role: string;
}
interface Invite {
  id: string;
  email: string;
  role: string;
  expires_at: string;
}
export function Settings({
  account,
  org,
  reload,
}: {
  account: Account;
  org: Organization;
  reload: () => Promise<void>;
}) {
  const { data, command, refresh } = useWorkspace();
  const base = `/api/organizations/${org.id}`;
  const [members, setMembers] = useState<Member[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [connectionId, setConnectionId] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('viewer');
  const [inviteUrl, setInviteUrl] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [plan, setPlan] = useState(org.plan);
  const [seats, setSeats] = useState(org.seat_capacity);
  const [used, setUsed] = useState(0);
  const [postal, setPostal] = useState(data?.communicationPolicy.postalAddress ?? '');
  const [password, setPassword] = useState('');
  const admin = org.role === 'owner' || org.role === 'admin';
  const load = useCallback(async () => {
    const [people, pending, mailboxes, selected, usage] = await Promise.all([
      api<Member[]>(`${base}/members`),
      admin ? api<Invite[]>(`${base}/invites`) : [],
      api<Connection[]>('/api/google/connections'),
      api<{ connectionId: string } | null>(`${base}/mailbox`),
      api<{ usedCents: number }>(`${base}/usage`),
    ]);
    setMembers(people);
    setInvites(pending);
    setConnections(mailboxes);
    setConnectionId(selected?.connectionId ?? '');
    setUsed(usage.usedCents);
  }, [base, admin]);
  useEffect(() => {
    void load().catch((cause: Error) => setError(cause.message));
  }, [load]);
  async function act(work: () => Promise<unknown>, message = 'Saved.') {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await work();
      await Promise.all([load(), reload()]);
      setNotice(message);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The request failed.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="page cloud-settings">
      <h1>Workspace settings</h1>
      <p>
        {org.name} · {account.user.email} · {org.role}
      </p>
      {error && (
        <p role="alert" className="cloud-error">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <section>
        <h2>Plan and seats</h2>
        <button
          disabled={busy}
          onClick={() => void act(() => post(`${base}/billing/refresh`, {}), 'Billing refreshed.')}
        >
          Refresh billing status
        </button>
        <p>
          Sol: $49 per editing seat/month. Astra: $200 per editing seat/month. Viewers are free.
          Invitations do not purchase seats.
        </p>
        <p>
          {org.entitlement.trial
            ? `Trial ends ${new Date(org.trial_ends_at!).toLocaleDateString()}.`
            : `Subscription: ${org.subscription_status}.`}{' '}
          {org.cancel_at_period_end && 'Cancellation is scheduled for the end of the paid period.'}
        </p>
        <p>
          AI allowance used: ${(used / 100).toFixed(2)} of $
          {(org.entitlement.allowanceCents / 100).toFixed(2)}. Allowance uses uncached model catalog
          token rates plus Cloud’s service markup. No automatic overage.
        </p>
        <label>
          Plan
          <select
            value={plan}
            onChange={(e) => setPlan(e.target.value as 'sol' | 'astra')}
            disabled={org.role !== 'owner' || busy}
          >
            <option value="sol">Sol — GPT-5.6 Sol · $49/seat</option>
            <option value="astra">Astra — GPT-6 Astra · $200/seat</option>
          </select>
        </label>
        <label>
          Editing seats
          <input
            type="number"
            min={Math.max(1, members.filter((member) => member.role !== 'viewer').length)}
            max="1000"
            value={seats}
            onChange={(e) => setSeats(Number(e.target.value))}
            disabled={org.role !== 'owner' || busy}
          />
        </label>
        <p>
          {seats} editing seat{seats === 1 ? '' : 's'} × ${plan === 'sol' ? 49 : 200} = $
          {seats * (plan === 'sol' ? 49 : 200)}/month, before tax.
        </p>
        <button
          disabled={org.role !== 'owner' || busy || !Number.isInteger(seats) || seats < 1}
          onClick={() =>
            void act(async () => {
              const result = await post<{ url: string }>(`${base}/billing/checkout`, {
                plan,
                seats,
              });
              window.location.assign(result.url);
            })
          }
        >
          Review subscription
        </button>
        <button
          disabled={org.role !== 'owner' || busy || org.subscription_status === 'none'}
          onClick={() =>
            void act(async () => {
              const result = await post<{ url: string }>(`${base}/billing/portal`, {});
              window.location.assign(result.url);
            })
          }
        >
          Billing and cancellation
        </button>
      </section>
      <section>
        <h2>Members</h2>
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Role</th>
              <th>Access</th>
            </tr>
          </thead>
          <tbody>
            {members.map((member) => (
              <tr key={member.id}>
                <td>{member.name}</td>
                <td>{member.email}</td>
                <td>
                  <select
                    aria-label={`Role for ${member.email}`}
                    value={member.role}
                    disabled={busy || org.role !== 'owner'}
                    onChange={(event) =>
                      void act(() =>
                        api(`${base}/members/${member.id}`, {
                          method: 'PATCH',
                          body: JSON.stringify({ role: event.target.value }),
                        }),
                      )
                    }
                  >
                    {['owner', 'admin', 'member', 'viewer'].map((value) => (
                      <option key={value}>{value}</option>
                    ))}
                  </select>
                </td>
                <td>
                  <button
                    disabled={busy || (!admin && member.id !== account.user.id)}
                    onClick={() =>
                      void act(() =>
                        api(`${base}/members/${member.id}`, {
                          method: 'PATCH',
                          body: JSON.stringify({ role: null }),
                        }),
                      )
                    }
                  >
                    {member.id === account.user.id ? 'Leave' : 'Remove'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {admin && (
          <>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void act(async () => {
                  const invitation = await post<{ url: string }>(`${base}/invites`, {
                    email,
                    role,
                  });
                  setInviteUrl(invitation.url);
                  setEmail('');
                }, 'Invitation link created. Share it with the invited person.');
              }}
            >
              <label>
                Invite email
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </label>
              <label>
                Role
                <select value={role} onChange={(e) => setRole(e.target.value)}>
                  <option value="viewer">Viewer — free</option>
                  <option value="member">Member — editing seat</option>
                  <option value="admin">Admin — editing seat</option>
                </select>
              </label>
              <button disabled={busy}>Create invitation link</button>
            </form>
            {inviteUrl && (
              <label>
                Invitation link
                <input
                  aria-label="Invitation link"
                  readOnly
                  value={inviteUrl}
                  onFocus={(e) => e.target.select()}
                />
                <button onClick={() => void navigator.clipboard.writeText(inviteUrl)}>
                  Copy invitation
                </button>
              </label>
            )}
            {invites.map((invite) => (
              <p key={invite.id}>
                {invite.email} · {invite.role} · expires{' '}
                {new Date(invite.expires_at).toLocaleDateString()}{' '}
                <button
                  disabled={busy}
                  onClick={() =>
                    void act(() => api(`${base}/invites/${invite.id}`, { method: 'DELETE' }))
                  }
                >
                  Revoke
                </button>
              </p>
            ))}
          </>
        )}
      </section>
      <section>
        <h2>Your Gmail account</h2>
        <p>
          Your mailbox authorization stays with your Eliza account. Other members select their own
          mailbox.
        </p>
        <a
          href="https://cloud.eliza.app/settings?section=connectors"
          target="_blank"
          rel="noreferrer"
        >
          Manage Google connections in Eliza
        </a>
        <label>
          Gmail mailbox
          <select
            value={connectionId}
            disabled={!org.entitlement.canEdit || busy}
            onChange={(event) => setConnectionId(event.target.value)}
          >
            <option value="">No mailbox selected</option>
            {connections
              .filter((connection) => connection.connected && connection.connectionId)
              .map((connection) => (
                <option value={connection.connectionId!} key={connection.connectionId}>
                  {typeof connection.identity?.email === 'string'
                    ? connection.identity.email
                    : 'Connected Google account'}
                </option>
              ))}
          </select>
        </label>
        <button
          disabled={!org.entitlement.canEdit || busy}
          onClick={() =>
            void act(async () => {
              await post(`${base}/mailbox`, { connectionId: connectionId || null });
              await refresh();
            })
          }
        >
          Save mailbox
        </button>
        <button
          disabled={!connectionId || busy}
          onClick={() =>
            void act(
              () => command('connector.test', { provider: 'google' }),
              'Connection verified.',
            )
          }
        >
          Test connection
        </button>
        <button
          disabled={!connectionId || busy || !org.entitlement.canEdit}
          onClick={() =>
            void act(
              () => command('connector.syncMail', { provider: 'google' }),
              'Mail reconciliation completed.',
            )
          }
        >
          Sync mail
        </button>
        <button
          disabled={!connectionId || busy || !org.entitlement.canEdit}
          onClick={() =>
            void act(
              () => command('connector.syncCalendar', { provider: 'google' }),
              'Calendar synced.',
            )
          }
        >
          Sync calendar
        </button>
      </section>
      {admin && data && (
        <section>
          <h2>Sending policy</h2>
          <p>
            Messages require exact draft approval and a complete prior-contact check before sending.
          </p>
          <label>
            Sender postal address
            <textarea value={postal} onChange={(event) => setPostal(event.target.value)} />
          </label>
          <button
            disabled={busy || !org.entitlement.canEdit}
            onClick={() =>
              void act(() => {
                const policy = data.communicationPolicy;
                return command('communications.policy.update', {
                  sendingPaused: policy.sendingPaused,
                  dailySendLimit: policy.dailySendLimit,
                  hourlySendLimit: policy.hourlySendLimit,
                  recipientDomainDailyLimit: policy.recipientDomainDailyLimit,
                  recipientDomainCooldownMinutes: policy.recipientDomainCooldownMinutes,
                  optOutText: policy.optOutText,
                  postalAddress: postal.trim() || null,
                });
              })
            }
          >
            Save sender address
          </button>
          <button
            disabled={busy || !org.entitlement.canEdit}
            onClick={() =>
              void act(() => {
                const policy = data.communicationPolicy;
                return command('communications.policy.update', {
                  dailySendLimit: policy.dailySendLimit,
                  hourlySendLimit: policy.hourlySendLimit,
                  recipientDomainDailyLimit: policy.recipientDomainDailyLimit,
                  recipientDomainCooldownMinutes: policy.recipientDomainCooldownMinutes,
                  postalAddress: policy.postalAddress,
                  optOutText: policy.optOutText,
                  sendingPaused: !policy.sendingPaused,
                });
              })
            }
          >
            {data.communicationPolicy.sendingPaused ? 'Resume sending' : 'Pause all sending'}
          </button>
        </section>
      )}
      <section>
        <h2>Export and backup</h2>
        <p>
          Read and export access remains available after the trial. Encrypted backups require your
          password to restore.
        </p>
        {(['investors', 'people', 'pipeline', 'activity'] as const).map((kind) => (
          <button
            key={kind}
            disabled={busy}
            onClick={() =>
              void act(async () => {
                const result = await command('data.exportCsv', {
                  directory: 'cloud-downloads',
                  kind,
                });
                await window.outreachr.revealPath(result.path);
              }, 'Download ready.')
            }
          >
            Export {kind} CSV
          </button>
        ))}
        <label>
          Backup password
          <input
            type="password"
            minLength={12}
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <button
          disabled={busy || password.length < 12}
          onClick={() =>
            void act(async () => {
              const result = await command('backup.export', {
                directory: 'cloud-downloads',
                password,
              });
              await window.outreachr.revealPath(result.path);
            }, 'Encrypted backup downloaded.')
          }
        >
          Download encrypted backup
        </button>
        {admin && (
          <button
            disabled={busy || password.length < 12 || !org.entitlement.canEdit}
            onClick={() =>
              void act(async () => {
                const path = await window.outreachr.selectFile();
                if (path) {
                  if (!window.confirm('Replace this workspace with the selected encrypted backup?'))
                    return;
                  await command('backup.restore', { path, password });
                }
              }, 'Backup restored.')
            }
          >
            Restore encrypted backup
          </button>
        )}
      </section>
    </div>
  );
}
