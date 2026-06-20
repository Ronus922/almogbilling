// Supplier domain types. Single-tenant (no tenant_id). Audit deferred to a
// later slice; supplier_links not in v1.

// Unified status vocabulary (migration 046): one active state + one archived
// state. The legacy 'inactive' value was folded into 'archived'.
export type SupplierStatus = 'active' | 'archived';

export type SupplierPaymentTerms =
  | 'immediate'
  | 'net_15'
  | 'net_30'
  | 'net_45'
  | 'net_60'
  | 'net_90'
  | 'other';

export type SupplierDocType =
  | 'general'
  | 'contract'
  | 'invoice'
  | 'quote'
  | 'license'
  | 'insurance'
  | 'warranty';

/** A user-managed supplier category (classifies suppliers beyond supplier_type). */
export interface SupplierCategory {
  id: string;
  name: string;
  /** User-chosen hex ('#2563eb'); null → app falls back to a name-hash tone. */
  color: string | null;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

/** Category row enriched with its live-supplier count (category management sheet). */
export interface SupplierCategoryWithCount extends SupplierCategory {
  linked_count: number;
}

export interface Supplier {
  id: string;
  display_name: string;
  company_name: string;
  contact_person: string;
  supplier_type: string;
  category_id: string | null;
  status: SupplierStatus;
  phone: string;
  mobile: string;
  email: string;
  website: string;
  address: string;
  city: string;
  tax_id: string;
  bank_name: string;
  bank_branch: string;
  bank_account: string;
  payment_terms: SupplierPaymentTerms;
  notes: string;
  internal_notes: string;
  rating: number | null;
  created_by: string | null;
  created_by_name: string | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

/** A supplier list row — adds a documents_count aggregate + the joined category name. */
export interface SupplierListItem extends Supplier {
  documents_count: number;
  category_name: string | null;
  category_color: string | null;
}

export interface SupplierDocument {
  id: string;
  supplier_id: string;
  file_name: string;
  file_url: string;
  file_size_bytes: number;
  mime_type: string;
  doc_type: SupplierDocType;
  uploaded_by: string | null;
  uploaded_by_name: string | null;
  created_at: Date;
}

/** One row of a supplier's automatic activity log (central audit_log,
 *  entity_type='supplier'). `changes` / `metadata` are the raw jsonb payloads
 *  written by writeAudit; the UI decides what to render per `action`. */
export interface SupplierActivityEntry {
  id: string;
  action: string;
  changes: unknown;
  metadata: unknown;
  actor_name: string | null;
  created_at: Date;
}

/** Fields a client may write — the panel saves the whole supplier in one PATCH. */
export interface SupplierWritableFields {
  display_name: string;
  company_name: string;
  contact_person: string;
  supplier_type: string;
  category_id: string | null;
  status: SupplierStatus;
  phone: string;
  mobile: string;
  email: string;
  website: string;
  address: string;
  city: string;
  tax_id: string;
  bank_name: string;
  bank_branch: string;
  bank_account: string;
  payment_terms: SupplierPaymentTerms;
  notes: string;
  internal_notes: string;
  rating: number | null;
}

// Status filter "tabs" for the suppliers list — exactly three, in order:
// 'active' (פעיל, the default) · 'archived' (ארכיון) · 'all' (הכל = both).
export type SupplierStatusFilter = SupplierStatus | 'all';

export interface SupplierListFilters {
  search?: string;
  status?: SupplierStatusFilter;
  type?: string | 'all';
  category?: string | 'all';
}
