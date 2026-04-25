// Shared contract for Slice 3 (TenantDetailPanel).
// Consumed by both UI components and backend API routes / DB helpers.
//
// API routes (signatures):
//   GET   /api/statuses                     → LegalStatus[]
//   GET   /api/debtors/:id                  → TenantDetailResponse
//   PATCH /api/debtors/:id                  body: TenantFieldsUpdate                 (admin)
//   PUT   /api/debtors/:id/legal-status     body: { status_id: LegalStatusId | null } (admin)
//   GET   /api/debtors/:id/comments         → TenantNote[]
//   POST  /api/debtors/:id/comments         body: { content: string }                (admin)

export type LegalStatusId = string;

export interface LegalStatus {
  id: LegalStatusId;
  name: string;
  description: string | null;
  color: string;
  is_default: boolean;
  is_active: boolean;
  sort_order: number;
}

export interface Tenant {
  id: string;
  apartment_number: string;
  owner_name: string | null;
  tenant_name: string | null;
  phone_owner: string | null;
  phone_tenant: string | null;
  phones_manual_override: boolean;
  total_debt: number;
  management_fees: number;
  hot_water_debt: number;
  monthly_debt: string | null;
  details: string | null;
  last_imported_at: string | null;
  legal_status_id: LegalStatusId | null;
  legal_status_name: string | null;
  legal_status_color: string | null;
  legal_status_is_default: boolean | null;
  legal_status_updated_at: string | null;
  legal_status_updated_by_name: string | null;
  notes: string | null;
  next_action_description: string | null;
  next_action_date: string | null;
  last_contact_date: string | null;
  is_archived: boolean;
}

export interface TenantNote {
  id: string;
  debtor_id: string;
  content: string;
  user_id: string | null;
  author_name: string;
  author_email: string | null;
  created_at: string;
}

export interface PhonesUpdate {
  phone_owner?: string | null;
  phone_tenant?: string | null;
}

export interface NextActionUpdate {
  next_action_description?: string | null;
  next_action_date?: string | null;
  last_contact_date?: string | null;
  notes?: string | null;
}

export type TenantFieldsUpdate = PhonesUpdate & NextActionUpdate;

export interface TenantDetailResponse {
  tenant: Tenant;
  recent_notes: TenantNote[];
}

export interface CompletedAction {
  id: string;
  debtor_id: string;
  apartment_number: string;
  description: string;
  due_date: string | null;
  completed_at: string;
  completed_by: string | null;
  completed_by_name: string;
}
