import {
  validateCalendarDateTime,
  validateEventInput,
  validateFreeBusyInput,
  validateListInput,
} from './calendar.js';
import { ConnectorError } from './errors.js';
import { authorizedRequest, parseJson, responseRequestId } from './http.js';
import { buildGmailRaw } from './mime.js';
import {
  parseMailboxAddresses,
  providerEmailAddress,
  safeIsoTimestamp,
  validateMailboxListInput,
} from './mailbox.js';
import { executeGuardedSend } from './send.js';
import type {
  CalendarAttendee,
  CalendarConnector,
  CalendarDateTime,
  CalendarEvent,
  CalendarEventInput,
  CalendarEventPage,
  ConnectorClientOptions,
  CreateDraftInput,
  EmailConnector,
  EmailDraft,
  FreeBusyInput,
  FreeBusyResult,
  ListCalendarEventsInput,
  ListMailboxMessagesInput,
  MailboxMessage,
  MailboxMessagePage,
  RelationshipMailConnector,
  RetryPolicy,
  SendDraftInput,
  SendEmailInput,
  SendReceipt,
  Sleep,
} from './types.js';

export interface GoogleConnectorOptions extends ConnectorClientOptions {
  gmailBaseUrl?: string;
  calendarBaseUrl?: string;
  userId?: string;
}

interface GmailMessageJson {
  id?: string;
  threadId?: string;
  internalDate?: string;
  labelIds?: string[];
  payload?: { headers?: Array<{ name?: string; value?: string }> };
}

interface GmailDraftJson {
  id?: string;
  message?: GmailMessageJson;
}

interface GoogleEventDateTime {
  dateTime?: string;
  date?: string;
  timeZone?: string;
}

interface GoogleEventJson {
  id?: string;
  status?: string;
  htmlLink?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: GoogleEventDateTime;
  end?: GoogleEventDateTime;
  attendees?: Array<{
    email?: string;
    displayName?: string;
    responseStatus?: string;
    optional?: boolean;
  }>;
  organizer?: { email?: string; displayName?: string };
}

const defaultNow = (): Date => new Date();

function trimTrailingSlash(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') end -= 1;
  return value.slice(0, end);
}

function googleDateTime(value: CalendarDateTime): GoogleEventDateTime {
  return { dateTime: value.dateTime, date: value.date, timeZone: value.timeZone };
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function mapGoogleDateTime(value: GoogleEventDateTime | undefined): CalendarDateTime | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const mapped: CalendarDateTime = {
    dateTime: typeof value.dateTime === 'string' ? value.dateTime : undefined,
    date: typeof value.date === 'string' ? value.date : undefined,
    timeZone: typeof value.timeZone === 'string' ? value.timeZone : undefined,
  };
  try {
    validateCalendarDateTime(mapped, 'provider event boundary');
    return mapped;
  } catch {
    return undefined;
  }
}

function calendarBoundaryTimestamp(value: CalendarDateTime): number {
  return Date.parse(value.dateTime ?? `${value.date}T00:00:00Z`);
}

function mapAttendee(
  value: NonNullable<GoogleEventJson['attendees']>[number] | null | undefined,
): CalendarAttendee | undefined {
  const address = providerEmailAddress(value?.email, value?.displayName);
  if (!address) return undefined;
  const allowed = new Set(['accepted', 'declined', 'tentative']);
  const responseStatus =
    typeof value?.responseStatus === 'string' ? value.responseStatus : undefined;
  return {
    ...address,
    optional: typeof value?.optional === 'boolean' ? value.optional : undefined,
    responseStatus: allowed.has(responseStatus ?? '')
      ? (responseStatus as CalendarAttendee['responseStatus'])
      : 'none',
  };
}

function mapGoogleEvent(event: GoogleEventJson, calendarId: string): CalendarEvent | undefined {
  const id = typeof event?.id === 'string' ? event.id.trim() : '';
  const start = mapGoogleDateTime(event?.start);
  const end = mapGoogleDateTime(event?.end);
  if (!id || !start || !end || calendarBoundaryTimestamp(end) <= calendarBoundaryTimestamp(start)) {
    return undefined;
  }
  const organizer = providerEmailAddress(event.organizer?.email, event.organizer?.displayName);
  return {
    provider: 'google',
    id,
    calendarId,
    title: typeof event.summary === 'string' ? event.summary : '(untitled)',
    start,
    end,
    description: typeof event.description === 'string' ? event.description : undefined,
    descriptionType: 'text',
    location: typeof event.location === 'string' ? event.location : undefined,
    attendees: Array.isArray(event.attendees)
      ? event.attendees.map(mapAttendee).filter(isDefined)
      : undefined,
    status: typeof event.status === 'string' ? event.status : undefined,
    webUrl: typeof event.htmlLink === 'string' ? event.htmlLink : undefined,
    organizer,
  };
}

