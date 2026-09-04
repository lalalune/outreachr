import { ConnectorError } from './errors.js';
import { randomBase64Url, sha256Base64Url } from './encoding.js';
import { getScopes, type ScopeProfile } from './scopes.js';
import type { ConnectorProvider, FetchLike } from './types.js';

export interface PkcePair {
  verifier: string;
  challenge: string;
  method: 'S256';
}

export interface DesktopAuthorizationRequest {
  provider: ConnectorProvider;
  clientId: string;
  redirectUri: string;
  scopes?: string[];
  scopeProfile?: ScopeProfile;
  tenant?: string;
  loginHint?: string;
  prompt?: string;
}

export interface PreparedAuthorizationRequest {
  authorizationUrl: string;
  state: string;
  pkce: PkcePair;
  redirectUri: string;
  scopes: string[];
}

export interface OAuthCallbackResult {
  code: string;
  state: string;
}

export interface OAuthTokenSet {
  accessToken: string;
  tokenType: string;
  expiresIn?: number;
  expiresAt?: string;
  refreshToken?: string;
  scope?: string;
  idToken?: string;
}

export interface ExchangeAuthorizationCodeInput {
  provider: ConnectorProvider;
  fetch: FetchLike;
  clientId: string;
  clientSecret?: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  tenant?: string;
  now?: () => Date;
}

export interface RefreshAccessTokenInput {
  provider: ConnectorProvider;
  fetch: FetchLike;
  clientId: string;
  clientSecret?: string;
  refreshToken: string;
  scopes?: string[];
  tenant?: string;
  now?: () => Date;
}

function microsoftTenant(tenant?: string): string {
  const value = tenant?.trim() || 'common';
  if (!/^[a-zA-Z0-9.-]+$/u.test(value)) {
    throw new TypeError('Microsoft tenant must be a tenant id or a supported tenant alias');
  }
  return value;
}

function authorizationEndpoint(provider: ConnectorProvider, tenant?: string): string {
  return provider === 'google'
    ? 'https://accounts.google.com/o/oauth2/v2/auth'
    : `https://login.microsoftonline.com/${microsoftTenant(tenant)}/oauth2/v2.0/authorize`;
}

export function tokenEndpoint(provider: ConnectorProvider, tenant?: string): string {
  return provider === 'google'
    ? 'https://oauth2.googleapis.com/token'
    : `https://login.microsoftonline.com/${microsoftTenant(tenant)}/oauth2/v2.0/token`;
}

export function createLoopbackRedirectUri(
  port: number,
  path = '/oauth/callback',
  host: '127.0.0.1' | 'localhost' = '127.0.0.1',
): string {
  if (!Number.isInteger(port) || port < 1_024 || port > 65_535) {
    throw new RangeError('Loopback redirect port must be an integer from 1024 through 65535');
  }
  if (!path.startsWith('/') || path.includes('?') || path.includes('#')) {
    throw new TypeError(
      'Loopback callback path must be an absolute path without query or fragment',
    );
  }
  return `http://${host}:${port}${path}`;
}

export function assertLoopbackRedirectUri(redirectUri: string): void {
  const url = new URL(redirectUri);
  const allowedHosts = new Set(['127.0.0.1', 'localhost', '[::1]']);
  if (
    url.protocol !== 'http:' ||
    !allowedHosts.has(url.hostname) ||
    !url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new TypeError(
      'Desktop OAuth redirect must be an http loopback URI with an explicit port and no credentials, query, or fragment',
    );
  }
}

export async function createPkcePair(): Promise<PkcePair> {
  // 64 random bytes produces an 86-character verifier, within RFC 7636's 43-128 range.
  const verifier = randomBase64Url(64);
  return {
    verifier,
    challenge: await sha256Base64Url(verifier),
    method: 'S256',
  };
}

export async function prepareDesktopAuthorization(
  input: DesktopAuthorizationRequest,
): Promise<PreparedAuthorizationRequest> {
  assertLoopbackRedirectUri(input.redirectUri);
  if (!input.clientId.trim()) throw new TypeError('OAuth client id is required');

  const scopes = input.scopes ?? getScopes(input.provider, input.scopeProfile);
  if (scopes.length === 0) throw new TypeError('At least one OAuth scope is required');

  const pkce = await createPkcePair();
  const state = randomBase64Url(32);
  const url = new URL(authorizationEndpoint(input.provider, input.tenant));
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', scopes.join(' '));
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', pkce.challenge);
  url.searchParams.set('code_challenge_method', pkce.method);
  if (input.loginHint) url.searchParams.set('login_hint', input.loginHint);

  if (input.provider === 'google') {
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('include_granted_scopes', 'true');
    url.searchParams.set('prompt', input.prompt ?? 'consent');
  } else if (input.prompt) {
    url.searchParams.set('prompt', input.prompt);
  }

  return {
    authorizationUrl: url.toString(),
    state,
    pkce,
    redirectUri: input.redirectUri,
    scopes,
  };
}

export function parseOAuthCallback(
  callbackUrl: string,
  expectedState: string,
): OAuthCallbackResult {
  return validateOAuthCallback(callbackUrl, expectedState);
}

