import type { EmailAddress, ListMailboxMessagesInput } from './types.js';

const MAX_EMAIL_LENGTH = 320;
const MAX_ADDRESS_LIST_LENGTH = 64 * 1024;
const MAX_PARSED_ADDRESSES = 1_000;

export function validateMailboxListInput(input: ListMailboxMessagesInput): void {
  if (input.since !== undefined && !Number.isFinite(Date.parse(input.since))) {
    throw new TypeError('Mailbox since must be an ISO timestamp');
  }
  if (input.mailbox !== undefined && !['all', 'sent'].includes(input.mailbox)) {
    throw new TypeError('Mailbox selection must be all or sent');
  }
  if (
    input.pageSize !== undefined &&
    (!Number.isInteger(input.pageSize) || input.pageSize < 1 || input.pageSize > 250)
  ) {
    throw new TypeError('Mailbox page size must be between 1 and 250');
  }
}

export function parseMailboxAddresses(value: string | undefined): EmailAddress[] {
  if (!value || value.length > MAX_ADDRESS_LIST_LENGTH) return [];
  const addresses: EmailAddress[] = [];
  for (const token of splitAddressList(value)) {
    const parsed = parseAddressToken(token);
    if (!parsed) continue;
    const { email, name } = parsed;
    if (!isProviderEmail(email)) continue;
    addresses.push({ email, ...(name ? { name } : {}) });
    if (addresses.length >= MAX_PARSED_ADDRESSES) break;
  }
  return addresses;
}

/**
 * Provider payloads are untrusted even after a successful API response. This
 * deliberately returns `undefined` instead of inventing an identity that could
 * become a local relationship.
 */
export function providerEmailAddress(email: unknown, name?: unknown): EmailAddress | undefined {
  if (!isProviderEmail(email)) return undefined;
  const displayName =
    typeof name === 'string' && name.trim() && !/[\r\n]/u.test(name) ? name.trim() : undefined;
  return { email: email.trim(), ...(displayName ? { name: displayName } : {}) };
}

export function isProviderEmail(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const email = value.trim();
  if (!email || email.length > MAX_EMAIL_LENGTH) return false;
  for (const character of email) {
    if (!character.trim()) return false;
  }
  const at = email.indexOf('@');
  if (at <= 0 || at !== email.lastIndexOf('@') || at >= email.length - 1) return false;
  const dot = email.indexOf('.', at + 1);
  return dot > at + 1 && dot < email.length - 1;
}

function splitAddressList(value: string): string[] {
  const tokens: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  let angleDepth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quoted && character === '\\') {
      escaped = true;
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
      continue;
    }
    if (quoted) continue;
    if (character === '<') angleDepth += 1;
    else if (character === '>' && angleDepth > 0) angleDepth -= 1;
    else if (character === ',' && angleDepth === 0) {
      tokens.push(value.slice(start, index));
      start = index + 1;
    }
  }
  tokens.push(value.slice(start));
  return tokens;
}

function parseAddressToken(token: string): { email: string; name?: string } | undefined {
  let candidate = token.trim();
  if (!candidate) return undefined;
  while (candidate.endsWith(';')) candidate = candidate.slice(0, -1).trim();

  const open = candidate.lastIndexOf('<');
  const close = open >= 0 ? candidate.indexOf('>', open + 1) : -1;
  if (open >= 0 && close > open) {
    const email = candidate.slice(open + 1, close).trim();
    let name = candidate.slice(0, open).trim();
    if (name.startsWith('"') && name.endsWith('"') && name.length >= 2) {
      name = name.slice(1, -1).trim();
    }
    return { email, ...(name ? { name } : {}) };
  }

  const group = candidate.lastIndexOf(':');
  if (group >= 0) candidate = candidate.slice(group + 1).trim();
  return candidate ? { email: candidate } : undefined;
}

/** Return a canonical provider timestamp, or `undefined` for missing/invalid data. */
export function safeIsoTimestamp(value: string | number | undefined): string | undefined {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+$/u.test(value)
        ? Number(value)
        : Date.parse(value ?? '');
  if (!Number.isFinite(parsed)) return undefined;
  const date = new Date(parsed);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}
