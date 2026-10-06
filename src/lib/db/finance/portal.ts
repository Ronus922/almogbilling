import 'server-only';
import { query, queryOne } from '@/lib/db';
import type { FinKind, FinSection } from '@/lib/constants/finance';
import type {
  PeriodReport, PeriodReportCategory, PeriodReportMonth, RenovationFundKpis, ResidentBankBalance, ResidentCategoryMonth,
  ResidentDocument, ResidentEntry, ResidentFundKpis, ResidentMonthData, ResidentMonthSection, ResidentOverview,
  ResidentPeriodData, ResidentPeriodMonth,
} from '@/lib/types/finance';
import { PORTAL_CATEGORY_TREND_MONTHS } from '@/lib/constants/portal';
import { currentMonthKey, monthKeyOf, periodMonthOf, shiftMonthKey } from '@/lib/finance/period';
import { publishedMonthKeys } from '@/lib/finance/resident';
import { roundShekels } from '@/lib/portal/ui';
import { buildProxyUrl, FINANCE_RECEIPTS_BUCKET } from '@/lib/storage/server';
import { PUBLISHED_JOIN, listFundEntries } from './entries';
import { getRenovationFundSettings } from './fund-settings';
import { getMonthStatus, listPublishedMonthBalances, listPublishedMonths } from './month-status';
import { getFinanceSettings } from './settings';

// The read layer the owners portal will stand on (no route, no UI yet), also
// used by the admin overview with publishedOnly = false.
//
// THE RULE: "published" is enforced inside each query (the PUBLISHED_JOIN +
// `coalesce(s.published, false)` predicate), never by the caller filtering
// afterwards — so a portal route that forgets a check still cannot leak a
// hidden month. Residents get only category / description / amount (+ date):
// supplier names and internal notes never leave this module.

/** Published (year, month) pairs, newest first. */
export async function getPublishedMonths(): Promise<Array<{ year: number; month: number }>> {
  return listPublishedMonths();
}

// The entry id rides along INTERNALLY (to attach receipts) and is dropped by
// toResidentEntries before anything leaves this module — a resident row never
// carries an entry id, so nothing on the portal can address a line. The
// category id does leave (06/10/2026): it is what a category row of the
// transactions tab asks its trend by, and the reports tab already hands it out.
const RESIDENT_COLS = `
  e.id as entry_id, e.kind, c.section, e.category_id, c.name as category_name, e.description, e.amount::float8 as amount,
  e.payment_date::text as payment_date, e.period_month::text as period_month`;

type ResidentRow = ResidentEntry & { entry_id: string };

function sectionOf(rows: ResidentEntry[], section: FinSection) {
  const income = rows.filter((r) => r.section === section && r.kind === 'income');
  const expense = rows.filter((r) => r.section === section && r.kind === 'expense');
  const sumOf = (list: ResidentEntry[]) => list.reduce((s, r) => s + r.amount, 0);
  const i = sumOf(income);
  const x = sumOf(expense);
  return { income, expense, totals: { income: i, expense: x, diff: i - x } };
}

/** The receipts of these entries, keyed by entry id — ONLY when the
 *  "הצג מסמכים לדיירים" switch is on; an empty map otherwise, so the object
 *  keys never reach a resident while the switch is off. */
async function residentDocumentsFor(entryIds: string[]): Promise<Map<string, ResidentDocument[]>> {
  const out = new Map<string, ResidentDocument[]>();
  if (entryIds.length === 0) return out;
  const settings = await getFinanceSettings();
  if (!settings.show_documents_to_residents) return out;
  const r = await query<{ entry_id: string; object_key: string; original_name: string }>(
    `select entry_id, object_key, original_name from public.fin_documents
      where entry_id = any($1::uuid[]) and object_deleted_at is null
      order by created_at`,
    [entryIds],
  );
  for (const d of r.rows) {
    const doc = { url: buildProxyUrl(FINANCE_RECEIPTS_BUCKET, d.object_key), name: d.original_name };
    const list = out.get(d.entry_id);
    if (list) list.push(doc);
    else out.set(d.entry_id, [doc]);
  }
  return out;
}

