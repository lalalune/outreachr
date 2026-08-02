import { useEffect, useMemo, useState } from 'react';
import {
  ArchiveRestore,
  Bot,
  Check,
  ChevronRight,
  CircleHelp,
  Database,
  Download,
  ExternalLink,
  KeyRound,
  Laptop,
  LockKeyhole,
  Mail,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Trash2,
  Upload,
} from 'lucide-react';
import { useLocation, useNavigate } from '../lib/router';
import type { AgentProvider, ConnectorProvider, SuppressionItem } from '../../../shared/contracts';
import {
  Badge,
  Button,
  Dialog,
  PageHeader,
  Section,
  StateDot,
  TextField,
  titleCase,
} from '../components/ui';
import { useWorkspace } from '../state/WorkspaceContext';

const sections = [
  { id: 'general', label: 'General', icon: Settings2 },
  { id: 'round', label: 'Round', icon: RefreshCw },
  { id: 'connectors', label: 'Mail & calendar', icon: Mail },
  { id: 'agents', label: 'Agents', icon: Bot },
  { id: 'data', label: 'Data & backup', icon: Database },
  { id: 'privacy', label: 'Privacy & security', icon: LockKeyhole },
  { id: 'about', label: 'About', icon: CircleHelp },
] as const;

type SectionId = (typeof sections)[number]['id'];

const officialLinks = {
  googleProject: 'https://console.cloud.google.com/projectcreate',
  googleApis: 'https://console.cloud.google.com/apis/library',
  googleConsent: 'https://console.cloud.google.com/auth/overview',
  googleAudience: 'https://console.cloud.google.com/auth/audience',
  googleDataAccess: 'https://console.cloud.google.com/auth/scopes',
  googleClients: 'https://console.cloud.google.com/auth/clients',
  googleDesktop: 'https://developers.google.com/workspace/guides/create-credentials#desktop-app',
  googleNativeOAuth: 'https://developers.google.com/identity/protocols/oauth2/native-app',
  googleConnections: 'https://myaccount.google.com/connections',
  microsoftApps:
    'https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
  microsoftRegister:
    'https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app',
  microsoftRedirect: 'https://learn.microsoft.com/en-us/entra/identity-platform/reply-url',
  microsoftPermissions: 'https://learn.microsoft.com/en-us/graph/permissions-reference',
  microsoftConnections: 'https://myapps.microsoft.com/',
  codexAuth: 'https://learn.chatgpt.com/docs/auth',
  codexCli: 'https://learn.chatgpt.com/docs/codex/cli',
  claudeApiAuth: 'https://platform.claude.com/docs/en/manage-claude/authentication',
  claudeApiKeys: 'https://console.anthropic.com/settings/keys',
  claudeAuthentication: 'https://code.claude.com/docs/en/authentication',
  claudeAgentSdk: 'https://code.claude.com/docs/en/agent-sdk/overview',
  claudeLegal: 'https://code.claude.com/docs/en/legal-and-compliance',
};

function ExternalLinkButton({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <Button
      tone="quiet"
      size="small"
      icon={<ExternalLink aria-hidden="true" />}
      onClick={() => void window.outreachr.openExternal(href)}
    >
      {children}
    </Button>
  );
}

