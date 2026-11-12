import { test, expect, type Page } from '@playwright/test';
import { Pool } from 'pg';

// Table display invariants of three screens — התחברויות לפורטל (/admin/portal-log), ניהול חיובים
// (/dashboard) and רכש (/purchasing) — at the widths a laptop and a tablet give them (1440 → 768).
//
// The navigation panel is open by default, so at 1280 the content is ~920px and at 768 it is ~460px: every
// table is wider than its card somewhere in this range. What must hold at EVERY width:
//   - the PAGE never scrolls sideways (only the table does, inside its card);
//   - exactly ONE horizontal scroll box sits between the table and <main> (a second one — ui/Table's own
//     wrapper under the card — was the old "no scrollbar" bug: its bar sat under all the rows);
//   - the card sits inside the content area, and (portal log + debtors) is capped at 70% of the viewport,
//     so its horizontal scrollbar is on screen instead of under 50–200 rows;
//   - the header row stays put while the rows scroll;
//   - the filters / tabs wrap by the CARD's width (container queries): nothing is cut or overlapped at 768–1024.
// No pixel values are asserted except relative ones (the viewport the test itself chose).
//
// Fixtures are inserted with FIXED ids (…7e00xx) and removed by exactly those ids (CLAUDE.md iron rule 12):
// a crashed run leaves nothing a later run cannot clean, and nothing here is ever matched by a filter.

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
pool.on('error', () => undefined);

const ids = (prefix: string, n: number) =>
  Array.from({ length: n }, (_, i) => `00000000-0000-4000-8000-0000007e${prefix}${String(i + 1).padStart(2, '0')}`);
const EVENT_IDS = ids('00', 60);
const DEBTOR_IDS = ids('01', 40);
const DOC_IDS = ids('02', 2); // [0] = request, [1] = order

async function removeFixtures() {
  await pool.query('delete from public.portal_login_events where id = any($1::uuid[])', [EVENT_IDS]);
  await pool.query('delete from public.debtors where id = any($1::uuid[])', [DEBTOR_IDS]);
  await pool.query('delete from public.purchasing_documents where id = any($1::uuid[])', [DOC_IDS]);
}

test.beforeAll(async () => {
  await removeFixtures();
  await pool.query(
    `insert into public.portal_login_events (id, phone_e164, apartment_numbers, event_type, ip, user_agent)
     select t.id, '+9725400' || lpad(t.n::text, 5, '0'),
            array['990001','990002','990003','990004','990005'], 'login_success',
            '2a02:0ed0:abcd:1234:5678:90ab:cdef:' || to_hex(4096 + t.n::int),
            'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36'
       from unnest($1::uuid[]) with ordinality as t(id, n)`,
    [EVENT_IDS],
  );
  await pool.query(
    `insert into public.debtors (id, apartment_number, owner_name, phone_owner, total_debt, management_fees, hot_water_debt)
     select t.id, (990000 + t.n)::text, 'חברת ניהול נכסים והשקעות אלמוג-חיפה בע״מ ' || t.n,
            '0540000' || lpad(t.n::text, 3, '0'), 1000 + t.n, 300, 50
       from unnest($1::uuid[]) with ordinality as t(id, n)`,
    [DEBTOR_IDS],
  );
  await pool.query(
    `insert into public.purchasing_documents (id, doc_type, number, doc_date, title, supplier_name, notes, due_date, vat_rate, status)
     values ($1, 'rfq', 7900001, current_date, 'בקשה להצעת מחיר לשיפוץ לובי הכניסה הראשי כולל ריצוף חדש ותאורה מלאה', null, '', current_date + 10, 18, 'issued'),
            ($2, 'po',  7900002, current_date, 'הזמנת רכש: החלפת משאבות מים חמים ושירות שנתי', 'חברת אינסטלציה ואחזקת מבנים מתקדמת בע״מ', '', null, 18, 'issued')`,
    [DOC_IDS[0], DOC_IDS[1]],
  );
});

test.afterAll(async () => {
  await removeFixtures();
  await pool.end();
});

const SIZES = [
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
  { width: 1024, height: 768 },
  { width: 768, height: 1024 },
];

interface Geometry {
  bodyOverflow: boolean;
  xScrollers: number;
  wrapper: { left: number; right: number; top: number; bottom: number; clientWidth: number; scrollWidth: number };
  main: { left: number; right: number };
  innerHeight: number;
  headerSticky: string | null;
}

