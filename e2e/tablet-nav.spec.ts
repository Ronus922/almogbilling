import { test, expect, type Page } from '@playwright/test';

// The navigation panel on a TABLET (12/11/2026, DESIGN.md §14 "טאבלט"): from 768px up to, not including,
// 1024px the items panel is an OVERLAY above the content instead of a column beside it, closed until a
// category is clicked. Before it the panel opened by default and pushed the content to 460px at 768 —
// the Header (it needs ~636px) lost its user menu and bells off the edge.
//   · 768 / 900 / 1023: only the 72px rail takes room, the content gets the rest, and the Header fits whole
//     (nothing cut, no sideways scroll); no panel until a category is clicked;
//   · a click on a panel category opens the panel OVER the content (the content does not move, the URL does
//     not change, a scrim dims it); an item navigates and closes it; Escape, a click outside and the panel's
//     own close button close it too — Escape hands the focus back to the rail button;
//   · a link category (one permitted item) still navigates straight away, no panel;
//   · the desktop's saved choice (`almog:sidebar-collapsed`) is neither read nor written by any of it;
//   · NOT changed: 1024 and up keep the panel in a column that pushes the content (open by default, saved
//     choice honoured); below 768 the phone drawer is the only navigation.
// Runs as the seeded admin (the project's saved session) — no user is created here.

const STORAGE_KEY = 'almog:sidebar-collapsed';
const TABLET_WIDTHS = [768, 900, 1023];

const rail = (page: Page) => page.locator('aside nav[aria-label="קטגוריות ניווט"]');
const railButton = (page: Page, label: string) => rail(page).locator('[data-nav-category]', { hasText: new RegExp(`^${label}$`) });
const panel = (page: Page) => page.locator('aside [data-nav-panel]');
const scrim = (page: Page) => page.locator('[data-nav-scrim]');
const saved = (page: Page) => page.evaluate((k) => localStorage.getItem(k), STORAGE_KEY);

/** Everything the layout claims, read in the page. */
async function layout(page: Page) {
  return page.evaluate(() => {
    const r = (el: Element | null) => {
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { left: b.left, right: b.right, width: b.width, top: b.top, bottom: b.bottom };
    };
    const header = document.querySelector('header')!;
    const column = header.parentElement!.getBoundingClientRect();
    let minLeft = Infinity;
    let maxRight = -Infinity;
    for (const el of header.querySelectorAll('button, a, input')) {
      const b = el.getBoundingClientRect();
      if (b.width === 0) continue;
      minLeft = Math.min(minLeft, b.left);
      maxRight = Math.max(maxRight, b.right);
    }
    const de = document.documentElement;
    return {
      aside: r(document.querySelector('aside')),
      main: r(document.querySelector('main')),
      headerFits: header.scrollWidth <= header.clientWidth && minLeft >= column.left - 0.5 && maxRight <= column.right + 0.5,
      headerSpan: { minLeft, maxRight, columnLeft: column.left, columnRight: column.right },
      pill: r(document.querySelector('header button[aria-label="חשבון משתמש"]')),
      pageScrollsSideways: de.scrollWidth > de.clientWidth,
    };
  });
}

async function gotoWaitingForHydration(page: Page, url: string) {
  await page.goto(url);
  await expect(railButton(page, 'כספים')).toBeVisible();
  // At tablet width the inline panel is unmounted once the client knows the range — wait for that.
  await expect(panel(page)).toHaveCount(0);
}

