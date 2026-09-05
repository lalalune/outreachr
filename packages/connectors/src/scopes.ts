import type { ConnectorProvider } from './types.js';

export type ScopeProfile = 'minimum' | 'relationship-sync';

const GOOGLE_MINIMUM = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/calendar.events.owned',
  'https://www.googleapis.com/auth/calendar.events.freebusy',
] as const;

const GOOGLE_RELATIONSHIP = [
  ...GOOGLE_MINIMUM,
  'https://www.googleapis.com/auth/gmail.readonly',
] as const;

const MICROSOFT_MINIMUM = [
  'openid',
  'profile',
  'email',
  'offline_access',
  'User.Read',
  'Mail.Send',
  'Calendars.ReadWrite',
] as const;

const MICROSOFT_RELATIONSHIP = [...MICROSOFT_MINIMUM, 'Mail.ReadBasic'] as const;

export const SCOPE_PROFILES: Readonly<
  Record<ConnectorProvider, Record<ScopeProfile, readonly string[]>>
> = {
  google: {
    minimum: GOOGLE_MINIMUM,
    'relationship-sync': GOOGLE_RELATIONSHIP,
  },
  microsoft: {
    minimum: MICROSOFT_MINIMUM,
    'relationship-sync': MICROSOFT_RELATIONSHIP,
  },
};

/**
 * Extra delegated scopes needed only when a founder chooses provider-hosted
 * drafts. Local SQLite drafts and direct send do not need these broader scopes.
 */
export const PROVIDER_DRAFT_SCOPES: Readonly<Record<ConnectorProvider, readonly string[]>> = {
  google: ['https://www.googleapis.com/auth/gmail.compose'],
  microsoft: ['Mail.ReadWrite'],
};

export function getScopes(
  provider: ConnectorProvider,
  profile: ScopeProfile = 'minimum',
): string[] {
  return [...SCOPE_PROFILES[provider][profile]];
}

/** Full reconciliation uses search; Google's metadata-only scope cannot authorize that query. */
export function hasRelationshipReadScope(
  provider: ConnectorProvider,
  scopes: readonly string[],
): boolean {
  return provider === 'google'
    ? [
        'https://www.googleapis.com/auth/gmail.readonly',
        'https://www.googleapis.com/auth/gmail.modify',
        'https://mail.google.com/',
      ].some((scope) => scopes.includes(scope))
    : ['Mail.ReadBasic', 'Mail.Read', 'Mail.ReadWrite'].some((scope) => scopes.includes(scope));
}
