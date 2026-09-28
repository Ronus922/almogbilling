import { test, expect, type Browser, type BrowserContext } from '@playwright/test';

// Three display decisions of 28/09/2026 (evening), against db/seed/e2e.sql:
//   • whole shekels on every screen of the portal — the published month holds
//     an income of 8,820.40 + 1 and an expense of 1,800.50, so the KPIs read
//     ₪8,821 / ₪1,801 / ₪7,021 (from the exact totals) and the lines
//     +₪8,820 / −₪1,801 / +₪1, while the Excel export keeps 1800.5 as a
//     number with two decimals;
//   • an income amount wears .in (green-ink #0B7A3B), an expense .out
//     (red-ink #B03A3E) — rows, KPIs, categories, report totals, the fund;
//   • E2E-D is archived with a balance: its owner sees the figures exactly
//     like any other owner — no note, no status, no word about it — and
//     none of the canaries; the admin preview shows the same.
// Portal cookies only (no admin session by default), like portal-security.

const STORAGE_STATE = 'e2e/.auth/state.json';
test.use({ storageState: { cookies: [], origins: [] } });

const GREEN_INK = 'rgb(11, 122, 59)';
const RED_INK = 'rgb(176, 58, 62)';
const CANARIES = ['CANARY-', '050-4444444', 'is_archived'];
/** Words that must not appear anywhere on an archived apartment's screens. */
const NOT_SHOWN = ['בבדיקה מול חברת הניהול', 'מאורכב', 'ארכיון', 'משפטי', 'פתאל', 'לא פעיל'];
const D_KPIS = ['יתרה לתשלום=₪1,000', 'חוב דמי ניהול=₪1,000', 'חוב מים חמים=₪0', 'חיוב חודשי=9/26'];

const prevKey = () => { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 7); };

async function owner(browser: Browser, token: string, viewport?: { width: number; height: number }): Promise<BrowserContext> {
  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] }, viewport });
  await ctx.addCookies([{ name: 'portal_session', value: token, domain: 'localhost', path: '/' }]);
  return ctx;
}

const kpisOf = (page: import('@playwright/test').Page, root: string) =>
  page.evaluate((r) => [...document.querySelectorAll(`${r} .kpi`)].map((k) => `${k.querySelector('.k')?.textContent}=${k.querySelector('.v')?.textContent}`), root);

const colorOf = (page: import('@playwright/test').Page, selector: string) =>
  page.locator(selector).first().evaluate((el) => getComputedStyle(el).color);

test.describe('an archived apartment with a balance', () => {
  test('its owner sees the figures like any other owner — no note, no status, no canary', async ({ browser }) => {
    const ctx = await owner(browser, 'e2e-owner-d');
    const page = await ctx.newPage();
    await page.goto('/portal?tab=acc');
    expect(await kpisOf(page, '#t-acc')).toEqual(D_KPIS);
    await expect(page.locator('#t-acc .kpi .v.red')).toHaveCount(1);
    await expect(page.locator('#t-acc .details')).toContainText('E2E-DETAILS-D');
    const text = await page.locator('main.wrap').innerText();
    for (const w of NOT_SHOWN) expect(text, w).not.toContain(w);
    await page.goto('/portal?tab=ov');
    await expect(page.locator('.mine .big')).toHaveText('₪1,000');
    await expect(page.locator('.mine .tag')).toHaveText('חוב פתוח');
    for (const q of ['/portal?tab=acc', '/portal?tab=ov']) {
      const html = await (await ctx.request.get(q)).text();
      const rsc = await (await ctx.request.get(q, { headers: { RSC: '1' } })).text();
      for (const c of CANARIES) {
        expect(html, `${q} html`).not.toContain(c);
        expect(rsc, `${q} rsc`).not.toContain(c);
      }
      for (const w of NOT_SHOWN) expect(html, `${q} ${w}`).not.toContain(w);
    }
    await ctx.close();
  });

  test('the admin preview shows the same figures, with no mark either', async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: STORAGE_STATE });
    const page = await ctx.newPage();
    await page.goto('/finance?view=resident&apt=E2E-D&tab=acc');
    await expect(page.getByText('תצוגה מקדימה — כך רואה דייר')).toBeVisible();
    expect(await kpisOf(page, '#t-acc')).toEqual(D_KPIS);
    const text = await page.locator('main.wrap').innerText();
    for (const w of NOT_SHOWN) expect(text, w).not.toContain(w);
    await ctx.close();
  });
});

