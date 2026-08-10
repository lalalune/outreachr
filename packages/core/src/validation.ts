import { z } from 'zod';

export const IdSchema = z.string().trim().min(1).max(200);
export const IsoDateTimeSchema = z.string().datetime({ offset: true });
export const UrlSchema = z.string().url().max(4096);
export const EmailSchema = z.string().trim().email().max(320);
export const JsonValueSchema: z.ZodType<unknown> = z.unknown();

export const FounderProfileSchema = z.object({
  id: IdSchema.default('founder'),
  fullName: z.string().trim().min(1).max(300),
  preferredName: z.string().trim().max(200).nullable().default(null),
  workEmail: EmailSchema.nullable().default(null),
  companyName: z.string().trim().min(1).max(300),
  companyUrl: UrlSchema.nullable().default(null),
  location: z.string().trim().max(300).nullable().default(null),
  bio: z.string().max(20_000).nullable().default(null),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type FounderProfileInput = z.input<typeof FounderProfileSchema>;
export type FounderProfile = z.output<typeof FounderProfileSchema>;

export const RoundStageSchema = z.enum(['pre_seed', 'seed', 'series_a']);
export const RoundStatusSchema = z.enum(['planning', 'active', 'paused', 'closed']);
export const RoundSchema = z
  .object({
    id: IdSchema,
    founderProfileId: IdSchema.default('founder'),
    name: z.string().trim().min(1).max(300),
    stage: RoundStageSchema,
    targetAmountUsd: z.number().int().nonnegative().nullable().default(null),
    minimumCheckUsd: z.number().int().nonnegative().nullable().default(null),
    maximumCheckUsd: z.number().int().nonnegative().nullable().default(null),
    status: RoundStatusSchema.default('planning'),
    thesis: z.string().max(50_000).nullable().default(null),
    openedOn: z.string().date().nullable().default(null),
    closedOn: z.string().date().nullable().default(null),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .superRefine((round, context) => {
    if (
      round.minimumCheckUsd !== null &&
      round.maximumCheckUsd !== null &&
      round.minimumCheckUsd > round.maximumCheckUsd
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'minimumCheckUsd cannot exceed maximumCheckUsd',
      });
    }
  });
export type RoundInput = z.input<typeof RoundSchema>;

export const FirmSchema = z.object({
  id: IdSchema,
  name: z.string().trim().min(1).max(500),
  website: UrlSchema.nullable().default(null),
  investorType: z.string().trim().min(1).max(100),
  headquarters: z.string().max(1000).nullable().default(null),
  description: z.string().max(100_000).nullable().default(null),
  isPublic: z.boolean().default(false),
  contributionEligible: z.boolean().default(false),
  origin: z.enum(['local', 'seed', 'import', 'contribution']).default('local'),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type FirmInput = z.input<typeof FirmSchema>;

export const PersonSchema = z.object({
  id: IdSchema,
  firmId: IdSchema.nullable().default(null),
  fullName: z.string().trim().min(1).max(500),
  title: z.string().max(500).nullable().default(null),
  city: z.string().max(500).nullable().default(null),
  bio: z.string().max(100_000).nullable().default(null),
  isInvestor: z.boolean().default(true),
  isPublic: z.boolean().default(false),
  contributionEligible: z.boolean().default(false),
  origin: z.enum(['local', 'seed', 'import', 'contribution']).default('local'),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type PersonInput = z.input<typeof PersonSchema>;

export const FundSchema = z.object({
  id: IdSchema,
  firmId: IdSchema,
  name: z.string().trim().min(1).max(500),
  vintageYear: z.number().int().min(1900).max(2200).nullable().default(null),
  sizeUsd: z.number().int().nonnegative().nullable().default(null),
  announcedOn: z.string().date().nullable().default(null),
  isPublic: z.boolean().default(false),
  contributionEligible: z.boolean().default(false),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type FundInput = z.input<typeof FundSchema>;

export const SourceSchema = z.object({
  id: IdSchema,
  canonicalUrl: UrlSchema,
  title: z.string().max(2000).nullable().default(null),
  publisher: z.string().max(1000).nullable().default(null),
  sourceType: z.string().trim().min(1).max(100),
  retrievedAt: IsoDateTimeSchema,
  publishedOn: z.string().date().nullable().default(null),
  rightsClass: z.string().trim().min(1).max(100),
  redistributionStatus: z.enum(['allowed', 'attribution_required', 'unknown', 'prohibited']),
  attribution: z.string().max(10_000).nullable().default(null),
  excerpt: z.string().max(25_000).nullable().default(null),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type SourceInput = z.input<typeof SourceSchema>;

export const EntityTypeSchema = z.enum(['firm', 'person', 'fund']);
export const ClaimSchema = z.object({
  id: IdSchema,
  entityType: EntityTypeSchema,
  entityId: IdSchema,
  field: z.string().trim().min(1).max(200),
  valueJson: JsonValueSchema,
  sourceId: IdSchema.nullable().default(null),
  confidence: z.number().min(0).max(1).nullable().default(null),
  observedAt: IsoDateTimeSchema.nullable().default(null),
  status: z.enum(['asserted', 'verified', 'disputed', 'stale']).default('asserted'),
  isPublic: z.boolean().default(false),
  contributionEligible: z.boolean().default(false),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type ClaimInput = z.input<typeof ClaimSchema>;

export const ContactMethodSchema = z
  .object({
    id: IdSchema,
    personId: IdSchema,
    kind: z.enum(['work_email', 'personal_email', 'phone', 'linkedin', 'x', 'website', 'other']),
    value: z.string().trim().min(1).max(4096),
    label: z.string().max(200).nullable().default(null),
    sourceId: IdSchema.nullable().default(null),
    visibility: z.enum(['private', 'public']).default('private'),
    contributionEligible: z.boolean().default(false),
    isPrimary: z.boolean().default(false),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .superRefine((contact, context) => {
    if (
      (contact.kind === 'work_email' || contact.kind === 'personal_email') &&
      !EmailSchema.safeParse(contact.value).success
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['value'],
        message: 'Email contact must contain a valid address',
      });
    }
    if (
      contact.contributionEligible &&
      (contact.kind !== 'work_email' || contact.visibility !== 'public' || !contact.sourceId)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Only sourced, public work emails may be contribution eligible',
      });
    }
  });
export type ContactMethodInput = z.input<typeof ContactMethodSchema>;

export const PipelineStageSchema = z.enum([
  'research',
  'qualified',
  'intro_requested',
  'ready_to_contact',
  'contacted',
  'meeting',
  'diligence',
  'partner_meeting',
  'term_sheet',
  'passed',
  'committed',
]);
export const TargetSchema = z
  .object({
    id: IdSchema,
    roundId: IdSchema,
    firmId: IdSchema.nullable().default(null),
    personId: IdSchema.nullable().default(null),
    stage: PipelineStageSchema.default('research'),
    disposition: z.enum(['not_now']).nullable().default(null),
    priority: z.number().int().min(0).max(100).default(50),
    fitScore: z.number().min(0).max(100).nullable().default(null),
    expectedCheckUsd: z.number().int().nonnegative().nullable().default(null),
    ownerNote: z.string().max(50_000).nullable().default(null),
    nextActionAt: IsoDateTimeSchema.nullable().default(null),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .superRefine((target, context) => {
    if (!target.firmId && !target.personId)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'A target requires a firm or person',
      });
  });
export type TargetInput = z.input<typeof TargetSchema>;

export const MessageDraftSchema = z.object({
  id: IdSchema,
  roundId: IdSchema.nullable().default(null),
  targetId: IdSchema.nullable().default(null),
  recipientPersonId: IdSchema.nullable().default(null),
  recipientAddress: EmailSchema,
  provider: z.enum(['google', 'microsoft']),
  senderAddress: EmailSchema,
  messageKind: z.enum(['initial', 'follow_up', 'intro_request', 'reply']).default('initial'),
  providerThreadId: z.string().trim().min(1).max(2000).nullable().default(null),
  subject: z.string().trim().min(1).max(998),
  bodyText: z.string().min(1).max(500_000),
  attachments: z
    .array(
      z.object({
        name: z.string().min(1).max(1000),
        contentSha256: z.string().regex(/^[a-f0-9]{64}$/),
        size: z.number().int().nonnegative(),
      }),
    )
    .default([]),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type MessageDraftInput = z.input<typeof MessageDraftSchema>;

export const SuppressionSchema = z.object({
  id: IdSchema,
  scope: z.enum(['global', 'email', 'domain', 'person', 'firm']),
  value: z.string().trim().min(1).max(1000),
  reason: z.string().trim().min(1).max(10_000),
  source: z.enum(['founder', 'unsubscribe', 'bounce', 'complaint', 'policy', 'import']),
  active: z.boolean().default(true),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type SuppressionInput = z.input<typeof SuppressionSchema>;

export const ConnectorConfigSchema = z.object({
  id: IdSchema,
  provider: z.enum(['google', 'microsoft', 'codex', 'claude', 'custom']),
  accountLabel: z.string().max(500),
  publicConfig: z.record(z.string(), z.unknown()).default({}),
  secretRef: z
    .string()
    .trim()
    .min(1)
    .max(1000)
    .regex(
      /^(keychain|credential-manager|secret-service|secure-store|external-agent|memory):\/\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+$/,
      'secretRef must point to an approved secure store or external agent',
    ),
  scopes: z.array(z.string().min(1)).default([]),
  status: z
    .enum(['unconfigured', 'connected', 'expired', 'error', 'disabled'])
    .default('unconfigured'),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type ConnectorConfigInput = z.input<typeof ConnectorConfigSchema>;

export const MeetingSchema = z
  .object({
    id: IdSchema,
    roundId: IdSchema.nullable().default(null),
    targetId: IdSchema.nullable().default(null),
    externalCalendarId: z.string().max(2000).nullable().default(null),
    title: z.string().trim().min(1).max(2000),
    startsAt: IsoDateTimeSchema,
    endsAt: IsoDateTimeSchema,
    location: z.string().max(2000).nullable().default(null),
    attendees: z
      .array(
        z.object({
          name: z.string().max(500).nullable().default(null),
          email: EmailSchema,
          // A local-only canonical relationship. Connector adapters deliberately
          // project attendee records to name/email before calling a provider.
          personId: IdSchema.optional(),
        }),
      )
      .default([]),
    agenda: z.string().max(50_000).nullable().default(null),
    notes: z.string().max(100_000).nullable().default(null),
    status: z.enum(['tentative', 'confirmed', 'cancelled']).default('confirmed'),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .superRefine((meeting, context) => {
    if (Date.parse(meeting.endsAt) <= Date.parse(meeting.startsAt))
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endsAt'],
        message: 'Meeting must end after it starts',
      });
  });
export type MeetingInput = z.input<typeof MeetingSchema>;

export const TaskSchema = z.object({
  id: IdSchema,
  roundId: IdSchema.nullable().default(null),
  targetId: IdSchema.nullable().default(null),
  title: z.string().trim().min(1).max(2000),
  description: z.string().max(50_000).nullable().default(null),
  dueAt: IsoDateTimeSchema.nullable().default(null),
  status: z.enum(['open', 'done', 'cancelled']).default('open'),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type TaskInput = z.input<typeof TaskSchema>;

export const NoteSchema = z.object({
  id: IdSchema,
  roundId: IdSchema.nullable().default(null),
  targetId: IdSchema.nullable().default(null),
  personId: IdSchema.nullable().default(null),
  firmId: IdSchema.nullable().default(null),
  body: z.string().trim().min(1).max(1_000_000),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type NoteInput = z.input<typeof NoteSchema>;

export const KnowledgeItemSchema = z.object({
  id: IdSchema,
  kind: z.string().trim().min(1).max(200),
  title: z.string().trim().min(1).max(2000),
  content: z.string().min(1).max(5_000_000),
  sourceUrl: UrlSchema.nullable().default(null),
  sharePolicy: z
    .enum(['internal', 'safe_for_outreach', 'meeting_only', 'diligence_only'])
    .default('internal'),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type KnowledgeItemInput = z.input<typeof KnowledgeItemSchema>;

export const ListSchema = z.object({
  id: IdSchema,
  name: z.string().trim().min(1).max(1000),
  description: z.string().max(20_000).nullable().default(null),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type ListInput = z.input<typeof ListSchema>;

export const AgentRunSchema = z.object({
  id: IdSchema,
  provider: z.enum(['codex', 'claude', 'custom']),
  model: z.string().max(500).nullable().default(null),
  purpose: z.string().trim().min(1).max(5000),
  contextPolicy: z.record(z.string(), z.unknown()).default({}),
  status: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']).default('queued'),
  startedAt: IsoDateTimeSchema.nullable().default(null),
  completedAt: IsoDateTimeSchema.nullable().default(null),
  errorDetail: z.string().max(100_000).nullable().default(null),
  createdAt: IsoDateTimeSchema,
});
export type AgentRunInput = z.input<typeof AgentRunSchema>;

export const AgentProposalSchema = z.object({
  id: IdSchema,
  agentRunId: IdSchema,
  proposalType: z.string().trim().min(1).max(500),
  payload: z.unknown(),
  status: z.enum(['pending', 'accepted', 'rejected', 'expired']).default('pending'),
  reviewedAt: IsoDateTimeSchema.nullable().default(null),
  createdAt: IsoDateTimeSchema,
});
export type AgentProposalInput = z.input<typeof AgentProposalSchema>;

export const BackupEnvelopeSchema = z.object({
  format: z.literal('outreachr-encrypted-backup'),
  version: z.literal(1),
  createdAt: IsoDateTimeSchema,
  sqliteSha256: z.string().regex(/^[a-f0-9]{64}$/),
  kdf: z.object({
    name: z.literal('scrypt'),
    salt: z.string().regex(/^[A-Za-z0-9+/]{43}=$/u),
    N: z
      .number()
      .int()
      .min(1024)
      .max(65_536)
      .refine((value) => Number.isInteger(Math.log2(value)), 'scrypt N must be a power of two'),
    r: z.number().int().min(1).max(16),
    p: z.number().int().min(1).max(4),
  }),
  cipher: z.object({
    name: z.literal('aes-256-gcm'),
    iv: z.string().regex(/^[A-Za-z0-9+/]{16}$/u),
    authTag: z.string().regex(/^[A-Za-z0-9+/]{22}==$/u),
  }),
  ciphertext: z
    .string()
    .min(1)
    .max(715_827_884)
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u),
});
export type BackupEnvelope = z.infer<typeof BackupEnvelopeSchema>;

export function normalizeEmail(value: string): string {
  return EmailSchema.parse(value).trim().toLowerCase();
}

export function normalizeDomain(value: string): string {
  return value.trim().toLowerCase().replace(/^@/, '');
}

export function stableJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  if (typeof value === 'bigint') throw new TypeError('BigInt is not a JSON value');
  if (typeof value === 'function' || typeof value === 'symbol') return 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
    .join(',')}}`;
}
