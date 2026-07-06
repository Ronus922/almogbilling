import 'server-only';
import { query, queryOne, withTransaction } from '@/lib/db';
import { phoneDigitsKey } from '@/lib/whatsapp';
import type { Tenant } from '@/types/tenant';

export interface Debtor {
  id: string;
  apartment_number: string;
  owner_name: string | null;
  tenant_name: string | null;
  address: string | null;
  phone_owner: string | null;
  phone_tenant: string | null;
  email_owner: string | null;
  email_tenant: string | null;
  total_debt: number;
  management_fees: number;
  monthly_debt: string | null;
  hot_water_debt: number;
  special_debt: number;
  details: string | null;
  legal_status_id: string | null;
  legal_status_name: string | null;
  legal_status_color: string | null;
  legal_status_is_default: boolean | null;
  next_action_description: string | null;
  next_action_date: string | null;
  is_archived: boolean;
  archived_at: Date | null;
  last_imported_at: Date | null;
  // Documentation indicator (list query only): comments + events count and the
  // most recent of the two timestamps. 0 / null when nothing is documented.
  doc_count: number;
  last_doc_at: Date | null;
}

export interface DashboardKpis {
  managementDebtTotal: number;
  hotWaterDebtTotal: number;
  immediateCollectionCount: number;
  warningLetterCount: number;
  legalCareCount: number;
  legalProceedingCount: number;
}

/** A single charted month: total open debt + the DERIVED collection for that month. */
export interface MonthlyDebtPoint {
  year: number;
  month: number; // 1-12
  /** ISO `YYYY-MM` — the UI formats the display label. */
  ym: string;
  totalDebt: number;
  /** prev.totalDebt − this.totalDebt, clamped ≥ 0 (no per-payment data exists). */
  collection: number;
  /** collection / prev.totalDebt (0 when there is no prior month or prior debt). */
  collectionRate: number;
  /** True for the earliest charted month when it had no prior snapshot to derive
   *  collection from — the UI shows "—" for its rate instead of a misleading 0%.
   *  (Once ≥ months+1 snapshots accrue the baseline is dropped from the window,
   *  so no charted point carries this.) */
  isBaseline: boolean;
}

/** Hero KPI trio derived from the snapshot series + live debtor totals. */
export interface CollectionKpis {
  /** Derived collection for the current (latest) month. */
  collectedThisMonth: number;
  /** Live sum of total_debt over non-archived debtors (current open balance). */
  openDebtBalance: number;
  /** Mean collectionRate across the charted window. */
  avgCollectionRate: number;
  /** Latest month's rate − previous month's rate (trend arrow). */
  avgCollectionRateDelta: number;
}

export interface CollectionVsDebt {
  series: MonthlyDebtPoint[];
  kpis: CollectionKpis;
}

export interface TabCounts {
  active: number;
  warningLetter: number;
  legalCare: number;
  legalProceeding: number;
  actions: number;
  archived: number;
}

export type TabKey = 'active' | 'warning' | 'legal-care' | 'legal-proceeding' | 'actions' | 'archived';

// The `debtors ⨝ statuses` base from-clause used by every query.
// LEFT JOIN so legacy null legal_status_id still returns the row.
const DEBTORS_JOIN = `public.debtors d left join public.statuses s on s.id = d.legal_status_id`;

// Status names that drive KPIs / tabs. Seeded by 003_debtor_panel.sql.
// If a seed name changes, update here in lockstep.
const STATUS_WARNING = 'מכתב התראה';
const STATUS_LEGAL_CARE = 'לטיפול משפטי';
const STATUS_LEGAL_PROCEEDING = 'בהליך משפטי';

