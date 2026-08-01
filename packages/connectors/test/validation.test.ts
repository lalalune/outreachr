import { HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { validateEventInput, validateFreeBusyInput, validateListInput } from '../src/calendar.js';
import { errorCodeForStatus, isConnectorError } from '../src/errors.js';
import { authorizedRequest } from '../src/http.js';
import { buildGmailRaw, buildMimeMessage } from '../src/mime.js';
import {
  ConnectorError,
  InMemorySendAttemptLedger,
  assertLoopbackRedirectUri,
  assertSendAllowed,
  createLoopbackRedirectUri,
  isProviderEmail,
  parseMailboxAddresses,
  prepareDesktopAuthorization,
  refreshAccessToken,
  validateOAuthCallback,
  validateEmailMessage,
  type SendReceipt,
} from '../src/index.js';
import { FIXED_NOW, approvedSafety, message, noSleep, sendContext } from './helpers.js';

describe('input validation and less common branches', () => {
  it('parses bounded provider address lists without backtracking on hostile input', () => {
    expect(
      parseMailboxAddresses(
        '"Investor, Jane" <jane@example.com>, Group: partner@example.org;, malformed',
      ),
    ).toEqual([
      { email: 'jane@example.com', name: 'Investor, Jane' },
      { email: 'partner@example.org' },
    ]);
    expect(isProviderEmail(' founder@example.com ')).toBe(true);
    expect(isProviderEmail('two@@example.com')).toBe(false);
    expect(isProviderEmail(`a@${'x'.repeat(318)}.com`)).toBe(false);
    expect(parseMailboxAddresses(`${'!,'.repeat(40_000)}person@example.com`)).toEqual([]);
  });

  it('validates calendar date ranges, all-day values, pagination, and free/busy', () => {
    expect(() =>
      validateEventInput({
        title: 'All day',
        start: { date: '2026-08-01' },
        end: { date: '2026-08-02' },
      }),
    ).not.toThrow();
    expect(() =>
      validateEventInput({
        title: ' ',
        start: { date: '2026-08-01' },
        end: { date: '2026-08-02' },
      }),
    ).toThrow('title');
    expect(() =>
      validateEventInput({
        title: 'Invalid',
        start: {},
        end: { date: '2026-08-02' },
      }),
    ).toThrow('exactly one');
    expect(() =>
      validateEventInput({
        title: 'Invalid',
        start: { date: '2026-08-01', dateTime: '2026-08-01T00:00:00Z' },
        end: { date: '2026-08-02' },
      }),
    ).toThrow('exactly one');
    expect(() =>
      validateEventInput({
        title: 'Invalid',
        start: { date: '08/01/2026' },
        end: { date: '2026-08-02' },
      }),
    ).toThrow('YYYY-MM-DD');
    expect(() =>
      validateEventInput({
        title: 'Invalid',
        start: { dateTime: 'not-a-date' },
        end: { dateTime: '2026-08-02T00:00:00Z' },
      }),
    ).toThrow('ISO 8601');
    expect(() =>
      validateEventInput({
        title: 'Backwards',
        start: { dateTime: '2026-08-02T00:00:00Z' },
        end: { dateTime: '2026-08-01T00:00:00Z' },
      }),
    ).toThrow('after start');
    expect(() => validateListInput({ timeMin: 'bad', timeMax: '2026-08-02T00:00:00Z' })).toThrow(
      'ISO 8601',
    );
    expect(() =>
      validateListInput({
        timeMin: '2026-08-02T00:00:00Z',
        timeMax: '2026-08-01T00:00:00Z',
      }),
    ).toThrow('after timeMin');
    expect(() =>
      validateListInput({
        timeMin: '2026-08-01T00:00:00Z',
        timeMax: '2026-08-02T00:00:00Z',
        pageSize: 0,
      }),
    ).toThrow('positive integer');
    expect(() =>
      validateFreeBusyInput({
        calendarIds: [],
        timeMin: '2026-08-01T00:00:00Z',
        timeMax: '2026-08-02T00:00:00Z',
      }),
    ).toThrow('At least one');
    expect(() =>
      validateFreeBusyInput({
        calendarIds: ['primary'],
        timeMin: '2026-08-02T00:00:00Z',
        timeMax: '2026-08-01T00:00:00Z',
      }),
    ).toThrow('after timeMin');
  });

  it('rejects malformed email content, headers, approval, and recipient checks', async () => {
    expect(() => validateEmailMessage({ ...message, to: [] })).toThrow('To recipient');
    expect(() => validateEmailMessage({ ...message, subject: ' ' })).toThrow('subject');
    expect(() =>
      validateEmailMessage({ ...message, subject: 'Safe\r\nBcc: bad@example.com' }),
    ).toThrow('subject cannot contain newlines');
    expect(() => validateEmailMessage({ to: message.to, subject: 'No body' })).toThrow(
      'text or HTML',
    );
    expect(() => validateEmailMessage({ ...message, to: [{ email: 'invalid' }] })).toThrow(
      'Invalid email',
    );
    expect(() =>
      validateEmailMessage({ ...message, to: [{ email: 'ok@example.com', name: 'Bad\nName' }] }),
    ).toThrow('display names');
    expect(() => validateEmailMessage({ ...message, headers: { 'Bad Header': 'value' } })).toThrow(
      'Unsafe email header',
    );
    expect(() => validateEmailMessage({ ...message, headers: { 'X-Good': 'bad\rvalue' } })).toThrow(
      'Unsafe email header',
    );
    expect(() => validateEmailMessage({ ...message, headers: { Subject: 'replacement' } })).toThrow(
      'Unsafe email header',
    );
    expect(() => validateEmailMessage({ ...message, inReplyTo: 'ok\r\nBcc: bad' })).toThrow(
      'In-Reply-To',
    );
    expect(() => validateEmailMessage({ ...message, references: ['ok', 'bad\nvalue'] })).toThrow(
      'References',
    );

    const noOperation = await approvedSafety();
    noOperation.operationKey = ' ';
    await expect(assertSendAllowed(message, noOperation, sendContext)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
    const unsafeOperation = await approvedSafety();
    unsafeOperation.operationKey = 'safe\r\nX-Bad: value';
    await expect(assertSendAllowed(message, unsafeOperation, sendContext)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
    const noApproval = await approvedSafety();
    noApproval.approval.approved = false;
    await expect(assertSendAllowed(message, noApproval, sendContext)).rejects.toMatchObject({
      code: 'APPROVAL_REQUIRED',
    });
    const invalidApprovalDate = await approvedSafety();
    invalidApprovalDate.approval.approvedAt = 'bad';
    await expect(
      assertSendAllowed(message, invalidApprovalDate, sendContext),
    ).rejects.toMatchObject({
      code: 'APPROVAL_REQUIRED',
    });
    const invalidCheckDate = await approvedSafety();
    invalidCheckDate.duplicateCheck.checkedAt = 'bad';
    await expect(assertSendAllowed(message, invalidCheckDate, sendContext)).rejects.toMatchObject({
      code: 'DUPLICATE_CHECK_REQUIRED',
    });
    const repeatedPersonMessage = {
      ...message,
      cc: [{ email: 'alternate@example.com', recipientKey: 'person-pat' }],
    };
    const repeatedPerson = await approvedSafety(repeatedPersonMessage);
    repeatedPerson.duplicateCheck.checkedRecipientKeys = ['person-pat'];
    await expect(
      assertSendAllowed(repeatedPersonMessage, repeatedPerson, sendContext),
    ).rejects.toMatchObject({
      code: 'DUPLICATE_BLOCKED',
    });
  });

  it('builds plain, HTML, Unicode, reply, and custom MIME forms', () => {
    const plain = buildMimeMessage({
      to: [{ email: 'person@example.com' }],
      subject: 'Plain',
      text: 'Text only',
      headers: { 'X-Campaign': 'founder-approved' },
      inReplyTo: '<previous@example.com>',
      references: ['<first@example.com>', '<previous@example.com>'],
      replyTo: { email: 'founder@example.com' },
    });
    expect(plain).toContain('Content-Type: text/plain');
    expect(plain).toContain('X-Campaign: founder-approved');
    expect(plain).toContain('In-Reply-To: <previous@example.com>');
    const html = buildMimeMessage({
      to: [{ email: 'person@example.com', name: 'José Founder' }],
      subject: 'Olá investor',
      html: '<p>HTML only</p>',
    });
    expect(html).toContain('Content-Type: text/html');
    expect(html).toContain('=?UTF-8?B?');
    expect(buildGmailRaw({ ...message, html: undefined }, 'operation')).toMatch(
      /^[A-Za-z0-9_-]+$/u,
    );
  });

  it('maps every stable HTTP status category', () => {
    expect(errorCodeForStatus(400)).toBe('INVALID_REQUEST');
    expect(errorCodeForStatus(401)).toBe('UNAUTHORIZED');
    expect(errorCodeForStatus(403)).toBe('FORBIDDEN');
    expect(errorCodeForStatus(404)).toBe('NOT_FOUND');
    expect(errorCodeForStatus(409)).toBe('CONFLICT');
    expect(errorCodeForStatus(412)).toBe('PRECONDITION_FAILED');
    expect(errorCodeForStatus(429)).toBe('RATE_LIMITED');
    expect(errorCodeForStatus(503)).toBe('SERVER_ERROR');
    expect(errorCodeForStatus(418)).toBe('UNKNOWN');
    expect(
      isConnectorError(new ConnectorError({ operation: 'test', code: 'UNKNOWN', message: 'x' })),
    ).toBe(true);
    expect(isConnectorError(new Error('x'))).toBe(false);
  });

  it('validates all desktop redirect and callback failure modes', async () => {
    expect(() => createLoopbackRedirectUri(0)).toThrow(RangeError);
    expect(() => createLoopbackRedirectUri(70_000)).toThrow(RangeError);
    expect(() => createLoopbackRedirectUri(49_152, 'callback')).toThrow('absolute path');
    expect(() => createLoopbackRedirectUri(49_152, '/callback?bad=1')).toThrow('query');
    expect(() => assertLoopbackRedirectUri('http://127.0.0.1/callback')).toThrow('loopback');
    expect(() => assertLoopbackRedirectUri('https://127.0.0.1:49152/callback')).toThrow('loopback');
    expect(() => assertLoopbackRedirectUri('http://user@127.0.0.1:49152/callback')).toThrow(
      'loopback',
    );
    await expect(
      prepareDesktopAuthorization({
        provider: 'google',
        clientId: ' ',
        redirectUri: 'http://127.0.0.1:49152/callback',
      }),
    ).rejects.toThrow('client id');
    await expect(
      prepareDesktopAuthorization({
        provider: 'google',
        clientId: 'client',
        redirectUri: 'http://127.0.0.1:49152/callback',
        scopes: [],
      }),
    ).rejects.toThrow('scope');
    await expect(
      prepareDesktopAuthorization({
        provider: 'microsoft',
        clientId: 'client',
        redirectUri: 'http://localhost:49152/callback',
        tenant: 'bad/tenant',
      }),
    ).rejects.toThrow('tenant');
    expect(() =>
      validateOAuthCallback(
        'http://127.0.0.1:49152/callback?state=s&error=access_denied&error_description=Nope',
        's',
      ),
    ).toThrow('Nope');
    expect(() => validateOAuthCallback('http://127.0.0.1:49152/callback?state=s', 's')).toThrow(
      'authorization code',
    );
  });

  it('retries safe requests and maps network, text, and OAuth failures', async () => {
    let networkCalls = 0;
    const networkThenSuccess = vi.fn(async () => {
      networkCalls += 1;
      if (networkCalls === 1) throw new TypeError('offline');
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    await expect(
      authorizedRequest({
        provider: 'google',
        operation: 'safe.read',
        fetch: networkThenSuccess,
        getAccessToken: () => 'token',
        url: 'https://provider.example/read',
        retryNetworkErrors: true,
        retryServerErrors: true,
        retryPolicy: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
        sleep: noSleep,
      }),
    ).resolves.toMatchObject({ status: 200 });
    expect(networkCalls).toBe(2);

    await expect(
      authorizedRequest({
        provider: 'google',
        operation: 'plain.error',
        fetch: async () => new Response('Provider exploded', { status: 418 }),
        getAccessToken: () => 'token',
        url: 'https://provider.example/error',
        retryPolicy: { maxAttempts: 1 },
      }),
    ).rejects.toMatchObject({ code: 'UNKNOWN', message: 'Provider exploded' });

    await expect(
      authorizedRequest({
        provider: 'google',
        operation: 'empty-token',
        fetch: async () => new Response(null, { status: 200 }),
        getAccessToken: () => '',
        url: 'https://provider.example/read',
        retryPolicy: { maxAttempts: 1 },
      }),
    ).rejects.toMatchObject({ code: 'NETWORK_ERROR' });

    await expect(
      refreshAccessToken({
        provider: 'microsoft',
        fetch: async () => {
          throw new TypeError('offline');
        },
        clientId: 'client',
        refreshToken: 'refresh',
        tenant: 'common',
        scopes: ['openid'],
      }),
    ).rejects.toMatchObject({ code: 'NETWORK_ERROR', retryable: true });

    await expect(
      refreshAccessToken({
        provider: 'google',
        fetch: async () => HttpResponse.json({ token_type: 'Bearer' }),
        clientId: 'client',
        refreshToken: 'refresh',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('never retries an ambiguous create transport or timeout outcome', async () => {
    const networkCreate = vi.fn(async () => {
      throw new TypeError('connection reset after upload');
    });
    await expect(
      authorizedRequest({
        provider: 'google',
        operation: 'calendar.create',
        fetch: networkCreate,
        getAccessToken: () => 'token',
        url: 'https://provider.example/events',
        isCreate: true,
        retryPolicy: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 },
        sleep: noSleep,
      }),
    ).rejects.toMatchObject({
      code: 'AMBIGUOUS_CREATE',
      retryable: false,
      mayHaveSucceeded: true,
    });
    expect(networkCreate).toHaveBeenCalledTimes(1);

    const timedOutCreate = vi.fn(async () => new Response('provider timeout', { status: 408 }));
    await expect(
      authorizedRequest({
        provider: 'microsoft',
        operation: 'calendar.create',
        fetch: timedOutCreate,
        getAccessToken: () => 'token',
        url: 'https://provider.example/events',
        isCreate: true,
        retryPolicy: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 },
        sleep: noSleep,
      }),
    ).rejects.toMatchObject({
      code: 'AMBIGUOUS_CREATE',
      httpStatus: 408,
      retryable: false,
      mayHaveSucceeded: true,
    });
    expect(timedOutCreate).toHaveBeenCalledTimes(1);
  });

  it('checks ledger update and copy semantics', async () => {
    const ledger = new InMemorySendAttemptLedger();
    const receipt: SendReceipt = {
      provider: 'google',
      operationKey: 'ledger-operation',
      messageFingerprint: 'sha256:fingerprint',
      status: 'pending',
      attemptedAt: FIXED_NOW.toISOString(),
      updatedAt: FIXED_NOW.toISOString(),
      deliveryConfirmed: false,
      replayed: false,
      retrySafe: false,
    };
    await expect(ledger.update(receipt)).rejects.toThrow('No send claim');
    await ledger.claim(receipt);
    await expect(ledger.update({ ...receipt, provider: 'microsoft' })).rejects.toThrow(
      'Cannot change identity',
    );
    const fetched = await ledger.get(receipt.operationKey);
    expect(fetched).toEqual(receipt);
    if (fetched) fetched.status = 'sent';
    await expect(ledger.get(receipt.operationKey)).resolves.toMatchObject({ status: 'pending' });
    await expect(ledger.get('missing')).resolves.toBeUndefined();
  });
});
