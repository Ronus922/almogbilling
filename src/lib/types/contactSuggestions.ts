// The Bllink → residents-list approval queue (29/09/2026).
//
// The sync no longer overwrites a resident field it disagrees with: it files a
// suggestion and the value stands until someone decides. See the migration
// 20260929194811_contact_sync_suggestions for the seven rules.

/** The only fields the Bllink report carries about people — the same three the
 *  migration's CHECKs name. */
export type SuggestionField = 'owner_name' | 'owner_phone' | 'tenant_phone';

export const SUGGESTION_FIELD_LABEL: Record<SuggestionField, string> = {
  owner_name: 'שם בעלים',
  owner_phone: 'טלפון בעלים',
  tenant_phone: 'טלפון שוכר',
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

/** Who last changed each of the three fields of one apartment. A field nobody
 *  ever touched is simply absent. */
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
