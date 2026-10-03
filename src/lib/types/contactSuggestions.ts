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
  | 'tenant_name' | 'tenant_phone' | 'tenant_email'
  // A PERSON of Bllink's resident list vs the portal links (03/10/2026,
  // migration 20261003161749): link a person the card does not carry, unlink
  // a phone Bllink no longer lists. Never applied without an approval.
  | 'portal_link' | 'portal_unlink';

/** The card's own fields — the ones a suggestion tag sits beside. */
export type CardSuggestionField = Exclude<SuggestionField, 'portal_link' | 'portal_unlink'>;

export const SUGGESTION_FIELD_LABEL: Record<SuggestionField, string> = {
  owner_name: 'שם בעלים',
  owner_phone: 'טלפון בעלים',
  owner_email: 'מייל בעלים',
  tenant_name: 'שם שוכר',
  tenant_phone: 'טלפון שוכר',
  tenant_email: 'מייל שוכר',
  portal_link: 'שיוך לפורטל',
  portal_unlink: 'ניתוק מהפורטל',
};

/** Suggestions that change who opens the portal: approved ONE BY ONE, never
 *  by "אשר הכל" (03/10/2026). An owner REPLACEMENT is one too — see
 *  ContactSuggestion.owner_change. */
export const ACCESS_SUGGESTION_FIELDS: ReadonlySet<SuggestionField> = new Set([
  'owner_phone', 'tenant_phone', 'portal_link', 'portal_unlink',
]);

/** Which fields read left to right — numbers and addresses. Hebrew names do
 *  not, so they keep the page's own direction. */
export const SUGGESTION_FIELD_IS_NUMERIC: Record<SuggestionField, boolean> = {
  owner_name: false,
  owner_phone: true,
  owner_email: true,
  tenant_name: false,
  tenant_phone: true,
  tenant_email: true,
  portal_link: true,
  portal_unlink: true,
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
  /** portal_link / portal_unlink: the person. null on a field suggestion. */
  phone_e164: string | null;
  person_role: 'owner' | 'tenant' | 'operator' | null;
  person_name: string | null;
  /** Changes portal access → one by one, never "אשר הכל". */
  access: boolean;
  /** An owner-name CHANGE (ours is not empty): approved only as "תיקון שם"
   *  or "החלפת בעלים", never by a plain approve. */
  owner_change: boolean;
  /** An owner phone waiting for its apartment's owner-name decision. */
  waits_for_owner_name: boolean;
  /** A tenant "שיוך" on a card that says the owner lives there: approving it
   *  turns the card's resident type to "שוכר" (the section must show). */
  marks_rented: boolean;
}

/** What "החלפת בעלים" will do — shown in its confirmation dialog. */
export interface OwnerReplacementPreview {
  apartment_number: string;
  from_name: string | null;
  to_name: string;
  /** The previous owner's phones that will be detached from the portal. */
  detach: { phone_e164: string; owner_name: string | null }[];
  /** The new owner's phone, approved with the replacement (if Bllink has one). */
  new_phone: string | null;
}

/** Who last changed each synced field of one apartment. A field nobody ever
 *  touched is simply absent. */
export type ContactFieldSources = Partial<Record<CardSuggestionField, {
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
