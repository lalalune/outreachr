import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, open, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  approvalContentHash,
  appendCommunicationFooter,
  appendAuditEntry,
  backfillAuditChain,
  createEncryptedBackup,
  exportContribution,
  importInvestorSeed,
  MessageDraftSchema,
  OutreachrRepository,
  restoreEncryptedBackup,
  verifyAuditChain,
  type CoreVault,
} from '@outreachr/core';
import { openNodeVault } from '@outreachr/core/node';
import type { CalendarEvent, MailboxMessage } from '@outreachr/connectors';
import { z } from 'zod';
import type {
  ActivityItem,
  AgentContextGrant,
  AgentProposalItem,
  AgentProposalReviewResult,
  AgentStatus,
  AppBootstrap,
  CommandResultMap,
  Confidence,
  ConnectorStatus,
  DraftMessage,
  FounderSetupInput,
  InvestorDetail,
  InvestorKind,
  InvestorSummary,
  KnowledgeItem,
  ListItem,
  MailEventItem,
  MeetingItem,
  MoneyRange,
  PersonSummary,
  PipelineColumn,
  PipelineStage,
  SourceRef,
  SourceReviewItem,
  SuppressionItem,
  TaskItem,
  WorkItem,
} from '../shared/contracts';

const SEED_FILE_SHA256 = 'b120aeb6a71f201e6a4a3198e0b9a7eef45ff24b2c0b224b8e763fbea2caee23';
const SEED_LOGICAL_DIGEST = 'e91f834c59b9d7fc0a679174513c9b44b228cc6925c3654443f1b534d1643899';
const MAX_VAULT_OR_BACKUP_BYTES = 512 * 1024 * 1024;
const MAX_SEED_IMPORT_BYTES = 256 * 1024 * 1024;
const MAX_EXPORT_NAME_ATTEMPTS = 1_000;

async function readBoundedFile(
  path: string,
  maximumBytes: number,
  label: 'Local vault' | 'Backup' | 'Seed',
): Promise<Uint8Array> {
  const handle = await open(path, 'r');
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error(`${label} selection must be a regular file.`);
    if (metadata.size <= 0) throw new Error(`${label} file is empty.`);
    if (metadata.size > maximumBytes) {
      throw new Error(
        `${label} file is larger than the ${maximumBytes / (1024 * 1024)} MiB safety limit.`,
      );
    }
    const bytes = new Uint8Array(metadata.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (result.bytesRead === 0) throw new Error(`${label} file changed while it was being read.`);
      offset += result.bytesRead;
    }
    const sentinel = new Uint8Array(1);
    const extra = await handle.read(sentinel, 0, 1, bytes.length);
    if (extra.bytesRead !== 0) throw new Error(`${label} file changed while it was being read.`);
    return bytes;
  } finally {
    await handle.close();
  }
}

async function writeTimestampedPrivateExport(
  directory: string,
  prefix: string,
  timestamp: string,
  extension: string,
  contents: Uint8Array | string,
): Promise<string> {
  const fileTimestamp = timestamp.replaceAll(':', '-').replaceAll('.', '-');
  for (let attempt = 1; attempt <= MAX_EXPORT_NAME_ATTEMPTS; attempt += 1) {
    const suffix = attempt === 1 ? '' : `-${attempt}`;
    const output = join(directory, `${prefix}-${fileTimestamp}${suffix}${extension}`);
    try {
      await writeFile(output, contents, { flag: 'wx', mode: 0o600 });
      return output;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  throw new Error(`Could not allocate a unique ${prefix} export filename`);
}

async function writeVaultSnapshot(path: string, bytes: Uint8Array): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let renamed = false;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    renamed = true;
    if (process.platform !== 'win32') {
      const directory = await open(dirname(path), 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
  } finally {
    await handle?.close().catch(() => undefined);
    if (!renamed) {
      await unlink(temporary).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      });
    }
  }
}

interface SchemaObject {
  type: string;
  name: string;
  table_name: string;
  sql: string | null;
}

function schemaObjects(vault: CoreVault): SchemaObject[] {
  return vault.all<SchemaObject>(
    `SELECT type,name,tbl_name AS table_name,sql FROM sqlite_master
     WHERE name NOT LIKE 'sqlite_%' AND type IN ('table','index','trigger','view')
     ORDER BY type,name`,
  );
}

async function assertExpectedVaultSchema(
  candidate: CoreVault,
  wasmPath: string | undefined,
): Promise<void> {
  const baseline = await openNodeVault({ ...(wasmPath ? { wasmPath } : {}) });
  try {
    const expected = new Map(
      schemaObjects(baseline).map((object) => [`${object.type}:${object.name}`, object]),
    );
    const actual = schemaObjects(candidate);
    for (const object of actual) {
      const baselineObject = expected.get(`${object.type}:${object.name}`);
      if (
        !baselineObject ||
        baselineObject.table_name !== object.table_name ||
        baselineObject.sql !== object.sql
      ) {
        throw new Error(`Backup contains an unexpected or modified schema object: ${object.name}`);
      }
      expected.delete(`${object.type}:${object.name}`);
    }
    if (expected.size) {
      throw new Error(
        `Backup is missing required schema objects: ${[...expected.values()]
          .map((object) => object.name)
          .join(', ')}`,
      );
    }
  } finally {
    baseline.close();
  }
}

const PIPELINE_STAGES: readonly PipelineStage[] = [
  'researching',
  'ready',
  'intro_requested',
  'contacted',
  'meeting',
  'diligence',
  'partner_meeting',
  'soft_circle',
  'committed',
  'passed',
  'not_now',
];

type DbPipelineStage =
  | 'research'
  | 'qualified'
  | 'ready_to_contact'
  | 'intro_requested'
  | 'contacted'
  | 'meeting'
  | 'diligence'
  | 'partner_meeting'
  | 'term_sheet'
  | 'committed'
  | 'passed';

const UI_TO_DB_STAGE: Readonly<Record<PipelineStage, DbPipelineStage>> = {
  researching: 'research',
  ready: 'ready_to_contact',
  intro_requested: 'intro_requested',
  contacted: 'contacted',
  meeting: 'meeting',
  diligence: 'diligence',
  partner_meeting: 'partner_meeting',
  soft_circle: 'term_sheet',
  committed: 'committed',
  passed: 'passed',
  not_now: 'passed',
};

const DB_TO_UI_STAGE: Readonly<Record<string, PipelineStage>> = {
  research: 'researching',
  qualified: 'ready',
  ready_to_contact: 'ready',
  intro_requested: 'intro_requested',
  contacted: 'contacted',
  meeting: 'meeting',
  diligence: 'diligence',
  partner_meeting: 'partner_meeting',
  term_sheet: 'soft_circle',
  committed: 'committed',
  passed: 'passed',
};

const AgentProposalKindSchema = z.enum(['draft', 'task', 'pipeline_move', 'note', 'research']);

const StoredAgentProposalSchema = z
  .object({
    kind: AgentProposalKindSchema,
    title: z.string().trim().min(1).max(500),
    rationale: z.string().trim().min(1).max(4_000),
    investorId: z.string().trim().min(1).max(300).nullable(),
    payload: z.record(z.string(), z.unknown()),
  })
  .strict();

const AgentTaskPayloadSchema = z
  .object({
    title: z.string().trim().min(1).max(2_000),
    notes: z.string().max(50_000).nullable().optional(),
    dueAt: z.string().datetime({ offset: true }).nullable().optional(),
    investorId: z.string().trim().min(1).max(300).nullable().optional(),
    personId: z.string().trim().min(1).max(300).nullable().optional(),
  })
  .strict();

const AgentDraftPayloadSchema = z
  .object({
    personId: z.string().trim().min(1).max(300),
    provider: z.enum(['google', 'microsoft']),
    subject: z.string().trim().min(1).max(998),
    bodyText: z.string().min(1).max(500_000),
  })
  .strict();

const AgentPipelinePayloadSchema = z
  .object({
    investorId: z.string().trim().min(1).max(300),
    stage: z.enum([
      'researching',
      'ready',
      'intro_requested',
      'contacted',
      'meeting',
      'diligence',
      'partner_meeting',
      'soft_circle',
      'committed',
      'passed',
      'not_now',
    ]),
  })
  .strict();

const DEFAULT_AGENTS: AgentStatus[] = [
  {
    provider: 'codex',
    state: 'signed_out',
    version: null,
    accountLabel: null,
    mode: 'embedded',
    subscriptionAuthApproved: false,
    error: null,
  },
  {
    provider: 'claude',
    state: 'signed_out',
    version: null,
    accountLabel: null,
    mode: 'embedded',
    subscriptionAuthApproved: false,
    error: null,
  },
];

const DEFAULT_CONNECTORS: ConnectorStatus[] = [
  {
    provider: 'google',
    state: 'not_configured',
    accountEmail: null,
    scopes: [],
    relationshipSync: false,
    lastSyncAt: null,
    error: null,
    encryptionAvailable: false,
  },
  {
    provider: 'microsoft',
    state: 'not_configured',
    accountEmail: null,
    scopes: [],
    relationshipSync: false,
    lastSyncAt: null,
    error: null,
    encryptionAvailable: false,
  },
];

interface VaultServiceOptions {
  appVersion: string;
  platform: NodeJS.Platform;
  dataDirectory: string;
  resourceDirectory: string;
  now?: () => Date;
}

interface FirmRow {
  id: string;
  name: string;
  website: string | null;
  investor_type: string;
  headquarters: string | null;
  description: string | null;
  updated_at: string;
}

interface TargetRow {
  id: string;
  round_id: string;
  firm_id: string | null;
  person_id: string | null;
  stage: DbPipelineStage;
  disposition: 'not_now' | null;
  priority: number;
  fit_score: number | null;
  expected_check_usd: number | null;
  owner_note: string | null;
  next_action_at: string | null;
  created_at: string;
  updated_at: string;
}

interface PersonRow {
  id: string;
  firm_id: string | null;
  full_name: string;
  title: string | null;
  city: string | null;
}

interface ClaimRow {
  id: string;
  field: string;
  value_json: string;
  source_id: string | null;
  status: string;
  observed_at: string | null;
  updated_at: string;
}

interface ContactRow {
  id: string;
  person_id: string;
  kind: string;
  value: string;
  visibility: string;
  source_id: string | null;
}

interface MessageRow {
  id: string;
  round_id: string | null;
  target_id: string | null;
  recipient_person_id: string | null;
  recipient_address: string;
  recipient_normalized: string;
  provider: 'google' | 'microsoft';
  sender_address: string;
  sender_normalized: string;
  message_kind: DraftMessage['kind'];
  provider_thread_id: string | null;
  subject: string;
  body_text: string;
  attachments_json: string;
  state: string;
  created_at: string;
  updated_at: string;
}

function stringValue(value: unknown): string {
  if (typeof value !== 'string') return '';
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === 'string' ? parsed : JSON.stringify(parsed);
  } catch {
    return value;
  }
}