/** Everything the invariants need, read in the page: `wrapperSel` is the card's scroll box. */
async function geometry(page: Page, wrapperSel: string): Promise<Geometry> {
  return page.evaluate((sel) => {
    const wrap = document.querySelector<HTMLElement>(sel)!;
    const table = wrap.querySelector('table')!;
    const main = document.querySelector('main')!;
    const de = document.documentElement;
    let xScrollers = 0;
    for (let el: HTMLElement | null = table.parentElement; el && el !== main; el = el.parentElement) {
      if (['auto', 'scroll'].includes(getComputedStyle(el).overflowX)) xScrollers += 1;
    }
    const r = wrap.getBoundingClientRect();
    const mr = main.getBoundingClientRect();
    const th = table.querySelector('thead th');
    return {
      bodyOverflow: de.scrollWidth > de.clientWidth,
      xScrollers,
      wrapper: { left: r.left, right: r.right, top: r.top, bottom: r.bottom, clientWidth: wrap.clientWidth, scrollWidth: wrap.scrollWidth },
      main: { left: mr.left, right: mr.left + main.clientWidth },
      innerHeight: window.innerHeight,
      headerSticky: th ? getComputedStyle(th).position : null,
    };
  }, wrapperSel);
}

/** The card is inside the content area, nothing scrolls the page sideways, and ONE box scrolls the table. */
function expectContained(g: Geometry) {
  expect(g.bodyOverflow, 'the page must not scroll sideways').toBe(false);
  expect(g.xScrollers, 'exactly one horizontal scroll box between the table and <main>').toBe(1);
  expect(g.wrapper.left).toBeGreaterThanOrEqual(g.main.left - 1);
  expect(g.wrapper.right).toBeLessThanOrEqual(g.main.right + 1);
}

/** Scrolls <main> so the card's top sits 80px down (just under the header) and says whether its bottom edge is on screen. */
async function bottomEdgeOnScreen(page: Page, wrapperSel: string): Promise<boolean> {
  return page.evaluate((sel) => {
    const wrap = document.querySelector<HTMLElement>(sel)!;
    const main = document.querySelector('main')!;
    main.scrollTop += wrap.getBoundingClientRect().top - 80;
    return wrap.getBoundingClientRect().bottom <= window.innerHeight;
  }, wrapperSel);
}

/** Scrolls the card's own vertical scroll and checks the header row did not move relative to the card. */
async function expectStickyHeader(page: Page, wrapperSel: string) {
  const wrap = page.locator(wrapperSel);
  const head = wrap.locator('thead th').first();
  await wrap.scrollIntoViewIfNeeded();
  const before = await head.boundingBox();
  const wrapBox = await wrap.boundingBox();
  await wrap.evaluate((el) => { el.scrollTop = 300; });
  const after = await head.boundingBox();
  expect(await wrap.evaluate((el) => el.scrollTop), 'the box has to be tall enough to scroll').toBeGreaterThan(0);
  expect(after!.y).toBeCloseTo(before!.y, 0);
  expect(after!.y).toBeGreaterThanOrEqual(wrapBox!.y - 1);
}

