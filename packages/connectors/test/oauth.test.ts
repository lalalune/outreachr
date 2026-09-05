import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  ConnectorError,
  createLoopbackRedirectUri,
  createPkcePair,
  exchangeAuthorizationCode,
  getScopes,
  prepareDesktopAuthorization,
  PROVIDER_DRAFT_SCOPES,
  refreshAccessToken,
  tokenEndpoint,
  validateOAuthCallback,
} from '../src/index.js';

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('desktop OAuth and PKCE', () => {
  it('sends a Google Desktop secret only in token exchange and refresh bodies', async () => {
    const grants: string[] = [];
    server.use(
      http.post(tokenEndpoint('google'), async ({ request }) => {
        const body = new URLSearchParams(await request.text());
        expect(body.get('client_secret')).toBe('desktop-secret');
        expect(request.url).not.toContain('desktop-secret');
        grants.push(body.get('grant_type')!);
        return HttpResponse.json({ access_token: 'access', token_type: 'Bearer' });
      }),
    );
    await exchangeAuthorizationCode({
      provider: 'google',
      fetch,
      clientId: 'client',
      clientSecret: 'desktop-secret',
      code: 'code',
      codeVerifier: 'verifier',
      redirectUri: 'http://127.0.0.1:49152/oauth/callback',
    });
    await refreshAccessToken({
      provider: 'google',
      fetch,
      clientId: 'client',
      clientSecret: 'desktop-secret',
      refreshToken: 'refresh',
    });
    expect(grants).toEqual(['authorization_code', 'refresh_token']);
    await expect(
      refreshAccessToken({
        provider: 'microsoft',
        fetch,
        clientId: 'client',
        clientSecret: 'desktop-secret',
        refreshToken: 'refresh',
      }),
    ).rejects.toThrow('Microsoft desktop clients');
  });

  it('never exposes token endpoint echoes of credentials in errors', async () => {
    server.use(
      http.post(tokenEndpoint('google'), () =>
        HttpResponse.json(
          {
            error: 'invalid_client',
            error_description: 'Rejected secret-private-value',
            access_token: 'echoed-access-token',
          },
          { status: 400 },
        ),
      ),
    );
    try {
      await refreshAccessToken({
        provider: 'google',
        fetch,
        clientId: 'client',
        clientSecret: 'secret-private-value',
        refreshToken: 'refresh',
      });
      expect.unreachable('Token exchange should fail');
    } catch (error) {
      expect(error).toBeInstanceOf(ConnectorError);
      expect(String(error)).not.toContain('secret-private-value');
      expect(JSON.stringify(error)).not.toContain('secret-private-value');
      expect(JSON.stringify(error)).not.toContain('echoed-access-token');
      expect(error).toMatchObject({ providerCode: 'invalid_client' });
    }
  });

  it('creates RFC 7636 S256 material and loopback authorization URLs', async () => {
    const redirectUri = createLoopbackRedirectUri(48_231);
    const request = await prepareDesktopAuthorization({
      provider: 'google',
      clientId: 'google-desktop-client',
      redirectUri,
      scopeProfile: 'relationship-sync',
      loginHint: 'founder@example.com',
    });
    const url = new URL(request.authorizationUrl);

    expect(request.pkce.verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/u);
    expect(request.pkce.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(url.origin).toBe('https://accounts.google.com');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('client_secret')).toBeNull();
    expect(url.searchParams.get('scope')).toContain('gmail.readonly');
    expect(url.searchParams.get('access_type')).toBe('offline');
  });

  it('uses Microsoft delegated scopes and tenant-specific endpoints', async () => {
    const request = await prepareDesktopAuthorization({
      provider: 'microsoft',
      clientId: 'entra-public-client',
      tenant: 'organizations',
      redirectUri: 'http://localhost:41231/oauth/callback',
    });
    const url = new URL(request.authorizationUrl);
    expect(url.pathname).toContain('/organizations/oauth2/v2.0/authorize');
    expect(request.scopes).toContain('Mail.Send');
    expect(request.scopes).not.toContain('Mail.ReadWrite');
    expect(request.scopes).not.toContain('Mail.ReadBasic');
    expect(getScopes('microsoft', 'relationship-sync')).toContain('Mail.ReadBasic');
    expect(PROVIDER_DRAFT_SCOPES.microsoft).toContain('Mail.ReadWrite');
  });

  it('validates callback state and rejects non-loopback redirect URIs', async () => {
    expect(
      validateOAuthCallback(
        'http://127.0.0.1:49152/oauth/callback?code=code-1&state=state-1',
        'state-1',
      ),
    ).toEqual({ code: 'code-1', state: 'state-1' });
    expect(() =>
      validateOAuthCallback(
        'http://127.0.0.1:49152/oauth/callback?code=code-1&state=wrong',
        'state-1',
      ),
    ).toThrowError(ConnectorError);
    await expect(
      prepareDesktopAuthorization({
        provider: 'google',
        clientId: 'client',
        redirectUri: 'https://attacker.example/callback',
      }),
    ).rejects.toThrow('loopback');
  });

  it('exchanges Google and Microsoft codes without a client secret', async () => {
    const seenBodies: URLSearchParams[] = [];
    server.use(
      http.post(tokenEndpoint('google'), async ({ request }) => {
        seenBodies.push(new URLSearchParams(await request.text()));
        return HttpResponse.json({
          access_token: 'google-access',
          refresh_token: 'google-refresh',
          token_type: 'Bearer',
          expires_in: 3600,
          scope: 'openid email',
        });
      }),
      http.post(tokenEndpoint('microsoft', 'common'), async ({ request }) => {
        seenBodies.push(new URLSearchParams(await request.text()));
        return HttpResponse.json({
          access_token: 'microsoft-access',
          refresh_token: 'microsoft-refresh',
          token_type: 'Bearer',
          expires_in: 7200,
        });
      }),
    );

    const pkce = await createPkcePair();
    const google = await exchangeAuthorizationCode({
      provider: 'google',
      fetch,
      clientId: 'google-client',
      code: 'google-code',
      codeVerifier: pkce.verifier,
      redirectUri: 'http://127.0.0.1:49152/oauth/callback',
      now: () => new Date('2026-07-31T00:00:00Z'),
    });
    const microsoft = await exchangeAuthorizationCode({
      provider: 'microsoft',
      fetch,
      clientId: 'entra-client',
      code: 'microsoft-code',
      codeVerifier: pkce.verifier,
      redirectUri: 'http://localhost:49153/oauth/callback',
      now: () => new Date('2026-07-31T00:00:00Z'),
    });

    expect(google.accessToken).toBe('google-access');
    expect(google.expiresAt).toBe('2026-07-31T01:00:00.000Z');
    expect(microsoft.expiresAt).toBe('2026-07-31T02:00:00.000Z');
    for (const body of seenBodies) {
      expect(body.get('code_verifier')).toBe(pkce.verifier);
      expect(body.has('client_secret')).toBe(false);
    }
  });

  it('refreshes tokens and maps OAuth endpoint errors', async () => {
    server.use(
      http.post(tokenEndpoint('google'), async ({ request }) => {
        const body = new URLSearchParams(await request.text());
        expect(body.get('grant_type')).toBe('refresh_token');
        expect(body.has('client_secret')).toBe(false);
        return HttpResponse.json({
          access_token: 'refreshed',
          token_type: 'Bearer',
          expires_in: 60,
        });
      }),
    );
    await expect(
      refreshAccessToken({
        provider: 'google',
        fetch,
        clientId: 'client',
        refreshToken: 'refresh',
      }),
    ).resolves.toMatchObject({ accessToken: 'refreshed' });

    server.use(
      http.post(tokenEndpoint('google'), () =>
        HttpResponse.json(
          { error: 'invalid_grant', error_description: 'Refresh token expired' },
          { status: 400 },
        ),
      ),
    );
    await expect(
      refreshAccessToken({
        provider: 'google',
        fetch,
        clientId: 'client',
        refreshToken: 'expired',
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
      providerCode: 'invalid_grant',
      message: 'OAuth authorization expired or was revoked; reconnect the account.',
    });
  });
});
