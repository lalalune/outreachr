/** Enforces current membership, seat capacity, invitation identity, and trial eligibility. */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { lockOrganization, transaction } from './database';
import { requireCondition } from './errors';
import {
  INVITE_DAYS,
  PLANS,
  TRIAL_AI_CENTS,
  TRIAL_DAYS,
  isAdmin,
  isEditor,
  type Plan,
  type Role,
} from './plans';

export const hashToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');
export const newToken = (): string => randomBytes(32).toString('base64url');
const dayMs = 86_400_000;

export interface Identity {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
}
export interface Organization extends QueryResultRow {
  id: string;
  name: string;
  plan: Plan;
  role: Role;
  seat_capacity: number;
  editing_members?: number;
  trial_ends_at: Date | null;
  subscription_id: string | null;
  subscription_status: string;
  subscription_period_start: Date | null;
  subscription_period_end: Date | null;
  stripe_customer_id: string | null;
  cancel_at_period_end: boolean;
}
interface UserRow extends QueryResultRow {
  id: string;
  email: string;
  name: string;
  email_verified: boolean;
  default_org_id: string | null;
  trial_claimed_at: Date | null;
}
interface InviteRow extends QueryResultRow {
  id: string;
  org_id: string;
  email: string;
  role: Exclude<Role, 'owner'>;
  expires_at: Date;
  consumed_by: string | null;
  revoked_at: Date | null;
}

export function entitlement(org: Organization, now: Date) {
  const paid =
    org.subscription_status === 'active' &&
    org.subscription_period_start !== null &&
    org.subscription_period_start.getTime() <= now.getTime() &&
    org.subscription_period_end !== null &&
    org.subscription_period_end.getTime() > now.getTime();
  const trial =
    org.subscription_id === null &&
    org.trial_ends_at !== null &&
    org.trial_ends_at.getTime() > now.getTime();
  return {
    active: paid || trial,
    trial,
    canEdit:
      isEditor(org.role) && (paid || trial) && org.seat_capacity >= (org.editing_members ?? 1),
    plan: org.plan,
    model: PLANS[org.plan].model,
    allowanceCents: paid
      ? PLANS[org.plan].aiAllowanceCents * org.seat_capacity
      : trial
        ? TRIAL_AI_CENTS
        : 0,
    periodKey: paid
      ? `paid:${org.subscription_id}:${org.subscription_period_start?.toISOString()}`
      : `trial:${org.trial_ends_at?.toISOString()}`,
  };
}

export async function memberOrganization(
  client: Pick<PoolClient, 'query'>,
  userId: string,
  orgId: string,
): Promise<Organization> {
  const result = await client.query<Organization>(
    `SELECT o.*, m.role,(SELECT count(*)::int FROM outreachr.memberships active WHERE active.org_id=o.id AND active.role!='viewer') AS editing_members FROM outreachr.organizations o
      JOIN outreachr.memberships m ON m.org_id=o.id WHERE o.id=$1 AND m.user_id=$2`,
    [orgId, userId],
  );
  const org = result.rows[0];
  requireCondition(org, 404, 'workspace_not_found', 'Workspace not found or membership removed.');
  return org;
}

async function audit(
  client: PoolClient,
  orgId: string,
  userId: string,
  action: string,
  detail: Record<string, unknown> = {},
) {
  await client.query(
    'INSERT INTO outreachr.audit(org_id,user_id,action,detail) VALUES($1,$2,$3,$4)',
    [orgId, userId, action, JSON.stringify(detail)],
  );
}

async function requireSeat(client: PoolClient, org: Organization) {
  const result = await client.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM outreachr.memberships WHERE org_id=$1 AND role<>'viewer'",
    [org.id],
  );
  requireCondition(
    (result.rows[0]?.count ?? 0) < org.seat_capacity,
    409,
    'seat_capacity',
    'The owner must purchase another editing seat first.',
  );
}

export class WorkspaceStore {
  constructor(
    readonly pool: Pool,
    readonly now: () => Date = () => new Date(),
  ) {}