function ambiguousGoogleCreateResponse(
  operation: string,
  response: Response,
  message: string,
  details?: unknown,
  cause?: unknown,
): ConnectorError {
  return new ConnectorError({
    provider: 'google',
    operation,
    code: 'AMBIGUOUS_CREATE',
    message,
    httpStatus: response.status,
    providerRequestId: responseRequestId(response),
    mayHaveSucceeded: true,
    retryable: false,
    details,
    cause,
  });
}

function gmailHeader(message: GmailMessageJson, name: string): string | undefined {
  if (!Array.isArray(message?.payload?.headers)) return undefined;
  const header = message.payload.headers.find(
    (candidate) =>
      typeof candidate?.name === 'string' &&
      candidate.name.toLocaleLowerCase('en-US') === name.toLocaleLowerCase('en-US'),
  );
  return typeof header?.value === 'string' ? header.value : undefined;
}

function mapGmailMessage(
  message: GmailMessageJson,
  fallbackId?: string,
): MailboxMessage | undefined {
  const labels = Array.isArray(message?.labelIds)
    ? message.labelIds.filter((label): label is string => typeof label === 'string')
    : [];
  const id =
    (typeof message.id === 'string' && message.id.trim()) ||
    (typeof fallbackId === 'string' && fallbackId.trim()) ||
    '';
  const from = parseMailboxAddresses(gmailHeader(message, 'From'))[0];
  const occurredAt =
    safeIsoTimestamp(message.internalDate) ?? safeIsoTimestamp(gmailHeader(message, 'Date'));
  if (!id || !from || !occurredAt) return undefined;
  return {
    provider: 'google',
    id,
    threadId: typeof message.threadId === 'string' ? message.threadId : undefined,
    internetMessageId: gmailHeader(message, 'Message-ID'),
    operationKey: gmailHeader(message, 'X-Outreachr-Operation-Key'),
    subject: gmailHeader(message, 'Subject') ?? '',
    from,
    to: parseMailboxAddresses(gmailHeader(message, 'To')),
    cc: parseMailboxAddresses(gmailHeader(message, 'Cc')),
    occurredAt,
    labels,
    direction: labels.includes('SENT') ? 'outbound' : 'inbound',
  };
}

