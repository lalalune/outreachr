/** Adapts generic Cloud app delegation to Outreachr's server-only identity and Google ports. */
import {
  AppDelegationClient,
  APP_DELEGATION_SCOPES,
  type AppDelegationScope,
} from '@elizaos/cloud-sdk/app-delegation';
import { CloudApiError, ElizaCloudClient, buildAppAuthorizeUrl } from '@elizaos/cloud-sdk';
import { z } from 'zod';
import { CloudError, requireCondition } from './errors';

export const GOOGLE_CAPABILITIES = [
  'google.basic_identity',
  'google.gmail.triage',
  'google.gmail.send',
  'google.calendar.read',
  'google.calendar.write',
] satisfies AppDelegationScope[];
export const DELEGATION_SCOPES: AppDelegationScope[] = [
  'identity',
  'inference',
  'billing:read',
  'billing:write',
  ...GOOGLE_CAPABILITIES,
];
const scope = z.enum(APP_DELEGATION_SCOPES);
const principal = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid().nullable(),
  email: z.email().nullable(),
  name: z.string().nullable(),
  emailVerified: z.boolean(),
});
const grantSchema = z.object({
  appId: z.string().uuid(),
  billingEnvironment: z.enum(['test', 'live']),
  token: z.string().regex(/^ead_[A-Za-z0-9_-]{43}$/),
  expiresAt: z.iso.datetime(),
  scopes: z.array(scope),
  user: principal,
});
export const delegatedGoogleConnection = z.object({
  connectionId: z.string().uuid().nullable(),
  connected: z.boolean(),
  identity: z.record(z.string(), z.unknown()).nullable(),
  grantedCapabilities: z.array(scope),
  reason: z.string(),
});
export type DelegatedGoogleConnection = z.infer<typeof delegatedGoogleConnection>;

function dataOf(value: unknown): unknown {
  return z.object({ success: z.literal(true), data: z.unknown() }).parse(value).data;
}

function verifiedIdentity(value: unknown) {
  const identity = principal.parse(value);
  requireCondition(
    identity.emailVerified && identity.email,
    403,
    'verified_email_required',
    'Verify your email in Eliza Cloud before signing in to Outreachr.',
  );
  return { ...identity, email: identity.email, name: identity.name?.trim() || identity.email };
}

export interface DelegationConfig {
  appId: string;
  clientId: string;
  clientSecret: string;
  billingEnvironment: 'test' | 'live';
  apiOrigin: string;
  loginOrigin: string;
  publicOrigin: string;
}

