import { test, expect, type Page } from '@playwright/test';
import { Pool } from 'pg';

// /admin/portal-log pages through the WHOLE login log, 50 rows to a page (12/11/2026). Before it the
// screen asked for the newest 200 rows and its counter was that 200 while the table held 398: rows
// past 200 were unreachable and the counter lied. Pinned here with 260 synthetic events (above the old
// cap) that no other data shares — every check filters by their phone prefix:
//   · the counter is the true total, the caption says which rows the page shows ("מציג 51–100 מתוך 260"),
//     and the last page really is the last 10 of the 260 (rows the old screen could not reach);
//   · a filter applies to the whole log (52 locked-out rows → 2 pages, total 52) and a changed filter
//     starts again on page 1; a page past the end lands on the last page;
//   · turning a page keeps the APPLIED filters (the URL's) and leaves a half-typed form alone, and puts the
//     table's scroll back at its top;
//   · RTL: "הקודם" is on the right and page 1 right of page 2; the numbered pages are 44px buttons;
//     on a phone the numbers give way to "עמוד 1 מתוך 6".
//
// Fixtures carry FIXED ids and are removed by exactly those ids (CLAUDE.md iron rule 12).

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
pool.on('error', () => undefined);

const N = 260;
const PHONE_PREFIX = '97254777'; // digits — what the screen's phone filter matches
const LOCKED = N / 5; // every fifth is `locked_out`
const IDS = Array.from({ length: N }, (_, i) => `00000000-0000-4000-8000-00007f${String(i + 1).padStart(6, '0')}`);

test.beforeAll(async () => {
  await pool.query('delete from public.portal_login_events where id = any($1::uuid[])', [IDS]);
  await pool.query(
    `insert into public.portal_login_events (id, phone_e164, apartment_numbers, event_type, ip, user_agent, created_at)
     select t.id, '+${PHONE_PREFIX}' || lpad(t.n::text, 4, '0'), array['990777'],
            case when t.n % 5 = 0 then 'locked_out' else 'login_success' end,
            '10.0.0.' || (t.n % 250), 'Mozilla/5.0 (Linux; Android 14; SM-S918B)',
            now() - (t.n::int * interval '1 minute')
       from unnest($1::uuid[]) with ordinality as t(id, n)`,
    [IDS],
  );
});

test.afterAll(async () => {
  await pool.query('delete from public.portal_login_events where id = any($1::uuid[])', [IDS]);
  await pool.end();
});

const rows = (page: Page) => page.locator('[data-log-scroll] tbody tr');
const caption = (page: Page) => page.locator('[data-pagination-caption]');
const firstCell = (page: Page) => rows(page).first().locator('td').first().innerText();

/** Scrolled to the very end of the page, nothing — the assistant's floating button included — sits on top of an ENABLED
 *  paging control: every corner and the centre of "הקודם" / "הבא" hit the button itself. (The FAB, fixed bottom-left, used to
 *  cover "הבא" at 1440 and 390 until the control got `pb-16`.) */
async function expectControlsReachable(page: Page) {
  await page.locator('main').evaluate((m) => { m.scrollTop = m.scrollHeight; });
  for (const sel of ['[data-page-prev]', '[data-page-next]']) {
    const covered = await page.locator(sel).evaluate((el) => {
      // A disabled button has pointer-events:none — nothing to hit-test (and nothing to click).
      if ((el as HTMLButtonElement).disabled) return 0;
      const r = el.getBoundingClientRect();
      const pts = [
        [r.left + 8, r.top + 8], [r.right - 8, r.top + 8], [r.left + 8, r.bottom - 8], [r.right - 8, r.bottom - 8],
        [r.left + r.width / 2, r.top + r.height / 2],
      ];
      return pts.filter(([x, y]) => { const hit = document.elementFromPoint(x, y); return !(hit && el.contains(hit)); }).length;
    });
    expect(covered, `${sel}: points covered by something else at the end of the page`).toBe(0);
  }
}

/** Click a paging control, then wait until the ROWS are the new page's — the caption and the URL follow the click at
 *  once, the rows only when the fetch lands, so a caption check alone would pass on the old page's rows. */
async function turnTo(page: Page, control: string, n: number) {
  const before = await firstCell(page);
  await page.locator(control).click();
  await expect(page).toHaveURL(new RegExp(`page=${n}(&|$)`));
  await expect.poll(() => firstCell(page), `rows of page ${n}`).not.toBe(before);
}

test('the counter is the true total, beyond the old 200 cap, and pages are 50 rows', async ({ page }) => {
  await page.goto(`/admin/portal-log?phone=${PHONE_PREFIX}`);
  await expect(page.getByText(`${N} אירועים`, { exact: true })).toBeVisible();
  await expect(rows(page)).toHaveCount(50);
  await expect(caption(page)).toHaveText(`מציג 1–50 מתוך ${N}`);
  await expect(page.locator('[data-page-prev]')).toBeDisabled();
  await expect(page.locator('[data-page="1"]')).toHaveAttribute('aria-current', 'page');

  await turnTo(page, '[data-page="2"]', 2);
  await expect(caption(page)).toHaveText(`מציג 51–100 מתוך ${N}`);
  await expect(rows(page)).toHaveCount(50);
  await expect(page.getByText(`${N} אירועים`, { exact: true }), 'the counter does not shrink to the page').toBeVisible();

  // Rows 201–260: the ones the old screen could never show.
  await turnTo(page, '[data-page-next]', 3);
  await turnTo(page, '[data-page-next]', 4);
  await turnTo(page, '[data-page-next]', 5);
  await expect(caption(page)).toHaveText(`מציג 201–250 מתוך ${N}`);
  await turnTo(page, '[data-page-next]', 6);
  await expect(caption(page)).toHaveText(`מציג 251–${N} מתוך ${N}`);
  await expect(rows(page)).toHaveCount(N - 250);
  await expect(page.locator('[data-page-next]')).toBeDisabled();
});

