import { sha256Base64Url } from './encoding.js';
import { ConnectorError } from './errors.js';
import { isProviderEmail } from './mailbox.js';
import type {
  EmailAddress,
  EmailMessage,
  SendAttemptLedger,
  SendContext,
  SendReceipt,
  SendSafety,
} from './types.js';

const HEADER_NEWLINE = /[\r\n]/u;
const RESERVED_HEADERS = new Set([
  'to',
  'cc',
  'bcc',
  'reply-to',
  'subject',
  'mime-version',
  'content-type',
  'content-transfer-encoding',
  'message-id',
  'date',
  'x-outreachr-operation-key',
]);

export function normalizeEmail(email: string): string {
  return email.trim().toLocaleLowerCase('en-US');
}

export function recipientKey(address: EmailAddress): string {
  return (address.recipientKey?.trim() || normalizeEmail(address.email)).toLocaleLowerCase('en-US');
}

export function allRecipients(message: EmailMessage): EmailAddress[] {
  return [...message.to, ...(message.cc ?? []), ...(message.bcc ?? [])];
}

function normalizeAddress(address: EmailAddress): Record<string, string> {
  return {
    email: normalizeEmail(address.email),
    name: address.name?.trim() ?? '',
    recipientKey: recipientKey(address),
  };
}

function canonicalEmail(message: EmailMessage): string {
  const sortedHeaders = Object.entries(message.headers ?? {})
    .map(([name, value]) => [name.trim().toLocaleLowerCase('en-US'), value.trim()] as const)
    .sort(([left], [right]) => left.localeCompare(right));

  return JSON.stringify({
    to: message.to.map(normalizeAddress),
    cc: (message.cc ?? []).map(normalizeAddress),
    bcc: (message.bcc ?? []).map(normalizeAddress),
    replyTo: message.replyTo ? normalizeAddress(message.replyTo) : null,
    subject: message.subject,
    text: message.text ?? null,
    html: message.html ?? null,
    inReplyTo: message.inReplyTo?.trim() ?? null,
    references: (message.references ?? []).map((value) => value.trim()),
    headers: sortedHeaders,
  });
}

function canonicalSendContext(context: SendContext): Record<string, string | null> {
  return {
    provider: context.provider,
    senderAddress: normalizeEmail(context.senderAddress),
    messageKind: context.messageKind,
    providerThreadId: context.providerThreadId?.trim() || null,
  };
}

function sameSendContext(left: SendContext, right: SendContext): boolean {
  return JSON.stringify(canonicalSendContext(left)) === JSON.stringify(canonicalSendContext(right));
}

export async function fingerprintEmail(
  message: EmailMessage,
  context: SendContext,
): Promise<string> {
  validateEmailMessage(message);
  validateSendContext(context);
  return `sha256:${await sha256Base64Url(
    JSON.stringify({
      version: 2,
      message: canonicalEmail(message),
      context: canonicalSendContext(context),
    }),
  )}`;
}

export function validateSendContext(context: SendContext): void {
  if (!isProviderEmail(context.senderAddress)) {
    throw new TypeError('Invalid authenticated sender address');
  }
  if (context.providerThreadId && /[\r\n]/u.test(context.providerThreadId)) {
    throw new TypeError('Provider thread id cannot contain newlines');
  }
}

export function validateEmailMessage(message: EmailMessage): void {
  if (message.to.length === 0) throw new TypeError('Email requires at least one To recipient');
  if (!message.subject.trim()) throw new TypeError('Email subject is required');
  if (HEADER_NEWLINE.test(message.subject))
    throw new TypeError('Email subject cannot contain newlines');
  if (message.text === undefined && message.html === undefined) {
    throw new TypeError('Email requires a text or HTML body');
  }

  const recipients = [...allRecipients(message), ...(message.replyTo ? [message.replyTo] : [])];
  for (const address of recipients) {
    if (!isProviderEmail(address.email)) {
      throw new TypeError('Invalid email address');
    }
    if (address.name && /[\r\n]/u.test(address.name)) {
      throw new TypeError('Email display names cannot contain newlines');
    }
  }

  for (const [name, value] of Object.entries(message.headers ?? {})) {
    if (
      !/^[A-Za-z0-9-]+$/u.test(name) ||
      HEADER_NEWLINE.test(value) ||
      RESERVED_HEADERS.has(name.toLocaleLowerCase('en-US'))
    ) {
      throw new TypeError(`Unsafe email header: ${name}`);
    }
  }
  if (message.inReplyTo && HEADER_NEWLINE.test(message.inReplyTo)) {
    throw new TypeError('In-Reply-To cannot contain newlines');
  }
  if (message.references?.some((value) => HEADER_NEWLINE.test(value))) {
    throw new TypeError('References cannot contain newlines');
  }
}

