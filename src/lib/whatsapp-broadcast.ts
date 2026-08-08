import 'server-only';
import { query } from '@/lib/db';
import {
  normalizePhone,
  cleanPhoneField,
} from '@/lib/whatsapp';
import {
  listExtraRecipientsForAllDebtors,
  listExtraRecipientsForDebtors,
  type ExtraRecipient,
} from '@/lib/db/contactPeople';
import type { TemplateDebtor } from '@/lib/whatsapp-template';
import type { BroadcastAudience } from '@/types/whatsapp';
import type { ContactPersonRole } from '@/lib/types/contacts';

// Audience → recipient resolution for WhatsApp broadcasts. The actual sending is
// now the durable delivery queue's job (src/lib/wa-queue/*, drained by the
// standalone worker) — the old fire-and-forget in-process runner was retired in
// the Phase 2 cutover. This module resolves recipients from debtors joined to
// the contacts registry; the campaigns route (POST /api/whatsapp/campaigns) and
// the live estimate (GET /api/whatsapp/audience-count) both call it.

export interface BroadcastRecipient {
  debtor: TemplateDebtor & { id: string };
  /** International digits ("972XXXXXXXXX"). */
  phoneIntl: string;
}

interface DebtorRow {
  id: string;
  owner_name: string | null;
  tenant_name: string | null;
  apartment_number: string;
  total_debt: number;
  management_fees: number;
  /** {{special}} source — Bllink's "special debt" lives in hot_water_debt;
   *  the special_debt column is legacy and always 0. */
  hot_water_debt: number;
  phone_owner: string | null;
  phone_tenant: string | null;
}

const DEBTOR_COLS = `
  d.id,
  case when rc.id is null then d.owner_name   else rc.owner_name   end as owner_name,
  case when rc.id is null then d.tenant_name  else rc.tenant_name  end as tenant_name,
  d.apartment_number,
  d.total_debt::float8      as total_debt,
  d.management_fees::float8 as management_fees,
  d.hot_water_debt::float8  as hot_water_debt,
  case when rc.id is null then d.phone_owner  else rc.owner_phone  end as phone_owner,
  case when rc.id is null then d.phone_tenant else rc.tenant_phone end as phone_tenant
`;

// resident identity from contacts (registry); debtors columns are frozen legacy fallback (no linked contact only)
const DEBTOR_FROM = `
  from public.debtors d
  left join public.contacts rc on rc.id = d.contact_id
`;

/** Normalise a debtor phone field to international form, or null. */
function toIntl(field: string | null): string | null {
  const local = cleanPhoneField(field);
  if (!local) return null;
  try {
    return normalizePhone(local).phone;
  } catch {
    return null;
  }
}

/** Which contact_people roles an audience pulls in as extra recipients. */
function extraRoles(audience: BroadcastAudience): ContactPersonRole[] {
  if (audience.type === 'owners') return ['owner'];
  if (audience.type === 'tenants') return ['tenant'];
  return ['owner', 'tenant']; // 'all' / 'debtor_ids'
}

/**
 * Resolve the recipient list for an audience. Picks the matching phone field
 * (owners → phone_owner, tenants → phone_tenant, all/explicit → owner else
 * tenant), keeps only debtors with a valid number, and de-dups by phone. The
 * caller snapshots the result into wa_campaign_recipients, so a later audience
 * change never alters an already-started broadcast.
 *
 * On top of that primary phone, every ADDITIONAL owner/tenant on the apartment
 * card (public.contact_people) that is flagged "מקבל הודעות" and carries a valid
 * number becomes its own recipient — same debtor payload, so the template
 * variables ({{debt}}, {{apartment}}, …) interpolate identically. The phone
 * de-dup is global, so a person listed twice is still messaged once.
 */
export async function resolveBroadcastRecipients(
  audience: BroadcastAudience,
): Promise<BroadcastRecipient[]> {
  let rows: DebtorRow[];
  let extras: ExtraRecipient[];
  const roles = extraRoles(audience);
  if (audience.type === 'debtor_ids') {
    const ids = (audience.debtor_ids ?? []).filter((x) => typeof x === 'string');
    if (ids.length === 0) return [];
    const r = await query<DebtorRow>(
      `select ${DEBTOR_COLS} ${DEBTOR_FROM} where d.id = any($1::uuid[])`,
      [ids],
    );
    rows = r.rows;
    extras = await listExtraRecipientsForDebtors(ids, roles);
  } else {
    const r = await query<DebtorRow>(
      `select ${DEBTOR_COLS} ${DEBTOR_FROM} where d.is_archived = false`,
    );
    rows = r.rows;
    extras = await listExtraRecipientsForAllDebtors(roles);
  }

  const out: BroadcastRecipient[] = [];
  const seen = new Set<string>();
  const byDebtorId = new Map<string, DebtorRow>(rows.map((r) => [r.id, r]));

  const push = (row: DebtorRow, phoneIntl: string) => {
    if (seen.has(phoneIntl)) return;
    seen.add(phoneIntl);
    out.push({
      debtor: {
        id: row.id,
        owner_name: row.owner_name,
        tenant_name: row.tenant_name,
        apartment_number: row.apartment_number,
        total_debt: row.total_debt,
        management_fees: row.management_fees,
        hot_water_debt: row.hot_water_debt,
      },
      phoneIntl,
    });
  };

  for (const row of rows) {
    let phoneIntl: string | null = null;
    if (audience.type === 'owners') {
      phoneIntl = toIntl(row.phone_owner);
    } else if (audience.type === 'tenants') {
      phoneIntl = toIntl(row.phone_tenant);
    } else {
      // 'all' or 'debtor_ids' — prefer owner, fall back to tenant.
      phoneIntl = toIntl(row.phone_owner) ?? toIntl(row.phone_tenant);
    }
    if (!phoneIntl) continue;
    push(row, phoneIntl);
  }

  // Additional owners/tenants from the apartment card.
  for (const extra of extras) {
    const row = byDebtorId.get(extra.debtor_id);
    if (!row) continue;
    const phoneIntl = toIntl(extra.phone);
    if (!phoneIntl) continue;
    push(row, phoneIntl);
  }
  return out;
}