  async signIn(identity: Identity): Promise<{ user: UserRow; organizations: Organization[] }> {
    requireCondition(
      identity.emailVerified,
      403,
      'verified_email_required',
      'Verify your email in Eliza before using Outreachr.',
    );
    const user = await transaction(this.pool, async (client) => {
      await client.query(
        `INSERT INTO outreachr.users(id,email,name,email_verified) VALUES($1,$2,$3,$4)
        ON CONFLICT(id) DO UPDATE SET email=EXCLUDED.email,name=EXCLUDED.name,email_verified=EXCLUDED.email_verified`,
        [identity.id, identity.email.trim().toLowerCase(), identity.name, identity.emailVerified],
      );
      const found = await client.query<UserRow>(
        'SELECT * FROM outreachr.users WHERE id=$1 FOR UPDATE',
        [identity.id],
      );
      const user = found.rows[0]!;
      if (!user.default_org_id) {
        const orgId = randomUUID();
        const now = this.now();
        const trialEnd = user.trial_claimed_at
          ? null
          : new Date(now.getTime() + TRIAL_DAYS * dayMs);
        await client.query(
          'INSERT INTO outreachr.organizations(id,name,created_by,trial_ends_at) VALUES($1,$2,$3,$4)',
          [orgId, `${identity.name || 'My'} workspace`.slice(0, 100), identity.id, trialEnd],
        );
        await client.query(
          "INSERT INTO outreachr.memberships(org_id,user_id,role) VALUES($1,$2,'owner')",
          [orgId, identity.id],
        );
        await client.query(
          'UPDATE outreachr.users SET default_org_id=$2,trial_claimed_at=COALESCE(trial_claimed_at,$3) WHERE id=$1',
          [identity.id, orgId, now],
        );
        user.default_org_id = orgId;
        user.trial_claimed_at ??= now;
        await audit(client, orgId, identity.id, 'workspace.created', { default: true });
      }
      return user;
    });
    return { user, organizations: await this.list(identity.id) };
  }

  async list(userId: string): Promise<Organization[]> {
    return (
      await this.pool.query<Organization>(
        `SELECT o.*,m.role,(SELECT count(*)::int FROM outreachr.memberships active WHERE active.org_id=o.id AND active.role!='viewer') AS editing_members FROM outreachr.organizations o JOIN outreachr.memberships m ON o.id=m.org_id
      WHERE m.user_id=$1 ORDER BY o.created_at,o.id`,
        [userId],
      )
    ).rows;
  }

  async create(userId: string, name: string): Promise<Organization> {
    return transaction(this.pool, async (client) => {
      const orgId = randomUUID();
      await client.query(
        'INSERT INTO outreachr.organizations(id,name,created_by) VALUES($1,$2,$3)',
        [orgId, name.trim(), userId],
      );
      await client.query(
        "INSERT INTO outreachr.memberships(org_id,user_id,role) VALUES($1,$2,'owner')",
        [orgId, userId],
      );
      await audit(client, orgId, userId, 'workspace.created');
      return memberOrganization(client, userId, orgId);
    });
  }

  async invite(userId: string, orgId: string, email: string, role: Exclude<Role, 'owner'>) {
    return transaction(this.pool, async (client) => {
      await lockOrganization(client, orgId);
      const org = await memberOrganization(client, userId, orgId);
      requireCondition(
        isAdmin(org.role),
        403,
        'admin_required',
        'Only workspace owners and admins can invite members.',
      );
      requireCondition(
        role !== 'admin' || org.role === 'owner',
        403,
        'owner_required',
        'Only owners can invite admins.',
      );
      requireCondition(
        entitlement(org, this.now()).active || role === 'viewer',
        403,
        'subscription_required',
        'Start a subscription before inviting editing members.',
      );
      const normalized = email.trim().toLowerCase();
      const existing = await client.query(
        'SELECT 1 FROM outreachr.memberships m JOIN outreachr.users u ON u.id=m.user_id WHERE m.org_id=$1 AND lower(u.email)=$2',
        [orgId, normalized],
      );
      requireCondition(
        existing.rowCount === 0,
        409,
        'already_member',
        'This account already belongs to the workspace.',
      );
      if (isEditor(role)) await requireSeat(client, org);
      await client.query(
        'UPDATE outreachr.invites SET revoked_at=$3 WHERE org_id=$1 AND lower(email)=$2 AND consumed_by IS NULL AND revoked_at IS NULL',
        [orgId, normalized, this.now()],
      );
      const token = newToken();
      const id = randomUUID();
      const expiresAt = new Date(this.now().getTime() + INVITE_DAYS * dayMs);
      await client.query(
        'INSERT INTO outreachr.invites(id,org_id,email,role,token_hash,created_by,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [id, orgId, normalized, role, hashToken(token), userId, expiresAt],
      );
      await audit(client, orgId, userId, 'invite.created', {
        inviteId: id,
        email: normalized,
        role,
      });
      return { id, token, expiresAt };
    });
  }