test.describe('whole shekels on the screen, agorot in the file', () => {
  test('the month: KPIs from the exact totals, lines rounded, no decimals anywhere', async ({ browser }) => {
    const ctx = await owner(browser, 'e2e-owner-a1');
    const page = await ctx.newPage();
    await page.goto(`/portal?tab=tx&m=${prevKey()}`);
    const kpis = await kpisOf(page, '#t-tx');
    expect(kpis).toEqual(expect.arrayContaining(['הכנסות=₪8,821', 'הוצאות=₪1,801', 'הפרש=₪7,021']));
    expect(await page.locator('#t-tx .tw .amt').allTextContents()).toEqual(['−₪1,801', '+₪8,820', '+₪1']);
    expect(await page.locator('#t-tx .cats .a').allTextContents()).toEqual(['₪8,821100%', '₪1,801100%']);
    expect(await page.locator('#t-tx').innerText()).not.toMatch(/₪[\d,]*\.\d/);
    await page.goto('/portal?tab=ov');
    await expect(page.locator('#t-ov .kpi .v.in')).toHaveText('₪8,821');
    await expect(page.locator('#t-ov .kpi .v.out')).toHaveText('₪1,801');
    await expect(page.locator('#t-ov .mine .big')).toHaveText('₪1,240');
    expect(await page.locator('#t-ov').innerText()).not.toMatch(/₪[\d,]*\.\d/);
    await page.goto('/portal?tab=rep');
    await expect(page.locator('#t-rep .tot .amt.in').first()).toHaveText('₪8,821');
    await expect(page.locator('#t-rep .tot .amt.out').first()).toHaveText('₪1,801');
    expect(await kpisOf(page, '#t-rep')).toEqual(expect.arrayContaining(['הכנסות=₪8,821', 'הוצאות=₪1,801', 'עודף בתקופה=₪7,021']));
    await page.goto('/portal?tab=fund');
    const fund = page.locator('.fund-host');
    await expect(fund.locator('dd', { hasText: '₪5,001' })).toHaveCount(1);
    await expect(fund.locator('dd', { hasText: '₪1,200' })).toHaveCount(1);
    await expect(fund.locator('dd', { hasText: '₪3,800' })).toHaveCount(1);
    expect(await fund.innerText()).not.toMatch(/₪[\d,]*\.\d/);
    await ctx.close();
  });

  test('the Excel export keeps the agorot as a number with two decimals', async ({ browser }) => {
    const ctx = await owner(browser, 'e2e-owner-a1');
    const page = await ctx.newPage();
    await page.goto(`/portal?tab=tx&m=${prevKey()}`);
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#t-tx .pbtn-secondary')]);
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile((await dl.path())!);
    const amounts: Array<{ value: unknown; numFmt: string }> = [];
    wb.worksheets[0].eachRow((row, i) => { if (i > 1) amounts.push({ value: row.getCell(5).value, numFmt: row.getCell(5).numFmt }); });
    expect(amounts.map((a) => a.value).sort()).toEqual([1, 1800.5, 8820.4]);
    for (const a of amounts) {
      expect(typeof a.value).toBe('number');
      expect(a.numFmt).toBe('#,##0.00');
    }
    await ctx.close();
  });

  test('no amount breaks onto two lines at 360, 390 and 834', async ({ browser }) => {
    for (const width of [360, 390, 834]) {
      const ctx = await owner(browser, 'e2e-owner-a1', { width, height: 900 });
      const page = await ctx.newPage();
      for (const tab of ['ov', 'tx', 'acc', 'fund', 'rep']) {
        await page.goto(`/portal?tab=${tab}${tab === 'tx' ? `&m=${prevKey()}` : ''}`);
        await page.waitForLoadState('networkidle');
        const wrapped = await page.evaluate(() =>
          [...document.querySelectorAll('.amt, .kpi .v, .mine .big, .cat .a, .fund-host dd, .fund-host [dir=ltr]')]
            .filter((el) => { const r = [...el.getClientRects()]; return r.length > 1 && new Set(r.map((q) => Math.round(q.top))).size > 1; })
            .map((el) => el.textContent));
        expect(wrapped, `${width} ${tab}`).toEqual([]);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width} ${tab} horizontal scroll`).toBe(true);
      }
      await ctx.close();
    }
  });
});

test.describe('income green, expense red', () => {
  test('rows, KPIs, categories, report totals and the fund carry the tokens', async ({ browser }) => {
    const ctx = await owner(browser, 'e2e-owner-a1');
    const page = await ctx.newPage();
    await page.goto(`/portal?tab=tx&m=${prevKey()}`);
    expect(await colorOf(page, '#t-tx .tw .amt.in')).toBe(GREEN_INK);
    expect(await colorOf(page, '#t-tx .tw .amt.out')).toBe(RED_INK);
    await expect(page.locator('#t-tx .tw tr', { hasText: 'E2E ניקיון חדר מדרגות' }).locator('.amt')).toHaveClass(/\bout\b/);
    await expect(page.locator('#t-tx .tw tr', { hasText: 'E2E-FORMULA' }).locator('.amt')).toHaveClass(/\bin\b/);
    expect(await colorOf(page, '#t-tx .kpi .v.in')).toBe(GREEN_INK);
    expect(await colorOf(page, '#t-tx .kpi .v.out')).toBe(RED_INK);
    // the difference is positive this month → green
    await expect(page.locator('#t-tx .kpi', { hasText: 'הפרש' }).locator('.v')).toHaveClass(/\bin\b/);
    expect(await colorOf(page, '#t-tx .cats .a.in')).toBe(GREEN_INK);
    expect(await colorOf(page, '#t-tx .cats .a.out')).toBe(RED_INK);
    await page.goto('/portal?tab=ov');
    expect(await colorOf(page, '#t-ov .kpi .v.in')).toBe(GREEN_INK);
    expect(await colorOf(page, '#t-ov .kpi .v.out')).toBe(RED_INK);
    expect(await colorOf(page, '#t-ov .cats .a.out')).toBe(RED_INK);
    // the tooltip lines: hover the newest month
    await page.locator('.chart .grp').last().hover();
    await expect(page.locator('.tip.on')).toBeVisible();
    expect(await colorOf(page, '.tip.on .in')).toBe(GREEN_INK);
    expect(await colorOf(page, '.tip.on .out')).toBe(RED_INK);
    await page.goto('/portal?tab=rep');
    expect(await colorOf(page, '#t-rep .tot .amt.in')).toBe(GREEN_INK);
    expect(await colorOf(page, '#t-rep .tot .amt.out')).toBe(RED_INK);
    await page.goto('/portal?tab=fund');
    expect(await page.locator('.fund-host dd', { hasText: '₪5,001' }).evaluate((el) => getComputedStyle(el).color)).toBe(GREEN_INK);
    expect(await page.locator('.fund-host dd', { hasText: '₪1,200' }).evaluate((el) => getComputedStyle(el).color)).toBe(RED_INK);
    expect(await page.locator('.fund-host dd', { hasText: '₪3,800' }).evaluate((el) => getComputedStyle(el).color)).toBe(GREEN_INK);
    await ctx.close();
  });
});
