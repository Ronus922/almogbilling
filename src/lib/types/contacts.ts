// Contact domain types — Slice 4 Track A.
// One row per apartment. Bllink sync (Track B) consumes upsertContactByApartment.

export type ContactResidentType = 'owner' | 'tenant' | 'operator';

export type WhatsappProfileSyncStatus =
  | 'pending'
  | 'synced'
  | 'no_avatar'
  | 'unavailable'
  | 'failed';

/** Role of an EXTRA person on an apartment card (2nd owner, 2nd tenant, …). */
export type ContactPersonRole = 'owner' | 'tenant';

/**
 * An additional owner/tenant of an apartment (public.contact_people). The FIRST
 * owner and the FIRST tenant stay in the contacts.owner_* / tenant_* columns —
 * these rows are everyone after them, in `sort_order`.
 */
export interface ContactPerson {
  id: string;
  role: ContactPersonRole;
  name: string | null;
  phone: string | null;
  email: string | null;
  /** Receives WhatsApp messages / broadcasts ("מקבל הודעות"). */
  is_primary_contact: boolean;
  sort_order: number;
}

/** What a client may write for one extra person (id/sort_order are server-side). */
export interface ContactPersonInput {
  role: ContactPersonRole;
  name: string | null;
  phone: string | null;
  email: string | null;
  is_primary_contact: boolean;
}

export interface Contact {
  id: string;
  apartment_number: string;
  /** Floor area in m² — manual field, never written by an import. */
  apartment_size_sqm: number | null;
  /**
   * Agreed monthly management fee (manual). NOT the synced management-fee DEBT
   * in debtors.management_fees.
   */
  management_fee: number | null;
  /** Extra owners/tenants beyond the first of each role. */
  people: ContactPerson[];
  owner_name: string | null;
  owner_phone: string | null;
  owner_email: string | null;
  tenant_name: string | null;
  tenant_phone: string | null;
  tenant_email: string | null;
  operator_name: string | null;
  operator_phone: string | null;
  resident_type: ContactResidentType;
  operator_id: string | null;
  owner_is_primary_contact: boolean;
  tenant_is_primary_contact: boolean;
  operator_is_primary_contact: boolean;
  address: string | null;
  notes: string | null;
  tags: string[];
  whatsapp_profile_image_url: string | null;
  whatsapp_profile_sync_status: WhatsappProfileSyncStatus | null;
  whatsapp_profile_last_synced_at: Date | null;
  whatsapp_profile_sync_error: string | null;
  last_whatsapp_sent_at: Date | null;
  last_synced_at: Date | null;
  created_at: Date;
  updated_at: Date;
  created_by: string | null;
}

/**
 * Fields a client/sync may write. apartment_number is required on create and
 * immutable on update (the DB layer strips it from updates). Every other field
 * is optional on a partial update.
 */
export interface ContactWritableFields {
  apartment_number: string;
  apartment_size_sqm: number | null;
  management_fee: number | null;
  owner_name: string | null;
  owner_phone: string | null;
  owner_email: string | null;
  tenant_name: string | null;
  tenant_phone: string | null;
  tenant_email: string | null;
  operator_name: string | null;
  operator_phone: string | null;
  resident_type: ContactResidentType;
  operator_id: string | null;
  owner_is_primary_contact: boolean;
  tenant_is_primary_contact: boolean;
  operator_is_primary_contact: boolean;
  address: string | null;
  notes: string | null;
  tags: string[];
  whatsapp_profile_image_url: string | null;
  whatsapp_profile_sync_status: WhatsappProfileSyncStatus | null;
  whatsapp_profile_last_synced_at: string | null;
  whatsapp_profile_sync_error: string | null;
  last_whatsapp_sent_at: string | null;
  last_synced_at: string | null;
}

export type ContactSort = 'apartment_asc' | 'apartment_desc' | 'updated_desc' | 'created_desc';

export interface ContactListFilters {
  search?: string;
  tags?: string[];
  sort?: ContactSort;
}
