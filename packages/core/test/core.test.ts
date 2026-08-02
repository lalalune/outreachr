import { createRequire } from 'node:module';
import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  CoreVault,
  MIGRATIONS,
  MeetingSchema,
  OutreachrRepository,
  SCHEMA_VERSION,
  DEFAULT_OPT_OUT_TEXT,
  approvalContentHash,
  appendCommunicationFooter,
  createEncryptedBackup,
  computeSeedLogicalDigest,
  exportContribution,
  importInvestorSeed,
  restoreEncryptedBackup,
} from '../src/index.js';

const NOW = '2026-07-31T12:00:00.000Z';
const LATER = '2026-07-31T12:05:00.000Z';
const POSTAL_ADDRESS = '123 Founder Way\nSan Francisco, CA 94107\nUnited States';
let SQL: SqlJsStatic;

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const wasm = require.resolve('sql.js/dist/sql-wasm.wasm');
  SQL = await initSqlJs({ locateFile: () => wasm });
});

function vault(): CoreVault {
  return new CoreVault(SQL, { appliedAt: NOW });
}

function repositoryWithFounder(): { vault: CoreVault; repository: OutreachrRepository } {
  const core = vault();
  const repository = new OutreachrRepository(core);
  repository.upsertFounderProfile({
    id: 'founder',
    fullName: 'Ada Founder',
    companyName: 'Local Labs',
    workEmail: 'ada@local.test',
    createdAt: NOW,
    updatedAt: NOW,
  });
  repository.upsertRound({
    id: 'round-1',
    founderProfileId: 'founder',
    name: 'Seed 2026',
    stage: 'seed',
    targetAmountUsd: 2_000_000,
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
  });
  repository.upsertConnectorConfig({
    id: 'connector-google',
    provider: 'google',
    accountLabel: 'ada@local.test',
    publicConfig: {},
    secretRef: 'memory://google',
    scopes: [],
    status: 'connected',
    createdAt: NOW,
    updatedAt: NOW,
  });
  repository.updateCommunicationSettings(
    {
      sendingPaused: false,
      dailySendLimit: 10,
      hourlySendLimit: 3,
      recipientDomainDailyLimit: 2,
      recipientDomainCooldownMinutes: 30,
      postalAddress: POSTAL_ADDRESS,
      optOutText: DEFAULT_OPT_OUT_TEXT,
    },
    NOW,
  );
  return { vault: core, repository };
}

function compliantBody(bodyText: string): string {
  return appendCommunicationFooter(bodyText, {
    founderName: 'Ada Founder',
    companyName: 'Local Labs',
    postalAddress: POSTAL_ADDRESS,
    optOutText: DEFAULT_OPT_OUT_TEXT,
  });
}

function addFirmAndPeople(repository: OutreachrRepository): void {
  repository.upsertFirm({
    id: 'firm-1',
    name: 'Calm Capital',
    investorType: 'vc_firm',
    createdAt: NOW,
    updatedAt: NOW,
  });
  repository.upsertPerson({
    id: 'person-1',
    firmId: 'firm-1',
    fullName: 'Pat Partner',
    createdAt: NOW,
    updatedAt: NOW,
  });
  repository.upsertPerson({
    id: 'person-2',
    firmId: 'firm-1',
    fullName: 'Sam Scout',
    createdAt: NOW,
    updatedAt: NOW,
  });
  repository.upsertContactMethod({
    id: 'contact-person-1',
    personId: 'person-1',
    kind: 'work_email',
    value: 'partner@calm.example',
    visibility: 'private',
    createdAt: NOW,
    updatedAt: NOW,
  });
  repository.upsertContactMethod({
    id: 'contact-person-2',
    personId: 'person-2',
    kind: 'work_email',
    value: 'scout@calm.example',
    visibility: 'private',
    createdAt: NOW,
    updatedAt: NOW,
  });
}

describe('canonical validation', () => {
  it('compares meeting instants rather than lexical timezone-offset strings', () => {
    expect(() =>
      MeetingSchema.parse({
        id: 'meeting-offset-order',
        title: 'Timezone ordering',
        startsAt: '2026-08-03T10:00:00-08:00',
        endsAt: '2026-08-03T17:30:00Z',
        createdAt: NOW,
        updatedAt: NOW,
      }),
    ).toThrow('Meeting must end after it starts');
  });
});

describe('vault transactions', () => {
  it('commits nested work and can roll back a nested savepoint without aborting its parent', () => {
    const core = vault();
    core.run('CREATE TABLE nested_transaction_test(id TEXT PRIMARY KEY)');
    core.transaction(() => {
      core.run("INSERT INTO nested_transaction_test(id) VALUES ('outer-before')");
      core.transaction(() => {
        core.run("INSERT INTO nested_transaction_test(id) VALUES ('inner-committed')");
      });
      try {
        core.transaction(() => {
          core.run("INSERT INTO nested_transaction_test(id) VALUES ('inner-rolled-back')");
          throw new Error('roll back only this savepoint');
        });
      } catch {
        // The caller may recover from an inner operation while keeping the
        // surrounding unit of work active.
      }
      core.run("INSERT INTO nested_transaction_test(id) VALUES ('outer-after')");
    });
    expect(core.all<{ id: string }>('SELECT id FROM nested_transaction_test ORDER BY id')).toEqual([
      { id: 'inner-committed' },
      { id: 'outer-after' },
      { id: 'outer-before' },
    ]);
    core.close();
  });
});

