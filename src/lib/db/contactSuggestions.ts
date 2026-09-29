import 'server-only';
import { query, queryOne } from '@/lib/db';
import type {
  ContactFieldSources, ContactFieldState, ContactSuggestion, SuggestionField,
} from '@/lib/types/contactSuggestions';

// The Bllink approval queue. Every rule lives in SQL (migration
// 20260929194811) — one implementation of "did this value change", shared by
// the sync, the trigger and the approve/reject path, so no two copies of it can
// drift apart. This file only carries values across.

/** The live value of the suggested field, read from contacts rather than from
 *  the row: the stored current_value is the record of what we held when the
 *  suggestion was raised, and ours may have moved on since. */
const LIVE_VALUE = `
  case s.field
    when 'owner_name'  then c.owner_name
    when 'owner_phone' then c.owner_phone
    else c.tenant_phone
  end`;

/** Every open suggestion, newest first. The list is small by construction —
 *  one row per apartment+field at most. */
export async function listPendingSuggestions(): Promise<ContactSuggestion[]> {
  const r = await query<ContactSuggestion>(
    `select s.id, s.apartment_number, s.field,
            ${LIVE_VALUE} as current_value,
            s.proposed_value,
            s.created_at
       from public.contact_sync_suggestions s
       join public.contacts c on c.apartment_number = s.apartment_number
      where s.status = 'pending'
      order by s.created_at desc, s.apartment_number, s.field`,
  );
  return r.rows;
}

export async function countPendingSuggestions(): Promise<number> {
  const row = await queryOne<{ n: string }>(
    `select count(*)::text as n from public.contact_sync_suggestions where status = 'pending'`,
  );
  return Number(row?.n ?? 0);
}

/**
 * Approve or reject by id. Approving writes the value through
 * public.contacts — the very column the apartment card writes — so the portal
 * roster trigger picks up an owner phone immediately and that owner can sign
 * in without another step.
 *
 * Returns how many rows this call actually resolved: an id that was already
 * decided (or closed itself in the meantime) counts zero, which makes a double
 * click harmless.
 */
export async function resolveSuggestions(
  ids: string[],
  action: 'approve' | 'reject',
  actorId: string | null,
): Promise<number> {
  if (ids.length === 0) return 0;
  const row = await queryOne<{ n: number }>(
    `select public.contact_suggestion_resolve($1::uuid[], $2, $3::uuid) as n`,
    [ids, action, actorId],
  );
  return row?.n ?? 0;
}

/** Who last changed each synced field of one apartment — for the "ידני · תאריך"
 *  marker on the card. */
export async function getFieldSources(apartmentNumber: string): Promise<ContactFieldSources> {
  const r = await query<{ field: SuggestionField; source: 'manual' | 'bllink'; updated_at: string }>(
    `select field, source, updated_at
       from public.contact_field_sources
      where apartment_number = $1`,
    [apartmentNumber],
  );
  const out: ContactFieldSources = {};
  for (const row of r.rows) out[row.field] = { source: row.source, updated_at: row.updated_at };
  return out;
}

/** The open suggestions of ONE apartment — the badges on its card. */
export async function listSuggestionsForApartment(apartmentNumber: string): Promise<ContactSuggestion[]> {
  const r = await query<ContactSuggestion>(
    `select s.id, s.apartment_number, s.field,
            ${LIVE_VALUE} as current_value,
            s.proposed_value,
            s.created_at
       from public.contact_sync_suggestions s
       join public.contacts c on c.apartment_number = s.apartment_number
      where s.status = 'pending' and s.apartment_number = $1
      order by s.field`,
    [apartmentNumber],
  );
  return r.rows;
}

/** Both of the card's decorations in one round trip. Used by the apartment
 *  card's own endpoint and by the debtor detail it is rendered from, so the
 *  two can never answer differently. */
export async function getContactFieldState(apartmentNumber: string): Promise<ContactFieldState> {
  const [suggestions, sources] = await Promise.all([
    listSuggestionsForApartment(apartmentNumber),
    getFieldSources(apartmentNumber),
  ]);
  return { suggestions, sources };
}