export class GoogleConnector
  implements EmailConnector, CalendarConnector, RelationshipMailConnector
{
  readonly provider = 'google' as const;
  readonly #fetch: ConnectorClientOptions['fetch'];
  readonly #getAccessToken: ConnectorClientOptions['getAccessToken'];
  readonly #sendLedger: ConnectorClientOptions['sendLedger'];
  readonly #retryPolicy?: Partial<RetryPolicy>;
  readonly #sleep?: Sleep;
  readonly #now: () => Date;
  readonly #gmailBaseUrl: string;
  readonly #calendarBaseUrl: string;
  readonly #userId: string;

  constructor(options: GoogleConnectorOptions) {
    this.#fetch = options.fetch;
    this.#getAccessToken = options.getAccessToken;
    this.#sendLedger = options.sendLedger;
    this.#retryPolicy = options.retryPolicy;
    this.#sleep = options.sleep;
    this.#now = options.now ?? defaultNow;
    this.#gmailBaseUrl = trimTrailingSlash(
      options.gmailBaseUrl ?? 'https://gmail.googleapis.com/gmail/v1',
    );
    this.#calendarBaseUrl = trimTrailingSlash(
      options.calendarBaseUrl ?? 'https://www.googleapis.com/calendar/v3',
    );
    this.#userId = options.userId ?? 'me';
  }

  async #request(
    operation: string,
    url: string,
    init?: RequestInit,
    isSend = false,
    safeToRetry = false,
    isCreate = false,
  ): Promise<Response> {
    return authorizedRequest({
      provider: this.provider,
      operation,
      fetch: this.#fetch,
      getAccessToken: this.#getAccessToken,
      url,
      init,
      retryPolicy: this.#retryPolicy,
      sleep: this.#sleep,
      retryNetworkErrors: safeToRetry,
      retryServerErrors: safeToRetry,
      isSend,
      isCreate,
    });
  }

  #jsonInit(method: string, body: unknown): RequestInit {
    return {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    };
  }

  async createDraft(input: CreateDraftInput): Promise<EmailDraft> {
    const response = await this.#request(
      'gmail.drafts.create',
      `${this.#gmailBaseUrl}/users/${encodeURIComponent(this.#userId)}/drafts`,
      this.#jsonInit('POST', { message: { raw: buildGmailRaw(input.message) } }),
      false,
      false,
      true,
    );
    let draft: GmailDraftJson;
    try {
      draft = await parseJson<GmailDraftJson>(response);
    } catch (cause) {
      throw ambiguousGoogleCreateResponse(
        'gmail.drafts.create',
        response,
        'Gmail may have created the draft but returned malformed JSON',
        undefined,
        cause,
      );
    }
    if (typeof draft?.id !== 'string' || !draft.id.trim()) {
      throw ambiguousGoogleCreateResponse(
        'gmail.drafts.create',
        response,
        'Gmail may have created the draft but did not return a usable id',
        draft,
      );
    }
    return {
      provider: this.provider,
      id: draft.id,
      messageId: draft.message?.id,
      threadId: draft.message?.threadId,
    };
  }

  async sendEmail(input: SendEmailInput): Promise<SendReceipt> {
    return executeGuardedSend({
      provider: this.provider,
      message: input.message,
      context: input.context,
      safety: input.safety,
      ledger: this.#sendLedger,
      now: this.#now,
      perform: async () => {
        const response = await this.#request(
          'gmail.messages.send',
          `${this.#gmailBaseUrl}/users/${encodeURIComponent(this.#userId)}/messages/send`,
          this.#jsonInit('POST', {
            raw: buildGmailRaw(input.message, input.safety.operationKey),
          }),
          true,
        );
        const sent = await parseJson<GmailMessageJson>(response);
        if (!sent.id) {
          throw new ConnectorError({
            provider: this.provider,
            operation: 'gmail.messages.send',
            code: 'AMBIGUOUS_SEND',
            message: 'Gmail accepted the request but did not return a message id',
            httpStatus: response.status,
            providerRequestId: responseRequestId(response),
            mayHaveSucceeded: true,
          });
        }
        return {
          status: 'sent',
          providerMessageId: sent.id,
          providerThreadId: sent.threadId,
          providerRequestId: responseRequestId(response),
          httpStatus: response.status,
          deliveryConfirmed: Boolean(sent.id),
        };
      },
    });
  }

  async sendDraft(input: SendDraftInput): Promise<SendReceipt> {
    if (!input.draftId.trim()) throw new TypeError('Gmail draft id is required');
    return executeGuardedSend({
      provider: this.provider,
      message: input.message,
      context: input.context,
      safety: input.safety,
      ledger: this.#sendLedger,
      now: this.#now,
      perform: async () => {
        const response = await this.#request(
          'gmail.drafts.send',
          `${this.#gmailBaseUrl}/users/${encodeURIComponent(this.#userId)}/drafts/send`,
          this.#jsonInit('POST', { id: input.draftId }),
          true,
        );
        const sent = await parseJson<GmailMessageJson>(response);
        if (!sent.id) {
          throw new ConnectorError({
            provider: this.provider,
            operation: 'gmail.drafts.send',
            code: 'AMBIGUOUS_SEND',
            message: 'Gmail accepted the draft send but did not return a message id',
            httpStatus: response.status,
            providerRequestId: responseRequestId(response),
            mayHaveSucceeded: true,
          });
        }
        return {
          status: 'sent',
          providerMessageId: sent.id,
          providerThreadId: sent.threadId,
          providerRequestId: responseRequestId(response),
          httpStatus: response.status,
          deliveryConfirmed: Boolean(sent.id),
        };
      },
    });
  }

  async listMailboxMessages(input: ListMailboxMessagesInput): Promise<MailboxMessagePage> {
    validateMailboxListInput(input);
    const url = new URL(`${this.#gmailBaseUrl}/users/${encodeURIComponent(this.#userId)}/messages`);
    const query = [
      input.since ? `after:${Math.floor(Date.parse(input.since) / 1_000)}` : null,
      input.mailbox === 'sent' ? 'in:sent' : null,
    ]
      .filter((part): part is string => Boolean(part))
      .join(' ');
    if (query) url.searchParams.set('q', query);
    url.searchParams.set('maxResults', String(input.pageSize ?? 100));
    if (input.pageToken) url.searchParams.set('pageToken', input.pageToken);
    const response = await this.#request(
      'gmail.messages.list',
      url.toString(),
      undefined,
      false,
      true,
    );
    const page = await parseJson<{
      messages?: Array<{ id?: string; threadId?: string }>;
      nextPageToken?: string;
    }>(response);
    const stubs = (page.messages ?? []).filter(
      (message): message is { id: string; threadId?: string } =>
        typeof message.id === 'string' && Boolean(message.id.trim()),
    );
    const messages: MailboxMessage[] = [];
    for (let offset = 0; offset < stubs.length; offset += 10) {
      const batch = stubs.slice(offset, offset + 10);
      const details = await Promise.all(
        batch.map(async (stub) => {
          const detailUrl = new URL(
            `${this.#gmailBaseUrl}/users/${encodeURIComponent(this.#userId)}/messages/${encodeURIComponent(stub.id)}`,
          );
          detailUrl.searchParams.set('format', 'metadata');
          for (const header of [
            'From',
            'To',
            'Cc',
            'Subject',
            'Date',
            'Message-ID',
            'X-Outreachr-Operation-Key',
          ]) {
            detailUrl.searchParams.append('metadataHeaders', header);
          }
          const detail = await this.#request(
            'gmail.messages.getMetadata',
            detailUrl.toString(),
            undefined,
            false,
            true,
          );
          return mapGmailMessage(await parseJson<GmailMessageJson>(detail), stub.id);
        }),
      );
      messages.push(...details.filter(isDefined));
    }
    return { messages, nextPageToken: page.nextPageToken };
  }

  async createEvent(input: CalendarEventInput): Promise<CalendarEvent> {
    validateEventInput(input);
    const calendarId = input.calendarId ?? 'primary';
    const response = await this.#request(
      'google.calendar.events.create',
      `${this.#calendarBaseUrl}/calendars/${encodeURIComponent(calendarId)}/events`,
      this.#jsonInit('POST', {
        summary: input.title,
        description: input.description,
        location: input.location,
        start: googleDateTime(input.start),
        end: googleDateTime(input.end),
        attendees: input.attendees?.map((attendee) => ({
          email: attendee.email,
          displayName: attendee.name,
          optional: attendee.optional,
        })),
        extendedProperties: input.operationKey
          ? { private: { outreachrOperationKey: input.operationKey } }
          : undefined,
      }),
      false,
      false,
      true,
    );
    let json: GoogleEventJson | undefined;
    let event: CalendarEvent | undefined;
    try {
      json = await parseJson<GoogleEventJson>(response);
      event = mapGoogleEvent(json, calendarId);
    } catch (cause) {
      throw ambiguousGoogleCreateResponse(
        'google.calendar.events.create',
        response,
        'Google Calendar may have created the event but returned a malformed response',
        json,
        cause,
      );
    }
    if (!event) {
      throw ambiguousGoogleCreateResponse(
        'google.calendar.events.create',
        response,
        'Google Calendar may have created the event but omitted a usable id or event boundary',
        json,
      );
    }
    return event;
  }

  async listEvents(input: ListCalendarEventsInput): Promise<CalendarEventPage> {
    validateListInput(input);
    const calendarId = input.calendarId ?? 'primary';
    const url = new URL(
      `${this.#calendarBaseUrl}/calendars/${encodeURIComponent(calendarId)}/events`,
    );
    url.searchParams.set('timeMin', input.timeMin);
    url.searchParams.set('timeMax', input.timeMax);
    url.searchParams.set('singleEvents', 'true');
    url.searchParams.set('orderBy', 'startTime');
    if (input.timeZone) url.searchParams.set('timeZone', input.timeZone);
    if (input.pageSize) url.searchParams.set('maxResults', String(input.pageSize));
    if (input.pageToken) url.searchParams.set('pageToken', input.pageToken);
    const response = await this.#request(
      'google.calendar.events.list',
      url.toString(),
      undefined,
      false,
      true,
    );
    const json = await parseJson<{ items?: GoogleEventJson[]; nextPageToken?: string }>(response);
    return {
      events: (json.items ?? [])
        .map((event) => mapGoogleEvent(event, calendarId))
        .filter(isDefined),
      nextPageToken: json.nextPageToken,
    };
  }

  async queryFreeBusy(input: FreeBusyInput): Promise<FreeBusyResult> {
    validateFreeBusyInput(input);
    const response = await this.#request(
      'google.calendar.freebusy.query',
      `${this.#calendarBaseUrl}/freeBusy`,
      this.#jsonInit('POST', {
        timeMin: input.timeMin,
        timeMax: input.timeMax,
        timeZone: input.timeZone,
        items: input.calendarIds.map((id) => ({ id })),
      }),
      false,
      true,
    );
    const json = await parseJson<{
      timeMin?: string;
      timeMax?: string;
      calendars?: Record<
        string,
        {
          busy?: Array<{ start: string; end: string }>;
          errors?: Array<{ reason?: string; message?: string }>;
        }
      >;
    }>(response);
    return {
      timeMin: json.timeMin ?? input.timeMin,
      timeMax: json.timeMax ?? input.timeMax,
      calendars: input.calendarIds.map((calendarId) => {
        const result = json.calendars?.[calendarId];
        return {
          calendarId,
          busy: result?.busy ?? [],
          errors: result?.errors?.map((error) => ({
            code: error.reason,
            message: error.message ?? error.reason ?? 'Unknown free/busy error',
          })),
        };
      }),
    };
  }
}
