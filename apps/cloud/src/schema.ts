/** Creates only Outreachr-owned tables; existing Eliza tables are never altered. */
import type { Pool } from 'pg';

export async function migrate(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('outreachr:migrations', 0))");
    await client.query(`
      CREATE SCHEMA IF NOT EXISTS outreachr;
      CREATE TABLE IF NOT EXISTS outreachr.users (
        id text PRIMARY KEY,
        email text NOT NULL,
        name text NOT NULL,
        email_verified boolean NOT NULL,
        default_org_id uuid,
        trial_claimed_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS outreachr.organizations (
        id uuid PRIMARY KEY,
        name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
        created_by text NOT NULL REFERENCES outreachr.users(id),
        plan text NOT NULL DEFAULT 'sol' CHECK (plan IN ('sol','astra')),
        trial_ends_at timestamptz,
        seat_capacity integer NOT NULL DEFAULT 1 CHECK (seat_capacity BETWEEN 1 AND 1000),
        subscription_id text UNIQUE,
        subscription_status text NOT NULL DEFAULT 'none',
        subscription_period_start timestamptz,
        subscription_period_end timestamptz,
        stripe_customer_id text,
        cancel_at_period_end boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      ALTER TABLE outreachr.organizations ADD COLUMN IF NOT EXISTS trial_started_at timestamptz;
      ALTER TABLE outreachr.organizations ADD COLUMN IF NOT EXISTS cloud_provisioning_state text CHECK (cloud_provisioning_state IN ('pending','ready','ineligible','failed','migration_required'));
      ALTER TABLE outreachr.organizations ADD COLUMN IF NOT EXISTS cloud_trial_requested boolean NOT NULL DEFAULT false;
      ALTER TABLE outreachr.organizations ADD COLUMN IF NOT EXISTS cloud_provisioning_error text;
      ALTER TABLE outreachr.organizations ADD COLUMN IF NOT EXISTS cloud_app_id uuid;
      ALTER TABLE outreachr.organizations ADD COLUMN IF NOT EXISTS cloud_billing_account_id uuid;
      ALTER TABLE outreachr.organizations ADD COLUMN IF NOT EXISTS cloud_billing_environment text CHECK (cloud_billing_environment IN ('test','live'));
      ALTER TABLE outreachr.organizations ADD COLUMN IF NOT EXISTS cloud_product_family_key text;
      ALTER TABLE outreachr.organizations ADD COLUMN IF NOT EXISTS cloud_billing_access text CHECK (cloud_billing_access IN ('granted','read_only','denied'));
      ALTER TABLE outreachr.organizations ADD COLUMN IF NOT EXISTS cloud_billing_valid_until timestamptz;
      ALTER TABLE outreachr.organizations ADD COLUMN IF NOT EXISTS cloud_billing_observed_at timestamptz;
      ALTER TABLE outreachr.organizations ADD COLUMN IF NOT EXISTS cloud_billing_invalidated boolean NOT NULL DEFAULT false;
      ALTER TABLE outreachr.organizations ADD COLUMN IF NOT EXISTS cloud_ownership_confirmed boolean NOT NULL DEFAULT false;
      ALTER TABLE outreachr.organizations ADD COLUMN IF NOT EXISTS cloud_ownership_pending boolean NOT NULL DEFAULT false;
      ALTER TABLE outreachr.organizations ADD COLUMN IF NOT EXISTS cloud_ownership_observed_at timestamptz;
      ALTER TABLE outreachr.organizations ADD COLUMN IF NOT EXISTS cloud_administrator_revision text;
      ALTER TABLE outreachr.organizations ADD COLUMN IF NOT EXISTS cloud_administrators jsonb NOT NULL DEFAULT '[]'::jsonb;
      CREATE UNIQUE INDEX IF NOT EXISTS organizations_cloud_billing_account
        ON outreachr.organizations(cloud_app_id,cloud_billing_environment,cloud_billing_account_id);
      CREATE TABLE IF NOT EXISTS outreachr.memberships (
        org_id uuid NOT NULL REFERENCES outreachr.organizations(id),
        user_id text NOT NULL REFERENCES outreachr.users(id),
        role text NOT NULL CHECK (role IN ('owner','admin','member','viewer')),
        joined_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (org_id,user_id)
      );
      CREATE TABLE IF NOT EXISTS outreachr.invites (
        id uuid PRIMARY KEY,
        org_id uuid NOT NULL REFERENCES outreachr.organizations(id),
        email text NOT NULL,
        role text NOT NULL CHECK (role IN ('admin','member','viewer')),
        token_hash text NOT NULL UNIQUE,
        created_by text NOT NULL REFERENCES outreachr.users(id),
        expires_at timestamptz NOT NULL,
        consumed_by text REFERENCES outreachr.users(id),
        revoked_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      ALTER TABLE outreachr.memberships ADD COLUMN IF NOT EXISTS cloud_membership_ready boolean NOT NULL DEFAULT true;
      ALTER TABLE outreachr.memberships ADD COLUMN IF NOT EXISTS cloud_sync_job_id uuid;
      CREATE TABLE IF NOT EXISTS outreachr.cloud_membership_jobs (
        position bigserial UNIQUE,
        id uuid PRIMARY KEY,
        org_id uuid NOT NULL REFERENCES outreachr.organizations(id),
        user_id text NOT NULL REFERENCES outreachr.users(id),
        desired_role text CHECK (desired_role IN ('owner','admin','member','viewer')),
        app_id uuid NOT NULL,
        billing_account_id uuid NOT NULL,
        environment text NOT NULL CHECK (environment IN ('test','live')),
        product_family_key text NOT NULL,
        client_id uuid,
        request_json jsonb,
        state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','confirmed','superseded')),
        attempts integer NOT NULL DEFAULT 0,
        retry_after timestamptz NOT NULL DEFAULT now(),
        error_code text,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS cloud_membership_jobs_pending ON outreachr.cloud_membership_jobs(org_id,position) WHERE state='pending';
      CREATE TABLE IF NOT EXISTS outreachr.cloud_ownership_jobs (
        id uuid PRIMARY KEY,
        org_id uuid NOT NULL REFERENCES outreachr.organizations(id),
        actor_id text NOT NULL REFERENCES outreachr.users(id),
        target_id text NOT NULL REFERENCES outreachr.users(id),
        action text NOT NULL CHECK (action IN ('grant','revoke','transfer')),
        app_id uuid NOT NULL,
        client_id uuid NOT NULL,
        billing_account_id uuid NOT NULL,
        environment text NOT NULL CHECK (environment IN ('test','live')),
        request_json jsonb,
        response_json jsonb,
        state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','confirmed','reconciled','superseded')),
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS cloud_ownership_jobs_pending ON outreachr.cloud_ownership_jobs(org_id) WHERE state='pending';
      CREATE UNIQUE INDEX IF NOT EXISTS invites_pending_email
        ON outreachr.invites(org_id, lower(email))
        WHERE consumed_by IS NULL AND revoked_at IS NULL;
      CREATE TABLE IF NOT EXISTS outreachr.sessions (
        token_hash text PRIMARY KEY,
        user_id text NOT NULL REFERENCES outreachr.users(id),
        eliza_grant_ciphertext text NOT NULL,
        expires_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS sessions_user ON outreachr.sessions(user_id);
      CREATE TABLE IF NOT EXISTS outreachr.mailboxes (
        org_id uuid NOT NULL REFERENCES outreachr.organizations(id),
        user_id text NOT NULL REFERENCES outreachr.users(id),
        connection_id uuid NOT NULL,
        email text NOT NULL,
        selected_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY(org_id,user_id)
      );
      CREATE TABLE IF NOT EXISTS outreachr.login_states (
        token_hash text PRIMARY KEY,
        expires_at timestamptz NOT NULL,
        return_path text NOT NULL
      );
      CREATE TABLE IF NOT EXISTS outreachr.vaults (
        org_id uuid PRIMARY KEY REFERENCES outreachr.organizations(id),
        snapshot bytea NOT NULL,
        version bigint NOT NULL DEFAULT 1,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS outreachr.files (
        id uuid PRIMARY KEY,
        org_id uuid NOT NULL REFERENCES outreachr.organizations(id),
        user_id text NOT NULL REFERENCES outreachr.users(id),
        name text NOT NULL,
        content bytea NOT NULL,
        purpose text NOT NULL CHECK (purpose IN ('upload','download')),
        expires_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS files_org ON outreachr.files(org_id);
      CREATE TABLE IF NOT EXISTS outreachr.usage (
        id uuid PRIMARY KEY,
        org_id uuid NOT NULL REFERENCES outreachr.organizations(id),
        user_id text NOT NULL REFERENCES outreachr.users(id),
        request_key text NOT NULL,
        model text NOT NULL,
        period_key text NOT NULL,
        reserved_cents integer NOT NULL CHECK (reserved_cents > 0),
        settled_cents integer CHECK (settled_cents >= 0),
        status text NOT NULL CHECK (status IN ('reserved','completed','failed','ambiguous')),
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (org_id, request_key)
      );
      ALTER TABLE outreachr.usage ADD COLUMN IF NOT EXISTS response_json jsonb;
      CREATE INDEX IF NOT EXISTS usage_period ON outreachr.usage(org_id,period_key);
      CREATE TABLE IF NOT EXISTS outreachr.checkout_attempts (
        id uuid PRIMARY KEY,
        org_id uuid NOT NULL REFERENCES outreachr.organizations(id),
        plan text NOT NULL CHECK (plan IN ('sol','astra')),
        seats integer NOT NULL CHECK (seats BETWEEN 1 AND 1000),
        session_id text UNIQUE,
        status text NOT NULL CHECK (status IN ('pending','complete','expired')),
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS checkout_attempts_pending ON outreachr.checkout_attempts(org_id) WHERE status='pending';
      CREATE TABLE IF NOT EXISTS outreachr.cloud_billing_intents (
        id uuid PRIMARY KEY,
        org_id uuid NOT NULL REFERENCES outreachr.organizations(id),
        user_id text NOT NULL REFERENCES outreachr.users(id),
        app_id uuid NOT NULL,
        client_id uuid NOT NULL,
        billing_account_id uuid NOT NULL,
        environment text NOT NULL CHECK (environment IN ('test','live')),
        product_family_key text NOT NULL,
        kind text NOT NULL CHECK (kind IN ('checkout','update','portal','external','trial')),
        request_json jsonb NOT NULL,
        review_json jsonb NOT NULL,
        operation_json jsonb,
        state text NOT NULL DEFAULT 'review' CHECK (state IN ('review','pending','complete','superseded')),
        confirmed_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS cloud_billing_intents_pending ON outreachr.cloud_billing_intents(org_id) WHERE state='pending';
      ALTER TABLE outreachr.cloud_billing_intents ADD COLUMN IF NOT EXISTS rejection_code text;
      ALTER TABLE outreachr.cloud_billing_intents DROP CONSTRAINT IF EXISTS cloud_billing_intents_kind_check;
      ALTER TABLE outreachr.cloud_billing_intents ADD CONSTRAINT cloud_billing_intents_kind_check CHECK (kind IN ('checkout','update','portal','external','trial'));
      ALTER TABLE outreachr.cloud_billing_intents ADD COLUMN IF NOT EXISTS cancellation_request_json jsonb;
      ALTER TABLE outreachr.cloud_billing_intents ADD COLUMN IF NOT EXISTS cancellation_operation_json jsonb;
      ALTER TABLE outreachr.cloud_billing_intents ADD COLUMN IF NOT EXISTS cancellation_pending boolean NOT NULL DEFAULT false;
      CREATE TABLE IF NOT EXISTS outreachr.billing_events (
        id text PRIMARY KEY,
        processed_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS outreachr.cloud_billing_notifications (
        id uuid PRIMARY KEY,
        app_id uuid NOT NULL,
        environment text NOT NULL CHECK (environment IN ('test','live')),
        billing_account_id uuid NOT NULL,
        product_family_key text NOT NULL,
        payload_hash text NOT NULL,
        received_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS outreachr.audit (
        id bigserial PRIMARY KEY,
        org_id uuid REFERENCES outreachr.organizations(id),
        user_id text REFERENCES outreachr.users(id),
        action text NOT NULL,
        detail jsonb NOT NULL DEFAULT '{}',
        created_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
