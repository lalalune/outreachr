import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  createLoopbackRedirectUri,
  exchangeAuthorizationCode,
  fingerprintEmail,
  getScopes,
  GoogleConnector,
  MicrosoftConnector,
  normalizeEmail,
  prepareDesktopAuthorization,
  refreshAccessToken,
  validateOAuthCallback,
  type ConnectorProvider,
  type CalendarEvent,
  type EmailMessage,
  type OAuthTokenSet,
  type PreparedAuthorizationRequest,
  type SendAttemptLedger,
  type SendContext,
  type SendReceipt,
} from '@outreachr/connectors';
import type { AppBootstrap, ConnectorStatus, DraftMessage, MeetingItem } from '../shared/contracts';
import type { SecureStore } from './secure-store';
import type { VaultService } from './vault-service';

const MAX_CALENDAR_SYNC_PAGES = 10_000;
const OAUTH_CALLBACK_TIMEOUT_MS = 5 * 60 * 1_000;
const MAX_OAUTH_CALLBACK_URL_CHARS = 4_096;

interface ConnectorServiceOptions {
  vault: VaultService;
  secureStore: SecureStore;
  openExternal: (url: string) => Promise<void>;
  fetch?: typeof fetch;
  now?: () => Date;
  authorizeForTest?: (request: PreparedAuthorizationRequest) => Promise<string>;
}

interface PublicConfig {
  clientId: string;
  tenantId?: string;
  relationshipSync: boolean;
  lastSyncAt?: string;
  lastCalendarSyncAt?: string;
  lastMailSyncAt?: string;
  mailHistoryComplete?: boolean;
  mailIdentityDigest?: string;
  mailSyncProgress?: MailSyncProgress;
}

interface MailSyncProgress {
  mode: 'full' | 'incremental';
  startedAt: string;
  identityDigest: string;
  since?: string;
  scopeIndex: number;
  pageToken?: string;
  seenTokenDigests: string[];
}

interface StoredTokens extends OAuthTokenSet {
  accountEmail: string;
}

function secretKey(provider: ConnectorProvider): string {
  return `oauth/${provider}/tokens`;
}

function connectorId(provider: ConnectorProvider): string {
  return `connector:${provider}`;
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function writeLoopbackResponse(
  response: ServerResponse,
  status: number,
  message: string,
  extraHeaders: Record<string, string> = {},
  onComplete?: () => void,
): void {
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy':
      "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'cross-origin-opener-policy': 'same-origin',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    ...extraHeaders,
  });
  response.end(
    `<!doctype html><meta charset="utf-8"><title>Outreachr authorization</title><p>${message}</p>`,
    onComplete,
  );
}

function stateMatches(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual, 'utf8');
  const expectedBytes = Buffer.from(expected, 'utf8');
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

async function closeLoopbackServer(server: ReturnType<typeof createServer>): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeIdleConnections();
  });
}

