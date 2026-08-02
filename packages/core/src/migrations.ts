import type { Database } from 'sql.js';

export const SCHEMA_VERSION = 9;

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial_local_vault',
    sql: `
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

CREATE TABLE founder_profiles (
  id TEXT PRIMARY KEY,
  full_name TEXT NOT NULL,
  preferred_name TEXT,
  work_email TEXT,
  company_name TEXT NOT NULL,
  company_url TEXT,
  location TEXT,
  bio TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE rounds (
  id TEXT PRIMARY KEY,
  founder_profile_id TEXT NOT NULL REFERENCES founder_profiles(id),
  name TEXT NOT NULL,
  stage TEXT NOT NULL CHECK(stage IN ('pre_seed','seed','series_a')),
  target_amount_usd INTEGER CHECK(target_amount_usd IS NULL OR target_amount_usd >= 0),
  minimum_check_usd INTEGER CHECK(minimum_check_usd IS NULL OR minimum_check_usd >= 0),
  maximum_check_usd INTEGER CHECK(maximum_check_usd IS NULL OR maximum_check_usd >= 0),
  status TEXT NOT NULL CHECK(status IN ('planning','active','paused','closed')),
  thesis TEXT,
  opened_on TEXT,
  closed_on TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(minimum_check_usd IS NULL OR maximum_check_usd IS NULL OR minimum_check_usd <= maximum_check_usd)
);

CREATE TABLE firms (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  website TEXT,
  investor_type TEXT NOT NULL,
  headquarters TEXT,
  description TEXT,
  is_public INTEGER NOT NULL DEFAULT 0 CHECK(is_public IN (0,1)),
  contribution_eligible INTEGER NOT NULL DEFAULT 0 CHECK(contribution_eligible IN (0,1)),
  origin TEXT NOT NULL CHECK(origin IN ('local','seed','import','contribution')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX firms_normalized_name_idx ON firms(normalized_name);

CREATE TABLE people (
  id TEXT PRIMARY KEY,
  firm_id TEXT REFERENCES firms(id) ON DELETE SET NULL,
  full_name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  title TEXT,
  city TEXT,
  bio TEXT,
  is_investor INTEGER NOT NULL DEFAULT 1 CHECK(is_investor IN (0,1)),
  is_public INTEGER NOT NULL DEFAULT 0 CHECK(is_public IN (0,1)),
  contribution_eligible INTEGER NOT NULL DEFAULT 0 CHECK(contribution_eligible IN (0,1)),
  origin TEXT NOT NULL CHECK(origin IN ('local','seed','import','contribution')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX people_firm_idx ON people(firm_id);
CREATE INDEX people_normalized_name_idx ON people(normalized_name);

CREATE TABLE funds (
  id TEXT PRIMARY KEY,
  firm_id TEXT NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  vintage_year INTEGER,
  size_usd INTEGER CHECK(size_usd IS NULL OR size_usd >= 0),
  announced_on TEXT,
  is_public INTEGER NOT NULL DEFAULT 0 CHECK(is_public IN (0,1)),
  contribution_eligible INTEGER NOT NULL DEFAULT 0 CHECK(contribution_eligible IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  canonical_url TEXT NOT NULL UNIQUE,
  title TEXT,
  publisher TEXT,
  source_type TEXT NOT NULL,
  retrieved_at TEXT NOT NULL,
  published_on TEXT,
  rights_class TEXT NOT NULL,
  redistribution_status TEXT NOT NULL CHECK(redistribution_status IN ('allowed','attribution_required','unknown','prohibited')),
  attribution TEXT,
  excerpt TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE claims (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL CHECK(entity_type IN ('firm','person','fund')),
  entity_id TEXT NOT NULL,
  field TEXT NOT NULL,
  value_json TEXT NOT NULL,
  source_id TEXT REFERENCES sources(id) ON DELETE SET NULL,
  confidence REAL CHECK(confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  observed_at TEXT,
  status TEXT NOT NULL CHECK(status IN ('asserted','verified','disputed','stale')),
  is_public INTEGER NOT NULL DEFAULT 0 CHECK(is_public IN (0,1)),
  contribution_eligible INTEGER NOT NULL DEFAULT 0 CHECK(contribution_eligible IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(entity_type, entity_id, field, source_id, value_json)
);
CREATE INDEX claims_entity_idx ON claims(entity_type, entity_id);
CREATE INDEX claims_source_idx ON claims(source_id);
CREATE TRIGGER claims_entity_must_exist
BEFORE INSERT ON claims
BEGIN
  SELECT CASE WHEN
    (NEW.entity_type='firm' AND NOT EXISTS(SELECT 1 FROM firms WHERE id=NEW.entity_id)) OR
    (NEW.entity_type='person' AND NOT EXISTS(SELECT 1 FROM people WHERE id=NEW.entity_id)) OR
    (NEW.entity_type='fund' AND NOT EXISTS(SELECT 1 FROM funds WHERE id=NEW.entity_id))
  THEN RAISE(ABORT, 'claim entity does not exist') END;
END;
CREATE TRIGGER claims_updated_entity_must_exist
BEFORE UPDATE OF entity_type, entity_id ON claims
BEGIN
  SELECT CASE WHEN
    (NEW.entity_type='firm' AND NOT EXISTS(SELECT 1 FROM firms WHERE id=NEW.entity_id)) OR
    (NEW.entity_type='person' AND NOT EXISTS(SELECT 1 FROM people WHERE id=NEW.entity_id)) OR
    (NEW.entity_type='fund' AND NOT EXISTS(SELECT 1 FROM funds WHERE id=NEW.entity_id))
  THEN RAISE(ABORT, 'claim entity does not exist') END;
END;

CREATE TABLE entity_sources (
  entity_type TEXT NOT NULL CHECK(entity_type IN ('firm','person','fund')),
  entity_id TEXT NOT NULL,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  source_role TEXT NOT NULL,
  evidence_granularity TEXT NOT NULL,
  is_public INTEGER NOT NULL DEFAULT 0 CHECK(is_public IN (0,1)),
  contribution_eligible INTEGER NOT NULL DEFAULT 0 CHECK(contribution_eligible IN (0,1)),
  created_at TEXT NOT NULL,
  PRIMARY KEY(entity_type, entity_id, source_id, source_role)
);
CREATE INDEX entity_sources_source_idx ON entity_sources(source_id, entity_type, entity_id);
CREATE TRIGGER entity_sources_entity_must_exist
BEFORE INSERT ON entity_sources
BEGIN
  SELECT CASE WHEN
    (NEW.entity_type='firm' AND NOT EXISTS(SELECT 1 FROM firms WHERE id=NEW.entity_id)) OR
    (NEW.entity_type='person' AND NOT EXISTS(SELECT 1 FROM people WHERE id=NEW.entity_id)) OR
    (NEW.entity_type='fund' AND NOT EXISTS(SELECT 1 FROM funds WHERE id=NEW.entity_id))
  THEN RAISE(ABORT, 'sourced entity does not exist') END;
END;

CREATE TABLE tags (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  value TEXT NOT NULL,
  normalized_value TEXT NOT NULL,
  is_public INTEGER NOT NULL DEFAULT 0 CHECK(is_public IN (0,1)),
  contribution_eligible INTEGER NOT NULL DEFAULT 0 CHECK(contribution_eligible IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(kind, normalized_value)
);

CREATE TABLE entity_tags (
  entity_type TEXT NOT NULL CHECK(entity_type IN ('firm','person','fund')),
  entity_id TEXT NOT NULL,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  source_id TEXT REFERENCES sources(id) ON DELETE SET NULL,
  is_public INTEGER NOT NULL DEFAULT 0 CHECK(is_public IN (0,1)),
  contribution_eligible INTEGER NOT NULL DEFAULT 0 CHECK(contribution_eligible IN (0,1)),
  created_at TEXT NOT NULL,
  PRIMARY KEY(entity_type, entity_id, tag_id)
);

CREATE TABLE contact_methods (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('work_email','personal_email','phone','linkedin','x','website','other')),
  value TEXT NOT NULL,
  normalized_value TEXT NOT NULL,
  label TEXT,
  source_id TEXT REFERENCES sources(id) ON DELETE SET NULL,
  visibility TEXT NOT NULL CHECK(visibility IN ('private','public')),
  contribution_eligible INTEGER NOT NULL DEFAULT 0 CHECK(contribution_eligible IN (0,1)),
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK(is_primary IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(person_id, kind, normalized_value),
  CHECK(contribution_eligible = 0 OR (kind = 'work_email' AND visibility = 'public' AND source_id IS NOT NULL))
);
CREATE INDEX contact_methods_normalized_idx ON contact_methods(kind, normalized_value);

CREATE TRIGGER entity_tags_entity_must_exist
BEFORE INSERT ON entity_tags
BEGIN
  SELECT CASE WHEN
    (NEW.entity_type='firm' AND NOT EXISTS(SELECT 1 FROM firms WHERE id=NEW.entity_id)) OR
    (NEW.entity_type='person' AND NOT EXISTS(SELECT 1 FROM people WHERE id=NEW.entity_id)) OR
    (NEW.entity_type='fund' AND NOT EXISTS(SELECT 1 FROM funds WHERE id=NEW.entity_id))
  THEN RAISE(ABORT, 'tagged entity does not exist') END;
END;

CREATE TABLE targets (
  id TEXT PRIMARY KEY,
  round_id TEXT NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  firm_id TEXT REFERENCES firms(id) ON DELETE SET NULL,
  person_id TEXT REFERENCES people(id) ON DELETE SET NULL,
  stage TEXT NOT NULL CHECK(stage IN ('research','qualified','intro_requested','ready_to_contact','contacted','meeting','diligence','partner_meeting','term_sheet','passed','committed')),
  priority INTEGER NOT NULL CHECK(priority BETWEEN 0 AND 100),
  fit_score REAL CHECK(fit_score IS NULL OR (fit_score >= 0 AND fit_score <= 100)),
  owner_note TEXT,
  next_action_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(firm_id IS NOT NULL OR person_id IS NOT NULL),
  UNIQUE(round_id, firm_id, person_id)
);
CREATE INDEX targets_round_stage_idx ON targets(round_id, stage, priority DESC);

CREATE TABLE pipeline_events (
  id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
  from_stage TEXT,
  to_stage TEXT NOT NULL,
  reason TEXT,
  occurred_at TEXT NOT NULL
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  round_id TEXT REFERENCES rounds(id) ON DELETE SET NULL,
  target_id TEXT REFERENCES targets(id) ON DELETE SET NULL,
  recipient_person_id TEXT REFERENCES people(id) ON DELETE SET NULL,
  recipient_address TEXT NOT NULL,
  recipient_normalized TEXT NOT NULL,
  subject TEXT NOT NULL,
  body_text TEXT NOT NULL,
  attachments_json TEXT NOT NULL DEFAULT '[]',
  state TEXT NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','approved','reserved','sent','failed_safe','cancelled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX messages_target_idx ON messages(target_id);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  content_sha256 TEXT NOT NULL,
  approved_by TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  expires_at TEXT,
  status TEXT NOT NULL CHECK(status IN ('active','used','revoked','expired')),
  revoked_at TEXT
);
CREATE INDEX approvals_message_hash_idx ON approvals(message_id, content_sha256);
CREATE UNIQUE INDEX approvals_one_active_per_message_idx ON approvals(message_id) WHERE status = 'active';

CREATE TABLE suppressions (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK(scope IN ('global','email','domain','person','firm')),
  value TEXT NOT NULL,
  normalized_value TEXT NOT NULL,
  reason TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('founder','unsubscribe','bounce','complaint','policy','import')),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(scope, normalized_value)
);
CREATE INDEX suppressions_lookup_idx ON suppressions(active, scope, normalized_value);

CREATE TABLE send_ledger (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL UNIQUE REFERENCES messages(id),
  approval_id TEXT NOT NULL REFERENCES approvals(id),
  approval_sha256 TEXT NOT NULL,
  recipient_person_id TEXT NOT NULL REFERENCES people(id),
  recipient_address TEXT NOT NULL,
  recipient_normalized TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_message_id TEXT,
  dispatch_status TEXT NOT NULL CHECK(dispatch_status IN ('reserved','dispatching','sent','ambiguous','failed_pre_dispatch')),
  reserved_at TEXT NOT NULL,
  dispatch_started_at TEXT,
  completed_at TEXT,
  error_code TEXT,
  error_detail TEXT
);
CREATE UNIQUE INDEX send_ledger_recipient_address_once_idx ON send_ledger(recipient_normalized);
CREATE UNIQUE INDEX send_ledger_recipient_person_once_idx ON send_ledger(recipient_person_id);
CREATE UNIQUE INDEX send_ledger_provider_message_idx ON send_ledger(provider, provider_message_id) WHERE provider_message_id IS NOT NULL;

CREATE TRIGGER messages_revoke_approval_after_content_update
AFTER UPDATE OF recipient_address, recipient_normalized, subject, body_text, attachments_json ON messages
BEGIN
  UPDATE approvals SET status = 'revoked', revoked_at = NEW.updated_at
    WHERE message_id = NEW.id AND status = 'active';
  UPDATE messages SET state = 'draft' WHERE id = NEW.id AND state = 'approved';
END;

CREATE TRIGGER send_ledger_requires_active_matching_approval
BEFORE INSERT ON send_ledger
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM approvals a
    WHERE a.id = NEW.approval_id AND a.message_id = NEW.message_id
      AND a.content_sha256 = NEW.approval_sha256 AND a.status = 'active'
      AND (a.expires_at IS NULL OR a.expires_at > NEW.reserved_at)
  ) THEN RAISE(ABORT, 'active matching approval required') END;
END;

CREATE TRIGGER send_ledger_blocks_suppressed_recipient
BEFORE INSERT ON send_ledger
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM suppressions s
    WHERE s.active = 1 AND (
      s.scope = 'global'
      OR (s.scope = 'email' AND s.normalized_value = NEW.recipient_normalized)
      OR (s.scope = 'domain' AND s.normalized_value = substr(NEW.recipient_normalized, instr(NEW.recipient_normalized, '@') + 1))
      OR (s.scope = 'person' AND NEW.recipient_person_id IS NOT NULL AND s.normalized_value = NEW.recipient_person_id)
      OR (s.scope = 'firm' AND NEW.recipient_person_id IS NOT NULL AND s.normalized_value = (SELECT p.firm_id FROM people p WHERE p.id = NEW.recipient_person_id))
    )
  ) THEN RAISE(ABORT, 'recipient is suppressed') END;
END;

CREATE TRIGGER send_ledger_marks_approval_used
AFTER INSERT ON send_ledger
BEGIN
  UPDATE approvals SET status = 'used' WHERE id = NEW.approval_id;
  UPDATE messages SET state = 'reserved', updated_at = NEW.reserved_at WHERE id = NEW.message_id;
END;

CREATE TABLE meetings (
  id TEXT PRIMARY KEY,
  round_id TEXT REFERENCES rounds(id) ON DELETE SET NULL,
  target_id TEXT REFERENCES targets(id) ON DELETE SET NULL,
  external_calendar_id TEXT,
  title TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  location TEXT,
  attendee_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'confirmed' CHECK(status IN ('tentative','confirmed','cancelled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  round_id TEXT REFERENCES rounds(id) ON DELETE SET NULL,
  target_id TEXT REFERENCES targets(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  description TEXT,
  due_at TEXT,
  status TEXT NOT NULL CHECK(status IN ('open','done','cancelled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE notes (
  id TEXT PRIMARY KEY,
  round_id TEXT REFERENCES rounds(id) ON DELETE SET NULL,
  target_id TEXT REFERENCES targets(id) ON DELETE SET NULL,
  person_id TEXT REFERENCES people(id) ON DELETE SET NULL,
  firm_id TEXT REFERENCES firms(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE knowledge_items (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  source_url TEXT,
  content_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE lists (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE list_members (
  list_id TEXT NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL CHECK(entity_type IN ('firm','person','fund','target')),
  entity_id TEXT NOT NULL,
  rank INTEGER,
  added_at TEXT NOT NULL,
  PRIMARY KEY(list_id, entity_type, entity_id)
);
CREATE TRIGGER list_member_entity_must_exist
BEFORE INSERT ON list_members
BEGIN
  SELECT CASE WHEN
    (NEW.entity_type='firm' AND NOT EXISTS(SELECT 1 FROM firms WHERE id=NEW.entity_id)) OR
    (NEW.entity_type='person' AND NOT EXISTS(SELECT 1 FROM people WHERE id=NEW.entity_id)) OR
    (NEW.entity_type='fund' AND NOT EXISTS(SELECT 1 FROM funds WHERE id=NEW.entity_id)) OR
    (NEW.entity_type='target' AND NOT EXISTS(SELECT 1 FROM targets WHERE id=NEW.entity_id))
  THEN RAISE(ABORT, 'list member entity does not exist') END;
END;

CREATE TABLE connector_configs (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK(provider IN ('google','microsoft','codex','claude','custom')),
  account_label TEXT NOT NULL,
  public_config_json TEXT NOT NULL DEFAULT '{}',
  secret_ref TEXT NOT NULL CHECK(
    secret_ref LIKE 'keychain://%' OR secret_ref LIKE 'credential-manager://%' OR secret_ref LIKE 'secret-service://%'
    OR secret_ref LIKE 'secure-store://%' OR secret_ref LIKE 'external-agent://%' OR secret_ref LIKE 'memory://%'
  ),
  scopes_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL CHECK(status IN ('unconfigured','connected','expired','error','disabled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(provider, account_label)
);

CREATE TABLE agent_runs (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  model TEXT,
  purpose TEXT NOT NULL,
  context_policy_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed','cancelled')),
  started_at TEXT,
  completed_at TEXT,
  error_detail TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE agent_proposals (
  id TEXT PRIMARY KEY,
  agent_run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  proposal_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','accepted','rejected','expired')),
  reviewed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK(actor_type IN ('founder','system','connector','agent')),
  actor_id TEXT,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX audit_log_time_idx ON audit_log(occurred_at DESC);

CREATE TABLE seed_imports (
  package_id TEXT PRIMARY KEY,
  package_version TEXT NOT NULL,
  logical_digest_sha256 TEXT NOT NULL,
  source_file_sha256 TEXT NOT NULL,
  signature_status TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  firm_count INTEGER NOT NULL,
  person_count INTEGER NOT NULL,
  source_count INTEGER NOT NULL,
  CHECK(signature_status IN ('verified','unsigned_research'))
);
`,
  },
  {
    version: 2,
    name: 'secure_secrets_knowledge_policy_and_agent_context_grants',
    sql: `
ALTER TABLE knowledge_items ADD COLUMN share_policy TEXT NOT NULL DEFAULT 'internal'
  CHECK(share_policy IN ('internal','safe_for_outreach','meeting_only','diligence_only'));

CREATE TABLE secure_secrets (
  key TEXT PRIMARY KEY,
  ciphertext BLOB NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE agent_context_grants (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK(provider IN ('codex','claude')),
  context_class TEXT NOT NULL CHECK(context_class IN ('round','company','investors','activity')),
  granted_at TEXT NOT NULL,
  revoked_at TEXT,
  UNIQUE(provider,context_class)
);
CREATE INDEX agent_context_grants_active_idx ON agent_context_grants(provider,context_class)
  WHERE revoked_at IS NULL;
`,
  },
  {
    version: 3,
    name: 'round_economics_and_meeting_context',
    sql: `
ALTER TABLE targets ADD COLUMN expected_check_usd INTEGER
  CHECK(expected_check_usd IS NULL OR expected_check_usd >= 0);

ALTER TABLE meetings ADD COLUMN agenda TEXT;
ALTER TABLE meetings ADD COLUMN notes TEXT;
CREATE UNIQUE INDEX meetings_external_calendar_id_unique_idx ON meetings(external_calendar_id)
  WHERE external_calendar_id IS NOT NULL;
`,
  },
  {
    version: 4,
    name: 'mail_relationships_communication_policy_and_tamper_evident_audit',
    sql: `
ALTER TABLE send_ledger ADD COLUMN provider_thread_id TEXT;

CREATE TABLE mail_events (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK(provider IN ('google','microsoft')),
  provider_message_id TEXT NOT NULL,
  provider_thread_id TEXT,
  internet_message_id TEXT,
  person_id TEXT REFERENCES people(id) ON DELETE SET NULL,
  direction TEXT NOT NULL CHECK(direction IN ('inbound','outbound')),
  kind TEXT NOT NULL CHECK(kind IN ('message','reply','bounce','complaint')),
  sender_address TEXT NOT NULL,
  recipient_addresses_json TEXT NOT NULL DEFAULT '[]',
  subject TEXT NOT NULL DEFAULT '',
  occurred_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  reviewed_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(provider,provider_message_id)
);
CREATE INDEX mail_events_person_time_idx ON mail_events(person_id,occurred_at DESC);
CREATE INDEX mail_events_thread_idx ON mail_events(provider,provider_thread_id);

CREATE TABLE communication_settings (
  id TEXT PRIMARY KEY CHECK(id='global'),
  sending_paused INTEGER NOT NULL DEFAULT 0 CHECK(sending_paused IN (0,1)),
  daily_send_limit INTEGER NOT NULL DEFAULT 10 CHECK(daily_send_limit BETWEEN 1 AND 50),
  updated_at TEXT NOT NULL
);
INSERT INTO communication_settings(id,sending_paused,daily_send_limit,updated_at)
  VALUES ('global',0,10,strftime('%Y-%m-%dT%H:%M:%fZ','now'));

CREATE TRIGGER send_ledger_blocks_paused_sending
BEFORE INSERT ON send_ledger
BEGIN
  SELECT CASE WHEN (SELECT sending_paused FROM communication_settings WHERE id='global')=1
    THEN RAISE(ABORT,'all sending is paused') END;
END;

CREATE TRIGGER send_ledger_enforces_daily_limit
BEFORE INSERT ON send_ledger
BEGIN
  SELECT CASE WHEN (
    SELECT COUNT(*) FROM send_ledger
    WHERE substr(reserved_at,1,10)=substr(NEW.reserved_at,1,10)
      AND dispatch_status!='failed_pre_dispatch'
  ) >= (SELECT daily_send_limit FROM communication_settings WHERE id='global')
    THEN RAISE(ABORT,'daily founder send limit reached') END;
END;

CREATE TRIGGER send_ledger_blocks_synced_prior_outreach
BEFORE INSERT ON send_ledger
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM mail_events
    WHERE direction='outbound' AND (
      person_id=NEW.recipient_person_id
      OR EXISTS (
        SELECT 1 FROM json_each(recipient_addresses_json)
        WHERE lower(json_extract(value,'$.email'))=NEW.recipient_normalized
      )
    )
  ) THEN RAISE(ABORT,'prior outbound mailbox history blocks another initial') END;
END;

CREATE TRIGGER mail_event_suppresses_bounce_or_complaint
AFTER INSERT ON mail_events
WHEN NEW.person_id IS NOT NULL AND NEW.kind IN ('bounce','complaint')
BEGIN
  INSERT INTO suppressions(id,scope,value,normalized_value,reason,source,active,created_at,updated_at)
  VALUES (
    'suppression:mail:' || NEW.provider || ':' || NEW.provider_message_id,
    'person',NEW.person_id,NEW.person_id,
    CASE NEW.kind WHEN 'bounce' THEN 'Provider mailbox reported a bounce.' ELSE 'Provider mailbox reported a complaint.' END,
    CASE NEW.kind WHEN 'bounce' THEN 'bounce' ELSE 'complaint' END,
    1,NEW.created_at,NEW.created_at
  )
  ON CONFLICT(scope,normalized_value) DO UPDATE SET
    reason=excluded.reason,source=excluded.source,active=1,updated_at=excluded.updated_at;
END;

CREATE TABLE audit_chain (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  audit_id INTEGER NOT NULL UNIQUE REFERENCES audit_log(id) ON DELETE RESTRICT,
  previous_hash TEXT,
  entry_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  CHECK(previous_hash IS NULL OR length(previous_hash)=64),
  CHECK(length(entry_hash)=64)
);

CREATE TRIGGER audit_log_is_append_only_update
BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT,'audit log is append-only'); END;
CREATE TRIGGER audit_log_is_append_only_delete
BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT,'audit log is append-only'); END;
CREATE TRIGGER audit_chain_is_append_only_update
BEFORE UPDATE ON audit_chain BEGIN SELECT RAISE(ABORT,'audit chain is append-only'); END;
CREATE TRIGGER audit_chain_is_append_only_delete
BEFORE DELETE ON audit_chain BEGIN SELECT RAISE(ABORT,'audit chain is append-only'); END;
`,
  },
  {
    version: 5,
    name: 'exact_delivery_identity_and_global_email_ownership',
    sql: `
ALTER TABLE messages ADD COLUMN provider TEXT CHECK(provider IS NULL OR provider IN ('google','microsoft'));
ALTER TABLE messages ADD COLUMN sender_address TEXT;
ALTER TABLE messages ADD COLUMN sender_normalized TEXT;
ALTER TABLE messages ADD COLUMN message_kind TEXT
  CHECK(message_kind IS NULL OR message_kind IN ('initial','follow_up','intro_request','reply'));
ALTER TABLE messages ADD COLUMN provider_thread_id TEXT;

ALTER TABLE approvals ADD COLUMN provider TEXT CHECK(provider IS NULL OR provider IN ('google','microsoft'));
ALTER TABLE approvals ADD COLUMN sender_address TEXT;
ALTER TABLE approvals ADD COLUMN sender_normalized TEXT;
ALTER TABLE approvals ADD COLUMN message_kind TEXT
  CHECK(message_kind IS NULL OR message_kind IN ('initial','follow_up','intro_request','reply'));
ALTER TABLE approvals ADD COLUMN provider_thread_id TEXT;

ALTER TABLE send_ledger ADD COLUMN sender_address TEXT;
ALTER TABLE send_ledger ADD COLUMN sender_normalized TEXT;
ALTER TABLE send_ledger ADD COLUMN message_kind TEXT
  CHECK(message_kind IS NULL OR message_kind IN ('initial','follow_up','intro_request','reply'));
ALTER TABLE send_ledger ADD COLUMN approved_provider_thread_id TEXT;

-- Preserve the historical routing metadata for already-sent records. Old
-- active approvals did not cover these fields and therefore fail closed.
UPDATE messages SET
  provider=COALESCE(
    (SELECT sl.provider FROM send_ledger sl WHERE sl.message_id=messages.id),
    (SELECT json_extract(a.detail_json,'$.provider') FROM audit_log a
      WHERE a.entity_type='message' AND a.entity_id=messages.id
        AND a.action='message.provider_selected' ORDER BY a.id DESC LIMIT 1),
    'google'
  ),
  message_kind=COALESCE(
    (SELECT json_extract(a.detail_json,'$.kind') FROM audit_log a
      WHERE a.entity_type='message' AND a.entity_id=messages.id
        AND a.action='message.provider_selected' ORDER BY a.id DESC LIMIT 1),
    'initial'
  );
UPDATE messages SET
  sender_address=COALESCE(
    (SELECT c.account_label FROM connector_configs c
      WHERE c.provider=messages.provider AND c.status='connected' ORDER BY c.updated_at DESC LIMIT 1),
    (SELECT f.work_email FROM founder_profiles f WHERE f.work_email IS NOT NULL ORDER BY f.created_at LIMIT 1)
  );
UPDATE messages SET sender_normalized=lower(trim(sender_address)) WHERE sender_address IS NOT NULL;
UPDATE approvals SET status='revoked',revoked_at=COALESCE(revoked_at,approved_at) WHERE status='active';
UPDATE messages SET state='draft' WHERE state='approved';
UPDATE send_ledger SET
  sender_address=(SELECT m.sender_address FROM messages m WHERE m.id=send_ledger.message_id),
  sender_normalized=(SELECT m.sender_normalized FROM messages m WHERE m.id=send_ledger.message_id),
  message_kind=(SELECT m.message_kind FROM messages m WHERE m.id=send_ledger.message_id),
  approved_provider_thread_id=(SELECT m.provider_thread_id FROM messages m WHERE m.id=send_ledger.message_id);

-- A normalized email is a lifetime identity key. Ambiguous pre-v5 ownership is
-- suppressed before deterministic de-duplication so migration never makes an
-- unsafe guess about which duplicate person should receive outreach.
INSERT OR IGNORE INTO suppressions(
  id,scope,value,normalized_value,reason,source,active,created_at,updated_at
)
SELECT
  'suppression:ambiguous-email:' || min(id),
  'email',normalized_value,normalized_value,
  'Multiple people previously owned this email; resolve the identity before contact.',
  'policy',1,min(created_at),max(updated_at)
FROM contact_methods
WHERE kind IN ('work_email','personal_email')
GROUP BY normalized_value
HAVING count(DISTINCT person_id)>1;

DELETE FROM contact_methods
WHERE kind IN ('work_email','personal_email') AND id NOT IN (
  SELECT id FROM (
    SELECT id,row_number() OVER (
      PARTITION BY normalized_value
      ORDER BY CASE kind WHEN 'work_email' THEN 0 ELSE 1 END,is_primary DESC,created_at,id
    ) AS ownership_rank
    FROM contact_methods WHERE kind IN ('work_email','personal_email')
  ) WHERE ownership_rank=1
);

CREATE UNIQUE INDEX contact_methods_email_global_owner_idx
  ON contact_methods(normalized_value)
  WHERE kind IN ('work_email','personal_email');

CREATE TABLE person_email_identities (
  normalized_email TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES people(id) ON DELETE RESTRICT,
  claimed_at TEXT NOT NULL
);
INSERT INTO person_email_identities(normalized_email,person_id,claimed_at)
SELECT normalized_value,person_id,created_at FROM contact_methods
WHERE kind IN ('work_email','personal_email');

CREATE TRIGGER contact_email_owner_insert_guard
BEFORE INSERT ON contact_methods
WHEN NEW.kind IN ('work_email','personal_email')
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM person_email_identities
    WHERE normalized_email=NEW.normalized_value AND person_id!=NEW.person_id
  ) THEN RAISE(ABORT,'normalized email already belongs to another person') END;
END;

CREATE TRIGGER contact_email_owner_insert_claim
AFTER INSERT ON contact_methods
WHEN NEW.kind IN ('work_email','personal_email')
BEGIN
  INSERT OR IGNORE INTO person_email_identities(normalized_email,person_id,claimed_at)
  VALUES (NEW.normalized_value,NEW.person_id,NEW.created_at);
END;

CREATE TRIGGER contact_email_owner_update_guard
BEFORE UPDATE OF person_id,kind,normalized_value ON contact_methods
WHEN NEW.kind IN ('work_email','personal_email')
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM person_email_identities
    WHERE normalized_email=NEW.normalized_value AND person_id!=NEW.person_id
  ) THEN RAISE(ABORT,'normalized email already belongs to another person') END;
END;

CREATE TRIGGER contact_email_owner_update_claim
AFTER UPDATE OF person_id,kind,normalized_value ON contact_methods
WHEN NEW.kind IN ('work_email','personal_email')
BEGIN
  INSERT OR IGNORE INTO person_email_identities(normalized_email,person_id,claimed_at)
  VALUES (NEW.normalized_value,NEW.person_id,NEW.updated_at);
END;

CREATE TRIGGER messages_revoke_approval_after_delivery_identity_update
AFTER UPDATE OF provider,sender_address,sender_normalized,message_kind,provider_thread_id ON messages
BEGIN
  UPDATE approvals SET status='revoked',revoked_at=NEW.updated_at
    WHERE message_id=NEW.id AND status='active';
  UPDATE messages SET state='draft' WHERE id=NEW.id AND state='approved';
END;

CREATE TRIGGER approvals_require_exact_delivery_identity
BEFORE INSERT ON approvals
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM messages m WHERE m.id=NEW.message_id
      AND m.provider=NEW.provider
      AND m.sender_address=NEW.sender_address
      AND m.sender_normalized=NEW.sender_normalized
      AND m.sender_normalized=lower(trim(m.sender_address))
      AND m.message_kind=NEW.message_kind
      AND COALESCE(m.provider_thread_id,'')=COALESCE(NEW.provider_thread_id,'')
      AND m.provider IN ('google','microsoft')
      AND m.message_kind IN ('initial','follow_up','intro_request','reply')
  ) THEN RAISE(ABORT,'approval requires exact delivery identity') END;
END;

CREATE TRIGGER approvals_delivery_identity_is_immutable
BEFORE UPDATE OF message_id,content_sha256,provider,sender_address,sender_normalized,message_kind,provider_thread_id ON approvals
BEGIN
  SELECT RAISE(ABORT,'approved delivery identity is immutable');
END;

CREATE TRIGGER send_ledger_requires_exact_delivery_identity
BEFORE INSERT ON send_ledger
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM approvals a JOIN messages m ON m.id=a.message_id
    WHERE a.id=NEW.approval_id AND a.message_id=NEW.message_id
      AND a.status='active' AND a.content_sha256=NEW.approval_sha256
      AND a.provider=NEW.provider AND m.provider=NEW.provider
      AND a.sender_address=NEW.sender_address AND m.sender_address=NEW.sender_address
      AND a.sender_normalized=NEW.sender_normalized AND m.sender_normalized=NEW.sender_normalized
      AND NEW.sender_normalized=lower(trim(NEW.sender_address))
      AND a.message_kind=NEW.message_kind AND m.message_kind=NEW.message_kind
      AND COALESCE(a.provider_thread_id,'')=COALESCE(NEW.approved_provider_thread_id,'')
      AND COALESCE(m.provider_thread_id,'')=COALESCE(NEW.approved_provider_thread_id,'')
      AND m.recipient_person_id=NEW.recipient_person_id
      AND m.recipient_normalized=NEW.recipient_normalized
  ) THEN RAISE(ABORT,'send reservation delivery identity does not match approval') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM connector_configs c
    WHERE c.provider=NEW.provider AND c.status='connected'
      AND lower(trim(c.account_label))=NEW.sender_normalized
  ) THEN RAISE(ABORT,'approved sender is not the currently connected account') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM person_email_identities i
    WHERE i.normalized_email=NEW.recipient_normalized AND i.person_id=NEW.recipient_person_id
  ) THEN RAISE(ABORT,'recipient email is not owned by the canonical person') END;
END;

CREATE TRIGGER send_ledger_delivery_identity_is_immutable
BEFORE UPDATE OF message_id,approval_id,approval_sha256,recipient_person_id,recipient_address,
  recipient_normalized,provider,sender_address,sender_normalized,message_kind,approved_provider_thread_id
ON send_ledger
BEGIN
  SELECT RAISE(ABORT,'send reservation delivery identity is immutable');
END;

CREATE TRIGGER connector_account_change_revokes_approvals
AFTER UPDATE OF provider,account_label,status ON connector_configs
BEGIN
  UPDATE approvals SET status='revoked',revoked_at=NEW.updated_at
  WHERE status='active' AND provider=OLD.provider AND NOT EXISTS (
    SELECT 1 FROM connector_configs c WHERE c.provider=approvals.provider
      AND c.status='connected' AND lower(trim(c.account_label))=approvals.sender_normalized
  );
  UPDATE messages SET state='draft',updated_at=NEW.updated_at
  WHERE state='approved' AND NOT EXISTS (
    SELECT 1 FROM approvals a WHERE a.message_id=messages.id AND a.status='active'
  );
END;

CREATE TRIGGER connector_account_delete_revokes_approvals
AFTER DELETE ON connector_configs
BEGIN
  UPDATE approvals SET status='revoked',revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE status='active' AND provider=OLD.provider AND NOT EXISTS (
    SELECT 1 FROM connector_configs c WHERE c.provider=approvals.provider
      AND c.status='connected' AND lower(trim(c.account_label))=approvals.sender_normalized
  );
  UPDATE messages SET state='draft',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE state='approved' AND NOT EXISTS (
    SELECT 1 FROM approvals a WHERE a.message_id=messages.id AND a.status='active'
  );
END;
`,
  },
  {
    version: 6,
    name: 'complete_mailbox_reconciliation_and_automatic_suppression_safety',
    sql: `
DROP TRIGGER mail_event_suppresses_bounce_or_complaint;
DROP TRIGGER send_ledger_blocks_synced_prior_outreach;
DROP INDEX mail_events_person_time_idx;
DROP INDEX mail_events_thread_idx;

CREATE TABLE mail_events_v6 (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK(provider IN ('google','microsoft')),
  provider_message_id TEXT NOT NULL,
  provider_thread_id TEXT,
  internet_message_id TEXT,
  person_id TEXT REFERENCES people(id) ON DELETE SET NULL,
  direction TEXT NOT NULL CHECK(direction IN ('inbound','outbound')),
  kind TEXT NOT NULL CHECK(kind IN ('message','reply','bounce','hard_bounce','complaint','unsubscribe')),
  sender_address TEXT NOT NULL,
  recipient_addresses_json TEXT NOT NULL DEFAULT '[]',
  subject TEXT NOT NULL DEFAULT '',
  occurred_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  reviewed_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(provider,provider_message_id)
);
INSERT INTO mail_events_v6(
  id,provider,provider_message_id,provider_thread_id,internet_message_id,person_id,
  direction,kind,sender_address,recipient_addresses_json,subject,occurred_at,
  metadata_json,reviewed_at,created_at
)
SELECT id,provider,provider_message_id,provider_thread_id,internet_message_id,person_id,
  direction,kind,sender_address,recipient_addresses_json,subject,occurred_at,
  metadata_json,reviewed_at,created_at
FROM mail_events;
DROP TABLE mail_events;
ALTER TABLE mail_events_v6 RENAME TO mail_events;
CREATE INDEX mail_events_person_time_idx ON mail_events(person_id,occurred_at DESC);
CREATE INDEX mail_events_thread_idx ON mail_events(provider,provider_thread_id);

CREATE TRIGGER send_ledger_blocks_synced_prior_outreach
BEFORE INSERT ON send_ledger
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM mail_events
    WHERE direction='outbound' AND (
      person_id=NEW.recipient_person_id
      OR EXISTS (
        SELECT 1 FROM json_each(recipient_addresses_json)
        WHERE lower(json_extract(value,'$.email'))=NEW.recipient_normalized
      )
    )
  ) THEN RAISE(ABORT,'prior outbound mailbox history blocks another initial') END;
END;

CREATE TRIGGER mail_event_creates_automatic_suppression_insert
AFTER INSERT ON mail_events
WHEN NEW.person_id IS NOT NULL AND NEW.kind IN ('hard_bounce','complaint','unsubscribe')
BEGIN
  INSERT INTO suppressions(id,scope,value,normalized_value,reason,source,active,created_at,updated_at)
  VALUES (
    'suppression:mail:' || NEW.provider || ':' || NEW.provider_message_id,
    'person',NEW.person_id,NEW.person_id,
    CASE NEW.kind
      WHEN 'hard_bounce' THEN 'Provider mailbox reported a hard bounce.'
      WHEN 'unsubscribe' THEN 'The recipient requested no further email.'
      ELSE 'Provider mailbox reported a complaint.'
    END,
    CASE NEW.kind WHEN 'hard_bounce' THEN 'bounce' WHEN 'unsubscribe' THEN 'unsubscribe' ELSE 'complaint' END,
    1,NEW.created_at,NEW.created_at
  )
  ON CONFLICT(scope,normalized_value) DO UPDATE SET
    reason=excluded.reason,source=excluded.source,active=1,updated_at=excluded.updated_at;
END;

CREATE TRIGGER mail_event_creates_automatic_suppression_update
AFTER UPDATE OF person_id,kind ON mail_events
WHEN NEW.person_id IS NOT NULL AND NEW.kind IN ('hard_bounce','complaint','unsubscribe')
BEGIN
  INSERT INTO suppressions(id,scope,value,normalized_value,reason,source,active,created_at,updated_at)
  VALUES (
    'suppression:mail:' || NEW.provider || ':' || NEW.provider_message_id,
    'person',NEW.person_id,NEW.person_id,
    CASE NEW.kind
      WHEN 'hard_bounce' THEN 'Provider mailbox reported a hard bounce.'
      WHEN 'unsubscribe' THEN 'The recipient requested no further email.'
      ELSE 'Provider mailbox reported a complaint.'
    END,
    CASE NEW.kind WHEN 'hard_bounce' THEN 'bounce' WHEN 'unsubscribe' THEN 'unsubscribe' ELSE 'complaint' END,
    1,NEW.created_at,NEW.created_at
  )
  ON CONFLICT(scope,normalized_value) DO UPDATE SET
    reason=excluded.reason,source=excluded.source,active=1,updated_at=excluded.updated_at;
END;

CREATE TRIGGER automatic_suppression_is_not_deactivatable
BEFORE UPDATE OF source,active ON suppressions
WHEN OLD.source IN ('unsubscribe','bounce','complaint')
  AND (NEW.source NOT IN ('unsubscribe','bounce','complaint') OR NEW.active!=1)
BEGIN
  SELECT RAISE(ABORT,'automatic safety suppressions cannot be deactivated');
END;

CREATE TRIGGER automatic_suppression_is_not_deletable
BEFORE DELETE ON suppressions
WHEN OLD.source IN ('unsubscribe','bounce','complaint')
BEGIN
  SELECT RAISE(ABORT,'automatic safety suppressions cannot be deleted');
END;

CREATE TRIGGER send_ledger_allows_initial_only
BEFORE INSERT ON send_ledger
WHEN COALESCE(NEW.message_kind,'')!='initial'
BEGIN
  SELECT RAISE(ABORT,'Outreachr 0.1 sends initial outreach only');
END;
`,
  },
  {
    version: 7,
    name: 'founder_footer_and_rate_limit_enforcement',
    sql: `
ALTER TABLE communication_settings ADD COLUMN postal_address TEXT
  CHECK(postal_address IS NULL OR (length(trim(postal_address)) BETWEEN 1 AND 1000));
ALTER TABLE communication_settings ADD COLUMN opt_out_text TEXT NOT NULL
  DEFAULT 'If you prefer no further email from me, reply "opt out" and I will not contact you again.'
  CHECK(length(trim(opt_out_text)) BETWEEN 1 AND 1000);
ALTER TABLE communication_settings ADD COLUMN hourly_send_limit INTEGER NOT NULL DEFAULT 3
  CHECK(hourly_send_limit BETWEEN 1 AND 20);
ALTER TABLE communication_settings ADD COLUMN recipient_domain_daily_limit INTEGER NOT NULL DEFAULT 2
  CHECK(recipient_domain_daily_limit BETWEEN 1 AND 20);
ALTER TABLE communication_settings ADD COLUMN recipient_domain_cooldown_minutes INTEGER NOT NULL DEFAULT 30
  CHECK(recipient_domain_cooldown_minutes BETWEEN 1 AND 1440);

-- A pre-v7 approval never proved that the current founder-controlled footer
-- was visibly present. Migration therefore fails closed without deleting the
-- draft or any historical approval record.
UPDATE approvals
SET status='revoked',revoked_at=COALESCE(revoked_at,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
WHERE status='active';
UPDATE messages SET state='draft',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE state='approved';

CREATE TRIGGER communication_policy_change_revokes_approvals
AFTER UPDATE OF sending_paused,daily_send_limit,postal_address,opt_out_text,
  hourly_send_limit,recipient_domain_daily_limit,recipient_domain_cooldown_minutes
ON communication_settings
WHEN OLD.sending_paused!=NEW.sending_paused
  OR OLD.daily_send_limit!=NEW.daily_send_limit
  OR COALESCE(OLD.postal_address,'')!=COALESCE(NEW.postal_address,'')
  OR OLD.opt_out_text!=NEW.opt_out_text
  OR OLD.hourly_send_limit!=NEW.hourly_send_limit
  OR OLD.recipient_domain_daily_limit!=NEW.recipient_domain_daily_limit
  OR OLD.recipient_domain_cooldown_minutes!=NEW.recipient_domain_cooldown_minutes
BEGIN
  UPDATE approvals SET status='revoked',revoked_at=NEW.updated_at WHERE status='active';
  UPDATE messages SET state='draft',updated_at=NEW.updated_at WHERE state='approved';
END;

CREATE TRIGGER approvals_require_visible_compliance_footer
BEFORE INSERT ON approvals
BEGIN
  SELECT CASE WHEN trim(COALESCE((
    SELECT postal_address FROM communication_settings WHERE id='global'
  ),''))=''
    THEN RAISE(ABORT,'founder postal address is required before approval') END;
  SELECT CASE WHEN trim(COALESCE((
    SELECT opt_out_text FROM communication_settings WHERE id='global'
  ),''))=''
    THEN RAISE(ABORT,'opt-out wording is required before approval') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM messages m,communication_settings c
    WHERE m.id=NEW.message_id AND c.id='global'
      AND instr(m.body_text,c.postal_address)>0
      AND instr(m.body_text,c.opt_out_text)>0
  ) THEN RAISE(ABORT,'message body must visibly contain the exact configured compliance footer') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM messages m WHERE m.id=NEW.message_id AND m.message_kind='initial'
      AND (m.provider_thread_id IS NOT NULL OR NOT json_valid(m.attachments_json)
        OR json_type(m.attachments_json)!='array' OR json_array_length(m.attachments_json)!=0)
  ) THEN RAISE(ABORT,'initial outreach cannot use a provider thread or attachments') END;
END;

CREATE TRIGGER send_ledger_requires_visible_compliance_footer
BEFORE INSERT ON send_ledger
BEGIN
  SELECT CASE WHEN COALESCE(NEW.message_kind,'')!='initial'
    THEN RAISE(ABORT,'Outreachr 0.1 sends initial outreach only') END;
  SELECT CASE WHEN trim(COALESCE((
    SELECT postal_address FROM communication_settings WHERE id='global'
  ),''))=''
    THEN RAISE(ABORT,'founder postal address is required before sending') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM messages m,communication_settings c
    WHERE m.id=NEW.message_id AND c.id='global'
      AND instr(m.body_text,c.postal_address)>0
      AND instr(m.body_text,c.opt_out_text)>0
  ) THEN RAISE(ABORT,'message body must visibly contain the exact configured compliance footer') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM messages m WHERE m.id=NEW.message_id AND m.message_kind='initial'
      AND m.provider_thread_id IS NULL AND json_valid(m.attachments_json)
      AND json_type(m.attachments_json)='array' AND json_array_length(m.attachments_json)=0
  ) THEN RAISE(ABORT,'initial outreach must be unthreaded and have no attachments') END;
END;

CREATE TRIGGER send_ledger_enforces_hourly_limit
BEFORE INSERT ON send_ledger
BEGIN
  SELECT CASE WHEN (
    SELECT COUNT(*) FROM send_ledger
    WHERE dispatch_status!='failed_pre_dispatch'
      AND julianday(reserved_at)>julianday(NEW.reserved_at,'-1 hour')
      AND julianday(reserved_at)<=julianday(NEW.reserved_at)
  ) >= (SELECT hourly_send_limit FROM communication_settings WHERE id='global')
    THEN RAISE(ABORT,'hourly founder send limit reached') END;
END;

CREATE TRIGGER send_ledger_enforces_recipient_domain_daily_limit
BEFORE INSERT ON send_ledger
BEGIN
  SELECT CASE WHEN (
    SELECT COUNT(*) FROM send_ledger
    WHERE dispatch_status!='failed_pre_dispatch'
      AND substr(reserved_at,1,10)=substr(NEW.reserved_at,1,10)
      AND substr(recipient_normalized,instr(recipient_normalized,'@')+1)
        =substr(NEW.recipient_normalized,instr(NEW.recipient_normalized,'@')+1)
  ) >= (SELECT recipient_domain_daily_limit FROM communication_settings WHERE id='global')
    THEN RAISE(ABORT,'recipient-domain daily send limit reached') END;
END;

CREATE TRIGGER send_ledger_enforces_recipient_domain_cooldown
BEFORE INSERT ON send_ledger
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM send_ledger
    WHERE dispatch_status!='failed_pre_dispatch'
      AND substr(recipient_normalized,instr(recipient_normalized,'@')+1)
        =substr(NEW.recipient_normalized,instr(NEW.recipient_normalized,'@')+1)
      AND julianday(reserved_at)>julianday(
        NEW.reserved_at,
        '-' || (SELECT recipient_domain_cooldown_minutes FROM communication_settings WHERE id='global') || ' minutes'
      )
      AND julianday(reserved_at)<=julianday(NEW.reserved_at)
  ) THEN RAISE(ABORT,'recipient-domain cooldown is still active') END;
END;
`,
  },
  {
    version: 8,
    name: 'explicit_review_and_pipeline_dispositions',
    sql: `
ALTER TABLE claims ADD COLUMN review_disposition TEXT
  CHECK(review_disposition IS NULL OR review_disposition IN ('accepted','rejected'));
ALTER TABLE claims ADD COLUMN reviewed_at TEXT;

ALTER TABLE targets ADD COLUMN disposition TEXT
  CHECK(disposition IS NULL OR disposition='not_now');

-- Before this migration the UI represented "not now" as a passed target with
-- this exact service-authored note. Preserve that intent without guessing from
-- arbitrary founder notes.
UPDATE targets SET disposition='not_now'
WHERE stage='passed' AND owner_note='Not now';
`,
  },
  {
    version: 9,
    name: 'device_local_preferences',
    sql: `
CREATE TABLE local_preferences (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`,
  },
] as const;

function scalarNumber(db: Database, sql: string): number {
  const result = db.exec(sql)[0];
  if (!result || !result.values[0]) return 0;
  return Number(result.values[0][0]);
}

export function currentSchemaVersion(db: Database): number {
  return scalarNumber(db, 'PRAGMA user_version');
}

export function migrate(db: Database, appliedAt: string): number {
  db.run('PRAGMA foreign_keys = ON');
  const current = currentSchemaVersion(db);
  if (current > SCHEMA_VERSION)
    throw new Error(`Vault schema ${current} is newer than supported schema ${SCHEMA_VERSION}`);

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    db.run('BEGIN IMMEDIATE');
    try {
      db.run(migration.sql);
      db.run('INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)', [
        migration.version,
        migration.name,
        appliedAt,
      ]);
      db.run(`PRAGMA user_version = ${migration.version}`);
      db.run('COMMIT');
    } catch (error) {
      db.run('ROLLBACK');
      throw error;
    }
  }
  db.run('PRAGMA foreign_keys = ON');
  return currentSchemaVersion(db);
}
