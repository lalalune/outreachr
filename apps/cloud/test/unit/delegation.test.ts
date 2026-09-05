/** Exercises the packaged generic Cloud SDK through real local HTTP, never live Google. */
import { createServer, type Server, type IncomingHttpHeaders } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DELEGATION_SCOPES,
  effectiveGoogleScopes,
  GOOGLE_CAPABILITIES,
  OutreachrDelegation,
  type DelegationConfig,
} from '../../src/delegation';

let server: Server;
let client: OutreachrDelegation;
let config: DelegationConfig;
let reply: unknown;
let status: number;
let requests: {
  path: string;
  method: string;
  headers: IncomingHttpHeaders;
  body: unknown;
}[];
const token = `ead_${'a'.repeat(43)}`;
const user = {
  id: randomUUID(),
  organizationId: null,
  email: 'owner@example.test',
  name: null,
  emailVerified: true,
};
function grant(overrides = {}) {
  return {
    success: true,
    data: {
      appId: config.appId,
      billingEnvironment: 'test',
      token,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      scopes: DELEGATION_SCOPES,
      user,
      ...overrides,
    },
  };
}
beforeEach(async () => {
  requests = [];
  status = 200;
  reply = { success: true };
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const part of req) chunks.push(Buffer.from(part));
    const text = Buffer.concat(chunks).toString();
    requests.push({
      path: req.url!,
      method: req.method!,
      headers: req.headers,
      body: text ? JSON.parse(text) : undefined,
    });
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(reply));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (typeof address !== 'object' || !address) throw new Error('Missing local server port');
  config = {
    appId: randomUUID(),
    clientId: randomUUID(),
    clientSecret: 'local-fixture-only',
    billingEnvironment: 'test',
    apiOrigin: `http://127.0.0.1:${address.port}`,
    loginOrigin: 'https://cloud.eliza.test',
    publicOrigin: 'https://outreachr.example.test',
  };
  client = new OutreachrDelegation(config);
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('generic Cloud delegation consumer', () => {
  it('builds explicit app consent and accepts verified free identity without a Cloud organization', async () => {
    const url = new URL(client.authorizeUrl('browser-bound-state'));
    expect(url.pathname).toBe('/app-auth/authorize');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      flow: 'app_delegation',
      app_id: config.appId,
      client_id: config.clientId,
      state: 'browser-bound-state',
      redirect_uri: `${config.publicOrigin}/api/auth/callback`,
      scopes: DELEGATION_SCOPES.join(' '),
    });
    expect(url.href).not.toContain(config.clientSecret);
    expect(() => client.authorizeUrl('')).toThrow();
    reply = grant();
    expect((await client.exchange('eac_fixture')).user).toMatchObject({
      organizationId: null,
      name: user.email,
    });
    expect(requests[0]).toMatchObject({
      path: '/api/v1/app-auth/delegations/token',
      method: 'POST',
      body: { code: 'eac_fixture', redirectUri: `${config.publicOrigin}/api/auth/callback` },
    });
    expect(requests[0]!.headers.authorization).toBe(
      `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`,
    );
    expect(requests[0]!.headers['x-outreachr-client']).toBeUndefined();
  });
  it.each([
    ['another app', { appId: randomUUID() }],
    ['live grant in test', { billingEnvironment: 'live' }],
    ['expired credential', { expiresAt: '2000-01-01T00:00:00.000Z' }],
    ['missing identity scope', { scopes: ['billing:read'] }],
  ])('rejects %s before creating a session', async (_label, overrides) => {
    reply = grant(overrides);
    await expect(client.exchange('eac_fixture')).rejects.toMatchObject({
      code: 'delegation_binding_invalid',
    });
  });
  it.each([
    { ...user, emailVerified: false },
    { ...user, email: null },
  ])('requires verified usable email', async (identity) => {
    reply = { success: true, data: identity };
    await expect(client.identity(token)).rejects.toMatchObject({ code: 'verified_email_required' });
    expect(requests[0]!.headers['x-app-delegation']).toBe(token);
    expect(requests[0]!.headers.authorization).toMatch(/^Basic /);
  });
  it('keeps connection capabilities restricted to the returned intersection', async () => {
    reply = {
      success: true,
      data: [
        {
          connectionId: randomUUID(),
          connected: true,
          identity: { email: user.email },
          grantedCapabilities: ['google.basic_identity'],
          reason: 'connected',
        },
      ],
    };
    const [connection] = await client.connections(token);
    expect(connection!.grantedCapabilities).toEqual(['google.basic_identity']);
    expect(connection).not.toHaveProperty('grantedScopes');
  });
  it('requests explicit Google capabilities and a separate registered return URI', async () => {
    reply = {
      success: true,
      data: {
        authUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=fixture',
        redirectUri: `${config.publicOrigin}/api/google/callback`,
        requestedCapabilities: GOOGLE_CAPABILITIES,
      },
    };
    await expect(client.connectGoogle(token)).resolves.toHaveProperty('authUrl');
    expect(requests[0]!.body).toEqual({
      redirectUri: `${config.publicOrigin}/api/google/callback`,
      capabilities: GOOGLE_CAPABILITIES,
    });
    reply = {
      success: true,
      data: {
        authUrl: 'https://evil.example.test/',
        redirectUri: `${config.publicOrigin}/api/google/callback`,
        requestedCapabilities: GOOGLE_CAPABILITIES,
      },
    };
    await expect(client.connectGoogle(token)).rejects.toMatchObject({
      code: 'google_authorization_invalid',
    });
  });
  it('preserves Google receipts and never retries an unconfirmed send', async () => {
    reply = { id: 'provider-receipt', threadId: 'provider-thread', nextPageToken: 'continuation' };
    const google = client.googleFetch(token, 'selected-connection');
    const response = await google('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      body: '{"raw":"draft"}',
    });
    expect(await response.json()).toEqual(reply);
    expect(requests[0]!.body).toMatchObject({
      method: 'POST',
      connectionId: 'selected-connection',
      body: '{"raw":"draft"}',
    });
    status = 502;
    reply = { error: 'private upstream error', code: 'UNCONFIRMED' };
    const failed = await google('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      body: '{}',
    });
    expect(failed.status).toBe(502);
    expect(requests).toHaveLength(2);
  });
  it('does not retry network failure or accept a false success envelope', async () => {
    let calls = 0;
    const disconnected = new OutreachrDelegation(config, async () => {
      calls += 1;
      throw new Error('connection lost');
    });
    await expect(
      disconnected.googleFetch(token, 'selected')(
        'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
        { method: 'POST', body: '{}' },
      ),
    ).rejects.toMatchObject({ code: 'eliza_request_unconfirmed' });
    expect(calls).toBe(1);
    reply = { ...grant(), success: false };
    await expect(client.exchange('eac_fixture')).rejects.toMatchObject({
      code: 'eliza_request_unconfirmed',
    });
  });
  it('never invents mail permissions from identity or broadens read access into compose', () => {
    expect(effectiveGoogleScopes(['google.gmail.send'])).toEqual([]);
    const read = effectiveGoogleScopes(['google.basic_identity', 'google.gmail.triage']);
    expect(read).toContain('https://www.googleapis.com/auth/gmail.readonly');
    expect(read).not.toContain('https://www.googleapis.com/auth/gmail.modify');
    expect(read).not.toContain('https://www.googleapis.com/auth/gmail.compose');
    expect(read).not.toContain('https://www.googleapis.com/auth/gmail.send');
  });
  it('explains free account setup without falsely expiring the identity session', async () => {
    status = 403;
    reply = { success: false, error: 'internal detail', code: 'APP_GOOGLE_ACCOUNT_REQUIRED' };
    await expect(client.connections(token)).rejects.toMatchObject({
      status: 403,
      code: 'google_account_setup_required',
    });
  });
  it('revokes using generic credentials and rejects insecure origins', async () => {
    await client.revoke(token);
    expect(requests[0]).toMatchObject({
      path: '/api/v1/app-auth/delegations/revoke',
      method: 'POST',
    });
    expect(
      () => new OutreachrDelegation({ ...config, apiOrigin: 'http://api.eliza.test' }),
    ).toThrow();
  });
});
