import 'server-only';
import { query, queryOne } from '@/lib/db';
import { hasMixedOwners } from '@/lib/portal/ownership';
import type { OwnerIdentity, OwnerPhone } from '@/lib/types/portal';

// The portal roster (apartment_owner_phones): which phone may sign in for which
// apartment. Several owners per apartment and several apartments per phone are
// both normal, so every lookup returns a LIST.

const COLS = `id, apartment_number, owner_name, phone_e164, is_active, created_at`;

/** Every roster row of one apartment — the "בעלי דירה" tab, active first. */
export async function listOwnerPhones(apartmentNumber: string): Promise<OwnerPhone[]> {
  const r = await query<OwnerPhone>(
    `select ${COLS} from public.apartment_owner_phones
      where apartment_number = $1
      order by is_active desc, coalesce(owner_name, ''), phone_e164`,
    [apartmentNumber],
  );
  return r.rows;
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

export interface CreateOwnerPhoneArgs {
  apartmentNumber: string;
  ownerName: string | null;
  phoneE164: string;
  createdBy: string;
}

/** Adds a phone to an apartment. Returns null when that pair already exists
 *  (the unique key) so the route can answer 409 instead of a raw pg error. */
export async function createOwnerPhone(args: CreateOwnerPhoneArgs): Promise<OwnerPhone | null> {
  const row = await queryOne<OwnerPhone>(
    `insert into public.apartment_owner_phones
       (apartment_number, owner_name, phone_e164, created_by)
     values ($1, $2, $3, $4)
     on conflict (apartment_number, phone_e164) do nothing
     returning ${COLS}`,
    [args.apartmentNumber, args.ownerName, args.phoneE164, args.createdBy],
  );
  return row;
}

export interface UpdateOwnerPhoneArgs {
  ownerName?: string | null;
  isActive?: boolean;
}

/** Edit / deactivate one roster row, scoped to its apartment so an id from
 *  another apartment cannot be reached through this apartment's endpoint. */
export async function updateOwnerPhone(
  apartmentNumber: string,
  id: string,
  args: UpdateOwnerPhoneArgs,
): Promise<OwnerPhone | null> {
  const sets: string[] = [];
  const params: unknown[] = [];
  let n = 1;
  if (args.ownerName !== undefined) { sets.push(`owner_name = $${n++}`); params.push(args.ownerName); }
  if (args.isActive !== undefined) { sets.push(`is_active = $${n++}`); params.push(args.isActive); }
  if (sets.length === 0) {
    return queryOne<OwnerPhone>(
      `select ${COLS} from public.apartment_owner_phones where id = $1 and apartment_number = $2`,
      [id, apartmentNumber],
    );
  }
  params.push(id, apartmentNumber);
  return queryOne<OwnerPhone>(
    `update public.apartment_owner_phones set ${sets.join(', ')}
      where id = $${n++} and apartment_number = $${n}
      returning ${COLS}`,
    params,
  );
}