function factValues(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(factValues);
  if (value && typeof value === 'object') return Object.values(value).flatMap(factValues);
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
    return [];
  }
  return String(value)
    .split(/[|;,•]/u)
    .map((item) =>
      item
        .trim()
        .replace(/^\[+|\]+$/gu, '')
        .replace(/^[\s'"{}]+|[\s'"{}]+$/gu, ''),
    )
    .filter(Boolean);
}

function splitFacts(value: string): string[] {
  try {
    return factValues(JSON.parse(value) as unknown);
  } catch {
    return factValues(value);
  }
}

function unique(values: Iterable<string>): string[] {
  return [...new Set([...values].map((value) => value.trim()).filter(Boolean))];
}

function investorKind(value: string, sectors: readonly string[]): InvestorKind {
  const normalized = `${value} ${sectors.join(' ')}`.toLowerCase().replaceAll('_', ' ');
  if (
    normalized.includes('crypto') ||
    normalized.includes('blockchain') ||
    normalized.includes('web3')
  )
    return 'crypto_fund';
  if (normalized.includes('corporate')) return 'corporate_vc';
  if (normalized.includes('family office')) return 'family_office';
  if (normalized.includes('accelerator')) return 'accelerator';
  if (normalized.includes('studio')) return 'venture_studio';
  if (normalized.includes('syndicate')) return 'syndicate';
  if (normalized.includes('scout')) return 'scout';
  if (normalized.includes('angel network') || normalized.includes('founder community'))
    return 'angel_network';
  if (normalized.includes('angel')) return 'angel';
  if (normalized.includes('solo')) return 'solo_gp';
  if (normalized.includes('micro')) return 'micro_vc';
  return 'venture_capital';
}

function parseMoney(value: string): MoneyRange {
  const values = [...stringValue(value).matchAll(/\$?([\d,.]+)\s*(k|m|b)?/giu)]
    .map((match) => {
      const number = Number((match[1] ?? '').replaceAll(',', ''));
      const suffix = match[2]?.toLowerCase();
      return Math.round(
        number *
          (suffix === 'b'
            ? 1_000_000_000
            : suffix === 'm'
              ? 1_000_000
              : suffix === 'k'
                ? 1_000
                : 1),
      );
    })
    .filter((number) => Number.isFinite(number) && number > 0);
  if (!values.length) return { currency: 'USD', minimum: null, maximum: null, typical: null };
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  return {
    currency: 'USD',
    minimum,
    maximum,
    typical: values.length === 1 ? values[0]! : Math.round((minimum + maximum) / 2),
  };
}

function sourceConfidence(status: string): Confidence {
  if (status === 'verified') return 'verified';
  if (status === 'stale') return 'stale';
  if (status === 'asserted') return 'supported';
  if (status === 'disputed') return 'unknown';
  return 'inferred';
}

function sourceReviewItem(row: Record<string, unknown>): SourceReviewItem {
  return {
    id: sqlText(row.id),
    entityName: sqlText(row.entity_name, 'Unknown'),
    field: sqlText(row.field),
    currentValue: null,
    proposedValue: stringValue(sqlText(row.value_json)),
    source: {
      id: sqlText(row.source_id),
      title: sqlText(row.publisher, sqlText(row.canonical_url, 'Source')),
      url: sqlText(row.canonical_url),
      publisher: sqlText(row.publisher, 'Unknown'),
      observedAt: sqlText(row.observed_at, sqlText(row.updated_at)),
      confidence: sourceConfidence(sqlText(row.status)),
      rights: 'local_research',
    },
    status: 'pending',
  };
}

function csvCell(value: unknown): string {
  let text = '';
  if (typeof value === 'string') text = value;
  else if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint')
    text = String(value);
  else if (value instanceof Uint8Array) text = Buffer.from(value).toString('base64');
  else if (value !== null && value !== undefined) text = JSON.stringify(value) ?? '';
  // Prevent imported investor/source text from becoming a spreadsheet formula
  // when a founder opens the private CSV in Excel, Numbers, or LibreOffice.
  if (/^[\t\r ]*[=+@-]/u.test(text)) text = `'${text}`;
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function sqlText(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint')
    return String(value);
  return fallback;
}

export class VaultService {
  readonly vaultPath: string;
  readonly #options: VaultServiceOptions;
  readonly #now: () => Date;
  #vault!: CoreVault;
  #repository!: OutreachrRepository;
  #persistQueue: Promise<void> = Promise.resolve();
  #connectorStatuses: ConnectorStatus[] = DEFAULT_CONNECTORS;
  #agentStatuses: AgentStatus[] = DEFAULT_AGENTS;

  constructor(options: VaultServiceOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => new Date());
    this.vaultPath = join(options.dataDirectory, 'outreachr.sqlite');
  }

  get vault(): CoreVault {
    return this.#vault;
  }

  get repository(): OutreachrRepository {
    return this.#repository;
  }

  async initialize(): Promise<void> {
    await mkdir(this.#options.dataDirectory, { recursive: true });
    const resetMarker = join(this.#options.dataDirectory, 'reset-on-next-launch');
    try {
      await access(resetMarker);
      try {
        await unlink(this.vaultPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await unlink(resetMarker);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    let bytes: Uint8Array | undefined;
    try {
      bytes = await readBoundedFile(this.vaultPath, MAX_VAULT_OR_BACKUP_BYTES, 'Local vault');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const packagedWasmPath = join(this.#options.resourceDirectory, 'sql-wasm.wasm');
    let wasmPath: string | undefined;
    try {
      await access(packagedWasmPath);
      wasmPath = packagedWasmPath;
    } catch {
      // Development resolves the direct sql.js dependency; packaged builds provide a hashed resource.
    }
    this.#vault = await openNodeVault({
      ...(bytes ? { bytes } : {}),
      ...(wasmPath ? { wasmPath } : {}),
    });
    this.#repository = new OutreachrRepository(this.#vault);
    backfillAuditChain(this.#vault);
    if (!bytes) {
      const seedBytes = await readBoundedFile(
        join(this.#options.resourceDirectory, 'Outreachr_Investor_Seed.sqlite'),
        MAX_SEED_IMPORT_BYTES,
        'Seed',
      );
      const importedAt = this.#now().toISOString();
      const result = importInvestorSeed(this.#vault.sqlite, this.#vault, seedBytes, {
        importedAt,
        expectedFileSha256: SEED_FILE_SHA256,
        expectedLogicalDigest: SEED_LOGICAL_DIGEST,
        allowUnsignedResearch: true,
      });
      appendAuditEntry(this.#vault, {
        occurredAt: importedAt,
        actorType: 'system',
        action: 'seed.imported',
        entityType: 'seed_package',
        entityId: result.packageId,
        detail: {
          packageVersion: result.packageVersion,
          logicalDigestSha256: result.logicalDigestSha256,
          signatureStatus: result.signatureStatus,
          counts: {
            firms: result.firmCount,
            people: result.personCount,
            sources: result.sourceCount,
          },
        },
      });
    }
    // Persist migrations, audit-chain backfills, and a first seed before the UI opens.
    await this.persist();
  }

  setRuntimeStatuses(connectors: ConnectorStatus[], agents: AgentStatus[]): void {
    this.#connectorStatuses = connectors;
    this.#agentStatuses = agents;
  }

  persist(): Promise<void> {
    const snapshot = this.#vault.export();
    const pending = this.#persistQueue.then(() => writeVaultSnapshot(this.vaultPath, snapshot));
    this.#persistQueue = pending.catch(() => undefined);
    return pending;
  }

  recordConnectorDisconnect(provider: 'google' | 'microsoft', occurredAt: string): void {
    appendAuditEntry(this.#vault, {
      occurredAt,
      actorType: 'founder',
      actorId: 'founder',
      action: 'connector.disconnected',
      entityType: 'connector',
      entityId: `connector:${provider}`,
      detail: { provider },
    });
  }

  async scheduleReset(): Promise<{ scheduled: true }> {
    const marker = join(this.#options.dataDirectory, 'reset-on-next-launch');
    await writeFile(
      marker,
      'Delete the exact Outreachr SQLite vault on the next application launch.\n',
      { mode: 0o600 },
    );
    appendAuditEntry(this.#vault, {
      occurredAt: this.#now().toISOString(),
      actorType: 'founder',
      actorId: 'founder',
      action: 'data.reset_scheduled',
      entityType: 'vault',
      entityId: 'local',
      detail: { timing: 'next_launch' },
    });
    await this.persist();
    return { scheduled: true };
  }

  integrityCheck(): { ok: boolean; messages: string[] } {
    return this.#vault.integrityCheck();
  }

  auditIntegrity(): { ok: boolean; entries: number; errorAt: number | null } {
    return verifyAuditChain(this.#vault);
  }

  #claims(entityType: 'firm' | 'person', entityId: string): ClaimRow[] {
    return this.#vault.all<ClaimRow>(
      'SELECT id,field,value_json,source_id,status,observed_at,updated_at FROM claims WHERE entity_type=? AND entity_id=? ORDER BY updated_at DESC,id',
      [entityType, entityId],
    );
  }

  #tags(entityType: 'firm' | 'person', entityId: string, kind?: string): string[] {
    const rows = this.#vault.all<{ kind: string; value: string }>(
      `SELECT tg.kind,tg.value FROM entity_tags et JOIN tags tg ON tg.id=et.tag_id
       WHERE et.entity_type=? AND et.entity_id=? ${kind ? 'AND tg.kind=?' : ''} ORDER BY tg.kind,tg.value`,
      kind ? [entityType, entityId, kind] : [entityType, entityId],
    );
    return rows.map((row) => row.value);
  }

  #claimValues(claims: readonly ClaimRow[], fields: readonly string[]): string[] {
    return unique(
      claims
        .filter((claim) => fields.includes(claim.field))
        .flatMap((claim) => splitFacts(claim.value_json)),
    );
  }

  #roundRow(): Record<string, unknown> | null {
    return this.#vault.one<Record<string, unknown>>(
      "SELECT * FROM rounds ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'planning' THEN 1 ELSE 2 END,created_at LIMIT 1",
    );
  }

  #targetsByFirm(): Map<string, TargetRow> {
    return new Map(
      this.#vault
        .all<TargetRow>(
          'SELECT * FROM targets WHERE firm_id IS NOT NULL AND person_id IS NULL ORDER BY updated_at DESC',
        )
        .map((target) => [target.firm_id!, target]),
    );
  }

  #contactMap(): Map<string, ContactRow[]> {
    const result = new Map<string, ContactRow[]>();
    for (const contact of this.#vault.all<ContactRow>(
      'SELECT id,person_id,kind,value,visibility,source_id FROM contact_methods ORDER BY is_primary DESC,updated_at DESC',
    )) {
      result.set(contact.person_id, [...(result.get(contact.person_id) ?? []), contact]);
    }
    return result;
  }

  #personSummary(
    row: PersonRow,
    firmName: string | null,
    contacts: readonly ContactRow[],
    targets: readonly TargetRow[],
  ): PersonSummary {
    const workEmail = contacts.find((contact) => contact.kind === 'work_email')?.value ?? null;
    const personalEmail =
      contacts.find((contact) => contact.kind === 'personal_email')?.value ?? null;
    const email = workEmail ?? personalEmail;
    const sent = this.#vault.one<{ status: string }>(
      `SELECT status FROM (
         SELECT dispatch_status AS status,COALESCE(completed_at,reserved_at) occurred_at
         FROM send_ledger WHERE recipient_person_id=?
         UNION ALL
         SELECT 'synced_outbound' AS status,occurred_at FROM mail_events
         WHERE person_id=? AND direction='outbound'
       ) ORDER BY occurred_at DESC LIMIT 1`,
      [row.id, row.id],
    );
    const replied = Boolean(
      this.#vault.scalar(
        "SELECT 1 FROM mail_events WHERE person_id=? AND direction='inbound' AND kind='reply' LIMIT 1",
        [row.id],
      ),
    );
    const emailDomain = email?.split('@')[1]?.toLowerCase() ?? '';
    const suppressed = this.#vault.one<{ reason: string }>(
      `SELECT reason FROM suppressions WHERE active=1 AND (
         scope='global' OR (scope='person' AND normalized_value=?) OR
         (scope='firm' AND normalized_value=?) OR
         (scope='email' AND normalized_value=lower(?)) OR
         (scope='domain' AND normalized_value=?)
       ) ORDER BY CASE scope WHEN 'global' THEN 0 WHEN 'person' THEN 1 WHEN 'firm' THEN 2 WHEN 'email' THEN 3 ELSE 4 END LIMIT 1`,
      [row.id, row.firm_id ?? '', email ?? '', emailDomain],
    );
    const claims = this.#claims('person', row.id);
    const sectors = unique([
      ...this.#tags('person', row.id, 'focus'),
      ...this.#claimValues(claims, ['focus', 'sectors']),
    ]);
    const investorKinds = unique(
      this.#claimValues(claims, ['primary_investor_type', 'investor_types']),
    ).map((value) => investorKind(value, []));
    const target = targets.find(
      (item) => item.person_id === row.id || (row.firm_id !== null && item.firm_id === row.firm_id),
    );
    const lastInteraction = this.#vault.scalar(
      `SELECT MAX(value) FROM (
         SELECT MAX(completed_at) value FROM send_ledger WHERE recipient_person_id=?
         UNION ALL SELECT MAX(occurred_at) FROM mail_events WHERE person_id=?
         UNION ALL SELECT MAX(m.starts_at) FROM meetings m WHERE EXISTS (
           SELECT 1 FROM json_each(m.attendee_json) WHERE json_extract(value,'$.email')=lower(?)
         )
       )`,
      [row.id, row.id, email ?? ''],
    );
    return {
      id: row.id,
      name: row.full_name,
      firmId: row.firm_id,
      firmName,
      title: row.title,
      investorKinds: investorKinds.length
        ? investorKinds
        : [row.firm_id ? 'venture_capital' : 'angel'],
      sectors,
      workEmail,
      personalEmail,
      email,
      emailConfidence: email
        ? contacts.find((contact) => contact.value === email)?.source_id
          ? 'supported'
          : 'inferred'
        : 'unknown',
      linkedinUrl: contacts.find((contact) => contact.kind === 'linkedin')?.value ?? null,
      xUrl: contacts.find((contact) => contact.kind === 'x')?.value ?? null,
      target: Boolean(target),
      contacted: Boolean(sent),
      replied,
      canSendInitial: Boolean(email) && !sent && !suppressed,
      suppressionReason:
        suppressed?.reason ??
        (sent ? 'An initial message is already recorded for this canonical person.' : null),
      lastInteractionAt: typeof lastInteraction === 'string' ? lastInteraction : null,
      nextAction: target?.owner_note ?? null,
    };
  }

  #allPeople(
    targetRows: readonly TargetRow[] = this.#vault.all<TargetRow>('SELECT * FROM targets'),
  ): PersonSummary[] {
    const firmNames = new Map(
      this.#vault
        .all<{ id: string; name: string }>('SELECT id,name FROM firms')
        .map((firm) => [firm.id, firm.name]),
    );
    const contacts = this.#contactMap();
    return this.#vault
      .all<PersonRow>('SELECT id,firm_id,full_name,title,city FROM people ORDER BY full_name')
      .map((person) =>
        this.#personSummary(
          person,
          person.firm_id ? (firmNames.get(person.firm_id) ?? null) : null,
          contacts.get(person.id) ?? [],
          targetRows,
        ),
      );
  }

  #fit(
    claims: readonly ClaimRow[],
    sectors: readonly string[],
    stages: readonly string[],
    geographies: readonly string[],
    check: MoneyRange,
  ): { score: number; reasons: string[] } {
    const round = this.#roundRow();
    if (!round)
      return {
        score: 50,
        reasons: ['Complete the round brief to calculate founder-specific fit.'],
      };
    const reasons: string[] = [];
    let score = 40;
    const roundStage = sqlText(round.stage).replace('_', ' ');
    if (stages.some((stage) => stage.toLowerCase().includes(roundStage))) {
      score += 20;
      reasons.push(`Invests at ${roundStage.replace('pre seed', 'pre-seed')}.`);
    }
    const thesis = sqlText(round.thesis).toLowerCase();
    const sectorMatches = sectors
      .filter((sector) => thesis.includes(sector.toLowerCase()))
      .slice(0, 2);
    if (sectorMatches.length) {
      score += Math.min(20, sectorMatches.length * 10);
      reasons.push(`Focus overlaps ${sectorMatches.join(' and ')}.`);
    }
    if (
      geographies.some((geography) =>
        /san francisco|bay area|los angeles|new york|united states|us\b/iu.test(geography),
      )
    ) {
      score += 10;
      reasons.push('US fundraising geography is supported by current evidence.');
    }
    const targetMin = Number(round.minimum_check_usd ?? 0);
    const targetMax = Number(round.maximum_check_usd ?? 0);
    if (
      check.minimum &&
      check.maximum &&
      (!targetMin || check.maximum >= targetMin) &&
      (!targetMax || check.minimum <= targetMax)
    ) {
      score += 10;
      reasons.push('Published check evidence overlaps the target range.');
    }
    if (!reasons.length && claims.length)
      reasons.push('Public source coverage exists; fit still needs founder review.');
    return { score: Math.min(100, score), reasons };
  }

  #investors(): InvestorSummary[] {
    const targets = this.#targetsByFirm();
    const lastMessages = new Map(
      this.#vault
        .all<{ firm_id: string; last_message_at: string }>(
          `SELECT firm_id,MAX(occurred_at) last_message_at FROM (
             SELECT p.firm_id,COALESCE(s.completed_at,s.reserved_at) occurred_at
             FROM send_ledger s JOIN people p ON p.id=s.recipient_person_id
             WHERE p.firm_id IS NOT NULL
             UNION ALL
             SELECT p.firm_id,e.occurred_at
             FROM mail_events e JOIN people p ON p.id=e.person_id
             WHERE p.firm_id IS NOT NULL
           ) GROUP BY firm_id`,
        )
        .map((row) => [row.firm_id, row.last_message_at]),
    );
    const peopleCounts = new Map(
      this.#vault
        .all<{ firm_id: string; count: number }>(
          'SELECT firm_id,COUNT(*) count FROM people WHERE firm_id IS NOT NULL GROUP BY firm_id',
        )
        .map((row) => [row.firm_id, Number(row.count)]),
    );
    const sourceCounts = new Map(
      this.#vault
        .all<{ entity_id: string; count: number }>(
          "SELECT entity_id,COUNT(DISTINCT source_id) count FROM entity_sources WHERE entity_type='firm' GROUP BY entity_id",
        )
        .map((row) => [row.entity_id, Number(row.count)]),
    );
    const portfolioCounts = new Map(
      this.#vault
        .all<{ entity_id: string; count: number }>(
          "SELECT entity_id,COUNT(*) count FROM claims WHERE entity_type='firm' AND field='portfolio_example' GROUP BY entity_id",
        )
        .map((row) => [row.entity_id, Number(row.count)]),
    );
    return this.#vault
      .all<FirmRow>(
        'SELECT id,name,website,investor_type,headquarters,description,updated_at FROM firms ORDER BY name',
      )
      .map((firm) => {
        const claims = this.#claims('firm', firm.id);
        const sectors = unique([
          ...this.#tags('firm', firm.id, 'sector'),
          ...this.#claimValues(claims, ['sectors', 'focus']),
        ]);
        const stages = unique([
          ...this.#tags('firm', firm.id, 'stage'),
          ...this.#claimValues(claims, ['stages']),
        ]);
        const geographies = unique([
          ...this.#tags('firm', firm.id, 'geography'),
          ...this.#claimValues(claims, ['priority_geography', 'geography_basis']),
        ]);
        const check = parseMoney(this.#claimValues(claims, ['check_size'])[0] ?? '');
        const target = targets.get(firm.id);
        const calculated = this.#fit(claims, sectors, stages, geographies, check);
        // The explicit record type is authoritative for the primary kind. A sector
        // focus such as crypto must not turn an angel or solo GP into a fund.
        const kind = investorKind(firm.investor_type, []);
        const kinds = [
          ...unique([
            firm.investor_type,
            ...this.#claimValues(claims, ['primary_investor_type', 'investor_types']),
          ]).map((value) => investorKind(value, [])),
        ];
        return {
          id: firm.id,
          name: firm.name,
          kind,
          additionalKinds: unique(kinds).filter(
            (candidate) => candidate !== kind,
          ) as InvestorKind[],
          headquarters: firm.headquarters,
          geographies,
          stages,
          sectors,
          check,
          fitScore: target?.fit_score ?? calculated.score,
          fitReasons: calculated.reasons,
          expectedCheckUsd: target?.expected_check_usd ?? null,
          confidence: claims.some((claim) => claim.status === 'verified')
            ? 'verified'
            : claims.some((claim) => claim.status === 'stale')
              ? 'stale'
              : claims.length
                ? 'supported'
                : 'unknown',
          sourceCount: sourceCounts.get(firm.id) ?? 0,
          peopleCount: peopleCounts.get(firm.id) ?? 0,
          portfolioCount: portfolioCounts.get(firm.id) ?? 0,
          target: Boolean(target),
          pipelineStage: target
            ? target.disposition === 'not_now'
              ? 'not_now'
              : (DB_TO_UI_STAGE[target.stage] ?? 'researching')
            : null,
          nextAction: target?.owner_note ?? null,
          nextActionAt: target?.next_action_at ?? null,
          lastMessageAt: lastMessages.get(firm.id) ?? null,
          conflict: 'none',
          updatedAt: firm.updated_at,
        };
      });
  }

  #round(): AppBootstrap['round'] {
    const row = this.#roundRow();
    if (!row) return null;
    const founder = this.#vault.one<{ company_name: string }>(
      'SELECT company_name FROM founder_profiles WHERE id=?',
      [String(row.founder_profile_id)],
    );
    const committed = Number(
      this.#vault.scalar(
        "SELECT COALESCE(SUM(expected_check_usd),0) FROM targets WHERE round_id=? AND stage='committed'",
        [String(row.id)],
      ) ?? 0,
    );
    const softCircle = Number(
      this.#vault.scalar(
        "SELECT COALESCE(SUM(expected_check_usd),0) FROM targets WHERE round_id=? AND stage='term_sheet'",
        [String(row.id)],
      ) ?? 0,
    );
    return {
      id: String(row.id),
      companyName: founder?.company_name ?? '',
      companyOneLiner: sqlText(row.thesis).split('\n')[0] ?? '',
      stage: row.stage as 'pre_seed' | 'seed' | 'series_a',
      targetAmount: Number(row.target_amount_usd ?? 0),
      committedAmount: committed,
      softCircleAmount: softCircle,
      targetCheck: {
        currency: 'USD',
        minimum: Number(row.minimum_check_usd ?? 0) || null,
        maximum: Number(row.maximum_check_usd ?? 0) || null,
        typical: null,
      },
      sectors: splitFacts(
        sqlText(row.thesis)
          .split('\n')
          .find((line) => line.startsWith('Sectors:'))
          ?.slice(8) ?? '',
      ),
      geographies: splitFacts(
        sqlText(row.thesis)
          .split('\n')
          .find((line) => line.startsWith('Geographies:'))
          ?.slice(12) ?? '',
      ),
      leadRequired: false,
      launchDate: typeof row.opened_on === 'string' ? row.opened_on : null,
      targetCloseDate: typeof row.closed_on === 'string' ? row.closed_on : null,
      narrative: sqlText(row.thesis),
      status: row.status as 'planning' | 'active' | 'paused' | 'closed',
    };
  }

  #tasks(): TaskItem[] {
    return this.#vault
      .all<Record<string, unknown>>(
        "SELECT * FROM tasks ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END,COALESCE(due_at,'9999'),created_at",
      )
      .map((row) => ({
        id: String(row.id),
        title: String(row.title),
        notes: typeof row.description === 'string' ? row.description : null,
        dueAt: typeof row.due_at === 'string' ? row.due_at : null,
        status: row.status === 'open' ? 'open' : row.status === 'done' ? 'done' : 'dismissed',
        investorId:
          typeof row.target_id === 'string'
            ? (this.#vault.scalar('SELECT firm_id FROM targets WHERE id=?', [row.target_id]) as
                string | null)
            : null,
        personId:
          typeof row.target_id === 'string'
            ? (this.#vault.scalar('SELECT person_id FROM targets WHERE id=?', [row.target_id]) as
                string | null)
            : null,
        createdAt: String(row.created_at),
      }));
  }

  #meetings(): MeetingItem[] {
    const now = this.#now().toISOString();
    return this.#vault
      .all<Record<string, unknown>>('SELECT * FROM meetings ORDER BY starts_at')
      .map((row) => {
        const attendees = JSON.parse(sqlText(row.attendee_json, '[]')) as Array<{
          personId?: unknown;
          email?: unknown;
        }>;
        const personIds = unique(
          attendees.flatMap((attendee) => {
            if (
              typeof attendee.personId === 'string' &&
              this.#vault.scalar('SELECT 1 FROM people WHERE id=?', [attendee.personId])
            ) {
              return [attendee.personId];
            }
            // Backward compatibility for meetings stored before canonical person
            // IDs were embedded in local attendee JSON.
            const value =
              typeof attendee.email === 'string'
                ? this.#vault.scalar(
                    "SELECT person_id FROM contact_methods WHERE kind LIKE '%email' AND normalized_value=lower(?) LIMIT 1",
                    [attendee.email],
                  )
                : null;
            return typeof value === 'string' ? [value] : [];
          }),
        );
        return {
          id: String(row.id),
          title: String(row.title),
          startsAt: String(row.starts_at),
          endsAt: String(row.ends_at),
          provider:
            typeof row.external_calendar_id === 'string' &&
            row.external_calendar_id.startsWith('microsoft:')
              ? 'microsoft'
              : typeof row.external_calendar_id === 'string'
                ? 'google'
                : 'manual',
          investorId:
            typeof row.target_id === 'string'
              ? (this.#vault.scalar('SELECT firm_id FROM targets WHERE id=?', [row.target_id]) as
                  string | null)
              : null,
          personIds,
          location: typeof row.location === 'string' ? row.location : null,
          agenda: typeof row.agenda === 'string' ? row.agenda : null,
          notes: typeof row.notes === 'string' ? row.notes : null,
          status:
            row.status === 'cancelled'
              ? 'cancelled'
              : String(row.ends_at) < now
                ? 'completed'
                : 'upcoming',
        };
      });
  }

  #knowledge(): KnowledgeItem[] {
    return this.#vault
      .all<Record<string, unknown>>('SELECT * FROM knowledge_items ORDER BY updated_at DESC')
      .map((row) => ({
        id: String(row.id),
        title: String(row.title),
        category: ['company', 'round', 'narrative', 'metrics', 'disclosure'].includes(
          String(row.kind),
        )
          ? (String(row.kind) as KnowledgeItem['category'])
          : 'other',
        content: String(row.content),
        updatedAt: String(row.updated_at),
        sharePolicy: ['internal', 'safe_for_outreach', 'meeting_only', 'diligence_only'].includes(
          String(row.share_policy),
        )
          ? (String(row.share_policy) as KnowledgeItem['sharePolicy'])
          : 'internal',
      }));
  }

  #lists(): ListItem[] {
    return this.#vault
      .all<Record<string, unknown>>(
        `SELECT l.*,SUM(CASE WHEN m.entity_type='firm' THEN 1 ELSE 0 END) count
        FROM lists l LEFT JOIN list_members m ON m.list_id=l.id
        GROUP BY l.id ORDER BY l.name`,
      )
      .map((row) => ({
        id: String(row.id),
        name: String(row.name),
        description: typeof row.description === 'string' ? row.description : null,
        count: Number(row.count),
        memberFirmIds: this.#vault
          .all<{ entity_id: string }>(
            "SELECT entity_id FROM list_members WHERE list_id=? AND entity_type='firm' ORDER BY COALESCE(rank,2147483647),added_at,entity_id",
            [String(row.id)],
          )
          .map((member) => member.entity_id),
      }));
  }

  #mailEvents(): MailEventItem[] {
    return this.#vault
      .all<Record<string, unknown>>(
        `SELECT e.*,p.full_name,p.firm_id
        FROM mail_events e JOIN people p ON p.id=e.person_id
        ORDER BY e.occurred_at DESC,e.id`,
      )
      .map((row) => ({
        id: String(row.id),
        provider: row.provider === 'microsoft' ? 'microsoft' : 'google',
        personId: String(row.person_id),
        personName: String(row.full_name),
        investorId: typeof row.firm_id === 'string' ? row.firm_id : null,
        direction: row.direction === 'inbound' ? 'inbound' : 'outbound',
        kind: ['message', 'reply', 'bounce', 'hard_bounce', 'complaint', 'unsubscribe'].includes(
          String(row.kind),
        )
          ? (String(row.kind) as MailEventItem['kind'])
          : 'message',
        subject: sqlText(row.subject),
        occurredAt: String(row.occurred_at),
        reviewedAt: typeof row.reviewed_at === 'string' ? row.reviewed_at : null,
      }));
  }

  #suppressions(): SuppressionItem[] {
    return this.#vault
      .all<Record<string, unknown>>(
        'SELECT * FROM suppressions ORDER BY active DESC,updated_at DESC,id',
      )
      .map((row) => ({
        id: String(row.id),
        scope: ['global', 'email', 'domain', 'person', 'firm'].includes(String(row.scope))
          ? (String(row.scope) as SuppressionItem['scope'])
          : 'global',
        value: String(row.value),
        reason: String(row.reason),
        source: ['founder', 'unsubscribe', 'bounce', 'complaint', 'policy', 'import'].includes(
          String(row.source),
        )
          ? (String(row.source) as SuppressionItem['source'])
          : 'policy',
        active: Number(row.active) === 1,
        updatedAt: String(row.updated_at),
      }));
  }

  #communicationPolicy(): AppBootstrap['communicationPolicy'] {
    const settings = this.#repository.communicationSettings();
    const now = this.#now().toISOString();
    const date = now.slice(0, 10);
    const reservedToday = Number(
      this.#vault.scalar(
        "SELECT COUNT(*) FROM send_ledger WHERE substr(reserved_at,1,10)=? AND dispatch_status!='failed_pre_dispatch'",
        [date],
      ) ?? 0,
    );
    const reservedThisHour = Number(
      this.#vault.scalar(
        `SELECT COUNT(*) FROM send_ledger
         WHERE dispatch_status!='failed_pre_dispatch'
           AND julianday(reserved_at)>julianday(?,'-1 hour')
           AND julianday(reserved_at)<=julianday(?)`,
        [now, now],
      ) ?? 0,
    );
    return {
      ...settings,
      reservedToday,
      reservedThisHour,
    };
  }

  #agentProposalFromRow(row: {
    id: string;
    agent_run_id: string;
    proposal_type: string;
    payload_json: string;
    payload_sha256: string;
    provider: string;
    created_at: string;
  }): AgentProposalItem {
    const digest = createHash('sha256').update(row.payload_json).digest('hex');
    if (digest !== row.payload_sha256) throw new Error('Agent proposal payload integrity failed');
    const proposal = StoredAgentProposalSchema.parse(JSON.parse(row.payload_json) as unknown);
    if (proposal.kind !== row.proposal_type) {
      throw new Error('Agent proposal kind does not match its durable record');
    }
    if (row.provider !== 'codex' && row.provider !== 'claude') {
      throw new Error('Agent proposal provider is unsupported');
    }
    return {
      id: row.id,
      agentRunId: row.agent_run_id,
      provider: row.provider,
      status: 'pending',
      createdAt: row.created_at,
      ...proposal,
    };
  }

  #agentProposals(): AgentProposalItem[] {
    return this.#vault
      .all<{
        id: string;
        agent_run_id: string;
        proposal_type: string;
        payload_json: string;
        payload_sha256: string;
        provider: string;
        created_at: string;
      }>(
        `SELECT p.id,p.agent_run_id,p.proposal_type,p.payload_json,p.payload_sha256,
        r.provider,p.created_at FROM agent_proposals p JOIN agent_runs r ON r.id=p.agent_run_id
        WHERE p.status='pending' ORDER BY p.created_at DESC,p.id`,
      )
      .flatMap((row) => {
        try {
          return [this.#agentProposalFromRow(row)];
        } catch {
          return [];
        }
      });
  }

  #draftReadiness(
    message: MessageRow,
    person: PersonSummary | undefined,
    state: DraftMessage['approvalState'],
  ): Pick<
    DraftMessage,
    'canApprove' | 'canSend' | 'approvalBlockReasons' | 'sendBlockReasons' | 'blockReason'
  > {
    const approvalBlockReasons = this.#repository.messageComplianceIssues(message.id);
    if (!message.recipient_person_id) {
      approvalBlockReasons.push(
        'Link this draft to one canonical person before approval so lifetime deduplication is enforceable.',
      );
    }
    if (person?.suppressionReason) approvalBlockReasons.push(person.suppressionReason);

    const policy = this.#communicationPolicy();
    const sendBlockReasons = [...approvalBlockReasons];
    if (message.message_kind !== 'initial') {
      sendBlockReasons.push(
        'Stock Outreachr 0.1 sends initial outreach only; keep this message local for review.',
      );
    }
    if (policy.sendingPaused)
      sendBlockReasons.push('All sending is paused in Communication safety.');
    if (policy.reservedToday >= policy.dailySendLimit) {
      sendBlockReasons.push('The founder daily send limit has been reached.');
    }
    if (policy.reservedThisHour >= policy.hourlySendLimit) {
      sendBlockReasons.push('The founder hourly send limit has been reached.');
    }

    const domain = message.recipient_normalized.split('@')[1] ?? '';
    if (domain) {
      const date = this.#now().toISOString().slice(0, 10);
      const domainCount = Number(
        this.#vault.scalar(
          `SELECT COUNT(*) FROM send_ledger
           WHERE dispatch_status!='failed_pre_dispatch'
             AND substr(reserved_at,1,10)=?
             AND substr(recipient_normalized,instr(recipient_normalized,'@')+1)=?`,
          [date, domain],
        ) ?? 0,
      );
      if (domainCount >= policy.recipientDomainDailyLimit) {
        sendBlockReasons.push(`The daily send limit for ${domain} has been reached.`);
      }
      const lastDomainReservation = this.#vault.scalar(
        `SELECT MAX(reserved_at) FROM send_ledger
         WHERE dispatch_status!='failed_pre_dispatch'
           AND substr(recipient_normalized,instr(recipient_normalized,'@')+1)=?`,
        [domain],
      );
      if (typeof lastDomainReservation === 'string') {
        const cooldownEnds =
          Date.parse(lastDomainReservation) + policy.recipientDomainCooldownMinutes * 60_000;
        if (cooldownEnds > this.#now().getTime()) {
          sendBlockReasons.push(
            `Wait until ${new Date(cooldownEnds).toISOString()} before another message to ${domain}.`,
          );
        }
      }
    }

    const connector = this.#vault.one<{
      status: string;
      public_config_json: string;
      scopes_json: string;
    }>(
      `SELECT status,public_config_json,scopes_json FROM connector_configs
       WHERE provider=? AND lower(trim(account_label))=lower(trim(?))
       ORDER BY updated_at DESC LIMIT 1`,
      [message.provider, message.sender_address],
    );
    if (!connector || connector.status !== 'connected') {
      sendBlockReasons.push(
        `Connect ${message.provider === 'google' ? 'Google Workspace' : 'Microsoft 365'} as ${message.sender_address} before sending.`,
      );
    } else {
      let relationshipSync = false;
      let scopes: string[] = [];
      try {
        const publicConfig = JSON.parse(connector.public_config_json) as Record<string, unknown>;
        relationshipSync = publicConfig.relationshipSync === true;
        const parsedScopes = JSON.parse(connector.scopes_json) as unknown;
        scopes = Array.isArray(parsedScopes)
          ? parsedScopes.filter((scope): scope is string => typeof scope === 'string')
          : [];
      } catch {
        // Invalid connector configuration fails closed below.
      }
      const readScope =
        message.provider === 'google'
          ? 'https://www.googleapis.com/auth/gmail.readonly'
          : 'Mail.ReadBasic';
      if (!relationshipSync || !scopes.includes(readScope)) {
        sendBlockReasons.push(
          'Reconnect this provider with relationship sync enabled; complete mailbox reconciliation is required before sending.',
        );
      }
    }

    const uniqueApprovalReasons = unique(approvalBlockReasons);
    const uniqueSendReasons = unique(sendBlockReasons);
    const blockReason =
      state === 'ambiguous'
        ? 'Provider outcome is ambiguous. Reconcile before any further contact.'
        : state === 'sent' || state === 'sending'
          ? null
          : state === 'approved' || state === 'failed'
            ? (uniqueSendReasons[0] ?? null)
            : (uniqueApprovalReasons[0] ?? null);
    return {
      canApprove: state === 'draft' && uniqueApprovalReasons.length === 0,
      canSend: state === 'approved' && uniqueSendReasons.length === 0,
      approvalBlockReasons: uniqueApprovalReasons,
      sendBlockReasons: uniqueSendReasons,
      blockReason,
    };
  }

  #drafts(people: readonly PersonSummary[]): DraftMessage[] {
    const byId = new Map(people.map((person) => [person.id, person]));
    return this.#vault
      .all<MessageRow>('SELECT * FROM messages ORDER BY updated_at DESC')
      .map((message) => {
        const person = message.recipient_person_id
          ? byId.get(message.recipient_person_id)
          : undefined;
        const ledger = this.#vault.one<Record<string, unknown>>(
          'SELECT * FROM send_ledger WHERE message_id=?',
          [message.id],
        );
        const approval = this.#vault.one<{ approved_at: string }>(
          "SELECT approved_at FROM approvals WHERE message_id=? AND status IN ('active','used') ORDER BY approved_at DESC LIMIT 1",
          [message.id],
        );
        const provider = message.provider;
        const state: DraftMessage['approvalState'] =
          ledger?.dispatch_status === 'sent'
            ? 'sent'
            : ledger?.dispatch_status === 'ambiguous'
              ? 'ambiguous'
              : ledger?.dispatch_status === 'dispatching'
                ? 'sending'
                : message.state === 'approved'
                  ? 'approved'
                  : message.state === 'failed_safe'
                    ? 'failed'
                    : 'draft';
        const readiness = this.#draftReadiness(message, person, state);
        return {
          id: message.id,
          provider,
          accountEmail: message.sender_address,
          personId: message.recipient_person_id ?? '',
          recipientName: person?.name ?? message.recipient_address,
          recipientEmail: message.recipient_address,
          subject: message.subject,
          bodyText: message.body_text,
          threadId:
            typeof ledger?.provider_thread_id === 'string'
              ? ledger.provider_thread_id
              : message.provider_thread_id,
          kind: message.message_kind,
          contentHash: approvalContentHash({
            recipientAddress: message.recipient_address,
            recipientPersonId: message.recipient_person_id,
            provider: message.provider,
            senderAddress: message.sender_address,
            messageKind: message.message_kind,
            providerThreadId: message.provider_thread_id,
            subject: message.subject,
            bodyText: message.body_text,
            attachments: JSON.parse(message.attachments_json),
          }),
          approvalState: state,
          ...readiness,
          approvedAt: approval?.approved_at ?? null,
          sentAt: typeof ledger?.completed_at === 'string' ? ledger.completed_at : null,
          providerMessageId:
            typeof ledger?.provider_message_id === 'string' ? ledger.provider_message_id : null,
        };
      });
  }

  #workItems(
    tasks: readonly TaskItem[],
    meetings: readonly MeetingItem[],
    drafts: readonly DraftMessage[],
    mailEvents: readonly MailEventItem[],
  ): WorkItem[] {
    return [
      ...mailEvents
        .filter((event) => event.direction === 'inbound' && !event.reviewedAt)
        .map((event): WorkItem => ({
          id: event.id,
          kind: 'follow_up',
          title:
            event.kind === 'reply'
              ? `Review reply from ${event.personName}`
              : event.kind === 'bounce' || event.kind === 'hard_bounce'
                ? `Resolve bounced email for ${event.personName}`
                : event.kind === 'unsubscribe'
                  ? `Honor unsubscribe from ${event.personName}`
                  : `Review complaint for ${event.personName}`,
          detail: event.subject || 'No subject',
          dueAt: event.occurredAt,
          investorId: event.investorId,
          personId: event.personId,
          priority: ['complaint', 'hard_bounce', 'unsubscribe'].includes(event.kind)
            ? 'urgent'
            : 'high',
          status: 'open',
        })),
      ...tasks
        .filter((task) => task.status === 'open')
        .map((task): WorkItem => ({
          id: task.id,
          kind: 'task',
          title: task.title,
          detail: task.notes ?? 'Founder task',
          dueAt: task.dueAt,
          investorId: task.investorId,
          personId: task.personId,
          priority: task.dueAt && task.dueAt < this.#now().toISOString() ? 'urgent' : 'normal',
          status: 'open',
        })),
      ...meetings
        .filter((meeting) => meeting.status === 'upcoming')
        .map((meeting): WorkItem => ({
          id: `meeting:${meeting.id}`,
          kind: 'meeting',
          title: meeting.title,
          detail: meeting.location ?? 'Upcoming investor meeting',
          dueAt: meeting.startsAt,
          investorId: meeting.investorId,
          personId: meeting.personIds[0] ?? null,
          priority: 'high',
          status: 'open',
        })),
      ...drafts
        .filter((draft) => draft.approvalState === 'draft')
        .map((draft): WorkItem => ({
          id: `draft:${draft.id}`,
          kind: 'approval',
          title: `Review message to ${draft.recipientName}`,
          detail: draft.subject,
          dueAt: null,
          investorId: null,
          personId: draft.personId,
          priority: 'normal',
          status: 'open',
        })),
    ];
  }

  async bootstrap(): Promise<AppBootstrap> {
    const targetRows = this.#vault.all<TargetRow>('SELECT * FROM targets');
    const investors = this.#investors();
    const people = this.#allPeople(targetRows);
    const tasks = this.#tasks();
    const meetings = this.#meetings();
    const mailEvents = this.#mailEvents();
    const drafts = this.#drafts(people);
    const seed = this.#vault.one<{ package_version: string; signature_status: string }>(
      'SELECT package_version,signature_status FROM seed_imports ORDER BY imported_at DESC LIMIT 1',
    );
    const pipeline: PipelineColumn[] = PIPELINE_STAGES.map((stage) => ({
      stage,
      label: stage.replaceAll('_', ' ').replace(/\b\w/gu, (letter) => letter.toUpperCase()),
      targetIds: investors
        .filter((investor) => investor.pipelineStage === stage)
        .map((investor) => investor.id),
    }));
    const sourceReview: SourceReviewItem[] = this.#vault
      .all<Record<string, unknown>>(
        "SELECT c.*,COALESCE(f.name,p.full_name,'Unknown') entity_name,s.canonical_url,s.publisher FROM claims c LEFT JOIN firms f ON c.entity_type='firm' AND f.id=c.entity_id LEFT JOIN people p ON c.entity_type='person' AND p.id=c.entity_id JOIN sources s ON s.id=c.source_id WHERE c.status IN ('stale','disputed') AND c.review_disposition IS NULL ORDER BY c.updated_at DESC,c.id",
      )
      .map(sourceReviewItem);
    return {
      appVersion: this.#options.appVersion,
      platform: ['darwin', 'win32', 'linux'].includes(this.#options.platform)
        ? (this.#options.platform as 'darwin' | 'win32' | 'linux')
        : 'other',
      vaultPath: this.vaultPath,
      isFirstRun: Number(this.#vault.scalar('SELECT COUNT(*) FROM founder_profiles') ?? 0) === 0,
      seedVersion: seed?.package_version ?? 'not imported',
      seedSignatureStatus:
        seed?.signature_status === 'verified' ? 'verified' : 'pinned unsigned research',
      round: this.#round(),
      investors,
      people,
      pipeline,
      workItems: this.#workItems(tasks, meetings, drafts, mailEvents),
      tasks,
      meetings,
      mailEvents,
      drafts,
      knowledge: this.#knowledge(),
      lists: this.#lists(),
      sourceReview,
      connectors: this.#connectorStatuses,
      agents: this.#agentStatuses,
      agentContextGrants: this.#vault
        .all<{
          provider: 'codex' | 'claude';
          context_class: AgentContextGrant['contextClass'];
          granted_at: string;
        }>(
          'SELECT provider,context_class,granted_at FROM agent_context_grants WHERE revoked_at IS NULL ORDER BY provider,context_class',
        )
        .map((row) => ({
          provider: row.provider,
          contextClass: row.context_class,
          grantedAt: row.granted_at,
        })),
      agentProposals: this.#agentProposals(),
      suppressions: this.#suppressions(),
      communicationPolicy: this.#communicationPolicy(),
      auditIntegrity: this.auditIntegrity(),
      counts: {
        firms: investors.length,
        people: people.length,
        targeted: investors.filter(
          (investor) =>
            investor.target && !['passed', 'not_now'].includes(investor.pipelineStage ?? ''),
        ).length,
        contacted: people.filter((person) => person.contacted).length,
        meetings: meetings.filter((meeting) => meeting.status !== 'cancelled').length,
        commitments: investors.filter((investor) => investor.pipelineStage === 'committed').length,
      },
    };
  }

  async investorDetail(id: string): Promise<InvestorDetail> {
    const summary = this.#investors().find((investor) => investor.id === id);
    if (!summary) throw new Error('Investor not found');
    const firm = this.#vault.one<FirmRow>(
      'SELECT id,name,website,investor_type,headquarters,description,updated_at FROM firms WHERE id=?',
      [id],
    );
    if (!firm) throw new Error('Investor not found');
    const targetRows = this.#vault.all<TargetRow>('SELECT * FROM targets');
    const people = this.#allPeople(targetRows).filter((person) => person.firmId === id);
    const claims = this.#claims('firm', id);
    const sourceRows = this.#vault.all<Record<string, unknown>>(
      `SELECT DISTINCT s.*,
      COALESCE(c.status,'asserted') claim_status,COALESCE(c.observed_at,s.retrieved_at) observed
      FROM sources s LEFT JOIN entity_sources es ON es.source_id=s.id AND es.entity_type='firm' AND es.entity_id=?
      LEFT JOIN claims c ON c.source_id=s.id AND c.entity_type='firm' AND c.entity_id=?
      WHERE es.entity_id IS NOT NULL OR c.entity_id IS NOT NULL ORDER BY observed DESC,s.id`,
      [id, id],
    );
    const sources: SourceRef[] = sourceRows.map((row) => ({
      id: sqlText(row.id),
      title: sqlText(row.title, sqlText(row.publisher, sqlText(row.canonical_url))),
      url: sqlText(row.canonical_url),
      publisher: sqlText(row.publisher, 'Unknown'),
      observedAt: sqlText(row.observed),
      confidence: sourceConfidence(sqlText(row.claim_status)),
      rights:
        row.redistribution_status === 'allowed'
          ? 'redistributable'
          : row.redistribution_status === 'attribution_required'
            ? 'link_only'
            : 'local_research',
    }));
    const sourceById = new Map(sources.map((source) => [source.id, source]));
    const unattributedSource: SourceRef = {
      id: 'unattributed',
      title: 'Unattributed seed record',
      url: '',
      publisher: 'Unknown',
      observedAt: firm.updated_at,
      confidence: 'unknown',
      rights: 'unknown',
    };
    const portfolio = claims
      .filter((claim) => claim.field === 'portfolio_example')
      .map((claim) => {
        let value: { companyName?: string; caveat?: string } = {};
        try {
          value = JSON.parse(claim.value_json) as typeof value;
        } catch {
          value = { companyName: stringValue(claim.value_json) };
        }
        return {
          id: claim.id,
          investorId: id,
          companyName: value.companyName ?? 'Unknown company',
          sector: null,
          round: null,
          announcedAt: claim.observed_at,
          source: claim.source_id
            ? (sourceById.get(claim.source_id) ?? unattributedSource)
            : unattributedSource,
        };
      });
    const auditActivity: ActivityItem[] = this.#vault
      .all<Record<string, unknown>>(
        `SELECT id,occurred_at,actor_type,action,detail_json FROM audit_log
      WHERE (entity_type='target' AND entity_id IN (SELECT id FROM targets WHERE firm_id=?))
         OR (entity_type='message' AND entity_id IN (SELECT m.id FROM messages m JOIN targets t ON t.id=m.target_id WHERE t.firm_id=?))
      ORDER BY occurred_at DESC,id DESC`,
        [id, id],
      )
      .map((row) => ({
        id: String(row.id),
        kind: String(row.action).includes('message')
          ? 'email'
          : String(row.action).includes('agent')
            ? 'agent'
            : 'stage',
        title: String(row.action).replaceAll('.', ' '),
        detail: String(row.detail_json),
        occurredAt: String(row.occurred_at),
        actor: ['founder', 'system', 'agent', 'provider'].includes(String(row.actor_type))
          ? (String(row.actor_type) as ActivityItem['actor'])
          : 'system',
      }));
    const mailActivity: ActivityItem[] = this.#vault
      .all<Record<string, unknown>>(
        `SELECT e.id,e.direction,e.kind,e.subject,e.occurred_at,p.full_name
        FROM mail_events e JOIN people p ON p.id=e.person_id WHERE p.firm_id=?
        ORDER BY e.occurred_at DESC,e.id`,
        [id],
      )
      .map((row) => ({
        id: String(row.id),
        kind: 'email',
        title: `${String(row.direction) === 'inbound' ? 'Inbound' : 'Outbound'} ${String(row.kind)} · ${String(row.full_name)}`,
        detail: sqlText(row.subject) || null,
        occurredAt: String(row.occurred_at),
        actor: 'provider',
      }));
    const activity = [...auditActivity, ...mailActivity].sort(
      (left, right) =>
        right.occurredAt.localeCompare(left.occurredAt) || right.id.localeCompare(left.id),
    );
    const claim = (field: string): string | null => this.#claimValues(claims, [field])[0] ?? null;
    return {
      ...summary,
      website: firm.website,
      description: firm.description,
      thesis: claim('sectors'),
      applicationUrl: claim('contact_url'),
      contactEmail: null,
      leadBehavior: null,
      currentFund: claim('fund_signal'),
      people,
      portfolio,
      sources,
      activity,
    };
  }

  async completeOnboarding(input: FounderSetupInput): Promise<AppBootstrap> {
    const now = this.#now().toISOString();
    const roundId = 'round:active';
    this.#vault.transaction(() => {
      this.#repository.upsertFounderProfile({
        id: 'founder',
        fullName: input.founderName,
        preferredName: input.founderName.split(' ')[0] ?? null,
        workEmail: input.founderEmail,
        companyName: input.companyName,
        companyUrl: null,
        location: null,
        bio: input.companyOneLiner,
        createdAt: now,
        updatedAt: now,
      });
      this.#repository.upsertRound({
        id: roundId,
        founderProfileId: 'founder',
        name: `${input.companyName} ${input.stage.replace('_', ' ')} round`,
        stage: input.stage,
        targetAmountUsd: input.targetAmount,
        minimumCheckUsd: input.targetCheckMinimum,
        maximumCheckUsd: input.targetCheckMaximum,
        status: 'active',
        thesis: `${input.companyOneLiner}\nSectors: ${input.sectors.join(', ')}\nGeographies: ${input.geographies.join(', ')}\n${input.narrative}`,
        openedOn: now.slice(0, 10),
        closedOn: null,
        createdAt: now,
        updatedAt: now,
      });
    });
    if (input.postalAddress?.trim()) {
      this.#repository.updateCommunicationSettings(
        {
          ...this.#repository.communicationSettings(),
          postalAddress: input.postalAddress.trim(),
        },
        now,
      );
    }
    await this.persist();
    return this.bootstrap();
  }

  async createInvestor(input: {
    name: string;
    kind: InvestorKind;
    website?: string;
    headquarters?: string;
    description?: string;
  }): Promise<InvestorSummary> {
    const now = this.#now().toISOString();
    const id = `firm:local:${createHash('sha256').update(input.name.trim().toLowerCase()).digest('hex').slice(0, 24)}`;
    this.#repository.upsertFirm({
      id,
      name: input.name,
      website: input.website ?? null,
      investorType: input.kind,
      headquarters: input.headquarters ?? null,
      description: input.description ?? null,
      isPublic: false,
      contributionEligible: false,
      origin: 'local',
      createdAt: now,
      updatedAt: now,
    });
    await this.persist();
    return this.#investors().find((investor) => investor.id === id)!;
  }

  async updateRound(input: {
    stage: 'pre_seed' | 'seed' | 'series_a';
    targetAmount: number;
    targetCheckMinimum: number | null;
    targetCheckMaximum: number | null;
    sectors: string[];
    geographies: string[];
    narrative: string;
    status: 'planning' | 'active' | 'paused' | 'closed';
  }): Promise<NonNullable<AppBootstrap['round']>> {
    const row = this.#roundRow();
    if (!row) throw new Error('No round exists');
    const now = this.#now().toISOString();
    const currentThesis = sqlText(row.thesis);
    const oneLiner =
      currentThesis
        .split('\n')
        .find((line) => !line.startsWith('Sectors:') && !line.startsWith('Geographies:')) ?? '';
    this.#repository.upsertRound({
      id: String(row.id),
      founderProfileId: String(row.founder_profile_id),
      name: String(row.name),
      stage: input.stage,
      targetAmountUsd: input.targetAmount,
      minimumCheckUsd: input.targetCheckMinimum,
      maximumCheckUsd: input.targetCheckMaximum,
      status: input.status,
      thesis: `${oneLiner}\nSectors: ${input.sectors.join(', ')}\nGeographies: ${input.geographies.join(', ')}\n${input.narrative}`,
      openedOn: typeof row.opened_on === 'string' ? row.opened_on : null,
      closedOn: typeof row.closed_on === 'string' ? row.closed_on : null,
      createdAt: String(row.created_at),
      updatedAt: now,
    });
    await this.persist();
    return this.#round()!;
  }

  async targetInvestor(id: string, target: boolean): Promise<AppBootstrap> {
    const round = this.#roundRow();
    if (!round) throw new Error('Complete round onboarding first');
    const existing = this.#vault.one<TargetRow>(
      'SELECT * FROM targets WHERE round_id=? AND firm_id=? AND person_id IS NULL',
      [String(round.id), id],
    );
    if (target) {
      const summary = this.#investors().find((investor) => investor.id === id);
      if (!summary) throw new Error('Investor not found');
      const now = this.#now().toISOString();
      this.#repository.upsertTarget({
        id: existing?.id ?? `target:${randomUUID()}`,
        roundId: String(round.id),
        firmId: id,
        personId: null,
        stage: existing?.stage ?? 'research',
        disposition: existing?.disposition ?? null,
        priority: existing?.priority ?? Math.round(summary.fitScore),
        fitScore: existing?.fit_score ?? summary.fitScore,
        expectedCheckUsd: existing?.expected_check_usd ?? null,
        ownerNote: existing?.owner_note ?? null,
        nextActionAt: existing?.next_action_at ?? null,
        createdAt: existing?.created_at ?? now,
        updatedAt: now,
      });
    } else if (existing) {
      this.#vault.run('DELETE FROM targets WHERE id=?', [existing.id]);
      appendAuditEntry(this.#vault, {
        occurredAt: this.#now().toISOString(),
        actorType: 'founder',
        actorId: 'founder',
        action: 'target.removed',
        entityType: 'target',
        entityId: existing.id,
        detail: { firmId: id, roundId: String(round.id) },
      });
    }
    await this.persist();
    return this.bootstrap();
  }

  async moveInvestor(id: string, stage: PipelineStage): Promise<AppBootstrap> {
    const target = this.#vault.one<TargetRow>(
      'SELECT * FROM targets WHERE firm_id=? AND person_id IS NULL ORDER BY updated_at DESC LIMIT 1',
      [id],
    );
    if (!target) throw new Error('Add this investor to the round before moving it');
    this.#repository.upsertTarget({
      id: target.id,
      roundId: target.round_id,
      firmId: target.firm_id,
      personId: target.person_id,
      stage: UI_TO_DB_STAGE[stage],
      disposition: stage === 'not_now' ? 'not_now' : null,
      priority: target.priority,
      fitScore: target.fit_score,
      expectedCheckUsd: target.expected_check_usd,
      ownerNote:
        stage === 'not_now'
          ? 'Not now'
          : target.disposition === 'not_now' && target.owner_note === 'Not now'
            ? null
            : target.owner_note,
      nextActionAt: target.next_action_at,
      createdAt: target.created_at,
      updatedAt: this.#now().toISOString(),
    });
    await this.persist();
    return this.bootstrap();
  }

  async updateExpectedCheck(
    investorId: string,
    expectedCheckUsd: number | null,
  ): Promise<InvestorSummary> {
    const target = this.#vault.one<TargetRow>(
      'SELECT * FROM targets WHERE firm_id=? AND person_id IS NULL ORDER BY updated_at DESC LIMIT 1',
      [investorId],
    );
    if (!target)
      throw new Error('Add this investor to the round before recording an expected check');
    this.#repository.upsertTarget({
      id: target.id,
      roundId: target.round_id,
      firmId: target.firm_id,
      personId: target.person_id,
      stage: target.stage,
      disposition: target.disposition,
      priority: target.priority,
      fitScore: target.fit_score,
      expectedCheckUsd,
      ownerNote: target.owner_note,
      nextActionAt: target.next_action_at,
      createdAt: target.created_at,
      updatedAt: this.#now().toISOString(),
    });
    await this.persist();
    return this.#investors().find((investor) => investor.id === investorId)!;
  }

  async updateNextAction(
    investorId: string,
    nextAction: string | null,
    nextActionAt: string | null,
  ): Promise<InvestorSummary> {
    const target = this.#vault.one<TargetRow>(
      'SELECT * FROM targets WHERE firm_id=? AND person_id IS NULL ORDER BY updated_at DESC LIMIT 1',
      [investorId],
    );
    if (!target) throw new Error('Add this investor to the round before setting a next action');
    this.#repository.upsertTarget({
      id: target.id,
      roundId: target.round_id,
      firmId: target.firm_id,
      personId: target.person_id,
      stage: target.stage,
      disposition: target.disposition,
      priority: target.priority,
      fitScore: target.fit_score,
      expectedCheckUsd: target.expected_check_usd,
      ownerNote: nextAction,
      nextActionAt,
      createdAt: target.created_at,
      updatedAt: this.#now().toISOString(),
    });
    await this.persist();
    return this.#investors().find((investor) => investor.id === investorId)!;
  }

  async addPersonContact(input: {
    personId: string;
    kind: 'work_email' | 'personal_email' | 'linkedin' | 'x';
    value: string;
    visibility: 'private' | 'public';
    sourceUrl?: string;
    contributionEligible: boolean;
  }): Promise<PersonSummary> {
    if (
      input.kind === 'personal_email' &&
      (input.visibility !== 'private' ||
        input.contributionEligible ||
        input.sourceUrl !== undefined)
    ) {
      throw new Error('Individual email is local-private and cannot be contribution eligible');
    }
    if (
      input.contributionEligible &&
      (input.kind !== 'work_email' || input.visibility !== 'public' || !input.sourceUrl)
    ) {
      throw new Error('Only a sourced public work email can be contribution eligible');
    }
    const now = this.#now().toISOString();
    let sourceId: string | null = null;
    if (input.visibility === 'public') {
      if (!input.sourceUrl) throw new Error('A public contact requires an attributable source URL');
      const existing = this.#vault.one<{ id: string }>(
        'SELECT id FROM sources WHERE canonical_url=?',
        [input.sourceUrl],
      );
      sourceId =
        existing?.id ??
        `source:${createHash('sha256').update(input.sourceUrl).digest('hex').slice(0, 24)}`;
      this.#repository.upsertSource({
        id: sourceId,
        canonicalUrl: input.sourceUrl,
        title: 'Public professional contact source',
        publisher: new URL(input.sourceUrl).hostname,
        sourceType: 'web',
        retrievedAt: now,
        publishedOn: null,
        rightsClass: 'factual_contact',
        redistributionStatus: 'attribution_required',
        attribution: input.sourceUrl,
        excerpt: null,
        createdAt: now,
        updatedAt: now,
      });
    }
    const contactId = `contact:${createHash('sha256').update(`${input.personId}:${input.kind}:${input.value.toLowerCase()}`).digest('hex').slice(0, 24)}`;
    // Editing a contact kind establishes one deterministic canonical value while
    // retaining older observations for provenance and mailbox reconciliation.
    this.#vault.run('UPDATE contact_methods SET is_primary=0 WHERE person_id=? AND kind=?', [
      input.personId,
      input.kind,
    ]);
    this.#repository.upsertContactMethod({
      id: contactId,
      personId: input.personId,
      kind: input.kind,
      value: input.value,
      label:
        input.kind === 'personal_email' ? 'Founder private individual email' : 'Founder reviewed',
      sourceId,
      visibility: input.visibility,
      contributionEligible: input.contributionEligible,
      isPrimary: true,
      createdAt: now,
      updatedAt: now,
    });
    if (input.kind === 'work_email' || input.kind === 'personal_email') {
      const normalizedEmail = input.value.trim().toLowerCase();
      const directMatches = this.#vault.all<{
        id: string;
        provider: string;
        provider_thread_id: string | null;
      }>(
        `SELECT id,provider,provider_thread_id FROM mail_events
         WHERE person_id IS NULL AND (
           (direction='outbound' AND EXISTS (
             SELECT 1 FROM json_each(mail_events.recipient_addresses_json)
             WHERE lower(json_extract(value,'$.email'))=?
           )) OR (direction='inbound' AND lower(sender_address)=?)
         )`,
        [normalizedEmail, normalizedEmail],
      );
      if (directMatches.length > 0) {
        const ids = new Set(directMatches.map((match) => match.id));
        for (const match of directMatches) {
          if (!match.provider_thread_id) continue;
          for (const threaded of this.#vault.all<{ id: string }>(
            'SELECT id FROM mail_events WHERE person_id IS NULL AND provider=? AND provider_thread_id=?',
            [match.provider, match.provider_thread_id],
          )) {
            ids.add(threaded.id);
          }
        }
        for (const eventId of ids) {
          this.#vault.run('UPDATE mail_events SET person_id=? WHERE id=? AND person_id IS NULL', [
            input.personId,
            eventId,
          ]);
        }
        appendAuditEntry(this.#vault, {
          occurredAt: now,
          actorType: 'system',
          action: 'mail.observations_reconciled_to_contact',
          entityType: 'person',
          entityId: input.personId,
          detail: { matchedEventCount: ids.size },
        });
      }
    }
    if (input.contributionEligible) {
      this.#vault.run(
        'UPDATE people SET is_public=1,contribution_eligible=1,updated_at=? WHERE id=?',
        [now, input.personId],
      );
      this.#vault.run(
        'UPDATE firms SET is_public=1,contribution_eligible=1,updated_at=? WHERE id=(SELECT firm_id FROM people WHERE id=?)',
        [now, input.personId],
      );
    }
    await this.persist();
    const person = this.#allPeople().find((item) => item.id === input.personId);
    if (!person) throw new Error('Person not found');
    return person;
  }

  async createTask(input: Omit<TaskItem, 'id' | 'createdAt'>): Promise<TaskItem> {
    const now = this.#now().toISOString();
    const id = this.#vault.transaction(() => this.#createTaskRecord(input, now));
    await this.persist();
    return this.#tasks().find((task) => task.id === id)!;
  }

  #createTaskRecord(
    input: Omit<TaskItem, 'id' | 'createdAt'>,
    now: string,
    id = `task:${randomUUID()}`,
  ): string {
    const round = this.#roundRow();
    let targetId: string | null = null;
    if (input.personId) {
      if (!round) throw new Error('Complete round onboarding before assigning a person task');
      const person = this.#vault.one<{ firm_id: string | null }>(
        'SELECT firm_id FROM people WHERE id=?',
        [input.personId],
      );
      if (!person) throw new Error('Task person does not exist');
      if (input.investorId && input.investorId !== person.firm_id) {
        throw new Error('Task person does not belong to the selected investor');
      }
      const existing = this.#vault.one<TargetRow>(
        'SELECT * FROM targets WHERE round_id=? AND person_id=? ORDER BY updated_at DESC LIMIT 1',
        [String(round.id), input.personId],
      );
      if (existing) {
        targetId = existing.id;
      } else {
        const firmId = input.investorId ?? person.firm_id;
        const firmTarget = firmId
          ? this.#vault.one<TargetRow>(
              'SELECT * FROM targets WHERE round_id=? AND firm_id=? AND person_id IS NULL ORDER BY updated_at DESC LIMIT 1',
              [String(round.id), firmId],
            )
          : null;
        targetId = `target:person:${randomUUID()}`;
        this.#repository.upsertTarget({
          id: targetId,
          roundId: String(round.id),
          firmId,
          personId: input.personId,
          stage: firmTarget?.stage ?? 'research',
          disposition: firmTarget?.disposition ?? null,
          priority: firmTarget?.priority ?? 50,
          fitScore: firmTarget?.fit_score ?? null,
          expectedCheckUsd: null,
          ownerNote: null,
          nextActionAt: input.dueAt,
          createdAt: now,
          updatedAt: now,
        });
      }
    } else if (input.investorId) {
      const value = this.#vault.scalar(
        'SELECT id FROM targets WHERE firm_id=? AND person_id IS NULL ORDER BY updated_at DESC LIMIT 1',
        [input.investorId],
      );
      targetId = typeof value === 'string' ? value : null;
    }
    this.#repository.upsertTask({
      id,
      roundId: round ? String(round.id) : null,
      targetId,
      title: input.title,
      description: input.notes,
      dueAt: input.dueAt,
      status: input.status === 'dismissed' ? 'cancelled' : input.status,
      createdAt: now,
      updatedAt: now,
    });
    return id;
  }

  async updateTask(input: {
    id: string;
    status?: TaskItem['status'];
    title?: string;
    dueAt?: string | null;
  }): Promise<TaskItem> {
    const row = this.#vault.one<Record<string, unknown>>('SELECT * FROM tasks WHERE id=?', [
      input.id,
    ]);
    if (!row) throw new Error('Task not found');
    this.#repository.upsertTask({
      id: input.id,
      roundId: typeof row.round_id === 'string' ? row.round_id : null,
      targetId: typeof row.target_id === 'string' ? row.target_id : null,
      title: input.title ?? String(row.title),
      description: typeof row.description === 'string' ? row.description : null,
      dueAt:
        input.dueAt === undefined
          ? typeof row.due_at === 'string'
            ? row.due_at
            : null
          : input.dueAt,
      status:
        input.status === 'dismissed'
          ? 'cancelled'
          : (input.status ?? (row.status as 'open' | 'done' | 'cancelled')),
      createdAt: String(row.created_at),
      updatedAt: this.#now().toISOString(),
    });
    await this.persist();
    return this.#tasks().find((task) => task.id === input.id)!;
  }

  #meetingTargetId(investorId: string | null): string | null {
    if (!investorId) return null;
    const round = this.#roundRow();
    if (!round) throw new Error('Complete round onboarding before linking an investor meeting');
    const existing = this.#vault.one<TargetRow>(
      'SELECT * FROM targets WHERE round_id=? AND firm_id=? AND person_id IS NULL ORDER BY updated_at DESC LIMIT 1',
      [String(round.id), investorId],
    );
    if (existing) return existing.id;
    const summary = this.#investors().find((investor) => investor.id === investorId);
    if (!summary) throw new Error('Meeting investor does not exist');
    const now = this.#now().toISOString();
    const targetId = `target:${randomUUID()}`;
    this.#repository.upsertTarget({
      id: targetId,
      roundId: String(round.id),
      firmId: investorId,
      personId: null,
      stage: 'research',
      disposition: null,
      priority: Math.round(summary.fitScore),
      fitScore: summary.fitScore,
      expectedCheckUsd: null,
      ownerNote: null,
      nextActionAt: null,
      createdAt: now,
      updatedAt: now,
    });
    return targetId;
  }

  async createMeeting(input: Omit<MeetingItem, 'id'>): Promise<MeetingItem> {
    const now = this.#now().toISOString();
    const id = `meeting:${randomUUID()}`;
    const round = this.#roundRow();
    const targetId = this.#meetingTargetId(input.investorId);
    const attendees = this.calendarAttendees(input.personIds);
    this.#repository.upsertMeeting({
      id,
      roundId: round ? String(round.id) : null,
      targetId,
      externalCalendarId: null,
      title: input.title,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      location: input.location,
      attendees,
      agenda: input.agenda,
      notes: input.notes,
      status: input.status === 'cancelled' ? 'cancelled' : 'confirmed',
      createdAt: now,
      updatedAt: now,
    });
    await this.persist();
    return this.#meetings().find((meeting) => meeting.id === id)!;
  }

  async updateMeeting(input: {
    id: string;
    agenda: string | null;
    notes: string | null;
    investorId?: string | null;
    personIds?: string[];
  }): Promise<MeetingItem> {
    const row = this.#vault.one<Record<string, unknown>>('SELECT * FROM meetings WHERE id=?', [
      input.id,
    ]);
    if (!row) throw new Error('Meeting not found');
    const attendees =
      input.personIds === undefined
        ? (JSON.parse(sqlText(row.attendee_json, '[]')) as Array<{
            name: string | null;
            email: string;
            personId?: string;
          }>)
        : this.calendarAttendees(input.personIds);
    this.#repository.upsertMeeting({
      id: input.id,
      roundId: typeof row.round_id === 'string' ? row.round_id : null,
      targetId:
        input.investorId === undefined
          ? typeof row.target_id === 'string'
            ? row.target_id
            : null
          : this.#meetingTargetId(input.investorId),
      externalCalendarId:
        typeof row.external_calendar_id === 'string' ? row.external_calendar_id : null,
      title: sqlText(row.title),
      startsAt: sqlText(row.starts_at),
      endsAt: sqlText(row.ends_at),
      location: typeof row.location === 'string' ? row.location : null,
      attendees,
      agenda: input.agenda,
      notes: input.notes,
      status:
        row.status === 'cancelled'
          ? 'cancelled'
          : row.status === 'tentative'
            ? 'tentative'
            : 'confirmed',
      createdAt: sqlText(row.created_at),
      updatedAt: this.#now().toISOString(),
    });
    await this.persist();
    return this.#meetings().find((meeting) => meeting.id === input.id)!;
  }

  calendarAttendees(
    personIds: readonly string[],
  ): Array<{ personId: string; name: string | null; email: string }> {
    if (new Set(personIds).size !== personIds.length) {
      throw new Error('Each meeting attendee may be selected only once');
    }
    const normalizedEmails = new Set<string>();
    return personIds.map((personId) => {
      const person = this.#vault.one<{ full_name: string; value: string }>(
        "SELECT p.full_name,c.value FROM people p JOIN contact_methods c ON c.person_id=p.id AND c.kind IN ('work_email','personal_email') WHERE p.id=? ORDER BY c.is_primary DESC,c.updated_at DESC LIMIT 1",
        [personId],
      );
      if (!person) throw new Error(`Meeting attendee ${personId} needs a valid email address`);
      const parsedEmail = z.string().trim().email().max(320).safeParse(person.value);
      if (!parsedEmail.success) {
        throw new Error(`Meeting attendee ${personId} needs a valid email address`);
      }
      const email = parsedEmail.data.toLowerCase();
      if (normalizedEmails.has(email)) {
        throw new Error(`The attendee email ${email} is linked to more than one selected person`);
      }
      normalizedEmails.add(email);
      return { personId, name: person.full_name, email };
    });
  }

  async importCalendarEvents(
    provider: 'google' | 'microsoft',
    events: readonly CalendarEvent[],
  ): Promise<AppBootstrap> {
    const now = this.#now().toISOString();
    const round = this.#roundRow();
    this.#vault.run('SAVEPOINT outreachr_calendar_import');
    try {
      for (const event of events) {
        if (!event.id) continue;
        const externalCalendarId = `${provider}:${event.id}`;
        const existing = this.#vault.one<Record<string, unknown>>(
          'SELECT * FROM meetings WHERE external_calendar_id=?',
          [externalCalendarId],
        );
        const existingAttendees = JSON.parse(sqlText(existing?.attendee_json, '[]')) as Array<{
          personId?: unknown;
          email?: unknown;
        }>;
        const existingPersonIdsByEmail = new Map(
          existingAttendees.flatMap((attendee) =>
            typeof attendee.personId === 'string' && typeof attendee.email === 'string'
              ? [[attendee.email.trim().toLowerCase(), attendee.personId] as const]
              : [],
          ),
        );
        const attendees = (event.attendees ?? [])
          .filter((attendee) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(attendee.email))
          .map((attendee) => {
            const email = attendee.email.trim().toLowerCase();
            const inferredPersonId = this.#vault.scalar(
              "SELECT person_id FROM contact_methods WHERE kind LIKE '%email' AND normalized_value=? ORDER BY is_primary DESC,updated_at DESC LIMIT 1",
              [email],
            );
            const personId =
              existingPersonIdsByEmail.get(email) ??
              (typeof inferredPersonId === 'string' ? inferredPersonId : null);
            return {
              name: attendee.name ?? null,
              email,
              ...(personId ? { personId } : {}),
            };
          });
        let targetId = typeof existing?.target_id === 'string' ? existing.target_id : null;
        if (!targetId && round) {
          for (const attendee of attendees) {
            const candidate = this.#vault.scalar(
              `SELECT t.id FROM contact_methods c JOIN people p ON p.id=c.person_id JOIN targets t ON t.round_id=? AND (t.person_id=p.id OR t.firm_id=p.firm_id)
            WHERE c.kind LIKE '%email' AND c.normalized_value=lower(?) ORDER BY CASE WHEN t.person_id=p.id THEN 0 ELSE 1 END,t.updated_at DESC LIMIT 1`,
              [String(round.id), attendee.email],
            );
            if (typeof candidate === 'string') {
              targetId = candidate;
              break;
            }
          }
        }
        const startsAt = event.start.dateTime ?? `${event.start.date}T00:00:00.000Z`;
        const endsAt = event.end.dateTime ?? `${event.end.date}T00:00:00.000Z`;
        this.#repository.upsertMeeting({
          id:
            typeof existing?.id === 'string'
              ? existing.id
              : `meeting:${provider}:${createHash('sha256').update(event.id).digest('hex').slice(0, 24)}`,
          roundId:
            typeof existing?.round_id === 'string'
              ? existing.round_id
              : round
                ? String(round.id)
                : null,
          targetId,
          externalCalendarId,
          title: event.title,
          startsAt,
          endsAt,
          location: event.location ?? null,
          attendees,
          agenda:
            typeof existing?.agenda === 'string' ? existing.agenda : (event.description ?? null),
          notes: typeof existing?.notes === 'string' ? existing.notes : null,
          status:
            event.status === 'cancelled'
              ? 'cancelled'
              : event.status === 'tentative'
                ? 'tentative'
                : 'confirmed',
          createdAt: typeof existing?.created_at === 'string' ? existing.created_at : now,
          updatedAt: now,
        });
      }
      this.#vault.run('RELEASE SAVEPOINT outreachr_calendar_import');
    } catch (error) {
      this.#vault.run('ROLLBACK TO SAVEPOINT outreachr_calendar_import');
      this.#vault.run('RELEASE SAVEPOINT outreachr_calendar_import');
      throw error;
    }
    await this.persist();
    return this.bootstrap();
  }

  async importMailboxMessages(
    provider: 'google' | 'microsoft',
    accountEmail: string,
    messages: readonly MailboxMessage[],
  ): Promise<AppBootstrap>;
  async importMailboxMessages(
    provider: 'google' | 'microsoft',
    accountEmail: string,
    messages: readonly MailboxMessage[],
    options: { skipBootstrap: true },
  ): Promise<void>;
  async importMailboxMessages(
    provider: 'google' | 'microsoft',
    accountEmail: string,
    messages: readonly MailboxMessage[],
    options?: { skipBootstrap: true },
  ): Promise<AppBootstrap | void> {
    const now = this.#now().toISOString();
    const account = accountEmail.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(account)) {
      throw new Error('The connected mailbox account does not contain a valid email address');
    }

    this.#vault.run('SAVEPOINT outreachr_mail_import');
    try {
      for (const message of messages) {
        if (
          message.provider !== provider ||
          !message.id ||
          !Number.isFinite(Date.parse(message.occurredAt))
        ) {
          continue;
        }
        const sender = message.from.email.trim().toLowerCase();
        const recipients = [...message.to, ...(message.cc ?? [])]
          .map((recipient) => ({
            email: recipient.email.trim().toLowerCase(),
            ...(recipient.name?.trim() ? { name: recipient.name.trim() } : {}),
          }))
          .filter((recipient) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(recipient.email));
        const existingEvent = this.#vault.one<{ direction: 'inbound' | 'outbound' }>(
          'SELECT direction FROM mail_events WHERE provider=? AND provider_message_id=?',
          [provider, message.id],
        );
        // Only provider context is authoritative for outbound. In particular,
        // a send-as alias need not equal the connected mailbox account.
        const direction =
          message.direction ??
          (existingEvent?.direction === 'outbound'
            ? 'outbound'
            : provider === 'google' && sender === account
              ? 'outbound'
              : 'inbound');
        const candidateEmails =
          direction === 'inbound'
            ? [sender]
            : recipients.map((recipient) => recipient.email).filter((email) => email !== account);
        let personId: string | null = null;
        for (const email of candidateEmails) {
          const candidate = this.#vault.scalar(
            "SELECT person_id FROM contact_methods WHERE kind LIKE '%email' AND normalized_value=lower(?) ORDER BY is_primary DESC,updated_at DESC LIMIT 1",
            [email],
          );
          if (typeof candidate === 'string') {
            personId = candidate;
            break;
          }
        }
        if (!personId && message.threadId) {
          const candidate = this.#vault.scalar(
            'SELECT person_id FROM mail_events WHERE provider=? AND provider_thread_id=? AND person_id IS NOT NULL ORDER BY occurred_at DESC LIMIT 1',
            [provider, message.threadId],
          );
          if (typeof candidate === 'string') personId = candidate;
        }
        if (message.direction === 'outbound' && message.operationKey) {
          this.#repository.reconcileUnconfirmedSendFromMailbox({
            operationKey: message.operationKey,
            provider,
            providerMessageId: message.id,
            providerThreadId: message.threadId ?? null,
            recipientAddresses: recipients.map((recipient) => recipient.email),
            subject: message.subject,
            occurredAt: message.occurredAt,
            reconciledAt: now,
          });
        }
        // Preserve unmatched outbound header observations for lifetime send
        // safety. Unrelated inbound mail remains outside the Outreachr vault.
        if (!personId && direction !== 'outbound') continue;

        const classifierText = `${sender} ${message.subject}`.toLowerCase();
        const kind: MailEventItem['kind'] =
          direction === 'outbound'
            ? 'message'
            : /\b(?:unsubscribe|remove me|stop emailing|stop email|no more emails|do not (?:email|contact)|opt[ -]?out)\b/iu.test(
                  classifierText,
                )
              ? 'unsubscribe'
              : /abuse|complaint|spam report|feedback loop/iu.test(classifierText)
                ? 'complaint'
                : /mailer-daemon|postmaster|delivery (?:status|failure)|undeliver|returned mail|mail delivery/iu.test(
                      classifierText,
                    )
                  ? /(?:5\.1\.[0-9]|5\.2\.1|5\.4\.1|user unknown|unknown user|no such (?:user|mailbox)|mailbox (?:does not exist|disabled)|recipient (?:address )?rejected|permanent (?:error|failure)|hard bounce)/iu.test(
                      classifierText,
                    )
                    ? 'hard_bounce'
                    : 'bounce'
                  : 'reply';
        const id = `mail:${provider}:${createHash('sha256').update(message.id).digest('hex').slice(0, 32)}`;
        const existing = this.#vault.scalar(
          'SELECT 1 FROM mail_events WHERE provider=? AND provider_message_id=?',
          [provider, message.id],
        );
        this.#vault.run(
          `INSERT INTO mail_events(
          id,provider,provider_message_id,provider_thread_id,internet_message_id,person_id,
          direction,kind,sender_address,recipient_addresses_json,subject,occurred_at,
          metadata_json,reviewed_at,created_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?)
        ON CONFLICT(provider,provider_message_id) DO UPDATE SET
          provider_thread_id=COALESCE(excluded.provider_thread_id,mail_events.provider_thread_id),
          internet_message_id=COALESCE(excluded.internet_message_id,mail_events.internet_message_id),
          person_id=COALESCE(mail_events.person_id,excluded.person_id),
          direction=excluded.direction,kind=excluded.kind,sender_address=excluded.sender_address,
          recipient_addresses_json=excluded.recipient_addresses_json,subject=excluded.subject,
          occurred_at=excluded.occurred_at,metadata_json=excluded.metadata_json`,
          [
            id,
            provider,
            message.id,
            message.threadId ?? null,
            message.internetMessageId ?? null,
            personId,
            direction,
            kind,
            sender,
            JSON.stringify(recipients),
            message.subject,
            message.occurredAt,
            JSON.stringify({
              labels: message.labels ?? [],
              accountEmail: account,
              directionAuthoritative: message.direction !== undefined,
            }),
            now,
          ],
        );
        if (!existing) {
          appendAuditEntry(this.#vault, {
            occurredAt: now,
            actorType: 'connector',
            action: 'mail.relationship_event_imported',
            entityType: 'mail_event',
            entityId: id,
            detail: { provider, direction, kind, personId, occurredAt: message.occurredAt },
          });
        }
        if (message.threadId) {
          this.#vault.run(
            `UPDATE send_ledger SET provider_thread_id=COALESCE(provider_thread_id,?)
           WHERE id=(SELECT id FROM send_ledger WHERE provider=? AND recipient_person_id=?
             ORDER BY reserved_at DESC LIMIT 1)`,
            [message.threadId, provider, personId],
          );
        }
      }
      this.#vault.run('RELEASE SAVEPOINT outreachr_mail_import');
    } catch (error) {
      this.#vault.run('ROLLBACK TO SAVEPOINT outreachr_mail_import');
      this.#vault.run('RELEASE SAVEPOINT outreachr_mail_import');
      throw error;
    }
    await this.persist();
    if (options?.skipBootstrap) return;
    return this.bootstrap();
  }

  async reviewMailEvent(id: string): Promise<MailEventItem> {
    const existing = this.#mailEvents().find((event) => event.id === id);
    if (!existing) throw new Error('Mailbox relationship event not found');
    if (!existing.reviewedAt) {
      const now = this.#now().toISOString();
      this.#vault.run('UPDATE mail_events SET reviewed_at=? WHERE id=? AND reviewed_at IS NULL', [
        now,
        id,
      ]);
      appendAuditEntry(this.#vault, {
        occurredAt: now,
        actorType: 'founder',
        action: 'mail.relationship_event_reviewed',
        entityType: 'mail_event',
        entityId: id,
        detail: { kind: existing.kind },
      });
      await this.persist();
    }
    return this.#mailEvents().find((event) => event.id === id)!;
  }

  async updateCommunicationPolicy(input: {
    sendingPaused: boolean;
    dailySendLimit: number;
    hourlySendLimit?: number;
    recipientDomainDailyLimit?: number;
    recipientDomainCooldownMinutes?: number;
    postalAddress?: string | null;
    optOutText?: string;
  }): Promise<AppBootstrap['communicationPolicy']> {
    if (
      !Number.isInteger(input.dailySendLimit) ||
      input.dailySendLimit < 1 ||
      input.dailySendLimit > 50
    ) {
      throw new Error('Daily send limit must be a whole number from 1 to 50');
    }
    const now = this.#now().toISOString();
    const current = this.#repository.communicationSettings();
    this.#repository.updateCommunicationSettings(
      {
        sendingPaused: input.sendingPaused,
        dailySendLimit: input.dailySendLimit,
        hourlySendLimit: input.hourlySendLimit ?? current.hourlySendLimit,
        recipientDomainDailyLimit:
          input.recipientDomainDailyLimit ?? current.recipientDomainDailyLimit,
        recipientDomainCooldownMinutes:
          input.recipientDomainCooldownMinutes ?? current.recipientDomainCooldownMinutes,
        postalAddress:
          input.postalAddress === undefined ? current.postalAddress : input.postalAddress,
        optOutText: input.optOutText ?? current.optOutText,
      },
      now,
    );
    await this.persist();
    return this.#communicationPolicy();
  }

  async addSuppression(input: {
    scope: SuppressionItem['scope'];
    value: string;
    reason: string;
  }): Promise<SuppressionItem> {
    const now = this.#now().toISOString();
    const id = `suppression:${randomUUID()}`;
    this.#repository.addSuppression({
      id,
      scope: input.scope,
      value: input.value,
      reason: input.reason,
      source: 'founder',
      active: true,
      createdAt: now,
      updatedAt: now,
    });
    await this.persist();
    const normalized =
      input.scope === 'email'
        ? input.value.trim().toLowerCase()
        : input.scope === 'domain'
          ? input.value.trim().toLowerCase().replace(/^@/u, '')
          : input.value.trim();
    const storedId = this.#vault.scalar(
      'SELECT id FROM suppressions WHERE scope=? AND normalized_value=?',
      [input.scope, normalized],
    );
    const result = this.#suppressions().find((item) => item.id === storedId);
    if (!result) throw new Error('Suppression could not be stored');
    return result;
  }

  async removeSuppression(id: string): Promise<SuppressionItem> {
    const row = this.#vault.one<Record<string, unknown>>('SELECT * FROM suppressions WHERE id=?', [
      id,
    ]);
    if (!row) throw new Error('Suppression not found');
    if (['unsubscribe', 'bounce', 'complaint'].includes(String(row.source))) {
      throw new Error(
        'Automatic unsubscribe, complaint, and hard-bounce suppressions cannot be deactivated',
      );
    }
    const now = this.#now().toISOString();
    this.#repository.addSuppression({
      id,
      scope: String(row.scope) as SuppressionItem['scope'],
      value: String(row.value),
      reason: String(row.reason),
      source: 'founder',
      active: false,
      createdAt: String(row.created_at),
      updatedAt: now,
    });
    await this.persist();
    return this.#suppressions().find((item) => item.id === id)!;
  }

  async saveKnowledge(
    input: Omit<KnowledgeItem, 'id' | 'updatedAt'> & { id?: string },
  ): Promise<KnowledgeItem> {
    const now = this.#now().toISOString();
    const id = input.id ?? `knowledge:${randomUUID()}`;
    const existing = this.#vault.one<{ created_at: string }>(
      'SELECT created_at FROM knowledge_items WHERE id=?',
      [id],
    );
    this.#repository.upsertKnowledgeItem({
      id,
      kind: input.category,
      title: input.title,
      content: input.content,
      sourceUrl: null,
      sharePolicy: input.sharePolicy,
      createdAt: existing?.created_at ?? now,
      updatedAt: now,
    });
    await this.persist();
    return this.#knowledge().find((item) => item.id === id)!;
  }

  async createList(input: {
    name: string;
    description: string | null;
    memberFirmIds?: string[];
  }): Promise<ListItem> {
    const now = this.#now().toISOString();
    const id = `list:${randomUUID()}`;
    const memberFirmIds = unique(input.memberFirmIds ?? []);
    this.#vault.transaction(() => {
      this.#repository.upsertList({
        id,
        name: input.name,
        description: input.description,
        createdAt: now,
        updatedAt: now,
      });
      memberFirmIds.forEach((firmId, rank) => {
        this.#repository.addListMember(id, 'firm', firmId, now, rank);
      });
      appendAuditEntry(this.#vault, {
        occurredAt: now,
        actorType: 'founder',
        action: 'list.created',
        entityType: 'list',
        entityId: id,
        detail: { memberCount: memberFirmIds.length },
      });
    });
    await this.persist();
    return this.#lists().find((list) => list.id === id)!;
  }

  async updateList(input: {
    id: string;
    name: string;
    description: string | null;
    memberFirmIds: string[];
  }): Promise<ListItem> {
    const existing = this.#vault.one<{ created_at: string }>(
      'SELECT created_at FROM lists WHERE id=?',
      [input.id],
    );
    if (!existing) throw new Error('List not found');
    const now = this.#now().toISOString();
    const memberFirmIds = unique(input.memberFirmIds);
    this.#vault.transaction(() => {
      this.#repository.upsertList({
        id: input.id,
        name: input.name,
        description: input.description,
        createdAt: existing.created_at,
        updatedAt: now,
      });
      this.#vault.run('DELETE FROM list_members WHERE list_id=?', [input.id]);
      memberFirmIds.forEach((firmId, rank) => {
        this.#repository.addListMember(input.id, 'firm', firmId, now, rank);
      });
      appendAuditEntry(this.#vault, {
        occurredAt: now,
        actorType: 'founder',
        action: 'list.updated',
        entityType: 'list',
        entityId: input.id,
        detail: { memberCount: memberFirmIds.length },
      });
    });
    await this.persist();
    return this.#lists().find((list) => list.id === input.id)!;
  }

  async createDraft(input: {
    personId: string;
    provider: 'google' | 'microsoft';
    kind: DraftMessage['kind'];
    subject: string;
    bodyText: string;
    threadId?: string | null;
  }): Promise<DraftMessage> {
    const person = this.#allPeople().find((item) => item.id === input.personId);
    if (!person?.email) throw new Error('A recipient work email is required');
    if (!person.canSendInitial && input.kind === 'initial')
      throw new Error(person.suppressionReason ?? 'Initial outreach is blocked for this person');
    const now = this.#now().toISOString();
    const id = `message:${randomUUID()}`;
    const round = this.#roundRow();
    const connectorAccount = this.#vault.one<{ account_label: string }>(
      "SELECT account_label FROM connector_configs WHERE provider=? AND status='connected' ORDER BY updated_at DESC LIMIT 1",
      [input.provider],
    );
    const founderEmail = this.#vault.scalar(
      'SELECT work_email FROM founder_profiles ORDER BY created_at LIMIT 1',
    );
    const senderAddress = connectorAccount?.account_label ?? founderEmail;
    if (typeof senderAddress !== 'string' || !senderAddress.trim()) {
      throw new Error('Add a founder work email or connect the selected email provider first');
    }
    const targetId = person.firmId
      ? this.#vault.scalar(
          `SELECT id FROM targets
           WHERE person_id=? OR (firm_id=? AND person_id IS NULL)
           ORDER BY CASE WHEN person_id=? THEN 0 ELSE 1 END,updated_at DESC LIMIT 1`,
          [person.id, person.firmId, person.id],
        )
      : null;
    const policy = this.#repository.communicationSettings();
    const founder = this.#vault.one<{ full_name: string; company_name: string }>(
      'SELECT full_name,company_name FROM founder_profiles ORDER BY created_at LIMIT 1',
    );
    const bodyText = policy.postalAddress
      ? appendCommunicationFooter(input.bodyText, {
          founderName: founder?.full_name ?? null,
          companyName: founder?.company_name ?? null,
          postalAddress: policy.postalAddress,
          optOutText: policy.optOutText,
        })
      : input.bodyText;
    this.#repository.createMessageDraft({
      id,
      roundId: round ? String(round.id) : null,
      targetId: typeof targetId === 'string' ? targetId : null,
      recipientPersonId: person.id,
      recipientAddress: person.email,
      provider: input.provider,
      senderAddress,
      messageKind: input.kind,
      providerThreadId: input.threadId ?? null,
      subject: input.subject,
      bodyText,
      attachments: [],
      createdAt: now,
      updatedAt: now,
    });
    appendAuditEntry(this.#vault, {
      occurredAt: now,
      actorType: 'founder',
      action: 'message.provider_selected',
      entityType: 'message',
      entityId: id,
      detail: { provider: input.provider, kind: input.kind },
    });
    await this.persist();
    return this.#drafts(this.#allPeople()).find((draft) => draft.id === id)!;
  }

  async updateDraft(
    id: string,
    values: { subject?: string; bodyText?: string },
  ): Promise<DraftMessage> {
    const row = this.#vault.one<MessageRow>('SELECT * FROM messages WHERE id=?', [id]);
    if (!row) throw new Error('Draft not found');
    const attachments = MessageDraftSchema.shape.attachments.parse(
      JSON.parse(row.attachments_json),
    );
    this.#repository.createMessageDraft({
      id,
      roundId: row.round_id,
      targetId: row.target_id,
      recipientPersonId: row.recipient_person_id,
      recipientAddress: row.recipient_address,
      provider: row.provider,
      senderAddress: row.sender_address,
      messageKind: row.message_kind,
      providerThreadId: row.provider_thread_id,
      subject: values.subject ?? row.subject,
      bodyText: values.bodyText ?? row.body_text,
      attachments,
      createdAt: row.created_at,
      updatedAt: this.#now().toISOString(),
    });
    await this.persist();
    return this.#drafts(this.#allPeople()).find((draft) => draft.id === id)!;
  }

  async approveDraft(id: string, expectedContentHash: string): Promise<DraftMessage> {
    const current = this.#drafts(this.#allPeople()).find((draft) => draft.id === id);
    if (!current || current.contentHash !== expectedContentHash)
      throw new Error('Draft changed before approval');
    if (!current.canApprove) {
      throw new Error(
        current.approvalBlockReasons[0] ?? 'This draft is not ready for founder approval',
      );
    }
    const person = this.#allPeople().find((item) => item.id === current.personId);
    if (current.kind === 'initial' && !person?.canSendInitial) {
      throw new Error(person?.suppressionReason ?? 'Initial outreach is blocked for this person');
    }
    this.#repository.approveMessage(id, this.#now().toISOString());
    await this.persist();
    return this.#drafts(this.#allPeople()).find((draft) => draft.id === id)!;
  }

  async exportBackup(directory: string, password: string): Promise<string> {
    const now = this.#now().toISOString();
    const output = await writeTimestampedPrivateExport(
      directory,
      'Outreachr',
      now,
      '.outreachr-backup',
      await createEncryptedBackup(this.#vault.export(), password),
    );
    appendAuditEntry(this.#vault, {
      occurredAt: now,
      actorType: 'founder',
      actorId: 'founder',
      action: 'backup.exported',
      entityType: 'vault',
      entityId: 'local',
      detail: { encrypted: true, format: 'outreachr-encrypted-backup' },
    });
    await this.persist();
    return output;
  }

  async restoreBackup(path: string, password: string): Promise<AppBootstrap> {
    const encryptedBytes = await readBoundedFile(path, MAX_VAULT_OR_BACKUP_BYTES, 'Backup');
    const bytes = await restoreEncryptedBackup(encryptedBytes, password);
    const packagedWasmPath = join(this.#options.resourceDirectory, 'sql-wasm.wasm');
    let wasmPath: string | undefined;
    try {
      await access(packagedWasmPath);
      wasmPath = packagedWasmPath;
    } catch {
      // Development resolves the direct sql.js dependency.
    }
    const replacement = await openNodeVault({ bytes, ...(wasmPath ? { wasmPath } : {}) });
    try {
      const check = replacement.integrityCheck();
      if (!check.ok) {
        throw new Error(`Backup SQLite integrity failed: ${check.messages.join('; ')}`);
      }
      await assertExpectedVaultSchema(replacement, wasmPath);
      const audit = verifyAuditChain(replacement);
      if (!audit.ok) {
        throw new Error(
          `Backup audit chain verification failed at sequence ${audit.errorAt ?? 'unknown'}`,
        );
      }
    } catch (error) {
      replacement.close();
      throw error;
    }
    this.#vault.close();
    this.#vault = replacement;
    this.#repository = new OutreachrRepository(this.#vault);
    appendAuditEntry(this.#vault, {
      occurredAt: this.#now().toISOString(),
      actorType: 'founder',
      actorId: 'founder',
      action: 'backup.restored',
      entityType: 'vault',
      entityId: 'local',
      detail: { encrypted: true, integrityCheck: 'passed' },
    });
    await this.persist();
    return this.bootstrap();
  }

  async exportContribution(directory: string): Promise<{ databasePath: string; diffPath: string }> {
    const result = exportContribution(this.#vault.sqlite, this.#vault, {
      packageId: `outreachr-contribution:${randomUUID()}`,
      packageVersion: this.#options.appVersion,
      createdAt: this.#now().toISOString(),
      contributor: null,
      // A contribution carries source-specific rights metadata and does not
      // relicense upstream facts as the application's Apache-2.0 code.
      licenseSpdx: 'NOASSERTION',
    });
    const databasePath = join(
      directory,
      `Outreachr-Contribution-${result.logicalDigestSha256.slice(0, 12)}.sqlite`,
    );
    const diffPath = join(
      directory,
      `Outreachr-Contribution-${result.logicalDigestSha256.slice(0, 12)}.json`,
    );
    let databaseCreated = false;
    try {
      await writeFile(databasePath, result.bytes, { flag: 'wx', mode: 0o600 });
      databaseCreated = true;
      await writeFile(
        diffPath,
        `${JSON.stringify({ logicalDigestSha256: result.logicalDigestSha256, counts: result.counts, privacy: 'Public allowlist only; no founder activity or communication history.' }, null, 2)}\n`,
        { encoding: 'utf8', flag: 'wx', mode: 0o600 },
      );
    } catch (error) {
      if (databaseCreated) {
        try {
          await unlink(databasePath);
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            'Contribution export failed and its partial database could not be removed',
            { cause: cleanupError },
          );
        }
      }
      throw error;
    }
    appendAuditEntry(this.#vault, {
      occurredAt: this.#now().toISOString(),
      actorType: 'founder',
      actorId: 'founder',
      action: 'contribution.exported',
      entityType: 'contribution',
      entityId: result.logicalDigestSha256,
      detail: { logicalDigestSha256: result.logicalDigestSha256, counts: result.counts },
    });
    await this.persist();
    return { databasePath, diffPath };
  }

  async exportCsv(
    directory: string,
    kind: 'investors' | 'people' | 'pipeline' | 'activity',
  ): Promise<string> {
    const bootstrap = await this.bootstrap();
    let headers: string[];
    let rows: unknown[][];
    if (kind === 'people') {
      headers = [
        'id',
        'name',
        'firm',
        'title',
        'work_email',
        'individual_email',
        'linkedin',
        'x',
        'contacted',
      ];
      rows = bootstrap.people.map((person) => [
        person.id,
        person.name,
        person.firmName,
        person.title,
        person.workEmail,
        person.personalEmail,
        person.linkedinUrl,
        person.xUrl,
        person.contacted,
      ]);
    } else if (kind === 'pipeline') {
      headers = ['id', 'name', 'stage', 'fit_score', 'next_action', 'next_action_at'];
      rows = bootstrap.investors
        .filter((investor) => investor.target)
        .map((investor) => [
          investor.id,
          investor.name,
          investor.pipelineStage,
          investor.fitScore,
          investor.nextAction,
          investor.nextActionAt,
        ]);
    } else if (kind === 'activity') {
      const auditIntegrity = this.auditIntegrity();
      if (!auditIntegrity.ok) {
        throw new Error(
          `Audit chain verification failed at sequence ${auditIntegrity.errorAt ?? 'unknown'}`,
        );
      }
      headers = [
        'sequence',
        'occurred_at',
        'actor',
        'action',
        'entity_type',
        'entity_id',
        'detail_json',
        'previous_hash',
        'entry_hash',
      ];
      rows = this.#vault
        .all<Record<string, unknown>>(
          `SELECT c.sequence,a.occurred_at,a.actor_type,a.action,a.entity_type,a.entity_id,
          a.detail_json,c.previous_hash,c.entry_hash FROM audit_chain c JOIN audit_log a ON a.id=c.audit_id
          ORDER BY c.sequence DESC`,
        )
        .map((row) => [
          row.sequence,
          row.occurred_at,
          row.actor_type,
          row.action,
          row.entity_type,
          row.entity_id,
          row.detail_json,
          row.previous_hash,
          row.entry_hash,
        ]);
    } else {
      headers = [
        'id',
        'name',
        'type',
        'headquarters',
        'stages',
        'sectors',
        'check_minimum',
        'check_maximum',
        'fit_score',
        'source_count',
      ];
      rows = bootstrap.investors.map((investor) => [
        investor.id,
        investor.name,
        investor.kind,
        investor.headquarters,
        investor.stages.join('|'),
        investor.sectors.join('|'),
        investor.check.minimum,
        investor.check.maximum,
        investor.fitScore,
        investor.sourceCount,
      ]);
    }
    const output = await writeTimestampedPrivateExport(
      directory,
      `Outreachr-${kind}`,
      this.#now().toISOString(),
      '.csv',
      `${[headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\n')}\n`,
    );
    appendAuditEntry(this.#vault, {
      occurredAt: this.#now().toISOString(),
      actorType: 'founder',
      actorId: 'founder',
      action: 'data.private_csv_exported',
      entityType: 'export',
      entityId: kind,
      detail: { kind, rowCount: rows.length },
    });
    await this.persist();
    return output;
  }

  search(query: string): CommandResultMap['search'] {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return [];
    const matches: Array<{
      id: string;
      kind: 'investor' | 'person' | 'task' | 'meeting' | 'knowledge';
      title: string;
      subtitle: string;
      href: string;
    }> = [];
    for (const investor of this.#investors())
      if (`${investor.name} ${investor.sectors.join(' ')}`.toLowerCase().includes(normalized))
        matches.push({
          id: investor.id,
          kind: 'investor',
          title: investor.name,
          subtitle: `${investor.fitScore} fit · ${investor.sectors.slice(0, 3).join(' · ')}`,
          href: `/investors/${investor.id}`,
        });
    for (const person of this.#allPeople())
      if (`${person.name} ${person.firmName ?? ''}`.toLowerCase().includes(normalized))
        matches.push({
          id: person.id,
          kind: 'person',
          title: person.name,
          subtitle: person.firmName ?? 'Independent investor',
          href: '/investors',
        });
    for (const task of this.#tasks())
      if (task.title.toLowerCase().includes(normalized))
        matches.push({
          id: task.id,
          kind: 'task',
          title: task.title,
          subtitle: task.dueAt ?? 'No due date',
          href: '/tasks',
        });
    for (const meeting of this.#meetings())
      if (meeting.title.toLowerCase().includes(normalized))
        matches.push({
          id: meeting.id,
          kind: 'meeting',
          title: meeting.title,
          subtitle: meeting.startsAt,
          href: '/meetings',
        });
    for (const item of this.#knowledge())
      if (`${item.title} ${item.content}`.toLowerCase().includes(normalized))
        matches.push({
          id: item.id,
          kind: 'knowledge',
          title: item.title,
          subtitle: item.category,
          href: '/knowledge',
        });
    return matches.slice(0, 50);
  }

  async importSeedFile(path: string): Promise<CommandResultMap['data.importSeed']> {
    const importedAt = this.#now().toISOString();
    const result = importInvestorSeed(
      this.#vault.sqlite,
      this.#vault,
      await readBoundedFile(path, MAX_SEED_IMPORT_BYTES, 'Seed'),
      {
        importedAt,
        allowUnsignedResearch: true,
      },
    );
    appendAuditEntry(this.#vault, {
      occurredAt: importedAt,
      actorType: 'founder',
      actorId: 'founder',
      action: result.alreadyImported ? 'seed.import_skipped' : 'seed.imported',
      entityType: 'seed_package',
      entityId: result.packageId,
      detail: {
        packageVersion: result.packageVersion,
        logicalDigestSha256: result.logicalDigestSha256,
        signatureStatus: result.signatureStatus,
        counts: {
          firms: result.firmCount,
          people: result.personCount,
          sources: result.sourceCount,
        },
      },
    });
    await this.persist();
    return {
      imported: result.alreadyImported
        ? 0
        : result.firmCount + result.personCount + result.sourceCount,
      skipped: result.alreadyImported
        ? result.firmCount + result.personCount + result.sourceCount
        : 0,
      updated: 0,
    };
  }

  async agentContext(disclosedContextIds: readonly string[]): Promise<Record<string, unknown>> {
    const allowed = new Set(disclosedContextIds);
    const bootstrap = await this.bootstrap();
    return {
      round: allowed.has('round') ? bootstrap.round : undefined,
      company: allowed.has('company')
        ? bootstrap.knowledge.filter(
            (item) =>
              ['company', 'narrative', 'metrics', 'disclosure'].includes(item.category) &&
              item.sharePolicy === 'safe_for_outreach',
          )
        : undefined,
      investors: allowed.has('investors') ? bootstrap.investors : undefined,
      people: allowed.has('investors')
        ? bootstrap.people.map((person) => ({
            ...person,
            email: null,
            workEmail: null,
            personalEmail: null,
          }))
        : undefined,
      activity: allowed.has('activity')
        ? {
            tasks: bootstrap.tasks,
            meetings: bootstrap.meetings,
            drafts: bootstrap.drafts,
            mailEvents: bootstrap.mailEvents,
            agentProposals: bootstrap.agentProposals,
          }
        : undefined,
      disclosure: [...allowed],
    };
  }

  async setAgentContextGrant(input: {
    provider: 'codex' | 'claude';
    contextClass: AgentContextGrant['contextClass'];
    granted: boolean;
  }): Promise<AgentContextGrant[]> {
    const now = this.#now().toISOString();
    const id = `agent-grant:${input.provider}:${input.contextClass}`;
    if (input.granted) {
      this.#vault.run(
        `INSERT INTO agent_context_grants(id,provider,context_class,granted_at,revoked_at) VALUES (?,?,?,?,NULL)
        ON CONFLICT(provider,context_class) DO UPDATE SET granted_at=excluded.granted_at,revoked_at=NULL`,
        [id, input.provider, input.contextClass, now],
      );
    } else {
      this.#vault.run(
        'UPDATE agent_context_grants SET revoked_at=? WHERE provider=? AND context_class=? AND revoked_at IS NULL',
        [now, input.provider, input.contextClass],
      );
    }
    appendAuditEntry(this.#vault, {
      occurredAt: now,
      actorType: 'founder',
      action: input.granted ? 'agent.context_grant.created' : 'agent.context_grant.revoked',
      entityType: 'agent_context_grant',
      entityId: id,
      detail: { provider: input.provider, contextClass: input.contextClass },
    });
    await this.persist();
    return this.#vault
      .all<{
        provider: 'codex' | 'claude';
        context_class: AgentContextGrant['contextClass'];
        granted_at: string;
      }>(
        'SELECT provider,context_class,granted_at FROM agent_context_grants WHERE revoked_at IS NULL ORDER BY provider,context_class',
      )
      .map((row) => ({
        provider: row.provider,
        contextClass: row.context_class,
        grantedAt: row.granted_at,
      }));
  }

  async reviewAgentProposal(input: {
    id: string;
    decision: 'apply' | 'reject' | 'convert_to_task';
  }): Promise<AgentProposalReviewResult> {
    const row = this.#vault.one<{
      id: string;
      agent_run_id: string;
      proposal_type: string;
      payload_json: string;
      payload_sha256: string;
      provider: string;
      status: string;
      created_at: string;
    }>(
      `SELECT p.id,p.agent_run_id,p.proposal_type,p.payload_json,p.payload_sha256,
      r.provider,p.status,p.created_at FROM agent_proposals p JOIN agent_runs r ON r.id=p.agent_run_id
      WHERE p.id=?`,
      [input.id],
    );
    if (!row) throw new Error('Agent proposal not found');
    if (row.status !== 'pending') throw new Error('Agent proposal is not pending');
    const now = this.#now().toISOString();

    if (input.decision === 'reject') {
      this.#repository.reviewAgentProposal(input.id, 'rejected', now);
      await this.persist();
      return {
        id: input.id,
        status: 'rejected',
        operation: 'rejected',
        appliedEntityType: null,
        appliedEntityId: null,
      };
    }

    const proposal = this.#agentProposalFromRow(row);
    let appliedEntityType: AgentProposalReviewResult['appliedEntityType'];
    let appliedEntityId: string;
    const appendAppliedAudit = (operation: 'applied' | 'converted_to_task'): void => {
      appendAuditEntry(this.#vault, {
        occurredAt: now,
        actorType: 'founder',
        actorId: 'founder',
        action: 'agent.proposal_applied',
        entityType: 'agent_proposal',
        entityId: proposal.id,
        detail: {
          kind: proposal.kind,
          operation,
          appliedEntityType,
          appliedEntityId,
          agentRunId: proposal.agentRunId,
        },
      });
    };

    if (input.decision === 'convert_to_task') {
      if (proposal.kind !== 'note' && proposal.kind !== 'research') {
        throw new Error('Only note and research proposals can be converted to a task');
      }
      appliedEntityType = 'task';
      appliedEntityId = `task:${randomUUID()}`;
      const round = this.#roundRow();
      this.#vault.transaction(() => {
        this.#repository.upsertTask({
          id: appliedEntityId,
          roundId: round ? String(round.id) : null,
          targetId: null,
          title: proposal.title,
          description: proposal.rationale,
          dueAt: null,
          status: 'open',
          createdAt: now,
          updatedAt: now,
        });
        this.#repository.reviewAgentProposal(proposal.id, 'accepted', now);
        appendAppliedAudit('converted_to_task');
      });
      await this.persist();
      return {
        id: proposal.id,
        status: 'accepted',
        operation: 'converted_to_task',
        appliedEntityType,
        appliedEntityId,
      };
    }

    if (proposal.kind === 'task') {
      const payload = AgentTaskPayloadSchema.parse(proposal.payload);
      if (proposal.investorId && payload.investorId && proposal.investorId !== payload.investorId) {
        throw new Error('Task proposal investor references do not match');
      }
      const investorId = payload.investorId ?? proposal.investorId;
      const personId = payload.personId ?? null;
      const firmTargetId =
        investorId && !personId
          ? this.#vault.scalar(
              'SELECT id FROM targets WHERE firm_id=? AND person_id IS NULL ORDER BY updated_at DESC LIMIT 1',
              [investorId],
            )
          : null;
      if (investorId && !personId && typeof firmTargetId !== 'string') {
        throw new Error('Add the referenced investor to this round before applying the task');
      }
      appliedEntityType = 'task';
      appliedEntityId = `task:${randomUUID()}`;
      this.#vault.transaction(() => {
        this.#createTaskRecord(
          {
            title: payload.title,
            notes: payload.notes ?? null,
            dueAt: payload.dueAt ?? null,
            status: 'open',
            investorId,
            personId,
          },
          now,
          appliedEntityId,
        );
        this.#repository.reviewAgentProposal(proposal.id, 'accepted', now);
        appendAppliedAudit('applied');
      });
    } else if (proposal.kind === 'draft') {
      const payload = AgentDraftPayloadSchema.parse(proposal.payload);
      const personRow = this.#vault.one<{ firm_id: string | null }>(
        'SELECT firm_id FROM people WHERE id=?',
        [payload.personId],
      );
      if (!personRow) throw new Error('Draft proposal person does not exist');
      if (proposal.investorId && personRow.firm_id !== proposal.investorId) {
        throw new Error('Draft proposal person does not belong to the referenced investor');
      }
      const person = this.#allPeople().find((item) => item.id === payload.personId);
      if (!person?.email) throw new Error('A recipient work email is required');
      if (!person.canSendInitial) {
        throw new Error(person.suppressionReason ?? 'Initial outreach is blocked for this person');
      }
      const connectorAccount = this.#vault.one<{ account_label: string }>(
        "SELECT account_label FROM connector_configs WHERE provider=? AND status='connected' ORDER BY updated_at DESC LIMIT 1",
        [payload.provider],
      );
      const founderEmail = this.#vault.scalar(
        'SELECT work_email FROM founder_profiles ORDER BY created_at LIMIT 1',
      );
      const senderAddress = connectorAccount?.account_label ?? founderEmail;
      if (typeof senderAddress !== 'string' || !senderAddress.trim()) {
        throw new Error('Add a founder work email or connect the selected email provider first');
      }
      const targetId = person.firmId
        ? this.#vault.scalar(
            `SELECT id FROM targets
             WHERE person_id=? OR (firm_id=? AND person_id IS NULL)
             ORDER BY CASE WHEN person_id=? THEN 0 ELSE 1 END,updated_at DESC LIMIT 1`,
            [person.id, person.firmId, person.id],
          )
        : null;
      appliedEntityType = 'message';
      appliedEntityId = `message:${randomUUID()}`;
      const round = this.#roundRow();
      this.#vault.transaction(() => {
        this.#repository.createMessageDraft({
          id: appliedEntityId,
          roundId: round ? String(round.id) : null,
          targetId: typeof targetId === 'string' ? targetId : null,
          recipientPersonId: person.id,
          recipientAddress: person.email!,
          provider: payload.provider,
          senderAddress: String(senderAddress),
          messageKind: 'initial',
          providerThreadId: null,
          subject: payload.subject,
          bodyText: payload.bodyText,
          attachments: [],
          createdAt: now,
          updatedAt: now,
        });
        this.#repository.reviewAgentProposal(proposal.id, 'accepted', now);
        appendAppliedAudit('applied');
      });
    } else if (proposal.kind === 'pipeline_move') {
      const payload = AgentPipelinePayloadSchema.parse(proposal.payload);
      if (proposal.investorId && proposal.investorId !== payload.investorId) {
        throw new Error('Pipeline proposal investor references do not match');
      }
      const target = this.#vault.one<TargetRow>(
        'SELECT * FROM targets WHERE firm_id=? AND person_id IS NULL ORDER BY updated_at DESC LIMIT 1',
        [payload.investorId],
      );
      if (!target) throw new Error('Add this investor to the round before moving it');
      const nextStage = UI_TO_DB_STAGE[payload.stage];
      appliedEntityType = 'target';
      appliedEntityId = target.id;
      this.#vault.transaction(() => {
        this.#vault.run(
          'UPDATE targets SET stage=?,disposition=?,owner_note=?,updated_at=? WHERE id=?',
          [
            nextStage,
            payload.stage === 'not_now' ? 'not_now' : null,
            payload.stage === 'not_now'
              ? 'Not now'
              : target.disposition === 'not_now' && target.owner_note === 'Not now'
                ? null
                : target.owner_note,
            now,
            target.id,
          ],
        );
        if (target.stage !== nextStage) {
          this.#vault.run(
            'INSERT INTO pipeline_events(id,target_id,from_stage,to_stage,reason,occurred_at) VALUES (?,?,?,?,?,?)',
            [randomUUID(), target.id, target.stage, nextStage, 'agent proposal approved', now],
          );
        }
        appendAuditEntry(this.#vault, {
          occurredAt: now,
          actorType: 'founder',
          actorId: 'founder',
          action: 'target.upsert',
          entityType: 'target',
          entityId: target.id,
          detail: { stage: nextStage },
        });
        this.#repository.reviewAgentProposal(proposal.id, 'accepted', now);
        appendAppliedAudit('applied');
      });
    } else {
      throw new Error('This proposal can only be converted to a task');
    }

    await this.persist();
    return {
      id: proposal.id,
      status: 'accepted',
      operation: 'applied',
      appliedEntityType,
      appliedEntityId,
    };
  }

  async reviewSource(id: string, decision: 'accept' | 'reject'): Promise<SourceReviewItem> {
    const claim = this.#vault.one<Record<string, unknown>>(
      `SELECT c.*,COALESCE(f.name,p.full_name,'Unknown') entity_name,s.canonical_url,s.publisher
       FROM claims c
       LEFT JOIN firms f ON c.entity_type='firm' AND f.id=c.entity_id
       LEFT JOIN people p ON c.entity_type='person' AND p.id=c.entity_id
       JOIN sources s ON s.id=c.source_id
       WHERE c.id=? AND c.status IN ('stale','disputed') AND c.review_disposition IS NULL`,
      [id],
    );
    if (!claim) {
      const exists = Number(this.#vault.scalar('SELECT COUNT(*) FROM claims WHERE id=?', [id]));
      throw new Error(
        exists ? 'Source review item is no longer pending' : 'Source review item not found',
      );
    }
    const reviewed = sourceReviewItem(claim);
    const now = this.#now().toISOString();
    this.#vault.transaction(() => {
      this.#vault.run(
        'UPDATE claims SET status=?,review_disposition=?,reviewed_at=?,updated_at=? WHERE id=?',
        [
          decision === 'accept' ? 'verified' : 'disputed',
          decision === 'accept' ? 'accepted' : 'rejected',
          now,
          now,
          id,
        ],
      );
      appendAuditEntry(this.#vault, {
        occurredAt: now,
        actorType: 'founder',
        actorId: 'founder',
        action: 'source.reviewed',
        entityType: 'claim',
        entityId: id,
        detail: { decision },
      });
    });
    await this.persist();
    return {
      ...reviewed,
      source: {
        ...reviewed.source,
        confidence: decision === 'accept' ? 'verified' : 'unknown',
      },
      status: decision === 'accept' ? 'accepted' : 'rejected',
    };
  }
}
