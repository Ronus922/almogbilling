import { test, expect, type Browser, type BrowserContext } from '@playwright/test';
import { Pool } from 'pg';

// Round 3 (14/10/2026) — the overview redesign (ref/almog-portal-overview),
// the header's sliding pill + scroll-aware shrink (and the round-2 bug that
// drove it: "דיווח על תקלה" pushed out of the visible header on a desktop
// narrower than the 1280px DESIGN.md had measured), and the report form's
// dock removal. Portal cookies only (no admin session), like portal-security.

test.use({ storageState: { cookies: [], origins: [] } });

async function owner(browser: Browser, token: string, viewport?: { width: number; height: number }): Promise<BrowserContext> {
  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] }, viewport, hasTouch: !!viewport, isMobile: !!viewport });
  await ctx.addCookies([{ name: 'portal_session', value: token, domain: 'localhost', path: '/' }]);
  return ctx;
}

test.describe('header — sliding pill, scroll-aware, "דיווח על תקלה" never pushed off-screen', () => {
  test('the report button and the user block stay inside the viewport at every width above 600px', async ({ browser }) => {
    const ctx = await owner(browser, 'e2e-owner-a1');
    const page = await ctx.newPage();
    // 601 (the dock boundary itself) through 1440 — including 1280, the exact
    // width DESIGN.md measured BEFORE `.top-report` existed (round 2's bug:
    // a width that used to fit no longer did once the button was added).
    for (const width of [601, 760, 900, 1024, 1181, 1280, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/portal?tab=ov');
      const report = page.locator('.top-report');
      await expect(report, `width ${width}`).toBeVisible();
      const box = await report.boundingBox();
      expect(box, `width ${width}: no box`).not.toBeNull();
      expect(box!.x, `width ${width}: left edge`).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width, `width ${width}: right edge`).toBeLessThanOrEqual(width);
      // the user block (avatar) must fit too — it sits after .top-report
      const me = page.locator('.me');
      const meBox = await me.boundingBox();
      expect(meBox, `width ${width}: .me no box`).not.toBeNull();
      expect(meBox!.x + meBox!.width, `width ${width}: .me right edge`).toBeLessThanOrEqual(width);
    }
    await ctx.close();
  });

  test('the tab row scrolls within itself instead of wrapping (no second row, no page-level horizontal scroll)', async ({ browser }) => {
    const ctx = await owner(browser, 'e2e-owner-a1');
    const page = await ctx.newPage();
    await page.setViewportSize({ width: 760, height: 900 });
    await page.goto('/portal?tab=ov');
    // one row: the nav and the building block overlap vertically (align-items:
    // center on .top-in can still centre boxes of a slightly different
    // height a couple of px apart — the real invariant is "same row", not
    // "identical pixel").
    const navBox = await page.locator('.nav').boundingBox();
    const bldBox = await page.locator('.bld').boundingBox();
    expect(Math.abs(navBox!.y - bldBox!.y)).toBeLessThan(10);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await ctx.close();
  });

  test('scrolling past 40px shrinks the header, moves the pill, and keeps the report button visible', async ({ browser }) => {
    const ctx = await owner(browser, 'e2e-owner-a1');
    const page = await ctx.newPage();
    await page.setViewportSize({ width: 1280, height: 700 });
    await page.goto('/portal?tab=ov');
    await expect(page.locator('.top')).not.toHaveClass(/shrink/);
    const before = await page.locator('.top-in').boundingBox();
    await page.evaluate(() => window.scrollTo(0, 300));
    await expect(page.locator('.top')).toHaveClass(/shrink/);
    await page.waitForTimeout(300); // the 250ms shrink transition + the 260ms pill reposition
    const after = await page.locator('.top-in').boundingBox();
    expect(after!.height, 'the header actually got shorter').toBeLessThan(before!.height);
    await expect(page.locator('.top-report')).toBeVisible();
    // the pill sits under the active tab ("סקירה"), not at a stale (0,0) —
    // give its own 350ms left/width transition (PortalShell's movePill()
    // reschedules at +260ms, then the pill itself still has to glide there)
    // room to settle before comparing.
    await page.waitForTimeout(450);
    const pill = await page.locator('.nav .pill').boundingBox();
    const onTab = await page.locator('.nav button.on').boundingBox();
    expect(Math.abs(pill!.x - onTab!.x)).toBeLessThan(2);
    expect(Math.abs(pill!.width - onTab!.width)).toBeLessThan(2);
    await ctx.close();
  });

  test('a tap-capable (hover:none) tablet width still shows the report button', async ({ browser }) => {
    const ctx = await owner(browser, 'e2e-owner-a1', { width: 900, height: 900 });
    const page = await ctx.newPage();
    await page.goto('/portal?tab=ov');
    await expect(page.locator('.top-report')).toBeVisible();
    await ctx.close();
  });
});

