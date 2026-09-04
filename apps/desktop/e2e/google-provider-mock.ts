import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { getResponse, HttpResponse, http, type RequestHandler } from 'msw';

export interface GoogleProviderMockState {
  readonly baseUrl: string;
  readonly requests: string[];
  readonly gmailListQueries: string[];
  readonly gmailMetadataIds: string[];
  readonly calendarPageTokens: Array<string | null>;
  readonly tokenRequestBodies: string[];
  readonly authorizationHeaders: Array<string | null>;
  readonly sentRawMessages: string[];
  readonly calendarCreateBodies: Array<Record<string, unknown>>;
  gmailSendCalls: number;
  calendarCreateCalls: number;
}

export interface GoogleProviderMock {
  readonly state: GoogleProviderMockState;
  close(): Promise<void>;
}

const googleAccount = 'ada@local.test';

function gmailMessage(id: string): Record<string, unknown> {
  const values: Record<string, Record<string, unknown>> = {
    'outbound-page-one': {
      id: 'outbound-page-one',
      threadId: 'history-thread-one',
      internalDate: '1735689600000',
      labelIds: ['SENT'],
      payload: {
        headers: [
          { name: 'From', value: `Ada Founder <${googleAccount}>` },
          { name: 'To', value: 'Historical One <history.one@example.test>' },
          { name: 'Subject', value: 'Historical page one' },
          { name: 'Message-ID', value: '<history-one@example.test>' },
        ],
      },
    },
    'ignored-inbound': {
      id: 'ignored-inbound',
      threadId: 'ignored-inbound-thread',
      internalDate: '1735776000000',
      labelIds: ['INBOX'],
      payload: {
        headers: [
          { name: 'From', value: 'Unrelated Sender <unrelated@example.test>' },
          { name: 'To', value: `Ada Founder <${googleAccount}>` },
          { name: 'Subject', value: 'Unrelated inbound must be discarded' },
          { name: 'Message-ID', value: '<ignored-inbound@example.test>' },
        ],
      },
    },
    'outbound-page-two': {
      id: 'outbound-page-two',
      threadId: 'history-thread-two',
      internalDate: '1735862400000',
      labelIds: ['SENT'],
      payload: {
        headers: [
          { name: 'From', value: `Ada Founder <${googleAccount}>` },
          { name: 'To', value: 'Historical Two <history.two@example.test>' },
          { name: 'Subject', value: 'Historical page two' },
          { name: 'Message-ID', value: '<history-two@example.test>' },
        ],
      },
    },
  };
  return values[id] ?? {};
}