/** Strips the internal entry id and attaches the receipts (when allowed). */
async function toResidentEntries(rows: ResidentRow[]): Promise<ResidentEntry[]> {
  const docs = await residentDocumentsFor(rows.map((r) => r.entry_id));
  return rows.map(({ entry_id, ...rest }) => {
    const list = docs.get(entry_id);
    return list ? { ...rest, documents: list } : rest;
  });
}

/** Month-end bank balances of published months ('YYYY-MM' → value), ONLY
 *  while the "הצג יתרת בנק לדיירים" switch is on — an empty map otherwise,
 *  so no balance can reach a resident with the switch off. Newest first. */
async function residentBankBalances(): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const settings = await getFinanceSettings();
  if (!settings.show_bank_balance_to_residents) return out;
  for (const r of await listPublishedMonthBalances()) {
    out.set(`${String(r.year).padStart(4, '0')}-${String(r.month).padStart(2, '0')}`, r.bank_balance);
  }
  return out;
}

/** The overview's bank-balance card: the newest published month with a value,
 *  plus the published month right before it when that one has a value. */
async function residentBankBalanceCard(publishedKeys: readonly string[]): Promise<ResidentBankBalance | undefined> {
  const balances = await residentBankBalances();
  if (balances.size === 0) return undefined;
  const sorted = [...publishedKeys].sort().reverse();
  const idx = sorted.findIndex((k) => balances.has(k));
  if (idx < 0) return undefined;
  const month = sorted[idx];
  const prevMonth = sorted[idx + 1];
  const prev = prevMonth !== undefined && balances.has(prevMonth) ? { month: prevMonth, value: balances.get(prevMonth)! } : null;
  return { month, value: balances.get(month)!, previous: prev };
}

/** The resident-visible lines of one month, or null when the month is not
 *  published. The entries query joins on the published row itself, so an
 *  unpublished month yields no rows even before the status check. */
