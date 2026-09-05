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
      CREATE TABLE IF NOT EXISTS outreachr.billing_events (
        id text PRIMARY KEY,
        processed_at timestamptz NOT NULL DEFAULT now()
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
