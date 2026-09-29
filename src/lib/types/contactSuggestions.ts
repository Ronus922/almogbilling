// The Bllink → residents-list approval queue (29/09/2026).
//
// The sync no longer overwrites a resident field it disagrees with: it files a
// suggestion and the value stands until someone decides. The seven rules live
// in SQL: 20260929194811_contact_sync_suggestions, widened to the tenant's
// name by 20260929211433 and to the two addresses by 20260929212603.

/** The fields Bllink carries about people — the same ones the migrations'
 *  CHECKs name. Two sources feed them: the debt report's single name cell,
 *  which holds BOTH names tagged "(בעלים)" / "(שוכר/ת)"
 *  (src/lib/sync/reportNames.ts), and Bllink's resident list, the only screen
 *  that carries an address at all (src/lib/sync/tenantList.ts). */
export type SuggestionField =
  | 'owner_name' | 'owner_phone' | 'owner_email'
  | 'tenant_name' | 'tenant_phone' | 'tenant_email';

export const SUGGESTION_FIELD_LABEL: Record<SuggestionField, string> = {
  owner_name: 'שם בעלים',
  owner_phone: 'טלפון בעלים',
  owner_email: 'מייל בעלים',
  tenant_name: 'שם שוכר',
  tenant_phone: 'טלפון שוכר',
  tenant_email: 'מייל שוכר',
};

/** Which fields read left to right — numbers and addresses. Hebrew names do
 *  not, so they keep the page's own direction. */
export const SUGGESTION_FIELD_IS_NUMERIC: Record<SuggestionField, boolean> = {
  owner_name: false,
  owner_phone: true,
  owner_email: true,
  tenant_name: false,
  tenant_phone: true,
  tenant_email: true,
};

export interface ContactSuggestion {
  id: string;
  apartment_number: string;
  field: SuggestionField;
  /** The value in the residents list RIGHT NOW — not the one stored when the
   *  suggestion was raised, which may have moved on since. */
  current_value: string | null;
  proposed_value: string;
  created_at: string;
}

/** Who last changed each synced field of one apartment. A field nobody ever
 *  touched is simply absent. */
export type ContactFieldSources = Partial<Record<SuggestionField, {
  source: 'manual' | 'bllink';
  updated_at: string;
}>>;

/** What one sync did to the residents list. */
export interface ContactSyncOutcome {
  created: number;
  applied: number;
  suggested: number;
  closed: number;
  relinked: number;
}

/** Everything the apartment card shows beside the fields themselves. */
export interface ContactFieldState {
  suggestions: ContactSuggestion[];
  sources: ContactFieldSources;
}
