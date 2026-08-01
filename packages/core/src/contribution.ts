import { createHash } from 'node:crypto';
import type { Database, SqlJsStatic, SqlValue } from 'sql.js';
import { z } from 'zod';
import type { CoreVault } from './database.js';
import { stableJson } from './validation.js';

const ContributionOptionsSchema = z.object({
  packageId: z.string().trim().min(1).max(200),
  packageVersion: z.string().trim().min(1).max(100).default('0.1.1'),
  createdAt: z.string().datetime({ offset: true }).optional(),
  contributor: z.string().trim().max(500).nullable().default(null),
  licenseSpdx: z.string().trim().min(1).max(200).default('NOASSERTION'),
});

export type ContributionOptions = z.input<typeof ContributionOptionsSchema>;

export interface ContributionResult {
  readonly bytes: Uint8Array;
  readonly logicalDigestSha256: string;
  readonly createdAt: string;
  readonly counts: Record<string, number>;
}

type SerializableRow = Record<string, SqlValue>;

const CONTRIBUTION_SCHEMA = `
PRAGMA application_id = 1330992204;
PRAGMA user_version = 1;
CREATE TABLE package_manifest(package_id TEXT PRIMARY KEY,package_version TEXT NOT NULL,package_kind TEXT NOT NULL CHECK(package_kind='contribution'),format_version INTEGER NOT NULL,created_at TEXT NOT NULL,contributor TEXT,license_spdx TEXT NOT NULL,logical_digest_sha256 TEXT NOT NULL,privacy_policy TEXT NOT NULL);
CREATE TABLE sources(id TEXT PRIMARY KEY,canonical_url TEXT NOT NULL UNIQUE,title TEXT,publisher TEXT,source_type TEXT NOT NULL,retrieved_at TEXT NOT NULL,published_on TEXT,rights_class TEXT NOT NULL,redistribution_status TEXT NOT NULL,attribution TEXT,excerpt TEXT);
CREATE TABLE firms(id TEXT PRIMARY KEY,name TEXT NOT NULL,website TEXT,investor_type TEXT NOT NULL,headquarters TEXT,description TEXT,updated_at TEXT NOT NULL);
CREATE TABLE people(id TEXT PRIMARY KEY,firm_id TEXT REFERENCES firms(id),full_name TEXT NOT NULL,title TEXT,city TEXT,bio TEXT,is_investor INTEGER NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE funds(id TEXT PRIMARY KEY,firm_id TEXT NOT NULL REFERENCES firms(id),name TEXT NOT NULL,vintage_year INTEGER,size_usd INTEGER,announced_on TEXT,updated_at TEXT NOT NULL);
CREATE TABLE claims(id TEXT PRIMARY KEY,entity_type TEXT NOT NULL,entity_id TEXT NOT NULL,field TEXT NOT NULL,value_json TEXT NOT NULL,source_id TEXT NOT NULL REFERENCES sources(id),confidence REAL,observed_at TEXT,status TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE entity_sources(entity_type TEXT NOT NULL,entity_id TEXT NOT NULL,source_id TEXT NOT NULL REFERENCES sources(id),source_role TEXT NOT NULL,evidence_granularity TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(entity_type,entity_id,source_id,source_role));
CREATE TABLE tags(id TEXT PRIMARY KEY,kind TEXT NOT NULL,value TEXT NOT NULL,normalized_value TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE entity_tags(entity_type TEXT NOT NULL,entity_id TEXT NOT NULL,tag_id TEXT NOT NULL REFERENCES tags(id),source_id TEXT REFERENCES sources(id),created_at TEXT NOT NULL,PRIMARY KEY(entity_type,entity_id,tag_id));
CREATE TABLE public_work_emails(id TEXT PRIMARY KEY,person_id TEXT NOT NULL REFERENCES people(id),work_email TEXT NOT NULL,normalized_email TEXT NOT NULL,source_id TEXT NOT NULL REFERENCES sources(id),label TEXT,updated_at TEXT NOT NULL,UNIQUE(person_id,normalized_email));
`;