export async function loopbackCallback(
  provider: ConnectorProvider,
  clientId: string,
  tenantId: string | undefined,
  relationshipSync: boolean,
  openExternal: (url: string) => Promise<void>,
  authorizeForTest?: (request: PreparedAuthorizationRequest) => Promise<string>,
  timeoutMs = OAUTH_CALLBACK_TIMEOUT_MS,
): Promise<{ callbackUrl: string; prepared: PreparedAuthorizationRequest }> {
  if (authorizeForTest) {
    const prepared = await prepareDesktopAuthorization({
      provider,
      clientId,
      ...(tenantId ? { tenant: tenantId } : {}),
      redirectUri: createLoopbackRedirectUri(
        19_876,
        '/oauth/callback',
        provider === 'microsoft' ? 'localhost' : '127.0.0.1',
      ),
      scopeProfile: relationshipSync ? 'relationship-sync' : 'minimum',
    });
    return { callbackUrl: await authorizeForTest(prepared), prepared };
  }

  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > OAUTH_CALLBACK_TIMEOUT_MS) {
    throw new RangeError('OAuth callback timeout is outside the supported safety bounds');
  }

  const server = createServer();
  server.headersTimeout = 10_000;
  server.requestTimeout = 10_000;
  server.keepAliveTimeout = 1_000;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let requestListener: ((request: IncomingMessage, response: ServerResponse) => void) | undefined;
  let serverErrorListener: ((error: Error) => void) | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      server.once('error', onError);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', onError);
        resolve();
      });
    });
    const address = server.address() as AddressInfo;
    // Microsoft ignores a dynamic loopback port only for the registered
    // `localhost` reply URI. The socket remains IPv4-loopback-only; Host is
    // validated against the provider-specific advertised URI below.
    const redirectUri = createLoopbackRedirectUri(
      address.port,
      '/oauth/callback',
      provider === 'microsoft' ? 'localhost' : '127.0.0.1',
    );
    const redirect = new URL(redirectUri);
    const prepared = await prepareDesktopAuthorization({
      provider,
      clientId,
      ...(tenantId ? { tenant: tenantId } : {}),
      redirectUri,
      scopeProfile: relationshipSync ? 'relationship-sync' : 'minimum',
    });
    const callback = new Promise<string>((resolve, reject) => {
      let completed = false;
      timeout = setTimeout(() => {
        if (completed) return;
        completed = true;
        reject(new Error('OAuth sign-in timed out after five minutes'));
      }, timeoutMs);
      timeout.unref?.();
      serverErrorListener = (error: Error): void => {
        if (completed) return;
        completed = true;
        reject(error);
      };
      server.once('error', serverErrorListener);
      requestListener = (request, response): void => {
        if (completed) {
          writeLoopbackResponse(response, 409, 'Authorization has already been received.');
          return;
        }
        if (request.method !== 'GET') {
          writeLoopbackResponse(response, 405, 'Only the authorization callback is accepted.', {
            allow: 'GET',
          });
          return;
        }
        if (
          request.socket.remoteAddress !== '127.0.0.1' ||
          request.headers.host !== redirect.host
        ) {
          writeLoopbackResponse(response, 400, 'Invalid authorization callback.');
          return;
        }
        if (
          !request.url ||
          request.url.length > MAX_OAUTH_CALLBACK_URL_CHARS ||
          !request.url.startsWith('/')
        ) {
          writeLoopbackResponse(response, 400, 'Invalid authorization callback.');
          return;
        }
        let callbackUrl: URL;
        try {
          callbackUrl = new URL(request.url, redirect);
        } catch {
          writeLoopbackResponse(response, 400, 'Invalid authorization callback.');
          return;
        }
        if (
          callbackUrl.origin !== redirect.origin ||
          callbackUrl.pathname !== redirect.pathname ||
          callbackUrl.username ||
          callbackUrl.password ||
          callbackUrl.hash
        ) {
          writeLoopbackResponse(response, 404, 'Authorization callback not found.');
          return;
        }
        const states = callbackUrl.searchParams.getAll('state');
        const codes = callbackUrl.searchParams.getAll('code');
        const errors = callbackUrl.searchParams.getAll('error');
        const hasCode = codes.length === 1 && Boolean(codes[0]);
        const hasError = errors.length === 1 && Boolean(errors[0]);
        if (
          states.length !== 1 ||
          !stateMatches(states[0]!, prepared.state) ||
          hasCode === hasError
        ) {
          writeLoopbackResponse(response, 400, 'Invalid authorization callback.');
          return;
        }
        completed = true;
        clearTimeout(timeout);
        writeLoopbackResponse(
          response,
          200,
          'Authorization response received. You may close this tab and return to Outreachr.',
          {},
          () => resolve(callbackUrl.toString()),
        );
      };
      server.on('request', requestListener);
    });
    const [, callbackUrl] = await Promise.all([openExternal(prepared.authorizationUrl), callback]);
    return { callbackUrl, prepared };
  } finally {
    if (timeout) clearTimeout(timeout);
    if (requestListener) server.off('request', requestListener);
    if (serverErrorListener) server.off('error', serverErrorListener);
    await closeLoopbackServer(server);
  }
}

class CoreSendLedger implements SendAttemptLedger {
  readonly #vault: VaultService;
  readonly #ledgerId: string;
  readonly #messageFingerprint: string;
  readonly #context: SendContext;

  constructor(
    vault: VaultService,
    ledgerId: string,
    messageFingerprint: string,
    context: SendContext,
  ) {
    this.#vault = vault;
    this.#ledgerId = ledgerId;
    this.#messageFingerprint = messageFingerprint;
    this.#context = context;
  }

