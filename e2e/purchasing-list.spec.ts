import { randomUUID } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import { Pool } from 'pg';

// The /purchasing lists ("רכש"), driven as the seeded super admin: header, tabs with their counters, the
// search + date-range row, the table (columns, offers pill in its three colours, winner, unseen dot, the
// four row icons), the delete confirmation — and, on a phone, the invariant that closed the white-screen bug
// of 27/10/2026: the page never scrolls sideways, only the table does (inside its card).
//
// The phone test uses a MOBILE context (`isMobile`): the bug only exists there. On Chrome for Android a
// position:absolute descendant of the table (the old sr-only "פעולות" label) escaped the card's overflow
// clip, the layout viewport grew to ~916px and the whole page slid out of sight. A desktop context with a
// small viewport never showed it, which is why it lived in main unnoticed. No pixel values are asserted:
// every check is relative to the viewport the test itself chose.
//
// The date range is the datePicker skill's DateRangePicker (DESIGN §6 "Date Input", the declared exception):
// a popover on a desktop, a bottom sheet on a phone. Its days are `button[data-key="YYYY-MM-DD"]`. The picker
// opens on TODAY's month, which moves every day, and the fixtures below are dated in March 2026 — so the
// desktop tests step back with its arrow until the day they need is on screen (the phone sheet has no
// arrows: it lists the months from the current one forward, so the phone test uses a fixture of this month).
//
// Fixtures are inserted with explicit ids and removed by exactly those ids (CLAUDE.md iron rule 12).

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
pool.on('error', () => undefined);

const RUN = Date.now().toString().slice(-7);
const NUM = 7_700_000;
const SUP = {
  cohen: `חשמל כהן ${RUN}`, abc: `אספקה טכנית ${RUN}`, motors: `מנועים והנעה ${RUN}`, cool: `טכנו קירור ${RUN}`,
  green: `גינות ירוקות ${RUN}`, noff: `נוף עיצוב ${RUN}`, grass: `דשא פלוס ${RUN}`, po: `ספק הזמנה ${RUN}`,
};
const ID: Record<'a' | 'b' | 'c' | 'draft' | 'po' | 'cur', string> = {
  a: randomUUID(), b: randomUUID(), c: randomUUID(), draft: randomUUID(), po: randomUUID(), cur: randomUUID(),
};
const ALL_IDS = Object.values(ID);

// This month, from the clock of the machine that also runs the browser — the phone sheet opens on it.
const NOW = new Date();
const THIS_MONTH = `${NOW.getFullYear()}-${String(NOW.getMonth() + 1).padStart(2, '0')}`;
const asDocDate = (iso: string) => iso.split('-').reverse().join('/');

const TITLE = { a: `ציוד חשמל ${RUN}`, b: `משאבת סחרור ${RUN}`, c: `אחזקת גינון ${RUN}`, draft: `טיוטת צביעה ${RUN}`, po: `חוזה שירות ${RUN}`, cur: `החלפת מנעולים ${RUN}` };
const row = (page: Page, id: string) => page.locator(`tr[data-doc="${id}"]`);
const rangeButton = (page: Page) => page.locator('[data-filter-range]');
const picker = (page: Page) => page.getByRole('dialog');
const dayIn = (page: Page, day: string) => picker(page).locator(`button[data-key="${day}"]`);
const closePicker = (page: Page) => picker(page).getByRole('button', { name: 'סגור', exact: true });

// Of the four requests (a, b, c and the draft) exactly `visible` are on the table.
async function only(page: Page, visible: string[]) {
  for (const id of [ID.a, ID.b, ID.c, ID.draft]) {
    if (visible.includes(id)) await expect(row(page, id)).toBeVisible();
    else await expect(row(page, id)).toHaveCount(0);
  }
}

// Desktop popover: step back until `day` is on screen (two months show at once, so two days of one month are).
async function reveal(page: Page, day: string) {
  const previous = picker(page).getByRole('button', { name: 'חודש קודם' });
  for (let i = 0; i < 120 && (await dayIn(page, day).count()) === 0; i++) await previous.click();
  await expect(dayIn(page, day)).toBeVisible();
}