export async function getResidentMonthData(year: number, month: number): Promise<ResidentMonthData | null> {
  const status = await getMonthStatus(year, month);
  if (!status.published) return null;
  const r = await query<ResidentRow>(
    `select ${RESIDENT_COLS}
       from public.fin_entries e
       join public.fin_categories c on c.id = e.category_id
       join public.finance_month_status s
         on s.year = extract(year from e.period_month)::int
        and s.month = extract(month from e.period_month)::int
      where s.published and e.deleted_at is null
        and e.period_month = make_date($1::int, $2::int, 1)
      order by e.kind, c.section, c.sort_order, c.name, coalesce(e.payment_date, e.period_month), e.created_at`,
    [year, month],
  );
  const rows = await toResidentEntries(r.rows);
  const balances = await residentBankBalances();
  const key = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`;
  const bank = balances.get(key);
  return {
    year,
    month,
    operating: sectionOf(rows, 'operating'),
    fund: sectionOf(rows, 'renovation_fund'),
    ...(bank !== undefined ? { bank_balance: bank } : {}),
  };
}

/** The operating lines and totals of a whole period — the transactions tab's
 *  four levels (a month, a quarter, a half, a year), published months only.
 *
 *  Same rule as everywhere in this module: the entries query joins on the
 *  published row and filters on it, so a month residents do not get yields no
 *  rows — it cannot reach a total, a category, a line or a chart column even
 *  if a caller forgot to check. `months` still LISTS every calendar month of
 *  the period up to the current one (a future month is not part of it), each
 *  flagged `included`, which is what the screen's "N of M months" line and the
 *  chart read. The closing balance is the newest included month that has one,
 *  and only while the bank-balance switch is on. */
export async function getResidentPeriodData(from: string, to: string): Promise<ResidentPeriodData> {
  const cutoff = currentMonthKey();
  const last = to < cutoff ? to : cutoff;
  const keys: string[] = [];
  for (let m = from; m <= last; m = shiftMonthKey(m, 1)) keys.push(m);

  const empty: ResidentMonthSection = { income: [], expense: [], totals: { income: 0, expense: 0, diff: 0 } };
  if (keys.length === 0) return { from, to, months: [], operating: empty };

  const [statuses, r] = await Promise.all([
    query<{ year: number; month: number; published: boolean }>(
      `select year, month, published from public.finance_month_status
        where make_date(year, month, 1) between $1::date and $2::date`,
      [periodMonthOf(from), periodMonthOf(last)],
    ),
    query<ResidentRow>(
      `select ${RESIDENT_COLS}
         from public.fin_entries e
         join public.fin_categories c on c.id = e.category_id
         join public.finance_month_status s
           on s.year = extract(year from e.period_month)::int
          and s.month = extract(month from e.period_month)::int
        where s.published and e.deleted_at is null and c.section = 'operating'
          and e.period_month between $1::date and $2::date
        order by e.kind, c.sort_order, c.name, coalesce(e.payment_date, e.period_month), e.created_at`,
      [periodMonthOf(from), periodMonthOf(last)],
    ),
  ]);

  const published = new Set(
    statuses.rows.filter((x) => x.published).map((x) => `${String(x.year).padStart(4, '0')}-${String(x.month).padStart(2, '0')}`),
  );
  const rows = await toResidentEntries(r.rows);
  const operating = sectionOf(rows, 'operating');

  const months: ResidentPeriodMonth[] = keys.map((month) => {
    const of = (list: ResidentEntry[]) => list.filter((e) => monthKeyOf(e.period_month) === month).reduce((sum, e) => sum + e.amount, 0);
    return { month, included: published.has(month), income: of(operating.income), expense: of(operating.expense) };
  });

  const balances = await residentBankBalances();
  const closing = [...keys].reverse().find((k) => published.has(k) && balances.has(k));

  return {
    from,
    to,
    months,
    operating,
    ...(closing !== undefined ? { bank_balance: balances.get(closing)!, bank_balance_month: closing } : {}),
  };
}

/** The transactions tab's category trend (06/10/2026): one OPERATING
 *  category's sum in each of the newest PORTAL_CATEGORY_TREND_MONTHS published
 *  months up to the current one, oldest first — whatever period the tab's
 *  picker is on. A published month without a line of the category is 0; the
 *  sum is exact (numeric) and rounded to whole shekels once, here, like every
 *  amount a resident sees. null when there is no such operating category —
 *  a fund category is not on that tab, so it is "not found" too.
 *
 *  Same rule as the rest of this module, and the one this feature exists
 *  under: the window is made of published rows IN THE SQL, and lines are
 *  joined to the window only — a month residents do not get is not in the
 *  answer at all, not even as a 0, whatever the caller does. */
export async function getResidentCategoryTrend(categoryId: string): Promise<ResidentCategoryMonth[] | null> {
  const category = await queryOne<{ id: string }>(
    `select id from public.fin_categories where id = $1 and section = 'operating'`,
    [categoryId],
  );
  if (!category) return null;
  const r = await query<{ month: string; total: number }>(
    `with win as (
       select make_date(s.year, s.month, 1) as month_start
         from public.finance_month_status s
        where s.published and make_date(s.year, s.month, 1) <= $2::date
        order by s.year desc, s.month desc
        limit $3
     )
     select to_char(w.month_start, 'YYYY-MM') as month, coalesce(sum(e.amount), 0)::float8 as total
       from win w
       left join public.fin_entries e
         on e.period_month = w.month_start and e.category_id = $1 and e.deleted_at is null
      group by w.month_start
      order by w.month_start`,
    [categoryId, periodMonthOf(currentMonthKey()), PORTAL_CATEGORY_TREND_MONTHS],
  );
  return r.rows.map((m) => ({ month: m.month, total: roundShekels(m.total) }));
}

/** The newest operating lines a resident may see, newest first — the
 *  overview's "תנועות אחרונות". Published months only, in the query itself. */
export async function listRecentResidentEntries(limit: number): Promise<ResidentEntry[]> {
  const r = await query<ResidentRow>(
    `select ${RESIDENT_COLS}
       from public.fin_entries e
       join public.fin_categories c on c.id = e.category_id
       join public.finance_month_status s
         on s.year = extract(year from e.period_month)::int
        and s.month = extract(month from e.period_month)::int
      where s.published and e.deleted_at is null and c.section = 'operating'
      order by coalesce(e.payment_date, e.period_month) desc, e.created_at desc
      limit $1`,
    [Math.max(1, Math.min(50, Math.floor(limit)))],
  );
  return toResidentEntries(r.rows);
}

/** Whether this receipt may be shown to a resident right now: the switch is
 *  on, the object belongs to a live entry, and that entry's month is
 *  published. The /api/files proxy asks this before serving a portal session.
 *  Returns the owning entry + name for the audit row, or null. */
export async function findResidentReceipt(objectKey: string): Promise<{ entry_id: string; document_id: string; original_name: string } | null> {
  const settings = await getFinanceSettings();
  if (!settings.show_documents_to_residents) return null;
  return queryOne<{ entry_id: string; document_id: string; original_name: string }>(
    `select d.entry_id, d.id as document_id, d.original_name
       from public.fin_documents d
       join public.fin_entries e on e.id = d.entry_id
       ${PUBLISHED_JOIN}
      where d.object_key = $1 and d.object_deleted_at is null
        and e.deleted_at is null and coalesce(s.published, false)
      limit 1`,
    [objectKey],
  );
}

/** The overview tab's data set: the last `monthsBack` calendar months up to
 *  the newest published month (only the published ones among them), the
 *  operating expense categories over that window and the newest lines.
 *  null when nothing is published. Every figure comes from published months —
 *  getPeriodReport with publishedOnly and the published join of the lines. */
export async function getResidentOverview(monthsBack: number): Promise<ResidentOverview | null> {
  const keys = publishedMonthKeys(await listPublishedMonths());
  if (keys.length === 0) return null;
  const latest = keys[0];
  const span = Math.max(1, Math.min(24, Math.floor(monthsBack)));
  const from = shiftMonthKey(latest, -(span - 1));
  const [report, recent, bank] = await Promise.all([
    getPeriodReport(from, latest, { publishedOnly: true }),
    listRecentResidentEntries(5),
    residentBankBalanceCard(keys),
  ]);
  const months = report.months
    .filter((m) => m.included)
    .map((m) => ({
      month: m.month,
      income: report.income.reduce((s, c) => s + (c.by_month[m.month] ?? 0), 0),
      expense: report.expense.reduce((s, c) => s + (c.by_month[m.month] ?? 0), 0),
    }));
  return {
    latest,
    months,
    expense_categories: report.expense.map((c) => ({ name: c.name, by_month: c.by_month })),
    recent,
    ...(bank ? { bank_balance: bank } : {}),
  };
}

/** Cumulative renovation-fund figures over ALL months (never per month):
 *  target, collected, spent, balance, the spend per purpose (every fund expense
 *  category, 0 included) and the full ledger. `publishedOnly` restricts every
 *  sum and the ledger to published months. */
export async function getRenovationFundKpis(opts: { publishedOnly: boolean }): Promise<RenovationFundKpis> {
  const [settings, sums, purposes, entries] = await Promise.all([
    getRenovationFundSettings(),
    query<{ kind: FinKind; total: number }>(
      `select e.kind, sum(e.amount)::float8 as total
         from public.fin_entries e
         join public.fin_categories c on c.id = e.category_id
         ${PUBLISHED_JOIN}
        where e.deleted_at is null and c.section = 'renovation_fund'
          and ($1::boolean = false or coalesce(s.published, false))
        group by e.kind`,
      [opts.publishedOnly],
    ),
    query<{ category_id: string; name: string; is_active: boolean; sort_order: number; total: number }>(
      `select c.id as category_id, c.name, c.is_active, c.sort_order,
              coalesce(sum(e.amount) filter (
                where e.deleted_at is null and ($1::boolean = false or coalesce(s.published, false))
              ), 0)::float8 as total
         from public.fin_categories c
         left join public.fin_entries e on e.category_id = c.id
         ${PUBLISHED_JOIN}
        where c.kind = 'expense' and c.section = 'renovation_fund'
        group by c.id, c.name, c.is_active, c.sort_order
        order by c.sort_order, c.name`,
      [opts.publishedOnly],
    ),
    listFundEntries({ publishedOnly: opts.publishedOnly }),
  ]);
  const collected = sums.rows.find((r) => r.kind === 'income')?.total ?? 0;
  const spent = sums.rows.find((r) => r.kind === 'expense')?.total ?? 0;
  const target = settings.target_amount;
  return {
    target_amount: target,
    collected,
    spent,
    balance: collected - spent,
    pct: target > 0 ? (collected / target) * 100 : 0,
    by_purpose: purposes.rows,
    entries,
  };
}

/** The fund as a resident gets it: getRenovationFundKpis over published months
 *  only, with the ledger stripped to the resident-safe row — no entry id,
 *  supplier, invoice number, internal note or files leave this function, so
 *  a page that serialises the result to the browser cannot leak them. */
export async function getResidentFundKpis(): Promise<ResidentFundKpis> {
  const { entries, ...rest } = await getRenovationFundKpis({ publishedOnly: true });
  return {
    ...rest,
    entries: entries.map((e) => ({
      kind: e.kind,
      category_name: e.category_name,
      description: e.description,
      amount: e.amount,
      payment_date: e.payment_date,
      period_month: e.period_month,
      published: e.published,
    })),
  };
}

/** Operating-budget sums per category and per month over `from`..`to`
 *  ('YYYY-MM', inclusive). Months after the current one are left out of the
 *  range (nothing can be entered for them from the picker). `publishedOnly`
 *  leaves unpublished months out of the sums — the report still lists them,
 *  flagged included = false, so a caller can say "N of M months". */
export async function getPeriodReport(
  from: string,
  to: string,
  opts: { publishedOnly: boolean },
): Promise<PeriodReport> {
  const cutoff = currentMonthKey();
  const last = to < cutoff ? to : cutoff;
  const keys: string[] = [];
  for (let m = from; m <= last; m = shiftMonthKey(m, 1)) keys.push(m);

  if (keys.length === 0) {
    return { from, to, months: [], income: [], expense: [], totals: { income: 0, expense: 0, surplus: 0 } };
  }

  const [statuses, rows] = await Promise.all([
    query<{ year: number; month: number; published: boolean }>(
      `select year, month, published from public.finance_month_status
        where make_date(year, month, 1) between $1::date and $2::date`,
      [periodMonthOf(from), periodMonthOf(last)],
    ),
    query<{ kind: FinKind; category_id: string; name: string; sort_order: number; is_hot_water: boolean; month: string; total: number }>(
      `select e.kind, e.category_id, c.name, c.sort_order, c.is_hot_water,
              to_char(e.period_month, 'YYYY-MM') as month, sum(e.amount)::float8 as total
         from public.fin_entries e
         join public.fin_categories c on c.id = e.category_id
         ${PUBLISHED_JOIN}
        where e.deleted_at is null and c.section = 'operating'
          and e.period_month between $1::date and $2::date
          and ($3::boolean = false or coalesce(s.published, false))
        group by e.kind, e.category_id, c.name, c.sort_order, c.is_hot_water, e.period_month`,
      [periodMonthOf(from), periodMonthOf(last), opts.publishedOnly],
    ),
  ]);

  const published = new Set(statuses.rows.filter((r) => r.published).map((r) => `${r.year}-${String(r.month).padStart(2, '0')}`));
  const months: PeriodReportMonth[] = keys.map((month) => ({
    month,
    published: published.has(month),
    included: !opts.publishedOnly || published.has(month),
  }));
  const divisor = Math.max(1, months.filter((m) => m.included).length);

  const byId = new Map<string, PeriodReportCategory>();
  for (const r of rows.rows) {
    let c = byId.get(r.category_id);
    if (!c) {
      c = { category_id: r.category_id, kind: r.kind, name: r.name, sort_order: r.sort_order, is_hot_water: r.is_hot_water, total: 0, average: 0, by_month: {} };
      byId.set(r.category_id, c);
    }
    c.total += r.total;
    c.by_month[r.month] = (c.by_month[r.month] ?? 0) + r.total;
  }
  const list = [...byId.values()]
    .map((c) => ({ ...c, average: c.total / divisor }))
    .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name, 'he'));
  const income = list.filter((c) => c.kind === 'income');
  const expense = list.filter((c) => c.kind === 'expense');
  const totalOf = (l: PeriodReportCategory[]) => l.reduce((s, c) => s + c.total, 0);
  const i = totalOf(income);
  const x = totalOf(expense);
  return { from, to, months, income, expense, totals: { income: i, expense: x, surplus: i - x } };
}
