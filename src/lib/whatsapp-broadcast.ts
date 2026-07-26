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
// the Phase 2 cutover. This module resolves recipients from debtors (there is no
// contacts table); the campaigns route (POST /api/whatsapp/campaigns) and the
// live estimate (GET /api/whatsapp/audience-count) both call it.

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
  special_debt: number;
  phone_owner: string | null;
  phone_tenant: string | null;
}

const DEBTOR_COLS = `
  id, owner_name, tenant_name, apartment_number,
  total_debt::float8      as total_debt,
  management_fees::float8 as management_fees,
  special_debt::float8    as special_debt,
  phone_owner, phone_tenant
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
      `select ${DEBTOR_COLS} from public.debtors where id = any($1::uuid[])`,
      [ids],
    );
    rows = r.rows;
    extras = await listExtraRecipientsForDebtors(ids, roles);
  } else {
    const r = await query<DebtorRow>(
      `select ${DEBTOR_COLS} from public.debtors where is_archived = false`,
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
        special_debt: row.special_debt,
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
