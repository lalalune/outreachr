import '@fontsource-variable/inter';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import React, { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../../desktop/src/renderer/src/App';
import { AgentPage } from '../../desktop/src/renderer/src/pages/AgentPage';
import { HashRouter } from '../../desktop/src/renderer/src/lib/router';
import { WorkspaceProvider } from '../../desktop/src/renderer/src/state/WorkspaceContext';
import '../../desktop/src/renderer/src/styles/global.css';
import { ApiError, api, createBridge, post } from './bridge';
import type { Account } from './types';
import { Settings } from './Settings';
import './styles.css';

const storedTheme = localStorage.getItem('outreachr.theme');
document.documentElement.dataset.theme =
  storedTheme === 'dark' || storedTheme === 'system' ? storedTheme : 'light';

function CloudApp() {
  const [account, setAccount] = useState<Account | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const invite = new URLSearchParams(window.location.search).get('invite');
  const orgId = localStorage.getItem('outreachr.cloud.org');
  const org =
    account?.organizations.find((item) => item.id === orgId) ??
    account?.organizations.find((item) => item.id === account.user.defaultOrgId) ??
    account?.organizations[0];
  const reload = useCallback(async () => {
    const value = await api<Account>('/api/me');
    if (new URLSearchParams(window.location.search).get('billing') === 'return') {
      const selected =
        value.organizations.find(
          (item) => item.id === localStorage.getItem('outreachr.cloud.org'),
        ) ?? value.organizations.find((item) => item.id === value.user.defaultOrgId);
      if (selected) await post(`/api/organizations/${selected.id}/billing/refresh`, {});
      history.replaceState(null, '', '/#/settings');
      const refreshed = await api<Account>('/api/me');
      setAccount(refreshed);
      return refreshed;
    }
    setAccount(value);
    return value;
  }, []);
  useEffect(() => {
    void reload()
      .catch((cause: unknown) => {
        if (!(cause instanceof ApiError && cause.status === 401))
          setError(cause instanceof Error ? cause.message : 'Sign-in is unavailable.');
      })
      .finally(() => setLoading(false));
  }, [reload]);
  const [bridgeOrg, setBridgeOrg] = useState('');
  useEffect(() => {
    if (org && org.id !== bridgeOrg) {
      window.outreachr = createBridge(org.id);
      setBridgeOrg(org.id);
    }
  }, [org, bridgeOrg]);
  if (loading)
    return (
      <main className="cloud-landing">
        <p role="status">Loading Outreachr…</p>
      </main>
    );
  if (!account || !org)
    return (
      <main className="cloud-landing">
        <a className="cloud-wordmark" href="/">
          outreachr
        </a>
        <h1>Keep your fundraising moving.</h1>
        <p>
          Research investors, prepare outreach, and follow through with your team. Your Gmail and
          Eliza account, in one workspace.
        </p>
        <a
          className="cloud-primary"
          href={`/api/auth/login?returnTo=${encodeURIComponent(window.location.pathname + window.location.search + window.location.hash)}`}
        >
          Continue with Eliza
        </a>
        <p>Start with a 7-day free trial. No card required.</p>
        <div className="cloud-plans">
          <article>
            <h2>Sol</h2>
            <strong>
              $49 <small>/ editing seat / month</small>
            </strong>
            <p>GPT-5.6 Sol · $15 monthly AI allowance per seat</p>
          </article>
          <article>
            <h2>Astra</h2>
            <strong>
              $200 <small>/ editing seat / month</small>
            </strong>
            <p>GPT-6 Astra · $70 monthly AI allowance per seat</p>
          </article>
        </div>
        <p>
          Free viewers. One plan per workspace. Trial includes $2 of AI allowance. No automatic
          overage.
        </p>
        {error && (
          <p role="alert" className="cloud-error">
            {error} <button onClick={() => window.location.reload()}>Retry</button>
          </p>
        )}
        <footer>
          <a href="/legal/license.txt">License</a> · <a href="/legal/notice.txt">Notice</a>
        </footer>
      </main>
    );
  const changeOrg = (id: string) => {
    localStorage.setItem('outreachr.cloud.org', id);
    window.location.assign('/');
  };
  return (
    <div className="cloud-root">
      <header className="cloud-bar">
        <a href="/">outreachr</a>
        <label className="cloud-org-label">
          Workspace
          <select
            aria-label="Workspace"
            value={org.id}
            onChange={(event) => changeOrg(event.target.value)}
          >
            {account.organizations.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <button onClick={() => setCreating(!creating)}>New workspace</button>
        <span>{account.user.email}</span>
        <a href="#/settings">Workspace settings</a>
        <button
          onClick={() =>
            void post('/api/auth/logout', {})
              .then(() => window.location.assign('/'))
              .catch((cause: Error) => setError(cause.message))
          }
        >
          Sign out
        </button>
      </header>
      {error && (
        <p role="alert" className="cloud-banner cloud-error">
          {error}
        </p>
      )}
      {creating && (
        <form
          className="cloud-banner"
          onSubmit={(event) => {
            event.preventDefault();
            void post<{ id: string }>('/api/organizations', { name: newName })
              .then((result) => changeOrg(result.id))
              .catch((cause: Error) => setError(cause.message));
          }}
        >
          <label>
            Workspace name
            <input
              required
              maxLength={100}
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
            />
          </label>
          <p>
            Additional workspaces require their own subscription. Your existing trial does not
            restart.
          </p>
          <button>Create workspace</button>
        </form>
      )}
      {invite && (
        <div className="cloud-banner">
          <span>Accept the invitation using the email address it was sent to.</span>
          <button
            onClick={() =>
              void post<{ orgId: string }>('/api/invites/accept', { token: invite })
                .then(async () => {
                  await reload();
                  window.location.assign('/');
                })
                .catch((cause: Error) => setError(cause.message))
            }
          >
            Accept invitation
          </button>
        </div>
      )}
      <div className="cloud-banner">
        {org.entitlement.trial
          ? `Free trial through ${new Date(org.trial_ends_at!).toLocaleDateString()}`
          : org.entitlement.active
            ? `${org.plan === 'sol' ? 'Sol' : 'Astra'} plan`
            : 'Subscription required to edit, use AI, or send mail. Read and export remain available.'}
        {org.role === 'viewer' && ' · Viewer access'}
        <a href="#/settings">Manage workspace</a>
      </div>
      {bridgeOrg === org.id && (
        <HashRouter>
          <WorkspaceProvider key={org.id} streamingAgent>
            <App
              settingsPage={
                <Settings
                  account={account}
                  org={org}
                  reload={async () => {
                    await reload();
                  }}
                />
              }
              agentPage={
                <AgentPage
                  cloudModel={org.entitlement.model.replace('openai/', '').replace('gpt-', 'GPT-')}
                />
              }
            />
          </WorkspaceProvider>
        </HashRouter>
      )}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <CloudApp />
  </React.StrictMode>,
);
