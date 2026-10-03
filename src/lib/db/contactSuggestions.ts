import 'server-only';
import { query, queryOne, withTransaction } from '@/lib/db';
import type {
  CardSuggestionField, ContactFieldSources, ContactFieldState, ContactSuggestion, OwnerReplacementPreview,
} from '@/lib/types/contactSuggestions';

// The Bllink approval queue. Every rule lives in SQL (migrations
// 20260929194811 + 20260929211433 + 20260929212603) — one implementation of "did this value change", shared by
// the sync, the trigger and the approve/reject path, so no two copies of it can
// drift apart. This file only carries values across.

/** The live value of the suggested field, read from contacts rather than from
 *  the row: the stored current_value is the record of what we held when the
 *  suggestion was raised, and ours may have moved on since. */
const LIVE_VALUE = `
  case s.field
    when 'owner_name'   then c.owner_name
    when 'owner_phone'  then c.owner_phone
    when 'owner_email'  then c.owner_email
    when 'tenant_name'  then c.tenant_name
    when 'tenant_phone' then c.tenant_phone
    when 'tenant_email' then c.tenant_email
    else null
  end`;

/** An owner-name CHANGE: ours is not empty and differs — the same predicate
 *  contact_suggestion_resolve applies (migration 20261003161749). */
const OWNER_CHANGE = (sug: string) => `(${sug}.field = 'owner_name'
    and nullif(btrim(coalesce(c.owner_name, '')), '') is not null
    and public.contact_value_norm('owner_name', c.owner_name)
        is distinct from public.contact_value_norm('owner_name', ${sug}.proposed_value))`;

/** Every column the screens need, decisions included. */
const SUGGESTION_SELECT = `
  select s.id, s.apartment_number, s.field,
         ${LIVE_VALUE} as current_value,
         s.proposed_value,
         s.created_at,
         s.phone_e164, s.person_role, s.person_name,
         s.field in ('owner_phone', 'tenant_phone', 'portal_link', 'portal_unlink') as access,
         ${OWNER_CHANGE('s')} as owner_change,
         (s.field = 'portal_link' and s.person_role = 'tenant' and c.resident_type = 'owner') as marks_rented,
         (s.field = 'owner_phone' and exists (
            select 1 from public.contact_sync_suggestions n
             where n.apartment_number = s.apartment_number and n.status = 'pending'
               and ${OWNER_CHANGE('n')})) as waits_for_owner_name
    from public.contact_sync_suggestions s
    join public.contacts c on c.apartment_number = s.apartment_number`;

/** Every open suggestion, newest first. Small by construction — one row per
 *  apartment+field, and one per apartment+phone for the person suggestions. */
export async function listPendingSuggestions(): Promise<ContactSuggestion[]> {
  const r = await query<ContactSuggestion>(
    `${SUGGESTION_SELECT}
      where s.status = 'pending'
      order by s.created_at desc, s.apartment_number, s.field, s.phone_e164`,
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
 * roster follows at COMMIT. The rules (all in contact_suggestion_resolve):
 * several ids approve only what does not change portal access; an owner-name
 * change needs 'approve_rename' or 'approve_replace'; every decision is
 * logged.
 *
 * Returns how many rows this call actually resolved: an id that was already
 * decided (or closed itself in the meantime) counts zero, which makes a double
 * click harmless.
 */
export async function resolveSuggestions(
  ids: string[],
  action: 'approve' | 'reject' | 'approve_rename' | 'approve_replace',
  actorId: string | null,
): Promise<number> {
  if (ids.length === 0) return 0;
  const row = await queryOne<{ n: number }>(
    `select public.contact_suggestion_resolve($1::uuid[], $2, $3::uuid) as n`,
    [ids, action, actorId],
  );
  return row?.n ?? 0;
}

/** "החלפת בעלים" for one owner-name suggestion: which phones it detaches
 *  (contact_owner_replacement_targets — the same function the approval
 *  applies) and which new phone it approves with it. null = not a pending
 *  owner-name change. */
export async function getOwnerReplacementPreview(id: string): Promise<OwnerReplacementPreview | null> {
  const s = await queryOne<{ apartment_number: string; from_name: string | null; to_name: string; new_phone: string | null }>(
    `select s.apartment_number, c.owner_name as from_name, s.proposed_value as to_name,
            (select p.proposed_value from public.contact_sync_suggestions p
              where p.apartment_number = s.apartment_number
                and p.field = 'owner_phone' and p.status = 'pending') as new_phone
       from public.contact_sync_suggestions s
       join public.contacts c on c.apartment_number = s.apartment_number
      where s.id = $1 and s.status = 'pending' and ${OWNER_CHANGE('s')}`,
    [id],
  );
  if (!s) return null;
  const t = await query<{ phone_e164: string; owner_name: string | null }>(
    `select phone_e164, owner_name from public.contact_owner_replacement_targets($1, $2)`,
    [s.apartment_number, s.new_phone],
  );
  return { ...s, detach: t.rows };
}

/** Containment (03/10/2026): "ניתוק" suggestions from Bllink are held back
 *  until they are decided by phone and not by name. While false, the
 *  portal_unlink rows one run creates are dropped inside that same
 *  transaction, so none is ever visible; links and everything else still run. */
const BLLINK_UNLINK_SUGGESTIONS = false;

/** Bllink's people of one scrape vs the portal links → "שיוך" / "ניתוק"
 *  suggestions (portal_link_suggest). Suggests only. */
export async function suggestPortalLinks(scrapeId: string): Promise<{
  suggested_link: number; suggested_unlink: number; closed: number;
}> {
  return withTransaction(async (client) => {
    const r = await client.query<{ suggested_link: number; suggested_unlink: number; closed: number }>(
      `select * from public.portal_link_suggest($1::uuid)`,
      [scrapeId],
    );
    const row = r.rows[0] ?? { suggested_link: 0, suggested_unlink: 0, closed: 0 };
    if (BLLINK_UNLINK_SUGGESTIONS) return row;
    // created_at defaults to now(), the transaction's start: exactly the rows
    // this call inserted, never an older one.
    await client.query(
      `delete from public.contact_sync_suggestions
        where field = 'portal_unlink' and status = 'pending' and created_at = now()`,
    );
    return { ...row, suggested_unlink: 0 };
  });
}

/** Who last changed each synced field of one apartment — for the "ידני · תאריך"
 *  marker on the card. */
export async function getFieldSources(apartmentNumber: string): Promise<ContactFieldSources> {
  const r = await query<{ field: CardSuggestionField; source: 'manual' | 'bllink'; updated_at: string }>(
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
    `${SUGGESTION_SELECT}
      where s.status = 'pending' and s.apartment_number = $1
      order by s.field, s.phone_e164`,
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
