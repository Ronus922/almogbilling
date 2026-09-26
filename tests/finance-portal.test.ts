import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool, type PoolClient } from 'pg';

// The finance read layer (src/lib/db/finance/portal.ts) + the section rule:
//   • a line's category must belong to the section it is entered from — a
//     fund expense on an operating category (or the reverse) is refused;
//   • the operating month view never contains fund lines;
//   • the fund KPIs are cumulative over months;
//   • publishedOnly (what the owners portal will use) is enforced in the
//     queries: a hidden month contributes nothing and getResidentMonthData
//     returns null for it;
//   • the period report sums per category and per month and says which months
//     residents would get.
//
// Runs ONLY against a throwaway database (WA_TEST_DATABASE_URL), never prod —
// the same gate tests/wa-queue.test.ts uses. Everything it creates is removed
// by the exact ids it recorded (CLAUDE.md iron rule 12).
const TEST_URL = process.env.WA_TEST_DATABASE_URL;
const d = TEST_URL ? describe : describe.skip;

let pool: Pool;

// The modules under test reach the app pool through query/queryOne; hand them
// the test pool.
vi.mock('@/lib/db', () => ({
  getDbPool: () => pool,
  query: (text: string, params?: unknown[]) => pool.query(text, params),
  queryOne: async (text: string, params?: unknown[]) => (await pool.query(text, params)).rows[0] ?? null,
  withTransaction: async (fn: (c: PoolClient) => Promise<unknown>) => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const r = await fn(c);
      await c.query('COMMIT');
      return r;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  },
}));

const { createEntry, listEntriesForMonth, listFundEntries } = await import('@/lib/db/finance/entries');
const { getPeriodReport, getPublishedMonths, getRenovationFundKpis, getResidentMonthData } = await import('@/lib/db/finance/portal');
const { setMonthPublished } = await import('@/lib/db/finance/month-status');
const { getRenovationFundSettings, updateRenovationFundSettings } = await import('@/lib/db/finance/fund-settings');
const { resolveEntryInput } = await import('@/lib/finance/entry-input');
const { currentMonthKey, makePeriod, monthKeyParts, periodMonthOf, shiftMonthKey } = await import('@/lib/finance/period');

const made = { categories: [] as string[], entries: [] as string[], months: [] as Array<{ year: number; month: number }> };
let actorId = '';
let targetBefore = 0;
/** Fund sums before this suite adds its lines — the DB may hold other fund
 *  data (another suite, a UI smoke), so the assertions are on the delta. */
let base = { all: { collected: 0, spent: 0 }, published: { collected: 0, spent: 0 } };
const uniq = `fin-portal-${Date.now()}`;

const cur = currentMonthKey();
const prev = shiftMonthKey(cur, -1);
const prev2 = shiftMonthKey(cur, -2);

const cat: Record<string, string> = {};

async function makeCategory(key: string, kind: 'income' | 'expense', section: 'operating' | 'renovation_fund'): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `insert into public.fin_categories (kind, name, section, created_by) values ($1, $2, $3, $4) returning id`,
    [kind, `${uniq}-${key}`, section, actorId],
  );
  made.categories.push(r.rows[0]!.id);
  cat[key] = r.rows[0]!.id;
  return r.rows[0]!.id;
}

async function makeEntry(kind: 'income' | 'expense', categoryKey: string, month: string, amount: number): Promise<string> {
  const e = await createEntry(
    {
      kind,
      category_id: cat[categoryKey]!,
      period_month: periodMonthOf(month),
      amount,
      description: `${uniq} ${categoryKey}`,
      internal_note: 'internal',
      supplier_id: null,
      supplier_name: kind === 'expense' ? 'secret supplier' : '',
      invoice_number: '',
      payment_date: kind === 'expense' ? `${month}-15` : null,
    },
    actorId,
  );
  made.entries.push(e.id);
  return e.id;
}

async function publish(month: string, published: boolean): Promise<void> {
  const { year, month: m } = monthKeyParts(month);
  const existing = await pool.query(`select 1 from public.finance_month_status where year = $1 and month = $2`, [year, m]);
  if (existing.rowCount === 0) made.months.push({ year, month: m });
  await setMonthPublished(year, m, published, actorId);
}

/** Sum of my lines of one category over the months inside [from, to]. */
function expectedTotal(lines: Array<{ month: string; amount: number }>, from: string, to: string): number {
  return lines.filter((l) => l.month >= from && l.month <= to).reduce((s, l) => s + l.amount, 0);
}

