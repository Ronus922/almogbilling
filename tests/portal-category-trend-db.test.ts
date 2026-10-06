import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { requireSeededAdmin } from './db-fixtures';

// GET /api/portal/finance/categories/[id]/monthly against a REAL database —
// the transactions tab's category trend (06/10/2026). The route runs as it
// does in production (guard → getResidentCategoryTrend → SQL); only the cookie
// store, the session row and the identity are faked, so the guard passes.
//
// The boundary this feature lives under: ONLY PUBLISHED MONTHS. The suite owns
// the publication state of the fourteen months up to the current one and of
// the next month, and asserts on the endpoint's answer:
//   • a month that is not published is not in the answer at all — not as 0;
//   • at most 12 months: the newest twelve published ones, oldest first;
//   • a published month in the future is not one of them;
//   • the sums are exact and rounded once (100.25 + 200.30 → 301, not 300);
//   • a published month without a line is there as 0; a deleted line counts 0;
//   • it works for an income category as for an expense one;
//   • a fund category and an unknown id → 404; no session → 401.
//
// Runs ONLY against a throwaway database (WA_TEST_DATABASE_URL), never prod.
// Everything it creates is removed by the exact ids it recorded, and every
// month's publication state is put back as it was (CLAUDE.md iron rule 12).
const TEST_URL = process.env.WA_TEST_DATABASE_URL;
// Explicit gate: without a throwaway database these report as SKIPPED, never
// as passed — scripts/check-no-skipped-tests.mjs fails CI if any of them do.
const d = describe.skipIf(!TEST_URL);

let pool: Pool;

const h = vi.hoisted(() => ({ cookie: 'good-token' as string | null }));

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
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (name === 'portal_session' && h.cookie ? { name, value: h.cookie } : undefined),
    set: vi.fn(),
    delete: vi.fn(),
  }),
}));
vi.mock('@/lib/db/portal/sessions', () => ({
  findPortalSession: vi.fn(async (token: string) => (token === 'good-token' ? { id: 's1', phoneE164: '+972521234567' } : null)),
  revokePortalSessionsForPhone: vi.fn(),
  revokePortalSession: vi.fn(),
  createPortalSessionRow: vi.fn(),
}));
vi.mock('@/lib/db/portal/ownerPhones', () => ({ isActiveOwner: vi.fn(async () => true) }));
vi.mock('@/lib/db/portal/events', () => ({ logPortalEvent: vi.fn() }));
vi.mock('@/lib/db/portal/identity', () => ({
  resolvePortalIdentity: vi.fn(async () => ({ status: 'ok', name: 'דנה לוי', apartments: [], canSeeBuildingFinance: true, approvalId: null, reporter: null })),
}));

const { GET } = await import('@/app/api/portal/finance/categories/[id]/monthly/route');
const { createEntry } = await import('@/lib/db/finance/entries');
const { setMonthPublished } = await import('@/lib/db/finance/month-status');
const { currentMonthKey, monthKeyParts, periodMonthOf, shiftMonthKey } = await import('@/lib/finance/period');

const uniq = `trend-${Date.now()}`;
const made = { categories: [] as string[], entries: [] as string[] };
const monthsBefore: Array<{ year: number; month: number; published: boolean | null }> = [];
let actorId = '';

const cur = currentMonthKey();
/** M(k) = k months before the current one; M(-1) = next month. */
const M = (k: number) => shiftMonthKey(cur, -k);
const cat: Record<string, string> = {};

