import 'server-only';
import { query } from '@/lib/db';
import { approvalsFor, LINK_NAME_SQL } from '@/lib/db/portal/identity';
import { decidePortalIdentity, type PortalRole } from '@/lib/portal/identity';
import { classifyBlockedPhone, type BlockedPhoneCategory } from '@/lib/portal/blockedClassify';
import type {
  ApprovedPortalIdentity, BlockedPortalPhone, IdentityRelation, OwnerPhoneSource,
} from '@/lib/types/portal';

// The "טלפונים חסומים" screen: every phone the portal blocks right now
// (lib/portal/identity.ts), each with its links, the classifier's suggestion,
// a waiting "same person" request and an entry flag; and the identities in
// force, so an approval can be revoked where it was given.

/** The screen's order: a suspected typing mistake first — it is the one that
 *  may show a stranger's apartment — then a missing name, then the rest. */
const CATEGORY_ORDER: BlockedPhoneCategory[] = ['unrelated', 'missing_name', 'family', 'company_contact', 'spelling'];

/** Numeric apartment order ('520' before '1001'), non-numeric last, as text. */
const APT_ORDER_SQL = (col: string) =>
  `(${col} ~ '^[0-9]+$') desc, case when ${col} ~ '^[0-9]+$' then ${col}::numeric end, ${col}`;

export async function listBlockedPortalPhones(): Promise<BlockedPortalPhone[]> {
  const [links, pending, flags] = await Promise.all([
    query<{
      id: string; phone_e164: string; apartment_number: string; owner_name: string | null;
      role: PortalRole; source_table: OwnerPhoneSource | null;
    }>(
      `select r.id, r.phone_e164, r.apartment_number, ${LINK_NAME_SQL('r')} as owner_name, r.role, r.source_table
         from public.apartment_owner_phones r
        where r.is_active
          and r.phone_e164 in (select phone_e164 from public.apartment_owner_phones
                                where is_active group by phone_e164 having count(*) > 1)
        order by r.phone_e164, ${APT_ORDER_SQL('r.apartment_number')}`,
    ),
    query<{ id: string; phone_e164: string; requested_by_name: string | null; requested_at: string }>(
      `select a.id, a.phone_e164, u.full_name as requested_by_name, a.requested_at::text as requested_at
         from public.portal_identity_approvals a
         left join public.users u on u.id = a.requested_by
        where a.status = 'pending'`,
    ),
    query<{ phone_e164: string }>(
      `select distinct phone_e164 from public.portal_phone_entry_flags where cleared_at is null`,
    ),
  ]);

  const byPhone = new Map<string, BlockedPortalPhone['links']>();
  for (const l of links.rows) {
    const list = byPhone.get(l.phone_e164) ?? [];
    list.push({ id: l.id, apartment_number: l.apartment_number, owner_name: l.owner_name, role: l.role, source_table: l.source_table });
    byPhone.set(l.phone_e164, list);
  }
  const approvals = await approvalsFor([...byPhone.keys()]);
  const flagged = new Set(flags.rows.map((f) => f.phone_e164));

  const out: BlockedPortalPhone[] = [];
  for (const [phone, list] of byPhone) {
    const identity = decidePortalIdentity(
      list.map((l) => ({ rosterId: l.id, apartmentNumber: l.apartment_number, role: l.role, name: l.owner_name })),
      approvals.get(phone) ?? null,
    );
    if (identity?.status !== 'blocked') continue;
    const p = pending.rows.find((x) => x.phone_e164 === phone);
    out.push({
      phone_e164: phone,
      category: classifyBlockedPhone(list.map((l) => l.owner_name), flagged.has(phone)),
      links: list,
      pending: p ? { id: p.id, requested_by_name: p.requested_by_name, requested_at: p.requested_at } : null,
      flagged: flagged.has(phone),
    });
  }
  return out.sort((a, b) =>
    CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category)
    || a.phone_e164.localeCompare(b.phone_e164));
}

export async function listApprovedIdentities(): Promise<ApprovedPortalIdentity[]> {
  const r = await query<Omit<ApprovedPortalIdentity, 'apartments'> & {
    apartments: { apartment_number: string; relation: IdentityRelation }[] | null;
  }>(
    `select a.id, a.phone_e164, a.display_name, a.names,
            u.full_name as decided_by_name, a.decided_at::text as decided_at,
            (select json_agg(json_build_object('apartment_number', x.apartment_number, 'relation', x.relation)
                             order by ${APT_ORDER_SQL('x.apartment_number')})
               from public.portal_identity_apartments x where x.approval_id = a.id) as apartments
       from public.portal_identity_approvals a
       left join public.users u on u.id = a.decided_by
      where a.status = 'approved'
      order by a.decided_at desc`,
  );
  return r.rows.map((x) => ({ ...x, apartments: x.apartments ?? [] }));
}
