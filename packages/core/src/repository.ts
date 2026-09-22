import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { CoreVault } from './database.js';
import {
  AgentProposalSchema,
  AgentRunSchema,
  ClaimSchema,
  ConnectorConfigSchema,
  ContactMethodSchema,
  FirmSchema,
  FounderProfileSchema,
  FundSchema,
  IdSchema,
  KnowledgeItemSchema,
  ListSchema,
  MeetingSchema,
  MessageDraftSchema,
  normalizeDomain,
  normalizeEmail,
  NoteSchema,
  PersonSchema,
  RoundSchema,
  SourceSchema,
  stableJson,
  SuppressionSchema,
  TargetSchema,
  TaskSchema,
  type AgentProposalInput,
  type AgentRunInput,
  type ClaimInput,
  type ConnectorConfigInput,
  type ContactMethodInput,
  type FirmInput,
  type FounderProfileInput,
  type FundInput,
  type KnowledgeItemInput,
  type ListInput,
  type MeetingInput,
  type MessageDraftInput,
  type NoteInput,
  type PersonInput,
  type RoundInput,
  type SourceInput,
  type SuppressionInput,
  type TargetInput,
  type TaskInput,
} from './validation.js';

const TagInputSchema = z.object({
  id: IdSchema,
  kind: z.string().trim().min(1).max(200),
  value: z.string().trim().min(1).max(1000),
  isPublic: z.boolean().default(false),
  contributionEligible: z.boolean().default(false),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});

const TagAssignmentSchema = z.object({
  entityType: z.enum(['firm', 'person', 'fund']),
  entityId: IdSchema,
  tagId: IdSchema,
  sourceId: IdSchema.nullable().default(null),
  isPublic: z.boolean().default(false),
  contributionEligible: z.boolean().default(false),
  createdAt: z.string().datetime({ offset: true }),
});

const SourceAssignmentSchema = z.object({
  entityType: z.enum(['firm', 'person', 'fund']),
  entityId: IdSchema,
  sourceId: IdSchema,
  sourceRole: z.string().trim().min(1).max(200),
  evidenceGranularity: z.string().trim().min(1).max(200),
  isPublic: z.boolean().default(false),
  contributionEligible: z.boolean().default(false),
  createdAt: z.string().datetime({ offset: true }),
});

export interface ApprovalRecord {
  id: string;
  messageId: string;
  contentSha256: string;
  provider: 'google' | 'microsoft';
  senderAddress: string;
  senderNormalized: string;
  messageKind: 'initial' | 'follow_up' | 'intro_request' | 'reply';
  providerThreadId: string | null;
  approvedAt: string;
  expiresAt: string | null;
  status: string;
}

export interface SendReservation {
  id: string;
  messageId: string;
  recipientAddress: string;
  recipientNormalized: string;
  recipientPersonId: string;
  provider: 'google' | 'microsoft';
  senderAddress: string;
  senderNormalized: string;
  messageKind: 'initial' | 'follow_up' | 'intro_request' | 'reply';
  providerThreadId: string | null;
  status: 'reserved';
}

const MailboxSendReconciliationSchema = z.object({
  operationKey: IdSchema.refine((value) => value.startsWith('send:'), {
    message: 'Mailbox send operation keys must use the send: namespace',
  }),
  provider: z.enum(['google', 'microsoft']),
  providerMessageId: z.string().trim().min(1).max(4_096),
  providerThreadId: z.string().trim().min(1).max(4_096).nullable().default(null),
  recipientAddresses: z.array(z.string().trim().email().max(320)).min(1).max(500),
  subject: z.string().max(10_000),
  occurredAt: z.string().datetime({ offset: true }),
  reconciledAt: z.string().datetime({ offset: true }),
});

export const DEFAULT_OPT_OUT_TEXT =
  'If you prefer no further email from me, reply "opt out" and I will not contact you again.';

const CommunicationSettingsSchema = z.object({
  sendingPaused: z.boolean(),
  dailySendLimit: z.number().int().min(1).max(50),
  hourlySendLimit: z.number().int().min(1).max(20),
  recipientDomainDailyLimit: z.number().int().min(1).max(20),
  recipientDomainCooldownMinutes: z.number().int().min(1).max(1_440),
  postalAddress: z.string().trim().min(1).max(1_000).nullable(),
  optOutText: z.string().trim().min(1).max(1_000),
});

export interface CommunicationSettings {
  sendingPaused: boolean;
  dailySendLimit: number;
  hourlySendLimit: number;
  recipientDomainDailyLimit: number;
  recipientDomainCooldownMinutes: number;
  postalAddress: string | null;
  optOutText: string;
}

export function buildCommunicationFooter(input: {
  founderName?: string | null;
  companyName?: string | null;
  postalAddress: string;
  optOutText: string;
}): string {
  return [
    '—',
    input.founderName?.trim(),
    input.companyName?.trim(),
    input.postalAddress.trim(),
    input.optOutText.trim(),
  ]
    .filter((line): line is string => Boolean(line))
    .join('\n');
}

export function appendCommunicationFooter(
  bodyText: string,
  input: Parameters<typeof buildCommunicationFooter>[0],
): string {
  const postalAddress = input.postalAddress.trim();
  const optOutText = input.optOutText.trim();
  if (bodyText.includes(postalAddress) && bodyText.includes(optOutText)) return bodyText;
  return `${bodyText.trimEnd()}\n\n${buildCommunicationFooter(input)}`;
}

export interface TargetListItem {
  id: string;
  roundId: string;
  stage: string;
  disposition: 'not_now' | null;
  priority: number;
  fitScore: number | null;
  expectedCheckUsd: number | null;
  firmId: string | null;
  firmName: string | null;
  personId: string | null;
  personName: string | null;
  nextActionAt: string | null;
}

function bool(value: boolean): number {
  return value ? 1 : 0;
}