export async function getDashboardKpis(): Promise<DashboardKpis> {
  const row = await queryOne<{
    management_total: string;
    hot_water_total: string;
    immediate_count: string;
    warning_count: string;
    legal_care_count: string;
    legal_proceeding_count: string;
  }>(
    `select
       coalesce(sum(d.management_fees) filter (where d.is_archived = false), 0)::text as management_total,
       coalesce(sum(d.hot_water_debt)  filter (where d.is_archived = false), 0)::text as hot_water_total,
       count(*) filter (
         where d.is_archived = false
           and d.total_debt > 0
           and (d.legal_status_id is null or s.is_default = true)
       )::text as immediate_count,
       count(*) filter (where d.is_archived = false and s.name = $1)::text as warning_count,
       count(*) filter (where d.is_archived = false and s.name = $2)::text as legal_care_count,
       count(*) filter (where d.is_archived = false and s.name = $3)::text as legal_proceeding_count
     from ${DEBTORS_JOIN}`,
    [STATUS_WARNING, STATUS_LEGAL_CARE, STATUS_LEGAL_PROCEEDING],
  );
  return {
    managementDebtTotal: Number(row?.management_total ?? 0),
    hotWaterDebtTotal: Number(row?.hot_water_total ?? 0),
    immediateCollectionCount: Number(row?.immediate_count ?? 0),
    warningLetterCount: Number(row?.warning_count ?? 0),
    legalCareCount: Number(row?.legal_care_count ?? 0),
    legalProceedingCount: Number(row?.legal_proceeding_count ?? 0),
  };
}

// ── Monthly debt snapshots (Hero chart) ─────────────────────────────────────
// Timezone-anchored to Asia/Jerusalem (matches the calendar's date handling) so
// the month bucket flips at local midnight, not UTC.

/**
 * Record (or refresh) the snapshot for the CURRENT month: the summed open debt
 * over non-archived debtors right now. Keyed by (year, month) — calling it again
 * the same month overwrites with the latest figure. Best-effort: callers should
 * not let a snapshot failure fail the import that triggered it.
 */
export async function upsertMonthlyDebtSnapshot(): Promise<void> {
  await query(
    `insert into public.monthly_debt_snapshots
       (snapshot_year, snapshot_month, snapshot_date,
        total_debt, management_debt, water_debt, special_debt, debtor_count)
     select
       extract(year  from (now() at time zone 'Asia/Jerusalem'))::int,
       extract(month from (now() at time zone 'Asia/Jerusalem'))::int,
       (now() at time zone 'Asia/Jerusalem')::date,
       coalesce(sum(total_debt)      filter (where is_archived = false), 0),
       coalesce(sum(management_fees) filter (where is_archived = false), 0),
       coalesce(sum(hot_water_debt)  filter (where is_archived = false), 0),
       coalesce(sum(special_debt)    filter (where is_archived = false), 0),
       count(*) filter (where is_archived = false)
     from public.debtors
     on conflict (snapshot_year, snapshot_month) do update set
       snapshot_date   = excluded.snapshot_date,
       total_debt      = excluded.total_debt,
       management_debt = excluded.management_debt,
       water_debt      = excluded.water_debt,
       special_debt    = excluded.special_debt,
       debtor_count    = excluded.debtor_count,
       updated_at      = now()`,
  );
}

/**
 * Collection-vs-debt series for the last `months` calendar months plus the
 * derived Hero KPIs. "Collection" is approximated as the month-over-month drop
 * in total open debt (no per-payment data exists). We fetch one extra (older)
 * month so the first charted month has a baseline to derive its collection from.
 */