  async claim(receipt: SendReceipt): Promise<{ claimed: boolean; receipt: SendReceipt }> {
    const row = this.#vault.vault.one<{
      dispatch_status: string;
      provider: string;
      sender_normalized: string;
      message_kind: string;
      approved_provider_thread_id: string | null;
    }>(
      'SELECT dispatch_status,provider,sender_normalized,message_kind,approved_provider_thread_id FROM send_ledger WHERE id=?',
      [this.#ledgerId],
    );
    if (
      !row ||
      row.provider !== receipt.provider ||
      receipt.messageFingerprint !== this.#messageFingerprint ||
      row.provider !== this.#context.provider ||
      row.sender_normalized !== normalizeEmail(this.#context.senderAddress) ||
      row.message_kind !== this.#context.messageKind ||
      (row.approved_provider_thread_id ?? null) !== (this.#context.providerThreadId ?? null)
    )
      throw new Error('Durable send reservation is missing or mismatched');
    if (row.dispatch_status !== 'reserved')
      return {
        claimed: false,
        receipt: {
          ...receipt,
          status: row.dispatch_status === 'sent' ? 'sent' : 'ambiguous',
          replayed: true,
          retrySafe: false,
        },
      };
    this.#vault.repository.markDispatchStarted(this.#ledgerId, receipt.attemptedAt);
    await this.#vault.persist();
    return { claimed: true, receipt };
  }

  async update(receipt: SendReceipt): Promise<void> {
    if (receipt.status === 'pending') return;
    const row = this.#vault.vault.one<{ dispatch_status: string }>(
      'SELECT dispatch_status FROM send_ledger WHERE id=?',
      [this.#ledgerId],
    );
    if (!row || ['sent', 'ambiguous'].includes(row.dispatch_status)) return;
    const now = receipt.updatedAt;
    if (receipt.status === 'sent' && receipt.providerMessageId) {
      this.#vault.repository.markSendSucceeded(
        this.#ledgerId,
        receipt.providerMessageId,
        now,
        receipt.providerThreadId ?? null,
      );
    } else if (receipt.status === 'accepted' || receipt.status === 'sent') {
      this.#vault.repository.markSendAmbiguous(
        this.#ledgerId,
        receipt.status === 'accepted'
          ? 'PROVIDER_ACCEPTED_PENDING_RECONCILIATION'
          : 'PROVIDER_MESSAGE_ID_MISSING',
        'The provider accepted the request without a message id. Automatic retry is disabled until mailbox reconciliation.',
        now,
      );
    } else {
      this.#vault.repository.markSendAmbiguous(
        this.#ledgerId,
        receipt.errorCode ?? 'PROVIDER_SEND_NOT_CONFIRMED',
        `Connector returned ${receipt.status}; automatic retry remains disabled.`,
        now,
      );
    }
  }

  async get(operationKey: string): Promise<SendReceipt | undefined> {
    if (operationKey !== this.#ledgerId) return undefined;
    const row = this.#vault.vault.one<Record<string, unknown>>(
      'SELECT * FROM send_ledger WHERE id=?',
      [operationKey],
    );
    if (!row) return undefined;
    return {
      provider: row.provider as ConnectorProvider,
      operationKey,
      messageFingerprint: String(row.approval_sha256),
      status:
        row.dispatch_status === 'sent'
          ? 'sent'
          : row.dispatch_status === 'ambiguous'
            ? 'ambiguous'
            : 'pending',
      attemptedAt: String(row.reserved_at),
      updatedAt: String(row.completed_at ?? row.dispatch_started_at ?? row.reserved_at),
      ...(typeof row.provider_message_id === 'string'
        ? { providerMessageId: row.provider_message_id }
        : {}),
      ...(typeof row.provider_thread_id === 'string'
        ? { providerThreadId: row.provider_thread_id }
        : {}),
      deliveryConfirmed: row.dispatch_status === 'sent',
      replayed: true,
      retrySafe: false,
    };
  }
}

class CalendarOnlyLedger implements SendAttemptLedger {
  async claim(): Promise<never> {
    throw new Error('Email sending is disabled for this calendar-only connector');
  }

  async update(): Promise<never> {
    throw new Error('Email sending is disabled for this calendar-only connector');
  }

  async get(): Promise<undefined> {
    return undefined;
  }
}

export class ConnectorService {
  readonly #vault: VaultService;
  readonly #secureStore: SecureStore;
  readonly #openExternal: (url: string) => Promise<void>;
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;
  readonly #authorizeForTest:
    ((request: PreparedAuthorizationRequest) => Promise<string>) | undefined;
  readonly #errors = new Map<ConnectorProvider, string>();

  constructor(options: ConnectorServiceOptions) {
    this.#vault = options.vault;
    this.#secureStore = options.secureStore;
    this.#secureStore.bindVault(() => this.#vault.vault);
    this.#openExternal = options.openExternal;
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? (() => new Date());
    this.#authorizeForTest = options.authorizeForTest;
  }

