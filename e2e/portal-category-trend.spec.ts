import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';

// The category trend of the transactions tab (06/10/2026): every category row
// — income and expense — opens on the category's sum in each of the newest
// published months (up to 12), whatever the period picker is on.
//
// Against db/seed/e2e.sql: the month before this one is published and holds
// "E2E דמי ועד" 8,820.40 + 1 (income) and "E2E ניקיון" 1,800.50 (expense);
// the month before THAT is published and empty; the CURRENT month is NOT
// published and holds "E2E ניקיון" CANARY-HIDDEN-ENTRY 6,543.21. So the
// expense trend must show ₪1,801 for the published month, 0 for the empty
// one, and nothing at all — not even a column — for the current month.
// Portal cookies only (no admin session by default), like portal-security.

const STORAGE_STATE = 'e2e/.auth/state.json';
test.use({ storageState: { cookies: [], origins: [] } });

const shift = (n: number) => {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 7);
};
// `prev` follows the seed (the database's now()); `cur` is the month the
// SERVER calls current (Asia/Jerusalem) — the hidden one is the seed's now().
const prev = shift(-1);
const hidden = shift(0);
const py = prev.slice(0, 4);

// The portal skin's tokens, as the browser resolves them.
const RED_SOFT = 'rgb(253, 236, 236)';
const GREEN_SOFT = 'rgb(231, 246, 238)';
const RED = 'rgb(229, 72, 77)';

async function owner(browser: Browser, viewport?: { width: number; height: number }): Promise<BrowserContext> {
  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] }, viewport, hasTouch: !!viewport, isMobile: !!viewport });
  await ctx.addCookies([{ name: 'portal_session', value: 'e2e-owner-a1', domain: 'localhost', path: '/' }]);
  return ctx;
}

const row = (page: Page, name: string) => page.locator('#t-tx .cat-tg', { hasText: name });
const trendCalls = (page: Page) => {
  const urls: string[] = [];
  page.on('request', (r) => { if (/\/api\/portal\/finance\/categories\/[^/]+\/monthly$/.test(r.url())) urls.push(r.url()); });
  return urls;
};

/** Opens the period picker and clicks the whole year (the picker's only gesture). */
async function pickYear(page: Page, year: string) {
  await page.locator('#t-tx .per button[aria-label="תקופה"]').click();
  const panel = page.locator('[role="dialog"][aria-label="בחירת תקופה"]');
  await panel.getByLabel(`בחר את כל ${year}`, { exact: true }).click();
  await expect(panel).toHaveCount(0);
}

