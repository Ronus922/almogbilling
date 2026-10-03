import 'server-only';
import { query, queryOne } from '@/lib/db';
import { hasMixedOwners } from '@/lib/portal/ownership';
import type { BlockedPortalPhone, OwnerIdentity, OwnerPhone, OwnerPhoneSource } from '@/lib/types/portal';

// The portal roster (apartment_owner_phones): which phone may sign in for which
// apartment. Several owners per apartment and several apartments per phone are
// both normal, so every lookup returns a LIST.
//
// Since 03/10/2026 (migration 20261003095149) the roster MIRRORS the owner
// records: the deferred triggers portal_roster_sync_* write it, and the ONLY
// write this module makes is a DETACH. There is no add — a phone reaches the
// portal through the apartment's owner record (contacts.owner_phone or a
// contact_people owner) and nothing else.

/** The name on the record that carries a row's phone, read live. */
const SOURCE_NAME_SQL = `case r.source_table
    when 'contacts' then (select nullif(btrim(c.owner_name), '') from public.contacts c where c.id = r.source_row_id)
    when 'contact_people' then (select nullif(btrim(p.name), '') from public.contact_people p where p.id = r.source_row_id)
  end`;

/** Numeric apartment order ('520' before '1001'), non-numeric last, as text. */
const APT_ORDER_SQL = (col: string) =>
  `(${col} ~ '^[0-9]+$') desc, case when ${col} ~ '^[0-9]+$' then ${col}::numeric end, ${col}`;

interface OwnerPhoneRow {
  id: string;
  apartment_number: string;
  owner_name: string | null;
  phone_e164: string;
  is_active: boolean;
  created_at: string;
  source_table: OwnerPhoneSource | null;
  source_name: string | null;
  detached_at: string | null;
  detach_reason: string | null;
}

/** Every roster row of one apartment — "טלפון ← דירות בפורטל", active first —
 *  each with the record that carries it and the phone's other apartments. */
export async function listOwnerPhones(apartmentNumber: string): Promise<OwnerPhone[]> {
  const r = await query<OwnerPhoneRow>(
    `select r.id, r.apartment_number, r.owner_name, r.phone_e164, r.is_active,
            r.created_at::text as created_at, r.source_table,
            ${SOURCE_NAME_SQL} as source_name,
            r.detached_at::text as detached_at, r.detach_reason
       from public.apartment_owner_phones r
      where r.apartment_number = $1
      order by r.is_active desc, coalesce(r.owner_name, ''), r.phone_e164`,
    [apartmentNumber],
  );
  if (r.rows.length === 0) return [];

  // Everything the same phones open — one query for the whole card.
  const phones = [...new Set(r.rows.map((x) => x.phone_e164))];
  const links = await query<{ phone_e164: string; apartment_number: string; owner_name: string | null }>(
    `select phone_e164, apartment_number, owner_name
       from public.apartment_owner_phones
      where phone_e164 = any($1::text[]) and is_active
      order by ${APT_ORDER_SQL('apartment_number')}`,
    [phones],
  );
  const byPhone = new Map<string, { apartment_number: string; owner_name: string | null }[]>();
  for (const l of links.rows) {
    const list = byPhone.get(l.phone_e164) ?? [];
    list.push(l);
    byPhone.set(l.phone_e164, list);
  }

  return r.rows.map((x) => {
    const active = byPhone.get(x.phone_e164) ?? [];
    return {
      ...x,
      other_apartments: active.map((l) => l.apartment_number).filter((a) => a !== x.apartment_number),
      mixed_owners: hasMixedOwners(active),
    };
  });
}

/**
 * Every phone the containment blocks right now: its ACTIVE links belong to
 * different people (lib/portal/ownership.ts). The admin unifies the name on
 * the apartment card or detaches the wrong link — this list is where they see
 * which.
 */
