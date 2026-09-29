import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';

// The period picker of the portal's "הכנסות והוצאות" tab, restored 29/09/2026
// after PR #44 (b51b791) left the tab with a month-only select. Four levels —
// month · quarter · half · year — and every figure of the tab follows the
// selection, published months only.
//
// Against db/seed/e2e.sql: the month before this one is published and holds
// 8,820.40 + 1 of income and 1,800.50 of expense; the month before THAT is
// published and empty; the current month is NOT published and holds
// CANARY-HIDDEN-ENTRY (6,543.21). So whichever range we pick around the
// published month — its quarter, its half, its year — the figures must stay
// ₪8,821 / ₪1,801 / ₪7,021: the empty published month adds nothing and the
// hidden month must add nothing either. That makes every assertion here
// independent of the date CI happens to run on.

const STORAGE_STATE = 'e2e/.auth/state.json';
test.use({ storageState: { cookies: [], origins: [] } });

const shift = (n: number) => {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 7);
};
// `cur` is the month the SERVER calls current (Asia/Jerusalem, currentMonthKey)
// — it is what cuts a period short; `prev`/`prev2` follow the seed, which
// builds them from the database's now().
const cur = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' }).slice(0, 7);
const prev = shift(-1);
const prev2 = shift(-2);
const PUBLISHED = [prev2, prev];

const pad = (n: number) => String(n).padStart(2, '0');
const [py, pm] = prev.split('-').map(Number) as [number, number];
const RANGES = [
  { key: `${py}-Q${Math.ceil(pm / 3)}`, from: `${py}-${pad((Math.ceil(pm / 3) - 1) * 3 + 1)}`, to: `${py}-${pad(Math.ceil(pm / 3) * 3)}` },
  { key: `${py}-H${pm <= 6 ? 1 : 2}`, from: `${py}-${pad(pm <= 6 ? 1 : 7)}`, to: `${py}-${pad(pm <= 6 ? 6 : 12)}` },
  { key: `${py}`, from: `${py}-01`, to: `${py}-12` },
];

/** Calendar months of a range up to the current one — what the tab counts as M. */
function monthsOf(from: string, to: string): string[] {
  const out: string[] = [];
  const last = to < cur ? to : cur;
  for (let m = from; m <= last; ) {
    out.push(m);
    const [y, mm] = m.split('-').map(Number) as [number, number];
    m = mm === 12 ? `${y + 1}-01` : `${y}-${pad(mm + 1)}`;
  }
  return out;
}
const publishedIn = (from: string, to: string) => PUBLISHED.filter((k) => k >= from && k <= to);

const KPIS = ['הכנסות=₪8,821', 'הוצאות=₪1,801', 'הפרש=₪7,021'];

async function owner(browser: Browser, token = 'e2e-owner-a1'): Promise<BrowserContext> {
  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  await ctx.addCookies([{ name: 'portal_session', value: token, domain: 'localhost', path: '/' }]);
  return ctx;
}

const kpisOf = (page: Page) =>
  page.evaluate(() => [...document.querySelectorAll('#t-tx .kpi')].map((k) => `${k.querySelector('.k')?.textContent}=${k.querySelector('.v')?.textContent}`));

const picker = (page: Page) => page.locator('#t-tx select.sel');