async function pickRange(page: Page, from: string, to: string) {
  await rangeButton(page).click();
  await reveal(page, from);
  await dayIn(page, from).click();
  await dayIn(page, to).click();
  await closePicker(page).click();
  await expect(picker(page)).toHaveCount(0);
}
const offersOf = (ids: string[]) => ids.map((id) => `tr[data-doc="${id}"] [data-offers]`).join(', ');
const toastOf = (page: Page, text: string) => page.locator('[data-sonner-toast]').filter({ hasText: text }).first();
const confirmDeletion = (page: Page) => page.getByRole('alertdialog').locator('[data-delete-confirm]').click();

interface Recipient { key: string; name: string }
async function insertDoc(
  id: string,
  d: { type: 'rfq' | 'po'; number: number | null; date: string; title: string; due?: string; status?: 'issued' | 'draft'; supplier?: string },
) {
  await pool.query(
    `insert into public.purchasing_documents (id, doc_type, number, doc_date, title, due_date, status, vat_rate, supplier_name)
     values ($1, $2, $3, $4, $5, $6, $7, 18, $8)`,
    [id, d.type, d.number, d.date, d.title, d.due ?? null, d.status ?? 'issued', d.supplier ?? null],
  );
}
async function insertRecipients(rfq: string, rs: Recipient[]) {
  for (const r of rs) {
    await pool.query(
      `insert into public.purchasing_rfq_recipients (rfq_id, token, supplier_name, manual_key) values ($1, $2, $3, $4)`,
      [rfq, randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '').slice(0, 11), r.name, r.key],
    );
  }
}
async function insertQuotes(rfq: string, source: 'portal' | 'manual', rs: Recipient[]) {
  for (const r of rs) {
    await pool.query(
      `insert into public.purchasing_quotes (rfq_id, source, total_amount, supplier_name, manual_key) values ($1, $2, 1000, $3, $4)`,
      [rfq, source, r.name, r.key],
    );
  }
}

const R = (n: string, key: string): Recipient => ({ key: `m${RUN}${key}`, name: n });

// Tests run in file order (one worker). They are deliberately NOT a serial group: a failure in one must not
// hide the others, and a retry gets a fresh worker — beforeAll re-seeds, the old afterAll already cleaned up.

test.beforeAll(async () => {
  // A: both suppliers answered through the portal (nobody opened them → unseen), one is the winner.
  const a = [R(SUP.cohen, 'a1'), R(SUP.abc, 'a2')];
  await insertDoc(ID.a, { type: 'rfq', number: NUM + 3, date: '2026-03-20', title: TITLE.a, due: '2026-04-20' });
  await insertRecipients(ID.a, a);
  await insertQuotes(ID.a, 'portal', a);
  await pool.query(`update public.purchasing_documents set winner_chosen_at = now(), winner_manual_key = $2 where id = $1`, [ID.a, a[0].key]);
  // B: asked two suppliers, none answered.
  await insertDoc(ID.b, { type: 'rfq', number: NUM + 2, date: '2026-03-10', title: TITLE.b, due: '2026-04-10' });
  await insertRecipients(ID.b, [R(SUP.motors, 'b1'), R(SUP.cool, 'b2')]);
  // C: three asked, two answered (typed in by staff → nothing "new"), long past its due date.
  const c = [R(SUP.green, 'c1'), R(SUP.noff, 'c2'), R(SUP.grass, 'c3')];
  await insertDoc(ID.c, { type: 'rfq', number: NUM + 1, date: '2026-02-01', title: TITLE.c, due: '2026-02-15' });
  await insertRecipients(ID.c, c);
  await insertQuotes(ID.c, 'manual', c.slice(0, 2));
  // A draft request and an issued purchase order (12 × 1,250 + 18% VAT = 17,700).
  await insertDoc(ID.draft, { type: 'rfq', number: null, date: '2026-03-25', title: TITLE.draft, due: '2026-04-25', status: 'draft' });
  await insertDoc(ID.po, { type: 'po', number: NUM + 1, date: '2026-03-15', title: TITLE.po, supplier: SUP.po });
  await pool.query(`insert into public.purchasing_lines (document_id, sort_order, description, quantity, unit_price) values ($1, 0, 'שירות חודשי', 12, 1250)`, [ID.po]);
  // Dated this month: the phone picker can only reach the current month onward, so its test filters on this one.
  await insertDoc(ID.cur, { type: 'rfq', number: NUM + 4, date: `${THIS_MONTH}-10`, title: TITLE.cur, due: `${THIS_MONTH}-20` });
});