export async function assertSendAllowed(
  message: EmailMessage,
  safety: SendSafety,
  context: SendContext,
): Promise<string> {
  validateEmailMessage(message);
  validateSendContext(context);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(safety.operationKey)) {
    throw new ConnectorError({
      operation: 'email.send.guard',
      code: 'IDEMPOTENCY_CONFLICT',
      message: 'A durable operation key is required before sending',
    });
  }
  if (!safety.approval.approved || !safety.approval.approvalId.trim()) {
    throw new ConnectorError({
      operation: 'email.send.guard',
      code: 'APPROVAL_REQUIRED',
      message: 'Founder approval is required before sending',
    });
  }
  if (Number.isNaN(Date.parse(safety.approval.approvedAt))) {
    throw new ConnectorError({
      operation: 'email.send.guard',
      code: 'APPROVAL_REQUIRED',
      message: 'Approval timestamp is missing or invalid',
    });
  }

  if (!sameSendContext(safety.approval.context, context)) {
    throw new ConnectorError({
      provider: context.provider,
      operation: 'email.send.guard',
      code: 'APPROVAL_STALE',
      message: 'Provider, authenticated sender, message kind, or thread changed after approval',
    });
  }

  const fingerprint = await fingerprintEmail(message, context);
  if (fingerprint !== safety.approval.messageFingerprint) {
    throw new ConnectorError({
      operation: 'email.send.guard',
      code: 'APPROVAL_STALE',
      message: 'Email content changed after approval',
    });
  }

  if (Number.isNaN(Date.parse(safety.duplicateCheck.checkedAt))) {
    throw new ConnectorError({
      operation: 'email.send.guard',
      code: 'DUPLICATE_CHECK_REQUIRED',
      message: 'A current duplicate-recipient check is required before sending',
    });
  }

  const keys = allRecipients(message).map(recipientKey);
  if (new Set(keys).size !== keys.length) {
    throw new ConnectorError({
      operation: 'email.send.guard',
      code: 'DUPLICATE_BLOCKED',
      message: 'The same person appears more than once on this email',
    });
  }
  const checked = new Set(
    safety.duplicateCheck.checkedRecipientKeys.map((key) => key.trim().toLocaleLowerCase('en-US')),
  );
  const missing = keys.filter((key) => !checked.has(key));
  if (missing.length > 0) {
    throw new ConnectorError({
      operation: 'email.send.guard',
      code: 'DUPLICATE_CHECK_REQUIRED',
      message: `Duplicate check did not cover: ${missing.join(', ')}`,
      details: { missingRecipientKeys: missing },
    });
  }
  const contacted = new Set(
    safety.duplicateCheck.previouslyContactedRecipientKeys.map((key) =>
      key.trim().toLocaleLowerCase('en-US'),
    ),
  );
  const duplicates = keys.filter((key) => contacted.has(key));
  if (duplicates.length > 0) {
    throw new ConnectorError({
      operation: 'email.send.guard',
      code: 'DUPLICATE_BLOCKED',
      message: 'At least one recipient has already been contacted',
      details: { duplicateRecipientKeys: duplicates },
    });
  }
  return fingerprint;
}

export class InMemorySendAttemptLedger implements SendAttemptLedger {
  readonly #receipts = new Map<string, SendReceipt>();

  async claim(receipt: SendReceipt): Promise<{ claimed: boolean; receipt: SendReceipt }> {
    const existing = this.#receipts.get(receipt.operationKey);
    if (existing) {
      if (
        existing.provider !== receipt.provider ||
        existing.messageFingerprint !== receipt.messageFingerprint
      ) {
        throw new ConnectorError({
          provider: receipt.provider,
          operation: 'email.send.claim',
          code: 'IDEMPOTENCY_CONFLICT',
          message: 'Operation key was already used for a different provider or message',
          details: { existing },
        });
      }
      return { claimed: false, receipt: { ...existing, replayed: true } };
    }
    this.#receipts.set(receipt.operationKey, { ...receipt });
    return { claimed: true, receipt: { ...receipt } };
  }

  async update(receipt: SendReceipt): Promise<void> {
    const existing = this.#receipts.get(receipt.operationKey);
    if (!existing) throw new Error(`No send claim for ${receipt.operationKey}`);
    if (
      existing.provider !== receipt.provider ||
      existing.messageFingerprint !== receipt.messageFingerprint
    ) {
      throw new Error(`Cannot change identity of send claim ${receipt.operationKey}`);
    }
    this.#receipts.set(receipt.operationKey, { ...receipt, replayed: false });
  }

  async get(operationKey: string): Promise<SendReceipt | undefined> {
    const receipt = this.#receipts.get(operationKey);
    return receipt ? { ...receipt } : undefined;
  }
}
