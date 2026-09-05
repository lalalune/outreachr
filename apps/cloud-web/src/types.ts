export interface Organization {
  id: string;
  name: string;
  role: 'owner' | 'admin' | 'member' | 'viewer';
  plan: 'sol' | 'astra';
  seat_capacity: number;
  trial_ends_at: string | null;
  subscription_status: string;
  cancel_at_period_end: boolean;
  cloud_membership_ready?: boolean;
  cloud_billing_account_id?: string | null;
  cloud_ownership_confirmed?: boolean;
  cloud_ownership_pending?: boolean;
  cloud_provisioning_state?:
    'pending' | 'ready' | 'ineligible' | 'failed' | 'migration_required' | null;
  cloud_provisioning_error?: string | null;
  created_by?: string;
  entitlement: {
    active: boolean;
    canEdit: boolean;
    model: string;
    allowanceCents: number;
    trial: boolean;
  };
}
export interface Account {
  user: { id: string; email: string; name: string; defaultOrgId: string };
  organizations: Organization[];
}