test.afterAll(async () => {
  await pool.query(`delete from public.purchasing_quotes where rfq_id = any($1::uuid[])`, [ALL_IDS]);
  await pool.query(`delete from public.purchasing_rfq_recipients where rfq_id = any($1::uuid[])`, [ALL_IDS]);
  await pool.query(`delete from public.purchasing_lines where document_id = any($1::uuid[])`, [ALL_IDS]);
  await pool.query(`delete from public.purchasing_documents where id = any($1::uuid[])`, [ALL_IDS]);
  await pool.end();
});

test('requests tab: header, counters, columns, order, offers pill, winner, unseen dot and the four row icons', async ({ page }) => {
  await page.goto('/purchasing?tab=rfq');
  await expect(page.locator('h1')).toHaveText('רכש');
  await expect(page.getByText('בקשות להצעת מחיר לספקים והזמנות רכש — מופקות על נייר המכתבים של החברה, עם PDF ושליחה במייל ו-WhatsApp.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'בקשה חדשה' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'הגדרות רכש — נייר מכתבים' })).toBeVisible();

  // The counters are the totals of each tab (never the filtered rows).
  for (const type of ['rfq', 'po'] as const) {
    const all = ((await (await page.request.get(`/api/purchasing/documents?type=${type}`)).json()) as { documents: unknown[] }).documents.length;
    await expect(page.locator(`[data-tab="${type}"]`)).toContainText(String(all));
  }
  await expect(page.locator('[data-tab="rfq"]')).toHaveAttribute('aria-selected', 'true');

  await expect(page.locator('table[data-list="rfq"] thead th')).toHaveText(['מספר', 'תאריך', 'נושא', 'יעד להגשה', 'הצעות', 'זוכה', 'פעולות']);
  await expect(page.getByPlaceholder('חיפוש לפי ספק, נושא או מספר בקשה...')).toBeVisible();
  await expect(page.locator('[data-filter-range]')).toContainText('מתאריך — עד תאריך');

  // Newest first, a draft before them all.
  const order = await page.locator('table[data-list="rfq"] tr[data-doc]').evaluateAll((els) => els.map((e) => e.getAttribute('data-doc')));
  expect(order.filter((id) => id && [ID.draft, ID.a, ID.b, ID.c].includes(id))).toEqual([ID.draft, ID.a, ID.b, ID.c]);

  const a = row(page, ID.a);
  await expect(a.locator('td').first()).toHaveText(String(NUM + 3));
  await expect(a).toContainText('20/03/2026');
  await expect(a).toContainText('20/04/2026');
  await expect(a).toContainText(TITLE.a);
  await expect(a).toContainText(`${SUP.cohen} · ${SUP.abc}`);
  await expect(a.locator('[data-offers]')).toHaveText('2 מתוך 2');
  await expect(a.locator('[data-offers]')).toHaveAttribute('data-tone', 'all');
  await expect(a.locator('td').nth(5)).toHaveText(SUP.cohen);
  await expect(a.locator('[data-new-quote-tag]')).toHaveCount(1);

  await expect(row(page, ID.b).locator('[data-offers]')).toHaveText('0 מתוך 2');
  await expect(row(page, ID.b).locator('[data-offers]')).toHaveAttribute('data-tone', 'none');
  await expect(row(page, ID.b).locator('[data-new-quote-tag]')).toHaveCount(0);
  await expect(row(page, ID.b).locator('td').nth(5)).toHaveText('—');

  await expect(row(page, ID.c).locator('[data-offers]')).toHaveText('2 מתוך 3');
  await expect(row(page, ID.c).locator('[data-offers]')).toHaveAttribute('data-tone', 'some');
  await expect(row(page, ID.c).locator('[data-new-quote-tag]')).toHaveCount(0);
  await expect(row(page, ID.c)).toContainText('נסגרה');

  // Every pill is one line at the default desktop width (1280, sidebar open): the dot beside a pill used to
  // squeeze it into two lines ("2 מתוך" / "2"), so a squeezed pill is taller than the one that fits.
  const heights = await page.locator(offersOf([ID.a, ID.b, ID.c])).evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
  expect(heights).toHaveLength(3);
  expect(new Set(heights).size, `pill heights ${heights.join(', ')}`).toBe(1);

  // ...and at that width the requests table fits its card: no sideways scroll on an ordinary laptop screen.
  const card = await page.locator('[data-table-scroll]').evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
  expect(card.scroll, 'the table fits the card at the default desktop width').toBeLessThanOrEqual(card.client);

  await expect(row(page, ID.draft).locator('td').first()).toHaveText('טיוטה');

  // Download · print · send, a rule, then delete (RTL: the first is the right-most).
  const icons = await a.locator('[data-row-action]').evaluateAll((els) => els.map((e) => e.getAttribute('data-row-action')));
  expect(icons).toEqual(['download', 'print', 'send', 'delete']);
});

test('the purchase orders tab: its own columns, the order total and the same row icons', async ({ page }) => {
  await page.goto('/purchasing?tab=po');
  await expect(page.locator('[data-tab="po"]')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('table[data-list="po"] thead th')).toHaveText(['מספר', 'תאריך', 'ספק', 'תיאור', 'סה״כ לתשלום', 'פעולות']);
  const po = row(page, ID.po);
  await expect(po).toContainText(SUP.po);
  await expect(po).toContainText(TITLE.po);
  await expect(po).toContainText('15/03/2026');
  await expect(po).toContainText('₪17,700.00');
  const icons = await po.locator('[data-row-action]').evaluateAll((els) => els.map((e) => e.getAttribute('data-row-action')));
  expect(icons).toEqual(['download', 'print', 'send', 'delete']);
});

test('search and date range filter both tabs; the counters keep the totals; clearing brings everything back', async ({ page }) => {
  await page.goto('/purchasing?tab=rfq');
  const counter = page.locator('[data-tab="rfq"]');
  const total = (await counter.textContent()) ?? '';
  const search = page.getByPlaceholder('חיפוש לפי ספק, נושא או מספר בקשה...');
  await only(page, [ID.a, ID.b, ID.c, ID.draft]);

  // A recipient of a request, its subject, its number.
  await search.fill(SUP.cohen);
  await only(page, [ID.a]);
  await search.fill(TITLE.b);
  await only(page, [ID.b]);
  await search.fill(String(NUM + 1));
  await only(page, [ID.c]);
  await search.fill(`אין-כזה-${RUN}`);
  await expect(page.locator('[data-empty]')).toContainText('לא נמצאו מסמכים התואמים');
  await expect(counter).toHaveText(total);
  await page.locator('[data-list-filters]').getByRole('button', { name: 'נקה חיפוש' }).click();
  await expect(search).toHaveValue('');
  await only(page, [ID.a, ID.b, ID.c, ID.draft]);

  // The date range filters by the document date.
  await expect(page.locator('[data-filter-range-clear]')).toHaveCount(0);
  await pickRange(page, '2026-03-01', '2026-03-31');
  await only(page, [ID.a, ID.b, ID.draft]);
  await expect(rangeButton(page)).toContainText('01/03/2026 — 31/03/2026');

  // It holds on the other tab (the order is from 15/03).
  await page.locator('[data-tab="po"]').click();
  await expect(rangeButton(page)).toContainText('01/03/2026 — 31/03/2026');
  await expect(row(page, ID.po)).toBeVisible();
  await search.fill(SUP.po);
  await expect(row(page, ID.po)).toBeVisible();
  await search.fill(`אין-כזה-${RUN}`);
  await expect(page.locator('[data-empty]')).toBeVisible();
  await search.fill('');

  await page.locator('[data-filter-range-clear]').click();
  await expect(rangeButton(page)).toContainText('מתאריך — עד תאריך');
  await expect(page.locator('[data-filter-range-clear]')).toHaveCount(0);
  await page.locator('[data-tab="rfq"]').click();
  await only(page, [ID.a, ID.b, ID.c, ID.draft]);
});

test('date range picker (desktop): floats inside the screen, a half-picked range filters nothing, both ends count, cancel keeps the filter', async ({ page }) => {
  await page.goto('/purchasing?tab=rfq');
  const pageHeight = () => page.evaluate(() => document.documentElement.scrollHeight);
  const before = await pageHeight();

  await rangeButton(page).click();
  await expect(picker(page)).toBeVisible();
  // It floats: inside the screen, and opening it does not push the page.
  const box = (await picker(page).boundingBox())!;
  const view = page.viewportSize()!;
  expect(box.x, 'popover left edge').toBeGreaterThanOrEqual(0);
  expect(box.y, 'popover top edge').toBeGreaterThanOrEqual(0);
  expect(box.x + box.width, 'popover right edge').toBeLessThanOrEqual(view.width);
  expect(box.y + box.height, 'popover bottom edge').toBeLessThanOrEqual(view.height);
  expect(await pageHeight(), 'opening the picker does not change the page height').toBe(before);
  await expect(rangeButton(page)).toHaveAttribute('aria-expanded', 'true');
  await expect(closePicker(page)).toBeDisabled();

  // A start alone filters nothing and cannot be closed on.
  await reveal(page, '2026-03-20');
  await dayIn(page, '2026-03-20').click();
  await expect(closePicker(page)).toBeDisabled();
  await expect(rangeButton(page)).toContainText('מתאריך — עד תאריך');
  await only(page, [ID.a, ID.b, ID.c, ID.draft]);
  // An earlier day moves the start — the range can never be upside down.
  await dayIn(page, '2026-03-10').click();
  await expect(closePicker(page)).toBeDisabled();
  await dayIn(page, '2026-03-20').click();
  await expect(closePicker(page)).toBeEnabled();
  await closePicker(page).click();

  // Both ends are inside the range: 10/03 (b) and 20/03 (a) stay, 25/03 (the draft) and 01/02 (c) go.
  await expect(picker(page)).toHaveCount(0);
  await expect(rangeButton(page)).toContainText('10/03/2026 — 20/03/2026');
  await expect(rangeButton(page)).toHaveAttribute('aria-expanded', 'false');
  await only(page, [ID.a, ID.b]);

  // Esc, and a second press on the button, throw the half-made change away.
  await rangeButton(page).click();
  await reveal(page, '2026-03-01');
  await dayIn(page, '2026-03-01').click();
  await page.keyboard.press('Escape');
  await expect(picker(page)).toHaveCount(0);
  await expect(rangeButton(page)).toBeFocused();
  await expect(rangeButton(page)).toContainText('10/03/2026 — 20/03/2026');
  await only(page, [ID.a, ID.b]);

  await rangeButton(page).click();
  await reveal(page, '2026-03-01');
  await dayIn(page, '2026-03-01').click();
  // On a short window the popover pins itself over the button, so the second press is sent to it directly.
  await rangeButton(page).dispatchEvent('click');
  await expect(picker(page)).toHaveCount(0);
  await expect(rangeButton(page)).toContainText('10/03/2026 — 20/03/2026');
  await only(page, [ID.a, ID.b]);

  // A new range replaces the old one, and the X brings everything back.
  await pickRange(page, '2026-02-01', '2026-02-28');
  await only(page, [ID.c]);
  await page.locator('[data-filter-range-clear]').click();
  await expect(rangeButton(page)).toContainText('מתאריך — עד תאריך');
  await only(page, [ID.a, ID.b, ID.c, ID.draft]);
});

test('delete asks first: cancel keeps the row; confirm closes an issued request and removes a draft for good', async ({ page }) => {
  await page.goto('/purchasing?tab=rfq');
  const b = row(page, ID.b);

  await b.locator('[data-row-action="delete"]').click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText(`למחוק את בקשה להצעת מחיר מספר ${NUM + 2}?`);
  await expect(dialog).toContainText('הקישורים האישיים שנשלחו לספקים יפסיקו לעבוד');
  await dialog.getByRole('button', { name: 'ביטול' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(b).toBeVisible();
  expect((await pool.query(`select deleted_at from public.purchasing_documents where id = $1`, [ID.b])).rows[0].deleted_at).toBeNull();

  await b.locator('[data-row-action="delete"]').click();
  await confirmDeletion(page);
  await expect(toastOf(page, 'המסמך נמחק')).toBeVisible();
  await expect(b).toHaveCount(0);
  // Closed, never reissued: the row stays for the audit trail with its number.
  const gone = (await pool.query(`select deleted_at, number from public.purchasing_documents where id = $1`, [ID.b])).rows[0];
  expect(gone.deleted_at).not.toBeNull();
  expect(gone.number).toBe(NUM + 2);

  const draft = row(page, ID.draft);
  await draft.locator('[data-delete-draft]').click();
  await expect(page.getByRole('alertdialog')).toContainText('למחוק את הטיוטה?');
  await confirmDeletion(page);
  await expect(toastOf(page, 'הטיוטה נמחקה')).toBeVisible();
  await expect(draft).toHaveCount(0);
  expect((await pool.query(`select 1 from public.purchasing_documents where id = $1`, [ID.draft])).rowCount).toBe(0);
});

// ── Phone ───────────────────────────────────────────────────────────────────

for (const width of [360, 390]) {
  test(`phone ${width}: the page never scrolls sideways, the content is in view, only the table scrolls — both tabs`, async ({ browser }) => {
    const height = 844;
    const ctx = await browser.newContext({
      storageState: 'e2e/.auth/state.json', viewport: { width, height }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, locale: 'he-IL',
    });
    const page = await ctx.newPage();
    try {
      for (const tab of ['rfq', 'po'] as const) {
        await page.goto(`/purchasing?tab=${tab}`);
        await expect(page.locator(`table[data-list="${tab}"]`)).toBeVisible();

        // THE regression: the layout viewport did not grow to the table's width, and the page is not wider than it.
        expect(await page.evaluate(() => window.innerWidth), `${tab}: layout viewport`).toBe(width);
        const geometry = await page.evaluate(() => ({
          scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth,
          htmlX: document.documentElement.getBoundingClientRect().x,
        }));
        expect(geometry.scroll, `${tab}: page scrollWidth`).toBeLessThanOrEqual(geometry.client);
        expect(geometry.htmlX, `${tab}: the page is not shifted`).toBe(0);

        // The content is visible: header, both tabs, the filter row (broken into rows), the card.
        await expect(page.getByRole('heading', { name: 'רכש', level: 1, exact: true })).toBeInViewport();
        await expect(page.getByRole('button', { name: tab === 'rfq' ? 'בקשה חדשה' : 'הזמנה חדשה' })).toBeInViewport();
        const inside = async (sel: string) => page.locator(sel).first().evaluate((el, w) => {
          const r = el.getBoundingClientRect();
          return r.left >= 0 && r.right <= w;
        }, width);
        for (const sel of ['[data-tab="rfq"]', '[data-tab="po"]', '[data-filter-search]', '[data-filter-range]', '[data-table-scroll]']) {
          expect(await inside(sel), `${tab}: ${sel} inside the screen`).toBe(true);
        }
        const [search, range] = await Promise.all([page.locator('[data-filter-search]').boundingBox(), page.locator('[data-filter-range]').boundingBox()]);
        expect(search!.y + search!.height, `${tab}: the filters wrap to rows`).toBeLessThanOrEqual(range!.y + 1);

        // Only the table scrolls — inside its card — and its far column (the icons) is reachable.
        const card = await page.locator('[data-table-scroll]').evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
        expect(card.scroll, `${tab}: the table is wider than its card`).toBeGreaterThan(card.client);
        const lastIcon = page.locator(`table[data-list="${tab}"] [data-row-action="delete"]`).first();
        await lastIcon.scrollIntoViewIfNeeded();
        await expect(lastIcon).toBeInViewport();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `${tab}: still not wider after scrolling the table`).toBe(true);
        expect(await page.evaluate(() => window.innerWidth)).toBe(width);
      }
    } finally {
      await ctx.close();
    }
  });

  test(`phone ${width}: the date picker is a sheet inside the screen; a range filters both tabs and the X clears it`, async ({ browser }) => {
    const height = 844;
    const ctx = await browser.newContext({
      storageState: 'e2e/.auth/state.json', viewport: { width, height }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, locale: 'he-IL',
    });
    const page = await ctx.newPage();
    // The sheet lists the months from the current one forward; this month's fixture is `cur`, dated the 10th.
    const from = `${THIS_MONTH}-01`;
    const to = `${THIS_MONTH}-28`;
    const label = `${asDocDate(from)} — ${asDocDate(to)}`;
    const noSidewaysScroll = async (where: string) => {
      expect(await page.evaluate(() => window.innerWidth), `${where}: layout viewport`).toBe(width);
      const g = await page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth,
        htmlX: document.documentElement.getBoundingClientRect().x,
      }));
      expect(g.scroll, `${where}: page scrollWidth`).toBeLessThanOrEqual(g.client);
      expect(g.htmlX, `${where}: the page is not shifted`).toBe(0);
    };
    try {
      await page.goto('/purchasing?tab=rfq');
      await expect(page.locator('table[data-list="rfq"]')).toBeVisible();
      await expect(rangeButton(page)).toBeVisible();
      await rangeButton(page).tap();

      // The sheet is inside the screen on every side, the page behind it does not move and does not scroll sideways.
      const sheet = page.locator('.drp-sheet');
      await expect(sheet).toBeVisible();
      const box = (await sheet.boundingBox())!;
      expect(box.x, 'sheet left edge').toBeGreaterThanOrEqual(0);
      expect(box.y, 'sheet top edge').toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, 'sheet right edge').toBeLessThanOrEqual(width);
      expect(box.y + box.height, 'sheet bottom edge').toBeLessThanOrEqual(height);
      await noSidewaysScroll('sheet open');
      expect(await page.evaluate(() => document.body.style.overflow), 'the page behind the sheet is locked').toBe('hidden');
      await expect(closePicker(page)).toBeDisabled();

      // Pick a range (start, then end), close.
      await dayIn(page, from).tap();
      await expect(closePicker(page)).toBeDisabled();
      await dayIn(page, to).tap();
      await expect(closePicker(page)).toBeEnabled();
      await noSidewaysScroll('range picked');
      await closePicker(page).tap();
      await expect(sheet).toHaveCount(0);
      expect(await page.evaluate(() => document.body.style.overflow), 'the page is released again').toBe('');
      await noSidewaysScroll('sheet closed');

      // The button shows the range; this month's request is the only one left; the March ones are gone.
      await expect(rangeButton(page)).toContainText(label);
      await expect(row(page, ID.cur)).toBeVisible();
      for (const id of [ID.a, ID.c]) await expect(row(page, id)).toHaveCount(0);
      // The other tab is filtered by the same range (its fixture is from March).
      await page.locator('[data-tab="po"]').tap();
      await expect(rangeButton(page)).toContainText(label);
      await expect(page.locator('[data-empty]')).toBeVisible();
      await expect(row(page, ID.po)).toHaveCount(0);

      // The X is a real touch target, inside the screen, and brings everything back.
      const clear = page.locator('[data-filter-range-clear]');
      const x = (await clear.boundingBox())!;
      expect(x.width, 'clear button width').toBeGreaterThanOrEqual(44);
      expect(x.height, 'clear button height').toBeGreaterThanOrEqual(44);
      expect(x.x, 'clear button left edge').toBeGreaterThanOrEqual(0);
      expect(x.x + x.width, 'clear button right edge').toBeLessThanOrEqual(width);
      await clear.tap();
      await expect(rangeButton(page)).toContainText('מתאריך — עד תאריך');
      await expect(row(page, ID.po)).toBeVisible();
      await page.locator('[data-tab="rfq"]').tap();
      for (const id of [ID.cur, ID.a, ID.c]) await expect(row(page, id)).toBeVisible();
      await noSidewaysScroll('after clearing');
    } finally {
      await ctx.close();
    }
  });
}