function mockHandlers(baseUrl: string, state: GoogleProviderMockState): RequestHandler[] {
  const firstEventStart = new Date(Date.now() + 2 * 86_400_000);
  firstEventStart.setUTCHours(17, 0, 0, 0);
  const secondEventStart = new Date(Date.now() + 4 * 86_400_000);
  secondEventStart.setUTCHours(18, 0, 0, 0);
  const event = (id: string, title: string, start: Date) => ({
    id,
    status: 'confirmed',
    htmlLink: `https://calendar.google.com/calendar/event?eid=${id}`,
    summary: title,
    description: 'Mocked provider metadata imported through the built Electron process.',
    location: 'Video call',
    start: { dateTime: start.toISOString() },
    end: { dateTime: new Date(start.getTime() + 30 * 60_000).toISOString() },
    organizer: { email: googleAccount, displayName: 'Ada Founder' },
  });

  const requireAccessToken = (request: Request): Response | null => {
    const authorization = request.headers.get('authorization');
    state.authorizationHeaders.push(authorization);
    return authorization === 'Bearer e2e-google-access'
      ? null
      : HttpResponse.json({ error: 'missing test bearer token' }, { status: 401 });
  };

  return [
    http.post(`${baseUrl}/token`, async ({ request }) => {
      const body = await request.text();
      state.tokenRequestBodies.push(body);
      const params = new URLSearchParams(body);
      if (
        params.get('grant_type') !== 'authorization_code' ||
        params.get('code') !== 'outreachr-e2e-google-code' ||
        !/^[A-Za-z0-9_-]{43,128}$/u.test(params.get('code_verifier') ?? '') ||
        params.get('client_secret') !== 'e2e-google-desktop-secret'
      ) {
        return HttpResponse.json({ error: 'invalid test PKCE exchange' }, { status: 400 });
      }
      return HttpResponse.json({
        access_token: 'e2e-google-access',
        refresh_token: 'e2e-google-refresh',
        token_type: 'Bearer',
        expires_in: 3_600,
      });
    }),
    http.get(`${baseUrl}/v1/userinfo`, ({ request }) => {
      const denied = requireAccessToken(request);
      return denied ?? HttpResponse.json({ email: googleAccount });
    }),
    http.get(`${baseUrl}/gmail/v1/users/me/messages`, ({ request }) => {
      const denied = requireAccessToken(request);
      if (denied) return denied;
      const url = new URL(request.url);
      const query = url.searchParams.get('q') ?? '';
      state.gmailListQueries.push(query);
      // Incremental overlap scans happen before a provider send. The exhaustive
      // two-page history is returned only for the initial full reconciliation.
      if (query) return HttpResponse.json({ messages: [] });
      const pageToken = url.searchParams.get('pageToken');
      if (pageToken === 'gmail-page-two') {
        return HttpResponse.json({ messages: [{ id: 'outbound-page-two' }] });
      }
      return HttpResponse.json({
        messages: [{ id: 'outbound-page-one' }, { id: 'ignored-inbound' }],
        nextPageToken: 'gmail-page-two',
      });
    }),
    http.get(`${baseUrl}/gmail/v1/users/me/messages/:messageId`, ({ params, request }) => {
      const denied = requireAccessToken(request);
      if (denied) return denied;
      const messageId = String(params.messageId);
      state.gmailMetadataIds.push(messageId);
      return HttpResponse.json(gmailMessage(messageId));
    }),
    http.post(`${baseUrl}/gmail/v1/users/me/messages/send`, async ({ request }) => {
      const denied = requireAccessToken(request);
      if (denied) return denied;
      const body = (await request.json()) as { raw?: string };
      if (!body.raw || !/^[A-Za-z0-9_-]+$/u.test(body.raw)) {
        return HttpResponse.json({ error: 'invalid RFC 2822 payload' }, { status: 400 });
      }
      state.gmailSendCalls += 1;
      state.sentRawMessages.push(body.raw);
      return HttpResponse.json(
        { id: `e2e-provider-message-${state.gmailSendCalls}`, threadId: 'e2e-provider-thread' },
        { headers: { 'x-request-id': `e2e-send-request-${state.gmailSendCalls}` } },
      );
    }),
    http.get(`${baseUrl}/calendar/v3/calendars/primary/events`, ({ request }) => {
      const denied = requireAccessToken(request);
      if (denied) return denied;
      const pageToken = new URL(request.url).searchParams.get('pageToken');
      state.calendarPageTokens.push(pageToken);
      if (pageToken === 'calendar-page-two') {
        return HttpResponse.json({
          items: [event('e2e-calendar-two', 'Mock investor follow-up', secondEventStart)],
        });
      }
      return HttpResponse.json({
        items: [event('e2e-calendar-one', 'Mock investor introduction', firstEventStart)],
        nextPageToken: 'calendar-page-two',
      });
    }),
    http.post(`${baseUrl}/calendar/v3/calendars/primary/events`, async ({ request }) => {
      const denied = requireAccessToken(request);
      if (denied) return denied;
      const body = (await request.json()) as Record<string, unknown>;
      state.calendarCreateCalls += 1;
      state.calendarCreateBodies.push(body);
      return HttpResponse.json({
        id: `e2e-created-calendar-${state.calendarCreateCalls}`,
        status: 'confirmed',
        htmlLink: 'https://calendar.google.com/calendar/event?eid=e2e-created',
        summary: body.summary,
        description: body.description,
        location: body.location,
        start: body.start,
        end: body.end,
        attendees: body.attendees,
        organizer: { email: googleAccount, displayName: 'Ada Founder' },
      });
    }),
  ];
}

async function requestFromNode(request: IncomingMessage, baseUrl: string): Promise<Request> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 2_000_000) throw new Error('Mock provider request exceeded two megabytes');
    chunks.push(bytes);
  }
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else if (value !== undefined) headers.set(name, value);
  }
  const method = request.method ?? 'GET';
  return new Request(new URL(request.url ?? '/', baseUrl), {
    method,
    headers,
    ...(!['GET', 'HEAD'].includes(method) && size > 0 ? { body: Buffer.concat(chunks) } : {}),
  });
}

export async function startGoogleProviderMock(): Promise<GoogleProviderMock> {
  const sockets = new Set<Socket>();
  let baseUrl = '';
  let handlers: RequestHandler[] = [];
  const state: GoogleProviderMockState = {
    get baseUrl() {
      return baseUrl;
    },
    requests: [],
    gmailListQueries: [],
    gmailMetadataIds: [],
    calendarPageTokens: [],
    tokenRequestBodies: [],
    authorizationHeaders: [],
    sentRawMessages: [],
    calendarCreateBodies: [],
    gmailSendCalls: 0,
    calendarCreateCalls: 0,
  };
  const server = createServer((incoming, outgoing) => {
    void (async () => {
      const request = await requestFromNode(incoming, baseUrl);
      state.requests.push(`${request.method} ${new URL(request.url).pathname}`);
      const response = await getResponse(handlers, request);
      if (!response) {
        outgoing.writeHead(500, { 'content-type': 'application/json' });
        outgoing.end(
          JSON.stringify({ error: `Unhandled MSW request: ${request.method} ${request.url}` }),
        );
        return;
      }
      const headers: Record<string, string> = {};
      response.headers.forEach((value, name) => {
        headers[name] = value;
      });
      outgoing.writeHead(response.status, headers);
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    })().catch((error: unknown) => {
      if (outgoing.headersSent) {
        outgoing.destroy(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      outgoing.writeHead(500, { 'content-type': 'application/json' });
      outgoing.end(
        JSON.stringify({ error: error instanceof Error ? error.message : 'Mock provider failure' }),
      );
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
  handlers = mockHandlers(baseUrl, state);

  return {
    state,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