test.describe('the category trend of the transactions tab', () => {
  test('an expense row opens on published months only: soft red bars, LTR time, the full amount on hover', async ({ browser }) => {
    const ctx = await owner(browser);
    const page = await ctx.newPage();
    await page.goto(`/portal?tab=tx&m=${prev}`);

    const r = row(page, 'E2E ניקיון');
    await expect(r).toHaveAttribute('aria-expanded', 'false');
    const amount = await r.locator('.a').innerText();
    expect(amount).toContain('₪1,801');

    const [res] = await Promise.all([
      page.waitForResponse((x) => /\/api\/portal\/finance\/categories\/[^/]+\/monthly$/.test(x.url())),
      r.click(),
    ]);
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { months: Array<{ month: string; total: number }> };
    const keys = body.months.map((m) => m.month);
    expect(keys).toContain(prev);
    expect(keys).not.toContain(hidden);
    expect(body.months.find((m) => m.month === prev)?.total).toBe(1801);
    expect(keys.length).toBeLessThanOrEqual(12);
    expect(JSON.stringify(body)).not.toMatch(/CANARY|6543/);

    await expect(r).toHaveAttribute('aria-expanded', 'true');
    const chart = page.locator('#t-tx .cat-trend .trend');
    await expect(chart).toBeVisible();
    await expect(chart).toHaveAttribute('dir', 'ltr');
    // one column per month of the answer — none for the hidden month
    await expect(chart.locator('.tcol')).toHaveCount(keys.length);
    await expect(chart.locator(`.tcol[data-month="${hidden}"]`)).toHaveCount(0);
    // oldest on the left, newest on the right
    const xs = await chart.locator('.tcol').evaluateAll((els) => els.map((e) => [e.getAttribute('data-month'), e.getBoundingClientRect().x] as const));
    expect(xs.map(([m]) => m)).toEqual([...keys].sort());
    for (let i = 1; i < xs.length; i += 1) expect(xs[i]![1]).toBeGreaterThan(xs[i - 1]![1]);

    // the soft tone at rest, the full one when hovered — with the whole amount
    const bar = chart.locator(`.tcol[data-month="${prev}"] .b`);
    expect(await bar.evaluate((el) => getComputedStyle(el).fill)).toBe(RED_SOFT);
    await chart.locator(`.tcol[data-month="${prev}"]`).hover();
    await expect(chart.locator('.tip')).toContainText('₪1,801');
    await expect.poll(() => bar.evaluate((el) => getComputedStyle(el).fill)).toBe(RED);

    // the row still shows the period's total, and closes on a second click
    expect(await r.locator('.a').innerText()).toBe(amount);
    await r.click();
    await expect(r).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#t-tx .cat-trend')).toHaveCount(0);
    await ctx.close();
  });

  test('an income row: soft green bars', async ({ browser }) => {
    const ctx = await owner(browser);
    const page = await ctx.newPage();
    await page.goto(`/portal?tab=tx&m=${prev}`);
    await row(page, 'E2E דמי ועד').click();
    const bar = page.locator(`#t-tx .cat-trend .tcol[data-month="${prev}"] .b`);
    await expect(bar).toHaveCount(1);
    expect(await bar.evaluate((el) => getComputedStyle(el).fill)).toBe(GREEN_SOFT);
    await page.locator(`#t-tx .cat-trend .tcol[data-month="${prev}"]`).hover();
    await expect(page.locator('#t-tx .cat-trend .tip')).toContainText('₪8,821');
    await ctx.close();
  });

  test('the period picker moves the row, not the trend — and a loaded trend is not asked for again', async ({ browser }) => {
    const ctx = await owner(browser);
    const page = await ctx.newPage();
    const calls = trendCalls(page);
    await page.goto(`/portal?tab=tx&m=${prev}`);
    await row(page, 'E2E ניקיון').click();
    const chart = page.locator('#t-tx .cat-trend .trend');
    await expect(chart.locator('.tcol').first()).toBeVisible();
    const before = await chart.locator('.tcol').evaluateAll((els) => els.map((e) => e.getAttribute('data-month')));
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toMatch(/[?&]m=/); // the trend carries no period at all

    await pickYear(page, py);
    await expect(page).toHaveURL(new RegExp(`m=${py}(&|$)`));
    await row(page, 'E2E ניקיון').click();
    await expect(chart.locator('.tcol').first()).toBeVisible();
    expect(await chart.locator('.tcol').evaluateAll((els) => els.map((e) => e.getAttribute('data-month')))).toEqual(before);
    expect(calls).toHaveLength(1);
    await ctx.close();
  });

  test('mobile: the trend fits the card with no sideways scroll, and a tap shows the amount', async ({ browser }) => {
    const ctx = await owner(browser, { width: 375, height: 812 });
    const page = await ctx.newPage();
    await page.goto(`/portal?tab=tx&m=${prev}`);
    const r = row(page, 'E2E ניקיון');
    const box = await r.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    await r.tap();
    const chart = page.locator('#t-tx .cat-trend .trend');
    await expect(chart.locator('.tcol').first()).toBeVisible();
    const card = await page.locator('#t-tx .cat-trend').evaluate((el) => el.closest('.card')!.getBoundingClientRect().width);
    const width = await chart.evaluate((el) => el.getBoundingClientRect().width);
    expect(width).toBeLessThanOrEqual(card);
    await chart.locator(`.tcol[data-month="${prev}"]`).tap();
    await expect(chart.locator('.tip')).toContainText('₪1,801');
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    await ctx.close();
  });

  test('the admin preview opens the row on a note and never calls the portal API', async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: STORAGE_STATE });
    const page = await ctx.newPage();
    const calls = trendCalls(page);
    await page.goto(`/finance?view=resident&apt=E2E-A&tab=tx&m=${prev}`);
    await row(page, 'E2E ניקיון').click();
    await expect(page.locator('#t-tx .cat-trend .trend-msg')).toContainText('בתצוגה המקדימה');
    expect(calls).toEqual([]);
    await ctx.close();
  });
});
