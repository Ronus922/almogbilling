import 'server-only';
import { query } from '@/lib/db';
import type { FinKind, FinSection } from '@/lib/constants/finance';
import type {
  PeriodReport, PeriodReportCategory, PeriodReportMonth, RenovationFundKpis, ResidentEntry, ResidentMonthData,
} from '@/lib/types/finance';
import { currentMonthKey, periodMonthOf, shiftMonthKey } from '@/lib/finance/period';
import { PUBLISHED_JOIN, listFundEntries } from './entries';
import { getRenovationFundSettings } from './fund-settings';
import { getMonthStatus, listPublishedMonths } from './month-status';

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

const RESIDENT_COLS = `
  e.kind, c.section, c.name as category_name, e.description, e.amount::float8 as amount,
  e.payment_date::text as payment_date`;

function sectionOf(rows: ResidentEntry[], section: FinSection) {
  const income = rows.filter((r) => r.section === section && r.kind === 'income');
  const expense = rows.filter((r) => r.section === section && r.kind === 'expense');
  const sumOf = (list: ResidentEntry[]) => list.reduce((s, r) => s + r.amount, 0);
  const i = sumOf(income);
  const x = sumOf(expense);
  return { income, expense, totals: { income: i, expense: x, diff: i - x } };
}

/** The resident-visible lines of one month, or null when the month is not
 *  published. The entries query joins on the published row itself, so an
 *  unpublished month yields no rows even before the status check. */
export async function getResidentMonthData(year: number, month: number): Promise<ResidentMonthData | null> {
  const status = await getMonthStatus(year, month);
  if (!status.published) return null;
  const r = await query<ResidentEntry>(
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
  return {
    year,
    month,
    operating: sectionOf(r.rows, 'operating'),
    fund: sectionOf(r.rows, 'renovation_fund'),
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