function normalizedName(value: string): string {
  return value.trim().toLocaleLowerCase('en-US').replace(/\s+/g, ' ');
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

interface AuditEntryInput {
  occurredAt: string;
  actorType: string;
  actorId?: string | null;
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  detail?: unknown;
}

interface AuditRow {
  id: number;
  occurred_at: string;
  actor_type: string;
  actor_id: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  detail_json: string;
}

function auditEntryHash(row: AuditRow, previousHash: string | null): string {
  return sha256(
    stableJson({
      version: 1,
      previousHash,
      auditId: row.id,
      occurredAt: row.occurred_at,
      actorType: row.actor_type,
      actorId: row.actor_id,
      action: row.action,
      entityType: row.entity_type,
      entityId: row.entity_id,
      detailJson: row.detail_json,
    }),
  );
}

export function appendAuditEntry(vault: CoreVault, input: AuditEntryInput): number {
  const detailJson = stableJson(input.detail ?? {});
  vault.run('SAVEPOINT outreachr_audit_append');
  try {
    vault.run(
      'INSERT INTO audit_log(occurred_at,actor_type,actor_id,action,entity_type,entity_id,detail_json) VALUES (?,?,?,?,?,?,?)',
      [
        input.occurredAt,
        input.actorType,
        input.actorId ?? null,
        input.action,
        input.entityType ?? null,
        input.entityId ?? null,
        detailJson,
      ],
    );
    const auditId = Number(vault.scalar('SELECT last_insert_rowid()'));
    const previousHash = vault.scalar(
      'SELECT entry_hash FROM audit_chain ORDER BY sequence DESC LIMIT 1',
    );
    const row: AuditRow = {
      id: auditId,
      occurred_at: input.occurredAt,
      actor_type: input.actorType,
      actor_id: input.actorId ?? null,
      action: input.action,
      entity_type: input.entityType ?? null,
      entity_id: input.entityId ?? null,
      detail_json: detailJson,
    };
    vault.run(
      'INSERT INTO audit_chain(audit_id,previous_hash,entry_hash,created_at) VALUES (?,?,?,?)',
      [
        auditId,
        typeof previousHash === 'string' ? previousHash : null,
        auditEntryHash(row, typeof previousHash === 'string' ? previousHash : null),
        input.occurredAt,
      ],
    );
    vault.run('RELEASE SAVEPOINT outreachr_audit_append');
    return auditId;
  } catch (error) {
    vault.run('ROLLBACK TO SAVEPOINT outreachr_audit_append');
    vault.run('RELEASE SAVEPOINT outreachr_audit_append');
    throw error;
  }
}

export function backfillAuditChain(vault: CoreVault): void {
  const rows =
    vault.all<AuditRow>(`SELECT a.id,a.occurred_at,a.actor_type,a.actor_id,a.action,a.entity_type,a.entity_id,a.detail_json
    FROM audit_log a LEFT JOIN audit_chain c ON c.audit_id=a.id
    WHERE c.audit_id IS NULL ORDER BY a.id`);
  let previousHash = vault.scalar(
    'SELECT entry_hash FROM audit_chain ORDER BY sequence DESC LIMIT 1',
  );
  for (const row of rows) {
    const previous = typeof previousHash === 'string' ? previousHash : null;
    const entryHash = auditEntryHash(row, previous);
    vault.run(
      'INSERT INTO audit_chain(audit_id,previous_hash,entry_hash,created_at) VALUES (?,?,?,?)',
      [row.id, previous, entryHash, row.occurred_at],
    );
    previousHash = entryHash;
  }
}

export function verifyAuditChain(vault: CoreVault): {
  ok: boolean;
  entries: number;
  errorAt: number | null;
} {
  const rows = vault.all<
    AuditRow & { sequence: number; previous_hash: string | null; entry_hash: string }
  >(`SELECT c.sequence,c.previous_hash,c.entry_hash,
    a.id,a.occurred_at,a.actor_type,a.actor_id,a.action,a.entity_type,a.entity_id,a.detail_json
    FROM audit_chain c JOIN audit_log a ON a.id=c.audit_id ORDER BY c.sequence`);
  let previousHash: string | null = null;
  for (const row of rows) {
    if (
      row.previous_hash !== previousHash ||
      row.entry_hash !== auditEntryHash(row, previousHash)
    ) {
      return { ok: false, entries: rows.length, errorAt: row.sequence };
    }
    previousHash = row.entry_hash;
  }
  const auditCount = Number(vault.scalar('SELECT COUNT(*) FROM audit_log') ?? 0);
  return {
    ok: rows.length === auditCount,
    entries: rows.length,
    errorAt: rows.length === auditCount ? null : rows.length + 1,
  };
}

function nullableJson(value: unknown): string {
  return stableJson(value);
}

export function approvalContentHash(message: {
  recipientAddress: string;
  recipientPersonId?: string | null;
  provider: 'google' | 'microsoft';
  senderAddress: string;
  messageKind: 'initial' | 'follow_up' | 'intro_request' | 'reply';
  providerThreadId?: string | null;
  replyParentId?: string | null;
  subject: string;
  bodyText: string;
  attachments: unknown;
}): string {
  return sha256(
    stableJson({
      version: 3,
      recipientAddress: normalizeEmail(message.recipientAddress),
      recipientPersonId: message.recipientPersonId ?? null,
      provider: message.provider,
      senderAddress: normalizeEmail(message.senderAddress),
      messageKind: message.messageKind,
      providerThreadId: message.providerThreadId?.trim() || null,
      replyParentId: message.replyParentId ?? null,
      subject: message.subject,
      bodyText: message.bodyText,
      attachments: message.attachments,
    }),
  );
}

export class OutreachrRepository {
  constructor(readonly vault: CoreVault) {}

  private audit(
    action: string,
    entityType: string | null,
    entityId: string | null,
    detail: unknown,
    at: string,
    actorType = 'founder',
    actorId: string | null = null,
  ): void {
    appendAuditEntry(this.vault, {
      occurredAt: at,
      actorType,
      actorId,
      action,
      entityType,
      entityId,
      detail,
    });
  }

  upsertFounderProfile(input: FounderProfileInput): void {
    const value = FounderProfileSchema.parse(input);
    this.vault.run(
      `INSERT INTO founder_profiles(id,full_name,preferred_name,work_email,company_name,company_url,location,bio,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      full_name=excluded.full_name,preferred_name=excluded.preferred_name,work_email=excluded.work_email,
      company_name=excluded.company_name,company_url=excluded.company_url,location=excluded.location,bio=excluded.bio,updated_at=excluded.updated_at`,
      [
        value.id,
        value.fullName,
        value.preferredName,
        value.workEmail,
        value.companyName,
        value.companyUrl,
        value.location,
        value.bio,
        value.createdAt,
        value.updatedAt,
      ],
    );
    this.audit('founder_profile.upsert', 'founder_profile', value.id, {}, value.updatedAt);
  }

  communicationSettings(): CommunicationSettings {
    const row = this.vault.one<{
      sending_paused: number;
      daily_send_limit: number;
      hourly_send_limit: number;
      recipient_domain_daily_limit: number;
      recipient_domain_cooldown_minutes: number;
      postal_address: string | null;
      opt_out_text: string;
    }>(
      `SELECT sending_paused,daily_send_limit,hourly_send_limit,
      recipient_domain_daily_limit,recipient_domain_cooldown_minutes,
      postal_address,opt_out_text FROM communication_settings WHERE id='global'`,
    );
    if (!row) throw new Error('Global communication settings are missing');
    return {
      sendingPaused: row.sending_paused === 1,
      dailySendLimit: row.daily_send_limit,
      hourlySendLimit: row.hourly_send_limit,
      recipientDomainDailyLimit: row.recipient_domain_daily_limit,
      recipientDomainCooldownMinutes: row.recipient_domain_cooldown_minutes,
      postalAddress: row.postal_address,
      optOutText: row.opt_out_text,
    };
  }

  updateCommunicationSettings(input: CommunicationSettings, updatedAt: string): void {
    const value = CommunicationSettingsSchema.parse(input);
    const normalized = {
      ...value,
      postalAddress: value.postalAddress?.trim() || null,
      optOutText: value.optOutText.trim(),
    };
    this.vault.transaction(() => {
      this.vault.run(
        `UPDATE communication_settings SET sending_paused=?,daily_send_limit=?,
        hourly_send_limit=?,recipient_domain_daily_limit=?,
        recipient_domain_cooldown_minutes=?,postal_address=?,opt_out_text=?,updated_at=?
        WHERE id='global'`,
        [
          bool(normalized.sendingPaused),
          normalized.dailySendLimit,
          normalized.hourlySendLimit,
          normalized.recipientDomainDailyLimit,
          normalized.recipientDomainCooldownMinutes,
          normalized.postalAddress,
          normalized.optOutText,
          updatedAt,
        ],
      );
      this.audit(
        'communication.policy_updated',
        'communication_settings',
        'global',
        {
          sendingPaused: normalized.sendingPaused,
          dailySendLimit: normalized.dailySendLimit,
          hourlySendLimit: normalized.hourlySendLimit,
          recipientDomainDailyLimit: normalized.recipientDomainDailyLimit,
          recipientDomainCooldownMinutes: normalized.recipientDomainCooldownMinutes,
          postalAddressConfigured: Boolean(normalized.postalAddress),
          optOutTextConfigured: Boolean(normalized.optOutText),
        },
        updatedAt,
      );
    });
  }

  /** Resolve only a reconciled conversation for the exact mailbox and canonical recipient. */
  conversationParent(input: {
    provider: string;
    threadId: string | null;
    senderAddress: string;
    recipientAddress: string;
    personId: string | null;
    parentId?: string | null;
  }): { internetMessageId: string; subject: string } {
    if (input.provider !== 'google' || !input.threadId || !input.personId)
      throw new Error('Follow-ups and replies require a synchronized Gmail conversation.');
    const sender = normalizeEmail(input.senderAddress);
    const recipient = normalizeEmail(input.recipientAddress);
    const events = this.vault.all<{
      internet_message_id: string | null;
      subject: string;
      sender_address: string;
      recipient_addresses_json: string;
      metadata_json: string;
    }>(
      `SELECT internet_message_id,subject,sender_address,recipient_addresses_json,metadata_json
       FROM mail_events WHERE provider=? AND provider_thread_id=? AND person_id=?
       AND kind IN ('message','reply') AND (? IS NULL OR internet_message_id=?)
       ORDER BY occurred_at DESC,id DESC`,
      [
        input.provider,
        input.threadId,
        input.personId,
        input.parentId ?? null,
        input.parentId ?? null,
      ],
    );
    for (const event of events) {
      if (
        !event.internet_message_id ||
        !/^<[^<>\s]+@[^<>\s]+>$/.test(event.internet_message_id) ||
        event.internet_message_id.length > 1000
      )
        continue;
      const metadata = JSON.parse(event.metadata_json) as { accountEmail?: string };
      const recipients = JSON.parse(event.recipient_addresses_json) as Array<{ email?: string }>;
      if (
        typeof metadata.accountEmail !== 'string' ||
        normalizeEmail(metadata.accountEmail) !== sender
      )
        continue;
      const from = normalizeEmail(event.sender_address);
      const addresses = recipients.flatMap((item) =>
        typeof item.email === 'string' ? [normalizeEmail(item.email)] : [],
      );
      if (
        (from === sender && addresses.includes(recipient)) ||
        (from === recipient && addresses.includes(sender))
      )
        return { internetMessageId: event.internet_message_id, subject: event.subject };
    }
    throw new Error(
      'Sync this mailbox before replying; no verified conversation for this recipient was found.',
    );
  }

  messageComplianceIssues(messageId: string): string[] {
    IdSchema.parse(messageId);
    const message = this.vault.one<{
      provider: string;
      sender_address: string;
      recipient_address: string;
      recipient_person_id: string | null;
      subject: string;
      reply_parent_id: string | null;
      message_kind: string | null;
      provider_thread_id: string | null;
      body_text: string;
      attachments_json: string;
    }>(
      'SELECT provider,sender_address,recipient_address,recipient_person_id,subject,reply_parent_id,message_kind,provider_thread_id,body_text,attachments_json FROM messages WHERE id=?',
      [messageId],
    );
    if (!message) return [`Message ${messageId} does not exist`];
    const policy = this.communicationSettings();
    const issues: string[] = [];
    if (!policy.postalAddress) {
      issues.push('Add a complete sender postal address in Communication safety before approval.');
    } else if (!message.body_text.includes(policy.postalAddress)) {
      issues.push('The message body must include the exact configured sender postal address.');
    }
    if (!policy.optOutText) {
      issues.push('Configure opt-out wording in Communication safety before approval.');
    } else if (!message.body_text.includes(policy.optOutText)) {
      issues.push('The message body must include the exact configured opt-out wording.');
    }
    if (
      message.message_kind === 'initial' &&
      (message.provider_thread_id || message.reply_parent_id)
    ) {
      issues.push('Initial outreach must not be attached to an existing provider thread.');
    }
    if (message.message_kind === 'follow_up' || message.message_kind === 'reply') {
      try {
        if (!message.reply_parent_id)
          throw new Error(
            'A verified reply parent is required. Sync the mailbox and create a new conversation draft.',
          );
        const parent = this.conversationParent({
          provider: message.provider,
          threadId: message.provider_thread_id,
          senderAddress: message.sender_address,
          recipientAddress: message.recipient_address,
          personId: message.recipient_person_id,
          parentId: message.reply_parent_id,
        });
        const subject = (value: string) =>
          value
            .replace(/^(?:re:\s*)+/i, '')
            .trim()
            .toLowerCase();
        if (subject(message.subject) !== subject(parent.subject))
          issues.push('Keep the conversation subject unchanged when replying.');
      } catch (error) {
        issues.push(error instanceof Error ? error.message : 'Conversation could not be verified.');
      }
    } else if (message.message_kind !== 'initial') {
      issues.push(
        'Prepare an introduction request as a reviewed initial message or conversation reply.',
      );
    }
    let attachments: unknown;
    try {
      attachments = JSON.parse(message.attachments_json) as unknown;
    } catch {
      issues.push('The draft attachment manifest is invalid.');
    }
    if (!Array.isArray(attachments) || attachments.length) {
      issues.push('Messages cannot include attachments. Share an approved document link instead.');
    }
    return issues;
  }

  upsertRound(input: RoundInput): void {
    const value = RoundSchema.parse(input);
    this.vault.run(
      `INSERT INTO rounds(id,founder_profile_id,name,stage,target_amount_usd,minimum_check_usd,maximum_check_usd,status,thesis,opened_on,closed_on,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      name=excluded.name,stage=excluded.stage,target_amount_usd=excluded.target_amount_usd,minimum_check_usd=excluded.minimum_check_usd,
      maximum_check_usd=excluded.maximum_check_usd,status=excluded.status,thesis=excluded.thesis,opened_on=excluded.opened_on,closed_on=excluded.closed_on,updated_at=excluded.updated_at`,
      [
        value.id,
        value.founderProfileId,
        value.name,
        value.stage,
        value.targetAmountUsd,
        value.minimumCheckUsd,
        value.maximumCheckUsd,
        value.status,
        value.thesis,
        value.openedOn,
        value.closedOn,
        value.createdAt,
        value.updatedAt,
      ],
    );
    this.audit(
      'round.upsert',
      'round',
      value.id,
      { stage: value.stage, status: value.status },
      value.updatedAt,
    );
  }

  upsertFirm(input: FirmInput): void {
    const value = FirmSchema.parse(input);
    this.vault.run(
      `INSERT INTO firms(id,name,normalized_name,website,investor_type,headquarters,description,is_public,contribution_eligible,origin,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      name=excluded.name,normalized_name=excluded.normalized_name,website=excluded.website,investor_type=excluded.investor_type,
      headquarters=excluded.headquarters,description=excluded.description,is_public=excluded.is_public,
      contribution_eligible=excluded.contribution_eligible,origin=excluded.origin,updated_at=excluded.updated_at`,
      [
        value.id,
        value.name,
        normalizedName(value.name),
        value.website,
        value.investorType,
        value.headquarters,
        value.description,
        bool(value.isPublic),
        bool(value.contributionEligible),
        value.origin,
        value.createdAt,
        value.updatedAt,
      ],
    );
  }

  upsertPerson(input: PersonInput): void {
    const value = PersonSchema.parse(input);
    this.vault.run(
      `INSERT INTO people(id,firm_id,full_name,normalized_name,title,city,bio,is_investor,is_public,contribution_eligible,origin,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      firm_id=excluded.firm_id,full_name=excluded.full_name,normalized_name=excluded.normalized_name,title=excluded.title,city=excluded.city,bio=excluded.bio,
      is_investor=excluded.is_investor,is_public=excluded.is_public,contribution_eligible=excluded.contribution_eligible,origin=excluded.origin,updated_at=excluded.updated_at`,
      [
        value.id,
        value.firmId,
        value.fullName,
        normalizedName(value.fullName),
        value.title,
        value.city,
        value.bio,
        bool(value.isInvestor),
        bool(value.isPublic),
        bool(value.contributionEligible),
        value.origin,
        value.createdAt,
        value.updatedAt,
      ],
    );
  }

  upsertFund(input: FundInput): void {
    const value = FundSchema.parse(input);
    this.vault.run(
      `INSERT INTO funds(id,firm_id,name,vintage_year,size_usd,announced_on,is_public,contribution_eligible,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET firm_id=excluded.firm_id,name=excluded.name,vintage_year=excluded.vintage_year,
      size_usd=excluded.size_usd,announced_on=excluded.announced_on,is_public=excluded.is_public,contribution_eligible=excluded.contribution_eligible,updated_at=excluded.updated_at`,
      [
        value.id,
        value.firmId,
        value.name,
        value.vintageYear,
        value.sizeUsd,
        value.announcedOn,
        bool(value.isPublic),
        bool(value.contributionEligible),
        value.createdAt,
        value.updatedAt,
      ],
    );
  }

  upsertSource(input: SourceInput): void {
    const value = SourceSchema.parse(input);
    this.vault.run(
      `INSERT INTO sources(id,canonical_url,title,publisher,source_type,retrieved_at,published_on,rights_class,redistribution_status,attribution,excerpt,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET canonical_url=excluded.canonical_url,title=excluded.title,publisher=excluded.publisher,
      source_type=excluded.source_type,retrieved_at=excluded.retrieved_at,published_on=excluded.published_on,rights_class=excluded.rights_class,
      redistribution_status=excluded.redistribution_status,attribution=excluded.attribution,excerpt=excluded.excerpt,updated_at=excluded.updated_at`,
      [
        value.id,
        value.canonicalUrl,
        value.title,
        value.publisher,
        value.sourceType,
        value.retrievedAt,
        value.publishedOn,
        value.rightsClass,
        value.redistributionStatus,
        value.attribution,
        value.excerpt,
        value.createdAt,
        value.updatedAt,
      ],
    );
  }

  upsertClaim(input: ClaimInput): void {
    const value = ClaimSchema.parse(input);
    this.vault.run(
      `INSERT INTO claims(id,entity_type,entity_id,field,value_json,source_id,confidence,observed_at,status,is_public,contribution_eligible,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET entity_type=excluded.entity_type,entity_id=excluded.entity_id,field=excluded.field,
      value_json=excluded.value_json,source_id=excluded.source_id,confidence=excluded.confidence,observed_at=excluded.observed_at,status=excluded.status,
      is_public=excluded.is_public,contribution_eligible=excluded.contribution_eligible,updated_at=excluded.updated_at`,
      [
        value.id,
        value.entityType,
        value.entityId,
        value.field,
        nullableJson(value.valueJson),
        value.sourceId,
        value.confidence,
        value.observedAt,
        value.status,
        bool(value.isPublic),
        bool(value.contributionEligible),
        value.createdAt,
        value.updatedAt,
      ],
    );
  }

  attachSource(input: z.input<typeof SourceAssignmentSchema>): void {
    const value = SourceAssignmentSchema.parse(input);
    this.vault.run(
      `INSERT INTO entity_sources(entity_type,entity_id,source_id,source_role,evidence_granularity,is_public,contribution_eligible,created_at)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(entity_type,entity_id,source_id,source_role) DO UPDATE SET
      evidence_granularity=excluded.evidence_granularity,is_public=excluded.is_public,contribution_eligible=excluded.contribution_eligible`,
      [
        value.entityType,
        value.entityId,
        value.sourceId,
        value.sourceRole,
        value.evidenceGranularity,
        bool(value.isPublic),
        bool(value.contributionEligible),
        value.createdAt,
      ],
    );
  }

  upsertContactMethod(input: ContactMethodInput): void {
    const value = ContactMethodSchema.parse(input);
    const normalized = value.kind.endsWith('email')
      ? normalizeEmail(value.value)
      : value.value.trim().toLocaleLowerCase('en-US');
    this.vault.run(
      `INSERT INTO contact_methods(id,person_id,kind,value,normalized_value,label,source_id,visibility,contribution_eligible,is_primary,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET person_id=excluded.person_id,kind=excluded.kind,value=excluded.value,
      normalized_value=excluded.normalized_value,label=excluded.label,source_id=excluded.source_id,visibility=excluded.visibility,
      contribution_eligible=excluded.contribution_eligible,is_primary=excluded.is_primary,updated_at=excluded.updated_at`,
      [
        value.id,
        value.personId,
        value.kind,
        value.value,
        normalized,
        value.label,
        value.sourceId,
        value.visibility,
        bool(value.contributionEligible),
        bool(value.isPrimary),
        value.createdAt,
        value.updatedAt,
      ],
    );
  }

  upsertTag(input: z.input<typeof TagInputSchema>): void {
    const value = TagInputSchema.parse(input);
    this.vault.run(
      `INSERT INTO tags(id,kind,value,normalized_value,is_public,contribution_eligible,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,value=excluded.value,normalized_value=excluded.normalized_value,
      is_public=excluded.is_public,contribution_eligible=excluded.contribution_eligible,updated_at=excluded.updated_at`,
      [
        value.id,
        value.kind,
        value.value,
        normalizedName(value.value),
        bool(value.isPublic),
        bool(value.contributionEligible),
        value.createdAt,
        value.updatedAt,
      ],
    );
  }

  attachTag(input: z.input<typeof TagAssignmentSchema>): void {
    const value = TagAssignmentSchema.parse(input);
    this.vault.run(
      `INSERT INTO entity_tags(entity_type,entity_id,tag_id,source_id,is_public,contribution_eligible,created_at)
      VALUES (?,?,?,?,?,?,?) ON CONFLICT(entity_type,entity_id,tag_id) DO UPDATE SET source_id=excluded.source_id,is_public=excluded.is_public,contribution_eligible=excluded.contribution_eligible`,
      [
        value.entityType,
        value.entityId,
        value.tagId,
        value.sourceId,
        bool(value.isPublic),
        bool(value.contributionEligible),
        value.createdAt,
      ],
    );
  }

  upsertTarget(input: TargetInput): void {
    const value = TargetSchema.parse(input);
    const prior = this.vault.one<{ stage: string }>('SELECT stage FROM targets WHERE id = ?', [
      value.id,
    ]);
    this.vault.transaction(() => {
      this.vault.run(
        `INSERT INTO targets(id,round_id,firm_id,person_id,stage,disposition,priority,fit_score,expected_check_usd,owner_note,next_action_at,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET round_id=excluded.round_id,firm_id=excluded.firm_id,person_id=excluded.person_id,
        stage=excluded.stage,disposition=excluded.disposition,priority=excluded.priority,fit_score=excluded.fit_score,expected_check_usd=excluded.expected_check_usd,
        owner_note=excluded.owner_note,next_action_at=excluded.next_action_at,updated_at=excluded.updated_at`,
        [
          value.id,
          value.roundId,
          value.firmId,
          value.personId,
          value.stage,
          value.disposition,
          value.priority,
          value.fitScore,
          value.expectedCheckUsd,
          value.ownerNote,
          value.nextActionAt,
          value.createdAt,
          value.updatedAt,
        ],
      );
      if (!prior || prior.stage !== value.stage) {
        this.vault.run(
          'INSERT INTO pipeline_events(id,target_id,from_stage,to_stage,reason,occurred_at) VALUES (?,?,?,?,?,?)',
          [
            randomUUID(),
            value.id,
            prior?.stage ?? null,
            value.stage,
            prior ? 'stage update' : 'target created',
            value.updatedAt,
          ],
        );
      }
      this.audit('target.upsert', 'target', value.id, { stage: value.stage }, value.updatedAt);
    });
  }

  listTargets(roundId: string): TargetListItem[] {
    return this.vault.all<TargetListItem>(
      `SELECT t.id,t.round_id AS roundId,t.stage,t.disposition,t.priority,t.fit_score AS fitScore,t.expected_check_usd AS expectedCheckUsd,
      t.firm_id AS firmId,f.name AS firmName,t.person_id AS personId,p.full_name AS personName,t.next_action_at AS nextActionAt
      FROM targets t LEFT JOIN firms f ON f.id=t.firm_id LEFT JOIN people p ON p.id=t.person_id
      WHERE t.round_id=? ORDER BY t.priority DESC, COALESCE(t.fit_score,-1) DESC, t.created_at`,
      [IdSchema.parse(roundId)],
    );
  }

  createMessageDraft(input: MessageDraftInput): void {
    const value = MessageDraftSchema.parse(input);
    const normalized = normalizeEmail(value.recipientAddress);
    this.vault.run(
      `INSERT INTO messages(id,round_id,target_id,recipient_person_id,recipient_address,recipient_normalized,provider,sender_address,sender_normalized,message_kind,provider_thread_id,reply_parent_id,subject,body_text,attachments_json,state,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'draft',?,?) ON CONFLICT(id) DO UPDATE SET round_id=excluded.round_id,target_id=excluded.target_id,
      recipient_person_id=excluded.recipient_person_id,recipient_address=excluded.recipient_address,recipient_normalized=excluded.recipient_normalized,
      provider=excluded.provider,sender_address=excluded.sender_address,sender_normalized=excluded.sender_normalized,
      message_kind=excluded.message_kind,provider_thread_id=excluded.provider_thread_id,reply_parent_id=excluded.reply_parent_id,
      subject=excluded.subject,body_text=excluded.body_text,attachments_json=excluded.attachments_json,updated_at=excluded.updated_at`,
      [
        value.id,
        value.roundId,
        value.targetId,
        value.recipientPersonId,
        value.recipientAddress,
        normalized,
        value.provider,
        value.senderAddress,
        normalizeEmail(value.senderAddress),
        value.messageKind,
        value.providerThreadId,
        value.replyParentId,
        value.subject,
        value.bodyText,
        stableJson(value.attachments),
        value.createdAt,
        value.updatedAt,
      ],
    );
    this.audit(
      'message.draft_saved',
      'message',
      value.id,
      {
        recipient: normalized,
        provider: value.provider,
        sender: normalizeEmail(value.senderAddress),
        messageKind: value.messageKind,
        providerThreadId: value.providerThreadId,
      },
      value.updatedAt,
    );
  }

  approveMessage(
    messageId: string,
    approvedAt: string,
    options: { approvedBy?: string; expiresAt?: string | null; approvalId?: string } = {},
  ): ApprovalRecord {
    IdSchema.parse(messageId);
    const message = this.vault.one<{
      id: string;
      recipient_address: string;
      recipient_person_id: string | null;
      provider: 'google' | 'microsoft' | null;
      sender_address: string | null;
      sender_normalized: string | null;
      message_kind: 'initial' | 'follow_up' | 'intro_request' | 'reply' | null;
      provider_thread_id: string | null;
      reply_parent_id: string | null;
      subject: string;
      body_text: string;
      attachments_json: string;
    }>(
      'SELECT id,recipient_address,recipient_person_id,provider,sender_address,sender_normalized,message_kind,provider_thread_id,reply_parent_id,subject,body_text,attachments_json FROM messages WHERE id=?',
      [messageId],
    );
    if (!message) throw new Error(`Message ${messageId} does not exist`);
    if (
      !message.provider ||
      !message.sender_address ||
      !message.sender_normalized ||
      !message.message_kind
    ) {
      throw new Error('Message delivery identity is incomplete');
    }
    if (normalizeEmail(message.sender_address) !== message.sender_normalized) {
      throw new Error('Message sender identity is not canonical');
    }
    const complianceIssues = this.messageComplianceIssues(messageId);
    if (complianceIssues.length) {
      throw new Error(`Message is not ready for approval: ${complianceIssues.join(' ')}`);
    }
    const attachments = JSON.parse(message.attachments_json) as unknown;
    const contentSha256 = approvalContentHash({
      recipientAddress: message.recipient_address,
      recipientPersonId: message.recipient_person_id,
      provider: message.provider,
      senderAddress: message.sender_address,
      messageKind: message.message_kind,
      providerThreadId: message.provider_thread_id,
      replyParentId: message.reply_parent_id,
      subject: message.subject,
      bodyText: message.body_text,
      attachments,
    });
    const approvalId = options.approvalId ?? `approval:${randomUUID()}`;
    this.vault.transaction(() => {
      this.vault.run(
        "UPDATE approvals SET status='revoked',revoked_at=? WHERE message_id=? AND status='active'",
        [approvedAt, messageId],
      );
      this.vault.run(
        "INSERT INTO approvals(id,message_id,content_sha256,provider,sender_address,sender_normalized,message_kind,provider_thread_id,approved_by,approved_at,expires_at,status) VALUES (?,?,?,?,?,?,?,?,?,?,?,'active')",
        [
          approvalId,
          messageId,
          contentSha256,
          message.provider,
          message.sender_address,
          message.sender_normalized,
          message.message_kind,
          message.provider_thread_id,
          options.approvedBy ?? 'founder',
          approvedAt,
          options.expiresAt ?? null,
        ],
      );
      this.vault.run("UPDATE messages SET state='approved',updated_at=? WHERE id=?", [
        approvedAt,
        messageId,
      ]);
      this.audit(
        'message.approved',
        'message',
        messageId,
        {
          approvalId,
          contentSha256,
          provider: message.provider,
          sender: message.sender_normalized,
          messageKind: message.message_kind,
          providerThreadId: message.provider_thread_id,
        },
        approvedAt,
      );
    });
    return {
      id: approvalId,
      messageId,
      contentSha256,
      provider: message.provider,
      senderAddress: message.sender_address,
      senderNormalized: message.sender_normalized,
      messageKind: message.message_kind,
      providerThreadId: message.provider_thread_id,
      approvedAt,
      expiresAt: options.expiresAt ?? null,
      status: 'active',
    };
  }

  addSuppression(input: SuppressionInput): void {
    const value = SuppressionSchema.parse(input);
    const normalized =
      value.scope === 'email'
        ? normalizeEmail(value.value)
        : value.scope === 'domain'
          ? normalizeDomain(value.value)
          : value.value.trim();
    this.vault.run(
      `INSERT INTO suppressions(id,scope,value,normalized_value,reason,source,active,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(scope,normalized_value) DO UPDATE SET value=excluded.value,reason=excluded.reason,source=excluded.source,active=excluded.active,updated_at=excluded.updated_at`,
      [
        value.id,
        value.scope,
        value.value,
        normalized,
        value.reason,
        value.source,
        bool(value.active),
        value.createdAt,
        value.updatedAt,
      ],
    );
    this.audit(
      'suppression.upsert',
      'suppression',
      value.id,
      { scope: value.scope, value: normalized, active: value.active },
      value.updatedAt,
    );
  }

  reserveApprovedSend(
    messageId: string,
    provider: 'google' | 'microsoft',
    authenticatedSenderAddress: string,
    reservedAt: string,
    ledgerId = `send:${randomUUID()}`,
  ): SendReservation {
    IdSchema.parse(messageId);
    const ProviderSchema = z.enum(['google', 'microsoft']);
    ProviderSchema.parse(provider);
    const authenticatedSenderNormalized = normalizeEmail(authenticatedSenderAddress);
    const message = this.vault.one<{
      id: string;
      recipient_address: string;
      recipient_normalized: string;
      recipient_person_id: string | null;
      provider: 'google' | 'microsoft' | null;
      sender_address: string | null;
      sender_normalized: string | null;
      message_kind: 'initial' | 'follow_up' | 'intro_request' | 'reply' | null;
      provider_thread_id: string | null;
      reply_parent_id: string | null;
      subject: string;
      body_text: string;
      attachments_json: string;
    }>(
      'SELECT id,recipient_address,recipient_normalized,recipient_person_id,provider,sender_address,sender_normalized,message_kind,provider_thread_id,reply_parent_id,subject,body_text,attachments_json FROM messages WHERE id=?',
      [messageId],
    );
    if (!message) throw new Error(`Message ${messageId} does not exist`);
    if (!message.recipient_person_id)
      throw new Error(
        'Approved sends must be linked to a person so lifetime deduplication is enforceable',
      );
    const complianceIssues = this.messageComplianceIssues(messageId);
    if (complianceIssues.length) {
      throw new Error(`Message is not ready to send: ${complianceIssues.join(' ')}`);
    }
    if (
      !message.provider ||
      !message.sender_address ||
      !message.sender_normalized ||
      !message.message_kind ||
      message.provider !== provider ||
      message.sender_normalized !== authenticatedSenderNormalized
    ) {
      throw new Error('Provider or authenticated sender changed after approval');
    }
    const approval = this.vault.one<{
      id: string;
      content_sha256: string;
      provider: string;
      sender_normalized: string;
      message_kind: string;
      provider_thread_id: string | null;
    }>(
      "SELECT id,content_sha256,provider,sender_normalized,message_kind,provider_thread_id FROM approvals WHERE message_id=? AND status='active'",
      [messageId],
    );
    if (!approval) throw new Error('Message has no active approval');
    if (
      approval.provider !== provider ||
      approval.sender_normalized !== authenticatedSenderNormalized ||
      approval.message_kind !== message.message_kind ||
      (approval.provider_thread_id ?? null) !== (message.provider_thread_id ?? null)
    ) {
      throw new Error('Approved delivery identity no longer matches this send');
    }
    const currentHash = approvalContentHash({
      recipientAddress: message.recipient_address,
      recipientPersonId: message.recipient_person_id,
      provider: message.provider,
      senderAddress: message.sender_address,
      messageKind: message.message_kind,
      providerThreadId: message.provider_thread_id,
      replyParentId: message.reply_parent_id,
      subject: message.subject,
      bodyText: message.body_text,
      attachments: JSON.parse(message.attachments_json),
    });
    if (currentHash !== approval.content_sha256)
      throw new Error('Message content changed after approval');

    this.vault.transaction(() => {
      this.vault.run(
        `INSERT INTO send_ledger(id,message_id,approval_id,approval_sha256,recipient_person_id,recipient_address,recipient_normalized,provider,sender_address,sender_normalized,message_kind,approved_provider_thread_id,dispatch_status,reserved_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'reserved',?)`,
        [
          ledgerId,
          messageId,
          approval.id,
          currentHash,
          message.recipient_person_id,
          message.recipient_address,
          message.recipient_normalized,
          provider,
          message.sender_address,
          message.sender_normalized,
          message.message_kind,
          message.provider_thread_id,
          reservedAt,
        ],
      );
      this.audit(
        'send.reserved',
        'send',
        ledgerId,
        { messageId, provider, recipient: message.recipient_normalized },
        reservedAt,
        'system',
      );
    });
    return {
      id: ledgerId,
      messageId,
      recipientAddress: message.recipient_address,
      recipientNormalized: message.recipient_normalized,
      recipientPersonId: message.recipient_person_id,
      provider,
      senderAddress: message.sender_address,
      senderNormalized: message.sender_normalized,
      messageKind: message.message_kind,
      providerThreadId: message.provider_thread_id,
      status: 'reserved',
    };
  }

  markDispatchStarted(ledgerId: string, at: string): void {
    this.vault.run(
      "UPDATE send_ledger SET dispatch_status='dispatching',dispatch_started_at=? WHERE id=? AND dispatch_status='reserved'",
      [at, IdSchema.parse(ledgerId)],
    );
    if (this.vault.db.getRowsModified() !== 1)
      throw new Error('Send reservation is not available for dispatch');
    this.audit('send.dispatch_started', 'send', ledgerId, {}, at, 'connector');
  }

  markSendSucceeded(
    ledgerId: string,
    providerMessageId: string,
    at: string,
    providerThreadId: string | null = null,
  ): void {
    this.vault.transaction(() => {
      this.vault.run(
        "UPDATE send_ledger SET dispatch_status='sent',provider_message_id=?,provider_thread_id=?,completed_at=? WHERE id=? AND dispatch_status IN ('reserved','dispatching')",
        [providerMessageId, providerThreadId, at, IdSchema.parse(ledgerId)],
      );
      if (this.vault.db.getRowsModified() !== 1)
        throw new Error('Send is not in a completable state');
      this.vault.run(
        "UPDATE messages SET state='sent',updated_at=? WHERE id=(SELECT message_id FROM send_ledger WHERE id=?)",
        [at, ledgerId],
      );
      this.audit(
        'send.succeeded',
        'send',
        ledgerId,
        { providerMessageId, providerThreadId },
        at,
        'connector',
      );
    });
  }

  markSendAmbiguous(ledgerId: string, errorCode: string, detail: string, at: string): void {
    this.vault.run(
      "UPDATE send_ledger SET dispatch_status='ambiguous',completed_at=?,error_code=?,error_detail=? WHERE id=? AND dispatch_status IN ('reserved','dispatching')",
      [at, errorCode, detail, IdSchema.parse(ledgerId)],
    );
    if (this.vault.db.getRowsModified() !== 1)
      throw new Error('Send is not in an ambiguous-completable state');
    this.audit('send.ambiguous_no_retry', 'send', ledgerId, { errorCode }, at, 'connector');
  }

  /**
   * Confirm an unconfirmed operation only from a provider-authoritative sent
   * observation. Mailbox data is untrusted input: malformed or mismatched
   * observations are ignored, and this method never creates or retries a send.
   */
  reconcileUnconfirmedSendFromMailbox(input: {
    operationKey: string;
    provider: 'google' | 'microsoft';
    providerMessageId: string;
    providerThreadId?: string | null;
    recipientAddresses: readonly string[];
    subject: string;
    occurredAt: string;
    reconciledAt: string;
  }): boolean {
    const parsed = MailboxSendReconciliationSchema.safeParse(input);
    if (!parsed.success) return false;
    const value = parsed.data;
    const row = this.vault.one<{
      provider: string;
      recipient_normalized: string;
      reserved_at: string;
      dispatch_status: 'dispatching' | 'ambiguous';
      subject: string;
    }>(
      `SELECT sl.provider,sl.recipient_normalized,sl.reserved_at,sl.dispatch_status,m.subject
       FROM send_ledger sl JOIN messages m ON m.id=sl.message_id
       WHERE sl.id=? AND sl.dispatch_status IN ('dispatching','ambiguous')`,
      [value.operationKey],
    );
    if (!row || row.provider !== value.provider || row.subject !== value.subject) return false;

    const recipients = [...new Set(value.recipientAddresses.map(normalizeEmail))];
    if (recipients.length !== 1 || recipients[0] !== row.recipient_normalized) return false;
    const reservedAt = Date.parse(row.reserved_at);
    const occurredAt = Date.parse(value.occurredAt);
    const reconciledAt = Date.parse(value.reconciledAt);
    const maximumProviderDelayMs = 30 * 24 * 60 * 60 * 1_000;
    const maximumClockSkewMs = 5 * 60 * 1_000;
    if (
      !Number.isFinite(reservedAt) ||
      occurredAt < reservedAt - maximumClockSkewMs ||
      occurredAt > reservedAt + maximumProviderDelayMs ||
      reconciledAt < occurredAt - maximumClockSkewMs
    ) {
      return false;
    }

    this.vault.run('SAVEPOINT outreachr_send_mailbox_reconcile');
    try {
      this.vault.run(
        `UPDATE send_ledger SET dispatch_status='sent',provider_message_id=?,
         provider_thread_id=COALESCE(?,provider_thread_id),completed_at=?,
         error_code=NULL,error_detail=NULL
         WHERE id=? AND dispatch_status IN ('dispatching','ambiguous')`,
        [value.providerMessageId, value.providerThreadId, value.occurredAt, value.operationKey],
      );
      if (this.vault.db.getRowsModified() !== 1) {
        this.vault.run('ROLLBACK TO SAVEPOINT outreachr_send_mailbox_reconcile');
        this.vault.run('RELEASE SAVEPOINT outreachr_send_mailbox_reconcile');
        return false;
      }
      this.vault.run(
        "UPDATE messages SET state='sent',updated_at=? WHERE id=(SELECT message_id FROM send_ledger WHERE id=?)",
        [value.reconciledAt, value.operationKey],
      );
      this.audit(
        'send.reconciled_from_mailbox',
        'send',
        value.operationKey,
        {
          provider: value.provider,
          providerMessageId: value.providerMessageId,
          providerThreadId: value.providerThreadId,
          providerOccurredAt: value.occurredAt,
          previousStatus: row.dispatch_status,
        },
        value.reconciledAt,
        'connector',
      );
      this.vault.run('RELEASE SAVEPOINT outreachr_send_mailbox_reconcile');
      return true;
    } catch (error) {
      this.vault.run('ROLLBACK TO SAVEPOINT outreachr_send_mailbox_reconcile');
      this.vault.run('RELEASE SAVEPOINT outreachr_send_mailbox_reconcile');
      throw error;
    }
  }

  markFailedBeforeDispatch(ledgerId: string, errorCode: string, detail: string, at: string): void {
    this.vault.run(
      "UPDATE send_ledger SET dispatch_status='failed_pre_dispatch',completed_at=?,error_code=?,error_detail=? WHERE id=? AND dispatch_status='reserved'",
      [at, errorCode, detail, IdSchema.parse(ledgerId)],
    );
    if (this.vault.db.getRowsModified() !== 1)
      throw new Error('Only a never-dispatched reservation can be marked failed_pre_dispatch');
    this.vault.run(
      "UPDATE messages SET state='failed_safe',updated_at=? WHERE id=(SELECT message_id FROM send_ledger WHERE id=?)",
      [at, ledgerId],
    );
    this.audit('send.failed_before_dispatch', 'send', ledgerId, { errorCode }, at, 'connector');
  }

  upsertMeeting(input: MeetingInput): void {
    const value = MeetingSchema.parse(input);
    this.vault.run(
      `INSERT INTO meetings(id,round_id,target_id,external_calendar_id,title,starts_at,ends_at,location,attendee_json,agenda,notes,status,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET round_id=excluded.round_id,target_id=excluded.target_id,external_calendar_id=excluded.external_calendar_id,
      title=excluded.title,starts_at=excluded.starts_at,ends_at=excluded.ends_at,location=excluded.location,attendee_json=excluded.attendee_json,
      agenda=excluded.agenda,notes=excluded.notes,status=excluded.status,updated_at=excluded.updated_at`,
      [
        value.id,
        value.roundId,
        value.targetId,
        value.externalCalendarId,
        value.title,
        value.startsAt,
        value.endsAt,
        value.location,
        stableJson(value.attendees),
        value.agenda,
        value.notes,
        value.status,
        value.createdAt,
        value.updatedAt,
      ],
    );
  }

  upsertTask(input: TaskInput): void {
    const value = TaskSchema.parse(input);
    this.vault.run(
      `INSERT INTO tasks(id,round_id,target_id,title,description,due_at,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET round_id=excluded.round_id,target_id=excluded.target_id,title=excluded.title,description=excluded.description,due_at=excluded.due_at,status=excluded.status,updated_at=excluded.updated_at`,
      [
        value.id,
        value.roundId,
        value.targetId,
        value.title,
        value.description,
        value.dueAt,
        value.status,
        value.createdAt,
        value.updatedAt,
      ],
    );
  }

  upsertNote(input: NoteInput): void {
    const value = NoteSchema.parse(input);
    this.vault.run(
      `INSERT INTO notes(id,round_id,target_id,person_id,firm_id,body,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET round_id=excluded.round_id,target_id=excluded.target_id,person_id=excluded.person_id,firm_id=excluded.firm_id,body=excluded.body,updated_at=excluded.updated_at`,
      [
        value.id,
        value.roundId,
        value.targetId,
        value.personId,
        value.firmId,
        value.body,
        value.createdAt,
        value.updatedAt,
      ],
    );
  }

  upsertKnowledgeItem(input: KnowledgeItemInput): void {
    const value = KnowledgeItemSchema.parse(input);
    this.vault.run(
      `INSERT INTO knowledge_items(id,kind,title,content,source_url,content_sha256,created_at,updated_at,share_policy) VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,title=excluded.title,content=excluded.content,source_url=excluded.source_url,content_sha256=excluded.content_sha256,share_policy=excluded.share_policy,updated_at=excluded.updated_at`,
      [
        value.id,
        value.kind,
        value.title,
        value.content,
        value.sourceUrl,
        sha256(value.content),
        value.createdAt,
        value.updatedAt,
        value.sharePolicy,
      ],
    );
  }

  upsertList(input: ListInput): void {
    const value = ListSchema.parse(input);
    this.vault.run(
      `INSERT INTO lists(id,name,description,created_at,updated_at) VALUES (?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,description=excluded.description,updated_at=excluded.updated_at`,
      [value.id, value.name, value.description, value.createdAt, value.updatedAt],
    );
  }

  addListMember(
    listId: string,
    entityType: 'firm' | 'person' | 'fund' | 'target',
    entityId: string,
    addedAt: string,
    rank: number | null = null,
  ): void {
    this.vault.run(
      'INSERT INTO list_members(list_id,entity_type,entity_id,rank,added_at) VALUES (?,?,?,?,?) ON CONFLICT(list_id,entity_type,entity_id) DO UPDATE SET rank=excluded.rank',
      [IdSchema.parse(listId), entityType, IdSchema.parse(entityId), rank, addedAt],
    );
  }

  upsertConnectorConfig(input: ConnectorConfigInput): void {
    const value = ConnectorConfigSchema.parse(input);
    this.vault.run(
      `INSERT INTO connector_configs(id,provider,account_label,public_config_json,secret_ref,scopes_json,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET provider=excluded.provider,account_label=excluded.account_label,public_config_json=excluded.public_config_json,
      secret_ref=excluded.secret_ref,scopes_json=excluded.scopes_json,status=excluded.status,updated_at=excluded.updated_at`,
      [
        value.id,
        value.provider,
        value.accountLabel,
        stableJson(value.publicConfig),
        value.secretRef,
        stableJson(value.scopes),
        value.status,
        value.createdAt,
        value.updatedAt,
      ],
    );
    this.audit(
      'connector.config_upsert',
      'connector',
      value.id,
      { provider: value.provider, scopes: value.scopes, secretRef: value.secretRef },
      value.updatedAt,
    );
  }

  createAgentRun(input: AgentRunInput): void {
    const value = AgentRunSchema.parse(input);
    this.vault.run(
      'INSERT INTO agent_runs(id,provider,model,purpose,context_policy_json,status,started_at,completed_at,error_detail,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [
        value.id,
        value.provider,
        value.model,
        value.purpose,
        stableJson(value.contextPolicy),
        value.status,
        value.startedAt,
        value.completedAt,
        value.errorDetail,
        value.createdAt,
      ],
    );
    this.audit(
      'agent.run_created',
      'agent_run',
      value.id,
      { provider: value.provider, purpose: value.purpose },
      value.createdAt,
      'agent',
      value.id,
    );
  }

  createAgentProposal(input: AgentProposalInput): void {
    const value = AgentProposalSchema.parse(input);
    const payloadJson = stableJson(value.payload);
    this.vault.run(
      'INSERT INTO agent_proposals(id,agent_run_id,proposal_type,payload_json,payload_sha256,status,reviewed_at,created_at) VALUES (?,?,?,?,?,?,?,?)',
      [
        value.id,
        value.agentRunId,
        value.proposalType,
        payloadJson,
        sha256(payloadJson),
        value.status,
        value.reviewedAt,
        value.createdAt,
      ],
    );
    this.audit(
      'agent.proposal_created',
      'agent_proposal',
      value.id,
      { runId: value.agentRunId, type: value.proposalType },
      value.createdAt,
      'agent',
      value.agentRunId,
    );
  }

  reviewAgentProposal(
    proposalId: string,
    decision: 'accepted' | 'rejected',
    reviewedAt: string,
  ): void {
    this.vault.run(
      "UPDATE agent_proposals SET status=?,reviewed_at=? WHERE id=? AND status='pending'",
      [decision, reviewedAt, IdSchema.parse(proposalId)],
    );
    if (this.vault.db.getRowsModified() !== 1) throw new Error('Proposal is not pending');
    this.audit(`agent.proposal_${decision}`, 'agent_proposal', proposalId, {}, reviewedAt);
  }

  getRoundSummary(roundId: string): Record<string, number> {
    const rows = this.vault.all<{ stage: string; count: number }>(
      'SELECT stage,COUNT(*) AS count FROM targets WHERE round_id=? GROUP BY stage',
      [IdSchema.parse(roundId)],
    );
    return Object.fromEntries(rows.map((row) => [row.stage, Number(row.count)]));
  }
}