test.describe('overview chart — three views, touch tooltip, no `:hover` dependency', () => {
  test('the segmented control switches views and each one renders real month groups', async ({ browser }) => {
    const ctx = await owner(browser, 'e2e-owner-a1');
    const page = await ctx.newPage();
    await page.goto('/portal?tab=ov');
    const chart = page.locator('.ovch');
    await expect(chart.locator('.grp')).not.toHaveCount(0);
    // default view: "מגמה"
    await expect(page.locator('.seg button', { hasText: 'מגמה' })).toHaveClass(/\bon\b/);

    await page.locator('.seg button', { hasText: 'עמודות' }).click();
    await expect(page.locator('.seg button', { hasText: 'עמודות' })).toHaveClass(/\bon\b/);
    await expect(chart.locator('rect[rx="4"]')).not.toHaveCount(0);

    await page.locator('.seg button', { hasText: 'מאזן חודשי' }).click();
    await expect(page.locator('.seg button', { hasText: 'מאזן חודשי' })).toHaveClass(/\bon\b/);
    await expect(page.locator('.legend', { hasText: 'עודף חודשי' })).toBeVisible();
    await ctx.close();
  });

  test('tapping a month opens the tooltip on a touch context (no mouse hover involved)', async ({ browser }) => {
    const ctx = await owner(browser, 'e2e-owner-a1', { width: 390, height: 844 });
    const page = await ctx.newPage();
    await page.goto('/portal?tab=ov');
    const latest = page.locator('.ovch .grp').last();
    await latest.tap();
    const tip = page.locator('.tip.on');
    await expect(tip).toBeVisible();
    await expect(tip).toContainText('הכנסות');
    await expect(tip).toContainText('הוצאות');
    await expect(tip).toContainText('מאזן');
    // tapping the same month again closes it (toggle)
    await latest.tap();
    await expect(page.locator('.tip.on')).toHaveCount(0);
    await ctx.close();
  });

  test('the KPIs count up to the real figures (no animation leaves them short)', async ({ browser }) => {
    const ctx = await owner(browser, 'e2e-owner-a1');
    const page = await ctx.newPage();
    await page.goto('/portal?tab=ov');
    // Against db/seed/e2e.sql (published month): income 8,820.40 + 1, expense 1,800.50.
    await expect(page.locator('#t-ov .kpi .v.in')).toHaveText('₪8,821');
    await expect(page.locator('#t-ov .kpi .v.out')).toHaveText('₪1,801');
    await ctx.close();
  });
});

test.describe('"לאן הולך הכסף" — scroll-triggered entrance', () => {
  test('the category row animates in and lands on its real amount and share', async ({ browser }) => {
    const ctx = await owner(browser, 'e2e-owner-a1');
    const page = await ctx.newPage();
    await page.goto('/portal?tab=ov');
    const row = page.locator('.ovcats .cat').first();
    await row.scrollIntoViewIfNeeded();
    await expect(row).toHaveClass(/\bgo\b/);
    await expect(row.locator('.a')).toHaveText('₪1,801100%');
    const barWidth = await row.locator('.bar b').evaluate((el) => (el as HTMLElement).style.width);
    expect(barWidth).toBe('100%');
    await ctx.close();
  });
});

test.describe('"דיווח על תקלה" (/portal/report) — the dock on the form vs. the confirmation', () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  pool.on('error', () => undefined);
  const created: string[] = [];

  test.afterAll(async () => {
    for (const id of created) await pool.query(`delete from public.issues where id = $1`, [id]);
    await pool.end();
  });

  test('no dock on the form (it used to cover the image area); a labelled back link; the dock returns on the receipt', async ({ browser }) => {
    const ctx = await owner(browser, 'e2e-owner-a2', { width: 390, height: 844 });
    const page = await ctx.newPage();
    await page.goto('/portal/report');

    await expect(page.locator('.dock-wrap')).toHaveCount(0);
    const back = page.getByRole('link', { name: 'חזרה' });
    await expect(back).toBeVisible();
    await expect(back).toHaveAttribute('href', '/portal');
    // the submit footer sits flush at the bottom — no leftover gap for a dock
    // that is no longer there.
    const footBottom = await page.locator('.pir-foot').evaluate((el) => getComputedStyle(el).bottom);
    expect(footBottom).toBe('0px');

    await page.locator('#pir-location').fill('לובי');
    await page.locator('#pir-description').fill('E2E round-3: בדיקת הדוק בטופס מול מסך הקבלה');
    const [res] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith('/api/portal/issues') && r.request().method() === 'POST'),
      page.getByRole('button', { name: 'שליחת הדיווח' }).click(),
    ]);
    expect(res.status()).toBe(201);
    const ticketText = (await page.locator('.pir-tk dd').first().textContent()) ?? '';
    const row = await pool.query(`select id from public.issues where ticket_number = $1`, [Number(ticketText.replace('#', ''))]);
    created.push(row.rows[0].id);

    await expect(page.getByRole('heading', { name: 'הדיווח התקבל' })).toBeVisible();
    await expect(page.locator('.dock-wrap')).toHaveCount(1);
    await ctx.close();
  });
});
