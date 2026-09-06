import { useCallback, useEffect, useRef, useState } from 'react';
import { useWorkspace } from '../../desktop/src/renderer/src/state/WorkspaceContext';
import { api, post } from './bridge';
import type { Account, Organization } from './types';
import { BillingRequest, type BillingProgress } from './BillingRequest';

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
  syncPending?: boolean;
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
  const [loadError, setLoadError] = useState('');
  const loadGeneration = useRef(0);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [plan, setPlan] = useState(org.plan);
  const [seats, setSeats] = useState(org.seat_capacity);
  const [billingRequest, setBillingRequest] = useState<BillingProgress | null>(null);
  const [allowance, setAllowance] = useState<{
    usedCents: number;
    allowanceCents: number;
    reservedCents?: number;
    source: string;
  } | null>(null);
  const [postal, setPostal] = useState(data?.communicationPolicy.postalAddress ?? '');
  const [password, setPassword] = useState('');
  const ownershipReady =
    org.cloud_provisioning_state !== 'pending' &&
    (!org.cloud_billing_account_id ||
      (org.cloud_ownership_confirmed && !org.cloud_ownership_pending));
  const admin =
    (org.role === 'owner' || org.role === 'admin') &&
    org.cloud_membership_ready !== false &&
    ownershipReady;
  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    const [people, pending, mailboxes, selected, usage] = await Promise.allSettled([
      api<Member[]>(`${base}/members`),
      admin ? api<Invite[]>(`${base}/invites`) : [],
      api<Connection[]>('/api/google/connections'),
      api<{ connectionId: string } | null>(`${base}/mailbox`),
      api<{ usedCents: number; allowanceCents: number; reservedCents?: number; source: string }>(
        `${base}/usage`,
      ),
    ]);
    // A previous focus refresh must not replace the latest settings or its recovery state.
    if (generation !== loadGeneration.current) return false;
    // Optional Google setup must not hide loaded membership and billing controls.
    setMembers(people.status === 'fulfilled' ? people.value : []);
    setInvites(pending.status === 'fulfilled' ? pending.value : []);
    setConnections(mailboxes.status === 'fulfilled' ? mailboxes.value : []);
    setConnectionId(
      mailboxes.status === 'fulfilled' && selected.status === 'fulfilled'
        ? (selected.value?.connectionId ?? '')
        : '',
    );
    setAllowance(usage.status === 'fulfilled' ? usage.value : null);
    const failures = [people, pending, mailboxes, selected, usage]
      .filter((result) => result.status === 'rejected')
      .map((result) =>
        result.reason instanceof Error
          ? result.reason.message
          : 'A workspace setting could not be loaded.',
      );
    setLoadError([...new Set(failures)].join(' '));
    return failures.length === 0;
  }, [base, admin]);
  useEffect(() => {
    void load();
    const refreshOnFocus = () => {
      void load();
    };
    window.addEventListener('focus', refreshOnFocus);
    return () => {
      loadGeneration.current += 1;
      window.removeEventListener('focus', refreshOnFocus);
    };
  }, [load]);
  async function connectGoogle() {
    const popup = window.open('about:blank', '_blank');
    if (!popup) {
      setError('Allow pop-ups to connect your Google account.');
      return;
    }
    popup.opener = null;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const { authUrl } = await post<{ authUrl: string }>('/api/google/connect', {});
      if (popup.closed) {
        setNotice('Google connection cancelled.');
        return;
      }
      popup.location.replace(authUrl);
      setNotice('Complete Google authorization in the new tab, then refresh connections here.');
    } catch (cause) {
      popup.close();
      setError(cause instanceof Error ? cause.message : 'Google authorization could not start.');
    } finally {
      setBusy(false);
    }
  }
  async function act(work: () => Promise<unknown>, message = 'Saved.') {
    loadGeneration.current += 1;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await work();
      const [loaded] = await Promise.all([load(), reload()]);
      if (loaded)
        setNotice(
          result && typeof result === 'object' && 'pending' in result && result.pending
            ? 'The request is pending. Check its status to confirm the outcome.'
            : message,
        );
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
      {(error || loadError) && (
        <p role="alert" className="cloud-error">
          {error || loadError}
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
          {allowance ? (
            <>
              AI allowance used: ${(allowance.usedCents / 100).toFixed(2)} of $
              {(allowance.allowanceCents / 100).toFixed(2)}.
              {Boolean(allowance.reservedCents) && (
                <> Pending requests reserve ${((allowance.reservedCents ?? 0) / 100).toFixed(2)}.</>
              )}
              {allowance.source === 'local_estimate' && (
                <> Usage is a local estimate while Cloud billing is being connected.</>
              )}
            </>
          ) : (
            'The current AI allowance could not be confirmed.'
          )}{' '}
          The workspace allowance does not increase with seat count. No automatic overage.
        </p>
        <label>
          Plan
          <select
            value={plan}
            onChange={(e) => setPlan(e.target.value as 'sol' | 'astra')}
            disabled={org.role !== 'owner' || busy || !ownershipReady}
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
            disabled={org.role !== 'owner' || busy || !ownershipReady}
          />
        </label>
        <p>
          {seats} editing seat{seats === 1 ? '' : 's'} × ${plan === 'sol' ? 49 : 200} = $
          {seats * (plan === 'sol' ? 49 : 200)}/month, before tax.
        </p>
        <button
          disabled={
            org.role !== 'owner' || busy || !ownershipReady || !Number.isInteger(seats) || seats < 1
          }
          onClick={() =>
            void act(async () => {
              const result = await post<BillingProgress>(`${base}/billing/checkout`, {
                plan,
                seats,
              });
              setBillingRequest(result);
            })
          }
        >
          Review subscription
        </button>
        <button
          disabled={
            org.role !== 'owner' || busy || !ownershipReady || org.subscription_status === 'none'
          }
          onClick={() =>
            void act(async () => {
              const result = await post<BillingProgress>(`${base}/billing/portal`, {});
              setBillingRequest(result);
            })
          }
        >
          Billing and cancellation
        </button>
        {org.role === 'owner' && (
          <BillingRequest
            key={org.id}
            base={base}
            value={billingRequest}
            onChange={setBillingRequest}
            reload={reload}
          />
        )}
      </section>
      <section>
        <h2>Members</h2>
        {org.cloud_billing_account_id && (
          <>
            <button
              disabled={busy}
              onClick={() =>
                void act(() => post(`${base}/ownership/recover`, {}), 'Ownership status refreshed.')
              }
            >
              Check ownership status
            </button>
            {org.cloud_ownership_pending && (
              <p role="status">
                An ownership change is pending. The original requester can check its status to
                recover it.
              </p>
            )}
            {!org.cloud_ownership_confirmed && (
              <p role="status">Cloud ownership has not been confirmed.</p>
            )}
            {org.role === 'owner' && (
              <p>
                Transfer makes the selected editor an owner and changes your role to member. Seats
                and billing stay with the workspace.
              </p>
            )}
          </>
        )}

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
                    disabled={busy || org.role !== 'owner' || !ownershipReady}
                    onChange={(event) =>
                      void act(() =>
                        org.cloud_billing_account_id &&
                        (event.target.value === 'owner' || member.role === 'owner')
                          ? post(`${base}/ownership/change`, {
                              action: event.target.value === 'owner' ? 'grant' : 'revoke',
                              targetId: member.id,
                            })
                          : api(`${base}/members/${member.id}`, {
                              method: 'PATCH',
                              body: JSON.stringify({ role: event.target.value }),
                            }),
                      )
                    }
                  >
                    {(org.cloud_billing_account_id && member.role === 'owner'
                      ? ['owner', 'member']
                      : ['owner', 'admin', 'member', 'viewer']
                    ).map((value) => (
                      <option key={value}>{value}</option>
                    ))}
                  </select>
                </td>
                <td>
                  {member.syncPending && <span role="status">Syncing Cloud access. </span>}
                  {org.cloud_billing_account_id &&
                    org.role === 'owner' &&
                    member.id !== account.user.id &&
                    member.role !== 'owner' &&
                    member.role !== 'viewer' && (
                      <button
                        disabled={busy || !ownershipReady || member.syncPending}
                        onClick={() =>
                          void act(
                            () =>
                              post(`${base}/ownership/change`, {
                                action: 'transfer',
                                targetId: member.id,
                              }),
                            'Ownership status refreshed.',
                          )
                        }
                      >
                        Transfer ownership to {member.email}
                      </button>
                    )}

                  <button
                    disabled={
                      busy ||
                      Boolean(org.cloud_billing_account_id && member.role === 'owner') ||
                      Boolean(org.cloud_ownership_pending) ||
                      (!admin && member.id !== account.user.id)
                    }
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
        <button disabled={busy || !org.entitlement.canEdit} onClick={() => void connectGoogle()}>
          Connect Google account
        </button>
        <button disabled={busy} onClick={() => void act(() => refresh(), 'Connections refreshed.')}>
          Refresh connections
        </button>
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