export async function listBlockedPortalPhones(): Promise<BlockedPortalPhone[]> {
  const r = await query<{
    id: string;
    phone_e164: string;
    apartment_number: string;
    owner_name: string | null;
    source_table: OwnerPhoneSource | null;
  }>(
    `select r.id, r.phone_e164, r.apartment_number, r.owner_name, r.source_table
       from public.apartment_owner_phones r
      where r.is_active
        and r.phone_e164 in (select phone_e164 from public.apartment_owner_phones
                              where is_active group by phone_e164 having count(*) > 1)
      order by r.phone_e164, ${APT_ORDER_SQL('r.apartment_number')}`,
  );
  const byPhone = new Map<string, BlockedPortalPhone>();
  for (const row of r.rows) {
    const entry = byPhone.get(row.phone_e164) ?? { phone_e164: row.phone_e164, links: [] };
    entry.links.push({
      id: row.id,
      apartment_number: row.apartment_number,
      owner_name: row.owner_name,
      source_table: row.source_table,
    });
    byPhone.set(row.phone_e164, entry);
  }
  return [...byPhone.values()].filter((p) => hasMixedOwners(p.links));
}

/**
 * Resolve a phone to the apartments it may sign in for. `onlyActive` separates
 * the two rejection cases the log has to tell apart: with it false, a phone that
 * exists but is switched off still resolves — that is `phone_inactive` rather
 * than `phone_not_found`.
 */
export async function findOwnerIdentity(
  phoneE164: string,
  opts: { onlyActive: boolean },
): Promise<OwnerIdentity | null> {
  const r = await query<{ apartment_number: string; owner_name: string | null; is_active: boolean }>(
    `select apartment_number, owner_name, is_active
       from public.apartment_owner_phones
      where phone_e164 = $1
        and ($2::boolean = false or is_active)
      order by apartment_number`,
    [phoneE164, opts.onlyActive],
  );
  if (r.rows.length === 0) return null;
  return {
    apartmentNumbers: r.rows.map((x) => x.apartment_number),
    ownerName: r.rows.find((x) => x.owner_name && x.owner_name.trim())?.owner_name ?? null,
    // Judged on the ACTIVE rows only — they are what the portal would show.
    mixedOwners: hasMixedOwners(r.rows.filter((x) => x.is_active)),
  };
}

/**
 * Containment (03/10/2026, lib/portal/ownership.ts): does this phone's set of
 * ACTIVE apartments span different people? Such a phone signs in and may
 * report a fault, but no financial figure is served to it — every finance
 * entry point of the portal asks this first.
 */
export async function isMixedOwnerPhone(phoneE164: string): Promise<boolean> {
  const r = await query<{ apartment_number: string; owner_name: string | null }>(
    `select apartment_number, owner_name
       from public.apartment_owner_phones
      where phone_e164 = $1 and is_active`,
    [phoneE164],
  );
  return hasMixedOwners(r.rows);
}

/**
 * THE per-request check behind every authenticated /portal page: is this phone
 * still an ACTIVE owner? A sale that removes the row (or switches it off) closes
 * access on the next request, with no manual step — which is why the session
 * guard re-runs this instead of trusting the session row.
 */
export async function isActiveOwner(phoneE164: string): Promise<boolean> {
  const row = await queryOne<{ n: number }>(
    `select 1 as n from public.apartment_owner_phones
      where phone_e164 = $1 and is_active limit 1`,
    [phoneE164],
  );
  return row !== null;
}

export interface DetachedOwnerPhone {
  id: string;
  apartment_number: string;
  phone_e164: string;
  owner_name: string | null;
}

/**
 * Detach one ACTIVE roster row, scoped to its apartment so an id from another
 * apartment cannot be reached through this apartment's endpoint. Sticky: the
 * sync does not re-link it while the owner record still holds the phone (see
 * the migration). null = no such active row.
 */
export async function detachOwnerPhone(
  apartmentNumber: string,
  id: string,
  actorUserId: string,
): Promise<DetachedOwnerPhone | null> {
  return queryOne<DetachedOwnerPhone>(
    `update public.apartment_owner_phones
        set is_active = false, detached_at = now(), detached_by = $3, detach_reason = 'admin'
      where id = $1 and apartment_number = $2 and is_active
      returning id, apartment_number, phone_e164, owner_name`,
    [id, apartmentNumber, actorUserId],
  );
}
