import 'server-only';
import { query, queryOne } from '@/lib/db';
import { visibleImportText } from '@/lib/debtor-import-text';
import type { PortalSession } from '@/lib/portal/session';
import type { PortalAccount } from '@/lib/types/portal';

// "החשבון שלי" — what an owner sees of their OWN apartment(s) in the portal,
// read from the debtors table (the Bllink sync target).
//
// THE RULE: the only input is the portal session. The apartments come from the
// roster (apartment_owner_phones) for the session's phone, never from the
// request, so no parameter, query string, body or header can point this at
// another apartment. A phone that owns several apartments (59 in production,
// 28/09/2026) gets one account per apartment.
//
// The SELECT names its columns: total_debt, management_fees, hot_water_debt,
// monthly_debt, details — and nothing else. Legal status, notes, next action,
// phones, emails, the operator, the archive flag and the other owners' names
// live in the same table and never leave this module. The name shown is the
// roster row's own owner_name (the person who signed in), not
// debtors.owner_name.
//
// Two edge cases:
//   • no debtors row (2 apartments in production) → a record with 0 debt;
//   • an archived row (a legal case or a debt handed over; 5 in production,
//     all with a balance) → shown exactly like any other apartment, with the
//     same figures and no mark of any kind (Ronen's decision 28/09/2026,
//     replacing the earlier "under review" card).

const DEBT_COLS = `
  apartment_number, total_debt::float8 as total_debt, management_fees::float8 as management_fees,
  hot_water_debt::float8 as hot_water_debt, monthly_debt, details`;

interface DebtRow {
  apartment_number: string;
  total_debt: number;
  management_fees: number;
  hot_water_debt: number;
  monthly_debt: string | null;
  details: string | null;
}

/** When the debtors table was last refreshed from Bllink: the source snapshot
 *  time of the newest successful sync (its finish time when that is missing),
 *  or null before any sync ever succeeded. */
export async function getLastSyncAt(): Promise<string | null> {
  const row = await queryOne<{ at: string | null }>(
    `select coalesce(source_run_at, finished_at)::text as at
       from public.sync_runs
      where status = 'success'
      order by finished_at desc nulls last
      limit 1`,
  );
  return row?.at ?? null;
}

function toAccount(apartment: string, ownerName: string | null, row: DebtRow | undefined, syncedAt: string | null): PortalAccount {
  if (!row) {
    return {
      apartment_number: apartment, owner_display_name: ownerName,
      total_debt: 0, management_fees: 0, hot_water_debt: 0, monthly_debt: null, details: null, synced_at: syncedAt,
    };
  }
  return {
    apartment_number: apartment, owner_display_name: ownerName,
    total_debt: row.total_debt, management_fees: row.management_fees, hot_water_debt: row.hot_water_debt,
    // Both describe the debt, so a leftover from an earlier report is never
    // shown next to a ₪0 balance — see lib/debtor-import-text.ts.
    monthly_debt: visibleImportText(row.monthly_debt, row.total_debt),
    details: visibleImportText(row.details, row.total_debt),
    synced_at: syncedAt,
  };
}

async function debtRowsFor(apartments: string[]): Promise<Map<string, DebtRow>> {
  const out = new Map<string, DebtRow>();
  if (apartments.length === 0) return out;
  const r = await query<DebtRow>(
    `select ${DEBT_COLS} from public.debtors where apartment_number = any($1::text[])`,
    [apartments],
  );
  for (const row of r.rows) out.set(row.apartment_number, row);
  return out;
}

/** The signed-in owner's account(s): one per apartment the session's phone is
 *  an ACTIVE owner of, in apartment order. Empty when the phone owns nothing
 *  (the session guard would already have revoked it). */
export async function getPortalMyAccount(session: PortalSession): Promise<PortalAccount[]> {
  const roster = await query<{ apartment_number: string; owner_name: string | null }>(
    `select apartment_number, owner_name
       from public.apartment_owner_phones
      where phone_e164 = $1 and is_active
      order by apartment_number`,
    [session.phoneE164],
  );
  const apartments = roster.rows.map((r) => r.apartment_number);
  const [rows, syncedAt] = await Promise.all([debtRowsFor(apartments), getLastSyncAt()]);
  return roster.rows.map((r) => toAccount(r.apartment_number, r.owner_name, rows.get(r.apartment_number), syncedAt));
}

/** The admin preview's "החשבון שלי" for ONE apartment the admin picked. Same
 *  shape and the same column list as the resident path, but a different entry
 *  point: it takes an apartment number, so it may only ever be reached from
 *  the staff route (/finance?view=resident) behind the staff session and the
 *  finance permission — the portal page never imports it. The name shown is
 *  the debtors row's owner (there is no signed-in owner to prefer). */
export async function getAdminPreviewAccount(apartment: string): Promise<PortalAccount | null> {
  const exists = await queryOne<{ n: number }>(
    `select 1 as n from public.contacts where apartment_number = $1 limit 1`,
    [apartment],
  );
  if (!exists) return null;
  const [rows, syncedAt, name] = await Promise.all([
    debtRowsFor([apartment]),
    getLastSyncAt(),
    queryOne<{ owner_name: string | null }>(`select owner_name from public.debtors where apartment_number = $1`, [apartment]),
  ]);
  return toAccount(apartment, name?.owner_name ?? null, rows.get(apartment), syncedAt);
}
