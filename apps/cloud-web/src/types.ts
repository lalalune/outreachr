export interface Organization {
  id: string;
  name: string;
  role: 'owner' | 'admin' | 'member' | 'viewer';
  plan: 'sol' | 'astra';
  seat_capacity: number;
  trial_ends_at: string | null;
  subscription_status: string;
  cancel_at_period_end: boolean;
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