function insertRows(db: Database, table: string, rows: SerializableRow[]): void {
  if (!rows.length) return;
  const columns = Object.keys(rows[0]!).sort();
  const statement = db.prepare(
    `INSERT INTO ${table}(${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
  );
  try {
    for (const row of rows) {
      statement.run(columns.map((column) => row[column] ?? null));
    }
  } finally {
    statement.free();
  }
}

function latestTimestamp(vault: CoreVault): string {
  const value = vault.scalar(`SELECT MAX(value) FROM (
    SELECT MAX(updated_at) value FROM firms WHERE is_public=1 AND contribution_eligible=1
    UNION ALL SELECT MAX(updated_at) FROM people WHERE is_public=1 AND contribution_eligible=1
    UNION ALL SELECT MAX(updated_at) FROM funds WHERE is_public=1 AND contribution_eligible=1
    UNION ALL SELECT MAX(updated_at) FROM claims WHERE is_public=1 AND contribution_eligible=1
  )`);
  return typeof value === 'string' && value ? value : '1970-01-01T00:00:00.000Z';
}

function digestPayload(payload: Record<string, SerializableRow[]>): string {
  return createHash('sha256').update(stableJson(payload), 'utf8').digest('hex');
}

export function exportContribution(
  sqlite: SqlJsStatic,
  vault: CoreVault,
  input: ContributionOptions,
): ContributionResult {
  const options = ContributionOptionsSchema.parse(input);
  const createdAt = options.createdAt ?? latestTimestamp(vault);
  const allowedSource = "redistribution_status IN ('allowed','attribution_required')";
  const rows: Record<string, SerializableRow[]> = {};

  rows.sources =
    vault.all(`SELECT id,canonical_url,title,publisher,source_type,retrieved_at,published_on,rights_class,redistribution_status,attribution,excerpt
    FROM sources WHERE ${allowedSource} AND id IN (
      SELECT source_id FROM claims WHERE is_public=1 AND contribution_eligible=1 AND source_id IS NOT NULL
      UNION SELECT source_id FROM contact_methods WHERE visibility='public' AND contribution_eligible=1 AND kind='work_email' AND source_id IS NOT NULL
      UNION SELECT source_id FROM entity_tags WHERE is_public=1 AND contribution_eligible=1 AND source_id IS NOT NULL
      UNION SELECT source_id FROM entity_sources WHERE is_public=1 AND contribution_eligible=1
    ) ORDER BY id`);
  const sourceIds = new Set(rows.sources.map((row) => String(row.id)));

  rows.firms =
    vault.all(`SELECT id,name,website,investor_type,headquarters,description,updated_at FROM firms
    WHERE is_public=1 AND contribution_eligible=1 ORDER BY id`);
  const firmIds = new Set(rows.firms.map((row) => String(row.id)));
  rows.people = vault
    .all(
      `SELECT id,firm_id,full_name,title,city,bio,is_investor,updated_at FROM people
    WHERE is_public=1 AND contribution_eligible=1 ORDER BY id`,
    )
    .filter((row) => row.firm_id === null || firmIds.has(String(row.firm_id)));
  const personIds = new Set(rows.people.map((row) => String(row.id)));
  rows.funds = vault
    .all(
      `SELECT id,firm_id,name,vintage_year,size_usd,announced_on,updated_at FROM funds
    WHERE is_public=1 AND contribution_eligible=1 ORDER BY id`,
    )
    .filter((row) => firmIds.has(String(row.firm_id)));
  const fundIds = new Set(rows.funds.map((row) => String(row.id)));
  const entityEligible = (row: SerializableRow): boolean => {
    if (row.entity_type === 'firm') return firmIds.has(String(row.entity_id));
    if (row.entity_type === 'person') return personIds.has(String(row.entity_id));
    if (row.entity_type === 'fund') return fundIds.has(String(row.entity_id));
    return false;
  };
  rows.claims = vault
    .all(
      `SELECT id,entity_type,entity_id,field,value_json,source_id,confidence,observed_at,status,updated_at FROM claims
    WHERE is_public=1 AND contribution_eligible=1 AND source_id IS NOT NULL ORDER BY id`,
    )
    .filter((row) => sourceIds.has(String(row.source_id)) && entityEligible(row));
  rows.tags = vault.all(
    `SELECT id,kind,value,normalized_value,updated_at FROM tags WHERE is_public=1 AND contribution_eligible=1 ORDER BY id`,
  );
  rows.entity_sources = vault
    .all(
      `SELECT entity_type,entity_id,source_id,source_role,evidence_granularity,created_at FROM entity_sources
    WHERE is_public=1 AND contribution_eligible=1 ORDER BY entity_type,entity_id,source_id,source_role`,
    )
    .filter((row) => sourceIds.has(String(row.source_id)) && entityEligible(row));
  const tagIds = new Set(rows.tags.map((row) => String(row.id)));
  rows.entity_tags = vault
    .all(
      `SELECT entity_type,entity_id,tag_id,source_id,created_at FROM entity_tags
    WHERE is_public=1 AND contribution_eligible=1 ORDER BY entity_type,entity_id,tag_id`,
    )
    .filter(
      (row) =>
        tagIds.has(String(row.tag_id)) &&
        entityEligible(row) &&
        (row.source_id === null || sourceIds.has(String(row.source_id))),
    );
  rows.public_work_emails = vault
    .all(
      `SELECT id,person_id,value AS work_email,normalized_value AS normalized_email,source_id,label,updated_at FROM contact_methods
    WHERE kind='work_email' AND visibility='public' AND contribution_eligible=1 AND source_id IS NOT NULL ORDER BY id`,
    )
    .filter((row) => personIds.has(String(row.person_id)) && sourceIds.has(String(row.source_id)));

  const logicalDigestSha256 = digestPayload(rows);
  const output = new sqlite.Database();
  try {
    output.run(CONTRIBUTION_SCHEMA);
    output.run('BEGIN IMMEDIATE');
    try {
      for (const table of [
        'sources',
        'firms',
        'people',
        'funds',
        'claims',
        'entity_sources',
        'tags',
        'entity_tags',
        'public_work_emails',
      ] as const)
        insertRows(output, table, rows[table]!);
      output.run(
        "INSERT INTO package_manifest(package_id,package_version,package_kind,format_version,created_at,contributor,license_spdx,logical_digest_sha256,privacy_policy) VALUES (?,?,'contribution',1,?,?,?,?,?)",
        [
          options.packageId,
          options.packageVersion,
          createdAt,
          options.contributor,
          options.licenseSpdx,
          logicalDigestSha256,
          'Public investor facts and explicitly public work email only; excludes founder profile, rounds, targets, pipeline, messages, approvals, send history, meetings, tasks, notes, connector configuration, agent activity, and audit history.',
        ],
      );
      output.run('COMMIT');
    } catch (error) {
      output.run('ROLLBACK');
      throw error;
    }
    output.run('VACUUM');
    return {
      bytes: output.export(),
      logicalDigestSha256,
      createdAt,
      counts: Object.fromEntries(
        Object.entries(rows).map(([table, values]) => [table, values.length]),
      ),
    };
  } finally {
    output.close();
  }
}