export async function getCollectionVsDebt(months = 6): Promise<CollectionVsDebt> {
  // Newest-first, then reversed to chronological. months+1 → baseline row.
  const res = await query<{
    snapshot_year: number;
    snapshot_month: number;
    total_debt: string;
  }>(
    `select snapshot_year, snapshot_month, total_debt::text
       from public.monthly_debt_snapshots
      order by snapshot_year desc, snapshot_month desc
      limit $1`,
    [months + 1],
  );

  const rowsAsc = res.rows
    .map((r) => ({
      year: r.snapshot_year,
      month: r.snapshot_month,
      totalDebt: Number(r.total_debt),
    }))
    .reverse();

  const points: MonthlyDebtPoint[] = rowsAsc.map((cur, i) => {
    const prev = i > 0 ? rowsAsc[i - 1] : null;
    const collection = prev ? Math.max(0, prev.totalDebt - cur.totalDebt) : 0;
    const collectionRate = prev && prev.totalDebt > 0 ? collection / prev.totalDebt : 0;
    return {
      year: cur.year,
      month: cur.month,
      ym: `${cur.year}-${String(cur.month).padStart(2, '0')}`,
      totalDebt: cur.totalDebt,
      collection,
      collectionRate,
      isBaseline: prev === null,
    };
  });

  // Drop the baseline-only month → return at most `months` charted points.
  const series = points.slice(-months);

  const openDebtBalance = await getOpenDebtBalance();
  const latest = series[series.length - 1];
  const prevMonth = series.length >= 2 ? series[series.length - 2] : null;
  // Average only over months with a derivable rate — the baseline month (shown
  // as "—" in the UI) has no opening balance, so folding its 0 into the mean
  // would dilute it. In the normal regime the baseline is already off the window
  // (no isBaseline survives), so this is a no-op there.
  const rated = series.filter((p) => !p.isBaseline);
  const avgCollectionRate =
    rated.length > 0 ? rated.reduce((s, p) => s + p.collectionRate, 0) / rated.length : 0;

  return {
    series,
    kpis: {
      collectedThisMonth: latest?.collection ?? 0,
      openDebtBalance,
      avgCollectionRate,
      avgCollectionRateDelta: latest && prevMonth ? latest.collectionRate - prevMonth.collectionRate : 0,
    },
  };
}

/** Live current open balance = sum(total_debt) over non-archived debtors. */
export async function getOpenDebtBalance(): Promise<number> {
  const row = await queryOne<{ total: string }>(
    `select coalesce(sum(total_debt) filter (where is_archived = false), 0)::text as total
       from public.debtors`,
  );
  return Number(row?.total ?? 0);
}

export async function getTabCounts(): Promise<TabCounts> {
  const row = await queryOne<{
    active: string;
    warning: string;
    legal_care: string;
    legal_proceeding: string;
    actions: string;
    archived: string;
  }>(
    `select
       count(*) filter (
         where d.is_archived = false
           and (d.legal_status_id is null or s.name not in ($1, $2, $3))
       )::text as active,
       count(*) filter (where d.is_archived = false and s.name = $1)::text as warning,
       count(*) filter (where d.is_archived = false and s.name = $2)::text as legal_care,
       count(*) filter (where d.is_archived = false and s.name = $3)::text as legal_proceeding,
       count(*) filter (where d.is_archived = false and d.next_action_date is not null)::text as actions,
       count(*) filter (where d.is_archived = true)::text as archived
     from ${DEBTORS_JOIN}`,
    [STATUS_WARNING, STATUS_LEGAL_CARE, STATUS_LEGAL_PROCEEDING],
  );
  return {
    active: Number(row?.active ?? 0),
    warningLetter: Number(row?.warning ?? 0),
    legalCare: Number(row?.legal_care ?? 0),
    legalProceeding: Number(row?.legal_proceeding ?? 0),
    actions: Number(row?.actions ?? 0),
    archived: Number(row?.archived ?? 0),
  };
}

export async function getLastImportedAt(): Promise<Date | null> {
  const row = await queryOne<{ last_at: Date | null }>(
    `select max(last_imported_at) as last_at from public.debtors`,
  );
  return row?.last_at ?? null;
}

export type SortKey =
  | 'apt_asc' | 'apt_desc'
  | 'owner_asc' | 'owner_desc'
  | 'total_debt_asc' | 'total_debt_desc'
  | 'management_fees_asc' | 'management_fees_desc'
  | 'hot_water_debt_asc' | 'hot_water_debt_desc'
  | 'legal_status_asc' | 'legal_status_desc';

export const ALL_SORT_KEYS: readonly SortKey[] = [
  'apt_asc', 'apt_desc',
  'owner_asc', 'owner_desc',
  'total_debt_asc', 'total_debt_desc',
  'management_fees_asc', 'management_fees_desc',
  'hot_water_debt_asc', 'hot_water_debt_desc',
  'legal_status_asc', 'legal_status_desc',
] as const;