d('finance read layer — sections, cumulative fund, publishedOnly, period report', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_URL, max: 4 });
    pool.on('error', () => undefined);
    const admin = await pool.query<{ id: string }>(`select id from public.users where username = 'e2e-admin'`);
    actorId = admin.rows[0]!.id;
    targetBefore = (await getRenovationFundSettings()).target_amount;
    const [all, published] = await Promise.all([
      getRenovationFundKpis({ publishedOnly: false }),
      getRenovationFundKpis({ publishedOnly: true }),
    ]);
    base = { all: { collected: all.collected, spent: all.spent }, published: { collected: published.collected, spent: published.spent } };

    await makeCategory('opInc', 'income', 'operating');
    await makeCategory('opExp', 'expense', 'operating');
    await makeCategory('fundInc', 'income', 'renovation_fund');
    await makeCategory('fundExp1', 'expense', 'renovation_fund');
    await makeCategory('fundExp2', 'expense', 'renovation_fund');
    await makeCategory('fundExpZero', 'expense', 'renovation_fund');

    await makeEntry('income', 'opInc', cur, 1000);
    await makeEntry('income', 'opInc', prev, 2000);
    await makeEntry('expense', 'opExp', cur, 300);
    await makeEntry('expense', 'opExp', prev, 500);
    await makeEntry('income', 'fundInc', cur, 5000);
    await makeEntry('income', 'fundInc', prev2, 7000);
    await makeEntry('expense', 'fundExp1', prev, 1500);
    await makeEntry('expense', 'fundExp2', cur, 250);

    await publish(prev, true);
    await updateRenovationFundSettings({ target_amount: 20000 }, actorId);
  });

  afterAll(async () => {
    for (const id of made.entries) await pool.query(`delete from public.fin_entries where id = $1`, [id]);
    for (const id of made.categories) await pool.query(`delete from public.fin_categories where id = $1`, [id]);
    for (const m of made.months) await pool.query(`delete from public.finance_month_status where year = $1 and month = $2`, [m.year, m.month]);
    await updateRenovationFundSettings({ target_amount: targetBefore }, actorId);
    await pool.end();
  });

  it('refuses a category of the other section (both directions), accepts a matching one', async () => {
    const fundOnOperating = await resolveEntryInput(
      { kind: 'expense', section: 'renovation_fund', category_id: cat.opExp!, amount: 10, payment_date: `${cur}-10`, supplier_id: null, supplier_name: '', invoice_number: '', description: '', internal_note: '', document_ids: [] },
      'create',
    );
    expect(fundOnOperating.ok).toBe(false);
    if (!fundOnOperating.ok) expect(fundOnOperating.error).toContain('אינו שייך לקרן');

    const operatingOnFund = await resolveEntryInput(
      { kind: 'income', section: 'operating', category_id: cat.fundInc!, amount: 10, month: cur, description: '', internal_note: '', document_ids: [] },
      'create',
    );
    expect(operatingOnFund.ok).toBe(false);
    if (!operatingOnFund.ok) expect(operatingOnFund.error).toContain('שייך לקרן');

    const matching = await resolveEntryInput(
      { kind: 'expense', section: 'renovation_fund', category_id: cat.fundExp1!, amount: 10, payment_date: `${cur}-10`, supplier_id: null, supplier_name: '', invoice_number: '', description: '', internal_note: '', document_ids: [] },
      'create',
    );
    expect(matching.ok).toBe(true);
  });

  it('the operating month view holds no fund line; the fund ledger holds only fund lines', async () => {
    const month = await listEntriesForMonth(periodMonthOf(cur), { section: 'operating' });
    const mine = month.filter((e) => made.entries.includes(e.id));
    expect(mine.map((e) => e.category_id).sort()).toEqual([cat.opInc, cat.opExp].sort());
    expect(mine.every((e) => e.category_section === 'operating')).toBe(true);

    const ledger = await listFundEntries({ publishedOnly: false });
    const mineLedger = ledger.filter((e) => made.entries.includes(e.id));
    expect(mineLedger).toHaveLength(4);
    expect(mineLedger.every((e) => e.category_section === 'renovation_fund')).toBe(true);
    // Newest first.
    const whens = mineLedger.map((e) => e.payment_date ?? e.period_month);
    expect([...whens].sort().reverse()).toEqual(whens);
  });

  it('fund KPIs are cumulative over all months and list every purpose, 0 included', async () => {
    const k = await getRenovationFundKpis({ publishedOnly: false });
    expect(k.target_amount).toBe(20000);
    expect(k.collected - base.all.collected).toBe(12000);
    expect(k.spent - base.all.spent).toBe(1750);
    expect(k.balance).toBe(k.collected - k.spent);
    expect(k.pct).toBeCloseTo((k.collected / 20000) * 100, 5);
    const byId = new Map(k.by_purpose.map((p) => [p.category_id, p.total]));
    expect(byId.get(cat.fundExp1!)).toBe(1500);
    expect(byId.get(cat.fundExp2!)).toBe(250);
    expect(byId.get(cat.fundExpZero!)).toBe(0);
    expect(k.by_purpose.some((p) => p.category_id === cat.fundInc)).toBe(false);
    const mine = k.entries.filter((e) => made.entries.includes(e.id));
    expect(mine.filter((e) => e.published).map((e) => e.period_month)).toEqual([periodMonthOf(prev)]);
  });

  it('publishedOnly leaves hidden months out of the fund sums and the ledger', async () => {
    const k = await getRenovationFundKpis({ publishedOnly: true });
    // My fund incomes sit in hidden months (cur, prev2): nothing of them is counted.
    expect(k.collected - base.published.collected).toBe(0);
    expect(k.spent - base.published.spent).toBe(1500);
    expect(k.balance).toBe(k.collected - k.spent);
    const byId = new Map(k.by_purpose.map((p) => [p.category_id, p.total]));
    expect(byId.get(cat.fundExp2!)).toBe(0);
    const mine = k.entries.filter((e) => made.entries.includes(e.id));
    expect(mine).toHaveLength(1);
    expect(mine[0]!.published).toBe(true);
    expect(mine[0]!.period_month).toBe(periodMonthOf(prev));
  });

  it('a hidden month returns null to residents; a published one returns only what they may see', async () => {
    const { year: cy, month: cm } = monthKeyParts(cur);
    expect(await getResidentMonthData(cy, cm)).toBeNull();

    const { year: py, month: pm } = monthKeyParts(prev);
    const data = await getResidentMonthData(py, pm);
    expect(data).not.toBeNull();
    const opInc = data!.operating.income.filter((e) => e.category_name === `${uniq}-opInc`);
    expect(opInc).toHaveLength(1);
    expect(opInc[0]!.amount).toBe(2000);
    expect(data!.fund.expense.filter((e) => e.category_name === `${uniq}-fundExp1`)[0]!.amount).toBe(1500);
    for (const e of [...data!.operating.expense, ...data!.fund.expense]) {
      expect(e).not.toHaveProperty('supplier_name');
      expect(e).not.toHaveProperty('internal_note');
    }

    const published = await getPublishedMonths();
    expect(published.some((m) => m.year === py && m.month === pm)).toBe(true);
    expect(published.some((m) => m.year === cy && m.month === cm)).toBe(false);
  });

  it('period report: totals + monthly average per category, publishedOnly narrows the months', async () => {
    const all = await getPeriodReport(prev2, cur, { publishedOnly: false });
    expect(all.months.map((m) => m.month)).toEqual([prev2, prev, cur]);
    expect(all.months.map((m) => m.published)).toEqual([false, true, false]);
    expect(all.months.every((m) => m.included)).toBe(true);
    const inc = all.income.find((c) => c.category_id === cat.opInc)!;
    expect(inc.total).toBe(3000);
    expect(inc.average).toBe(1000);
    expect(inc.by_month).toEqual({ [cur]: 1000, [prev]: 2000 });
    const exp = all.expense.find((c) => c.category_id === cat.opExp)!;
    expect(exp.total).toBe(800);
    // No fund category leaks into the operating report.
    expect([...all.income, ...all.expense].some((c) => c.category_id === cat.fundInc || c.category_id === cat.fundExp1)).toBe(false);
    expect(all.totals.surplus).toBe(all.totals.income - all.totals.expense);

    const pub = await getPeriodReport(prev2, cur, { publishedOnly: true });
    expect(pub.months.map((m) => m.included)).toEqual([false, true, false]);
    const pubInc = pub.income.find((c) => c.category_id === cat.opInc)!;
    expect(pubInc.total).toBe(2000);
    expect(pubInc.average).toBe(2000);
  });

  it('quarter, half and year ranges sum the right months', async () => {
    const incomeLines = [{ month: cur, amount: 1000 }, { month: prev, amount: 2000 }];
    const { year: cy } = monthKeyParts(cur);
    const quarter = makePeriod('quarter', cy, Math.ceil(monthKeyParts(cur).month / 3));
    const half = makePeriod('half', cy, monthKeyParts(cur).month <= 6 ? 1 : 2);
    const year = makePeriod('year', cy, 1);
    for (const p of [quarter, half, year]) {
      const r = await getPeriodReport(p.from, p.to, { publishedOnly: false });
      const inc = r.income.find((c) => c.category_id === cat.opInc);
      expect(inc?.total ?? 0).toBe(expectedTotal(incomeLines, p.from, p.to));
      // Future months of the range are not counted as months.
      expect(r.months.every((m) => m.month <= cur)).toBe(true);
      expect(r.months[0]!.month).toBe(p.from);
    }
  });
});