test.describe('the transactions tab period picker', () => {
  test('offers month, quarter, half and year — published only, newest published month first', async ({ browser }) => {
    const ctx = await owner(browser);
    const page = await ctx.newPage();
    await page.goto('/portal?tab=tx');

    await expect(picker(page)).toHaveAttribute('aria-label', 'תקופה');
    await expect(picker(page)).toHaveValue(prev);

    const values = await picker(page).locator('option').evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
    for (const k of [prev, prev2, ...RANGES.map((r) => r.key)]) expect(values, k).toContain(k);
    // The current month is not published: it is not an option at all, so no
    // click in this picker can open it.
    expect(values).not.toContain(cur);
    // All four levels are represented.
    expect(values.some((v) => /^\d{4}-Q[1-4]$/.test(v))).toBe(true);
    expect(values.some((v) => /^\d{4}-H[12]$/.test(v))).toBe(true);
    expect(values.some((v) => /^\d{4}$/.test(v))).toBe(true);
    await ctx.close();
  });

  for (const range of RANGES) {
    test(`${range.key}: the KPIs equal the published months of the period, and the hidden month is not in it`, async ({ browser }) => {
      const ctx = await owner(browser);
      const page = await ctx.newPage();
      await page.goto('/portal?tab=tx');
      await picker(page).selectOption(range.key);
      await page.waitForURL((u) => u.searchParams.get('m') === range.key);
      await expect(picker(page)).toHaveValue(range.key);

      // Only the published month carries figures, so the period equals it.
      expect(await kpisOf(page)).toEqual(KPIS);

      const months = monthsOf(range.from, range.to);
      const shown = publishedIn(range.from, range.to);
      await expect(page.locator('#t-tx .note').first()).toHaveText(`כולל ${shown.length} מתוך ${months.length} חודשים.`);
      // A column per month residents get — never one for a month they do not.
      await expect(page.locator('#t-tx .chart .grp')).toHaveCount(shown.length);

      const body = await page.locator('#t-tx').innerText();
      expect(body).toContain('E2E ניקיון חדר מדרגות');
      expect(body).not.toContain('CANARY-HIDDEN-ENTRY');
      expect(body).not.toContain('6,543');
      await ctx.close();
    });
  }

  test('a month keeps the tab exactly as it was — no period chart, no "N of M" line', async ({ browser }) => {
    const ctx = await owner(browser);
    const page = await ctx.newPage();
    await page.goto(`/portal?tab=tx&m=${prev}`);
    expect(await kpisOf(page)).toEqual(KPIS);
    await expect(page.locator('#t-tx .chart')).toHaveCount(0);
    await expect(page.locator('#t-tx .note').filter({ hasText: 'מתוך' })).toHaveCount(0);
    await ctx.close();
  });

  test('the period lives in the URL: a shared link opens it, a reload keeps it', async ({ browser }) => {
    const quarter = RANGES[0]!.key;
    const ctx = await owner(browser);
    const page = await ctx.newPage();
    // No ?tab= at all — a link that carries only the period lands on this tab.
    await page.goto(`/portal?m=${quarter}`);
    await expect(page.locator('#t-tx')).toBeVisible();
    await expect(picker(page)).toHaveValue(quarter);
    await page.reload();
    await expect(picker(page)).toHaveValue(quarter);
    expect(await kpisOf(page)).toEqual(KPIS);
    await ctx.close();
  });

  test('a period residents may not open falls back to the newest published month', async ({ browser }) => {
    const ctx = await owner(browser);
    const page = await ctx.newPage();
    for (const m of [cur, '1999-Q1', 'garbage']) {
      await page.goto(`/portal?tab=tx&m=${m}`);
      await expect(picker(page)).toHaveValue(prev);
      expect(await page.locator('#t-tx').innerText()).not.toContain('CANARY-HIDDEN-ENTRY');
    }
    await ctx.close();
  });

  test('the admin preview gets the same picker and the same figures', async ({ browser }) => {
    const quarter = RANGES[0]!.key;
    const ctx = await browser.newContext({ storageState: STORAGE_STATE });
    const page = await ctx.newPage();
    await page.goto(`/finance?view=resident&apt=E2E-A&tab=tx&m=${quarter}`);
    await expect(page.getByText('תצוגה מקדימה — כך רואה דייר')).toBeVisible();
    await expect(picker(page)).toHaveValue(quarter);
    expect(await kpisOf(page)).toEqual(KPIS);
    // The preview carries its own params through the picker.
    await picker(page).selectOption(prev);
    await page.waitForURL((u) => u.searchParams.get('m') === prev);
    expect(new URL(page.url()).searchParams.get('view')).toBe('resident');
    expect(new URL(page.url()).searchParams.get('apt')).toBe('E2E-A');
    await ctx.close();
  });
});
