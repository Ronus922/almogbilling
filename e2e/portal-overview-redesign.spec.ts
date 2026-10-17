import { randomUUID } from 'node:crypto';
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

  // 17/10/2026 ("כותרת הפורטל — ברכה בלבד"): the header used to grow a second
  // line — the full name + every apartment/role the phone holds — which for
  // anyone with many apartments pushed the building name and the tab row off
  // the visible header (the bug this change fixes). The greeting is now one
  // line, independent of apartment count; the only thing left that can still
  // be long is the name itself, so this pins THAT invariant instead, on
  // db/seed/e2e.sql's deliberately long-named fixture.
  test('a very long single name stays one line (ellipsis) and never pushes the building name or tabs off-screen', async ({ browser }) => {
    const ctx = await owner(browser, 'e2e-owner-longname');
    const page = await ctx.newPage();
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto('/portal?tab=ov');
    const nm = page.locator('.me .nm');
    const nmBox = await nm.boundingBox();
    expect(nmBox, 'no box').not.toBeNull();
    // one line, not wrapped to two: the box stays within a single line's height
    expect(nmBox!.height).toBeLessThan(24);
    // ellipsis, not an overflowing box wider than its own CSS max-width
    const maxWidth = await nm.evaluate((el) => parseFloat(getComputedStyle(el).maxWidth));
    expect(nmBox!.width).toBeLessThanOrEqual(maxWidth + 1);
    // the neighbours the old sub-line used to push out stay fully visible
    await expect(page.locator('.bld b')).toBeVisible();
    await expect(page.locator('.nav button', { hasText: 'סקירה' })).toBeVisible();
    const meBox = await page.locator('.me').boundingBox();
    expect(meBox!.x + meBox!.width).toBeLessThanOrEqual(1366);
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
    // Round 4 (14/10/2026): Phase 0 found "חזרה לדף הבית" had no clearance at
    // all above the dock that DOES mount here — it landed flush at the
    // viewport bottom, directly behind the floating pill. The invariant: the
    // button's own box sits entirely above the dock's top edge, with the
    // required ≥12px of daylight between them, and is still actually clickable
    // (not just visually above — Playwright's own actionability check already
    // covers "nothing else receives the click" for a plain .click()).
    const button = page.getByRole('link', { name: 'חזרה לדף הבית' });
    await expect(button).toBeVisible();
    const buttonBox = (await button.boundingBox())!;
    const dockBox = (await page.locator('.dock').boundingBox())!;
    expect(buttonBox.y + buttonBox.height, 'button bottom edge').toBeLessThanOrEqual(dockBox.y);
    expect(dockBox.y - (buttonBox.y + buttonBox.height), 'clearance above the dock').toBeGreaterThanOrEqual(12);
    await button.click();
    await expect(page).toHaveURL(/\/portal(\?|$)/);
    await ctx.close();
  });
});