for (const width of TABLET_WIDTHS) {
  test.describe(`${width}px`, () => {
    test.beforeEach(async ({ page }) => { await page.setViewportSize({ width, height: 900 }); });

    test('the rail alone takes room, the Header fits whole, and there is no panel until a category is clicked', async ({ page }) => {
      // A page OF a panel category — on desktop this is exactly where the panel would be open.
      await gotoWaitingForHydration(page, '/admin/portal-log');
      const l = await layout(page);
      expect(l.aside!.width).toBeCloseTo(72, 0);
      expect(l.main!.width, 'the content gets everything the rail leaves').toBeCloseTo(width - 72, 0);
      expect(l.headerFits, JSON.stringify(l.headerSpan)).toBe(true);
      expect(l.pill!.left, 'the user menu is on screen').toBeGreaterThanOrEqual(0);
      expect(l.pageScrollsSideways).toBe(false);
      await expect(scrim(page)).toHaveCount(0);
      await expect(railButton(page, 'פורטל')).toHaveAttribute('aria-expanded', 'false');
    });

    test('a category opens the panel OVER the content; an item navigates and closes it', async ({ page }) => {
      await gotoWaitingForHydration(page, '/admin/portal-log');
      const before = await layout(page);

      await railButton(page, 'כספים').click();
      const open = panel(page);
      await expect(open).toBeVisible();
      await expect(open).toHaveAttribute('data-nav-panel', 'finance');
      await expect(railButton(page, 'כספים')).toHaveAttribute('aria-expanded', 'true');
      await expect(scrim(page)).toBeVisible();
      expect(page.url(), 'a category click does not navigate').toContain('/admin/portal-log');

      const after = await layout(page);
      expect(after.main!.left, 'the content does not move').toBeCloseTo(before.main!.left, 0);
      expect(after.main!.width, 'the content does not shrink').toBeCloseTo(before.main!.width, 0);
      expect(after.aside!.width, 'the sidebar is still only the rail').toBeCloseTo(72, 0);
      const p = (await open.boundingBox())!;
      const r = (await rail(page).boundingBox())!;
      expect(p.width).toBeCloseTo(236, 0);
      expect(p.x + p.width, 'it floats right next to the rail').toBeCloseTo(r.x, 0);
      expect(p.x, 'and stays on screen').toBeGreaterThanOrEqual(0);
      expect(after.pageScrollsSideways).toBe(false);

      await open.locator('a[data-nav-item="/statuses"]').click();
      await expect(page).toHaveURL(/\/statuses/);
      await expect(panel(page)).toHaveCount(0);
      await expect(scrim(page)).toHaveCount(0);
    });

    test('Escape closes it and gives the focus back to the rail button', async ({ page }) => {
      await gotoWaitingForHydration(page, '/admin/portal-log');
      await railButton(page, 'כספים').click();
      await expect(panel(page)).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(panel(page)).toHaveCount(0);
      await expect(railButton(page, 'כספים')).toBeFocused();
      await expect(railButton(page, 'כספים')).toHaveAttribute('aria-expanded', 'false');
    });

    test('Tabbing out of the sidebar into the dimmed content closes it', async ({ page }) => {
      await gotoWaitingForHydration(page, '/admin/portal-log');
      await railButton(page, 'כספים').click();
      await expect(panel(page)).toBeVisible();
      // Inside the sidebar (the rail, then the panel) the overlay stays open…
      await page.keyboard.press('Tab');
      await expect(panel(page)).toBeVisible();
      // …and the first Tab that lands outside it closes it.
      for (let i = 0; i < 40 && (await panel(page).count()) > 0; i++) await page.keyboard.press('Tab');
      await expect(panel(page)).toHaveCount(0);
      expect(await page.evaluate(() => !!document.activeElement?.closest('aside')), 'focus is outside the sidebar').toBe(false);
    });

    test('a click outside (the dimmed content) closes it and does not reach what is under it', async ({ page }) => {
      await gotoWaitingForHydration(page, '/admin/portal-log');
      await railButton(page, 'כספים').click();
      await expect(panel(page)).toBeVisible();
      await page.mouse.click(60, 400); // inside the content area, left of the panel
      await expect(panel(page)).toHaveCount(0);
      expect(page.url()).toContain('/admin/portal-log');
    });

    test("the panel's own close button closes it; another category switches it; the same one closes it", async ({ page }) => {
      await gotoWaitingForHydration(page, '/admin/portal-log');
      await railButton(page, 'כספים').click();
      await expect(panel(page)).toHaveAttribute('data-nav-panel', 'finance');
      await railButton(page, 'דיירים').click();
      await expect(panel(page)).toHaveAttribute('data-nav-panel', 'residents');
      await railButton(page, 'דיירים').click();
      await expect(panel(page)).toHaveCount(0);

      await railButton(page, 'כספים').click();
      await panel(page).getByRole('button', { name: 'סגירת תפריט' }).click();
      await expect(panel(page)).toHaveCount(0);
      await expect(railButton(page, 'כספים')).toBeFocused();
    });

    test('a link category (one item) navigates straight away — no panel, nothing saved', async ({ page }) => {
      await gotoWaitingForHydration(page, '/admin/portal-log');
      await railButton(page, 'ראשי').click();
      await expect(page).toHaveURL(/\/overview/);
      await expect(panel(page)).toHaveCount(0);
      expect(await saved(page)).toBeNull();
    });

    test("the desktop's saved choice is neither obeyed nor overwritten", async ({ page }) => {
      for (const choice of ['0', '1']) {
        await page.goto('/admin/portal-log');
        await page.evaluate(([k, v]) => localStorage.setItem(k, v), [STORAGE_KEY, choice]);
        await page.reload();
        await expect(railButton(page, 'כספים')).toBeVisible();
        // "open" saved on the desktop does not open the panel on a tablet…
        await expect(panel(page)).toHaveCount(0);
        // …and using the overlay writes nothing.
        await railButton(page, 'כספים').click();
        await expect(panel(page)).toBeVisible();
        await panel(page).getByRole('button', { name: 'סגירת תפריט' }).click();
        await railButton(page, 'דיירים').click();
        await railButton(page, 'דיירים').click();
        await page.keyboard.press('Escape');
        await railButton(page, 'כספים').click();
        await panel(page).locator('a[data-nav-item="/chips"]').click();
        await expect(page).toHaveURL(/\/chips/);
        expect(await saved(page), `saved choice after using the overlay (was ${choice})`).toBe(choice);
      }
    });
  });
}