for (const size of SIZES) {
  test.describe(`${size.width}px`, () => {
    test.beforeEach(async ({ page }) => { await page.setViewportSize(size); });

    test('portal log: one scroll box, capped height, sticky header, long values cut with a title', async ({ page }) => {
      await page.goto('/admin/portal-log');
      await expect(page.locator('[data-log-scroll] tbody tr').first()).toBeVisible();
      const g = await geometry(page, '[data-log-scroll]');
      expectContained(g);
      // The scroll box is capped at 70% of the viewport…
      expect(g.wrapper.bottom - g.wrapper.top).toBeLessThanOrEqual(g.innerHeight * 0.7 + 1);
      // …so with its top just under the 64px header its bottom edge — where the horizontal scrollbar
      // lives — is on screen (it used to sit under all the rows, thousands of pixels down).
      expect(await bottomEdgeOnScreen(page, '[data-log-scroll]')).toBe(true);
      expect(g.headerSticky).toBe('sticky');
      await expectStickyHeader(page, '[data-log-scroll]');
      // The apartments cell holds five numbers: it is cut, and the whole value is in `title`.
      const clipped = page.locator('[data-log-scroll] tbody tr').first().locator('span[title*="990001"]');
      await expect(clipped).toHaveAttribute('title', /990001, 990002, 990003, 990004, 990005/);
      await expect(clipped).toHaveCSS('text-overflow', 'ellipsis');
    });

    test('portal log: the five filters wrap by the card width — none is cut or overlapped', async ({ page }) => {
      await page.goto('/admin/portal-log');
      const form = page.locator('form').first();
      await expect(form).toBeVisible();
      const formBox = (await form.boundingBox())!;
      const fields = form.locator('.grid > div');
      expect(await fields.count()).toBe(5);
      const boxes = [];
      for (let i = 0; i < 5; i++) boxes.push((await fields.nth(i).boundingBox())!);
      for (const b of boxes) {
        expect(b.x).toBeGreaterThanOrEqual(formBox.x - 1);
        expect(b.x + b.width).toBeLessThanOrEqual(formBox.x + formBox.width + 1);
        expect(b.width, 'a filter narrower than this cuts the date mask or hides the icon').toBeGreaterThanOrEqual(130);
      }
      for (let i = 0; i < 5; i++) {
        for (let j = i + 1; j < 5; j++) {
          const a = boxes[i], b = boxes[j];
          const overlap = a.x < b.x + b.width - 1 && b.x < a.x + a.width - 1 && a.y < b.y + b.height - 1 && b.y < a.y + a.height - 1;
          expect(overlap, `filters ${i} and ${j} overlap`).toBe(false);
        }
      }
    });

    test('debtors: one scroll box, capped height, sticky header, actions reachable, tabs not clipped', async ({ page }) => {
      await page.goto('/dashboard');
      const wrapSel = '[data-debtors-scroll]';
      await expect(page.locator(`${wrapSel} tbody tr`).first()).toBeVisible();
      const g = await geometry(page, wrapSel);
      expectContained(g);
      expect(g.wrapper.bottom - g.wrapper.top).toBeLessThanOrEqual(g.innerHeight * 0.7 + 1);
      expect(await bottomEdgeOnScreen(page, wrapSel)).toBe(true);
      expect(g.headerSticky).toBe('sticky');
      await expectStickyHeader(page, wrapSel);
      // The last column ("פעולות", WhatsApp included) is reachable. In a box wide enough to scroll the
      // rest under it (≥640px) it is pinned to the left edge — visible with NO sideways scrolling at all,
      // header and a body row alike; in a narrower box it scrolls like any column.
      const wrap = page.locator(wrapSel);
      const wb = (await wrap.boundingBox())!;
      const pinned = wb.width >= 640;
      if (pinned) {
        await wrap.evaluate((el) => { el.scrollLeft = 0; });
        for (const cell of [wrap.locator('thead th').last(), wrap.locator('tbody tr').first().locator('td').last()]) {
          const cb = (await cell.boundingBox())!;
          expect(cb.x).toBeGreaterThanOrEqual(wb.x - 1);
          expect(cb.x + cb.width).toBeLessThanOrEqual(wb.x + wb.width + 1);
        }
      }
      await wrap.evaluate((el) => { el.scrollLeft = -el.scrollWidth; });
      const last = wrap.locator('thead th').last();
      const lb = (await last.boundingBox())!;
      expect(lb.x).toBeGreaterThanOrEqual(wb.x - 1);
      expect(lb.x + lb.width).toBeLessThanOrEqual(wb.x + wb.width + 1);
      // The six status tabs: no label is wider than its button (the 1024 overlap of badge and label).
      for (const label of ['חייבים', 'מכתבי התראה', 'לטיפול משפטי', 'הליך משפטי', 'פעולות', 'ארכיון']) {
        const tab = page.locator('main button', { hasText: label }).filter({ has: page.locator('svg') }).first();
        const [client, scroll] = await tab.evaluate((el) => [el.clientWidth, el.scrollWidth]);
        expect(scroll, `tab "${label}" is clipped`).toBeLessThanOrEqual(client + 1);
      }
    });

    test('purchasing: both tables fit their card (no sideways overflow at the 900/820 floors), the search keeps its width', async ({ page }) => {
      await page.goto('/purchasing');
      const wrapSel = '[data-table-scroll]';
      await expect(page.locator('table[data-list="rfq"] tbody tr').first()).toBeVisible();
      const rfq = await geometry(page, wrapSel);
      expectContained(rfq);
      if (size.width >= 1280) {
        // 1280 with the panel open leaves the card ~918px: the old 920px floor overflowed it by a pixel.
        expect(rfq.wrapper.scrollWidth).toBeLessThanOrEqual(rfq.wrapper.clientWidth);
      }
      const search = (await page.locator('[data-filter-search]').boundingBox())!;
      expect(search.width, 'the search field was squeezed to ~120px at tablet widths').toBeGreaterThanOrEqual(200);

      await page.getByRole('tab', { name: /הזמנות רכש/ }).click();
      await expect(page.locator('table[data-list="po"] tbody tr').first()).toBeVisible();
      const po = await geometry(page, wrapSel);
      expectContained(po);
      if (size.width >= 1280) expect(po.wrapper.scrollWidth).toBeLessThanOrEqual(po.wrapper.clientWidth);
    });
  });
}