test.describe('overview chart & KPIs — entrance gated on scroll into view (round 4, 14/10/2026)', () => {
  test('both stay at their "before" state until the card actually scrolls on screen, then animate once', async ({ browser }) => {
    const ctx = await owner(browser, 'e2e-owner-a1', { width: 390, height: 844 });
    const page = await ctx.newPage();
    await page.goto('/portal?tab=ov');

    // Phase 0 (round 4): on a phone this short, the chart card (not the KPI
    // row above it, which already fits) starts below the fold — exactly the
    // condition a mount-triggered animation (the bug) would have already
    // finished under, unseen. `ratio: 0.25` matches `useArmOnView`'s own
    // threshold exactly — the chart card already peeks in at the very bottom
    // of a 390×844 screen (a sliver under 25%), so a plain "any visibility
    // counts" check would be too fragile here. The trend view's dots (`r`,
    // 0 → 3.5) are the gated element that is actually absent before `go` —
    // the line's own points render at their final position regardless (only
    // the dash-sweep reveal is cosmetic), so the dot radius, not the line, is
    // the reliable "undrawn vs. drawn" signal.
    const chart = page.locator('.ovch');
    await expect(chart).not.toBeInViewport({ ratio: 0.25 });
    await expect(chart.locator('circle').first()).toHaveAttribute('r', '0');

    await chart.scrollIntoViewIfNeeded();
    await expect(chart).toBeInViewport({ ratio: 0.25 });

    // Settled: real figures (same ones round 3's KPI test asserts), dots popped in.
    await expect(page.locator('#t-ov .kpi .v.in')).toHaveText('₪8,821', { timeout: 2000 });
    await expect(page.locator('#t-ov .kpi .v.out')).toHaveText('₪1,801');
    await expect(chart.locator('circle').first()).toHaveAttribute('r', '3.5');
    await ctx.close();
  });

  test('switching view/period replays the entrance (unchanged from round 3 — remount, not a re-arm)', async ({ browser }) => {
    const ctx = await owner(browser, 'e2e-owner-a1');
    const page = await ctx.newPage();
    await page.goto('/portal?tab=ov');
    const chart = page.locator('.ovch');
    await expect(chart).toBeInViewport(); // desktop default viewport: already on screen
    await expect
      .poll(async () => Number(await chart.locator('polyline').first().evaluate((el) => (el as SVGPolylineElement).style.strokeDashoffset)))
      .toBe(0);

    await page.locator('.seg button', { hasText: 'עמודות' }).click();
    const bar = chart.locator('rect[rx="4"]').first();
    // A fresh mount (key={view}-{span}) means the bar starts from height 0
    // again and transitions back up — same armed container, no re-arm needed.
    const h0 = await bar.evaluate((el) => Number((el as SVGRectElement).getAttribute('height')));
    await page.waitForTimeout(100);
    const h1 = await bar.evaluate((el) => Number((el as SVGRectElement).getAttribute('height')));
    expect(h1).toBeGreaterThanOrEqual(h0);
    await ctx.close();
  });
});

test.describe('document card lists — 12px gap, last row clear of the dock (round 4, 14/10/2026)', () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  pool.on('error', () => undefined);
  const uniq = `e2e-round4-${Date.now()}`;
  const ids: string[] = [];

  test.afterAll(async () => {
    for (const id of ids) await pool.query(`delete from public.portal_decisions where id = $1`, [id]);
    await pool.end();
  });

  test('consecutive rows sit 12px apart and the last one clears the floating dock', async ({ browser }) => {
    // Phase 0 found `.drow + .drow` was dead CSS (each row lived in its own
    // untracked wrapper div, never an actual sibling of another `.drow`) — so
    // rows in the SAME year were flush against each other. Six rows across
    // two years exercises both: the gap between ordinary rows, and the one
    // before a year separator.
    for (let i = 0; i < 6; i++) {
      const { rows } = await pool.query<{ id: string }>(
        `insert into public.portal_decisions
           (title, doc_type, decided_at, object_key, original_filename, file_size, mime_type, published)
         values ($1, 'decision', $2, $3, 'בדיקה.pdf', 4096, 'application/pdf', true)
         returning id`,
        [`${uniq}-${i}`, i < 3 ? '2026-10-05' : '2025-06-01', `${randomUUID()}.pdf`],
      );
      ids.push(rows[0].id);
    }

    const ctx = await owner(browser, 'e2e-owner-a1', { width: 390, height: 844 });
    const page = await ctx.newPage();
    await page.goto('/portal?tab=dec');
    const rows = page.locator('.drow', { hasText: uniq });
    await expect(rows).toHaveCount(6);

    // The gap WITHIN a year (no `.yr` between two rows): 12px, from the
    // list's own `gap`, not a per-row margin.
    const [box0, box1] = await Promise.all([rows.nth(0).boundingBox(), rows.nth(1).boundingBox()]);
    const gap = box1!.y - (box0!.y + box0!.height);
    expect(gap, 'gap between consecutive document rows').toBeGreaterThanOrEqual(11);
    expect(gap, 'gap between consecutive document rows').toBeLessThanOrEqual(13);

    // The last row, scrolled all the way to the bottom of the page, is not
    // covered by the dock — `.wrap`'s padding-bottom (dock height + 16px) at
    // work. Scrolled to the literal end (not just "into view somewhere"),
    // matching what the dock would actually threaten to cover.
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(50);
    const last = rows.last();
    const lastBox = (await last.boundingBox())!;
    const dockBox = (await page.locator('.dock').boundingBox())!;
    expect(lastBox.y + lastBox.height, 'last row bottom edge').toBeLessThanOrEqual(dockBox.y);
    await ctx.close();
  });
});