  #config(
    provider: ConnectorProvider,
  ): { publicConfig: PublicConfig; accountLabel: string; status: string; scopes: string[] } | null {
    const row = this.#vault.vault.one<{
      public_config_json: string;
      account_label: string;
      status: string;
      scopes_json: string;
    }>(
      'SELECT public_config_json,account_label,status,scopes_json FROM connector_configs WHERE id=?',
      [connectorId(provider)],
    );
    return row
      ? {
          publicConfig: parseJson<PublicConfig>(row.public_config_json),
          accountLabel: row.account_label,
          status: row.status,
          scopes: parseJson<string[]>(row.scopes_json),
        }
      : null;
  }

  async statuses(): Promise<ConnectorStatus[]> {
    const encryption = await this.#secureStore.status();
    return (['google', 'microsoft'] as const).map((provider) => {
      const config = this.#config(provider);
      return {
        provider,
        state: !config
          ? 'not_configured'
          : config.status === 'connected'
            ? 'connected'
            : config.status === 'error'
              ? 'error'
              : 'configured',
        accountEmail: config?.status === 'connected' ? config.accountLabel : null,
        scopes: config?.scopes ?? [],
        relationshipSync: config?.publicConfig.relationshipSync ?? false,
        lastSyncAt:
          config?.publicConfig.lastMailSyncAt ??
          config?.publicConfig.lastCalendarSyncAt ??
          config?.publicConfig.lastSyncAt ??
          null,
        error: this.#errors.get(provider) ?? null,
        encryptionAvailable: encryption.available,
      };
    });
  }

  async configure(input: {
    provider: ConnectorProvider;
    clientId: string;
    clientSecret?: string;
    tenantId?: string;
    relationshipSync: boolean;
  }): Promise<ConnectorStatus> {
    if (input.provider !== 'google' && input.clientSecret !== undefined) {
      throw new Error('Microsoft desktop clients do not use a client secret');
    }
    const clientId = input.clientId.trim();
    const previousClientId = this.#config(input.provider)?.publicConfig.clientId;
    if (input.provider === 'google') {
      if (input.clientSecret?.trim()) {
        await this.#secureStore.set('oauth/google/client', {
          clientId,
          clientSecret: input.clientSecret.trim(),
        });
      } else if (previousClientId !== clientId) {
        this.#secureStore.delete('oauth/google/client');
      }
    }
    this.#secureStore.delete(secretKey(input.provider));
    const now = this.#now().toISOString();
    const scopes = getScopes(
      input.provider,
      input.relationshipSync ? 'relationship-sync' : 'minimum',
    );
    this.#vault.repository.upsertConnectorConfig({
      id: connectorId(input.provider),
      provider: input.provider,
      accountLabel: `${input.provider}:configured`,
      publicConfig: {
        clientId,
        ...(input.provider === 'microsoft' ? { tenantId: input.tenantId?.trim() || 'common' } : {}),
        relationshipSync: input.relationshipSync,
      },
      secretRef: `secure-store://oauth/${input.provider}/tokens`,
      scopes,
      status: 'unconfigured',
      createdAt: now,
      updatedAt: now,
    });
    this.#errors.delete(input.provider);
    await this.#vault.persist();
    return (await this.statuses()).find((status) => status.provider === input.provider)!;
  }

  async connect(provider: ConnectorProvider): Promise<ConnectorStatus> {
    const config = this.#config(provider);
    if (!config?.publicConfig.clientId)
      throw new Error(`Configure ${provider} with a founder-owned desktop client ID first`);
    const encryption = await this.#secureStore.status();
    if (!encryption.available)
      throw new Error(encryption.reason ?? 'Credential encryption is unavailable');
    try {
      const { callbackUrl, prepared } = await loopbackCallback(
        provider,
        config.publicConfig.clientId,
        config.publicConfig.tenantId,
        config.publicConfig.relationshipSync,
        this.#openExternal,
        this.#authorizeForTest,
      );
      const callback = validateOAuthCallback(callbackUrl, prepared.state);
      const clientSecret =
        provider === 'google'
          ? await this.#googleClientSecret(config.publicConfig.clientId)
          : undefined;
      const tokens = await exchangeAuthorizationCode({
        provider,
        fetch: this.#fetch,
        clientId: config.publicConfig.clientId,
        ...(clientSecret ? { clientSecret } : {}),
        code: callback.code,
        codeVerifier: prepared.pkce.verifier,
        redirectUri: prepared.redirectUri,
        ...(config.publicConfig.tenantId ? { tenant: config.publicConfig.tenantId } : {}),
        now: this.#now,
      });
      const accountEmail = await this.#accountEmail(provider, tokens.accessToken);
      await this.#secureStore.set(secretKey(provider), {
        ...tokens,
        accountEmail,
      } satisfies StoredTokens);
      const now = this.#now().toISOString();
      this.#vault.repository.upsertConnectorConfig({
        id: connectorId(provider),
        provider,
        accountLabel: accountEmail,
        publicConfig: { ...config.publicConfig },
        secretRef: `secure-store://${secretKey(provider)}`,
        scopes: prepared.scopes,
        status: 'connected',
        createdAt: now,
        updatedAt: now,
      });
      this.#errors.delete(provider);
      await this.#vault.persist();
    } catch (error) {
      this.#errors.set(
        provider,
        error instanceof Error ? error.message : 'OAuth connection failed',
      );
      throw error;
    }
    return (await this.statuses()).find((status) => status.provider === provider)!;
  }

  async disconnect(provider: ConnectorProvider): Promise<ConnectorStatus> {
    const now = this.#now().toISOString();
    this.#secureStore.delete(secretKey(provider));
    if (provider === 'google') this.#secureStore.delete('oauth/google/client');
    this.#vault.vault.run(
      "UPDATE connector_configs SET status='disabled',updated_at=? WHERE id=?",
      [now, connectorId(provider)],
    );
    this.#vault.recordConnectorDisconnect(provider, now);
    this.#errors.delete(provider);
    await this.#vault.persist();
    return (await this.statuses()).find((status) => status.provider === provider)!;
  }

  async test(provider: ConnectorProvider): Promise<ConnectorStatus> {
    try {
      const token = await this.#accessToken(provider);
      await this.#accountEmail(provider, token);
      this.#errors.delete(provider);
    } catch (error) {
      this.#errors.set(provider, error instanceof Error ? error.message : 'Connection test failed');
      throw error;
    }
    return (await this.statuses()).find((status) => status.provider === provider)!;
  }

  #calendarConnector(provider: ConnectorProvider): GoogleConnector | MicrosoftConnector {
    const options = {
      fetch: this.#fetch,
      getAccessToken: () => this.#accessToken(provider),
      sendLedger: new CalendarOnlyLedger(),
      now: this.#now,
    };
    return provider === 'google' ? new GoogleConnector(options) : new MicrosoftConnector(options);
  }

  #mailIdentityDigest(accountLabel: string): string {
    const identities = this.#vault.vault
      .all<{ normalized_value: string }>(
        `SELECT DISTINCT normalized_value FROM contact_methods
         WHERE kind IN ('work_email','personal_email') ORDER BY normalized_value`,
      )
      .map((row) => row.normalized_value);
    return createHash('sha256')
      .update(`${normalizeEmail(accountLabel)}\n${identities.join('\n')}`)
      .digest('hex');
  }

  #relationshipReadScopePresent(
    provider: ConnectorProvider,
    config: { publicConfig: PublicConfig; scopes: string[] },
  ): boolean {
    if (!config.publicConfig.relationshipSync) return false;
    const minimum = new Set(getScopes(provider, 'minimum'));
    return getScopes(provider, 'relationship-sync')
      .filter((scope) => !minimum.has(scope))
      .every((scope) => config.scopes.includes(scope));
  }

  async #storeMailSyncProgress(
    provider: ConnectorProvider,
    config: {
      publicConfig: PublicConfig;
      accountLabel: string;
      scopes: string[];
    },
    progress: MailSyncProgress,
  ): Promise<void> {
    const updatedAt = this.#now().toISOString();
    this.#vault.repository.upsertConnectorConfig({
      id: connectorId(provider),
      provider,
      accountLabel: config.accountLabel,
      publicConfig: { ...config.publicConfig, mailSyncProgress: progress },
      secretRef: `secure-store://${secretKey(provider)}`,
      scopes: config.scopes,
      status: 'connected',
      createdAt: updatedAt,
      updatedAt,
    });
    await this.#vault.persist();
    config.publicConfig = { ...config.publicConfig, mailSyncProgress: progress };
  }

  async #reconcileMail(provider: ConnectorProvider): Promise<AppBootstrap> {
    const config = this.#config(provider);
    if (!config || config.status !== 'connected') throw new Error(`${provider} is not connected`);
    if (!this.#relationshipReadScopePresent(provider, config)) {
      throw new Error(
        'Complete mailbox reconciliation requires the relationship-sync read scope. Reconnect with relationship sync enabled.',
      );
    }

    const identityDigest = this.#mailIdentityDigest(config.accountLabel);
    const full =
      !config.publicConfig.mailHistoryComplete ||
      config.publicConfig.mailIdentityDigest !== identityDigest ||
      !config.publicConfig.lastMailSyncAt;
    const mode: MailSyncProgress['mode'] = full ? 'full' : 'incremental';
    const existingProgress = config.publicConfig.mailSyncProgress;
    const canResume =
      existingProgress?.mode === mode && existingProgress.identityDigest === identityDigest;
    const startedAt = canResume ? existingProgress.startedAt : this.#now().toISOString();
    const since = full
      ? undefined
      : canResume && existingProgress.since
        ? existingProgress.since
        : new Date(Date.parse(config.publicConfig.lastMailSyncAt!) - 5 * 60_000).toISOString();
    const progress: MailSyncProgress = canResume
      ? { ...existingProgress }
      : {
          mode,
          startedAt,
          identityDigest,
          ...(since ? { since } : {}),
          scopeIndex: 0,
          seenTokenDigests: [],
        };
    const scopes: Array<'all' | 'sent'> = provider === 'microsoft' ? ['sent', 'all'] : ['all'];
    const connector = this.#calendarConnector(provider);

    while (progress.scopeIndex < scopes.length) {
      const mailbox = scopes[progress.scopeIndex]!;
      const page = await connector.listMailboxMessages({
        ...(progress.since ? { since: progress.since } : {}),
        mailbox,
        pageSize: 100,
        ...(progress.pageToken ? { pageToken: progress.pageToken } : {}),
      });
      await this.#vault.importMailboxMessages(provider, config.accountLabel, page.messages, {
        skipBootstrap: true,
      });

      if (page.nextPageToken) {
        const tokenDigest = createHash('sha256').update(page.nextPageToken).digest('hex');
        if (
          page.nextPageToken === progress.pageToken ||
          progress.seenTokenDigests.includes(tokenDigest)
        ) {
          throw new Error(
            'Mailbox provider returned a pagination token loop; history remains incomplete and sending is blocked.',
          );
        }
        progress.pageToken = page.nextPageToken;
        progress.seenTokenDigests = [...progress.seenTokenDigests, tokenDigest];
      } else {
        progress.scopeIndex += 1;
        delete progress.pageToken;
        progress.seenTokenDigests = [];
      }
      if (progress.scopeIndex < scopes.length) {
        await this.#storeMailSyncProgress(provider, config, progress);
      }
    }

    const completedAt = this.#now().toISOString();
    const completedConfig: PublicConfig = {
      ...config.publicConfig,
      lastSyncAt: completedAt,
      // The start time is the reconciliation high-water mark. A subsequent
      // overlap scan catches messages that arrived while pages were exhausted.
      lastMailSyncAt: startedAt,
      mailHistoryComplete: true,
      mailIdentityDigest: identityDigest,
    };
    delete completedConfig.mailSyncProgress;
    this.#vault.repository.upsertConnectorConfig({
      id: connectorId(provider),
      provider,
      accountLabel: config.accountLabel,
      publicConfig: { ...completedConfig },
      secretRef: `secure-store://${secretKey(provider)}`,
      scopes: config.scopes,
      status: 'connected',
      createdAt: completedAt,
      updatedAt: completedAt,
    });
    await this.#vault.persist();
    this.#errors.delete(provider);
    return this.#vault.bootstrap();
  }

  async syncCalendar(provider: ConnectorProvider): Promise<AppBootstrap> {
    const config = this.#config(provider);
    if (!config || config.status !== 'connected') throw new Error(`${provider} is not connected`);
    const connector = this.#calendarConnector(provider);
    const start = new Date(this.#now());
    start.setUTCDate(start.getUTCDate() - 30);
    const end = new Date(this.#now());
    end.setUTCFullYear(end.getUTCFullYear() + 1);
    const events: CalendarEvent[] = [];
    const seenTokens = new Set<string>();
    let pageToken: string | undefined;
    let historyComplete = false;
    for (let pageNumber = 0; pageNumber < MAX_CALENDAR_SYNC_PAGES; pageNumber += 1) {
      const page = await connector.listEvents({
        timeMin: start.toISOString(),
        timeMax: end.toISOString(),
        pageSize: 250,
        ...(pageToken ? { pageToken } : {}),
      });
      events.push(...page.events);
      if (!page.nextPageToken) {
        historyComplete = true;
        break;
      }
      if (seenTokens.has(page.nextPageToken)) {
        throw new Error(
          'Calendar provider returned a pagination token loop; the partial sync was discarded.',
        );
      }
      seenTokens.add(page.nextPageToken);
      pageToken = page.nextPageToken;
    }
    if (!historyComplete) {
      throw new Error(
        `Calendar history exceeded the ${MAX_CALENDAR_SYNC_PAGES.toLocaleString('en-US')}-page safety limit; the partial sync was discarded.`,
      );
    }
    const syncedAt = this.#now().toISOString();
    await this.#vault.importCalendarEvents(provider, events);
    this.#vault.repository.upsertConnectorConfig({
      id: connectorId(provider),
      provider,
      accountLabel: config.accountLabel,
      publicConfig: {
        ...config.publicConfig,
        lastSyncAt: syncedAt,
        lastCalendarSyncAt: syncedAt,
      },
      secretRef: `secure-store://${secretKey(provider)}`,
      scopes: config.scopes,
      status: 'connected',
      createdAt: syncedAt,
      updatedAt: syncedAt,
    });
    await this.#vault.persist();
    const bootstrap = await this.#vault.bootstrap();
    this.#errors.delete(provider);
    return bootstrap;
  }

  async syncMail(provider: ConnectorProvider): Promise<AppBootstrap> {
    return this.#reconcileMail(provider);
  }

  async createMeeting(input: Omit<MeetingItem, 'id'>): Promise<MeetingItem> {
    if (input.provider === 'manual') return this.#vault.createMeeting(input);
    const connector = this.#calendarConnector(input.provider);
    const event = await connector.createEvent({
      title: input.title,
      start: { dateTime: input.startsAt },
      end: { dateTime: input.endsAt },
      ...(input.location ? { location: input.location } : {}),
      ...(input.agenda ? { description: input.agenda, descriptionType: 'text' as const } : {}),
      attendees: this.#vault.calendarAttendees(input.personIds).map((attendee) => ({
        email: attendee.email,
        ...(attendee.name ? { name: attendee.name } : {}),
      })),
      operationKey: `meeting:${randomUUID()}`,
    });
    const bootstrap = await this.#vault.importCalendarEvents(input.provider, [event]);
    const meeting = bootstrap.meetings.find(
      (item) =>
        item.provider === input.provider &&
        item.title === event.title &&
        item.startsAt === (event.start.dateTime ?? input.startsAt),
    );
    if (!meeting)
      throw new Error(
        'Calendar event was created but could not be stored locally; run calendar sync to reconcile it',
      );
    // Persist the founder's explicit canonical relationships after importing the
    // provider event. Provider payloads receive name/email only; local person IDs
    // never leave the vault.
    return this.#vault.updateMeeting({
      id: meeting.id,
      agenda: input.agenda,
      notes: input.notes,
      investorId: input.investorId,
      personIds: input.personIds,
    });
  }

  async #accountEmail(provider: ConnectorProvider, accessToken: string): Promise<string> {
    const url =
      provider === 'google'
        ? 'https://openidconnect.googleapis.com/v1/userinfo'
        : 'https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName';
    const response = await this.#fetch(url, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) throw new Error(`${provider} account lookup failed (${response.status})`);
    const body = (await response.json()) as {
      email?: string;
      mail?: string;
      userPrincipalName?: string;
    };
    const email = body.email ?? body.mail ?? body.userPrincipalName;
    if (!email) throw new Error(`${provider} did not return an account email`);
    return email;
  }

  async #accessToken(provider: ConnectorProvider): Promise<string> {
    const config = this.#config(provider);
    if (!config || config.status !== 'connected') throw new Error(`${provider} is not connected`);
    const tokens = await this.#secureStore.get<StoredTokens>(secretKey(provider));
    if (!tokens) throw new Error(`${provider} credentials are not available`);
    if (!tokens.expiresAt || Date.parse(tokens.expiresAt) > this.#now().getTime() + 60_000)
      return tokens.accessToken;
    if (!tokens.refreshToken)
      throw new Error(
        `${provider} access expired and no refresh token is available; reconnect the account`,
      );
    const clientSecret =
      provider === 'google'
        ? await this.#googleClientSecret(config.publicConfig.clientId)
        : undefined;
    const refreshed = await refreshAccessToken({
      provider,
      fetch: this.#fetch,
      clientId: config.publicConfig.clientId,
      ...(clientSecret ? { clientSecret } : {}),
      refreshToken: tokens.refreshToken,
      scopes: config.scopes,
      ...(config.publicConfig.tenantId ? { tenant: config.publicConfig.tenantId } : {}),
      now: this.#now,
    });
    const updated: StoredTokens = {
      ...tokens,
      ...refreshed,
      refreshToken: refreshed.refreshToken ?? tokens.refreshToken,
    };
    await this.#secureStore.set(secretKey(provider), updated);
    await this.#vault.persist();
    return updated.accessToken;
  }

  async #googleClientSecret(clientId: string): Promise<string | undefined> {
    const credential = await this.#secureStore.get<{ clientId: string; clientSecret: string }>(
      'oauth/google/client',
    );
    return credential?.clientId === clientId ? credential.clientSecret : undefined;
  }

  async sendApprovedDraft(id: string, expectedContentHash: string): Promise<DraftMessage> {
    const message = this.#vault.vault.one<{
      id: string;
      recipient_person_id: string;
      recipient_address: string;
      provider: ConnectorProvider;
      sender_address: string;
      sender_normalized: string;
      message_kind: DraftMessage['kind'];
      provider_thread_id: string | null;
      subject: string;
      body_text: string;
      attachments_json: string;
    }>(
      'SELECT id,recipient_person_id,recipient_address,provider,sender_address,sender_normalized,message_kind,provider_thread_id,subject,body_text,attachments_json FROM messages WHERE id=?',
      [id],
    );
    if (!message) throw new Error('Draft not found');
    const draft = (await this.#vault.bootstrap()).drafts.find((item) => item.id === id);
    if (!draft || draft.contentHash !== expectedContentHash)
      throw new Error('Message content changed after approval');
    if (draft.approvalState !== 'approved')
      throw new Error('Exact founder approval is required before sending');
    if (message.message_kind !== 'initial') {
      throw new Error('Outreachr 0.1 sends initial outreach only');
    }
    const provider = message.provider;
    const approval = this.#vault.vault.one<{
      id: string;
      approved_at: string;
      provider: ConnectorProvider;
      sender_address: string;
      sender_normalized: string;
      message_kind: DraftMessage['kind'];
      provider_thread_id: string | null;
    }>(
      "SELECT id,approved_at,provider,sender_address,sender_normalized,message_kind,provider_thread_id FROM approvals WHERE message_id=? AND status='active' ORDER BY approved_at DESC LIMIT 1",
      [id],
    );
    if (!approval) throw new Error('Active approval is missing');
    if (
      approval.provider !== provider ||
      approval.sender_normalized !== message.sender_normalized ||
      normalizeEmail(approval.sender_address) !== message.sender_normalized ||
      approval.message_kind !== message.message_kind ||
      (approval.provider_thread_id ?? null) !== (message.provider_thread_id ?? null)
    ) {
      throw new Error('Provider, sender, message kind, or thread changed after approval');
    }

    const config = this.#config(provider);
    if (!config || config.status !== 'connected') throw new Error(`${provider} is not connected`);
    // Sending is fail-closed on a complete, current mailbox reconciliation.
    // This runs before a durable reservation or any provider send endpoint.
    const reconciled = await this.#reconcileMail(provider);
    const reconciledDraft = reconciled.drafts.find((item) => item.id === id);
    if (!reconciledDraft || reconciledDraft.contentHash !== expectedContentHash) {
      throw new Error('Message changed during mailbox reconciliation');
    }
    if (reconciledDraft.blockReason) {
      throw new Error(reconciledDraft.blockReason);
    }
    const accessToken = await this.#accessToken(provider);
    const authenticatedTokens = await this.#secureStore.get<StoredTokens>(secretKey(provider));
    if (!authenticatedTokens?.accountEmail) {
      throw new Error(`${provider} authenticated account identity is unavailable`);
    }
    const authenticatedSender = normalizeEmail(authenticatedTokens.accountEmail);
    if (
      authenticatedSender !== message.sender_normalized ||
      normalizeEmail(config.accountLabel) !== message.sender_normalized
    ) {
      throw new Error('Currently authenticated account does not match the founder-approved sender');
    }

    const email: EmailMessage = {
      to: [
        {
          email: message.recipient_address,
          name: draft.recipientName,
          recipientKey: message.recipient_person_id,
        },
      ],
      subject: message.subject,
      text: message.body_text,
    };
    const context: SendContext = {
      provider,
      senderAddress: authenticatedTokens.accountEmail,
      messageKind: message.message_kind,
      ...(message.provider_thread_id ? { providerThreadId: message.provider_thread_id } : {}),
    };
    const fingerprint = await fingerprintEmail(email, context);
    const reservation = this.#vault.repository.reserveApprovedSend(
      id,
      provider,
      authenticatedTokens.accountEmail,
      this.#now().toISOString(),
    );
    try {
      await this.#vault.persist();
    } catch (error) {
      this.#vault.repository.markFailedBeforeDispatch(
        reservation.id,
        'LOCAL_RESERVATION_PERSIST_FAILED',
        error instanceof Error ? error.message : 'Local reservation persistence failed',
        this.#now().toISOString(),
      );
      throw error;
    }
    const ledger = new CoreSendLedger(this.#vault, reservation.id, fingerprint, context);
    const options = {
      fetch: this.#fetch,
      getAccessToken: () => accessToken,
      sendLedger: ledger,
      now: this.#now,
    };
    const connector =
      provider === 'google' ? new GoogleConnector(options) : new MicrosoftConnector(options);
    try {
      await connector.sendEmail({
        message: email,
        context,
        safety: {
          operationKey: reservation.id,
          approval: {
            approved: true,
            approvalId: approval.id,
            approvedAt: approval.approved_at,
            messageFingerprint: fingerprint,
            context,
          },
          duplicateCheck: {
            checkedAt: this.#now().toISOString(),
            checkedRecipientKeys: [message.recipient_person_id],
            previouslyContactedRecipientKeys: [],
          },
        },
        saveToSentItems: true,
      });
    } catch (error) {
      const ledgerRow = this.#vault.vault.one<{ dispatch_status: string }>(
        'SELECT dispatch_status FROM send_ledger WHERE id=?',
        [reservation.id],
      );
      if (ledgerRow?.dispatch_status === 'reserved') {
        this.#vault.repository.markFailedBeforeDispatch(
          reservation.id,
          'PRE_DISPATCH_FAILED',
          error instanceof Error ? error.message : 'Unknown pre-dispatch failure',
          this.#now().toISOString(),
        );
      } else if (ledgerRow?.dispatch_status === 'dispatching') {
        this.#vault.repository.markSendAmbiguous(
          reservation.id,
          'SEND_OUTCOME_UNCERTAIN',
          error instanceof Error ? error.message : 'Unknown provider error',
          this.#now().toISOString(),
        );
      }
      await this.#vault.persist();
      throw error;
    }
    await this.#vault.persist();
    return (await this.#vault.bootstrap()).drafts.find((item) => item.id === id)!;
  }
}
