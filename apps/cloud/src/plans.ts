/** Defines the product contract independently of provider price identifiers. */
export const PLANS = {
  sol: { name: 'Sol', monthlyCents: 4900, model: 'openai/gpt-5.6-sol', aiAllowanceCents: 1500 },
  astra: {
    name: 'Astra',
    monthlyCents: 20000,
    model: 'openai/gpt-6-astra',
    aiAllowanceCents: 7000,
  },
} as const;
export type Plan = keyof typeof PLANS;
export type Role = 'owner' | 'admin' | 'member' | 'viewer';
export const TRIAL_DAYS = 7;
export const TRIAL_AI_CENTS = 200;
export const INVITE_DAYS = 7;
export const SESSION_DAYS = 7;
export const isEditor = (role: Role): boolean => role !== 'viewer';
export const isAdmin = (role: Role): boolean => role === 'owner' || role === 'admin';