function parseCallbackUrl(callbackUrl: string): URL {
  const url = new URL(callbackUrl);
  const base = new URL(url.toString());
  base.search = '';
  assertLoopbackRedirectUri(base.toString());
  return url;
}

export function validateOAuthCallback(
  callbackUrl: string,
  expectedState: string,
): OAuthCallbackResult {
  const url = parseCallbackUrl(callbackUrl);
  const returnedState = url.searchParams.get('state') ?? '';
  if (!expectedState || returnedState !== expectedState) {
    throw new ConnectorError({
      operation: 'oauth.callback',
      code: 'OAUTH_CALLBACK_INVALID',
      message: 'OAuth callback state did not match the authorization request',
    });
  }
  const providerError = url.searchParams.get('error');
  if (providerError) {
    throw new ConnectorError({
      operation: 'oauth.callback',
      code: 'OAUTH_CALLBACK_INVALID',
      message: url.searchParams.get('error_description') ?? providerError,
      providerCode: providerError,
    });
  }
  const code = url.searchParams.get('code');
  if (!code) {
    throw new ConnectorError({
      operation: 'oauth.callback',
      code: 'OAUTH_CALLBACK_INVALID',
      message: 'OAuth callback did not include an authorization code',
    });
  }
  return { code, state: returnedState };
}

interface TokenJson {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  id_token?: string;
  error?: string;
  error_description?: string;
}

async function postToken(
  provider: ConnectorProvider,
  fetchFn: FetchLike,
  tenant: string | undefined,
  body: URLSearchParams,
  operation: string,
  now: () => Date,
): Promise<OAuthTokenSet> {
  let response: Response;
  try {
    response = await fetchFn(tokenEndpoint(provider, tenant), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
  } catch {
    throw new ConnectorError({
      provider,
      operation,
      code: 'NETWORK_ERROR',
      message: 'OAuth token endpoint could not be reached',
      retryable: true,
    });
  }
  const json = (await response.json().catch(() => ({}))) as TokenJson;
  if (!response.ok || !json.access_token) {
    // Token endpoint diagnostics can echo submitted credentials. Expose only
    // known error codes and our own messages across the renderer/log boundary.
    const messages: Record<string, string> = {
      invalid_client:
        'OAuth client credentials were rejected; check the client ID and Desktop client secret.',
      invalid_grant: 'OAuth authorization expired or was revoked; reconnect the account.',
      invalid_request: 'OAuth token request was rejected; check the Desktop client configuration.',
      invalid_scope: 'OAuth scopes were rejected; check the provider permissions.',
      unauthorized_client: 'This OAuth client is not authorized for the desktop flow.',
      access_denied: 'OAuth access was denied.',
      unsupported_grant_type: 'The OAuth provider does not support this grant type.',
      temporarily_unavailable: 'The OAuth provider is temporarily unavailable.',
      server_error: 'The OAuth provider could not complete the token request.',
    };
    const providerCode =
      typeof json.error === 'string' && Object.hasOwn(messages, json.error)
        ? json.error
        : undefined;
    throw new ConnectorError({
      provider,
      operation,
      code: response.status === 401 ? 'UNAUTHORIZED' : 'INVALID_REQUEST',
      message: providerCode ? messages[providerCode]! : 'OAuth token request failed',
      httpStatus: response.status,
      providerCode,
    });
  }
  const expiresIn = json.expires_in;
  return {
    accessToken: json.access_token,
    tokenType: json.token_type ?? 'Bearer',
    expiresIn,
    expiresAt:
      expiresIn === undefined
        ? undefined
        : new Date(now().getTime() + expiresIn * 1_000).toISOString(),
    refreshToken: json.refresh_token,
    scope: json.scope,
    idToken: json.id_token,
  };
}

export async function exchangeAuthorizationCode(
  input: ExchangeAuthorizationCodeInput,
): Promise<OAuthTokenSet> {
  assertLoopbackRedirectUri(input.redirectUri);
  const body = new URLSearchParams({
    client_id: input.clientId,
    code: input.code,
    code_verifier: input.codeVerifier,
    redirect_uri: input.redirectUri,
    grant_type: 'authorization_code',
  });
  addDesktopClientSecret(body, input.provider, input.clientSecret);
  return postToken(
    input.provider,
    input.fetch,
    input.tenant,
    body,
    'oauth.exchange',
    input.now ?? (() => new Date()),
  );
}

export async function refreshAccessToken(input: RefreshAccessTokenInput): Promise<OAuthTokenSet> {
  const body = new URLSearchParams({
    client_id: input.clientId,
    refresh_token: input.refreshToken,
    grant_type: 'refresh_token',
  });
  addDesktopClientSecret(body, input.provider, input.clientSecret);
  if (input.scopes?.length) body.set('scope', input.scopes.join(' '));
  return postToken(
    input.provider,
    input.fetch,
    input.tenant,
    body,
    'oauth.refresh',
    input.now ?? (() => new Date()),
  );
}

function addDesktopClientSecret(
  body: URLSearchParams,
  provider: ConnectorProvider,
  secret?: string,
): void {
  if (!secret?.trim()) return;
  if (provider !== 'google')
    throw new TypeError('Microsoft desktop clients do not use a client secret');
  body.set('client_secret', secret.trim());
}
