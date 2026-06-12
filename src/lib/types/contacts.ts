// Contact domain types — Slice 4 Track A.
// One row per apartment. Bllink sync (Track B) consumes upsertContactByApartment.

export type ContactResidentType = 'owner' | 'tenant' | 'operator';

export type WhatsappProfileSyncStatus =
  | 'pending'
  | 'synced'
  | 'no_avatar'
  | 'unavailable'
  | 'failed';

export interface Contact {
  id: string;
  apartment_number: string;
  owner_name: string | null;
  owner_phone: string | null;
  owner_email: string | null;
  tenant_name: string | null;
  tenant_phone: string | null;
  tenant_email: string | null;
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
  owner_name: string | null;
  owner_phone: string | null;
  owner_email: string | null;
  tenant_name: string | null;
  tenant_phone: string | null;
  tenant_email: string | null;
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