  async acceptInvite(userId: string, token: string): Promise<Organization> {
    return transaction(this.pool, async (client) => {
      const lookup = await client.query<InviteRow>(
        'SELECT * FROM outreachr.invites WHERE token_hash=$1',
        [hashToken(token)],
      );
      const hint = lookup.rows[0];
      requireCondition(hint, 404, 'invite_invalid', 'Invitation not found.');
      await lockOrganization(client, hint.org_id);
      const locked = await client.query<InviteRow>(
        'SELECT * FROM outreachr.invites WHERE id=$1 FOR UPDATE',
        [hint.id],
      );
      const invite = locked.rows[0]!;
      requireCondition(
        !invite.revoked_at &&
          !invite.consumed_by &&
          invite.expires_at.getTime() > this.now().getTime(),
        409,
        'invite_expired',
        'Invitation has expired, was revoked, or was already accepted.',
      );
      const user = (
        await client.query<UserRow>('SELECT * FROM outreachr.users WHERE id=$1 FOR UPDATE', [
          userId,
        ])
      ).rows[0];
      requireCondition(
        user?.email_verified && user.email.toLowerCase() === invite.email.toLowerCase(),
        403,
        'invite_email_mismatch',
        'Sign in using the verified email this invitation was addressed to.',
      );
      const existing = await client.query(
        'SELECT 1 FROM outreachr.memberships WHERE org_id=$1 AND user_id=$2',
        [invite.org_id, userId],
      );
      requireCondition(
        existing.rowCount === 0,
        409,
        'already_member',
        'This account already belongs to the workspace.',
      );
      const org = (
        await client.query<Organization>(
          "SELECT *, 'owner' AS role FROM outreachr.organizations WHERE id=$1",
          [invite.org_id],
        )
      ).rows[0]!;
      if (isEditor(invite.role)) {
        requireCondition(
          entitlement(org, this.now()).active,
          403,
          'subscription_required',
          'This workspace needs an active subscription.',
        );
        await requireSeat(client, org);
      }
      await client.query(
        'INSERT INTO outreachr.memberships(org_id,user_id,role) VALUES($1,$2,$3)',
        [invite.org_id, userId, invite.role],
      );
      await client.query('UPDATE outreachr.invites SET consumed_by=$2 WHERE id=$1', [
        invite.id,
        userId,
      ]);
      await audit(client, invite.org_id, userId, 'invite.accepted', {
        inviteId: invite.id,
        role: invite.role,
      });
      return memberOrganization(client, userId, invite.org_id);
    });
  }

  async revokeInvite(userId: string, orgId: string, inviteId: string): Promise<void> {
    await transaction(this.pool, async (client) => {
      await lockOrganization(client, orgId);
      const org = await memberOrganization(client, userId, orgId);
      requireCondition(
        isAdmin(org.role),
        403,
        'admin_required',
        'Only workspace owners and admins can revoke invitations.',
      );
      const result = await client.query(
        'UPDATE outreachr.invites SET revoked_at=$3 WHERE id=$1 AND org_id=$2 AND consumed_by IS NULL RETURNING id',
        [inviteId, orgId, this.now()],
      );
      requireCondition(result.rowCount, 404, 'invite_not_found', 'Pending invitation not found.');
      await audit(client, orgId, userId, 'invite.revoked', { inviteId });
    });
  }

  async changeMember(
    userId: string,
    orgId: string,
    targetId: string,
    role: Role | null,
  ): Promise<void> {
    await transaction(this.pool, async (client) => {
      await lockOrganization(client, orgId);
      const org = await memberOrganization(client, userId, orgId);
      requireCondition(
        isAdmin(org.role) || (userId === targetId && role === null),
        403,
        'admin_required',
        'Only owners and admins can change memberships.',
      );
      const target = await memberOrganization(client, targetId, orgId);
      requireCondition(
        org.role === 'owner' ||
          (target.role !== 'owner' &&
            target.role !== 'admin' &&
            role !== 'owner' &&
            role !== 'admin') ||
          (userId === targetId && role === null),
        403,
        'owner_required',
        'Only owners can manage owners and admins.',
      );
      if (target.role === 'owner' && role !== 'owner') {
        const count = (
          await client.query<{ count: number }>(
            "SELECT count(*)::int AS count FROM outreachr.memberships WHERE org_id=$1 AND role='owner'",
            [orgId],
          )
        ).rows[0]!.count;
        requireCondition(
          count > 1,
          409,
          'last_owner',
          'Assign another owner before removing the last owner.',
        );
      }
      if (role && isEditor(role) && !isEditor(target.role)) {
        requireCondition(
          entitlement(org, this.now()).active,
          403,
          'subscription_required',
          'This workspace needs an active subscription.',
        );
        await requireSeat(client, org);
      }
      if (role)
        await client.query(
          'UPDATE outreachr.memberships SET role=$3 WHERE org_id=$1 AND user_id=$2',
          [orgId, targetId, role],
        );
      else {
        await client.query('DELETE FROM outreachr.memberships WHERE org_id=$1 AND user_id=$2', [
          orgId,
          targetId,
        ]);
        await client.query(
          `UPDATE outreachr.users SET default_org_id=(SELECT org_id FROM outreachr.memberships WHERE user_id=$1 ORDER BY joined_at LIMIT 1) WHERE id=$1 AND default_org_id=$2`,
          [targetId, orgId],
        );
      }
      await audit(client, orgId, userId, 'membership.changed', { targetId, role });
    });
  }

  async members(userId: string, orgId: string) {
    await memberOrganization(this.pool, userId, orgId);
    return (
      await this.pool.query<{ id: string; name: string; email: string; role: Role }>(
        'SELECT u.id,u.name,u.email,m.role FROM outreachr.memberships m JOIN outreachr.users u ON m.user_id=u.id WHERE m.org_id=$1 ORDER BY m.joined_at',
        [orgId],
      )
    ).rows;
  }
}