export class OutreachrDelegation {
  private readonly sdk: AppDelegationClient;
  constructor(
    readonly config: DelegationConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    for (const origin of [config.apiOrigin, config.loginOrigin, config.publicOrigin]) {
      const url = new URL(origin);
      if (
        url.origin !== origin ||
        (url.protocol !== 'https:' &&
          !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)))
      )
        throw new Error('Cloud delegation requires exact HTTPS origins or local test origins.');
    }
    this.sdk = new AppDelegationClient({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      apiBaseUrl: `${config.apiOrigin}/api/v1`,
      // Never forward credentials through an upstream redirect or retry an ambiguous send.
      fetchImpl: (input, init) => this.fetchImpl(input, { ...init, redirect: 'error' }),
    });
  }
  appBilling(token: string) {
    return new ElizaCloudClient({
      apiBaseUrl: `${this.config.apiOrigin}/api/v1`,
      defaultHeaders: this.sdk.headers(token),
      fetchImpl: (input, init) =>
        this.fetchImpl(input, {
          ...init,
          redirect: 'error',
          signal: AbortSignal.any([
            ...(init?.signal ? [init.signal] : []),
            AbortSignal.timeout(15_000),
          ]),
        }),
    }).appBilling(this.config.appId, { clientId: this.config.clientId });
  }
  appBillingBackend() {
    return new ElizaCloudClient({
      apiBaseUrl: `${this.config.apiOrigin}/api/v1`,
      defaultHeaders: {
        Authorization: `Basic ${Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString('base64')}`,
      },
      fetchImpl: (input, init) =>
        this.fetchImpl(input, {
          ...init,
          redirect: 'error',
          signal: AbortSignal.any([
            ...(init?.signal ? [init.signal] : []),
            AbortSignal.timeout(15_000),
          ]),
        }),
    }).appBilling(this.config.appId, { clientId: this.config.clientId });
  }
  authorizeUrl(state: string) {
    return buildAppAuthorizeUrl({
      appId: this.config.appId,
      baseUrl: this.config.loginOrigin,
      redirectUri: `${this.config.publicOrigin}/api/auth/callback`,
      state,
      delegation: { clientId: this.config.clientId, scopes: DELEGATION_SCOPES },
    });
  }
  private async invoke<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof CloudError) throw error;
      if (error instanceof CloudApiError) {
        if (error.errorBody.code === 'APP_GOOGLE_ACCOUNT_REQUIRED')
          throw new CloudError(
            403,
            'google_account_setup_required',
            'Finish free account setup in Eliza Cloud before connecting Google.',
          );
        if (error.statusCode === 401)
          throw new CloudError(
            401,
            'eliza_authorization_expired',
            'Sign in again to reconnect Eliza Cloud.',
          );
        if (error.statusCode === 403)
          throw new CloudError(
            403,
            'eliza_permission_required',
            'Reconnect Eliza Cloud with the required permissions.',
          );
      }
      throw new CloudError(
        502,
        'eliza_request_unconfirmed',
        'Eliza Cloud did not return a confirmed result.',
      );
    }
  }
  exchange(code: string) {
    return this.invoke(async () => {
      const response = await this.sdk.exchange(
        code,
        `${this.config.publicOrigin}/api/auth/callback`,
      );
      const grant = grantSchema.parse(dataOf(response));
      requireCondition(
        grant.appId === this.config.appId &&
          grant.billingEnvironment === this.config.billingEnvironment &&
          grant.scopes.includes('identity') &&
          new Date(grant.expiresAt).getTime() > Date.now(),
        401,
        'delegation_binding_invalid',
        'Sign in again using this Outreachr app registration.',
      );
      return { ...grant, user: verifiedIdentity(grant.user) };
    });
  }
  identity(token: string) {
    return this.invoke(async () => verifiedIdentity(dataOf(await this.sdk.identity(token))));
  }
  connections(token: string) {
    return this.invoke(async () =>
      z.array(delegatedGoogleConnection).parse(dataOf(await this.sdk.googleConnections(token))),
    );
  }
  connectGoogle(token: string) {
    return this.invoke(async () => {
      const redirectUri = `${this.config.publicOrigin}/api/google/callback`;
      const response = await this.sdk.connectGoogle(token, {
        redirectUri,
        capabilities: GOOGLE_CAPABILITIES,
      });
      const result = z
        .object({ authUrl: z.url(), redirectUri: z.url(), requestedCapabilities: z.array(scope) })
        .parse(dataOf(response));
      const target = new URL(result.authUrl);
      requireCondition(
        result.redirectUri === redirectUri &&
          result.requestedCapabilities.length === GOOGLE_CAPABILITIES.length &&
          GOOGLE_CAPABILITIES.every((capability) =>
            result.requestedCapabilities.includes(capability),
          ) &&
          target.origin === 'https://accounts.google.com' &&
          ['/o/oauth2/v2/auth', '/o/oauth2/auth'].includes(target.pathname) &&
          !target.username &&
          !target.password &&
          !target.hash,
        502,
        'google_authorization_invalid',
        'Eliza returned an invalid Google authorization URL.',
      );
      return { authUrl: target.href };
    });
  }
  revoke(token: string) {
    return this.invoke(async () => {
      z.object({ success: z.literal(true) }).parse(await this.sdk.revoke(token));
    });
  }
  googleFetch(token: string, connectionId: string): typeof fetch {
    return async (input, init) => {
      requireCondition(
        !(input instanceof Request),
        400,
        'google_request_invalid',
        'Use an explicit Google URL and request options.',
      );
      const method = z.enum(['GET', 'POST', 'PATCH', 'DELETE']).parse(init?.method ?? 'GET');
      requireCondition(
        init?.body === undefined || typeof init.body === 'string',
        400,
        'google_body_invalid',
        'Google requests must use a JSON body.',
      );
      return this.invoke(() =>
        this.sdk.googleRequest(token, {
          connectionId,
          url: String(input),
          method,
          ...(typeof init?.body === 'string' ? { body: init.body } : {}),
        }),
      );
    };
  }
}

/** Equivalent local connector permissions from Cloud's app/provider intersection, not raw provider grants.
 * Cloud still authorizes every proxied operation independently. No broad modify/compose scope is inferred.
 */
export function effectiveGoogleScopes(capabilities: readonly AppDelegationScope[]): string[] {
  if (!capabilities.includes('google.basic_identity')) return [];
  const scopes = ['openid', 'https://www.googleapis.com/auth/userinfo.email'];
  if (capabilities.includes('google.gmail.triage'))
    scopes.push('https://www.googleapis.com/auth/gmail.readonly');
  if (capabilities.includes('google.gmail.send'))
    scopes.push('https://www.googleapis.com/auth/gmail.send');
  if (capabilities.includes('google.calendar.read'))
    scopes.push('https://www.googleapis.com/auth/calendar.readonly');
  if (capabilities.includes('google.calendar.write'))
    scopes.push('https://www.googleapis.com/auth/calendar.events');
  return scopes;
}
