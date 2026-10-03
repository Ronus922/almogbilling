import 'server-only';
import { query } from '@/lib/db';
import {
  decidePortalIdentity, type IdentityApproval, type IdentityLink, type PortalIdentity, type PortalRole,
} from '@/lib/portal/identity';

// The server side of the portal's ONE identity decision (lib/portal/identity.ts).
// Everything the portal says about a verified phone — the name in the header
// and on a fault, the apartments and the role in each, what may be seen, and
// whether the phone is blocked — is read through resolvePortalIdentity(). No
// page, route or helper of the portal works a name or a permission out on its
// own (03/10/2026, "זהות אחידה").

/** The name on the record that carries a link's phone, read LIVE — the field
 *  beside the phone (owner / tenant / operator) or the contact_people row.
 *  NULL when no record carries it, or the record has no name. */
export const SOURCE_NAME_SQL = (r: string) => `case ${r}.source_table
    when 'contacts' then (select nullif(btrim(case ${r}.source_field
                                                 when 'tenant_phone' then c.tenant_name
                                                 when 'operator_phone' then c.operator_name
                                                 else c.owner_name end), '')
                            from public.contacts c where c.id = ${r}.source_row_id)
    when 'contact_people' then (select nullif(btrim(p.name), '') from public.contact_people p where p.id = ${r}.source_row_id)
  end`;

/** THE name of a link, everywhere the identity is decided: the record's
 *  name, live; the roster's own label only when no record says one. The sync
 *  keeps the label in step at every commit, but a label left stale by a
 *  direct write must not decide who a phone is. */
export const LINK_NAME_SQL = (r: string) => `coalesce(${SOURCE_NAME_SQL(r)}, nullif(btrim(${r}.owner_name), ''))`;

/** The approval in force for each phone (status 'approved'), by phone. */
export async function approvalsFor(phones: readonly string[]): Promise<Map<string, IdentityApproval>> {
  const out = new Map<string, IdentityApproval>();
  if (phones.length === 0) return out;
  const r = await query<{ id: string; phone_e164: string; display_name: string; names: string[] }>(
    `select id, phone_e164, display_name, names
       from public.portal_identity_approvals
      where phone_e164 = any($1::text[]) and status = 'approved'`,
    [phones],
  );
  for (const a of r.rows) out.set(a.phone_e164, { id: a.id, displayName: a.display_name, names: a.names });
  return out;
}

/** The phone's ACTIVE links and its approved identity, decided. null = the
 *  phone opens nothing (the session guard revokes such a session). */
export async function resolvePortalIdentity(phoneE164: string): Promise<PortalIdentity | null> {
  const [links, approvals] = await Promise.all([
    query<{ id: string; apartment_number: string; role: PortalRole; owner_name: string | null }>(
      `select r.id, r.apartment_number, r.role, ${LINK_NAME_SQL('r')} as owner_name
         from public.apartment_owner_phones r
        where r.phone_e164 = $1 and r.is_active`,
      [phoneE164],
    ),
    approvalsFor([phoneE164]),
  ]);
  const rows: IdentityLink[] = links.rows.map((r) => ({
    rosterId: r.id, apartmentNumber: r.apartment_number, role: r.role, name: r.owner_name,
  }));
  return decidePortalIdentity(rows, approvals.get(phoneE164) ?? null);
}

/**
 * Which apartments a phone is on — for the login's event log, BEFORE the code
 * is verified. No name and no decision: an unverified phone is told nothing,
 * and the log only needs the apartments so the apartment card can show the
 * attempt. `onlyActive` separates the two rejections the log tells apart:
 * a phone that exists but is switched off is `phone_inactive`, not
 * `phone_not_found`.
 */
export async function findPortalRegistration(
  phoneE164: string,
  opts: { onlyActive: boolean },
): Promise<{ apartmentNumbers: string[] } | null> {
  const r = await query<{ apartment_number: string }>(
    `select apartment_number
       from public.apartment_owner_phones
      where phone_e164 = $1
        and ($2::boolean = false or is_active)
      order by apartment_number`,
    [phoneE164, opts.onlyActive],
  );
  if (r.rows.length === 0) return null;
  return { apartmentNumbers: r.rows.map((x) => x.apartment_number) };
}
