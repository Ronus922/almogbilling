// Shared contract for the Vendors module — a lightweight service-provider
// directory (plumber, electrician, elevators, …). Distinct from the heavyweight
// `suppliers` procurement module. Consumed by API routes, DB helpers and UI.

export interface VendorCategory {
  id: string;
  name: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

/** A category plus its live (active) vendor count — for the management sheet. */
export interface VendorCategoryWithCount extends VendorCategory {
  linked_count: number;
}

/** The persisted vendor row. */
export interface Vendor {
  id: string;
  name: string;
  category_id: string | null;
  contact_person: string;
  phone: string;
  email: string;
  address: string;
  notes: string;
  is_active: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

/** One row in the vendors table — the vendor plus its joined category name. */
export interface VendorListItem extends Vendor {
  category_name: string | null;
}

/** Fields a create/update accepts (validated + coerced server-side). */
export interface VendorWritableFields {
  name: string;
  category_id: string | null;
  contact_person: string;
  phone: string;
  email: string;
  address: string;
  notes: string;
}

/** List query filters (text search + category). */
export interface VendorListFilters {
  search?: string;
  /** Category id, or 'all'. */
  category?: string;
}
