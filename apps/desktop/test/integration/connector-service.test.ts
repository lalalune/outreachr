import { readFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { GoogleConnector, InMemorySendAttemptLedger, tokenEndpoint } from '@outreachr/connectors';
import type { VaultService } from '../../src/main/vault-service';
import { ConnectorService } from '../../src/main/connector-service';
import { SecureStore } from '../../src/main/secure-store';
import { FakeSecretBackend } from '../helpers/secret-backend';
import {
  FIXED_NOW,
  firstPersonWithoutEmail,
  initializedVault,
  onboard,
  removeTemporaryDirectory,
  temporaryDirectory,
} from '../helpers/vault';

const server = setupServer();

describe('ConnectorService with MSW provider boundaries', () => {
  const directories: string[] = [];
  const vaults: VaultService[] = [];

  beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
  afterEach(async () => {
    server.resetHandlers();
    vi.restoreAllMocks();
    for (const vault of vaults.splice(0)) vault.vault.close();
    await Promise.all(directories.splice(0).map(removeTemporaryDirectory));
  });
  afterAll(() => server.close());

  async function fixture(): Promise<{
    vault: VaultService;
    secureStore: SecureStore;
    backend: FakeSecretBackend;
    connector: ConnectorService;
    openExternal: ReturnType<typeof vi.fn>;
  }> {
    const directory = await temporaryDirectory('connector');
    directories.push(directory);
    const vault = await initializedVault(directory);
    vaults.push(vault);
    await onboard(vault);
    const backend = new FakeSecretBackend();
    const secureStore = new SecureStore(vault.vault, backend);
    const openExternal = vi.fn(async () => undefined);
    const connector = new ConnectorService({
      vault,
      secureStore,
      openExternal,
      fetch,
      now: () => FIXED_NOW,
      authorizeForTest: async (request) =>
        `${request.redirectUri}?code=mock-google-code&state=${encodeURIComponent(request.state)}`,
    });
    return { vault, secureStore, backend, connector, openExternal };
  }

  function successfulGoogleHandlers(onSend?: (request: Request) => void): void {
    server.use(
      http.post(tokenEndpoint('google'), async ({ request }) => {
        const body = new URLSearchParams(await request.text());
        expect(body.get('client_id')).toBe('founder-owned-desktop-client');
        expect(body.get('grant_type')).toBe('authorization_code');
        expect(body.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43,128}$/u);
        expect(body.has('client_secret')).toBe(false);
        return HttpResponse.json({
          access_token: 'google-access',
          refresh_token: 'google-refresh',
          token_type: 'Bearer',
          expires_in: 3_600,
        });
      }),
      http.get('https://openidconnect.googleapis.com/v1/userinfo', ({ request }) => {
        expect(request.headers.get('authorization')).toBe('Bearer google-access');
        return HttpResponse.json({ email: 'founder@local.test' });
      }),
      http.get('https://gmail.googleapis.com/gmail/v1/users/me/messages', () =>
        HttpResponse.json({ messages: [] }),
      ),
      http.post(
        'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
        async ({ request }) => {
          onSend?.(request);
          const body = (await request.json()) as { raw?: string };
          expect(body.raw).toMatch(/^[A-Za-z0-9_-]+$/u);
          expect(request.headers.get('authorization')).toBe('Bearer google-access');
          return HttpResponse.json(
            { id: 'gmail-message-1', threadId: 'gmail-thread-1' },
            { headers: { 'x-request-id': 'gmail-request-1' } },
          );
        },
      ),
    );
  }

  function successfulMicrosoftHandlers(onSend?: (request: Request) => void): void {
    server.use(
      http.post(tokenEndpoint('microsoft'), async ({ request }) => {
        const body = new URLSearchParams(await request.text());
        expect(body.get('client_id')).toBe('founder-owned-microsoft-client');
        expect(body.get('grant_type')).toBe('authorization_code');
        return HttpResponse.json({
          access_token: 'microsoft-access',
          refresh_token: 'microsoft-refresh',
          token_type: 'Bearer',
          expires_in: 3_600,
        });
      }),
      http.get('https://graph.microsoft.com/v1.0/me', ({ request }) => {
        expect(request.headers.get('authorization')).toBe('Bearer microsoft-access');
        return HttpResponse.json({ mail: 'founder@microsoft.test' });
      }),
      http.get('https://graph.microsoft.com/v1.0/me/messages', () =>
        HttpResponse.json({ value: [] }),
      ),
      http.get('https://graph.microsoft.com/v1.0/me/mailFolders/sentitems/messages', () =>
        HttpResponse.json({ value: [] }),
      ),
      http.post('https://graph.microsoft.com/v1.0/me/sendMail', ({ request }) => {
        onSend?.(request);
        expect(request.headers.get('authorization')).toBe('Bearer microsoft-access');
        return new HttpResponse(null, {
          status: 202,
          headers: { 'request-id': 'graph-accepted-request' },
        });
      }),
    );
  }

  it('uses PKCE without a secret, stores encrypted OAuth tokens, and reports connected state', async () => {
    successfulGoogleHandlers();
    const { vault, connector, openExternal } = await fixture();

    const configured = await connector.configure({
      provider: 'google',
      clientId: 'founder-owned-desktop-client',
      relationshipSync: false,
    });
    expect(configured).toMatchObject({ provider: 'google', state: 'configured' });

    const connected = await connector.connect('google');
    expect(connected).toMatchObject({
      provider: 'google',
      state: 'connected',
      accountEmail: 'founder@local.test',
      relationshipSync: false,
      encryptionAvailable: true,
    });
    expect(connected.scopes).toEqual(
      expect.arrayContaining([
        'openid',
        'https://www.googleapis.com/auth/userinfo.email',
        'https://www.googleapis.com/auth/gmail.send',
      ]),
    );
    expect(connected.scopes).not.toContain('https://www.googleapis.com/auth/gmail.readonly');
    expect(openExternal).not.toHaveBeenCalled();

    const config = vault.vault.one<{
      public_config_json: string;
      secret_ref: string;
    }>('SELECT public_config_json,secret_ref FROM connector_configs WHERE provider=?', ['google']);
    expect(config?.public_config_json).toContain('founder-owned-desktop-client');
    expect(config?.public_config_json).not.toContain('google-access');
    expect(config?.secret_ref).toBe('secure-store://oauth/google/tokens');
    expect(Buffer.from(vault.vault.export()).includes(Buffer.from('google-refresh'))).toBe(false);
    await expect(connector.syncMail('google')).rejects.toThrow('relationship-sync read scope');

    await expect(connector.disconnect('google')).resolves.toMatchObject({
      provider: 'google',
      state: 'configured',
      accountEmail: null,
    });
    expect(
      Number(
        vault.vault.scalar("SELECT COUNT(*) FROM secure_secrets WHERE key='oauth/google/tokens'"),
      ),
    ).toBe(0);
    const disconnectAudit = vault.vault.one<{ detail_json: string }>(
      "SELECT detail_json FROM audit_log WHERE action='connector.disconnected' ORDER BY id DESC LIMIT 1",
    );
    expect(disconnectAudit?.detail_json).toContain('google');
    expect(disconnectAudit?.detail_json).not.toContain('founder@local.test');
    expect(disconnectAudit?.detail_json).not.toContain('founder-owned-desktop-client');
  });

  it('encrypts the Google Desktop secret and reuses it for expired-token refresh', async () => {
    successfulGoogleHandlers();
    const grants: string[] = [];
    server.use(
      http.post(tokenEndpoint('google'), async ({ request }) => {
        const body = new URLSearchParams(await request.text());
        expect(body.get('client_secret')).toBe('founder-desktop-secret');
        grants.push(body.get('grant_type')!);
        return HttpResponse.json({
          access_token: 'google-access',
          refresh_token: 'google-refresh',
          token_type: 'Bearer',
          expires_in: grants.length === 1 ? 0 : 3600,
        });
      }),
    );
    const { vault, secureStore, connector } = await fixture();
    await connector.configure({
      provider: 'google',
      clientId: 'founder-owned-desktop-client',
      clientSecret: 'founder-desktop-secret',
      relationshipSync: false,
    });
    await connector.connect('google');
    await connector.test('google');
    expect(grants).toEqual(['authorization_code', 'refresh_token']);
    expect(JSON.stringify(await vault.bootstrap())).not.toContain('founder-desktop-secret');
    expect(JSON.stringify(await connector.statuses())).not.toContain('founder-desktop-secret');
    expect(
      Buffer.from(await readFile(vault.vaultPath)).includes(Buffer.from('founder-desktop-secret')),
    ).toBe(false);
    expect(
      String(
        vault.vault.scalar('SELECT public_config_json FROM connector_configs WHERE id=?', [
          'connector:google',
        ]),
      ),
    ).not.toContain('founder-desktop-secret');
    await connector.configure({
      provider: 'google',
      clientId: 'founder-owned-desktop-client',
      relationshipSync: false,
    });
    await expect(secureStore.get('oauth/google/client')).resolves.toMatchObject({
      clientSecret: 'founder-desktop-secret',
    });
    await connector.configure({
      provider: 'google',
      clientId: 'another-client',
      relationshipSync: false,
    });
    await expect(secureStore.get('oauth/google/client')).resolves.toBeNull();
    await expect(secureStore.get('oauth/google/tokens')).resolves.toBeNull();
    await connector.configure({
      provider: 'google',
      clientId: 'another-client',
      clientSecret: 'replacement-secret',
      relationshipSync: false,
    });
    await connector.disconnect('google');
    await expect(secureStore.get('oauth/google/client')).resolves.toBeNull();
    await expect(
      connector.configure({
        provider: 'microsoft',
        clientId: 'microsoft-client',
        clientSecret: 'rejected',
        relationshipSync: false,
      }),
    ).rejects.toThrow('Microsoft desktop clients');
  });

  it('rebinds connector secrets to the authenticated replacement vault after backup restore', async () => {
    successfulGoogleHandlers();
    const { vault, secureStore, connector } = await fixture();
    const backupDirectory = await temporaryDirectory('connector-restore');
    directories.push(backupDirectory);
    await connector.configure({
      provider: 'google',
      clientId: 'founder-owned-desktop-client',
      relationshipSync: false,
    });
    await connector.connect('google');
    const backupPath = await vault.exportBackup(backupDirectory, 'correct horse battery staple');

    await connector.disconnect('google');
    expect(
      Number(
        vault.vault.scalar("SELECT COUNT(*) FROM secure_secrets WHERE key='oauth/google/tokens'"),
      ),
    ).toBe(0);
    await vault.restoreBackup(backupPath, 'correct horse battery staple');

    await expect(connector.test('google')).resolves.toMatchObject({
      provider: 'google',
      state: 'connected',
      accountEmail: 'founder@local.test',
    });
    await expect(
      secureStore.get<{ accessToken: string; refreshToken: string }>('oauth/google/tokens'),
    ).resolves.toMatchObject({ accessToken: 'google-access', refreshToken: 'google-refresh' });
    expect(vault.integrityCheck().ok).toBe(true);
  });

  it('sends one exact-approved Gmail message and database-blocks a replay', async () => {
    let gmailCalls = 0;
    successfulGoogleHandlers(() => {
      gmailCalls += 1;
    });
    const { vault, connector } = await fixture();
    await connector.configure({
      provider: 'google',
      clientId: 'founder-owned-desktop-client',
      relationshipSync: true,
    });
    await connector.connect('google');
    const person = firstPersonWithoutEmail(vault);
    await vault.addPersonContact({
      personId: person.id,
      kind: 'work_email',
      value: 'partner.send@example.test',
      visibility: 'private',
      contributionEligible: false,
    });
    const draft = await vault.createDraft({
      personId: person.id,
      provider: 'google',
      kind: 'initial',
      subject: 'Founder-approved subject',
      bodyText: 'Founder-approved body',
    });

    await expect(connector.sendApprovedDraft(draft.id, draft.contentHash)).rejects.toThrow(
      'Exact founder approval',
    );
    const approved = await vault.approveDraft(draft.id, draft.contentHash);
    const sent = await connector.sendApprovedDraft(approved.id, approved.contentHash);
    expect(sent).toMatchObject({
      approvalState: 'sent',
      providerMessageId: 'gmail-message-1',
    });
    expect(gmailCalls).toBe(1);
    expect(
      vault.vault.one<{ dispatch_status: string; provider_message_id: string }>(
        'SELECT dispatch_status,provider_message_id FROM send_ledger WHERE message_id=?',
        [draft.id],
      ),
    ).toEqual({ dispatch_status: 'sent', provider_message_id: 'gmail-message-1' });

    await expect(connector.sendApprovedDraft(approved.id, approved.contentHash)).rejects.toThrow();
    expect(gmailCalls).toBe(1);
    expect((await vault.bootstrap()).people.find((item) => item.id === person.id)).toMatchObject({
      contacted: true,
      canSendInitial: false,
    });
  });

  it('blocks provider, sender, kind, thread, and authenticated-account drift before Gmail send', async () => {
    let gmailCalls = 0;
    successfulGoogleHandlers(() => {
      gmailCalls += 1;
    });
    const { vault, connector, secureStore } = await fixture();
    await connector.configure({
      provider: 'google',
      clientId: 'founder-owned-desktop-client',
      relationshipSync: true,
    });
    await connector.connect('google');
    const person = firstPersonWithoutEmail(vault);
    await vault.addPersonContact({
      personId: person.id,
      kind: 'work_email',
      value: 'identity.guard@example.test',
      visibility: 'private',
      contributionEligible: false,
    });
    const draft = await vault.createDraft({
      personId: person.id,
      provider: 'google',
      kind: 'initial',
      subject: 'Exact delivery identity',
      bodyText: 'Every delivery-identity field is founder reviewed.',
    });
    let approved = await vault.approveDraft(draft.id, draft.contentHash);

    const mutations = [
      "provider='microsoft'",
      "sender_address='other-founder@example.test'",
      "message_kind='reply'",
      "provider_thread_id='mutated-provider-thread'",
    ];
    for (const assignment of mutations) {
      vault.vault.run(`UPDATE messages SET ${assignment},updated_at=? WHERE id=?`, [
        FIXED_NOW.toISOString(),
        draft.id,
      ]);
      const changed = (await vault.bootstrap()).drafts.find((item) => item.id === draft.id)!;
      expect(changed.approvalState).toBe('draft');
      await expect(connector.sendApprovedDraft(draft.id, changed.contentHash)).rejects.toThrow(
        'Exact founder approval',
      );
      expect(gmailCalls).toBe(0);
      expect(Number(vault.vault.scalar('SELECT COUNT(*) FROM send_ledger'))).toBe(0);
      vault.vault.run(
        "UPDATE messages SET provider='google',sender_address='founder@local.test',sender_normalized='founder@local.test',message_kind='initial',provider_thread_id=NULL,updated_at=? WHERE id=?",
        [FIXED_NOW.toISOString(), draft.id],
      );
      const restored = (await vault.bootstrap()).drafts.find((item) => item.id === draft.id)!;
      approved = await vault.approveDraft(restored.id, restored.contentHash);
    }

    await secureStore.set('oauth/google/tokens', {
      accessToken: 'google-access',
      refreshToken: 'google-refresh',
      tokenType: 'Bearer',
      expiresAt: '2026-07-31T20:00:00.000Z',
      accountEmail: 'different-authenticated-account@example.test',
    });
    await expect(connector.sendApprovedDraft(approved.id, approved.contentHash)).rejects.toThrow(
      'authenticated account does not match',
    );
    expect(gmailCalls).toBe(0);
    expect(Number(vault.vault.scalar('SELECT COUNT(*) FROM send_ledger'))).toBe(0);
  });

  it('keeps a Microsoft 202 acceptance pending reconciliation without inventing a message id', async () => {
    let sendCalls = 0;
    successfulMicrosoftHandlers(() => {
      sendCalls += 1;
    });
    const { vault, connector } = await fixture();
    await connector.configure({
      provider: 'microsoft',
      clientId: 'founder-owned-microsoft-client',
      tenantId: 'common',
      relationshipSync: true,
    });
    await connector.connect('microsoft');
    const person = firstPersonWithoutEmail(vault);
    await vault.addPersonContact({
      personId: person.id,
      kind: 'work_email',
      value: 'graph.accepted@example.test',
      visibility: 'private',
      contributionEligible: false,
    });
    const draft = await vault.createDraft({
      personId: person.id,
      provider: 'microsoft',
      kind: 'initial',
      subject: 'Graph acceptance requires reconciliation',
      bodyText: 'A 202 response is not proof of a sent provider message.',
    });
    const approved = await vault.approveDraft(draft.id, draft.contentHash);
    const result = await connector.sendApprovedDraft(approved.id, approved.contentHash);

    expect(sendCalls).toBe(1);
    expect(result).toMatchObject({ approvalState: 'ambiguous', providerMessageId: null });
    expect(
      vault.vault.one<{
        dispatch_status: string;
        provider_message_id: string | null;
        error_code: string;
      }>(
        'SELECT dispatch_status,provider_message_id,error_code FROM send_ledger WHERE message_id=?',
        [draft.id],
      ),
    ).toEqual({
      dispatch_status: 'ambiguous',
      provider_message_id: null,
      error_code: 'PROVIDER_ACCEPTED_PENDING_RECONCILIATION',
    });

    const operationKey = String(
      vault.vault.scalar('SELECT id FROM send_ledger WHERE message_id=?', [draft.id]),
    );
    server.use(
      http.get('https://graph.microsoft.com/v1.0/me/mailFolders/sentitems/messages', () =>
        HttpResponse.json({
          value: [
            {
              id: 'graph-confirmed-message',
              conversationId: 'graph-confirmed-thread',
              subject: 'Graph acceptance requires reconciliation',
              from: { emailAddress: { address: 'founder@microsoft.test' } },
              toRecipients: [{ emailAddress: { address: 'graph.accepted@example.test' } }],
              sentDateTime: FIXED_NOW.toISOString(),
              internetMessageHeaders: [{ name: 'X-Outreachr-Operation-Key', value: operationKey }],
            },
          ],
        }),
      ),
    );
    const reconciled = await connector.syncMail('microsoft');
    expect(reconciled.drafts.find((item) => item.id === draft.id)).toMatchObject({
      approvalState: 'sent',
      providerMessageId: 'graph-confirmed-message',
      threadId: 'graph-confirmed-thread',
    });
    expect(
      vault.vault.one(
        'SELECT dispatch_status,provider_message_id,error_code,error_detail FROM send_ledger WHERE id=?',
        [operationKey],
      ),
    ).toEqual({
      dispatch_status: 'sent',
      provider_message_id: 'graph-confirmed-message',
      error_code: null,
      error_detail: null,
    });
    expect(
      Number(
        vault.vault.scalar(
          "SELECT COUNT(*) FROM audit_log WHERE action='send.reconciled_from_mailbox' AND entity_id=?",
          [operationKey],
        ),
      ),
    ).toBe(1);
    expect(sendCalls).toBe(1);
  });

  it('fails closed on an ambiguous Gmail acceptance and never retries it', async () => {
    let gmailCalls = 0;
    successfulGoogleHandlers();
    server.use(
      http.post('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', () => {
        gmailCalls += 1;
        return HttpResponse.json({}, { status: 200 });
      }),
    );
    const { vault, connector } = await fixture();
    await connector.configure({
      provider: 'google',
      clientId: 'founder-owned-desktop-client',
      relationshipSync: true,
    });
    await connector.connect('google');
    const person = firstPersonWithoutEmail(vault);
    await vault.addPersonContact({
      personId: person.id,
      kind: 'work_email',
      value: 'partner.ambiguous@example.test',
      visibility: 'private',
      contributionEligible: false,
    });
    const draft = await vault.createDraft({
      personId: person.id,
      provider: 'google',
      kind: 'initial',
      subject: 'Ambiguous provider result',
      bodyText: 'This must not be sent twice.',
    });
    const approved = await vault.approveDraft(draft.id, draft.contentHash);

    await expect(
      connector.sendApprovedDraft(approved.id, approved.contentHash),
    ).rejects.toMatchObject({ code: 'AMBIGUOUS_SEND' });
    expect(gmailCalls).toBe(1);
    expect(
      vault.vault.scalar('SELECT dispatch_status FROM send_ledger WHERE message_id=?', [draft.id]),
    ).toBe('ambiguous');
    await expect(connector.sendApprovedDraft(approved.id, approved.contentHash)).rejects.toThrow();
    expect(gmailCalls).toBe(1);

    const operationKey = String(
      vault.vault.scalar('SELECT id FROM send_ledger WHERE message_id=?', [draft.id]),
    );
    await vault.importMailboxMessages('google', 'founder@local.test', [
      {
        provider: 'google',
        id: 'forged-inbound-confirmation',
        operationKey,
        subject: 'Ambiguous provider result',
        from: { email: 'founder@local.test' },
        to: [{ email: 'partner.ambiguous@example.test' }],
        occurredAt: FIXED_NOW.toISOString(),
        direction: 'inbound',
      },
    ]);
    expect(
      vault.vault.scalar('SELECT dispatch_status FROM send_ledger WHERE id=?', [operationKey]),
    ).toBe('ambiguous');
    server.use(
      http.get('https://gmail.googleapis.com/gmail/v1/users/me/messages', () =>
        HttpResponse.json({ messages: [{ id: 'gmail-confirmed-message' }] }),
      ),
      http.get(
        'https://gmail.googleapis.com/gmail/v1/users/me/messages/gmail-confirmed-message',
        () =>
          HttpResponse.json({
            id: 'gmail-confirmed-message',
            threadId: 'gmail-confirmed-thread',
            internalDate: String(FIXED_NOW.getTime()),
            labelIds: ['SENT'],
            payload: {
              headers: [
                { name: 'From', value: 'Ada Founder <founder@local.test>' },
                { name: 'To', value: 'Investor <partner.ambiguous@example.test>' },
                { name: 'Subject', value: 'Ambiguous provider result' },
                { name: 'Message-ID', value: '<gmail-confirmed-message@example.test>' },
                { name: 'X-Outreachr-Operation-Key', value: operationKey },
              ],
            },
          }),
      ),
    );
    const reconciled = await connector.syncMail('google');
    expect(reconciled.drafts.find((item) => item.id === draft.id)).toMatchObject({
      approvalState: 'sent',
      providerMessageId: 'gmail-confirmed-message',
      threadId: 'gmail-confirmed-thread',
    });
    expect(gmailCalls).toBe(1);
  });

  it('refreshes an expired token and uses the replacement for connection tests', async () => {
    successfulGoogleHandlers();
    const { connector, secureStore } = await fixture();
    await connector.configure({
      provider: 'google',
      clientId: 'founder-owned-desktop-client',
      relationshipSync: false,
    });
    await connector.connect('google');
    await secureStore.set('oauth/google/tokens', {
      accessToken: 'expired-access',
      refreshToken: 'google-refresh',
      tokenType: 'Bearer',
      expiresAt: '2026-07-31T18:59:00.000Z',
      accountEmail: 'founder@local.test',
    });
    server.use(
      http.post(tokenEndpoint('google'), async ({ request }) => {
        const body = new URLSearchParams(await request.text());
        expect(body.get('grant_type')).toBe('refresh_token');
        expect(body.has('client_secret')).toBe(false);
        return HttpResponse.json({
          access_token: 'refreshed-access',
          token_type: 'Bearer',
          expires_in: 3_600,
        });
      }),
      http.get('https://openidconnect.googleapis.com/v1/userinfo', ({ request }) => {
        expect(request.headers.get('authorization')).toBe('Bearer refreshed-access');
        return HttpResponse.json({ email: 'founder@local.test' });
      }),
    );

    await expect(connector.test('google')).resolves.toMatchObject({ state: 'connected' });
    await expect(
      secureStore.get<{ accessToken: string; refreshToken: string }>('oauth/google/tokens'),
    ).resolves.toMatchObject({
      accessToken: 'refreshed-access',
      refreshToken: 'google-refresh',
    });
  });

  it('syncs paginated Google Calendar events idempotently and preserves founder notes', async () => {
    successfulGoogleHandlers();
    let listCalls = 0;
    let providerRevision = 1;
    server.use(
      http.get('https://www.googleapis.com/calendar/v3/calendars/primary/events', ({ request }) => {
        listCalls += 1;
        expect(request.headers.get('authorization')).toBe('Bearer google-access');
        const url = new URL(request.url);
        expect(url.searchParams.get('singleEvents')).toBe('true');
        expect(url.searchParams.get('orderBy')).toBe('startTime');
        expect(url.searchParams.get('maxResults')).toBe('250');
        expect(Date.parse(url.searchParams.get('timeMin')!)).not.toBeNaN();
        expect(Date.parse(url.searchParams.get('timeMax')!)).not.toBeNaN();
        if (url.searchParams.get('pageToken') === 'page-2') {
          return HttpResponse.json({ items: [] });
        }
        return HttpResponse.json({
          items: [
            {
              id: 'provider-event-1',
              status: 'confirmed',
              summary: `Provider title revision ${providerRevision}`,
              description: `Provider agenda revision ${providerRevision}`,
              location: providerRevision === 1 ? 'Video' : 'Updated conference room',
              start: { dateTime: '2026-08-03T17:00:00.000Z' },
              end: { dateTime: '2026-08-03T17:30:00.000Z' },
              attendees: [
                { email: 'investor@example.test', displayName: 'Investor Example' },
                { email: 'not-an-email', displayName: 'Invalid attendee' },
              ],
            },
          ],
          nextPageToken: 'page-2',
        });
      }),
    );
    const { connector, vault } = await fixture();
    await connector.configure({
      provider: 'google',
      clientId: 'founder-owned-desktop-client',
      relationshipSync: false,
    });
    await connector.connect('google');

    const firstSync = await connector.syncCalendar('google');
    const first = firstSync.meetings.find(
      (meeting) => meeting.title === 'Provider title revision 1',
    );
    expect(first).toMatchObject({
      provider: 'google',
      location: 'Video',
      agenda: 'Provider agenda revision 1',
      notes: null,
    });
    const firstStored = vault.vault.one<{ attendee_json: string }>(
      'SELECT attendee_json FROM meetings WHERE external_calendar_id=?',
      ['google:provider-event-1'],
    );
    expect(JSON.parse(firstStored!.attendee_json)).toEqual([
      { name: 'Investor Example', email: 'investor@example.test' },
    ]);
    expect(
      vault.vault.scalar('SELECT COUNT(*) FROM meetings WHERE external_calendar_id=?', [
        'google:provider-event-1',
      ]),
    ).toBe(1);
    await vault.updateMeeting({
      id: first!.id,
      agenda: 'Founder-owned agenda must survive sync.',
      notes: 'Founder-owned notes must survive sync.',
    });

    providerRevision = 2;
    const secondSync = await connector.syncCalendar('google');
    const second = secondSync.meetings.find((meeting) => meeting.id === first!.id);
    expect(second).toMatchObject({
      title: 'Provider title revision 2',
      location: 'Updated conference room',
      agenda: 'Founder-owned agenda must survive sync.',
      notes: 'Founder-owned notes must survive sync.',
    });
    expect(
      vault.vault.scalar('SELECT COUNT(*) FROM meetings WHERE external_calendar_id=?', [
        'google:provider-event-1',
      ]),
    ).toBe(1);
    expect(listCalls).toBe(4);
    await expect(connector.statuses()).resolves.toContainEqual(
      expect.objectContaining({
        provider: 'google',
        state: 'connected',
        lastSyncAt: FIXED_NOW.toISOString(),
      }),
    );
  });

  it('exhausts more than twenty calendar pages before marking the sync current', async () => {
    successfulGoogleHandlers();
    let listCalls = 0;
    server.use(
      http.get('https://www.googleapis.com/calendar/v3/calendars/primary/events', ({ request }) => {
        listCalls += 1;
        const token = new URL(request.url).searchParams.get('pageToken');
        const pageNumber = token ? Number(token.replace('calendar-page-', '')) : 1;
        return HttpResponse.json({
          items: [
            {
              id: `calendar-event-${pageNumber}`,
              status: 'confirmed',
              summary: `Calendar page ${pageNumber}`,
              start: { dateTime: `2026-08-${String(pageNumber).padStart(2, '0')}T17:00:00.000Z` },
              end: { dateTime: `2026-08-${String(pageNumber).padStart(2, '0')}T17:30:00.000Z` },
            },
          ],
          ...(pageNumber < 21 ? { nextPageToken: `calendar-page-${pageNumber + 1}` } : {}),
        });
      }),
    );
    const { connector } = await fixture();
    await connector.configure({
      provider: 'google',
      clientId: 'founder-owned-desktop-client',
      relationshipSync: false,
    });
    await connector.connect('google');

    const result = await connector.syncCalendar('google');
    expect(listCalls).toBe(21);
    expect(
      result.meetings.filter((meeting) => meeting.title.startsWith('Calendar page ')),
    ).toHaveLength(21);
    await expect(connector.statuses()).resolves.toContainEqual(
      expect.objectContaining({
        provider: 'google',
        lastSyncAt: FIXED_NOW.toISOString(),
      }),
    );
  });

  it('discards partial calendar history on a provider pagination loop', async () => {
    successfulGoogleHandlers();
    let listCalls = 0;
    server.use(
      http.get('https://www.googleapis.com/calendar/v3/calendars/primary/events', () => {
        listCalls += 1;
        return HttpResponse.json({
          items: [
            {
              id: `loop-event-${listCalls}`,
              status: 'confirmed',
              summary: 'Must remain unstored',
              start: { dateTime: '2026-08-03T17:00:00.000Z' },
              end: { dateTime: '2026-08-03T17:30:00.000Z' },
            },
          ],
          nextPageToken: 'calendar-loop-token',
        });
      }),
    );
    const { connector, vault } = await fixture();
    await connector.configure({
      provider: 'google',
      clientId: 'founder-owned-desktop-client',
      relationshipSync: false,
    });
    await connector.connect('google');

    await expect(connector.syncCalendar('google')).rejects.toThrow('pagination token loop');
    expect(listCalls).toBe(2);
    expect(
      Number(
        vault.vault.scalar("SELECT COUNT(*) FROM meetings WHERE title='Must remain unstored'"),
      ),
    ).toBe(0);
    await expect(connector.statuses()).resolves.toContainEqual(
      expect.objectContaining({ provider: 'google', lastSyncAt: null }),
    );
  });

  it('creates a Google event with selected attendees and preserves canonical local relationships', async () => {
    successfulGoogleHandlers();
    let createCalls = 0;
    server.use(
      http.post(
        'https://www.googleapis.com/calendar/v3/calendars/primary/events',
        async ({ request }) => {
          createCalls += 1;
          const body = (await request.json()) as {
            summary: string;
            description?: string;
            location?: string;
            start: { dateTime: string };
            end: { dateTime: string };
            attendees: Array<{ email: string; displayName?: string; personId?: string }>;
            extendedProperties: { private: { outreachrOperationKey: string } };
          };
          expect(body).toMatchObject({
            summary: 'Google investor call',
            description: 'Discuss founder fit',
            location: 'https://meet.example/google',
            attendees: [
              {
                email: 'calendar.google.partner@example.test',
                displayName: expect.any(String),
              },
            ],
          });
          expect(body.attendees[0]).not.toHaveProperty('personId');
          expect(body.extendedProperties.private.outreachrOperationKey).toMatch(/^meeting:/u);
          return HttpResponse.json({
            id: 'created-google-meeting',
            status: 'confirmed',
            summary: body.summary,
            description: body.description,
            location: body.location,
            start: body.start,
            end: body.end,
            attendees: body.attendees,
          });
        },
      ),
    );
    const { connector, vault } = await fixture();
    await connector.configure({
      provider: 'google',
      clientId: 'founder-owned-desktop-client',
      relationshipSync: false,
    });
    await connector.connect('google');
    const person = firstPersonWithoutEmail(vault);
    await vault.addPersonContact({
      personId: person.id,
      kind: 'work_email',
      value: 'calendar.google.partner@example.test',
      visibility: 'private',
      contributionEligible: false,
    });

    const meeting = await connector.createMeeting({
      title: 'Google investor call',
      startsAt: '2026-08-04T17:00:00.000Z',
      endsAt: '2026-08-04T17:30:00.000Z',
      provider: 'google',
      investorId: person.firmId,
      personIds: [person.id],
      location: 'https://meet.example/google',
      agenda: 'Discuss founder fit',
      notes: 'Private preparation note',
      status: 'upcoming',
    });

    expect(createCalls).toBe(1);
    expect(meeting).toMatchObject({
      provider: 'google',
      investorId: person.firmId,
      personIds: [person.id],
      notes: 'Private preparation note',
    });
    expect(
      JSON.parse(
        String(vault.vault.scalar('SELECT attendee_json FROM meetings WHERE id=?', [meeting.id])),
      ),
    ).toEqual([
      {
        email: 'calendar.google.partner@example.test',
        name: person.name,
        personId: person.id,
      },
    ]);
  });

  it('creates a Microsoft event with selected attendees and no local IDs in the Graph payload', async () => {
    successfulMicrosoftHandlers();
    let createCalls = 0;
    server.use(
      http.post('https://graph.microsoft.com/v1.0/me/events', async ({ request }) => {
        createCalls += 1;
        const body = (await request.json()) as {
          subject: string;
          body?: { contentType: string; content: string };
          start: { dateTime: string; timeZone: string };
          end: { dateTime: string; timeZone: string };
          location?: { displayName: string };
          attendees: Array<{
            emailAddress: { address: string; name?: string; personId?: string };
            type: string;
          }>;
          transactionId: string;
        };
        expect(body).toMatchObject({
          subject: 'Microsoft investor call',
          body: { contentType: 'Text', content: 'Discuss diligence' },
          location: { displayName: 'Conference room' },
          attendees: [
            {
              emailAddress: {
                address: 'calendar.microsoft.partner@example.test',
                name: expect.any(String),
              },
              type: 'required',
            },
          ],
        });
        expect(body.attendees[0]?.emailAddress).not.toHaveProperty('personId');
        expect(body.transactionId).toMatch(/^meeting:/u);
        return HttpResponse.json({
          id: 'created-microsoft-meeting',
          subject: body.subject,
          body: body.body,
          start: body.start,
          end: body.end,
          location: body.location,
          attendees: body.attendees,
          showAs: 'busy',
        });
      }),
    );
    const { connector, vault } = await fixture();
    await connector.configure({
      provider: 'microsoft',
      clientId: 'founder-owned-microsoft-client',
      tenantId: 'common',
      relationshipSync: false,
    });
    await connector.connect('microsoft');
    const person = firstPersonWithoutEmail(vault);
    await vault.addPersonContact({
      personId: person.id,
      kind: 'work_email',
      value: 'calendar.microsoft.partner@example.test',
      visibility: 'private',
      contributionEligible: false,
    });

    const meeting = await connector.createMeeting({
      title: 'Microsoft investor call',
      startsAt: '2026-08-05T17:00:00.000Z',
      endsAt: '2026-08-05T17:30:00.000Z',
      provider: 'microsoft',
      investorId: person.firmId,
      personIds: [person.id],
      location: 'Conference room',
      agenda: 'Discuss diligence',
      notes: null,
      status: 'upcoming',
    });

    expect(createCalls).toBe(1);
    expect(meeting).toMatchObject({
      provider: 'microsoft',
      investorId: person.firmId,
      personIds: [person.id],
    });
  });

  it('syncs only matched Gmail relationship metadata, classifies replies and bounces, and remains idempotent and private', async () => {
    successfulGoogleHandlers();
    let listCalls = 0;
    let detailCalls = 0;
    const targetEmail = 'mail.relationship.partner@example.test';
    const privateSubject = 'Private mailbox relationship subject 7d7150';
    const messageDetails: Record<
      string,
      {
        threadId: string;
        internalDate: string;
        labelIds: string[];
        headers: Array<{ name: string; value: string }>;
      }
    > = {
      'outbound-1': {
        threadId: 'matched-thread-1',
        internalDate: String(Date.parse('2026-07-30T17:00:00.000Z')),
        labelIds: ['SENT'],
        headers: [
          { name: 'From', value: 'Ada Founder <founder@local.test>' },
          { name: 'To', value: `Investor Partner <${targetEmail}>` },
          { name: 'Subject', value: privateSubject },
          { name: 'Message-ID', value: '<outbound-1@local.test>' },
        ],
      },
      'reply-1': {
        threadId: 'matched-thread-1',
        internalDate: String(Date.parse('2026-07-30T18:00:00.000Z')),
        labelIds: ['INBOX'],
        headers: [
          { name: 'From', value: `Investor Partner <${targetEmail}>` },
          { name: 'To', value: 'Ada Founder <founder@local.test>' },
          { name: 'Subject', value: `Re: ${privateSubject}` },
          { name: 'Message-ID', value: '<reply-1@local.test>' },
        ],
      },
      'bounce-1': {
        threadId: 'matched-thread-1',
        internalDate: String(Date.parse('2026-07-30T19:00:00.000Z')),
        labelIds: ['INBOX'],
        headers: [
          { name: 'From', value: 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>' },
          { name: 'To', value: 'Ada Founder <founder@local.test>' },
          { name: 'Subject', value: `Mail delivery failure — user unknown: ${privateSubject}` },
          { name: 'Message-ID', value: '<bounce-1@local.test>' },
        ],
      },
      'unrelated-1': {
        threadId: 'unrelated-thread',
        internalDate: String(Date.parse('2026-07-30T20:00:00.000Z')),
        labelIds: ['INBOX'],
        headers: [
          { name: 'From', value: 'Unrelated Person <unrelated@example.test>' },
          { name: 'To', value: 'Ada Founder <founder@local.test>' },
          { name: 'Subject', value: 'Unrelated private mailbox subject' },
          { name: 'Message-ID', value: '<unrelated-1@local.test>' },
        ],
      },
    };
    server.use(
      http.get('https://gmail.googleapis.com/gmail/v1/users/me/messages', ({ request }) => {
        listCalls += 1;
        expect(request.headers.get('authorization')).toBe('Bearer google-access');
        const url = new URL(request.url);
        const query = url.searchParams.get('q');
        if (query !== null) expect(query).toMatch(/^after:\d+$/u);
        expect(url.searchParams.get('maxResults')).toBe('100');
        if (url.searchParams.get('pageToken') === 'mail-page-2') {
          return HttpResponse.json({
            messages: [{ id: 'bounce-1' }, { id: 'unrelated-1' }],
          });
        }
        return HttpResponse.json({
          messages: [{ id: 'outbound-1' }, { id: 'reply-1' }],
          nextPageToken: 'mail-page-2',
        });
      }),
      http.get(
        'https://gmail.googleapis.com/gmail/v1/users/me/messages/:messageId',
        ({ params, request }) => {
          detailCalls += 1;
          const url = new URL(request.url);
          expect(url.searchParams.get('format')).toBe('metadata');
          expect(url.searchParams.getAll('metadataHeaders')).toEqual([
            'From',
            'To',
            'Cc',
            'Subject',
            'Date',
            'Message-ID',
            'X-Outreachr-Operation-Key',
          ]);
          const id = String(params.messageId);
          return HttpResponse.json({
            id,
            ...messageDetails[id],
            payload: { headers: messageDetails[id]!.headers },
          });
        },
      ),
    );
    const { connector, vault } = await fixture();
    const person = firstPersonWithoutEmail(vault);
    await vault.addPersonContact({
      personId: person.id,
      kind: 'work_email',
      value: targetEmail,
      visibility: 'private',
      contributionEligible: false,
    });
    await connector.configure({
      provider: 'google',
      clientId: 'founder-owned-desktop-client',
      relationshipSync: true,
    });
    const connected = await connector.connect('google');
    expect(connected).toMatchObject({ relationshipSync: true, state: 'connected' });
    expect(connected.scopes).toContain('https://www.googleapis.com/auth/gmail.readonly');

    vault.vault.run(`CREATE TRIGGER test_mail_import_rollback
      BEFORE INSERT ON mail_events WHEN NEW.provider_message_id='bounce-1'
      BEGIN SELECT RAISE(ABORT,'forced mailbox import failure'); END`);
    await expect(connector.syncMail('google')).rejects.toThrow('forced mailbox import failure');
    expect(Number(vault.vault.scalar('SELECT COUNT(*) FROM mail_events'))).toBe(2);
    expect(
      Number(
        vault.vault.scalar(
          "SELECT COUNT(*) FROM audit_log WHERE action='mail.relationship_event_imported'",
        ),
      ),
    ).toBe(2);
    const failedConfig = vault.vault.one<{ public_config_json: string }>(
      'SELECT public_config_json FROM connector_configs WHERE provider=?',
      ['google'],
    );
    expect(JSON.parse(failedConfig!.public_config_json)).not.toHaveProperty('lastMailSyncAt');
    await expect(connector.statuses()).resolves.toContainEqual(
      expect.objectContaining({ provider: 'google', lastSyncAt: null }),
    );
    vault.vault.run('DROP TRIGGER test_mail_import_rollback');

    const first = await connector.syncMail('google');
    expect(first.mailEvents).toHaveLength(3);
    expect(first.mailEvents.map((event) => event.kind)).toEqual([
      'hard_bounce',
      'reply',
      'message',
    ]);
    expect(first.people.find((item) => item.id === person.id)).toMatchObject({
      contacted: true,
      replied: true,
      canSendInitial: false,
      suppressionReason: 'Provider mailbox reported a hard bounce.',
      lastInteractionAt: '2026-07-30T19:00:00.000Z',
    });
    expect(first.suppressions).toContainEqual(
      expect.objectContaining({
        scope: 'person',
        value: person.id,
        source: 'bounce',
        active: true,
      }),
    );
    expect(first.workItems.filter((item) => item.kind === 'follow_up')).toHaveLength(2);
    expect(first.auditIntegrity.ok).toBe(true);
    expect(Number(vault.vault.scalar('SELECT COUNT(*) FROM mail_events'))).toBe(3);
    expect(
      Number(
        vault.vault.scalar(
          "SELECT COUNT(*) FROM audit_log WHERE action='mail.relationship_event_imported'",
        ),
      ),
    ).toBe(3);

    const reply = first.mailEvents.find((event) => event.kind === 'reply')!;
    await expect(vault.reviewMailEvent(reply.id)).resolves.toMatchObject({
      id: reply.id,
      reviewedAt: FIXED_NOW.toISOString(),
    });
    const second = await connector.syncMail('google');
    expect(second.mailEvents).toHaveLength(3);
    expect(second.mailEvents.find((event) => event.id === reply.id)?.reviewedAt).toBe(
      FIXED_NOW.toISOString(),
    );
    expect(second.workItems.filter((item) => item.kind === 'follow_up')).toHaveLength(1);
    expect(
      Number(
        vault.vault.scalar(
          "SELECT COUNT(*) FROM audit_log WHERE action='mail.relationship_event_imported'",
        ),
      ),
    ).toBe(3);
    expect(listCalls).toBe(5);
    expect(detailCalls).toBe(10);
    await expect(connector.statuses()).resolves.toContainEqual(
      expect.objectContaining({
        provider: 'google',
        lastSyncAt: FIXED_NOW.toISOString(),
      }),
    );

    const exportDirectory = await temporaryDirectory('mail-export');
    directories.push(exportDirectory);
    const contribution = await vault.exportContribution(exportDirectory);
    const publicBytes = await readFile(contribution.databasePath);
    expect(publicBytes.includes(Buffer.from(targetEmail))).toBe(false);
    expect(publicBytes.includes(Buffer.from(privateSubject))).toBe(false);
    expect(publicBytes.includes(Buffer.from('Provider mailbox reported a hard bounce.'))).toBe(
      false,
    );
  });

  it('exhausts more than ten full-history pages, preserves old alias sends, and reconciles them when a contact is added', async () => {
    successfulGoogleHandlers();
    let listCalls = 0;
    let detailCalls = 0;
    const historicalRecipient = 'historical.partner@example.test';
    server.use(
      http.get('https://gmail.googleapis.com/gmail/v1/users/me/messages', ({ request }) => {
        listCalls += 1;
        const url = new URL(request.url);
        expect(url.searchParams.get('q')).toBeNull();
        const token = url.searchParams.get('pageToken');
        const pageNumber = token ? Number(token.replace('history-page-', '')) : 1;
        return HttpResponse.json({
          messages: pageNumber === 12 ? [{ id: 'old-alias-send' }] : [],
          ...(pageNumber < 12 ? { nextPageToken: `history-page-${pageNumber + 1}` } : {}),
        });
      }),
      http.get(
        'https://gmail.googleapis.com/gmail/v1/users/me/messages/:messageId',
        ({ params }) => {
          detailCalls += 1;
          expect(params.messageId).toBe('old-alias-send');
          return HttpResponse.json({
            id: 'old-alias-send',
            threadId: 'old-alias-thread',
            internalDate: String(Date.parse('2012-01-05T03:04:05.000Z')),
            labelIds: ['SENT'],
            payload: {
              headers: [
                { name: 'From', value: 'Founder Alias <send-as-alias@example.test>' },
                { name: 'To', value: `Historical Partner <${historicalRecipient}>` },
                { name: 'Subject', value: 'Very old fundraising note' },
                { name: 'Message-ID', value: '<old-alias-send@example.test>' },
              ],
            },
          });
        },
      ),
    );
    const { connector, vault } = await fixture();
    await connector.configure({
      provider: 'google',
      clientId: 'founder-owned-desktop-client',
      relationshipSync: true,
    });
    await connector.connect('google');

    await connector.syncMail('google');
    expect(listCalls).toBe(12);
    expect(detailCalls).toBe(1);
    expect(
      vault.vault.one<{
        person_id: string | null;
        direction: string;
        sender_address: string;
        occurred_at: string;
      }>('SELECT person_id,direction,sender_address,occurred_at FROM mail_events'),
    ).toEqual({
      person_id: null,
      direction: 'outbound',
      sender_address: 'send-as-alias@example.test',
      occurred_at: '2012-01-05T03:04:05.000Z',
    });
    const completedConfig = JSON.parse(
      String(
        vault.vault.scalar('SELECT public_config_json FROM connector_configs WHERE provider=?', [
          'google',
        ]),
      ),
    ) as Record<string, unknown>;
    expect(completedConfig).toMatchObject({
      mailHistoryComplete: true,
      lastMailSyncAt: FIXED_NOW.toISOString(),
    });
    expect(completedConfig).not.toHaveProperty('mailSyncProgress');

    const person = firstPersonWithoutEmail(vault);
    await vault.addPersonContact({
      personId: person.id,
      kind: 'work_email',
      value: historicalRecipient,
      visibility: 'private',
      contributionEligible: false,
    });
    expect(vault.vault.scalar('SELECT person_id FROM mail_events')).toBe(person.id);
    expect((await vault.bootstrap()).people.find((item) => item.id === person.id)).toMatchObject({
      contacted: true,
      canSendInitial: false,
    });

    await vault.importMailboxMessages('google', 'founder@local.test', [
      {
        provider: 'google',
        id: 'unsubscribe-after-reconcile',
        threadId: 'old-alias-thread',
        subject: 'Please unsubscribe me',
        from: { email: historicalRecipient },
        to: [{ email: 'founder@local.test' }],
        occurredAt: '2026-07-31T17:00:00.000Z',
        direction: 'inbound',
      },
    ]);
    const unsubscribe = (await vault.bootstrap()).mailEvents.find(
      (event) => event.kind === 'unsubscribe',
    );
    expect(unsubscribe).toBeDefined();
    const automaticSuppression = (await vault.bootstrap()).suppressions.find(
      (item) => item.source === 'unsubscribe' && item.value === person.id,
    );
    expect(automaticSuppression).toMatchObject({ active: true });
    await expect(vault.removeSuppression(automaticSuppression!.id)).rejects.toThrow(
      'cannot be deactivated',
    );
  });

  it('fails closed on a mailbox pagination token loop without advancing the completion cursor', async () => {
    successfulGoogleHandlers();
    let listCalls = 0;
    server.use(
      http.get('https://gmail.googleapis.com/gmail/v1/users/me/messages', ({ request }) => {
        listCalls += 1;
        const token = new URL(request.url).searchParams.get('pageToken');
        return HttpResponse.json({ messages: [], nextPageToken: token ?? 'loop-token' });
      }),
    );
    const { connector, vault } = await fixture();
    await connector.configure({
      provider: 'google',
      clientId: 'founder-owned-desktop-client',
      relationshipSync: true,
    });
    await connector.connect('google');

    await expect(connector.syncMail('google')).rejects.toThrow('pagination token loop');
    expect(listCalls).toBe(2);
    const config = JSON.parse(
      String(
        vault.vault.scalar('SELECT public_config_json FROM connector_configs WHERE provider=?', [
          'google',
        ]),
      ),
    ) as Record<string, unknown>;
    expect(config).not.toHaveProperty('lastMailSyncAt');
    expect(config).not.toHaveProperty('mailHistoryComplete');
    expect(Number(vault.vault.scalar('SELECT COUNT(*) FROM send_ledger'))).toBe(0);
  });

  it('blocks a provider send before reservation when relationship history is unavailable', async () => {
    let gmailSendCalls = 0;
    successfulGoogleHandlers(() => {
      gmailSendCalls += 1;
    });
    const { connector, vault } = await fixture();
    await connector.configure({
      provider: 'google',
      clientId: 'founder-owned-desktop-client',
      relationshipSync: false,
    });
    await connector.connect('google');
    const person = firstPersonWithoutEmail(vault);
    await vault.addPersonContact({
      personId: person.id,
      kind: 'work_email',
      value: 'no-history@example.test',
      visibility: 'private',
      contributionEligible: false,
    });
    const draft = await vault.createDraft({
      personId: person.id,
      provider: 'google',
      kind: 'initial',
      subject: 'Must reconcile first',
      bodyText: 'This request must not reach the Gmail send endpoint.',
    });
    const approved = await vault.approveDraft(draft.id, draft.contentHash);

    await expect(connector.sendApprovedDraft(approved.id, approved.contentHash)).rejects.toThrow(
      'relationship-sync read scope',
    );
    expect(gmailSendCalls).toBe(0);
    expect(Number(vault.vault.scalar('SELECT COUNT(*) FROM send_ledger'))).toBe(0);
  });

  it('blocks every non-initial message kind in stock 0.1 before mailbox or send HTTP', async () => {
    let gmailSendCalls = 0;
    successfulGoogleHandlers(() => {
      gmailSendCalls += 1;
    });
    const { connector, vault } = await fixture();
    await connector.configure({
      provider: 'google',
      clientId: 'founder-owned-desktop-client',
      relationshipSync: true,
    });
    await connector.connect('google');
    const person = firstPersonWithoutEmail(vault);
    await vault.addPersonContact({
      personId: person.id,
      kind: 'work_email',
      value: 'follow-up-block@example.test',
      visibility: 'private',
      contributionEligible: false,
    });
    const draft = await vault.createDraft({
      personId: person.id,
      provider: 'google',
      kind: 'follow_up',
      subject: 'Follow-up remains local',
      bodyText: 'Outreachr 0.1 must not send this externally.',
    });
    const approved = await vault.approveDraft(draft.id, draft.contentHash);

    await expect(connector.sendApprovedDraft(approved.id, approved.contentHash)).rejects.toThrow(
      'sends initial outreach only',
    );
    expect(gmailSendCalls).toBe(0);
    expect(Number(vault.vault.scalar('SELECT COUNT(*) FROM send_ledger'))).toBe(0);
  });

  it('rejects a forged OAuth state and records a useful non-secret error', async () => {
    const directory = await temporaryDirectory('connector-state');
    directories.push(directory);
    const vault = await initializedVault(directory);
    vaults.push(vault);
    await onboard(vault);
    const secureStore = new SecureStore(vault.vault, new FakeSecretBackend());
    const connector = new ConnectorService({
      vault,
      secureStore,
      openExternal: async () => undefined,
      fetch,
      now: () => FIXED_NOW,
      authorizeForTest: async (request) =>
        `${request.redirectUri}?code=attacker-code&state=forged-state`,
    });
    await connector.configure({
      provider: 'google',
      clientId: 'founder-owned-desktop-client',
      relationshipSync: false,
    });

    await expect(connector.connect('google')).rejects.toThrow('state did not match');
    const status = (await connector.statuses()).find((item) => item.provider === 'google');
    expect(status).toMatchObject({ state: 'configured' });
    expect(status?.error).toContain('state did not match');
  });

  it('uses MSW Google Calendar mocks for event creation and free/busy', async () => {
    server.use(
      http.post(
        'https://www.googleapis.com/calendar/v3/calendars/primary/events',
        async ({ request }) => {
          expect(request.headers.get('authorization')).toBe('Bearer calendar-access');
          const body = (await request.json()) as Record<string, unknown>;
          expect(body).toMatchObject({
            summary: 'Investor meeting',
            extendedProperties: {
              private: { outreachrOperationKey: 'calendar-operation-1' },
            },
          });
          return HttpResponse.json({
            id: 'calendar-event-1',
            status: 'confirmed',
            summary: 'Investor meeting',
            start: { dateTime: '2026-08-03T17:00:00.000Z' },
            end: { dateTime: '2026-08-03T17:30:00.000Z' },
          });
        },
      ),
      http.post('https://www.googleapis.com/calendar/v3/freeBusy', async ({ request }) => {
        const body = (await request.json()) as { items?: Array<{ id: string }> };
        expect(body.items).toEqual([{ id: 'primary' }, { id: 'investor@example.test' }]);
        return HttpResponse.json({
          timeMin: '2026-08-03T16:00:00.000Z',
          timeMax: '2026-08-03T19:00:00.000Z',
          calendars: {
            primary: {
              busy: [
                {
                  start: '2026-08-03T17:00:00.000Z',
                  end: '2026-08-03T17:30:00.000Z',
                },
              ],
            },
            'investor@example.test': { busy: [] },
          },
        });
      }),
    );
    const calendar = new GoogleConnector({
      fetch,
      getAccessToken: () => 'calendar-access',
      sendLedger: new InMemorySendAttemptLedger(),
      now: () => FIXED_NOW,
    });

    await expect(
      calendar.createEvent({
        title: 'Investor meeting',
        start: { dateTime: '2026-08-03T17:00:00.000Z' },
        end: { dateTime: '2026-08-03T17:30:00.000Z' },
        operationKey: 'calendar-operation-1',
      }),
    ).resolves.toMatchObject({ id: 'calendar-event-1', provider: 'google' });
    await expect(
      calendar.queryFreeBusy({
        calendarIds: ['primary', 'investor@example.test'],
        timeMin: '2026-08-03T16:00:00.000Z',
        timeMax: '2026-08-03T19:00:00.000Z',
      }),
    ).resolves.toMatchObject({
      calendars: [
        { calendarId: 'primary', busy: [{ start: '2026-08-03T17:00:00.000Z' }] },
        { calendarId: 'investor@example.test', busy: [] },
      ],
    });
  });
});