function addPersonWithEmail(
  repository: OutreachrRepository,
  personId: string,
  email: string,
): void {
  repository.upsertPerson({
    id: personId,
    firmId: 'firm-1',
    fullName: `Partner ${personId}`,
    createdAt: NOW,
    updatedAt: NOW,
  });
  repository.upsertContactMethod({
    id: `contact-${personId}`,
    personId,
    kind: 'work_email',
    value: email,
    visibility: 'private',
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function message(
  repository: OutreachrRepository,
  id: string,
  personId: string,
  recipientAddress: string,
  subject = 'A careful introduction',
): void {
  repository.createMessageDraft({
    id,
    roundId: 'round-1',
    recipientPersonId: personId,
    recipientAddress,
    provider: 'google',
    senderAddress: 'ada@local.test',
    messageKind: 'initial',
    providerThreadId: null,
    subject,
    bodyText: compliantBody('Hello — would this company be relevant to your current thesis?'),
    attachments: [],
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function createSeed(): { bytes: Uint8Array; digest: string } {
  const seed = new SQL.Database();
  seed.run(`
    CREATE TABLE package_manifest(package_id TEXT,package_version TEXT,package_kind TEXT,seed_format_version INTEGER,data_schema_version INTEGER,logical_digest_sha256 TEXT,signature_status TEXT);
    CREATE TABLE package_license(license_id TEXT PRIMARY KEY,applies_to TEXT,spdx_expression TEXT,license_url TEXT,rights_class TEXT,redistribution_status TEXT,attribution TEXT,notes TEXT);
    CREATE TABLE build_input(input_name TEXT PRIMARY KEY,sha256 TEXT,byte_count INTEGER,record_count INTEGER);
    CREATE TABLE entity(entity_id TEXT PRIMARY KEY,entity_kind TEXT,display_name TEXT,origin TEXT,verification_date TEXT,data_quality_notes TEXT);
    CREATE TABLE firm_profile(entity_id TEXT PRIMARY KEY,investor_types_text TEXT,website TEXT,hq_cities_text TEXT,priority_geography_text TEXT,stages_text TEXT,sectors_tags_text TEXT,typical_initial_check_usd_text TEXT,fund_or_aum_signal TEXT,notable_portfolio_examples_text TEXT,key_partners_text TEXT,linkedin_url TEXT,x_url TEXT,contact_or_application_url TEXT);
    CREATE TABLE person_profile(entity_id TEXT PRIMARY KEY,firm_id TEXT,title TEXT,city TEXT,focus_tags_text TEXT,linkedin_url TEXT,x_url TEXT,bio_url TEXT);
    CREATE TABLE individual_profile(entity_id TEXT PRIMARY KEY,primary_investor_type TEXT,investor_types_text TEXT,city_geography TEXT,geography_basis TEXT,stages_text TEXT,focus_tags_text TEXT,check_size_evidence TEXT,affiliations_text TEXT,website_or_bio_url TEXT,linkedin_url TEXT,x_url TEXT,contact_or_application_url TEXT);
    CREATE TABLE source(source_id TEXT PRIMARY KEY,canonical_url TEXT,host TEXT,source_type TEXT,rights_class TEXT,redistribution_status TEXT,retrieved_at TEXT,evidence_excerpt TEXT,notes TEXT);
    CREATE TABLE entity_source(entity_id TEXT,source_id TEXT,source_role TEXT,evidence_granularity TEXT);
    CREATE TABLE tag(tag_id TEXT PRIMARY KEY,tag_kind TEXT,normalized_value TEXT,display_value TEXT);
    CREATE TABLE entity_tag(entity_id TEXT,tag_id TEXT,basis TEXT);
    CREATE TABLE identity(identity_id TEXT PRIMARY KEY,entity_id TEXT,scheme TEXT,normalized_value TEXT,display_value TEXT);
    CREATE TABLE portfolio_example(firm_id TEXT,company_name TEXT,normalized_company_name TEXT,caveat TEXT);
    CREATE TABLE firm_named_partner(firm_id TEXT,person_name TEXT,normalized_person_name TEXT,caveat TEXT);
  `);
  seed.run(
    "INSERT INTO package_license VALUES ('license:test','normalized facts','CC0-1.0',NULL,'facts','allowed',NULL,'fixture')",
  );
  seed.run(
    "INSERT INTO build_input VALUES ('fixture','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',1,1)",
  );
  seed.run(
    "INSERT INTO entity VALUES ('firm:calm','firm','Calm Capital','curated_seed','2026-07-01','Research fixture')",
  );
  seed.run(
    "INSERT INTO entity VALUES ('person:pat','person','Pat Partner','curated_seed','2026-07-01','Research fixture')",
  );
  seed.run(
    "INSERT INTO entity VALUES ('person:angel','individual_investor','Ari Angel','curated_seed','2026-07-01','Research fixture')",
  );
  seed.run(
    "INSERT INTO firm_profile VALUES ('firm:calm','Institutional VC; Token / crypto fund','https://calm.example','San Francisco','US','Seed','AI; crypto','$250k-$1m','$100m','ExampleCo','Pat Partner',NULL,NULL,NULL)",
  );
  seed.run(
    "INSERT INTO person_profile VALUES ('person:pat','firm:calm','Partner','San Francisco','AI',NULL,NULL,NULL)",
  );
  seed.run(
    "INSERT INTO individual_profile VALUES ('person:angel','angel','Angel; Scout','New York','public bio','Pre-seed','consumer','$25k','Operator','https://angel.example',NULL,NULL,NULL)",
  );
  seed.run(
    "INSERT INTO source VALUES ('source:0','https://calm.example/unrelated','calm.example','public_web','facts_reference_only','source_terms_apply',?,'Unrelated entity-level evidence','')",
    [NOW],
  );
  seed.run(
    "INSERT INTO source VALUES ('source:1','https://calm.example/about','calm.example','firm_site','facts_reference_only','source_terms_apply',?,'Seed investing','')",
    [NOW],
  );
  seed.run(
    "INSERT INTO source VALUES ('source:2','https://angel.example','angel.example','investor_site','facts_reference_only','source_terms_apply',?,'Public biography','')",
    [NOW],
  );
  seed.run("INSERT INTO entity_source VALUES ('firm:calm','source:0','evidence','record')");
  seed.run("INSERT INTO entity_source VALUES ('firm:calm','source:1','profile','record')");
  seed.run("INSERT INTO entity_source VALUES ('person:pat','source:1','profile','record')");
  seed.run("INSERT INTO entity_source VALUES ('person:angel','source:2','bio_url','record')");
  seed.run("INSERT INTO tag VALUES ('tag:ai','sector','ai','AI')");
  seed.run(
    "INSERT INTO tag VALUES ('tag:institutional-vc','investor_type','institutional vc','Institutional VC')",
  );
  seed.run(
    "INSERT INTO tag VALUES ('tag:crypto-fund','investor_type','token / crypto fund','Token / crypto fund')",
  );
  seed.run("INSERT INTO entity_tag VALUES ('firm:calm','tag:ai','curated')");
  seed.run("INSERT INTO entity_tag VALUES ('firm:calm','tag:institutional-vc','curated')");
  seed.run("INSERT INTO entity_tag VALUES ('firm:calm','tag:crypto-fund','curated')");
  seed.run(
    "INSERT INTO identity VALUES ('identity:pat-linkedin','person:pat','linkedin_url','https://linkedin.com/in/pat','https://linkedin.com/in/pat')",
  );
  seed.run(
    "INSERT INTO identity VALUES ('identity:angel-bio','person:angel','bio_url','https://angel.example','https://angel.example/')",
  );
  seed.run(
    "INSERT INTO portfolio_example VALUES ('firm:calm','ExampleCo','exampleco','Illustrative')",
  );
  seed.run(
    "INSERT INTO firm_named_partner VALUES ('firm:calm','Pat Partner','pat partner','Named on public site')",
  );
  const digest = computeSeedLogicalDigest(seed);
  seed.run('INSERT INTO package_manifest VALUES (?,?,?,?,?,?,?)', [
    'seed:test',
    '0.1.0',
    'seed',
    2,
    2,
    digest,
    'UNSIGNED_RESEARCH_ARTIFACT',
  ]);
  const bytes = seed.export();
  seed.close();
  return { bytes, digest };
}

function tableNames(db: Database): string[] {
  const result = db.exec("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")[0];
  return result?.values.map((value) => String(value[0])) ?? [];
}

describe('vault migrations', () => {
  it('creates the complete schema, survives reopen, and passes integrity checks', () => {
    const first = vault();
    expect(first.schemaVersion).toBe(SCHEMA_VERSION);
    expect(tableNames(first.db)).toEqual(
      expect.arrayContaining([
        'founder_profiles',
        'rounds',
        'firms',
        'people',
        'funds',
        'claims',
        'sources',
        'tags',
        'targets',
        'messages',
        'approvals',
        'send_ledger',
        'suppressions',
        'meetings',
        'tasks',
        'notes',
        'knowledge_items',
        'lists',
        'connector_configs',
        'secure_secrets',
        'local_preferences',
        'agent_runs',
        'agent_proposals',
        'audit_log',
        'seed_imports',
      ]),
    );
    expect(first.integrityCheck()).toEqual({ ok: true, messages: ['ok'] });
    const exported = first.export();
    first.close();

    const reopened = new CoreVault(SQL, { bytes: exported, appliedAt: LATER });
    expect(reopened.schemaVersion).toBe(SCHEMA_VERSION);
    expect(reopened.integrityCheck().ok).toBe(true);
    expect(Number(reopened.scalar('SELECT COUNT(*) FROM schema_migrations'))).toBe(SCHEMA_VERSION);
    reopened.close();
  });

  it('migrates a v6 vault with footer settings unset and revokes legacy active approvals', () => {
    const legacy = new SQL.Database();
    for (const migration of MIGRATIONS.filter((item) => item.version <= 6)) {
      legacy.run(migration.sql);
      legacy.run('INSERT INTO schema_migrations(version,name,applied_at) VALUES (?,?,?)', [
        migration.version,
        migration.name,
        NOW,
      ]);
      legacy.run(`PRAGMA user_version=${migration.version}`);
    }
    legacy.run(
      `INSERT INTO founder_profiles(id,full_name,company_name,created_at,updated_at)
       VALUES ('founder','Legacy Founder','Legacy Labs',?,?)`,
      [NOW, NOW],
    );
    legacy.run(
      `INSERT INTO people(id,full_name,normalized_name,is_investor,is_public,contribution_eligible,origin,created_at,updated_at)
       VALUES ('person-legacy','Legacy Partner','legacy partner',1,0,0,'local',?,?)`,
      [NOW, NOW],
    );
    legacy.run(
      `INSERT INTO contact_methods(id,person_id,kind,value,normalized_value,visibility,contribution_eligible,is_primary,created_at,updated_at)
       VALUES ('contact-legacy','person-legacy','work_email','legacy@example.test','legacy@example.test','private',0,1,?,?)`,
      [NOW, NOW],
    );
    legacy.run(
      `INSERT INTO connector_configs(id,provider,account_label,public_config_json,secret_ref,scopes_json,status,created_at,updated_at)
       VALUES ('connector-legacy','google','founder@example.test','{}','memory://legacy','[]','connected',?,?)`,
      [NOW, NOW],
    );
    legacy.run(
      `INSERT INTO messages(id,recipient_person_id,recipient_address,recipient_normalized,
       provider,sender_address,sender_normalized,message_kind,subject,body_text,attachments_json,state,created_at,updated_at)
       VALUES ('message-legacy','person-legacy','legacy@example.test','legacy@example.test',
       'google','founder@example.test','founder@example.test','initial','Legacy subject','Legacy body','[]','approved',?,?)`,
      [NOW, NOW],
    );
    legacy.run(
      `INSERT INTO approvals(id,message_id,content_sha256,provider,sender_address,sender_normalized,
       message_kind,approved_by,approved_at,status)
       VALUES ('approval-legacy','message-legacy',?,'google','founder@example.test','founder@example.test',
       'initial','founder',?,'active')`,
      ['a'.repeat(64), NOW],
    );
    const bytes = legacy.export();
    legacy.close();

    const migrated = new CoreVault(SQL, { bytes, appliedAt: LATER });
    const settings = new OutreachrRepository(migrated).communicationSettings();
    expect(migrated.schemaVersion).toBe(SCHEMA_VERSION);
    expect(settings).toMatchObject({
      postalAddress: null,
      optOutText: DEFAULT_OPT_OUT_TEXT,
      hourlySendLimit: 3,
      recipientDomainDailyLimit: 2,
      recipientDomainCooldownMinutes: 30,
    });
    expect(migrated.scalar("SELECT status FROM approvals WHERE id='approval-legacy'")).toBe(
      'revoked',
    );
    expect(migrated.scalar("SELECT state FROM messages WHERE id='message-legacy'")).toBe('draft');
    expect(migrated.integrityCheck().ok).toBe(true);
    migrated.close();
  });

  it('migrates legacy not-now notes into an explicit disposition without guessing other notes', () => {
    const legacy = new SQL.Database();
    for (const migration of MIGRATIONS.filter((item) => item.version <= 7)) {
      legacy.run(migration.sql);
      legacy.run('INSERT INTO schema_migrations(version,name,applied_at) VALUES (?,?,?)', [
        migration.version,
        migration.name,
        NOW,
      ]);
      legacy.run(`PRAGMA user_version=${migration.version}`);
    }
    legacy.run(
      `INSERT INTO founder_profiles(id,full_name,company_name,created_at,updated_at)
       VALUES ('founder-v7','Legacy Founder','Legacy Labs',?,?)`,
      [NOW, NOW],
    );
    legacy.run(
      `INSERT INTO rounds(id,founder_profile_id,name,stage,status,created_at,updated_at)
       VALUES ('round-v7','founder-v7','Legacy seed','seed','active',?,?)`,
      [NOW, NOW],
    );
    legacy.run(
      `INSERT INTO firms(id,name,normalized_name,investor_type,is_public,contribution_eligible,origin,created_at,updated_at)
       VALUES ('firm-not-now','Not Now Capital','not now capital','vc',0,0,'local',?,?),
              ('firm-custom-note','Custom Note Capital','custom note capital','vc',0,0,'local',?,?)`,
      [NOW, NOW, NOW, NOW],
    );
    legacy.run(
      `INSERT INTO targets(id,round_id,firm_id,stage,priority,owner_note,created_at,updated_at)
       VALUES ('target-not-now','round-v7','firm-not-now','passed',50,'Not now',?,?),
              ('target-custom-note','round-v7','firm-custom-note','passed',50,'Founder chose to pause',?,?)`,
      [NOW, NOW, NOW, NOW],
    );
    const bytes = legacy.export();
    legacy.close();

    const migrated = new CoreVault(SQL, { bytes, appliedAt: LATER });
    expect(migrated.schemaVersion).toBe(SCHEMA_VERSION);
    expect(migrated.scalar("SELECT disposition FROM targets WHERE id='target-not-now'")).toBe(
      'not_now',
    );
    expect(
      migrated.scalar("SELECT disposition FROM targets WHERE id='target-custom-note'"),
    ).toBeNull();
    expect(migrated.integrityCheck().ok).toBe(true);
    migrated.close();
  });

  it('migrates a v8 vault with an empty device-local preference store', () => {
    const legacy = new SQL.Database();
    for (const migration of MIGRATIONS.filter((item) => item.version <= 8)) {
      legacy.run(migration.sql);
      legacy.run('INSERT INTO schema_migrations(version,name,applied_at) VALUES (?,?,?)', [
        migration.version,
        migration.name,
        NOW,
      ]);
      legacy.run(`PRAGMA user_version=${migration.version}`);
    }
    const bytes = legacy.export();
    legacy.close();

    const migrated = new CoreVault(SQL, { bytes, appliedAt: LATER });
    expect(migrated.schemaVersion).toBe(SCHEMA_VERSION);
    expect(tableNames(migrated.db)).toContain('local_preferences');
    expect(Number(migrated.scalar('SELECT COUNT(*) FROM local_preferences'))).toBe(0);
    expect(migrated.integrityCheck().ok).toBe(true);
    migrated.close();
  });
});

describe('seed import', () => {
  it('imports the immutable research seed once and pins its logical digest', () => {
    const core = vault();
    const { bytes, digest } = createSeed();
    const imported = importInvestorSeed(SQL, core, bytes, {
      importedAt: NOW,
      expectedLogicalDigest: digest,
    });
    expect(imported).toMatchObject({
      firmCount: 2,
      personCount: 2,
      sourceCount: 3,
      alreadyImported: false,
      signatureStatus: 'unsigned_research',
    });
    expect(Number(core.scalar('SELECT COUNT(*) FROM firms'))).toBe(2);
    expect(Number(core.scalar('SELECT COUNT(*) FROM people'))).toBe(2);
    expect(Number(core.scalar('SELECT COUNT(*) FROM tags'))).toBe(3);
    expect(Number(core.scalar('SELECT COUNT(*) FROM contact_methods'))).toBe(2);
    expect(Number(core.scalar('SELECT COUNT(*) FROM claims'))).toBeGreaterThan(0);
    expect(core.one("SELECT investor_type FROM firms WHERE id='firm:calm'")).toEqual({
      investor_type: 'venture_capital',
    });
    expect(
      core.one(
        "SELECT value_json FROM claims WHERE entity_type='firm' AND entity_id='firm:calm' AND field='investor_types'",
      ),
    ).toEqual({ value_json: JSON.stringify('Institutional VC; Token / crypto fund') });
    expect(
      core.all(
        `SELECT t.value FROM entity_tags et JOIN tags t ON t.id=et.tag_id
         WHERE et.entity_type='firm' AND et.entity_id='firm:calm' AND t.kind='investor_type'
         ORDER BY t.normalized_value`,
      ),
    ).toEqual([{ value: 'Institutional VC' }, { value: 'Token / crypto fund' }]);
    expect(
      core.one(
        "SELECT f.investor_type,p.firm_id,p.title FROM firms f JOIN people p ON p.id=f.id WHERE f.id='person:angel'",
      ),
    ).toEqual({ investor_type: 'angel', firm_id: 'person:angel', title: 'angel' });
    expect(
      core.all(
        "SELECT entity_type,field,value_json,source_id FROM claims WHERE entity_id='person:angel' AND field IN ('primary_investor_type','investor_types') ORDER BY entity_type,field",
      ),
    ).toEqual([
      {
        entity_type: 'firm',
        field: 'investor_types',
        value_json: JSON.stringify('Angel; Scout'),
        source_id: null,
      },
      {
        entity_type: 'firm',
        field: 'primary_investor_type',
        value_json: JSON.stringify('angel'),
        source_id: null,
      },
      {
        entity_type: 'person',
        field: 'investor_types',
        value_json: JSON.stringify('Angel; Scout'),
        source_id: null,
      },
      {
        entity_type: 'person',
        field: 'primary_investor_type',
        value_json: JSON.stringify('angel'),
        source_id: null,
      },
    ]);
    expect(
      core.all(
        "SELECT entity_type,source_id FROM entity_sources WHERE entity_id='person:angel' ORDER BY entity_type",
      ),
    ).toEqual([
      { entity_type: 'firm', source_id: 'source:2' },
      { entity_type: 'person', source_id: 'source:2' },
    ]);
    expect(core.one("SELECT source_id FROM contact_methods WHERE id='identity:angel-bio'")).toEqual(
      { source_id: 'source:2' },
    );
    expect(
      core.one("SELECT source_id FROM contact_methods WHERE id='identity:pat-linkedin'"),
    ).toEqual({ source_id: null });
    expect(
      core.all(
        "SELECT field,source_id FROM claims WHERE field IN ('portfolio_example','named_partner') ORDER BY field",
      ),
    ).toEqual([
      { field: 'named_partner', source_id: null },
      { field: 'portfolio_example', source_id: null },
    ]);
    expect(
      importInvestorSeed(SQL, core, bytes, { importedAt: LATER, expectedLogicalDigest: digest })
        .alreadyImported,
    ).toBe(true);
    expect(() =>
      importInvestorSeed(SQL, core, bytes, {
        importedAt: LATER,
        expectedLogicalDigest: 'b'.repeat(64),
      }),
    ).toThrow(/digest/i);
    const tampered = new SQL.Database(bytes);
    tampered.run("UPDATE entity SET display_name='Tampered Capital' WHERE entity_id='firm:calm'");
    const tamperedBytes = tampered.export();
    tampered.close();
    expect(() =>
      importInvestorSeed(SQL, core, tamperedBytes, {
        importedAt: LATER,
        allowUnsignedResearch: true,
      }),
    ).toThrow(/contents.*logical digest/i);
    expect(core.integrityCheck().ok).toBe(true);
    core.close();
  });

  it('requires an explicit opt-in or pinned digest for an unsigned seed', () => {
    const core = vault();
    expect(() => importInvestorSeed(SQL, core, createSeed().bytes, { importedAt: NOW })).toThrow(
      /unsigned research seed/i,
    );
    core.close();
  });
});

describe('approval and send safety', () => {
  it('computes a stable content hash and invalidates approval after any content edit', () => {
    const { vault: core, repository } = repositoryWithFounder();
    addFirmAndPeople(repository);
    message(repository, 'message-1', 'person-1', 'partner@calm.example');
    const approval = repository.approveMessage('message-1', NOW, { approvalId: 'approval-1' });
    expect(approval.contentSha256).toBe(
      approvalContentHash({
        recipientAddress: 'partner@calm.example',
        recipientPersonId: 'person-1',
        provider: 'google',
        senderAddress: 'ada@local.test',
        messageKind: 'initial',
        providerThreadId: null,
        subject: 'A careful introduction',
        bodyText: compliantBody('Hello — would this company be relevant to your current thesis?'),
        attachments: [],
      }),
    );
    const replacement = repository.approveMessage('message-1', LATER, { approvalId: 'approval-2' });
    expect(replacement.contentSha256).toBe(approval.contentSha256);
    expect(core.scalar("SELECT status FROM approvals WHERE id='approval-1'")).toBe('revoked');
    message(repository, 'message-1', 'person-1', 'partner@calm.example', 'Changed after approval');
    expect(core.scalar("SELECT status FROM approvals WHERE id='approval-2'")).toBe('revoked');
    expect(core.scalar("SELECT state FROM messages WHERE id='message-1'")).toBe('draft');
    expect(() =>
      repository.reserveApprovedSend('message-1', 'google', 'ada@local.test', LATER),
    ).toThrow(/active approval/i);
    core.close();
  });

  it('revokes approval for every delivery-identity mutation and reserves only the exact account', () => {
    const { vault: core, repository } = repositoryWithFounder();
    addFirmAndPeople(repository);
    message(repository, 'message-identity', 'person-1', 'partner@calm.example');

    const mutations = [
      ["provider='microsoft'", 'provider'],
      ["sender_address='other@local.test'", 'sender'],
      ["message_kind='reply'", 'kind'],
      ["provider_thread_id='thread-mutated'", 'thread'],
    ] as const;
    for (const [assignment, label] of mutations) {
      const approval = repository.approveMessage('message-identity', NOW, {
        approvalId: `approval-${label}`,
      });
      core.run(`UPDATE messages SET ${assignment},updated_at=? WHERE id='message-identity'`, [
        LATER,
      ]);
      expect(core.scalar('SELECT status FROM approvals WHERE id=?', [approval.id])).toBe('revoked');
      expect(core.scalar("SELECT state FROM messages WHERE id='message-identity'")).toBe('draft');
      core.run(
        "UPDATE messages SET provider='google',sender_address='ada@local.test',sender_normalized='ada@local.test',message_kind='initial',provider_thread_id=NULL,updated_at=? WHERE id='message-identity'",
        [LATER],
      );
    }

    const exact = repository.approveMessage('message-identity', LATER, {
      approvalId: 'approval-exact',
    });
    expect(exact).toMatchObject({
      provider: 'google',
      senderNormalized: 'ada@local.test',
      messageKind: 'initial',
      providerThreadId: null,
    });
    expect(() =>
      core.run("UPDATE approvals SET provider='microsoft' WHERE id='approval-exact'"),
    ).toThrow(/immutable/i);
    expect(() =>
      repository.reserveApprovedSend(
        'message-identity',
        'microsoft',
        'ada@local.test',
        LATER,
        'send-wrong-provider',
      ),
    ).toThrow(/provider|sender/i);
    expect(() =>
      repository.reserveApprovedSend(
        'message-identity',
        'google',
        'other@local.test',
        LATER,
        'send-wrong-sender',
      ),
    ).toThrow(/provider|sender/i);
    expect(Number(core.scalar('SELECT COUNT(*) FROM send_ledger'))).toBe(0);
    expect(
      repository.reserveApprovedSend(
        'message-identity',
        'google',
        'ADA@LOCAL.TEST',
        LATER,
        'send-exact',
      ),
    ).toMatchObject({
      id: 'send-exact',
      provider: 'google',
      senderNormalized: 'ada@local.test',
      messageKind: 'initial',
      providerThreadId: null,
    });
    expect(
      core.one(
        "SELECT provider,sender_normalized,message_kind,approved_provider_thread_id FROM send_ledger WHERE id='send-exact'",
      ),
    ).toEqual({
      provider: 'google',
      sender_normalized: 'ada@local.test',
      message_kind: 'initial',
      approved_provider_thread_id: null,
    });
    core.close();
  });

  it('enforces one lifetime reservation per person and per normalized email', () => {
    const { vault: core, repository } = repositoryWithFounder();
    addFirmAndPeople(repository);
    message(repository, 'message-1', 'person-1', 'Partner@Calm.Example');
    repository.approveMessage('message-1', NOW, { approvalId: 'approval-1' });
    repository.reserveApprovedSend('message-1', 'google', 'ada@local.test', LATER, 'send-1');

    repository.upsertContactMethod({
      id: 'contact-person-1-alt',
      personId: 'person-1',
      kind: 'work_email',
      value: 'pat+alternate@calm.example',
      visibility: 'private',
      createdAt: NOW,
      updatedAt: NOW,
    });
    message(repository, 'message-2', 'person-1', 'pat+alternate@calm.example');
    repository.approveMessage('message-2', NOW, { approvalId: 'approval-2' });
    expect(() =>
      repository.reserveApprovedSend(
        'message-2',
        'google',
        'ada@local.test',
        '2026-07-31T12:40:00.000Z',
        'send-2',
      ),
    ).toThrow(/unique constraint/i);

    expect(() =>
      repository.upsertContactMethod({
        id: 'contact-duplicate',
        personId: 'person-2',
        kind: 'work_email',
        value: 'PARTNER@CALM.EXAMPLE',
        visibility: 'private',
        createdAt: NOW,
        updatedAt: NOW,
      }),
    ).toThrow(/already belongs to another person/i);
    message(repository, 'message-3', 'person-2', 'partner@calm.example');
    repository.approveMessage('message-3', NOW, { approvalId: 'approval-3' });
    expect(() =>
      repository.reserveApprovedSend(
        'message-3',
        'google',
        'ada@local.test',
        '2026-07-31T12:41:00.000Z',
        'send-3',
      ),
    ).toThrow(/unique constraint|canonical person/i);

    repository.createMessageDraft({
      id: 'message-unlinked',
      roundId: 'round-1',
      recipientAddress: 'unknown@example.org',
      provider: 'google',
      senderAddress: 'ada@local.test',
      messageKind: 'initial',
      providerThreadId: null,
      subject: 'Hello',
      bodyText: compliantBody('Hello'),
      createdAt: NOW,
      updatedAt: NOW,
    });
    repository.approveMessage('message-unlinked', NOW, { approvalId: 'approval-unlinked' });
    expect(() =>
      repository.reserveApprovedSend(
        'message-unlinked',
        'google',
        'ada@local.test',
        LATER,
        'send-unlinked',
      ),
    ).toThrow(/linked to a person/i);
    expect(Number(core.scalar('SELECT COUNT(*) FROM send_ledger'))).toBe(1);
    core.close();
  });

  it('blocks domain suppression in the database even for an approved message', () => {
    const { vault: core, repository } = repositoryWithFounder();
    addFirmAndPeople(repository);
    repository.addSuppression({
      id: 'suppression-1',
      scope: 'domain',
      value: '@calm.example',
      reason: 'Do not contact',
      source: 'founder',
      createdAt: NOW,
      updatedAt: NOW,
    });
    message(repository, 'message-1', 'person-1', 'partner@calm.example');
    repository.approveMessage('message-1', NOW, { approvalId: 'approval-1' });
    expect(() =>
      repository.reserveApprovedSend('message-1', 'google', 'ada@local.test', LATER, 'send-1'),
    ).toThrow(/suppressed/i);
    expect(Number(core.scalar('SELECT COUNT(*) FROM send_ledger'))).toBe(0);
    core.close();
  });

  it('requires the exact visible footer at approval and send time and revokes on policy change', () => {
    const { vault: core, repository } = repositoryWithFounder();
    addFirmAndPeople(repository);
    repository.createMessageDraft({
      id: 'message-missing-footer',
      roundId: 'round-1',
      recipientPersonId: 'person-1',
      recipientAddress: 'partner@calm.example',
      provider: 'google',
      senderAddress: 'ada@local.test',
      messageKind: 'initial',
      providerThreadId: null,
      subject: 'Missing footer',
      bodyText: 'A body without the configured footer.',
      attachments: [],
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(() => repository.approveMessage('message-missing-footer', NOW)).toThrow(
      /exact configured sender postal address/i,
    );
    expect(() =>
      core.run(
        `INSERT INTO approvals(id,message_id,content_sha256,provider,sender_address,
         sender_normalized,message_kind,approved_by,approved_at,status)
         VALUES ('forged-approval','message-missing-footer',?,'google','ada@local.test',
         'ada@local.test','initial','founder',?,'active')`,
        ['b'.repeat(64), NOW],
      ),
    ).toThrow(/exact configured compliance footer/i);
    repository.createMessageDraft({
      id: 'message-threaded-initial',
      roundId: 'round-1',
      recipientPersonId: 'person-2',
      recipientAddress: 'scout@calm.example',
      provider: 'google',
      senderAddress: 'ada@local.test',
      messageKind: 'initial',
      providerThreadId: 'existing-thread',
      subject: 'Threaded initial',
      bodyText: compliantBody('A structurally invalid initial.'),
      attachments: [],
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(() => repository.approveMessage('message-threaded-initial', NOW)).toThrow(
      /existing provider thread/i,
    );
    expect(() =>
      core.run(
        `INSERT INTO approvals(id,message_id,content_sha256,provider,sender_address,
         sender_normalized,message_kind,provider_thread_id,approved_by,approved_at,status)
         VALUES ('threaded-approval','message-threaded-initial',?,'google','ada@local.test',
         'ada@local.test','initial','existing-thread','founder',?,'active')`,
        ['c'.repeat(64), NOW],
      ),
    ).toThrow(/cannot use a provider thread or attachments/i);
    repository.createMessageDraft({
      id: 'message-attached-initial',
      roundId: 'round-1',
      recipientPersonId: 'person-2',
      recipientAddress: 'scout@calm.example',
      provider: 'google',
      senderAddress: 'ada@local.test',
      messageKind: 'initial',
      providerThreadId: null,
      subject: 'Attached initial',
      bodyText: compliantBody('An attachment is not allowed on stock initial outreach.'),
      attachments: [{ name: 'deck.pdf', contentSha256: 'd'.repeat(64), size: 10 }],
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(() => repository.approveMessage('message-attached-initial', NOW)).toThrow(
      /cannot include attachments/i,
    );
    expect(() =>
      core.run(
        `INSERT INTO approvals(id,message_id,content_sha256,provider,sender_address,
         sender_normalized,message_kind,approved_by,approved_at,status)
         VALUES ('attached-approval','message-attached-initial',?,'google','ada@local.test',
         'ada@local.test','initial','founder',?,'active')`,
        ['e'.repeat(64), NOW],
      ),
    ).toThrow(/cannot use a provider thread or attachments/i);
    core.run('DROP TRIGGER approvals_require_visible_compliance_footer');
    core.run(
      `INSERT INTO approvals(id,message_id,content_sha256,provider,sender_address,
       sender_normalized,message_kind,approved_by,approved_at,status)
       VALUES ('forged-approval','message-missing-footer',?,'google','ada@local.test',
       'ada@local.test','initial','founder',?,'active')`,
      ['b'.repeat(64), NOW],
    );
    expect(() =>
      core.run(
        `INSERT INTO send_ledger(id,message_id,approval_id,approval_sha256,
         recipient_person_id,recipient_address,recipient_normalized,provider,
         sender_address,sender_normalized,message_kind,dispatch_status,reserved_at)
         VALUES ('forged-send','message-missing-footer','forged-approval',?,
         'person-1','partner@calm.example','partner@calm.example','google',
         'ada@local.test','ada@local.test','initial','reserved',?)`,
        ['b'.repeat(64), LATER],
      ),
    ).toThrow(/exact configured compliance footer/i);
    expect(Number(core.scalar('SELECT COUNT(*) FROM send_ledger'))).toBe(0);

    message(repository, 'message-compliant', 'person-1', 'partner@calm.example');
    repository.approveMessage('message-compliant', NOW, { approvalId: 'approval-compliant' });
    repository.updateCommunicationSettings(
      {
        ...repository.communicationSettings(),
        optOutText: 'Reply "stop" if you do not want another message from me.',
      },
      LATER,
    );
    expect(core.scalar("SELECT status FROM approvals WHERE id='approval-compliant'")).toBe(
      'revoked',
    );
    expect(core.scalar("SELECT state FROM messages WHERE id='message-compliant'")).toBe('draft');
    expect(repository.messageComplianceIssues('message-compliant')).toContain(
      'The message body must include the exact configured opt-out wording.',
    );
    core.close();
  });

  it('database-enforces hourly, recipient-domain daily, and recipient-domain cooldown limits', () => {
    const hourly = repositoryWithFounder();
    addFirmAndPeople(hourly.repository);
    addPersonWithEmail(hourly.repository, 'person-3', 'third@third.example');
    addPersonWithEmail(hourly.repository, 'person-4', 'fourth@fourth.example');
    hourly.repository.updateCommunicationSettings(
      {
        ...hourly.repository.communicationSettings(),
        hourlySendLimit: 2,
        recipientDomainDailyLimit: 5,
        recipientDomainCooldownMinutes: 1,
      },
      NOW,
    );
    const hourlyMessages = [
      ['hourly-1', 'person-1', 'partner@calm.example'],
      ['hourly-2', 'person-3', 'third@third.example'],
      ['hourly-3', 'person-4', 'fourth@fourth.example'],
    ] as const;
    for (const [id, personId, email] of hourlyMessages) {
      message(hourly.repository, id, personId, email);
      hourly.repository.approveMessage(id, NOW, { approvalId: `approval-${id}` });
    }
    hourly.repository.reserveApprovedSend(
      'hourly-1',
      'google',
      'ada@local.test',
      '2026-07-31T12:00:00.000Z',
      'send-hourly-1',
    );
    hourly.repository.reserveApprovedSend(
      'hourly-2',
      'google',
      'ada@local.test',
      '2026-07-31T12:10:00.000Z',
      'send-hourly-2',
    );
    expect(() =>
      hourly.repository.reserveApprovedSend(
        'hourly-3',
        'google',
        'ada@local.test',
        '2026-07-31T12:20:00.000Z',
        'send-hourly-3',
      ),
    ).toThrow(/hourly founder send limit/i);
    hourly.vault.close();

    const domain = repositoryWithFounder();
    addFirmAndPeople(domain.repository);
    addPersonWithEmail(domain.repository, 'person-3', 'third@calm.example');
    domain.repository.updateCommunicationSettings(
      {
        ...domain.repository.communicationSettings(),
        hourlySendLimit: 20,
        recipientDomainDailyLimit: 2,
        recipientDomainCooldownMinutes: 30,
      },
      NOW,
    );
    for (const [id, personId, email] of [
      ['domain-1', 'person-1', 'partner@calm.example'],
      ['domain-2', 'person-2', 'scout@calm.example'],
      ['domain-3', 'person-3', 'third@calm.example'],
    ] as const) {
      message(domain.repository, id, personId, email);
      domain.repository.approveMessage(id, NOW, { approvalId: `approval-${id}` });
    }
    domain.repository.reserveApprovedSend(
      'domain-1',
      'google',
      'ada@local.test',
      '2026-07-31T12:00:00.000Z',
      'send-domain-1',
    );
    expect(() =>
      domain.repository.reserveApprovedSend(
        'domain-2',
        'google',
        'ada@local.test',
        '2026-07-31T12:10:00.000Z',
        'send-domain-cooldown',
      ),
    ).toThrow(/recipient-domain cooldown/i);
    domain.repository.reserveApprovedSend(
      'domain-2',
      'google',
      'ada@local.test',
      '2026-07-31T12:31:00.000Z',
      'send-domain-2',
    );
    expect(() =>
      domain.repository.reserveApprovedSend(
        'domain-3',
        'google',
        'ada@local.test',
        '2026-07-31T13:02:00.000Z',
        'send-domain-daily',
      ),
    ).toThrow(/recipient-domain daily send limit/i);
    domain.vault.close();
  });

  it('enforces initial-only sends and makes automatic safety suppressions immutable', () => {
    const { vault: core, repository } = repositoryWithFounder();
    addFirmAndPeople(repository);
    repository.createMessageDraft({
      id: 'message-follow-up',
      roundId: 'round-1',
      recipientPersonId: 'person-1',
      recipientAddress: 'partner@calm.example',
      provider: 'google',
      senderAddress: 'ada@local.test',
      messageKind: 'follow_up',
      providerThreadId: 'existing-thread',
      subject: 'A local-only follow-up',
      bodyText: compliantBody('This can be drafted and reviewed but stock 0.1 must not send it.'),
      attachments: [],
      createdAt: NOW,
      updatedAt: NOW,
    });
    repository.approveMessage('message-follow-up', NOW, { approvalId: 'approval-follow-up' });
    expect(() =>
      repository.reserveApprovedSend(
        'message-follow-up',
        'google',
        'ada@local.test',
        LATER,
        'send-follow-up',
      ),
    ).toThrow(/initial outreach only/i);

    repository.addSuppression({
      id: 'suppression-unsubscribe',
      scope: 'person',
      value: 'person-1',
      reason: 'Recipient requested no further email.',
      source: 'unsubscribe',
      active: true,
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(() =>
      repository.addSuppression({
        id: 'suppression-unsubscribe',
        scope: 'person',
        value: 'person-1',
        reason: 'Attempted founder override',
        source: 'founder',
        active: false,
        createdAt: NOW,
        updatedAt: LATER,
      }),
    ).toThrow(/cannot be deactivated/i);
    expect(() => core.run("DELETE FROM suppressions WHERE id='suppression-unsubscribe'")).toThrow(
      /cannot be deleted/i,
    );
    core.close();
  });

  it('confirms an ambiguous send only from an exact authoritative mailbox observation', () => {
    const { vault: core, repository } = repositoryWithFounder();
    addFirmAndPeople(repository);
    message(repository, 'message-reconcile', 'person-1', 'partner@calm.example');
    repository.approveMessage('message-reconcile', NOW, { approvalId: 'approval-reconcile' });
    repository.reserveApprovedSend(
      'message-reconcile',
      'google',
      'ada@local.test',
      LATER,
      'send:reconcile-exact',
    );
    repository.markDispatchStarted('send:reconcile-exact', '2026-07-31T12:05:01.000Z');
    repository.markSendAmbiguous(
      'send:reconcile-exact',
      'AMBIGUOUS_SEND',
      'Provider response was lost.',
      '2026-07-31T12:05:02.000Z',
    );

    const base = {
      operationKey: 'send:reconcile-exact',
      provider: 'google' as const,
      providerMessageId: 'gmail-confirmed-message',
      providerThreadId: 'gmail-confirmed-thread',
      recipientAddresses: ['PARTNER@CALM.EXAMPLE'],
      subject: 'A careful introduction',
      occurredAt: '2026-07-31T12:05:03.000Z',
      reconciledAt: '2026-07-31T12:10:00.000Z',
    };
    expect(repository.reconcileUnconfirmedSendFromMailbox(base)).toBe(true);
    expect(
      core.one(
        `SELECT dispatch_status,provider_message_id,provider_thread_id,error_code,error_detail
         FROM send_ledger WHERE id='send:reconcile-exact'`,
      ),
    ).toEqual({
      dispatch_status: 'sent',
      provider_message_id: 'gmail-confirmed-message',
      provider_thread_id: 'gmail-confirmed-thread',
      error_code: null,
      error_detail: null,
    });
    expect(core.scalar("SELECT state FROM messages WHERE id='message-reconcile'")).toBe('sent');
    expect(
      Number(
        core.scalar(
          "SELECT COUNT(*) FROM audit_log WHERE action='send.reconciled_from_mailbox' AND entity_id='send:reconcile-exact'",
        ),
      ),
    ).toBe(1);
    expect(repository.reconcileUnconfirmedSendFromMailbox(base)).toBe(false);
    core.close();
  });

  it('ignores malformed, forged, mismatched, or implausibly timed mailbox confirmations', () => {
    const { vault: core, repository } = repositoryWithFounder();
    addFirmAndPeople(repository);
    message(repository, 'message-unconfirmed', 'person-1', 'partner@calm.example');
    repository.approveMessage('message-unconfirmed', NOW, { approvalId: 'approval-unconfirmed' });
    repository.reserveApprovedSend(
      'message-unconfirmed',
      'google',
      'ada@local.test',
      LATER,
      'send:unconfirmed',
    );
    repository.markDispatchStarted('send:unconfirmed', '2026-07-31T12:05:01.000Z');
    const exact = {
      operationKey: 'send:unconfirmed',
      provider: 'google' as const,
      providerMessageId: 'provider-message',
      providerThreadId: null,
      recipientAddresses: ['partner@calm.example'],
      subject: 'A careful introduction',
      occurredAt: '2026-07-31T12:05:02.000Z',
      reconciledAt: '2026-07-31T12:10:00.000Z',
    };
    const mismatches = [
      { ...exact, operationKey: 'not-a-send-operation' },
      { ...exact, operationKey: 'send:missing' },
      { ...exact, provider: 'microsoft' as const },
      { ...exact, recipientAddresses: ['attacker@example.test'] },
      {
        ...exact,
        recipientAddresses: ['partner@calm.example', 'copied@example.test'],
      },
      { ...exact, subject: 'Different subject' },
      { ...exact, occurredAt: '2026-07-31T11:59:00.000Z' },
      { ...exact, occurredAt: '2026-09-01T12:05:02.000Z' },
      { ...exact, reconciledAt: '2026-07-31T11:59:00.000Z' },
    ];
    for (const candidate of mismatches) {
      expect(repository.reconcileUnconfirmedSendFromMailbox(candidate)).toBe(false);
    }
    expect(core.scalar("SELECT dispatch_status FROM send_ledger WHERE id='send:unconfirmed'")).toBe(
      'dispatching',
    );
    expect(
      Number(
        core.scalar("SELECT COUNT(*) FROM audit_log WHERE action='send.reconciled_from_mailbox'"),
      ),
    ).toBe(0);
    core.close();
  });
});

describe('contribution export privacy', () => {
  it('is deterministic and includes only allowlisted public facts and sourced work email', () => {
    const { vault: core, repository } = repositoryWithFounder();
    repository.upsertSource({
      id: 'source-public',
      canonicalUrl: 'https://example.com/team',
      title: 'Team',
      publisher: 'Example',
      sourceType: 'firm_site',
      retrievedAt: NOW,
      rightsClass: 'public_fact',
      redistributionStatus: 'allowed',
      createdAt: NOW,
      updatedAt: NOW,
    });
    repository.upsertFirm({
      id: 'firm-public',
      name: 'Public Ventures',
      website: 'https://example.com',
      investorType: 'vc_firm',
      isPublic: true,
      contributionEligible: true,
      createdAt: NOW,
      updatedAt: NOW,
    });
    repository.upsertPerson({
      id: 'person-public',
      firmId: 'firm-public',
      fullName: 'Public Partner',
      isPublic: true,
      contributionEligible: true,
      createdAt: NOW,
      updatedAt: NOW,
    });
    repository.upsertContactMethod({
      id: 'contact-work',
      personId: 'person-public',
      kind: 'work_email',
      value: 'partner@example.com',
      sourceId: 'source-public',
      visibility: 'public',
      contributionEligible: true,
      createdAt: NOW,
      updatedAt: NOW,
    });
    repository.upsertContactMethod({
      id: 'contact-private',
      personId: 'person-public',
      kind: 'personal_email',
      value: 'private-person@example.net',
      visibility: 'private',
      contributionEligible: false,
      createdAt: NOW,
      updatedAt: NOW,
    });
    repository.upsertClaim({
      id: 'claim-check',
      entityType: 'firm',
      entityId: 'firm-public',
      field: 'check_size',
      valueJson: '$250k-$1m',
      sourceId: 'source-public',
      confidence: 0.9,
      status: 'verified',
      isPublic: true,
      contributionEligible: true,
      createdAt: NOW,
      updatedAt: NOW,
    });
    repository.upsertNote({
      id: 'private-note',
      body: 'PRIVATE_FOUNDER_NOTE',
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(() =>
      repository.upsertConnectorConfig({
        id: 'unsafe-google',
        provider: 'google',
        accountLabel: 'Unsafe',
        secretRef: 'raw-oauth-token',
        scopes: ['gmail.send'],
        status: 'connected',
        createdAt: NOW,
        updatedAt: NOW,
      }),
    ).toThrow(/secretRef/i);
    repository.upsertConnectorConfig({
      id: 'google-1',
      provider: 'google',
      accountLabel: 'Founder Gmail',
      secretRef: 'keychain://SUPER_SECRET_TOKEN_REF',
      publicConfig: { clientId: 'local-client' },
      scopes: ['gmail.send'],
      status: 'connected',
      createdAt: NOW,
      updatedAt: NOW,
    });

    const options = {
      packageId: 'contribution:test',
      packageVersion: '1.0.0',
      createdAt: NOW,
      contributor: 'Test contributor',
    } as const;
    expect(() => exportContribution(SQL, core, { ...options, licenseSpdx: ' ' })).toThrow();
    const first = exportContribution(SQL, core, options);
    const second = exportContribution(SQL, core, options);
    expect(first.logicalDigestSha256).toBe(second.logicalDigestSha256);
    expect(Buffer.from(first.bytes).equals(Buffer.from(second.bytes))).toBe(true);
    expect(first.counts).toMatchObject({ firms: 1, people: 1, claims: 1, public_work_emails: 1 });

    const contribution = new SQL.Database(first.bytes);
    const tables = tableNames(contribution);
    expect(tables).toEqual([
      'claims',
      'entity_sources',
      'entity_tags',
      'firms',
      'funds',
      'package_manifest',
      'people',
      'public_work_emails',
      'sources',
      'tags',
    ]);
    expect(contribution.exec('SELECT work_email FROM public_work_emails')[0]?.values[0]?.[0]).toBe(
      'partner@example.com',
    );
    expect(contribution.exec('SELECT license_spdx FROM package_manifest')[0]?.values[0]?.[0]).toBe(
      'NOASSERTION',
    );
    const raw = Buffer.from(first.bytes).toString('latin1');
    expect(raw).not.toContain('private-person@example.net');
    expect(raw).not.toContain('PRIVATE_FOUNDER_NOTE');
    expect(raw).not.toContain('SUPER_SECRET_TOKEN_REF');
    expect(tables).not.toEqual(
      expect.arrayContaining([
        'messages',
        'send_ledger',
        'targets',
        'notes',
        'connector_configs',
        'audit_log',
      ]),
    );
    contribution.close();
    core.close();
  });
});

describe('encrypted backup', () => {
  it('round-trips the complete SQLite vault, authenticates content, and invokes hooks', async () => {
    const { vault: core } = repositoryWithFounder();
    const original = core.export();
    const events: string[] = [];
    const backup = await createEncryptedBackup(original, 'correct horse battery staple', {
      createdAt: NOW,
      scrypt: { N: 1024, r: 8, p: 1 },
      hooks: {
        beforeEncrypt: () => {
          events.push('before-encrypt');
        },
        afterEncrypt: () => {
          events.push('after-encrypt');
        },
      },
    });
    expect(Buffer.from(backup).toString('utf8')).not.toContain('Ada Founder');
    const restored = await restoreEncryptedBackup(backup, 'correct horse battery staple', {
      beforeDecrypt: () => {
        events.push('before-decrypt');
      },
      afterDecrypt: () => {
        events.push('after-decrypt');
      },
    });
    expect(Buffer.from(restored).equals(Buffer.from(original))).toBe(true);
    expect(events).toEqual(['before-encrypt', 'after-encrypt', 'before-decrypt', 'after-decrypt']);
    await expect(restoreEncryptedBackup(backup, 'this is the wrong password')).rejects.toThrow(
      /authentication failed/i,
    );
    const modified = JSON.parse(Buffer.from(backup).toString('utf8')) as Record<string, unknown>;
    modified.createdAt = LATER;
    await expect(
      restoreEncryptedBackup(Buffer.from(JSON.stringify(modified)), 'correct horse battery staple'),
    ).rejects.toThrow(/authentication failed/i);

    const reopened = new CoreVault(SQL, { bytes: restored, appliedAt: LATER });
    expect(reopened.scalar("SELECT full_name FROM founder_profiles WHERE id='founder'")).toBe(
      'Ada Founder',
    );
    expect(reopened.integrityCheck().ok).toBe(true);
    reopened.close();
    core.close();
  });
});