async function makeCategory(key: string, kind: 'income' | 'expense', section: 'operating' | 'renovation_fund'): Promise<void> {
  const r = await pool.query<{ id: string }>(
    `insert into public.fin_categories (kind, name, section, created_by) values ($1, $2, $3, $4) returning id`,
    [kind, `${uniq}-${key}`, section, actorId],
  );
  made.categories.push(r.rows[0]!.id);
  cat[key] = r.rows[0]!.id;
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

/** State the publication of a month, remembering what was there. */
async function forceMonth(month: string, published: boolean): Promise<void> {
  const { year, month: m } = monthKeyParts(month);
  const existing = await pool.query<{ published: boolean }>(
    `select published from public.finance_month_status where year = $1 and month = $2`,
    [year, m],
  );
  monthsBefore.push({ year, month: m, published: existing.rows[0]?.published ?? null });
  await setMonthPublished(year, m, published, actorId);
}

async function trend(id: string): Promise<{ status: number; body: { months?: Array<{ month: string; total: number }>; error?: string } }> {
  const res = await GET(new Request(`http://localhost/api/portal/finance/categories/${id}/monthly`), { params: Promise.resolve({ id }) });
  return { status: res.status, body: await res.json() };
}

d('the category trend endpoint — published months only, at most 12, exact sums', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_URL, max: 4 });
    pool.on('error', () => undefined);
    actorId = await requireSeededAdmin(pool);

    // Fourteen months up to the current one, all published except M(2); and
    // the NEXT month published too — it is in the future, so it never counts.
    for (let k = 0; k <= 13; k += 1) await forceMonth(M(k), k !== 2);
    await forceMonth(M(-1), true);

    await makeCategory('elec', 'expense', 'operating');
    await makeCategory('fees', 'income', 'operating');
    await makeCategory('fund', 'expense', 'renovation_fund');

    await makeEntry('expense', 'elec', M(1), 100.25);
    await makeEntry('expense', 'elec', M(1), 200.3);
    await makeEntry('expense', 'elec', M(3), 1800.5);
    await makeEntry('expense', 'elec', M(2), 999.99); // hidden month
    await makeEntry('expense', 'elec', M(13), 500); // published, but the 13th newest
    await makeEntry('expense', 'elec', M(-1), 777); // published, but in the future
    const deleted = await makeEntry('expense', 'elec', M(4), 444);
    await pool.query(`update public.fin_entries set deleted_at = now(), deleted_by = $2 where id = $1`, [deleted, actorId]);

    await makeEntry('income', 'fees', M(5), 1000);
    await makeEntry('expense', 'fund', M(1), 50);
  });

  afterAll(async () => {
    for (const id of made.entries) await pool.query(`delete from public.fin_entries where id = $1`, [id]);
    for (const id of made.categories) await pool.query(`delete from public.fin_categories where id = $1`, [id]);
    for (const m of [...monthsBefore].reverse()) {
      if (m.published === null) {
        await pool.query(`delete from public.finance_month_status where year = $1 and month = $2`, [m.year, m.month]);
      } else {
        await setMonthPublished(m.year, m.month, m.published, actorId);
      }
    }
    await pool.end();
  });

  it('answers with the newest 12 published months, oldest first — the hidden month is not there at all', async () => {
    const r = await trend(cat.elec!);
    expect(r.status).toBe(200);
    const keys = r.body.months!.map((m) => m.month);
    const expected = [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 1, 0].map(M);
    expect(keys).toEqual(expected);
    expect(keys).toHaveLength(12);
    expect(keys).not.toContain(M(2));
    expect(keys).not.toContain(M(13));
    expect(keys).not.toContain(M(-1));
  });

  it('sums exactly and rounds once; a month without a line — or with a deleted one — is 0', async () => {
    const r = await trend(cat.elec!);
    const byMonth = Object.fromEntries(r.body.months!.map((m) => [m.month, m.total]));
    expect(byMonth[M(1)]).toBe(301);
    expect(byMonth[M(3)]).toBe(1801);
    expect(byMonth[M(4)]).toBe(0);
    expect(byMonth[M(0)]).toBe(0);
    expect(r.body.months!.filter((m) => m.total !== 0)).toHaveLength(2);
    // a monthly sum and nothing else — no line, no supplier, no description
    expect(JSON.stringify(r.body)).not.toMatch(/secret supplier|internal|trend-/);
    expect(Object.keys(r.body)).toEqual(['months']);
    for (const m of r.body.months!) expect(Object.keys(m).sort()).toEqual(['month', 'total']);
  });

  it('works the same for an income category', async () => {
    const r = await trend(cat.fees!);
    expect(r.status).toBe(200);
    expect(r.body.months!).toHaveLength(12);
    expect(r.body.months!.filter((m) => m.total !== 0)).toEqual([{ month: M(5), total: 1000 }]);
  });

  it('publishing the hidden month brings it in; hiding a month takes it out — the window follows the SQL', async () => {
    const { year, month } = monthKeyParts(M(2));
    await setMonthPublished(year, month, true, actorId);
    try {
      const r = await trend(cat.elec!);
      const keys = r.body.months!.map((m) => m.month);
      expect(keys).toContain(M(2));
      expect(keys).toHaveLength(12);
      expect(keys[0]).toBe(M(11)); // twelve newest now reach back one month less
      expect(r.body.months!.find((m) => m.month === M(2))?.total).toBe(1000); // 999.99 → 1,000
    } finally {
      await setMonthPublished(year, month, false, actorId);
    }
    const after = await trend(cat.elec!);
    expect(after.body.months!.map((m) => m.month)).not.toContain(M(2));
  });

  it('a renovation-fund category and an unknown id → 404', async () => {
    expect((await trend(cat.fund!)).status).toBe(404);
    expect((await trend('00000000-0000-4000-8000-00000000abcd')).status).toBe(404);
  });

  it('no portal session → 401', async () => {
    h.cookie = null;
    try {
      expect((await trend(cat.elec!)).status).toBe(401);
    } finally {
      h.cookie = 'good-token';
    }
  });
});