function sortToSql(k: SortKey): string {
  switch (k) {
    case 'apt_asc':                return 'd.apartment_number asc';
    case 'apt_desc':               return 'd.apartment_number desc';
    case 'owner_asc':              return 'd.owner_name asc nulls last';
    case 'owner_desc':             return 'd.owner_name desc nulls last';
    case 'total_debt_asc':         return 'd.total_debt asc';
    case 'total_debt_desc':        return 'd.total_debt desc';
    case 'management_fees_asc':    return 'd.management_fees asc';
    case 'management_fees_desc':   return 'd.management_fees desc';
    case 'hot_water_debt_asc':     return 'd.hot_water_debt asc';
    case 'hot_water_debt_desc':    return 'd.hot_water_debt desc';
    case 'legal_status_asc':       return 's.sort_order asc nulls first, s.name asc';
    case 'legal_status_desc':      return 's.sort_order desc nulls last, s.name desc';
  }
}

export interface ListDebtorsParams {
  tab: TabKey;
  q?: string;
  apt?: string;
  sort?: SortKey;
  page?: number;
  pageSize?: number;
}

export interface ListDebtorsResult {
  rows: Debtor[];
  total: number;
  page: number;
  totalPages: number;
}

interface TabFilter {
  sql: string;
  params: string[];
}

function tabFilter(tab: TabKey): TabFilter {
  switch (tab) {
    case 'archived':
      return { sql: 'd.is_archived = true', params: [] };
    case 'warning':
      return { sql: 'd.is_archived = false and s.name = $P1', params: [STATUS_WARNING] };
    case 'legal-care':
      return { sql: 'd.is_archived = false and s.name = $P1', params: [STATUS_LEGAL_CARE] };
    case 'legal-proceeding':
      return { sql: 'd.is_archived = false and s.name = $P1', params: [STATUS_LEGAL_PROCEEDING] };
    case 'actions':
      return { sql: 'd.is_archived = false and d.next_action_date is not null', params: [] };
    case 'active':
    default:
      // "Active" = not in escalated tabs and not archived. Includes default, null, and
      // internal tracking statuses (במעקב נעמה / בניהול פתאל / לטיפול רונן).
      return {
        sql: 'd.is_archived = false and (d.legal_status_id is null or s.name not in ($P1, $P2, $P3))',
        params: [STATUS_WARNING, STATUS_LEGAL_CARE, STATUS_LEGAL_PROCEEDING],
      };
  }
}

const SELECT_COLUMNS = `
  d.id, d.apartment_number, d.owner_name, d.tenant_name, d.address,
  d.phone_owner, d.phone_tenant, d.email_owner, d.email_tenant,
  d.total_debt::float8 as total_debt,
  d.management_fees::float8 as management_fees,
  d.monthly_debt,
  d.hot_water_debt::float8 as hot_water_debt,
  d.special_debt::float8 as special_debt,
  d.details,
  d.legal_status_id,
  s.name       as legal_status_name,
  s.color      as legal_status_color,
  s.is_default as legal_status_is_default,
  d.next_action_description,
  d.next_action_date,
  d.is_archived,
  d.archived_at,
  d.last_imported_at,
  (
    coalesce((select count(*) from public.comments c       where c.debtor_id = d.id), 0)
    + coalesce((select count(*) from public.debtor_events e where e.debtor_id = d.id), 0)
  )::int as doc_count,
  greatest(
    (select max(c.created_at) from public.comments c       where c.debtor_id = d.id),
    (select max(e.created_at) from public.debtor_events e   where e.debtor_id = d.id)
  ) as last_doc_at
`;