test.describe('the Header with a long name', () => {
  test('still fits whole at 768: the name is cut with an ellipsis and the search gives way', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 900 });
    await gotoWaitingForHydration(page, '/admin/portal-log');
    // The name is the `text-ink` span of the pill (the avatar's initial is `text-brand-text`, the role `text-ink-3`).
    const name = page.locator('header button[aria-label="חשבון משתמש"] span.font-extrabold.text-ink');
    await expect(name).toHaveCount(1);
    await name.evaluate((el) => { el.textContent = 'אברהם־יצחק בן־ציון מרדכי הכהן־לוי'; });
    const cut = await name.evaluate((el) => ({ clipped: el.scrollWidth > el.clientWidth, width: el.getBoundingClientRect().width, ellipsis: getComputedStyle(el).textOverflow }));
    expect(cut.clipped, 'a 33-character name does not fit 9rem — it must be cut, not widen the pill').toBe(true);
    expect(cut.ellipsis).toBe('ellipsis');
    expect(cut.width).toBeLessThanOrEqual(9 * 17 + 1);
    const l = await layout(page);
    expect(l.headerFits, JSON.stringify(l.headerSpan)).toBe(true);
  });
});

test.describe('NOT changed', () => {
  test('1024 and up: the panel is a column that pushes the content, open by default, and the saved choice is honoured', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 800 });
    await page.goto('/admin/portal-log');
    const open = panel(page);
    await expect(open).toHaveAttribute('data-state', 'open');
    expect((await open.boundingBox())!.width).toBeCloseTo(236, 0);
    const l = await layout(page);
    expect(l.aside!.width, 'rail 72 + panel 236').toBeCloseTo(308, 0);
    expect(l.main!.width).toBeCloseTo(1024 - 308, 0);
    await expect(scrim(page)).toHaveCount(0);

    // A click on the shown category closes the column and SAVES it — the desktop behaviour, untouched.
    await page.waitForLoadState('networkidle'); // a click before hydration is lost
    await railButton(page, 'פורטל').click();
    await expect(open).toHaveAttribute('data-state', 'closed');
    expect(await saved(page)).toBe('1');
    // …and the column is 0px only when its 220ms width transition has finished.
    await expect.poll(async () => (await layout(page)).main!.width).toBeCloseTo(1024 - 72, 0);
    await page.evaluate((k) => localStorage.removeItem(k), STORAGE_KEY);
  });

  test('below 768: no sidebar, the hamburger opens the drawer', async ({ page }) => {
    await page.setViewportSize({ width: 767, height: 900 });
    await page.goto('/admin/portal-log');
    await page.waitForLoadState('networkidle'); // a click before hydration is lost
    await expect(page.locator('aside')).toBeHidden();
    await page.getByRole('button', { name: 'פתח תפריט' }).click();
    const drawer = page.getByRole('dialog');
    await expect(drawer.locator('nav[aria-label="קטגוריות ניווט"]')).toBeVisible();
    expect((await drawer.boundingBox())!.width, 'rail 72 + panel 236').toBeCloseTo(308, 0);
    expect((await layout(page)).headerFits).toBe(true);
  });
});