test('a filter applies to the whole log and a changed filter starts on page 1', async ({ page }) => {
  await page.goto(`/admin/portal-log?phone=${PHONE_PREFIX}&page=3`);
  await expect(caption(page)).toHaveText(`מציג 101–150 מתוך ${N}`);

  await page.locator('#pl-event').click();
  await page.getByRole('option', { name: 'נחסם' }).click();
  await page.getByRole('button', { name: 'סנן' }).click();

  await expect(page).toHaveURL(/event_type=locked_out/);
  expect(page.url(), 'a new filter drops the page').not.toContain('page=');
  await expect(page.getByText(`${LOCKED} אירועים`, { exact: true })).toBeVisible();
  await expect(caption(page)).toHaveText(`מציג 1–50 מתוך ${LOCKED}`);
  await expect(rows(page)).toHaveCount(50);
  await page.locator('[data-page-next]').click();
  await expect(caption(page)).toHaveText(`מציג 51–${LOCKED} מתוך ${LOCKED}`);
  await expect(rows(page)).toHaveCount(LOCKED - 50);
});

test('a page past the end lands on the last page', async ({ page }) => {
  await page.goto(`/admin/portal-log?phone=${PHONE_PREFIX}&page=99`);
  await expect(caption(page)).toHaveText(`מציג 251–${N} מתוך ${N}`);
  await expect(page).toHaveURL(/page=6/);
});

test('turning a page keeps the applied filters, leaves the half-typed form alone, and scrolls the table to its top', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/admin/portal-log?phone=${PHONE_PREFIX}`);
  await expect(rows(page)).toHaveCount(50);

  await page.locator('#pl-apt').fill('zzz-not-applied');
  const box = page.locator('[data-log-scroll]');
  await box.evaluate((el) => { el.scrollTop = 600; });
  expect(await box.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);

  await turnTo(page, '[data-page="2"]', 2);
  await expect(caption(page)).toHaveText(`מציג 51–100 מתוך ${N}`);
  const url = new URL(page.url());
  expect(url.searchParams.get('phone')).toBe(PHONE_PREFIX);
  expect(url.searchParams.get('page')).toBe('2');
  expect(url.searchParams.has('apartment'), 'the half-typed field was never applied').toBe(false);
  await expect(page.locator('#pl-apt')).toHaveValue('zzz-not-applied');
  await expect.poll(() => box.evaluate((el) => el.scrollTop), 'the table is back at its top').toBe(0);
});

test('RTL: previous on the right, page 1 right of page 2, 44px controls', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/admin/portal-log?phone=${PHONE_PREFIX}`);
  await expect(page.locator('[data-page]')).toHaveCount(6);
  const x = async (sel: string) => (await page.locator(sel).boundingBox())!.x;
  expect(await x('[data-page-prev]')).toBeGreaterThan(await x('[data-page="1"]'));
  expect(await x('[data-page="1"]')).toBeGreaterThan(await x('[data-page="2"]'));
  expect(await x('[data-page="6"]')).toBeGreaterThan(await x('[data-page-next]'));
  for (const sel of ['[data-page-prev]', '[data-page-next]', '[data-page="1"]', '[data-page="6"]']) {
    const b = (await page.locator(sel).boundingBox())!;
    expect(b.height, sel).toBeGreaterThanOrEqual(44);
    expect(b.width, sel).toBeGreaterThanOrEqual(44);
  }
  // Caption and controls share a row on a wide card.
  const cap = (await caption(page).boundingBox())!;
  const prev = (await page.locator('[data-page-prev]').boundingBox())!;
  expect(Math.abs(cap.y + cap.height / 2 - (prev.y + prev.height / 2))).toBeLessThan(20);
  await expectControlsReachable(page);
});

test('phone: previous · "עמוד 1 מתוך 6" · next, 44px, no sideways page scroll', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/admin/portal-log?phone=${PHONE_PREFIX}`);
  await expect(page.locator('[data-pagination-position]')).toHaveText('עמוד 1 מתוך 6');
  await expect(page.locator('[data-page]').first()).toBeHidden();
  await expect(caption(page)).toHaveText(`מציג 1–50 מתוך ${N}`);
  for (const sel of ['[data-page-prev]', '[data-page-next]']) {
    expect((await page.locator(sel).boundingBox())!.height, sel).toBeGreaterThanOrEqual(44);
  }
  await page.locator('[data-page-next]').click();
  await expect(page.locator('[data-pagination-position]')).toHaveText('עמוד 2 מתוך 6');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await expectControlsReachable(page);
});