function ConnectorSetup({ provider }: { provider: ConnectorProvider }): React.JSX.Element {
  const { data, command, notify } = useWorkspace();
  const existing = data?.connectors.find((item) => item.provider === provider);
  const [clientId, setClientId] = useState('');
  const [tenantId, setTenantId] = useState('common');
  const [relationshipSync, setRelationshipSync] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setRelationshipSync(existing?.relationshipSync ?? false);
  }, [existing?.relationshipSync]);

  const saveAndConnect = async (): Promise<void> => {
    setBusy(true);
    try {
      await command('connector.configure', {
        provider,
        clientId,
        ...(provider === 'microsoft' ? { tenantId } : {}),
        relationshipSync,
      });
      await command('connector.connect', { provider });
      notify({
        tone: 'success',
        title: `${titleCase(provider)} connected`,
        detail: 'Tokens are encrypted with the operating-system credential facility.',
      });
    } finally {
      setBusy(false);
    }
  };

  const syncCalendar = async (): Promise<void> => {
    setBusy(true);
    try {
      const result = await command('connector.syncCalendar', { provider });
      notify({
        tone: 'success',
        title: `${titleCase(provider)} calendar synced`,
        detail: `${result.meetings.length} local meeting records are now current.`,
      });
    } finally {
      setBusy(false);
    }
  };

  const syncMail = async (): Promise<void> => {
    setBusy(true);
    try {
      const result = await command('connector.syncMail', { provider });
      const unreviewed = result.mailEvents.filter(
        (event) => event.direction === 'inbound' && !event.reviewedAt,
      ).length;
      notify({
        tone: 'success',
        title: `${titleCase(provider)} relationship history synced`,
        detail: `${result.mailEvents.length} attributed metadata records · ${unreviewed} to review.`,
      });
    } finally {
      setBusy(false);
    }
  };

  const testConnection = async (): Promise<void> => {
    setBusy(true);
    try {
      await command('connector.test', { provider });
      notify({ tone: 'success', title: `${titleCase(provider)} connection verified` });
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async (): Promise<void> => {
    setBusy(true);
    try {
      await command('connector.disconnect', { provider });
      notify({
        tone: 'info',
        title: `${titleCase(provider)} disconnected locally`,
        detail:
          'Encrypted local tokens were removed. Revoke the provider grant separately if desired.',
      });
    } finally {
      setBusy(false);
    }
  };

  const diagnostic = existing?.error ? (
    <div className="setup-diagnostic" role="status">
      <Badge tone="danger">Needs attention</Badge>
      <div>
        <strong>{existing.error}</strong>
        <p>
          Review the registered client type, callback, account access, and requested scopes below,
          then reconnect. Outreachr never asks for an account password or client secret.
        </p>
      </div>
    </div>
  ) : null;

  if (existing?.state === 'connected') {
    return (
      <div className="connector-connected-shell">
        {diagnostic}
        <div className="connector-connected">
          <div>
            <StateDot tone={existing.error ? 'warning' : 'success'} label="Connected" />
            <strong>{existing.accountEmail}</strong>
            <small>{existing.scopes.join(' · ')}</small>
            <small>
              {existing.relationshipSync
                ? 'Relationship sync enabled.'
                : 'Relationship sync is off. Reconnect with it enabled before sending.'}
            </small>
          </div>
          <div>
            {existing.relationshipSync ? (
              <Button loading={busy} onClick={() => void syncMail()}>
                Sync mail history
              </Button>
            ) : null}
            <Button loading={busy} onClick={() => void syncCalendar()}>
              Sync calendar
            </Button>
            <Button loading={busy} onClick={() => void testConnection()}>
              Test connection
            </Button>
            <Button tone="danger" loading={busy} onClick={() => void disconnect()}>
              Disconnect
            </Button>
          </div>
        </div>
        <p className="settings-prose">
          Disconnect deletes Outreachr's local encrypted token. It does not revoke consent at the
          provider. Review grants in{' '}
          <ExternalLinkButton
            href={
              provider === 'google'
                ? officialLinks.googleConnections
                : officialLinks.microsoftConnections
            }
          >
            {provider === 'google' ? 'Google Account connections' : 'Microsoft My Apps'}
          </ExternalLinkButton>
          .
        </p>
      </div>
    );
  }

  return (
    <div className="connector-setup">
      <div>
        {diagnostic}
        <ol className="setup-steps">
          {provider === 'google' ? (
            <>
              <li>
                <span>1</span>
                <div>
                  <strong>Create a Google Cloud project</strong>
                  <p>
                    The public client ID belongs to this local installation. No hosted Outreachr
                    service receives it.
                  </p>
                  <ExternalLinkButton href={officialLinks.googleProject}>
                    Open project creator
                  </ExternalLinkButton>
                </div>
              </li>
              <li>
                <span>2</span>
                <div>
                  <strong>Enable Gmail and Google Calendar APIs</strong>
                  <p>
                    Gmail sends approved messages. Calendar reads availability and creates
                    founder-approved events.
                  </p>
                  <ExternalLinkButton href={officialLinks.googleApis}>
                    Open API library
                  </ExternalLinkButton>
                </div>
              </li>
              <li>
                <span>3</span>
                <div>
                  <strong>Configure branding, audience, and data access</strong>
                  <p>
                    Add your account as a test user when an External app remains in Testing. Declare
                    the scopes shown here. Google says Testing grants expire after seven days, so a
                    test-only client may require reconnecting.
                  </p>
                  <p>
                    Minimum: <code>openid</code>, <code>userinfo.email</code>,{' '}
                    <code>gmail.send</code>, <code>calendar.events.owned</code>, and{' '}
                    <code>calendar.events.freebusy</code>. Relationship sync adds{' '}
                    <code>gmail.readonly</code>.
                  </p>
                  <ExternalLinkButton href={officialLinks.googleConsent}>
                    Auth overview
                  </ExternalLinkButton>
                  <ExternalLinkButton href={officialLinks.googleAudience}>
                    Audience and test users
                  </ExternalLinkButton>
                  <ExternalLinkButton href={officialLinks.googleDataAccess}>
                    Data access
                  </ExternalLinkButton>
                </div>
              </li>
              <li>
                <span>4</span>
                <div>
                  <strong>Create a Desktop app OAuth client</strong>
                  <p>
                    Choose Desktop app and copy only its client ID. Outreachr uses the system
                    browser, PKCE, and a temporary 127.0.0.1 loopback callback. Do not paste a
                    client secret.
                  </p>
                  <ExternalLinkButton href={officialLinks.googleClients}>
                    OAuth clients
                  </ExternalLinkButton>
                  <ExternalLinkButton href={officialLinks.googleNativeOAuth}>
                    Desktop OAuth details
                  </ExternalLinkButton>
                </div>
              </li>
            </>
          ) : (
            <>
              <li>
                <span>1</span>
                <div>
                  <strong>Register an app in Microsoft Entra</strong>
                  <p>
                    To support both work/school and personal accounts, choose “Accounts in any
                    organizational directory and personal Microsoft accounts.” Use a single-tenant
                    registration only when that restriction is intentional.
                  </p>
                  <ExternalLinkButton href={officialLinks.microsoftApps}>
                    Open Entra app registrations
                  </ExternalLinkButton>
                  <ExternalLinkButton href={officialLinks.microsoftRegister}>
                    Registration guide
                  </ExternalLinkButton>
                </div>
              </li>
              <li>
                <span>2</span>
                <div>
                  <strong>Register the exact desktop callback</strong>
                  <p>
                    Under Authentication, add Mobile and desktop applications with{' '}
                    <code>http://localhost/oauth/callback</code>, then enable public client flows.
                    The runtime adds a temporary port that Microsoft ignores for localhost. Do not
                    create a client secret.
                  </p>
                  <ExternalLinkButton href={officialLinks.microsoftRedirect}>
                    Redirect URI rules
                  </ExternalLinkButton>
                </div>
              </li>
              <li>
                <span>3</span>
                <div>
                  <strong>Add delegated Graph permissions</strong>
                  <p>
                    Add User.Read, Mail.Send, Calendars.ReadWrite, and offline_access. Relationship
                    sync adds Mail.ReadBasic; it excludes bodies and attachments and is required
                    before sending.
                  </p>
                  <ExternalLinkButton href={officialLinks.microsoftPermissions}>
                    Graph permission reference
                  </ExternalLinkButton>
                </div>
              </li>
            </>
          )}
        </ol>
      </div>
      <div className="credential-form">
        {!existing?.encryptionAvailable ? (
          <div className="setup-diagnostic" role="status">
            <Badge tone="danger">Credential storage unavailable</Badge>
            <p>
              Unlock or install an operating-system secret service, restart Outreachr, and try
              again. The app refuses plaintext token storage.
            </p>
          </div>
        ) : null}
        <TextField
          label="Application (client) ID"
          value={clientId}
          onChange={(event) => setClientId(event.target.value)}
          placeholder="Paste the provider-issued client ID"
          hint="This identifier is public configuration. Never paste a client secret or account password."
          autoComplete="off"
          spellCheck={false}
        />
        {provider === 'microsoft' ? (
          <TextField
            label="Tenant"
            value={tenantId}
            onChange={(event) => setTenantId(event.target.value)}
            hint="Use common for a multi-tenant registration that includes personal accounts; use the Directory (tenant) ID for a single-tenant registration."
            autoComplete="off"
            spellCheck={false}
          />
        ) : null}
        <label className="check-row">
          <input
            type="checkbox"
            checked={relationshipSync}
            onChange={(event) => setRelationshipSync(event.target.checked)}
          />
          <span>
            <strong>Enable relationship sync</strong>
            <small>
              Research-only use can leave this off; sending requires it. Outreachr retains headers
              for known relationships plus unmatched outbound headers for later contact matching,
              and discards unrelated inbound mail, every body, and every attachment.
            </small>
          </span>
        </label>
        <Button
          tone="primary"
          loading={busy}
          disabled={!clientId.trim() || !existing?.encryptionAvailable}
          onClick={() => void saveAndConnect()}
        >
          Save and connect in browser
        </Button>
      </div>
    </div>
  );
}

function AgentsSettings(): React.JSX.Element {
  const { data, command, notify } = useWorkspace();
  const [busy, setBusy] = useState<AgentProvider | null>(null);
  const [claudeApiKey, setClaudeApiKey] = useState('');
  const [claudeApiKeyError, setClaudeApiKeyError] = useState<string | undefined>();
  const [claudeApprovalConfirmed, setClaudeApprovalConfirmed] = useState(false);
  const encryptionAvailable = data?.connectors.some((item) => item.encryptionAvailable) ?? false;

  const detect = async (provider: AgentProvider): Promise<void> => {
    setBusy(provider);
    try {
      const status = await command('agent.detect', { provider });
      const detail = status.error ?? status.version;
      notify({
        tone: status.state === 'ready' ? 'success' : 'info',
        title: `${titleCase(provider)}: ${titleCase(status.state)}`,
        ...(detail ? { detail } : {}),
      });
    } finally {
      setBusy(null);
    }
  };

  const login = async (provider: AgentProvider): Promise<void> => {
    setBusy(provider);
    try {
      const status = await command('agent.login', { provider });
      notify({
        tone: status.state === 'ready' ? 'success' : 'info',
        title:
          status.state === 'ready'
            ? `${titleCase(provider)} is ready`
            : `${titleCase(provider)} setup guidance`,
        detail:
          status.error ??
          (provider === 'codex'
            ? 'Finish the official browser flow, then select Detect.'
            : status.subscriptionAuthApproved
              ? 'Run claude auth login --claudeai in a terminal, finish Anthropic sign-in, then select Detect.'
              : 'Create an Anthropic API key, save it in this page, then select Detect.'),
      });
    } finally {
      setBusy(null);
    }
  };

  const logout = async (provider: AgentProvider): Promise<void> => {
    setBusy(provider);
    try {
      const status = await command('agent.logout', { provider });
      notify({
        tone: 'info',
        title: `${titleCase(provider)} signed out`,
        ...(status.error ? { detail: status.error } : {}),
      });
    } finally {
      setBusy(null);
    }
  };

  const saveClaudeApiKey = async (): Promise<void> => {
    const credential = claudeApiKey.trim();
    if (credential.length < 20 || credential.length > 1_000 || /\s/u.test(credential)) {
      setClaudeApiKeyError('Enter a 20–1,000 character API key with no spaces.');
      return;
    }
    setBusy('claude');
    setClaudeApiKeyError(undefined);
    try {
      const status = await command('agent.credential.set', { provider: 'claude', credential });
      notify({
        tone: status.state === 'ready' ? 'success' : 'info',
        title: status.state === 'ready' ? 'Claude API key saved' : 'Claude API key stored',
        detail:
          status.state === 'ready'
            ? 'The encrypted key is active on this device.'
            : (status.error ?? 'Install or detect the bundled Claude runtime to finish setup.'),
      });
    } finally {
      setClaudeApiKey('');
      setBusy(null);
    }
  };

  const removeClaudeApiKey = async (): Promise<void> => {
    setClaudeApiKey('');
    setClaudeApiKeyError(undefined);
    setBusy('claude');
    try {
      const status = await command('agent.credential.remove', { provider: 'claude' });
      notify({
        tone: 'info',
        title: 'Stored Claude API key removed',
        ...(status.error ? { detail: status.error } : {}),
      });
    } finally {
      setBusy(null);
    }
  };

  const setClaudeSubscriptionAccess = async (approved: boolean): Promise<void> => {
    if (approved && !claudeApprovalConfirmed) return;
    setBusy('claude');
    try {
      const status = approved
        ? await command('agent.subscription.set', {
            provider: 'claude',
            approved: true,
            approvalConfirmed: true,
          })
        : await command('agent.subscription.set', { provider: 'claude', approved: false });
      notify({
        tone: approved ? 'success' : 'info',
        title: approved
          ? 'Claude subscription access enabled'
          : 'Claude subscription access disabled',
        detail: approved
          ? status.state === 'ready'
            ? 'The official local Claude Code session is ready. Outreachr does not receive its token.'
            : (status.error ??
              'Run claude auth login --claudeai in a terminal, then return and select Detect.')
          : 'Outreachr stopped using the local Claude subscription session without signing Claude Code out.',
      });
    } finally {
      setClaudeApprovalConfirmed(false);
      setBusy(null);
    }
  };

  return (
    <div className="agent-settings-list">
      {(data?.agents ?? []).map((agent) => (
        <article key={agent.provider}>
          <div className="agent-settings-list__identity">
            <span aria-hidden="true">{agent.provider === 'codex' ? 'C' : 'A'}</span>
            <div>
              <strong>{agent.provider === 'codex' ? 'OpenAI Codex' : 'Anthropic Claude'}</strong>
              <small>
                {agent.provider === 'codex'
                  ? 'Embedded app-server with ChatGPT plan authentication'
                  : 'Local Agent SDK with an API key or approved subscription access'}
              </small>
            </div>
          </div>
          <StateDot
            tone={
              agent.state === 'ready' ? 'success' : agent.state === 'error' ? 'danger' : 'warning'
            }
            label={titleCase(agent.state)}
          />
          <div className="agent-settings-list__actions">
            <Button loading={busy === agent.provider} onClick={() => void detect(agent.provider)}>
              Detect
            </Button>
            {agent.provider === 'codex' && agent.state === 'ready' ? (
              <Button
                tone="danger"
                loading={busy === agent.provider}
                onClick={() => void logout(agent.provider)}
              >
                Sign out
              </Button>
            ) : agent.provider === 'codex' ? (
              <Button
                tone="primary"
                loading={busy === agent.provider}
                onClick={() => void login(agent.provider)}
              >
                Sign in
              </Button>
            ) : agent.subscriptionAuthApproved && agent.state !== 'ready' ? (
              <Button
                tone="primary"
                loading={busy === agent.provider}
                onClick={() => void login(agent.provider)}
              >
                Sign-in guidance
              </Button>
            ) : null}
          </div>
          <div className="agent-settings-list__detail">
            {agent.provider === 'codex' ? (
              <>
                <p>
                  Outreachr ships the official Codex sidecar, starts `codex app-server` locally, and
                  opens the official ChatGPT sign-in page. Finish the browser flow, return here, and
                  select Detect. Credentials remain in the Codex OS keyring.
                </p>
                <ExternalLinkButton href={officialLinks.codexAuth}>
                  Codex authentication
                </ExternalLinkButton>
                <ExternalLinkButton href={officialLinks.codexCli}>
                  Codex CLI guide
                </ExternalLinkButton>
              </>
            ) : (
              <>
                <p>
                  Outreachr ships the official Claude Agent SDK sidecar. API-key authentication is
                  the default. A local Claude subscription can be used only when Anthropic has
                  approved this third-party integration and the founder explicitly enables it.
                </p>
                <ExternalLinkButton href={officialLinks.claudeAgentSdk}>
                  Agent SDK authentication policy
                </ExternalLinkButton>
                <ExternalLinkButton href={officialLinks.claudeAuthentication}>
                  Claude Code authentication
                </ExternalLinkButton>
                <ExternalLinkButton href={officialLinks.claudeLegal}>
                  Anthropic legal guidance
                </ExternalLinkButton>

                <fieldset className="agent-auth-form">
                  <legend>Claude subscription</legend>
                  <p>
                    Use the official Claude sign-in already present on this device. Subscription
                    access is off by default and may be enabled only for an Outreachr deployment
                    Anthropic has approved. Approval for one deployment may not transfer to a fork.
                  </p>
                  <p>
                    Outreachr never asks for, copies, stores, returns, or logs your Claude OAuth
                    token. The official local runtime owns sign-in and refresh. Setup tokens remain
                    unsupported, and disabling this mode does not sign you out of Claude Code.
                  </p>
                  <p>
                    Agent SDK use draws from your plan's separate Agent SDK credit under Anthropic's
                    current limits.
                  </p>
                  {agent.subscriptionAuthApproved ? (
                    <div className="setup-diagnostic" role="status">
                      <Badge tone={agent.state === 'ready' ? 'success' : 'warning'}>
                        Subscription enabled by founder
                      </Badge>
                      <p>
                        {agent.state === 'ready'
                          ? 'The official local Claude Code session is ready.'
                          : 'Run claude auth login --claudeai in a terminal, finish Anthropic sign-in, then select Detect.'}
                      </p>
                    </div>
                  ) : (
                    <label className="check-row">
                      <input
                        type="checkbox"
                        checked={claudeApprovalConfirmed}
                        onChange={(event) => setClaudeApprovalConfirmed(event.target.checked)}
                        disabled={busy === 'claude'}
                      />
                      <span>
                        <strong>I confirm Anthropic approved this Outreachr deployment</strong>
                        <small>
                          This is a founder attestation, not an approval check performed by
                          Outreachr.
                        </small>
                      </span>
                    </label>
                  )}
                  <div className="agent-credential-form__actions">
                    {agent.subscriptionAuthApproved ? (
                      <Button
                        tone="danger"
                        loading={busy === 'claude'}
                        onClick={() => void setClaudeSubscriptionAccess(false)}
                      >
                        Disable subscription access
                      </Button>
                    ) : (
                      <Button
                        tone="primary"
                        loading={busy === 'claude'}
                        disabled={!claudeApprovalConfirmed}
                        onClick={() => void setClaudeSubscriptionAccess(true)}
                      >
                        Enable subscription access
                      </Button>
                    )}
                    {agent.subscriptionAuthApproved && agent.state !== 'ready' ? (
                      <Button loading={busy === 'claude'} onClick={() => void login('claude')}>
                        Show sign-in command
                      </Button>
                    ) : null}
                  </div>
                </fieldset>

                <div className="agent-credential-form">
                  <strong>Anthropic API key</strong>
                  <p>
                    API use is optional and may incur charges from Anthropic. Saving a key makes
                    API-key mode active and disables subscription mode without deleting the
                    independent Claude Code login.
                  </p>
                  <ExternalLinkButton href={officialLinks.claudeApiKeys}>
                    Create API key
                  </ExternalLinkButton>
                  <ExternalLinkButton href={officialLinks.claudeApiAuth}>
                    API authentication
                  </ExternalLinkButton>
                  {!encryptionAvailable ? (
                    <div className="setup-diagnostic" role="status">
                      <Badge tone="danger">Credential storage unavailable</Badge>
                      <p>
                        Unlock or install an operating-system secret service, restart Outreachr, and
                        try again. The app refuses plaintext API-key storage.
                      </p>
                    </div>
                  ) : null}
                  <TextField
                    label="Anthropic API key"
                    type="password"
                    name="outreachr-anthropic-api-key"
                    autoComplete="new-password"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    value={claudeApiKey}
                    onChange={(event) => {
                      setClaudeApiKey(event.target.value);
                      if (claudeApiKeyError) setClaudeApiKeyError(undefined);
                    }}
                    {...(claudeApiKeyError ? { error: claudeApiKeyError } : {})}
                    hint="Write-only setup: this field clears after every save attempt. The key is encrypted with the operating-system credential facility, never returned after save, never logged, and never stored as plaintext in SQLite."
                    placeholder="Paste a founder-owned API key"
                    disabled={busy === 'claude' || !encryptionAvailable}
                  />
                  <div className="agent-credential-form__actions">
                    <Button
                      tone="primary"
                      loading={busy === 'claude'}
                      disabled={!encryptionAvailable || !claudeApiKey.trim()}
                      onClick={() => void saveClaudeApiKey()}
                    >
                      Save encrypted API key
                    </Button>
                    <Button
                      tone="danger"
                      loading={busy === 'claude'}
                      onClick={() => void removeClaudeApiKey()}
                    >
                      Remove stored API key
                    </Button>
                  </div>
                </div>
              </>
            )}
            {agent.error ? (
              <div className="setup-diagnostic" role="status">
                <Badge tone={agent.state === 'error' ? 'danger' : 'warning'}>
                  {agent.state === 'not_installed' ? 'Install required' : 'Next step'}
                </Badge>
                <p>{agent.error}</p>
              </div>
            ) : null}
          </div>
        </article>
      ))}
    </div>
  );
}

function CommunicationSafety(): React.JSX.Element {
  const { data, command, notify } = useWorkspace();
  const [dailyLimit, setDailyLimit] = useState(data?.communicationPolicy.dailySendLimit ?? 10);
  const [hourlyLimit, setHourlyLimit] = useState(data?.communicationPolicy.hourlySendLimit ?? 3);
  const [domainDailyLimit, setDomainDailyLimit] = useState(
    data?.communicationPolicy.recipientDomainDailyLimit ?? 2,
  );
  const [domainCooldown, setDomainCooldown] = useState(
    data?.communicationPolicy.recipientDomainCooldownMinutes ?? 30,
  );
  const [postalAddress, setPostalAddress] = useState(data?.communicationPolicy.postalAddress ?? '');
  const [optOutText, setOptOutText] = useState(data?.communicationPolicy.optOutText ?? '');
  const [scope, setScope] = useState<SuppressionItem['scope']>('email');
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('Do not contact');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (data) {
      setDailyLimit(data.communicationPolicy.dailySendLimit);
      setHourlyLimit(data.communicationPolicy.hourlySendLimit);
      setDomainDailyLimit(data.communicationPolicy.recipientDomainDailyLimit);
      setDomainCooldown(data.communicationPolicy.recipientDomainCooldownMinutes);
      setPostalAddress(data.communicationPolicy.postalAddress ?? '');
      setOptOutText(data.communicationPolicy.optOutText);
    }
  }, [data]);

  if (!data) return <></>;
  const policy = data.communicationPolicy;
  const activeSuppressions = data.suppressions.filter((item) => item.active);

  const updatePolicy = async (sendingPaused: boolean, saveEdits = true): Promise<void> => {
    setBusy(true);
    try {
      await command('communications.policy.update', {
        sendingPaused,
        dailySendLimit: saveEdits ? dailyLimit : policy.dailySendLimit,
        hourlySendLimit: saveEdits ? hourlyLimit : policy.hourlySendLimit,
        recipientDomainDailyLimit: saveEdits ? domainDailyLimit : policy.recipientDomainDailyLimit,
        recipientDomainCooldownMinutes: saveEdits
          ? domainCooldown
          : policy.recipientDomainCooldownMinutes,
        postalAddress: saveEdits ? postalAddress.trim() || null : policy.postalAddress,
        optOutText: saveEdits ? optOutText.trim() : policy.optOutText,
      });
      notify({
        tone: 'success',
        title: sendingPaused ? 'All sending paused' : 'Communication safety updated',
        detail: saveEdits
          ? `Daily ${dailyLimit} · hourly ${hourlyLimit} · per-domain daily ${domainDailyLimit}. Active approvals were revoked if policy changed.`
          : 'The saved communication policy was preserved. Active approvals were revoked because the pause state changed.',
      });
    } finally {
      setBusy(false);
    }
  };

  const add = async (): Promise<void> => {
    const suppressionValue = scope === 'global' ? '*' : value.trim();
    if (!suppressionValue || !reason.trim()) return;
    setBusy(true);
    try {
      await command('suppression.add', { scope, value: suppressionValue, reason: reason.trim() });
      setValue('');
      notify({
        tone: 'success',
        title: 'Suppression added',
        detail: `${titleCase(scope)} · ${suppressionValue}`,
      });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string): Promise<void> => {
    setBusy(true);
    try {
      await command('suppression.remove', { id });
      notify({ tone: 'success', title: 'Suppression deactivated' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="communication-safety">
      <div
        className={`communication-policy ${policy.sendingPaused ? 'communication-policy--paused' : !policy.postalAddress ? 'communication-policy--incomplete' : ''}`}
      >
        <div>
          <StateDot
            tone={policy.sendingPaused ? 'danger' : policy.postalAddress ? 'success' : 'warning'}
            label={
              policy.sendingPaused
                ? 'Sending paused'
                : policy.postalAddress
                  ? 'Policy configured'
                  : 'Sender address required'
            }
          />
          <p>
            {policy.reservedToday} of {policy.dailySendLimit} founder-approved sends reserved today.
            {` ${policy.reservedThisHour} of ${policy.hourlySendLimit} reserved in the last hour.`}
            Database triggers enforce these limits, the pause state, the footer, and domain pacing.
          </p>
        </div>
        <div className="communication-policy__controls">
          <label className="field">
            <span className="field__label">Daily hard limit</span>
            <input
              className="input"
              type="number"
              min={1}
              max={50}
              value={dailyLimit}
              onChange={(event) =>
                setDailyLimit(Math.max(1, Math.min(50, Number(event.target.value) || 1)))
              }
            />
          </label>
          <label className="field">
            <span className="field__label">Hourly hard limit</span>
            <input
              className="input"
              type="number"
              min={1}
              max={20}
              value={hourlyLimit}
              onChange={(event) =>
                setHourlyLimit(Math.max(1, Math.min(20, Number(event.target.value) || 1)))
              }
            />
          </label>
          <label className="field">
            <span className="field__label">Per-domain daily limit</span>
            <input
              className="input"
              type="number"
              min={1}
              max={20}
              value={domainDailyLimit}
              onChange={(event) =>
                setDomainDailyLimit(Math.max(1, Math.min(20, Number(event.target.value) || 1)))
              }
            />
          </label>
          <label className="field">
            <span className="field__label">Domain cooldown (minutes)</span>
            <input
              className="input"
              type="number"
              min={1}
              max={1440}
              value={domainCooldown}
              onChange={(event) =>
                setDomainCooldown(Math.max(1, Math.min(1440, Number(event.target.value) || 1)))
              }
            />
          </label>
          <Button
            loading={busy}
            tone={policy.sendingPaused ? 'primary' : 'danger'}
            onClick={() => void updatePolicy(!policy.sendingPaused, false)}
          >
            {policy.sendingPaused ? 'Resume founder-approved sends' : 'Pause all sending'}
          </Button>
          <Button
            loading={busy}
            disabled={!optOutText.trim()}
            onClick={() => void updatePolicy(policy.sendingPaused)}
          >
            Save communication policy
          </Button>
        </div>
      </div>
      <div className="communication-footer-settings">
        <div>
          <strong>Visible sender footer</strong>
          <p>
            New drafts append these exact local values. Approval and sending remain blocked when
            either value is absent from the body.
          </p>
        </div>
        <label className="field">
          <span className="field__label">Sender postal address</span>
          <textarea
            className="textarea"
            value={postalAddress}
            onChange={(event) => setPostalAddress(event.target.value)}
            placeholder={'Street address\nCity, state ZIP\nUnited States'}
          />
          <span className="field__hint">
            Use an address you are permitted to publish in individual outreach email.
          </span>
        </label>
        <label className="field">
          <span className="field__label">Opt-out wording</span>
          <textarea
            className="textarea"
            value={optOutText}
            onChange={(event) => setOptOutText(event.target.value)}
          />
          <span className="field__hint">
            This exact sentence must remain visible in every approved message body.
          </span>
        </label>
        <div className="communication-footer-preview">
          <strong>Required footer fields</strong>
          <pre>{`—\n${postalAddress.trim() || 'Sender postal address required'}\n${optOutText.trim() || 'Opt-out wording required'}`}</pre>
        </div>
        <p className="settings-prose">
          Outreachr enforces the founder’s configured controls; it does not certify legal or
          deliverability compliance. Review applicable requirements and your provider’s SPF, DKIM,
          and DMARC setup before sending.
        </p>
      </div>
      <div className="suppression-form">
        <label className="field">
          <span className="field__label">Block by</span>
          <select
            className="select"
            value={scope}
            onChange={(event) => setScope(event.target.value as SuppressionItem['scope'])}
          >
            <option value="email">Email</option>
            <option value="domain">Domain</option>
            <option value="person">Canonical person ID</option>
            <option value="firm">Investor ID</option>
            <option value="global">Everyone</option>
          </select>
        </label>
        {scope !== 'global' ? (
          <TextField
            label="Value"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder={
              scope === 'email'
                ? 'person@firm.com'
                : scope === 'domain'
                  ? 'firm.com'
                  : 'Canonical local ID'
            }
          />
        ) : (
          <div className="suppression-global-note">
            <strong>Global suppression</strong>
            <small>This blocks every send until deactivated.</small>
          </div>
        )}
        <TextField
          label="Reason"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
        <Button
          loading={busy}
          disabled={(scope !== 'global' && !value.trim()) || !reason.trim()}
          onClick={() => void add()}
        >
          Add suppression
        </Button>
      </div>
      {activeSuppressions.length ? (
        <div className="suppression-list" aria-label="Active communication suppressions">
          {activeSuppressions.map((item) => (
            <div key={item.id}>
              <span>
                <strong>
                  {titleCase(item.scope)} · {item.value}
                </strong>
                <small>
                  {item.reason} · {titleCase(item.source)}
                </small>
              </span>
              <Button
                tone="quiet"
                size="small"
                disabled={busy}
                onClick={() => void remove(item.id)}
              >
                Deactivate
              </Button>
            </div>
          ))}
        </div>
      ) : (
        <p className="settings-prose">
          No active founder, bounce, complaint, or policy suppressions.
        </p>
      )}
    </div>
  );
}

export function SettingsPage(): React.JSX.Element {
  const { data, command, notify } = useWorkspace();
  const location = useLocation();
  const navigate = useNavigate();
  const pathSection = location.pathname.split('/')[2] as SectionId | undefined;
  const active = sections.some((item) => item.id === pathSection) ? pathSection! : 'general';
  const [backupOpen, setBackupOpen] = useState(false);
  const [backupPassword, setBackupPassword] = useState('');
  const [restorePath, setRestorePath] = useState<string | null>(null);
  const [restorePassword, setRestorePassword] = useState('');
  const [resetOpen, setResetOpen] = useState(false);
  const [resetConfirmation, setResetConfirmation] = useState('');
  const [roundOpen, setRoundOpen] = useState(false);
  const [roundStage, setRoundStage] = useState<'pre_seed' | 'seed' | 'series_a'>('seed');
  const [roundTarget, setRoundTarget] = useState(0);
  const [roundCheckMin, setRoundCheckMin] = useState<number | null>(null);
  const [roundCheckMax, setRoundCheckMax] = useState<number | null>(null);
  const [roundSectors, setRoundSectors] = useState('');
  const [roundGeographies, setRoundGeographies] = useState('');
  const [roundNarrative, setRoundNarrative] = useState('');
  const [roundStatus, setRoundStatus] = useState<'planning' | 'active' | 'paused' | 'closed'>(
    'active',
  );
  const [theme, setTheme] = useState<'light' | 'dark' | 'system'>(() => {
    const stored = window.localStorage.getItem('outreachr.theme');
    return stored === 'dark' || stored === 'system' ? stored : 'light';
  });
  const encryptionAvailable = useMemo(
    () => data?.connectors.every((item) => item.encryptionAvailable) ?? false,
    [data],
  );
  useEffect(() => {
    window.localStorage.setItem('outreachr.theme', theme);
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  if (!data) return <></>;

  const closeBackup = (): void => {
    setBackupOpen(false);
    setBackupPassword('');
  };

  const closeRestore = (): void => {
    setRestorePath(null);
    setRestorePassword('');
  };

  const closeReset = (): void => {
    setResetOpen(false);
    setResetConfirmation('');
  };

  const backup = async (): Promise<void> => {
    const directory = await window.outreachr.selectDirectory();
    if (!directory) return;
    const result = await command('backup.export', { directory, password: backupPassword });
    closeBackup();
    notify({ tone: 'success', title: 'Encrypted backup created', detail: result.path });
  };

  const chooseRestore = async (): Promise<void> => {
    const path = await window.outreachr.selectFile([
      { name: 'Outreachr encrypted backup', extensions: ['outreachr-backup'] },
    ]);
    if (path) setRestorePath(path);
  };

  const restore = async (): Promise<void> => {
    if (!restorePath) return;
    await command('backup.restore', { path: restorePath, password: restorePassword });
    closeRestore();
    notify({
      tone: 'success',
      title: 'Encrypted backup restored',
      detail: 'SQLite integrity and foreign keys passed.',
    });
  };

  const importSeed = async (): Promise<void> => {
    const path = await window.outreachr.selectFile([
      { name: 'Outreachr SQLite seed', extensions: ['sqlite', 'db'] },
    ]);
    if (!path) return;
    const result = await command('data.importSeed', { path });
    notify({
      tone: 'success',
      title: 'Seed import complete',
      detail: `${result.imported} imported · ${result.skipped} already present`,
    });
  };

  const exportPrivate = async (): Promise<void> => {
    const directory = await window.outreachr.selectDirectory();
    if (!directory) return;
    const result = await command('data.exportCsv', { directory, kind: 'investors' });
    notify({ tone: 'success', title: 'Investor CSV exported', detail: result.path });
  };

  const exportPublic = async (): Promise<void> => {
    const directory = await window.outreachr.selectDirectory();
    if (!directory) return;
    const result = await command('contribution.export', { directory });
    notify({
      tone: 'success',
      title: 'Privacy-safe contribution exported',
      detail: result.databasePath,
    });
  };

  const exportAudit = async (): Promise<void> => {
    const directory = await window.outreachr.selectDirectory();
    if (!directory) return;
    const result = await command('data.exportCsv', { directory, kind: 'activity' });
    notify({ tone: 'success', title: 'Hash-chained audit log exported', detail: result.path });
  };

  const openRound = (): void => {
    if (!data.round) return;
    setRoundStage(data.round.stage);
    setRoundTarget(data.round.targetAmount);
    setRoundCheckMin(data.round.targetCheck.minimum);
    setRoundCheckMax(data.round.targetCheck.maximum);
    setRoundSectors(data.round.sectors.join(', '));
    setRoundGeographies(data.round.geographies.join(', '));
    setRoundNarrative(data.round.narrative);
    setRoundStatus(data.round.status);
    setRoundOpen(true);
  };

  const saveRound = async (): Promise<void> => {
    await command('round.update', {
      stage: roundStage,
      targetAmount: roundTarget,
      targetCheckMinimum: roundCheckMin,
      targetCheckMaximum: roundCheckMax,
      sectors: roundSectors
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
      geographies: roundGeographies
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
      narrative: roundNarrative,
      status: roundStatus,
    });
    setRoundOpen(false);
    notify({ tone: 'success', title: 'Round strategy updated' });
  };

  const resetVault = async (): Promise<void> => {
    await command('data.reset', { confirmation: 'DELETE' });
    notify({
      tone: 'info',
      title: 'Restarting with a fresh local vault',
      detail: 'The exact SQLite vault will be removed before the new workspace is created.',
    });
  };

  return (
    <div className="page settings-page">
      <PageHeader
        title="Settings"
        description="Founder-controlled credentials, local data, agent access, and round defaults."
      />
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          {sections.map(({ id, label, icon: Icon }) => (
            <button
              className={active === id ? 'settings-nav__active' : ''}
              key={id}
              onClick={() => navigate(`/settings/${id}`)}
            >
              <Icon aria-hidden="true" />
              {label}
              <ChevronRight aria-hidden="true" />
            </button>
          ))}
        </nav>
        <div className="settings-content">
          {active === 'general' ? (
            <>
              <Section
                title="Application"
                description="The desktop app and vault are independent of any hosted Outreachr account."
              >
                <dl className="settings-facts">
                  <div>
                    <dt>Version</dt>
                    <dd>{data.appVersion}</dd>
                  </div>
                  <div>
                    <dt>Platform</dt>
                    <dd>{data.platform}</dd>
                  </div>
                  <div>
                    <dt>Vault</dt>
                    <dd className="mono">{data.vaultPath}</dd>
                  </div>
                  <div>
                    <dt>Seed</dt>
                    <dd>
                      {data.seedVersion} · {data.seedSignatureStatus}
                    </dd>
                  </div>
                </dl>
              </Section>
              <Section title="Appearance">
                <label className="field">
                  <span className="field__label">Theme</span>
                  <select
                    className="select"
                    value={theme}
                    onChange={(event) => setTheme(event.target.value as typeof theme)}
                  >
                    <option value="light">Light</option>
                    <option value="system">Follow system</option>
                    <option value="dark">Dark</option>
                  </select>
                  <span className="field__hint">
                    Stored only on this device. System mode follows the operating-system preference.
                  </span>
                </label>
              </Section>
            </>
          ) : null}
          {active === 'round' ? (
            <>
              <Section title="Active round">
                <dl className="settings-facts">
                  <div>
                    <dt>Company</dt>
                    <dd>{data.round?.companyName ?? 'Not set'}</dd>
                  </div>
                  <div>
                    <dt>Stage</dt>
                    <dd>{data.round ? titleCase(data.round.stage) : 'Not set'}</dd>
                  </div>
                  <div>
                    <dt>Status</dt>
                    <dd>{data.round?.status ?? 'Not set'}</dd>
                  </div>
                  <div>
                    <dt>Target</dt>
                    <dd>
                      {data.round?.targetAmount.toLocaleString('en-US', {
                        style: 'currency',
                        currency: 'USD',
                        maximumFractionDigits: 0,
                      })}
                    </dd>
                  </div>
                </dl>
                <Button disabled={!data.round} onClick={openRound}>
                  Edit round strategy
                </Button>
              </Section>
            </>
          ) : null}
          {active === 'connectors' ? (
            <>
              <Section
                title="Communication safety"
                description="Founder-controlled hard stops apply below the interface and before any provider request."
              >
                <CommunicationSafety />
              </Section>
              <Section
                title="Google Workspace"
                description="Gmail sending and Google Calendar, using credentials created and owned by this founder."
              >
                <ConnectorSetup provider="google" />
              </Section>
              <Section
                title="Microsoft 365"
                description="Outlook mail and Microsoft Calendar through delegated Microsoft Graph permissions."
              >
                <ConnectorSetup provider="microsoft" />
              </Section>
            </>
          ) : null}
          {active === 'agents' ? (
            <>
              <Section
                title="Local agents"
                description="Codex uses official ChatGPT sign-in; Claude uses an API key or explicitly enabled approved subscription access. Both receive typed local context and proposal-only tools."
              >
                <AgentsSettings />
              </Section>
              <Section title="Disclosure defaults">
                <p className="settings-prose">
                  Private email bodies, calendar descriptions, decks, and transcripts are selected
                  per run. You may later create a revocable durable rule after Outreachr has shown
                  the exact data class.
                </p>
              </Section>
            </>
          ) : null}
          {active === 'data' ? (
            <>
              <Section
                title="Encrypted backup"
                description="Password-protected SQLite backup with authenticated encryption."
              >
                <div className="settings-action-row">
                  <div>
                    <ArchiveRestore aria-hidden="true" />
                    <span>
                      <strong>Create or restore a portable backup</strong>
                      <small>
                        Uses memory-hard key derivation, integrity verification, and authenticated
                        encryption.
                      </small>
                    </span>
                  </div>
                  <div>
                    <Button onClick={() => void chooseRestore()}>Restore</Button>
                    <Button tone="primary" onClick={() => setBackupOpen(true)}>
                      Create backup
                    </Button>
                  </div>
                </div>
              </Section>
              <Section
                title="Audit integrity"
                description="Every security-relevant event is append-only and linked to the prior event hash."
              >
                <div className="settings-action-row">
                  <div>
                    <ShieldCheck aria-hidden="true" />
                    <span>
                      <strong>
                        {data.auditIntegrity.ok
                          ? 'Audit chain verified'
                          : 'Audit chain verification failed'}
                      </strong>
                      <small>
                        {data.auditIntegrity.entries} linked entries
                        {data.auditIntegrity.errorAt
                          ? ` · first error at sequence ${data.auditIntegrity.errorAt}`
                          : ' · no gaps or changed entries detected'}
                      </small>
                    </span>
                  </div>
                  <div>
                    <StateDot
                      tone={data.auditIntegrity.ok ? 'success' : 'danger'}
                      label={data.auditIntegrity.ok ? 'Verified' : 'Investigate'}
                    />
                    <Button onClick={() => void exportAudit()}>Export audit CSV</Button>
                  </div>
                </div>
              </Section>
              <Section title="Import and export">
                <div className="settings-action-list">
                  <button onClick={() => void importSeed()}>
                    <Upload aria-hidden="true" />
                    <span>
                      <strong>Import Outreachr seed</strong>
                      <small>
                        Verify schema and immutable package digest before changing the vault.
                      </small>
                    </span>
                    <ChevronRight />
                  </button>
                  <button onClick={() => void exportPrivate()}>
                    <Download aria-hidden="true" />
                    <span>
                      <strong>Export private investor records</strong>
                      <small>CSV for the founder’s own use.</small>
                    </span>
                    <ChevronRight />
                  </button>
                  <button onClick={() => void exportPublic()}>
                    <ShieldCheck aria-hidden="true" />
                    <span>
                      <strong>Export public contribution</strong>
                      <small>Privacy allowlist excludes every private activity table.</small>
                    </span>
                    <ChevronRight />
                  </button>
                </div>
              </Section>
            </>
          ) : null}
          {active === 'privacy' ? (
            <>
              <Section title="Credential protection">
                <div className="security-state">
                  <LockKeyhole aria-hidden="true" />
                  <div>
                    <strong>
                      {encryptionAvailable
                        ? 'Operating-system encryption is available'
                        : 'Credential persistence is disabled'}
                    </strong>
                    <p>
                      {encryptionAvailable
                        ? 'Provider tokens are encrypted in the main process. SQLite stores ciphertext and non-secret configuration only.'
                        : 'Unlock or install a supported operating-system secret service. Outreachr fails closed instead of using Electron’s insecure Linux basic_text fallback.'}
                    </p>
                  </div>
                  <StateDot
                    tone={encryptionAvailable ? 'success' : 'danger'}
                    label={encryptionAvailable ? 'Protected' : 'Unavailable'}
                  />
                </div>
              </Section>
              <Section title="Local privacy">
                <div className="settings-action-list">
                  <div className="settings-static-item">
                    <Laptop aria-hidden="true" />
                    <span>
                      <strong>No hosted workspace</strong>
                      <small>Canonical data remains on this device.</small>
                    </span>
                    <Check />
                  </div>
                  <div className="settings-static-item">
                    <KeyRound aria-hidden="true" />
                    <span>
                      <strong>Per-run agent disclosure</strong>
                      <small>Inspect what leaves the vault before an agent receives it.</small>
                    </span>
                    <Check />
                  </div>
                  <button onClick={() => setResetOpen(true)}>
                    <Trash2 aria-hidden="true" />
                    <span>
                      <strong>Delete local vault</strong>
                      <small>
                        Requires an explicit typed confirmation and restarts to a clean seed.
                      </small>
                    </span>
                    <ChevronRight />
                  </button>
                </div>
              </Section>
            </>
          ) : null}
          {active === 'about' ? (
            <>
              <Section title="Outreachr">
                <div className="about-block">
                  <div className="brand-mark brand-mark--large">O</div>
                  <div>
                    <h2>Free, local, open source.</h2>
                    <p>
                      Apache-2.0 first-party code and documentation. Investor data retains its
                      actual source rights.
                    </p>
                    <Badge tone="accent">Version {data.appVersion}</Badge>
                  </div>
                </div>
              </Section>
              <Section title="Support and legal">
                <div className="settings-action-list">
                  <button onClick={() => void window.outreachr.openLegal('license')}>
                    <ExternalLink />
                    <span>
                      <strong>Apache-2.0 license</strong>
                      <small>Open the exact first-party license shipped with this build.</small>
                    </span>
                    <ChevronRight />
                  </button>
                  <button onClick={() => void window.outreachr.openLegal('third-party')}>
                    <ExternalLink />
                    <span>
                      <strong>Third-party notices</strong>
                      <small>
                        Open generated dependency licenses and investor-data rights notices.
                      </small>
                    </span>
                    <ChevronRight />
                  </button>
                </div>
              </Section>
            </>
          ) : null}
        </div>
      </div>

      <Dialog
        open={backupOpen}
        onClose={closeBackup}
        title="Create encrypted backup"
        description="Use a strong password. Outreachr cannot recover it."
        footer={
          <>
            <Button tone="quiet" onClick={closeBackup}>
              Cancel
            </Button>
            <Button
              tone="primary"
              disabled={backupPassword.length < 12}
              onClick={() => void backup()}
            >
              Choose folder and encrypt
            </Button>
          </>
        }
      >
        <TextField
          label="Backup password"
          type="password"
          value={backupPassword}
          onChange={(event) => setBackupPassword(event.target.value)}
          hint="At least 12 characters. The password never leaves this device."
        />
      </Dialog>
      <Dialog
        open={Boolean(restorePath)}
        onClose={closeRestore}
        title="Restore encrypted backup"
        description="The selected backup is decrypted, migrated if needed, and checked before it replaces the current vault."
        footer={
          <>
            <Button tone="quiet" onClick={closeRestore}>
              Cancel
            </Button>
            <Button
              tone="primary"
              disabled={restorePassword.length < 12}
              onClick={() => void restore()}
            >
              Verify and restore
            </Button>
          </>
        }
      >
        <TextField
          label="Backup password"
          type="password"
          value={restorePassword}
          onChange={(event) => setRestorePassword(event.target.value)}
          {...(restorePath ? { hint: restorePath } : {})}
        />
      </Dialog>
      <Dialog
        open={resetOpen}
        onClose={closeReset}
        title="Delete the local vault?"
        description="This removes the exact SQLite vault—including private activity and encrypted connector tokens—on restart. Create an encrypted backup first if you may need this data."
        footer={
          <>
            <Button tone="quiet" onClick={closeReset}>
              Cancel
            </Button>
            <Button
              tone="danger"
              disabled={resetConfirmation !== 'DELETE'}
              onClick={() => void resetVault()}
            >
              Delete and restart
            </Button>
          </>
        }
      >
        <TextField
          label="Type DELETE to confirm"
          value={resetConfirmation}
          onChange={(event) => setResetConfirmation(event.target.value)}
          autoComplete="off"
        />
      </Dialog>
      <Dialog
        open={roundOpen}
        onClose={() => setRoundOpen(false)}
        title="Edit round strategy"
        description="Fit scores recalculate from these explicit founder preferences."
        footer={
          <>
            <Button tone="quiet" onClick={() => setRoundOpen(false)}>
              Cancel
            </Button>
            <Button
              tone="primary"
              disabled={
                roundTarget <= 0 ||
                (roundCheckMin !== null && roundCheckMax !== null && roundCheckMin > roundCheckMax)
              }
              onClick={() => void saveRound()}
            >
              Save round
            </Button>
          </>
        }
      >
        <div className="form-grid form-grid--two">
          <label className="field">
            <span className="field__label">Stage</span>
            <select
              className="select"
              value={roundStage}
              onChange={(event) => setRoundStage(event.target.value as typeof roundStage)}
            >
              <option value="pre_seed">Pre-seed</option>
              <option value="seed">Seed</option>
              <option value="series_a">Series A</option>
            </select>
          </label>
          <label className="field">
            <span className="field__label">Status</span>
            <select
              className="select"
              value={roundStatus}
              onChange={(event) => setRoundStatus(event.target.value as typeof roundStatus)}
            >
              <option value="planning">Planning</option>
              <option value="active">Active</option>
              <option value="paused">Paused</option>
              <option value="closed">Closed</option>
            </select>
          </label>
          <TextField
            label="Target raise (USD)"
            type="number"
            value={roundTarget}
            onChange={(event) => setRoundTarget(Number(event.target.value))}
          />
          <TextField
            label="Minimum useful check"
            type="number"
            value={roundCheckMin ?? ''}
            onChange={(event) =>
              setRoundCheckMin(event.target.value ? Number(event.target.value) : null)
            }
          />
          <TextField
            label="Maximum expected check"
            type="number"
            value={roundCheckMax ?? ''}
            onChange={(event) =>
              setRoundCheckMax(event.target.value ? Number(event.target.value) : null)
            }
          />
          <TextField
            label="Sector tags"
            value={roundSectors}
            onChange={(event) => setRoundSectors(event.target.value)}
          />
          <TextField
            label="Geographies"
            value={roundGeographies}
            onChange={(event) => setRoundGeographies(event.target.value)}
          />
          <label className="field field--span-two">
            <span className="field__label">Narrative</span>
            <textarea
              className="textarea"
              value={roundNarrative}
              onChange={(event) => setRoundNarrative(event.target.value)}
            />
          </label>
        </div>
      </Dialog>
    </div>
  );
}