export async function listDebtors(params: ListDebtorsParams): Promise<ListDebtorsResult> {
  const page = Math.max(1, params.page ?? 1);
  const pageSize = Math.max(1, Math.min(200, params.pageSize ?? 50));
  const offset = (page - 1) * pageSize;

  const args: unknown[] = [];
  const where: string[] = [];

  const tab = tabFilter(params.tab);
  let tabSql = tab.sql;
  // Inline the tab params first so their indices are known.
  for (let i = 0; i < tab.params.length; i++) {
    args.push(tab.params[i]);
    tabSql = tabSql.replace(`$P${i + 1}`, `$${args.length}`);
  }
  where.push(tabSql);

  if (params.q) {
    args.push(`%${params.q}%`);
    where.push(`d.owner_name ilike $${args.length}`);
  }
  if (params.apt) {
    args.push(`%${params.apt}%`);
    where.push(`d.apartment_number ilike $${args.length}`);
  }

  // Actions tab is always sorted by next-action date ascending (closest first),
  // overriding any URL sort param.
  const orderBy = params.tab === 'actions'
    ? 'd.next_action_date asc nulls last'
    : sortToSql(params.sort ?? 'total_debt_desc');

  const whereSql = where.join(' and ');

  const filterArgs = [...args];
  args.push(pageSize, offset);

  const rowsRes = await query<Debtor>(
    `select ${SELECT_COLUMNS}
       from ${DEBTORS_JOIN}
       where ${whereSql}
       order by ${orderBy}
       limit $${args.length - 1} offset $${args.length}`,
    args,
  );

  const totalRes = await queryOne<{ c: string }>(
    `select count(*)::text as c from ${DEBTORS_JOIN} where ${whereSql}`,
    filterArgs,
  );
  const total = Number(totalRes?.c ?? 0);
  return {
    rows: rowsRes.rows,
    total,
    page,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

/**
 * Same tab/search/sort filter as listDebtors but WITHOUT pagination — returns
 * every matching row. Backs the toolbar export/print (Excel / PDF / print),
 * whose scope is the full current filtered set, not just the visible page.
 * Capped defensively at 100k rows (the building has ~300).
 */
export async function listAllDebtorsForExport(
  params: { tab: TabKey; q?: string; apt?: string; sort?: SortKey },
): Promise<Debtor[]> {
  const args: unknown[] = [];
  const where: string[] = [];

  const tab = tabFilter(params.tab);
  let tabSql = tab.sql;
  for (let i = 0; i < tab.params.length; i++) {
    args.push(tab.params[i]);
    tabSql = tabSql.replace(`$P${i + 1}`, `$${args.length}`);
  }
  where.push(tabSql);

  if (params.q) {
    args.push(`%${params.q}%`);
    where.push(`d.owner_name ilike $${args.length}`);
  }
  if (params.apt) {
    args.push(`%${params.apt}%`);
    where.push(`d.apartment_number ilike $${args.length}`);
  }

  const orderBy = params.tab === 'actions'
    ? 'd.next_action_date asc nulls last'
    : sortToSql(params.sort ?? 'total_debt_desc');

  const res = await query<Debtor>(
    `select ${SELECT_COLUMNS}
       from ${DEBTORS_JOIN}
       where ${where.join(' and ')}
       order by ${orderBy}
       limit 100000`,
    args,
  );
  return res.rows;
}

export async function getAllApartmentNumbers(): Promise<Set<string>> {
  const r = await query<{ apartment_number: string }>(
    `select apartment_number from public.debtors`,
  );
  return new Set(r.rows.map((x) => x.apartment_number));
}

// ─────────────────────── Slice 3: panel ───────────────────────

export async function getDebtorById(id: string): Promise<Tenant | null> {
  const row = await queryOne<Tenant>(
    `select
       d.id, d.apartment_number, d.owner_name, d.tenant_name,
       d.phone_owner, d.phone_tenant,
       d.email_owner, d.email_tenant,
       coalesce(d.phones_manual_override, false) as phones_manual_override,
       d.total_debt::float8       as total_debt,
       d.management_fees::float8  as management_fees,
       d.hot_water_debt::float8   as hot_water_debt,
       d.special_debt::float8     as special_debt,
       d.monthly_debt,
       d.details,
       d.last_imported_at,
       d.legal_status_id,
       s.name       as legal_status_name,
       s.color      as legal_status_color,
       s.is_default as legal_status_is_default,
       d.legal_status_updated_at,
       d.legal_status_updated_by_name,
       d.notes,
       d.next_action_description,
       d.next_action_date,
       d.last_contact_date,
       d.is_archived
     from ${DEBTORS_JOIN}
     where d.id = $1`,
    [id],
  );
  return row;
}

// Fields allowed via PATCH /api/debtors/:id. Keep in sync with
// src/types/tenant.ts (TenantFieldsUpdate).
const UPDATABLE_FIELDS = new Set([
  'phone_owner',
  'phone_tenant',
  'notes',
  'next_action_date',
  'next_action_description',
  'last_contact_date',
  'phones_manual_override',
]);

export async function updateDebtorFields(
  id: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const sets: string[] = [];
  const args: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (!UPDATABLE_FIELDS.has(k)) continue;
    if (v === undefined) continue;
    args.push(v);
    sets.push(`${k} = $${args.length}`);
  }
  if (sets.length === 0) return;
  args.push(id);
  await query(
    `update public.debtors set ${sets.join(', ')} where id = $${args.length}`,
    args,
  );
}

export interface LegalStatusChangeResult {
  old: { id: string | null; name: string | null; color: string | null; is_default: boolean | null };
  new: { id: string | null; name: string | null; color: string | null; notification_emails: string[] | null };
}

export async function updateDebtorLegalStatus(
  debtorId: string,
  newStatusId: string | null,
  user: { id: string; name: string },
  source: 'MANUAL' | 'IMPORT' | 'AUTO_DEFAULT' | 'SYSTEM_FIX' = 'MANUAL',
): Promise<LegalStatusChangeResult> {
  return withTransaction(async (client) => {
    const before = await client.query<{
      apartment_number: string;
      old_id: string | null;
      old_name: string | null;
      old_color: string | null;
      old_is_default: boolean | null;
    }>(
      `select d.apartment_number,
              d.legal_status_id as old_id,
              s.name            as old_name,
              s.color           as old_color,
              s.is_default      as old_is_default
         from ${DEBTORS_JOIN}
         where d.id = $1
         for update of d`,
      [debtorId],
    );
    const row = before.rows[0];
    if (!row) throw new Error('debtor_not_found');

    let nextName: string | null = null;
    let nextColor: string | null = null;
    let nextEmails: string[] | null = null;
    if (newStatusId !== null) {
      const sRes = await client.query<{
        name: string; color: string; notification_emails: string[] | null;
      }>(
        `select name, color, notification_emails
           from public.statuses
           where id = $1 and is_active = true`,
        [newStatusId],
      );
      if (sRes.rowCount === 0) throw new Error('status_not_found');
      nextName = sRes.rows[0].name;
      nextColor = sRes.rows[0].color;
      nextEmails = sRes.rows[0].notification_emails;
    }

    await client.query(
      `update public.debtors
          set legal_status_id               = $1,
              legal_status_source           = $2,
              legal_status_updated_at       = now(),
              legal_status_updated_by       = $3,
              legal_status_updated_by_name  = $4
        where id = $5`,
      [newStatusId, source, user.id, user.name, debtorId],
    );

    await client.query(
      `insert into public.legal_status_history
         (debtor_id, apartment_number,
          old_status_id, old_status_name,
          new_status_id, new_status_name,
          changed_by, changed_by_name, source)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        debtorId,
        row.apartment_number,
        row.old_id,
        row.old_name,
        newStatusId,
        nextName,
        user.id,
        user.name,
        source,
      ],
    );

    return {
      old: {
        id: row.old_id,
        name: row.old_name,
        color: row.old_color,
        is_default: row.old_is_default,
      },
      new: {
        id: newStatusId,
        name: nextName,
        color: nextColor,
        notification_emails: nextEmails,
      },
    };
  });
}

// Archive / restore now live in the archive route (transactional, with event
// logging via logDebtorEvent). See src/app/api/debtors/[id]/archive/route.ts.

export async function getDebtorApartmentNumber(id: string): Promise<string | null> {
  const r = await queryOne<{ apartment_number: string }>(
    `select apartment_number from public.debtors where id = $1`,
    [id],
  );
  return r?.apartment_number ?? null;
}

// ─────────────────────── WhatsApp send ───────────────────────
// The subset of fields the WhatsApp send route needs: phone resolution and
// placeholder interpolation ({{name}}/{{debt}}/{{monthly}}/{{special}}).
// {{monthly}} = management_fees (numeric); monthly_debt is a text month-range.
export interface DebtorContact {
  id: string;
  apartment_number: string;
  owner_name: string | null;
  tenant_name: string | null;
  phone_owner: string | null;
  phone_tenant: string | null;
  total_debt: number;
  management_fees: number;
  special_debt: number;
}

export async function getDebtorContact(id: string): Promise<DebtorContact | null> {
  return queryOne<DebtorContact>(
    `select id, apartment_number, owner_name, tenant_name,
            phone_owner, phone_tenant,
            total_debt::float8      as total_debt,
            management_fees::float8 as management_fees,
            special_debt::float8    as special_debt
       from public.debtors
      where id = $1`,
    [id],
  );
}

/** Find the debtor whose phone field matches `localPhone` by the NORMALIZED key
 *  (last 9 digits, non-digits stripped on both sides). Used by the inbox composer
 *  to link an outbound message to a debtor; the normalized match unifies local /
 *  international / formatted stored forms. Prefers a live (non-archived) match. */
export async function getDebtorContactByPhone(localPhone: string): Promise<DebtorContact | null> {
  const key = phoneDigitsKey(localPhone);
  if (!key) return null;
  return queryOne<DebtorContact>(
    `select id, apartment_number, owner_name, tenant_name,
            phone_owner, phone_tenant,
            total_debt::float8      as total_debt,
            management_fees::float8 as management_fees,
            special_debt::float8    as special_debt
       from public.debtors
      where right(regexp_replace(coalesce(phone_owner,''),  '[^0-9]', '', 'g'), 9) = $1
         or right(regexp_replace(coalesce(phone_tenant,''), '[^0-9]', '', 'g'), 9) = $1
      order by is_archived asc, created_at asc
      limit 1`,
    [key],
  );
}

// Lightweight debtor lookup for the "link inbound message to debtor" dialog:
// matches by apartment number, owner OR tenant name, across all debtors.
export interface DebtorSearchResult {
  id: string;
  apartment_number: string;
  owner_name: string | null;
  tenant_name: string | null;
  phone_owner: string | null;
  phone_tenant: string | null;
  is_archived: boolean;
  // Added (additive) so callers get the status + debt breakdown per row without a
  // second query. `legal_status_name` is null when the debtor has no status set.
  legal_status_name: string | null;
  total_debt: number;
  management_fees: number;
  hot_water_debt: number;
  monthly_debt: string | null;
}

/**
 * Cross-status debtor lookup by free-text term and/or status name.
 *
 * The term is matched (OR) against apartment number, owner name AND tenant name.
 * There is NO tab/status bucket — every matching row is returned regardless of
 * legal status, INCLUDING archived rows (ordered last), so a person's apartments
 * that sit in different statuses all come back, each with its own status.
 *
 * `opts.status` (optional) narrows to a status by name (ILIKE) — applied only
 * when provided. At least one of `q` / `status` must be non-empty, else [].
 *
 * Backward compatible: `searchDebtors(q)` behaves as before (now also returning
 * legal_status_name / total_debt / monthly_debt — additive fields).
 */
export async function searchDebtors(
  q: string,
  opts: { limit?: number; status?: string } = {},
): Promise<DebtorSearchResult[]> {
  const term = q.trim();
  const status = (opts.status ?? '').trim();
  if (!term && !status) return [];
  const limit = Math.max(1, Math.min(50, opts.limit ?? 20));

  const args: unknown[] = [];
  const where: string[] = [];
  if (term) {
    args.push(`%${term}%`);
    const p = `$${args.length}`;
    where.push(`(d.apartment_number ilike ${p} or d.owner_name ilike ${p} or d.tenant_name ilike ${p})`);
  }
  if (status) {
    args.push(`%${status}%`);
    where.push(`s.name ilike $${args.length}`);
  }
  args.push(limit);

  const r = await query<DebtorSearchResult>(
    `select d.id, d.apartment_number, d.owner_name, d.tenant_name,
            d.phone_owner, d.phone_tenant, d.is_archived,
            s.name as legal_status_name,
            d.total_debt::float8      as total_debt,
            d.management_fees::float8 as management_fees,
            d.hot_water_debt::float8  as hot_water_debt,
            d.monthly_debt
       from ${DEBTORS_JOIN}
      where ${where.join(' and ')}
      order by d.is_archived asc, d.apartment_number asc
      limit $${args.length}`,
    args,
  );
  return r.rows;
}
