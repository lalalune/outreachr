import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../../src/renderer/src/App';
import { HashRouter } from '../../src/renderer/src/lib/router';
import { WorkspaceProvider } from '../../src/renderer/src/state/WorkspaceContext';
import type { ConnectorStatus } from '../../src/shared/contracts';
import { bootstrapFixture, installBridge } from './fixtures';

function renderSettings(route: '#/settings/connectors' | '#/settings/agents'): void {
  window.location.hash = route;
  render(
    <HashRouter>
      <WorkspaceProvider>
        <App />
      </WorkspaceProvider>
    </HashRouter>,
  );
}

function section(name: string): HTMLElement {
  const heading = screen.getByRole('heading', { name });
  const element = heading.closest('section');
  if (!element) throw new Error(`Missing settings section: ${name}`);
  return element;
}

describe('credential setup guidance and renderer boundary', () => {
  it('shows complete Google and Microsoft desktop OAuth requirements with official links', async () => {
    const bridge = installBridge(bootstrapFixture());
    renderSettings('#/settings/connectors');

    expect(await screen.findByRole('heading', { name: 'Google Workspace' })).toBeVisible();
    const google = section('Google Workspace');
    expect(within(google).getByText('Create a Google Cloud project')).toBeVisible();
    expect(within(google).getByText('Enable Gmail and Google Calendar APIs')).toBeVisible();
    expect(within(google).getByText('Configure branding, audience, and data access')).toBeVisible();
    expect(within(google).getByText('Create a Desktop app OAuth client')).toBeVisible();
    expect(within(google).getByText('gmail.readonly')).toBeVisible();
    expect(within(google).getByText(/Testing grants expire after seven days/u)).toBeVisible();
    fireEvent.click(within(google).getByRole('button', { name: 'Desktop OAuth details' }));
    expect(bridge.openExternal).toHaveBeenCalledWith(
      'https://developers.google.com/identity/protocols/oauth2/native-app',
    );

    const microsoft = section('Microsoft 365');
    expect(within(microsoft).getByText('Register the exact desktop callback')).toBeVisible();
    expect(within(microsoft).getByText('http://localhost/oauth/callback')).toBeVisible();
    expect(within(microsoft).getByText(/Mail\.ReadBasic/u)).toBeVisible();
    expect(
      within(microsoft).getByText(/Accounts in any organizational directory and personal/u),
    ).toBeVisible();
    fireEvent.click(within(microsoft).getByRole('button', { name: 'Redirect URI rules' }));
    expect(bridge.openExternal).toHaveBeenCalledWith(
      'https://learn.microsoft.com/en-us/entra/identity-platform/reply-url',
    );
  });

  it('passes only public connector configuration through the renderer bridge', async () => {
    const fixture = bootstrapFixture();
    const configured: ConnectorStatus = {
      ...fixture.connectors[0]!,
      state: 'configured',
      relationshipSync: true,
      scopes: [
        'openid',
        'https://www.googleapis.com/auth/userinfo.email',
        'https://www.googleapis.com/auth/gmail.send',
        'https://www.googleapis.com/auth/calendar.events.owned',
        'https://www.googleapis.com/auth/calendar.events.freebusy',
        'https://www.googleapis.com/auth/gmail.readonly',
      ],
    };
    const connected: ConnectorStatus = {
      ...configured,
      state: 'connected',
      accountEmail: 'founder@local.test',
    };
    const command = vi.fn(async (name: string, payload: Record<string, unknown>) => {
      void payload;
      if (name === 'connector.configure') return configured;
      if (name === 'connector.connect') return connected;
      throw new Error(`Unexpected command: ${name}`);
    });
    installBridge(fixture, command as never);
    renderSettings('#/settings/connectors');

    await screen.findByRole('heading', { name: 'Google Workspace' });
    const google = section('Google Workspace');
    const clientId = within(google).getByPlaceholderText('Paste the provider-issued client ID');
    expect(clientId).toHaveAttribute('autocomplete', 'off');
    expect(
      within(google).queryByPlaceholderText(/client secret|password/u),
    ).not.toBeInTheDocument();
    expect(google.querySelector('input[type="password"]')).toBeNull();
    fireEvent.change(clientId, {
      target: { value: '123456789.apps.googleusercontent.com' },
    });
    fireEvent.click(within(google).getByRole('checkbox', { name: /Enable relationship sync/u }));
    fireEvent.click(within(google).getByRole('button', { name: 'Save and connect in browser' }));

    await waitFor(() =>
      expect(command).toHaveBeenCalledWith('connector.configure', {
        provider: 'google',
        clientId: '123456789.apps.googleusercontent.com',
        relationshipSync: true,
      }),
    );
    await waitFor(() =>
      expect(command).toHaveBeenCalledWith('connector.connect', { provider: 'google' }),
    );
    for (const [, payload] of command.mock.calls) {
      expect(payload).not.toHaveProperty('clientSecret');
      expect(payload).not.toHaveProperty('accessToken');
      expect(payload).not.toHaveProperty('refreshToken');
      expect(payload).not.toHaveProperty('authorizationCode');
    }
  });

  it('keeps setup failures actionable and blocks connection without protected storage', async () => {
    const fixture = bootstrapFixture();
    fixture.connectors[0] = {
      ...fixture.connectors[0]!,
      state: 'configured',
      error: 'OAuth sign-in timed out after five minutes',
      encryptionAvailable: false,
    };
    installBridge(fixture);
    renderSettings('#/settings/connectors');

    await screen.findByRole('heading', { name: 'Google Workspace' });
    const google = section('Google Workspace');
    expect(within(google).getByText('OAuth sign-in timed out after five minutes')).toBeVisible();
    expect(within(google).getByText('Credential storage unavailable')).toBeVisible();
    expect(
      within(google).getByText(/Unlock or install an operating-system secret service/u),
    ).toBeVisible();
    fireEvent.change(within(google).getByPlaceholderText('Paste the provider-issued client ID'), {
      target: { value: 'cannot-connect.apps.googleusercontent.com' },
    });
    expect(
      within(google).getByRole('button', { name: 'Save and connect in browser' }),
    ).toBeDisabled();
  });

  it('saves and removes a Claude key through the write-only encrypted credential commands', async () => {
    const fixture = bootstrapFixture();
    const ready = {
      ...fixture.agents[1]!,
      state: 'ready' as const,
      version: '2.1.0',
      accountLabel: 'Anthropic API key',
    };
    const signedOut = { ...fixture.agents[1]!, state: 'signed_out' as const };
    const command = vi.fn(async (name: string) => {
      if (name === 'agent.credential.set') return ready;
      if (name === 'agent.credential.remove') return signedOut;
      throw new Error(`Unexpected command: ${name}`);
    });
    const bridge = installBridge(fixture, command as never);
    renderSettings('#/settings/agents');

    expect(await screen.findByRole('heading', { name: 'Local agents' })).toBeVisible();
    const agents = section('Local agents');
    expect(within(agents).getByText(/API-key authentication is the default/u)).toBeVisible();
    fireEvent.click(within(agents).getByRole('button', { name: 'Codex authentication' }));
    expect(bridge.openExternal).toHaveBeenCalledWith('https://learn.chatgpt.com/docs/auth');
    fireEvent.click(within(agents).getByRole('button', { name: 'Anthropic legal guidance' }));
    expect(bridge.openExternal).toHaveBeenCalledWith(
      'https://code.claude.com/docs/en/legal-and-compliance',
    );
    fireEvent.click(
      within(agents).getByRole('button', { name: 'Agent SDK authentication policy' }),
    );
    expect(bridge.openExternal).toHaveBeenCalledWith(
      'https://code.claude.com/docs/en/agent-sdk/overview',
    );

    const key = 'sk-ant-founder-owned-test-key-00000001';
    const keyInput = within(agents).getByPlaceholderText('Paste a founder-owned API key');
    expect(keyInput).toHaveAttribute('type', 'password');
    expect(keyInput).toHaveAttribute('autocomplete', 'new-password');
    expect(keyInput).toHaveAttribute('spellcheck', 'false');
    fireEvent.change(keyInput, { target: { value: key } });
    fireEvent.click(within(agents).getByRole('button', { name: 'Save encrypted API key' }));

    await waitFor(() =>
      expect(command).toHaveBeenCalledWith('agent.credential.set', {
        provider: 'claude',
        credential: key,
      }),
    );
    await waitFor(() => expect(keyInput).toHaveValue(''));
    expect(document.body).not.toHaveTextContent(key);
    expect(command.mock.calls.filter(([name]) => name === 'agent.credential.set')).toHaveLength(1);

    fireEvent.click(within(agents).getByRole('button', { name: 'Remove stored API key' }));
    await waitFor(() =>
      expect(command).toHaveBeenCalledWith('agent.credential.remove', { provider: 'claude' }),
    );
  });

  it('requires founder confirmation before enabling approved Claude subscription access', async () => {
    const fixture = bootstrapFixture();
    const enabled = {
      ...fixture.agents[1]!,
      state: 'signed_out' as const,
      subscriptionAuthApproved: true,
      error: 'Run claude auth login --claudeai in a terminal, then select Detect.',
    };
    const command = vi.fn(async (name: string) => {
      if (name === 'agent.subscription.set') return enabled;
      throw new Error(`Unexpected command: ${name}`);
    });
    installBridge(fixture, command as never);
    renderSettings('#/settings/agents');

    await screen.findByRole('heading', { name: 'Local agents' });
    const agents = section('Local agents');
    expect(
      within(agents).getByText(/never asks for, copies, stores, returns, or logs/u),
    ).toBeVisible();
    expect(within(agents).getByText(/separate Agent SDK credit/u)).toBeVisible();
    const enable = within(agents).getByRole('button', { name: 'Enable subscription access' });
    expect(enable).toBeDisabled();
    fireEvent.click(
      within(agents).getByRole('checkbox', {
        name: /I confirm Anthropic approved this Outreachr deployment/u,
      }),
    );
    expect(enable).toBeEnabled();
    fireEvent.click(enable);

    await waitFor(() =>
      expect(command).toHaveBeenCalledWith('agent.subscription.set', {
        provider: 'claude',
        approved: true,
        approvalConfirmed: true,
      }),
    );
    const serializedCalls = JSON.stringify(command.mock.calls);
    expect(serializedCalls).not.toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(serializedCalls).not.toContain('ANTHROPIC_API_KEY');
  });

  it('shows official sign-in guidance and can disable subscription access without global logout', async () => {
    const fixture = bootstrapFixture();
    fixture.agents[1] = {
      ...fixture.agents[1]!,
      state: 'signed_out',
      subscriptionAuthApproved: true,
      error: 'Run claude auth login --claudeai in a terminal, then select Detect.',
    };
    const disabled = {
      ...fixture.agents[1],
      subscriptionAuthApproved: false,
      error: null,
    };
    const command = vi.fn(async (name: string) => {
      if (name === 'agent.login') return fixture.agents[1]!;
      if (name === 'agent.subscription.set') return disabled;
      throw new Error(`Unexpected command: ${name}`);
    });
    installBridge(fixture, command as never);
    renderSettings('#/settings/agents');

    await screen.findByRole('heading', { name: 'Local agents' });
    const agents = section('Local agents');
    expect(within(agents).getByText('Subscription enabled by founder')).toBeVisible();
    expect(within(agents).getAllByText(/claude auth login --claudeai/u).length).toBeGreaterThan(0);
    fireEvent.click(within(agents).getByRole('button', { name: 'Show sign-in command' }));
    await waitFor(() =>
      expect(command).toHaveBeenCalledWith('agent.login', { provider: 'claude' }),
    );
    fireEvent.click(within(agents).getByRole('button', { name: 'Disable subscription access' }));
    await waitFor(() =>
      expect(command).toHaveBeenCalledWith('agent.subscription.set', {
        provider: 'claude',
        approved: false,
      }),
    );
    expect(command.mock.calls.some(([name]) => name === 'agent.logout')).toBe(false);
  });

  it('blocks Claude key entry when protected credential storage is unavailable', async () => {
    const fixture = bootstrapFixture();
    fixture.connectors = fixture.connectors.map((connector) => ({
      ...connector,
      encryptionAvailable: false,
    }));
    fixture.agents[1] = {
      ...fixture.agents[1]!,
      error:
        'Claude subscription credentials were detected but are not used. Enable Anthropic-approved subscription authentication only if Anthropic has approved this third-party integration, or configure an API key.',
    };
    installBridge(fixture);
    renderSettings('#/settings/agents');

    expect(await screen.findByRole('heading', { name: 'Local agents' })).toBeVisible();
    const agents = section('Local agents');
    expect(within(agents).getByText('Credential storage unavailable')).toBeVisible();
    expect(within(agents).getByText(/app refuses plaintext API-key storage/u)).toBeVisible();
    expect(within(agents).getByPlaceholderText('Paste a founder-owned API key')).toBeDisabled();
    expect(within(agents).getByRole('button', { name: 'Save encrypted API key' })).toBeDisabled();
    expect(
      within(agents).getByText(/Claude subscription credentials were detected but are not used/u),
    ).toBeVisible();
  });
});
