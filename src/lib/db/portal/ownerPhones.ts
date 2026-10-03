import 'server-only';
import { query, queryOne } from '@/lib/db';
import { decidePortalIdentity, type PortalRole } from '@/lib/portal/identity';
import { approvalsFor, LINK_NAME_SQL, SOURCE_NAME_SQL } from '@/lib/db/portal/identity';
import type { OwnerPhone, OwnerPhoneSource } from '@/lib/types/portal';

// The portal roster (apartment_owner_phones): which phone may sign in for which
// apartment. Several owners per apartment and several apartments per phone are
// both normal, so every lookup returns a LIST.
//
// Since 03/10/2026 (migrations 20261003095149 + 20261003161745) the roster
// MIRRORS the apartment's records in the three portal roles — owner, tenant,
// operator: the deferred triggers portal_roster_sync_* write it, and the ONLY
// write this module makes is a DETACH. There is no add — a phone reaches the
// portal through the apartment's card and nothing else.

/** Numeric apartment order ('520' before '1001'), non-numeric last, as text. */
const APT_ORDER_SQL = (col: string) =>
  `(${col} ~ '^[0-9]+$') desc, case when ${col} ~ '^[0-9]+$' then ${col}::numeric end, ${col}`;

interface OwnerPhoneRow {
  id: string;
  apartment_number: string;
  owner_name: string | null;
  role: PortalRole;
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
    `select r.id, r.apartment_number, r.owner_name, r.role, r.phone_e164, r.is_active,
            r.created_at::text as created_at, r.source_table,
            ${SOURCE_NAME_SQL('r')} as source_name,
            r.detached_at::text as detached_at, r.detach_reason
       from public.apartment_owner_phones r
      where r.apartment_number = $1
      order by r.is_active desc, coalesce(r.owner_name, ''), r.phone_e164`,
    [apartmentNumber],
  );
  if (r.rows.length === 0) return [];

  // Everything the same phones open — one query for the whole card — and
  // whether each phone is one person (lib/portal/identity.ts).
  const phones = [...new Set(r.rows.map((x) => x.phone_e164))];
  const [links, approvals] = await Promise.all([
    query<{ id: string; phone_e164: string; apartment_number: string; owner_name: string | null; role: PortalRole }>(
      `select r.id, r.phone_e164, r.apartment_number, ${LINK_NAME_SQL('r')} as owner_name, r.role
         from public.apartment_owner_phones r
        where r.phone_e164 = any($1::text[]) and r.is_active
        order by ${APT_ORDER_SQL('r.apartment_number')}`,
      [phones],
    ),
    approvalsFor(phones),
  ]);
  const byPhone = new Map<string, typeof links.rows>();
  for (const l of links.rows) {
    const list = byPhone.get(l.phone_e164) ?? [];
    list.push(l);
    byPhone.set(l.phone_e164, list);
  }

  return r.rows.map((x) => {
    const active = byPhone.get(x.phone_e164) ?? [];
    const identity = decidePortalIdentity(
      active.map((l) => ({ rosterId: l.id, apartmentNumber: l.apartment_number, role: l.role, name: l.owner_name })),
      approvals.get(x.phone_e164) ?? null,
    );
    return {
      ...x,
      other_apartments: active.map((l) => l.apartment_number).filter((a) => a !== x.apartment_number),
      blocked: identity?.status === 'blocked',
    };
  });
}

/**
 * THE per-request check behind every authenticated /portal page: does this
 * phone still hold an ACTIVE link, in any role? A sale or a tenant moving out
 * that removes the record (or a detach) closes access on the next request,
 * with no manual step — which is why the session guard re-runs this instead
 * of trusting the session row.
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
