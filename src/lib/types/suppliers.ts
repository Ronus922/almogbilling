// Supplier domain types. Single-tenant (no tenant_id). Audit deferred to a
// later slice; supplier_links not in v1.

export type SupplierStatus = 'active' | 'inactive' | 'archived';

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

export interface Supplier {
  id: string;
  display_name: string;
  company_name: string;
  contact_person: string;
  supplier_type: string;
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

/** A supplier list row — adds a documents_count subquery aggregate. */
export interface SupplierListItem extends Supplier {
  documents_count: number;
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

/** Fields a client may write — the panel saves the whole supplier in one PATCH. */
export interface SupplierWritableFields {
  display_name: string;
  company_name: string;
  contact_person: string;
  supplier_type: string;
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

export interface SupplierListFilters {
  search?: string;
  status?: SupplierStatus | 'all';
  type?: string | 'all';
}
