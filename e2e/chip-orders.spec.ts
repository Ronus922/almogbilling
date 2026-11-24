import { test, expect, type Locator, type Page } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import ExcelJS from 'exceljs';
import { Pool } from 'pg';
import { StorageStub } from './visitors-stubs';

// Chip orders in the browser — the 20/11/2026 redesign (ref/chip-order) with
// the 21/11/2026 fixes (one flat price per chip; the issue window has no
// quantity limit; the public page up to 10 chips per apartment — noon):
//   · /chips keeps its chips view as the default;
//   · the issue window WITHOUT an order: apartment picker, holder blocks, no
//     transaction section, ANY number of chips with no reason, card / app, the
//     active / disabled switch, and the kept "עמלת הנפקה (₪)", "החיוב בוצע"
//     and "הערה" fields — saved with the chips;
//   · a paid order opens the window with ONE BLOCK PER PERSON (owner and
//     renter of one apartment, plus a second apartment), the renter's lease
//     end date, chips per block (Enter and "הוסף", card / app), the counter
//     "שויכו X מתוך Y" full when done, "הוסף בעל צ׳יפ" outside the paid
//     quantity, ONE price line in the transaction section, "מוכן לאיסוף" and
//     "נאסף"; an order made before 21/11/2026 keeps its two price lines;
//   · /settings: one price field — the threshold, price-above and maximum
//     fields are gone, and saving keeps the old rule's stored keys;
//   · the public page (test link): rows per person (owner + renter with a
//     lease), the add-row prefill, up to 10 chips per apartment over its rows
//     (the plus past it shows the message next to the quantity; the server
//     refuses a body past it), one breakdown line at the price of /settings,
//     the "הערות" field, the card fields never sent, the code on WhatsApp →
//     the confirmation screen and its text; the staff side of that test order
//     (blocks, lease link, the note in "הערה", chips, the switch) and
//     "מחק הזמנת בדיקה" (its chips are disabled first, never deleted);
//   · "דלג על אימות" → confirmation → "דחה" on the test order;
//   · /chip-order is closed while Grow is not configured — the CI state;
//   · the look of the issue window (v2 of 24/11/2026,
//     ref/chip-order/chip-issue-admin-v2.html), kept as numbers on orders of
//     its own: the panel — 60% of the viewport, never under 780px — nothing
//     cut or scrolling sideways from 1920px down to 320px, the two
//     breakpoints, the status row — also for an order that was closed
//     somewhere else — and the 16px fields of a touch phone;
//   · 24/11/2026, third round (Ronen): "שמור שינויים" of an order keeps the
//     window open; "מוכן לאיסוף" is one click (it saves what is waiting, then
//     marks the order ready; a save that fails marks nothing) and says under
//     the buttons why it is off; the Orders tab has a quick status button per
//     row ("מוכן לאיסוף" / "נאסף", each asking first), a search by apartment
//     number and by name, "ייצוא לאקסל" and "הדפסה"; and "צ׳יפים" sits under
//     "אבטחה" in the menu.
// Real orders are seeded straight into the DB (paid = what Grow's verified
// callback leaves); fixtures are numeric apartments, removed by exact ids.
// Supabase Storage is the in-process stand-in of visitors-stubs.ts (CI runs
// no Storage), started for this file only.

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
pool.on('error', () => undefined);

const tag = String(Date.now()).slice(-6);
const APT = `992${tag}1`; // staff: the order of two people + a staff holder
const APT_B = `992${tag}2`; // staff: the second apartment of that order
const APT_OLD = `992${tag}3`; // staff: an order from before 21/11/2026
const APT_PUB = `992${tag}4`; // test link: owner + renter
const APT_SKIP = `992${tag}5`; // test link: "דלג על אימות"
const APT_LAY = `992${tag}6`; // the look of the window: an order of two people…
const APT_LAY_B = `992${tag}7`; // …and its second apartment
const APT_GONE = `992${tag}8`; // an order closed behind the screen's back
const APT_TAKEN = `992${tag}9`; // one-click "מוכן לאיסוף" with a taken number
const APT_ROW = `993${tag}1`; // the quick status button of a row: an order of two apartments…
const APT_ROW_B = `993${tag}2`; // …and its second apartment
const APT_S1 = `993${tag}3`; // search / Excel / print: an owner and a renter
const APT_S2 = `993${tag}4`; // search / Excel / print: another order
const APT_LIMIT_MSG = 'ניתן להזמין עד 10 כרטיסים לדירה בהזמנה אחת. לכמות גדולה יותר יש לפנות להנהלת הבניין.';
const PUB_NOTE = 'אני מבקש למסור את הכרטיסים לשכן מדירה 5';
const P_OWNER = '+972539300001';
const P_RENTER = '+972539300002';
const made = { contacts: {} as Record<string, string>, orders: [] as string[] };

const storageUrl = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'http://localhost:54321');
const storage = new StorageStub();

const PDF = Buffer.from('%PDF-1.4\n% e2e lease\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n');

async function noSideScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

interface SeedRow { apt: string; role: 'owner' | 'tenant'; name: string; phone: string; qty: number; leaseEnd?: string }

/** A PAID real order made of the given rows (one item per apartment, one
 *  holder line per row) — what Grow's verified callback leaves since
 *  20/11/2026, priced at one flat price as since 21/11/2026. */
async function seedPaidOrder(rows: SeedRow[], unit = 50): Promise<{ id: string; orderNumber: number; items: Record<string, string> }> {
  const total = rows.reduce((s, r) => s + r.qty, 0) * unit;
  const n = made.orders.length;
  const o = await pool.query<{ id: string; order_number: number }>(
    `insert into public.chip_orders
       (full_name, phone_e164, email, address, role, status, total, tracking_token, paid_at, due_at,
        grow_process_id, grow_transaction_id, grow_asmachta, address_street, address_city, address_zip)
     values ($1, $2, 'dana.e2e@example.test', 'רחוב בדיקה 1, חיפה 3300000', 'owner', 'paid', $3, $4, now(), now() + interval '3 days',
             $5, $6, 'e2e', 'רחוב בדיקה 1', 'חיפה', '3300000')
     returning id, order_number`,
    [rows[0]!.name, rows[0]!.phone, total, randomBytes(32).toString('base64url'), `e2e-p-${tag}-${n}`, `e2e-t-${tag}-${n}`],
  );
  const order = o.rows[0]!;
  made.orders.push(order.id);
  const items: Record<string, string> = {};
  for (const apt of [...new Set(rows.map((r) => r.apt))]) {
    const qty = rows.filter((r) => r.apt === apt).reduce((s, r) => s + r.qty, 0);
    const i = await pool.query<{ id: string }>(
      `insert into public.chip_order_items
         (order_id, contact_id, apartment_number, chips_count, unit_price, threshold, price_above, line_total, match_status)
       values ($1, $2, $3, $4, $5, $4, $5, $6, 'unassigned') returning id`,
      [order.id, made.contacts[apt], apt, qty, unit, qty * unit],
    );
    items[apt] = i.rows[0]!.id;
  }
  for (const [position, r] of rows.entries()) {
    await pool.query(
      `insert into public.chip_order_holders (order_id, item_id, position, source, role, full_name, phone, chips_count, lease_end_date)
       values ($1, $2, $3, 'order', $4, $5, $6, $7, $8)`,
      [order.id, items[r.apt], position, r.role, r.name, r.phone, r.qty, r.leaseEnd ?? null],
    );
  }
  return { id: order.id, orderNumber: order.order_number, items };
}

/** The window's apartment rows in /chips → "הזמנות". */
function orderRow(page: Page, text: string): Locator {
  return page.getByTestId('chip-orders-table').getByTestId('chip-order-row').filter({ hasText: text });
}

function issueWindow(page: Page): Locator {
  return page.getByRole('dialog').filter({ hasText: 'הנפקת צ׳יפ' });
}

/** The window without an order: pick the apartment in its search popover. */
async function pickApartment(page: Page, apt: string) {
  await issueWindow(page).getByText('בחר דירה או יחידה…').click();
  await page.getByPlaceholder('מספר דירה או שם דייר…').fill(apt);
  await page.locator('[data-slot="popover-content"]').getByRole('button').filter({ hasText: apt }).first().click();
}

/** Type a number into a block's chip field and add it (Enter or "הוסף"). */
async function addChip(block: Locator, number: string, how: 'enter' | 'button' = 'enter') {
  const input = block.getByLabel(/^מספר צ׳יפ/);
  await input.fill(number);
  if (how === 'enter') await input.press('Enter');
  else await block.getByRole('button', { name: 'הוסף', exact: true }).click();
  await expect(block.getByText(number, { exact: true })).toBeVisible();
}

/** Boxes of the window that clip sideways — the panel, a section, a block, the
 *  transaction card — and hold more than they show: content that is cut off
 *  with no way to reach it. A line cut on purpose (ellipsis) and form fields
 *  are not part of it. */
function cutOff(issue: Locator): Promise<string[]> {
  return issue.evaluate((root) => {
    const out: string[] = [];
    for (const el of [root, ...root.querySelectorAll('*')]) {
      if (!(el instanceof HTMLElement) || el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) continue;
      const cs = getComputedStyle(el);
      if (cs.overflowX === 'visible' || cs.textOverflow === 'ellipsis' || el.clientWidth <= 1) continue;
      const over = el.scrollWidth - el.clientWidth;
      if (over > 1) out.push(`${el.className} +${over}px`);
    }
    return out;
  });
}

/** On how many lines the element's own text sits. */
function textLines(el: Locator): Promise<number> {
  return el.evaluate((node) => {
    const tops = new Set<number>();
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      const range = document.createRange();
      range.selectNodeContents(t);
      for (const rect of range.getClientRects()) if (rect.width > 0) tops.add(Math.round(rect.top));
    }
    return tops.size;
  });
}

/** The status row of the transaction card, measured: every line of buttons
 *  starts at the row's start edge (the right — the window is RTL) and the
 *  buttons follow each other with the row's own gap, so a button that is not
 *  there leaves no hole. Returns what is off; an empty list = a tight row.
 *  "מחק הזמנת בדיקה" is pushed to the far end on purpose and is not measured. */
function statusRowGaps(issue: Locator): Promise<string[]> {
  return issue.getByTestId('chip-order-actions').evaluate((row) => {
    const cs = getComputedStyle(row);
    const gap = parseFloat(cs.columnGap);
    const start = row.getBoundingClientRect().right - parseFloat(cs.borderRightWidth) - parseFloat(cs.paddingRight);
    const off: string[] = [];
    let prev: DOMRect | null = null;
    for (const button of row.querySelectorAll<HTMLElement>('button:not(.ci-danger)')) {
      const box = button.getBoundingClientRect();
      const want = prev !== null && Math.abs(box.top - prev.top) < 1 ? prev.left - gap : start;
      if (Math.abs(box.right - want) > 0.5) off.push(`${button.textContent?.trim()}: ${Math.round((want - box.right) * 10) / 10}px away from its place`);
      prev = box;
    }
    return off;
  });
}

/** A toast of the app (sonner) with this text. */
function toast(page: Page, text: string): Locator {
  return page.locator('[data-sonner-toast]').filter({ hasText: text }).first();
}

/** An instant as a date in Israel, dd/mm/yyyy — how the Excel file writes an
 *  order's date. */
function dateInIsrael(at: Date): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', day: '2-digit', month: '2-digit', year: 'numeric' })
    .formatToParts(at).map((x) => [x.type, x.value]));
  return `${p.day}/${p.month}/${p.year}`;
}

/** The width the issue window takes in a viewport: 60% of it, never under
 *  780px, never wider than the screen. */
const panelWidth = (viewport: number) => Math.min(Math.max(0.6 * viewport, 780), viewport);

/** The font sizes of the window's text fields. */
function fieldSizes(issue: Locator): Promise<string[]> {
  return issue.evaluate((root) => [...new Set(
    [...root.querySelectorAll<HTMLElement>('input:not([type="checkbox"]), textarea')].map((el) => getComputedStyle(el).fontSize),
  )]);
}

test.beforeAll(async () => {
  for (const apt of [APT, APT_B, APT_OLD, APT_PUB, APT_SKIP, APT_LAY, APT_LAY_B, APT_GONE, APT_TAKEN, APT_ROW, APT_ROW_B, APT_S1, APT_S2]) {
    const c = await pool.query<{ id: string }>(`insert into public.contacts (apartment_number) values ($1) returning id`, [apt]);
    made.contacts[apt] = c.rows[0]!.id;
  }
  await storage.start(Number(storageUrl.port || 54321));
});

test.afterAll(async () => {
  const contactIds = Object.values(made.contacts);
  const chips = await pool.query<{ id: string }>(`select id from public.chips where contact_id = any($1::uuid[])`, [contactIds]);
  for (const { id } of chips.rows) {
    await pool.query(`delete from public.chip_events where chip_id = $1`, [id]);
    await pool.query(`delete from public.chips where id = $1`, [id]);
  }
  for (const id of made.orders) await pool.query(`delete from public.chip_orders where id = $1`, [id]);
  for (const id of contactIds) await pool.query(`delete from public.contacts where id = $1`, [id]);
  await storage.stop();
  await pool.end();
});

test('/chips opens on the chips view, unchanged, with the orders switch beside it', async ({ page }) => {
  await page.goto('/chips');
  await expect(page.getByRole('heading', { name: 'צ׳יפי כניסה' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'הנפק צ׳יפ' })).toBeVisible();
  await expect(page.getByPlaceholder('חפש לפי מספר צ׳יפ, מספר דירה או שם דייר')).toBeVisible();
  await expect(page.getByRole('tab', { name: /צ׳יפים/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('chip-orders-table')).toHaveCount(0);
});

// "צ׳יפים" moved from "כספים" to "אבטחה" (24/11/2026) — the item alone; its
// route and its `chips` permission did not move. Whoever sees both items of
// "אבטחה" (this user) gets the ordinary panel. The other case — the guard, who
// sees one item, for whom the rail button stays a direct link to /visitors —
// is pinned in e2e/nav-rail.spec.ts ("who sees what") and in
// tests/nav-category-kind.test.ts.
test('the menu: "צ׳יפים" sits under "אבטחה", next to "סריקת כניסה", and no longer under "כספים"', async ({ page }) => {
  const rail = page.locator('aside nav[aria-label="קטגוריות ניווט"]');
  const category = (label: string) => rail.locator('[data-nav-category]', { hasText: new RegExp(`^${label}$`) });
  const panel = page.locator('aside [data-nav-panel]');
  const items = () => panel.locator('a[data-nav-item]').allInnerTexts();

  await page.goto('/chips');
  // The page's own category is shown, with the page's own item marked.
  await expect(panel).toHaveAttribute('data-nav-panel', 'security');
  await expect(category('אבטחה')).toHaveAttribute('data-nav-kind', 'panel');
  await expect(category('אבטחה')).toHaveAttribute('data-selected', 'true');
  expect(await items()).toEqual(['סריקת כניסה', 'צ׳יפים']);
  await expect(panel.locator('a[aria-current="page"]')).toHaveText('צ׳יפים');
  await category('כספים').click();
  await expect(panel).toHaveAttribute('data-nav-panel', 'finance');
  expect(await items()).toEqual(['ניהול חיובים', 'ניהול סטטוס חיובים', 'סקירה חודשית', 'סעיפים והגדרות']);

  // From another page: "אבטחה" opens its list without navigating (two items —
  // a panel, not a link), and "צ׳יפים" in it leads to /chips.
  await page.goto('/dashboard');
  await category('אבטחה').click();
  await expect(panel).toHaveAttribute('data-nav-panel', 'security');
  expect(new URL(page.url()).pathname).toBe('/dashboard');
  await panel.locator('a[data-nav-item="/chips"]').click();
  await expect(page).toHaveURL(/\/chips$/);
  await expect(page.getByRole('heading', { name: 'צ׳יפי כניסה' })).toBeVisible();
});

test.describe.serial('staff: the issue window', () => {
  const order = { id: '', orderNumber: 0, items: {} as Record<string, string> };

  test.beforeAll(async () => {
    Object.assign(order, await seedPaidOrder([
      { apt: APT, role: 'owner', name: 'דנה בדיקה', phone: P_OWNER, qty: 2 },
      { apt: APT, role: 'tenant', name: 'שרה שוכרת', phone: P_RENTER, qty: 1, leaseEnd: '2030-01-31' },
      { apt: APT_B, role: 'owner', name: 'דנה בדיקה', phone: P_OWNER, qty: 1 },
    ]));
  });

  test('without an order: one block, no transaction section, 6 chips with no reason, card / app, fee + "החיוב בוצע" + note saved, the switch disables and re-enables', async ({ page }) => {
    await page.goto('/chips');
    await page.getByRole('button', { name: 'הנפק צ׳יפ' }).click();
    const issue = issueWindow(page);
    await expect(issue.getByText('בחר דירה כדי להוסיף בעלי צ׳יפ')).toBeVisible();
    await pickApartment(page, APT);
    const block = issue.getByTestId('chip-holder-block');
    await expect(block).toHaveCount(1);
    await expect(block).toContainText('בעל צ׳יפ חדש');
    // APT has an open order, and still: no transaction section here.
    await expect(issue.getByTestId('chip-order-section')).toHaveCount(0);
    await expect(issue.getByTestId('chip-holder-registry-update')).toHaveCount(0);

    // "אני" has four states; the fourth, "אורח", is the stored role `other`.
    await expect(block.locator('.ci-roleseg').getByRole('radio')).toHaveText(['בעלים', 'שוכר', 'מפעיל', 'אורח']);
    await block.getByRole('radio', { name: 'אורח' }).click();
    await block.getByLabel('שם מלא').fill('מטפלת בדיקה');
    // Six chips on one person (the old cap of 4 per apartment, and the old 5
    // per save, are gone) — one of them an app.
    for (let k = 1; k <= 5; k++) await addChip(block, `N${tag}${k}`, k % 2 ? 'enter' : 'button');
    await block.getByRole('radio', { name: 'אפליקציה' }).click();
    await addChip(block, `N${tag}6`);
    await expect(block.getByTestId('chip-alloc-counter')).toHaveText('שויכו 6');
    await expect(issue.getByText('סיבת חריגה')).toHaveCount(0);

    // The three kept fields.
    await issue.getByLabel('עמלת הנפקה (₪)').fill('25');
    await issue.getByRole('checkbox', { name: 'החיוב בוצע' }).check();
    await issue.getByLabel('הערה', { exact: true }).fill('הערת בדיקה');
    await issue.getByTestId('chip-issue-save').click();
    await expect(issue).toHaveCount(0);
    const saved = (await pool.query<{ chip_number: string; chip_type: string; status: string; issuance_fee: number; fee_charged: boolean; notes: string; limit_override_reason: string | null; order_item_id: string | null }>(
      `select chip_number, chip_type, status, issuance_fee::float8 as issuance_fee, fee_charged, notes, limit_override_reason, order_item_id
         from public.chips where contact_id = $1 order by chip_number`, [made.contacts[APT]],
    )).rows;
    expect(saved).toHaveLength(6);
    for (const c of saved) {
      expect(c).toMatchObject({ status: 'active', issuance_fee: 25, fee_charged: true, notes: 'הערת בדיקה', limit_override_reason: null, order_item_id: null });
    }
    expect(saved.find((c) => c.chip_number === `N${tag}6`)!.chip_type).toBe('app');
    expect(saved.filter((c) => c.chip_type === 'physical')).toHaveLength(5);
    // "אורח" is a name on the screen only — the stored role did not change.
    expect((await pool.query(`select distinct resident_role from public.chips where contact_id = $1`, [made.contacts[APT]])).rows)
      .toEqual([{ resident_role: 'other' }]);
    // And it is the name of that role in the whole module, not only in this
    // window: the chips table and the holder's panel say "אורח", never "אחר".
    const search = page.getByPlaceholder('חפש לפי מספר צ׳יפ, מספר דירה או שם דייר');
    await search.fill(`N${tag}1`);
    await expect(page.locator('main').getByText('אורח', { exact: true }).locator('visible=true')).toHaveCount(1);
    await expect(page.locator('main').getByText('אחר', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'מטפלת בדיקה', exact: true }).click();
    const holderPanel = page.getByRole('dialog').filter({ hasText: 'מטפלת בדיקה' });
    await expect(holderPanel.getByText('אורח', { exact: true }).first()).toBeVisible();
    await expect(holderPanel.getByText('אחר', { exact: true })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(holderPanel).toHaveCount(0);
    await search.fill('');

    // The switch: off (asks once) and back on — immediate, never deleted.
    await page.getByRole('button', { name: 'הנפק צ׳יפ' }).click();
    await pickApartment(page, APT);
    const again = issue.getByTestId('chip-holder-block').filter({ hasText: 'מטפלת בדיקה' });
    page.once('dialog', (d) => void d.accept());
    await again.getByRole('button', { name: `השבת את N${tag}1` }).click();
    await expect.poll(async () => (await pool.query(`select status from public.chips where chip_number = $1`, [`N${tag}1`])).rows[0].status).toBe('inactive');
    await again.getByRole('button', { name: `החזר לפעיל את N${tag}1` }).click();
    await expect.poll(async () => (await pool.query(`select status from public.chips where chip_number = $1`, [`N${tag}1`])).rows[0].status).toBe('active');
    // Picking the apartment counts as an edit: closing asks first.
    await issue.getByRole('button', { name: 'סגור' }).last().click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'צא ללא שמירה' }).click();
    await expect(issue).toHaveCount(0);
  });

  test('a paid order: one block per person, the renter, one price line, chips per block, the counter, "הוסף בעל צ׳יפ" outside the paid quantity; "שמור שינויים" keeps the window open; "מוכן לאיסוף" in ONE click saves what is waiting and marks the order ready → collected', async ({ page }) => {
    await page.goto('/chips?view=orders');
    const row = orderRow(page, APT);
    await expect(row.filter({ hasText: APT_B })).toHaveCount(0);
    await expect(orderRow(page, APT_B)).toHaveCount(1);
    await expect(row.first()).toContainText('דנה בדיקה');
    await expect(row.first().getByTestId('chip-order-stage')).toHaveText('ממתין לשיוך');
    await row.first().click();

    const issue = issueWindow(page);
    const blocks = issue.getByTestId('chip-holder-block');
    await expect(blocks).toHaveCount(3);
    const [owner, renter, second] = [blocks.nth(0), blocks.nth(1), blocks.nth(2)];
    await expect(owner.getByLabel('שם מלא')).toHaveValue('דנה בדיקה');
    await expect(owner.getByRole('radio', { name: 'בעלים' })).toHaveAttribute('aria-checked', 'true');
    await expect(owner.getByLabel('טלפון נייד')).toHaveValue('0539300001');
    await expect(renter.getByLabel('שם מלא')).toHaveValue('שרה שוכרת');
    await expect(renter.getByRole('radio', { name: 'שוכר' })).toHaveAttribute('aria-checked', 'true');
    await expect(renter).toContainText('סיום חוזה: 31.01.2030');
    await expect(second).toContainText(`דירה ${APT_B}`);

    // The transaction section: one price line for the whole order.
    const section = issue.getByTestId('chip-order-section');
    await expect(section).toContainText(String(order.orderNumber));
    await expect(section).toContainText('dana.e2e@example.test');
    await expect(section.getByTestId('chip-order-progress')).toHaveText('0 מתוך 4');
    await expect(section).toContainText('כרטיס בקרת כניסה — 4×50₪');
    await expect(section).not.toContainText('הכרטיסים הראשונים');
    await expect(section).toContainText('200₪');
    const readyBtn = section.getByRole('button', { name: 'מוכן לאיסוף' });
    const reason = section.getByTestId('chip-order-ready-reason');
    const saveBtn = issue.getByTestId('chip-issue-save');
    const savedNumbers = async () => (await pool.query<{ chip_number: string }>(
      `select chip_number from public.chips where chip_number like $1 order by chip_number`, [`E2E${tag}%`],
    )).rows.map((r) => r.chip_number);
    const status = async () => (await pool.query(`select status from public.chip_orders where id = $1`, [order.id])).rows[0].status;
    // Off — and WHY is written under the buttons, not left to a tooltip.
    await expect(readyBtn).toBeDisabled();
    await expect(reason).toHaveText('יש לשייך את כל הצ׳יפים שהוזמנו — חסרים 4 צ׳יפים');

    await addChip(owner, `E2E${tag}1`, 'enter');
    await addChip(owner, `E2E${tag}2`, 'button');
    await expect(owner.getByTestId('chip-alloc-counter')).toHaveText('שויכו 2 מתוך 2');
    await expect(owner.getByTestId('chip-alloc-counter')).toHaveClass(/ci-full/);
    // A number still waiting in the window already counts toward "ready".
    await expect(reason).toHaveText('יש לשייך את כל הצ׳יפים שהוזמנו — חסרים 2 צ׳יפים');

    // "שמור שינויים" saves and STAYS (until 24/11/2026 it closed the window):
    // a success message, and the window reloaded on what is stored now.
    await saveBtn.click();
    await expect(toast(page, '2 צ׳יפים הונפקו')).toBeVisible();
    await expect(owner.getByRole('button', { name: `השבת את E2E${tag}1` })).toBeVisible(); // a saved chip: it has the switch
    await expect(issue.getByText('ממתין לשמירה')).toHaveCount(0);
    await expect(saveBtn).toBeDisabled(); // nothing is left to save
    await expect(issue).toBeVisible();
    await expect(section.getByTestId('chip-order-progress')).toHaveText('2 מתוך 4');
    await expect(readyBtn).toBeDisabled();
    await expect(reason).toHaveText('יש לשייך את כל הצ׳יפים שהוזמנו — חסרים 2 צ׳יפים');
    expect(await savedNumbers()).toEqual([`E2E${tag}1`, `E2E${tag}2`]);
    // The row behind the window followed, in place.
    await expect(orderRow(page, APT).first().getByTestId('chip-order-stage')).toHaveText('שויכו 2 מתוך 3');

    await renter.getByRole('radio', { name: 'אפליקציה' }).click();
    await addChip(renter, `E2E${tag}3`);
    await expect(reason).toHaveText('יש לשייך את כל הצ׳יפים שהוזמנו — חסר צ׳יפ אחד');
    await expect(readyBtn).toBeDisabled();
    await addChip(second, `E2E${tag}4`);

    // A holder the staff adds: not part of the paid quantity (no "מתוך").
    await issue.getByRole('button', { name: 'הוסף בעל צ׳יפ' }).click();
    await expect(blocks).toHaveCount(4);
    const staff = blocks.nth(3);
    await staff.getByLabel('שם מלא').fill('עובד צוות');
    await addChip(staff, `E2E${tag}5`);
    await expect(staff.getByTestId('chip-alloc-counter')).toHaveText('שויכו 1');

    // Every ordered chip is covered now — two saved, two still waiting — so
    // "מוכן לאיסוף" is on, and the line under the buttons is gone. Nothing of
    // the three new numbers is saved yet.
    await expect(readyBtn).toBeEnabled();
    await expect(reason).toHaveCount(0);
    expect(await savedNumbers()).toEqual([`E2E${tag}1`, `E2E${tag}2`]);
    expect(await status()).toBe('paid');

    // ONE click: the window is saved, then the order is marked ready — and the
    // window stays open, on the new status.
    await readyBtn.click();
    await expect(toast(page, 'סומן מוכן לאיסוף — נשלחה הודעה למזמין')).toBeVisible();
    await expect(issue).toBeVisible();
    expect(await status()).toBe('ready');
    const chips = (await pool.query<{ chip_number: string; chip_type: string; order_item_id: string; full_name: string; source: string; chips_count: number }>(
      `select c.chip_number, c.chip_type, c.order_item_id, h.full_name, h.source, h.chips_count
         from public.chips c join public.chip_order_holders h on h.id = c.order_holder_id
        where c.chip_number like $1 order by c.chip_number`, [`E2E${tag}%`],
    )).rows;
    expect(chips.map((c) => [c.chip_number, c.full_name, c.source])).toEqual([
      [`E2E${tag}1`, 'דנה בדיקה', 'order'], [`E2E${tag}2`, 'דנה בדיקה', 'order'], [`E2E${tag}3`, 'שרה שוכרת', 'order'],
      [`E2E${tag}4`, 'דנה בדיקה', 'order'], [`E2E${tag}5`, 'עובד צוות', 'staff'],
    ]);
    expect(chips.find((c) => c.source === 'staff')!.chips_count).toBe(0);
    expect(chips[2]!.chip_type).toBe('app');
    expect(chips[3]!.order_item_id).toBe(order.items[APT_B]);
    // Issuing wrote nothing to the tenants list.
    expect((await pool.query(`select owner_name, owner_phone from public.contacts where id = $1`, [made.contacts[APT]])).rows[0])
      .toEqual({ owner_name: null, owner_phone: null });

    // The window, reloaded: nothing is waiting, all four are linked, the staff
    // holder is a saved block. The three buttons stay: the stage the order is
    // in now is a mark, the next step is the one button to press, and there is
    // no way back or to reject. There is no "בטיפול" — the system has no such
    // status.
    await expect(issue.getByText('ממתין לשמירה')).toHaveCount(0);
    await expect(blocks).toHaveCount(4);
    await expect(section.getByTestId('chip-order-progress')).toHaveText('4 מתוך 4');
    await expect(saveBtn).toBeDisabled();
    await expect(readyBtn).toHaveAttribute('aria-current', 'step');
    await expect(readyBtn).toBeDisabled();
    await expect(reason).toHaveText('ההזמנה כבר מוכנה לאיסוף — השלב הבא: „נאסף”');
    await expect(section.getByText('בטיפול')).toHaveCount(0);
    await expect(section.getByRole('button', { name: 'דחה', exact: true })).toBeDisabled();
    await expect(section.getByRole('button', { name: 'נאסף', exact: true })).toBeEnabled();
    // The "ready" message was attempted on both channels, each on its own —
    // once, and the audit row is the one "מוכן לאיסוף" always wrote.
    await expect.poll(async () => (await pool.query(
      `select count(distinct channel)::int as n from public.chip_order_notifications where order_id = $1 and kind = 'ready'`,
      [order.id],
    )).rows[0].n, { timeout: 30_000 }).toBe(2);
    expect((await pool.query(`select count(*)::int as n from public.chip_order_notifications where order_id = $1 and kind = 'ready'`, [order.id])).rows[0].n).toBe(2);
    await expect.poll(async () => (await pool.query(
      `select count(*)::int as n from public.audit_log where entity_type = 'chip_order' and entity_id = $1 and action = 'ready'`, [order.id],
    )).rows[0].n).toBe(1);

    await section.getByRole('button', { name: 'נאסף', exact: true }).click();
    await expect(issue).toHaveCount(0);
    await expect.poll(status).toBe('collected');
    await expect(orderRow(page, APT)).toHaveCount(0);
    await expect(orderRow(page, APT_B)).toHaveCount(0);

    // The chips are in the "צ׳יפים" tab like any other chip.
    await page.getByRole('tab', { name: /צ׳יפים/ }).click();
    await page.getByPlaceholder('חפש לפי מספר צ׳יפ, מספר דירה או שם דייר').fill(`E2E${tag}3`);
    await expect(page.getByText(`E2E${tag}3`).first()).toBeVisible();
  });

  // The numbers the test above issued are active chips now.
  test('"מוכן לאיסוף" in one click with a number another chip holds: nothing is saved, nothing is marked ready, the reason is on the screen; with a free number the same click goes through', async ({ page }) => {
    const o = await seedPaidOrder([{ apt: APT_TAKEN, role: 'owner', name: 'תמר תפוסה', phone: P_OWNER, qty: 1 }]);
    const status = async () => (await pool.query(`select status from public.chip_orders where id = $1`, [o.id])).rows[0].status;
    const linked = async () => (await pool.query<{ chip_number: string }>(
      `select chip_number from public.chips where order_item_id = $1 order by chip_number`, [o.items[APT_TAKEN]],
    )).rows.map((r) => r.chip_number);
    await page.goto('/chips?view=orders');
    await orderRow(page, APT_TAKEN).click();
    const issue = issueWindow(page);
    const block = issue.getByTestId('chip-holder-block');
    const section = issue.getByTestId('chip-order-section');
    const readyBtn = section.getByRole('button', { name: 'מוכן לאיסוף' });
    const reason = section.getByTestId('chip-order-ready-reason');
    await expect(reason).toHaveText('יש לשייך את כל הצ׳יפים שהוזמנו — חסר צ׳יפ אחד');

    // A number typed into the box and NOT added with "הוסף" counts as well —
    // the click saves it too.
    const box = block.getByLabel(/^מספר צ׳יפ/);
    await box.fill(`E2E${tag}1`);
    await expect(readyBtn).toBeEnabled();
    await expect(reason).toHaveCount(0);
    await readyBtn.click();
    // The save was refused, so nothing went on: the error of any save, the
    // order still paid, no chip, no message, no audit row. The refused number
    // left the box and became a row of its own, in red, with an X — so the
    // line under the buttons points at something that is really there.
    await expect(issue.locator('.ci-alert')).toContainText(`מספר צ׳יפ E2E${tag}1 כבר פעיל במערכת`);
    await expect(block.locator('.ci-chiprow.ci-conflict')).toContainText(`E2E${tag}1`);
    await expect(block.getByText('מספר תפוס')).toBeVisible();
    await expect(box).toHaveValue('');
    await expect(readyBtn).toBeDisabled();
    await expect(reason).toHaveText('יש להסיר או להחליף את מספר הצ׳יפ התפוס שמסומן באדום');
    expect(await status()).toBe('paid');
    expect(await linked()).toEqual([]);
    expect((await pool.query(`select count(*)::int as n from public.chip_order_notifications where order_id = $1 and kind = 'ready'`, [o.id])).rows[0].n).toBe(0);
    expect((await pool.query(`select count(*)::int as n from public.audit_log where entity_type = 'chip_order' and entity_id = $1`, [o.id])).rows[0].n).toBe(0);

    // Removing the red number is enough to move on: the refusal does not stick.
    await block.getByRole('button', { name: `הסר את המספר E2E${tag}1 מהרשימה` }).click();
    await expect(reason).toHaveText('יש לשייך את כל הצ׳יפים שהוזמנו — חסר צ׳יפ אחד');
    // The same with a number that WAS added to the list (another active chip).
    await addChip(block, `E2E${tag}2`);
    await readyBtn.click();
    await expect(issue.locator('.ci-alert')).toContainText(`מספר צ׳יפ E2E${tag}2 כבר פעיל במערכת`);
    await expect(block.locator('.ci-chiprow.ci-conflict')).toContainText(`E2E${tag}2`);
    await expect(readyBtn).toBeDisabled();
    expect(await status()).toBe('paid');
    expect(await linked()).toEqual([]);

    // The red number out, a free one in: the same one click saves and marks.
    await block.getByRole('button', { name: `הסר את המספר E2E${tag}2 מהרשימה` }).click();
    await expect(reason).toHaveText('יש לשייך את כל הצ׳יפים שהוזמנו — חסר צ׳יפ אחד');
    await addChip(block, `TK${tag}1`);
    await readyBtn.click();
    await expect.poll(status).toBe('ready');
    await expect(readyBtn).toHaveAttribute('aria-current', 'step');
    expect(await linked()).toEqual([`TK${tag}1`]);
    await expect(block.getByRole('button', { name: `השבת את TK${tag}1` })).toBeVisible();
    await issue.getByTestId('chip-issue-close').click();
    await expect(issue).toHaveCount(0);
    // The row followed: ready, with "נאסף" as its quick step.
    await expect(orderRow(page, APT_TAKEN).getByTestId('chip-order-stage')).toHaveText('מוכן לאיסוף');
  });

  test('an order made before 21/11/2026 keeps the two price lines it was sold with, in one block from the order', async ({ page }) => {
    const o = await pool.query<{ id: string; order_number: number }>(
      `insert into public.chip_orders
         (full_name, phone_e164, email, address, role, status, total, tracking_token, paid_at, due_at,
          grow_process_id, grow_transaction_id, grow_asmachta)
       values ('ותיק בדיקה', '+972539300003', 'old.e2e@example.test', 'רחוב בדיקה 3', 'owner', 'paid', 170, $1, now(), now() + interval '3 days',
               $2, $3, 'e2e')
       returning id, order_number`,
      [randomBytes(32).toString('base64url'), `e2e-p-${tag}-old`, `e2e-t-${tag}-old`],
    );
    made.orders.push(o.rows[0]!.id);
    await pool.query(
      `insert into public.chip_order_items
         (order_id, contact_id, apartment_number, chips_count, unit_price, threshold, price_above, line_total, match_status)
       values ($1, $2, $3, 3, 50, 2, 70, 170, 'unassigned')`,
      [o.rows[0]!.id, made.contacts[APT_OLD], APT_OLD],
    );
    await page.goto('/chips?view=orders');
    await orderRow(page, APT_OLD).click();
    const issue = issueWindow(page);
    const blocks = issue.getByTestId('chip-holder-block');
    await expect(blocks).toHaveCount(1);
    await expect(blocks.getByLabel('שם מלא')).toHaveValue('ותיק בדיקה');
    const section = issue.getByTestId('chip-order-section');
    await expect(section).toContainText('2 הכרטיסים הראשונים לכל דירה — 2×50₪');
    await expect(section).toContainText('מהכרטיס ה-3 ואילך — 1×70₪');
    await expect(section).toContainText('170₪');
    await issue.getByRole('button', { name: 'סגור' }).last().click();
    await expect(issue).toHaveCount(0);
  });
});

// The v2 look (ref/chip-order/chip-issue-admin-v2.html), kept as numbers. On
// orders of its own and outside the serial flow above: a cosmetic miss here
// must never skip "save → ready → collected".
test.describe('staff: the look of the issue window', () => {
  test.beforeAll(async () => {
    await seedPaidOrder([
      { apt: APT_LAY, role: 'owner', name: 'דנה בדיקה', phone: P_OWNER, qty: 2 },
      { apt: APT_LAY, role: 'tenant', name: 'שרה שוכרת', phone: P_RENTER, qty: 1, leaseEnd: '2030-01-31' },
      { apt: APT_LAY_B, role: 'owner', name: 'דנה בדיקה', phone: P_OWNER, qty: 1 },
    ]);
  });

  test('the layout: the panel on the left edge at 60% of the viewport and never under 780px, nothing cut or scrolling sideways from 1920 down to 320, the two breakpoints to the pixel, a one-line registry button, the footer order, the three status buttons with no hole between them', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/chips?view=orders');
    await orderRow(page, APT_LAY).first().click();
    const issue = issueWindow(page);
    const section = issue.getByTestId('chip-order-section');
    await expect(section).toBeVisible();
    const body = issue.getByTestId('chip-issue-body');
    const blocks = issue.getByTestId('chip-holder-block');
    await expect(blocks).toHaveCount(3);
    const columns = (el: Locator) => el.first().evaluate((node) => getComputedStyle(node).gridTemplateColumns.split(' ').length);

    // The panel is 60% of the viewport from 1300px up (1920 → 1152, 1440 →
    // 864, 1366 → 819.6), the reference's 780px under that (1300, 1299, 1024),
    // and the whole screen where 780px do not fit. 701 and 541 are one pixel
    // above the reference's breakpoints: the layout must not have moved yet
    // there, and must have moved at 700 and at 540.
    for (const width of [1920, 1440, 1366, 1300, 1299, 1024, 780, 701, 700, 541, 540, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      // The sheet slides in for 1.2s — wait until the panel rests on the edge.
      await expect.poll(async () => (await issue.boundingBox())!.x, { message: `panel on the left edge @${width}` }).toBe(0);
      expect((await issue.boundingBox())!.width, `panel width @${width}`).toBeCloseTo(panelWidth(width), 0);
      // Nothing scrolls sideways and nothing is cut: the body is not wider than
      // it shows (it has no overflow-x guard), and no clipping box of the
      // window — panel, section, block, card — hides content.
      expect(await body.evaluate((el) => el.scrollWidth - el.clientWidth), `the body scrolls sideways @${width}`).toBeLessThanOrEqual(0);
      expect(await cutOff(issue), `content cut off sideways @${width}`).toEqual([]);

      // "עדכן בכרטיס הדייר": one line of text in a 38px button, whatever the width.
      for (const btn of await issue.getByTestId('chip-holder-registry-update').all()) {
        expect(await textLines(btn), `registry button lines @${width}`).toBe(1);
        expect((await btn.boundingBox())!.height, `registry button height @${width}`).toBeCloseTo(38, 0);
      }
      // The reference's breakpoints: 700px and 540px.
      expect(await columns(section.locator('.ci-invwho')), `order grid columns @${width}`).toBe(width > 700 ? 3 : 2);
      expect(await columns(issue.locator('.ci-mainrow')), `name / apartment / quantity @${width}`).toBe(width > 700 ? 3 : 2);
      expect(await columns(issue.locator('.ci-frow')), `phone / email @${width}`).toBe(width > 540 ? 2 : 1);
      expect(await columns(issue.getByRole('radiogroup', { name: 'אני' })), `role buttons @${width}`).toBe(width > 540 ? 4 : 2);
      // A desktop keeps the reference's 14px in the fields at every width.
      expect(await fieldSizes(issue), `field font size @${width}`).toEqual(['14px']);

      // Footer: "שמור שינויים" at the left, "סגור" right beside it (10px).
      const save = (await issue.getByTestId('chip-issue-save').boundingBox())!;
      const close = (await issue.getByTestId('chip-issue-close').boundingBox())!;
      expect(save.x, `"שמור שינויים" is left of "סגור" @${width}`).toBeLessThan(close.x);
      expect(close.x - (save.x + save.width), `gap between the two @${width}`).toBeCloseTo(10, 0);
      expect(close.y, `one row @${width}`).toBeCloseTo(save.y, 0);

      // The status row is tight at every width, on one line or wrapped: no
      // hole where the reference's "בטיפול" would have been.
      expect(await statusRowGaps(issue), `status row spacing @${width}`).toEqual([]);

      // A wide window stretches the fields, never a sentence: a line of the
      // note stays as long as in the reference's 780px panel (676px), while
      // its box keeps the width of the row above it.
      const note = await issue.getByLabel('הערה', { exact: true }).evaluate((el) => {
        const cs = getComputedStyle(el);
        return { box: el.getBoundingClientRect().width, line: el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) };
      });
      const feeRow = (await issue.locator('.ci-feegrid').boundingBox())!.width;
      expect(note.box, `the note's box is as wide as the fee row @${width}`).toBeCloseTo(feeRow, 0);
      expect(note.line, `a line of the note @${width}`).toBeLessThanOrEqual(676.5);
      if (width >= 780) expect(note.line, `a line of the note @${width}`).toBeCloseTo(676, 0);
    }

    // The panel's own text settings win over the Sheet primitive's utilities.
    expect(await issue.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { size: cs.fontSize, color: cs.color };
    })).toEqual({ size: '16px', color: 'rgb(26, 34, 51)' });
    // "אני": four states, the stored role of the block selected.
    await expect(blocks.first().getByRole('radiogroup', { name: 'אני' }).getByRole('radio')).toHaveText(['בעלים', 'שוכר', 'מפעיל', 'אורח']);
    // The status row of a real order: the three real actions and nothing else.
    // The reference's "בטיפול" is left out — the system has no such status —
    // so a paid order carries no stage mark in the row. "מוכן לאיסוף" waits
    // for the chips, "נאסף" waits for "מוכן לאיסוף".
    const actions = issue.getByTestId('chip-order-actions');
    await expect(actions.getByRole('button')).toHaveText(['מוכן לאיסוף', 'נאסף', 'דחה']);
    await expect(actions.locator('[aria-current="step"]')).toHaveCount(0);
    await expect(issue.getByText('בטיפול')).toHaveCount(0);
    await expect(actions.getByRole('button', { name: 'מוכן לאיסוף' })).toBeDisabled();
    await expect(actions.getByRole('button', { name: 'נאסף', exact: true })).toBeDisabled();
    await expect(actions.getByRole('button', { name: 'דחה', exact: true })).toBeEnabled();
    // Why "מוכן לאיסוף" is off is a line of text under the row, on the screen.
    await expect(section.getByTestId('chip-order-ready-reason')).toHaveText('יש לשייך את כל הצ׳יפים שהוזמנו — חסרים 4 צ׳יפים');
    await expect(section.getByTestId('chip-order-ready-reason')).toBeVisible();
    // Numbers: Inter, tabular, isolated left-to-right.
    const num = await section.getByTestId('chip-order-progress').locator('.ci-num').first().evaluate((el) => {
      const cs = getComputedStyle(el);
      return { family: cs.fontFamily.split(',')[0]!.replace(/["']/g, '').trim(), numeric: cs.fontVariantNumeric, direction: cs.direction, bidi: cs.unicodeBidi };
    });
    expect(num).toEqual({ family: 'Inter', numeric: 'tabular-nums', direction: 'ltr', bidi: 'isolate' });

    await page.setViewportSize({ width: 1280, height: 720 });
    await issue.getByTestId('chip-issue-close').click();
    await expect(issue).toHaveCount(0);
  });

  // iOS zooms the page into a focused field under 16px and stays zoomed. The
  // one media query of the window that is not a layout breakpoint: a touch
  // screen under 768px, or a phone on its side.
  test('a touch phone gets 16px fields, upright and on its side; a touch tablet keeps the 14px of the reference', async ({ browser }) => {
    for (const [what, viewport, size] of [
      ['a phone', { width: 390, height: 844 }, '16px'],
      ['a phone on its side', { width: 844, height: 390 }, '16px'],
      ['a tablet', { width: 900, height: 1200 }, '14px'],
    ] as const) {
      const ctx = await browser.newContext({ storageState: 'e2e/.auth/state.json', viewport, isMobile: true, hasTouch: true, locale: 'he-IL' });
      const page = await ctx.newPage();
      try {
        await page.goto('/chips?view=orders');
        // The order's row: a table row from 640px, a card under it.
        await page.locator('[data-testid="chip-order-row"]:visible, [data-testid="chip-order-card"]:visible').filter({ hasText: APT_LAY }).first().click();
        const issue = issueWindow(page);
        await expect(issue.getByTestId('chip-order-section')).toBeVisible();
        expect(await fieldSizes(issue), `field font size on ${what}`).toEqual([size]);
      } finally {
        await ctx.close();
      }
    }
  });

  // The Orders tab lists open orders only, but it does not refresh on its own:
  // a row another user already closed still opens the window. The status row
  // then marks where the order stands and offers nothing to press.
  test('an order closed somewhere else while its row is still on the screen: the closing stage is the mark, every status button is off', async ({ page }) => {
    const gone = await seedPaidOrder([{ apt: APT_GONE, role: 'owner', name: 'גלית בדיקה', phone: P_OWNER, qty: 1 }]);
    await page.goto('/chips?view=orders');
    const row = orderRow(page, APT_GONE);
    await expect(row).toHaveCount(1);
    const issue = issueWindow(page);
    const actions = issue.getByTestId('chip-order-actions');

    for (const [mark, close] of [
      ['נאסף', `update public.chip_orders set status = 'collected', collected_at = now() where id = $1`],
      ['דחה', `update public.chip_orders set status = 'rejected', rejected_at = now(), reject_reason = 'e2e' where id = $1`],
    ] as const) {
      await pool.query(close, [gone.id]);
      await row.click();
      await expect(actions.getByRole('button')).toHaveText(['מוכן לאיסוף', 'נאסף', 'דחה']);
      await expect(actions.locator('[aria-current="step"]')).toHaveText(mark);
      for (const button of await actions.getByRole('button').all()) await expect(button).toBeDisabled();
      // …and the line under the row says why nothing can be pressed.
      await expect(issue.getByTestId('chip-order-ready-reason')).toHaveText(mark === 'נאסף' ? 'ההזמנה כבר נאספה' : 'ההזמנה נדחתה');
      await issue.getByTestId('chip-issue-close').click();
      await expect(issue).toHaveCount(0);
    }
  });
});

// The Orders tab itself (24/11/2026): the quick status button of a row, the
// search, "ייצוא לאקסל" and "הדפסה". Orders of its own.
test.describe('staff: the Orders tab', () => {
  test('the quick status button of a row: off with the reason until every chip of the ORDER is issued; "מוכן לאיסוף" and "נאסף" ask first, never open the window, and the rows follow in place — also on a phone card', async ({ page }) => {
    const o = await seedPaidOrder([
      { apt: APT_ROW, role: 'owner', name: 'רותם שורה', phone: P_OWNER, qty: 1 },
      { apt: APT_ROW_B, role: 'owner', name: 'רותם שורה', phone: P_OWNER, qty: 1 },
    ]);
    const status = async () => (await pool.query(`select status from public.chip_orders where id = $1`, [o.id])).rows[0].status;
    const audits = async (action: string) => (await pool.query(
      `select count(*)::int as n from public.audit_log where entity_type = 'chip_order' and entity_id = $1 and action = $2`, [o.id, action],
    )).rows[0].n;
    await page.goto('/chips?view=orders');
    const rowA = orderRow(page, APT_ROW);
    const rowB = orderRow(page, APT_ROW_B);
    const issue = issueWindow(page);
    const blocks = issue.getByTestId('chip-holder-block');
    const dialog = page.getByRole('alertdialog');

    // Nothing is issued: "מוכן לאיסוף" is off, the reason is written under it,
    // and "נאסף" is not offered before its turn.
    for (const r of [rowA, rowB]) {
      await expect(r.getByTestId('chip-order-row-ready')).toBeDisabled();
      await expect(r.getByTestId('chip-order-row-reason')).toHaveText('חסרים 2 צ׳יפים בהזמנה');
      await expect(r.getByTestId('chip-order-row-collected')).toHaveCount(0);
    }
    // A 1024px window with the menu panel open leaves the card narrower than
    // the table: the table scrolls sideways inside the card, and the action
    // column stays pinned to the card's edge — in sight without scrolling.
    await page.setViewportSize({ width: 1024, height: 800 });
    const table = page.getByTestId('chip-orders-table');
    expect(await table.evaluate((el) => el.scrollWidth > el.parentElement!.clientWidth), 'the table is wider than its card at 1024').toBe(true);
    await expect(rowA.getByTestId('chip-order-row-ready')).toBeInViewport({ ratio: 1 });
    await expect(rowA.getByTestId('chip-order-row-reason')).toBeInViewport({ ratio: 1 });
    await noSideScroll(page);
    // The assistant's floating button lives in that same corner of the screen.
    // Scrolled to the end, the LAST row's button is clear of it: the card
    // leaves room under itself.
    await page.locator('main').evaluate((el) => el.scrollTo(0, el.scrollHeight));
    const lastButton = (await table.getByTestId('chip-order-row').last()
      .locator('[data-testid="chip-order-row-ready"], [data-testid="chip-order-row-collected"]').boundingBox())!;
    const floating = (await page.locator('[data-agent-fab]').boundingBox())!;
    expect(lastButton.y + lastButton.height, 'the last row\'s button ends above the floating button').toBeLessThanOrEqual(floating.y);
    await page.locator('main').evaluate((el) => el.scrollTo(0, 0));
    await page.setViewportSize({ width: 1280, height: 720 });

    // A button lives inside the row now, so the row itself is no button: a
    // mouse click anywhere on it opens the window, and for the keyboard (and
    // a screen reader) the orderer's name is the button that does.
    expect(await rowA.getAttribute('role')).toBeNull();
    await rowA.getByRole('button', { name: 'רותם שורה', exact: true }).press('Enter');
    await expect(issue).toBeVisible();
    await issue.getByTestId('chip-issue-close').click();
    await expect(issue).toHaveCount(0);

    // Apartment A gets its chip in the window. Its own stage is done — and its
    // button still waits, because the status belongs to the whole order.
    await rowA.click();
    await addChip(blocks.nth(0), `RW${tag}1`);
    await issue.getByTestId('chip-issue-save').click();
    await expect(issue.getByTestId('chip-issue-save')).toBeDisabled();
    await issue.getByTestId('chip-issue-close').click();
    await expect(issue).toHaveCount(0);
    await expect(rowA.getByTestId('chip-order-stage')).toHaveText('שויך');
    await expect(rowA.getByTestId('chip-order-row-ready')).toBeDisabled();
    await expect(rowA.getByTestId('chip-order-row-reason')).toHaveText('חסר צ׳יפ אחד בהזמנה');

    await rowB.click();
    await addChip(blocks.nth(1), `RW${tag}2`);
    await issue.getByTestId('chip-issue-save').click();
    await expect(issue.getByTestId('chip-issue-save')).toBeDisabled();
    await issue.getByTestId('chip-issue-close').click();
    await expect(issue).toHaveCount(0);

    // Every chip of the order is issued and saved: the button is on, on both
    // rows. It asks first — and it does not open the issue window.
    for (const r of [rowA, rowB]) {
      await expect(r.getByTestId('chip-order-row-ready')).toBeEnabled();
      await expect(r.getByTestId('chip-order-row-reason')).toHaveCount(0);
    }
    await rowB.getByTestId('chip-order-row-ready').click();
    await expect(dialog).toContainText(`לסמן את הזמנה ${o.orderNumber} כמוכנה לאיסוף?`);
    await expect(dialog).toContainText('תישלח הודעה למזמין, רותם שורה, במייל ובוואטסאפ');
    await expect(dialog).toContainText(`הסימון חל על ההזמנה כולה — דירות ${APT_ROW}, ${APT_ROW_B}.`);
    await expect(issue).toHaveCount(0);
    // "ביטול" changes nothing.
    await dialog.getByRole('button', { name: 'ביטול' }).click();
    await expect(dialog).toHaveCount(0);
    expect(await status()).toBe('paid');

    await rowB.getByTestId('chip-order-row-ready').click();
    await dialog.getByRole('button', { name: 'סמן מוכן לאיסוף' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(toast(page, 'סומן מוכן לאיסוף — נשלחה הודעה למזמין')).toBeVisible();
    // Both rows of the order follow in place: the stage, and the next step.
    for (const r of [rowA, rowB]) {
      await expect(r.getByTestId('chip-order-stage')).toHaveText('מוכן לאיסוף');
      await expect(r.getByTestId('chip-order-row-collected')).toBeEnabled();
      await expect(r.getByTestId('chip-order-row-ready')).toHaveCount(0);
    }
    expect(await status()).toBe('ready');
    // The same message and the same audit row as the window's button.
    await expect.poll(async () => (await pool.query(
      `select count(distinct channel)::int as n from public.chip_order_notifications where order_id = $1 and kind = 'ready'`, [o.id],
    )).rows[0].n, { timeout: 30_000 }).toBe(2);
    await expect.poll(() => audits('ready')).toBe(1);

    // "נאסף" — from the card of a phone, which carries the same button.
    await page.setViewportSize({ width: 390, height: 844 });
    const card = page.getByTestId('chip-order-card').filter({ hasText: APT_ROW_B });
    const collect = card.getByTestId('chip-order-row-collected');
    await expect(collect).toBeVisible();
    expect((await collect.boundingBox())!.height, 'a 44px touch target on a phone').toBeGreaterThanOrEqual(44);
    await noSideScroll(page);
    await collect.click();
    await expect(dialog).toContainText(`לסמן את הזמנה ${o.orderNumber} כנאספה?`);
    await expect(dialog).toContainText('לא נשלחת הודעה למזמין');
    await expect(issue).toHaveCount(0);
    await dialog.getByRole('button', { name: 'סמן כנאסף' }).click();
    await expect(dialog).toHaveCount(0);
    // Collected = out of the open list: both cards leave.
    await expect(page.getByTestId('chip-order-card').filter({ hasText: APT_ROW })).toHaveCount(0);
    await expect(page.getByTestId('chip-order-card').filter({ hasText: APT_ROW_B })).toHaveCount(0);
    expect(await status()).toBe('collected');
    await expect.poll(() => audits('collected')).toBe(1);
    // No message goes out on "נאסף".
    expect((await pool.query(`select count(*)::int as n from public.chip_order_notifications where order_id = $1 and kind <> 'ready'`, [o.id])).rows[0].n).toBe(0);
    await page.setViewportSize({ width: 1280, height: 720 });
  });

  test('search by apartment number and by name (the orderer, the people of the order); "ייצוא לאקסל" and "הדפסה" take the rows the search left', async ({ page }) => {
    const s1 = await seedPaidOrder([
      { apt: APT_S1, role: 'owner', name: 'גדעון חיפוש', phone: '+972539300011', qty: 2 },
      { apt: APT_S1, role: 'tenant', name: 'רינה שוכרת', phone: P_RENTER, qty: 1, leaseEnd: '2030-01-31' },
    ]);
    await seedPaidOrder([{ apt: APT_S2, role: 'owner', name: 'מיכל אחרת', phone: '+972539300012', qty: 1 }]);
    await page.goto('/chips?view=orders');
    const rows = page.getByTestId('chip-orders-table').getByTestId('chip-order-row');
    const search = page.getByTestId('chip-orders-search');
    await expect(orderRow(page, APT_S1)).toHaveCount(1);
    await expect(orderRow(page, APT_S2)).toHaveCount(1);

    // By apartment number.
    await search.fill(APT_S1);
    await expect(rows).toHaveCount(1);
    await expect(rows).toContainText('גדעון חיפוש');
    // By the orderer's name.
    await search.fill('מיכל');
    await expect(rows).toHaveCount(1);
    await expect(rows).toContainText(APT_S2);
    // By a person of the order who did not place it — and the row says who.
    await search.fill('רינה');
    await expect(rows).toHaveCount(1);
    await expect(rows).toContainText(APT_S1);
    await expect(rows.getByTestId('chip-order-row-hit')).toHaveText('בעל צ׳יפ בהזמנה: רינה שוכרת');
    // Every word must be found: one order's name with the other's apartment is nothing.
    await search.fill(`גדעון ${APT_S2}`);
    await expect(page.getByTestId('chip-orders-no-match')).toContainText(`אין הזמנות עבור „גדעון ${APT_S2}”`);
    await expect(page.getByTestId('chip-orders-export')).toBeDisabled();
    await expect(page.getByTestId('chip-orders-print')).toBeDisabled();
    await search.fill(`גדעון ${APT_S1}`);
    await expect(rows).toHaveCount(1);

    // "ייצוא לאקסל": the rows on the screen, in the agreed columns.
    const headers = ['מס׳ הזמנה', 'תאריך הזמנה', 'שם המזמין', 'טלפון', 'דירה', 'בעלי הצ׳יפ', 'כמות', 'סה״כ (₪)', 'סטטוס', 'יעד להכנה', 'הזמנת בדיקה'];
    const downloading = page.waitForEvent('download');
    await page.getByTestId('chip-orders-export').click();
    const download = await downloading;
    expect(download.suggestedFilename()).toMatch(/^chip-orders_\d{4}-\d{2}-\d{2}\.xlsx$/);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile((await download.path())!);
    const ws = wb.worksheets[0]!;
    const cells = (n: number) => (ws.getRow(n).values as unknown[]).slice(1);
    expect(ws.views[0]?.rightToLeft).toBe(true);
    expect(cells(1)).toEqual(headers);
    expect(ws.rowCount, 'the header and the one row the search left').toBe(2);
    // The order's date is the stored instant, in Israel time (read back from
    // the DB — "today" would be wrong for a run that crosses midnight).
    const ordered = (await pool.query<{ created_at: Date }>(`select created_at from public.chip_orders where id = $1`, [s1.id])).rows[0]!.created_at;
    expect(cells(2)).toEqual([
      s1.orderNumber, dateInIsrael(ordered), 'גדעון חיפוש', '0539300011', APT_S1, 'גדעון חיפוש, רינה שוכרת', 3, 150, 'ממתין לשיוך',
      expect.stringMatching(/^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/), 'לא',
    ]);

    // "הדפסה": the print dialog opens on a print-only table of the same rows —
    // right to left, and everything else on the page (the menu, the toolbar,
    // every button) hidden. `window.print` is replaced by a probe that reads
    // the page as the printer would get it (print media).
    interface Printed { text: string; dir: string; shown: string; controls: number; restHidden: boolean; headers: (string | null)[]; rows: number }
    await page.evaluate(() => {
      const w = window as unknown as { __printed: unknown };
      w.__printed = null;
      window.print = () => {
        const root = document.getElementById('chip-orders-print-root');
        w.__printed = root && {
          text: root.innerText,
          dir: getComputedStyle(root).direction,
          shown: getComputedStyle(root).display,
          controls: root.querySelectorAll('button, a, input').length,
          restHidden: [...document.body.children].filter((el) => el !== root).every((el) => getComputedStyle(el).display === 'none'),
          headers: [...root.querySelectorAll('th')].map((th) => th.textContent),
          rows: root.querySelectorAll('tbody tr').length,
        };
        // What a browser does when its print dialog closes — the page takes
        // the print-only table down on this, not when print() returns.
        window.dispatchEvent(new Event('afterprint'));
      };
    });
    await page.emulateMedia({ media: 'print' });
    // In print media the screen itself is hidden — the click is a DOM click.
    await page.getByTestId('chip-orders-print').evaluate((button: HTMLElement) => button.click());
    await expect.poll(() => page.evaluate(() => (window as unknown as { __printed: unknown }).__printed !== null)).toBe(true);
    const printed = await page.evaluate(() => (window as unknown as { __printed: Printed }).__printed);
    await page.emulateMedia({ media: null });
    expect(printed).toMatchObject({ dir: 'rtl', shown: 'block', controls: 0, restHidden: true, headers, rows: 1 });
    expect(printed.text).toContain('הזמנות צ׳יפים פתוחות');
    expect(printed.text).toContain(`סינון: „גדעון ${APT_S1}”`);
    expect(printed.text).toContain('גדעון חיפוש, רינה שוכרת');
    expect(printed.text).toContain(APT_S1);
    expect(printed.text).not.toContain('מיכל אחרת');
    // On the screen the print-only table never shows, and it is gone afterwards.
    await expect(page.locator('#chip-orders-print-root')).toHaveCount(0);
    await expect(rows).toHaveCount(1);

    // The other print view that shares print.css must still print: the debtor
    // card's own print page (what the tenant panel's printer button and the
    // PDF route render) shows its root in print media only because its selector
    // outranks the app-wide hide rule — a rule this change sits next to.
    const debtor = (await pool.query<{ id: string }>(`select id from public.debtors order by apartment_number limit 1`)).rows[0];
    expect(debtor, 'the e2e seed holds debtors').toBeTruthy();
    await page.goto(`/debtors/${debtor!.id}/print`);
    const card = page.locator('#debtor-detail-print');
    await expect(card).toBeVisible();
    await page.emulateMedia({ media: 'print' });
    expect(await card.evaluate((el) => getComputedStyle(el).display), 'the debtor card in print media').toBe('block');
    await page.emulateMedia({ media: null });
  });
});

test.describe('public page', () => {
  test.use({ storageState: { cookies: [], origins: [] }, viewport: { width: 390, height: 844 } });

  test('/chip-order is closed while Grow is not configured, and fits a phone', async ({ page }) => {
    test.skip(Boolean(process.env.GROW_USER_ID && process.env.GROW_PAGE_CODE && process.env.GROW_ENV), 'Grow is configured in this environment');
    await page.goto('/chip-order');
    await expect(page.getByTestId('chip-order-closed')).toContainText('ההזמנות ייפתחו בקרוב');
    await noSideScroll(page);
    // The write routes refuse while closed.
    const r = await page.request.post('/api/public/chip-order/otp/request', { data: { phone: '0539300001' } });
    expect(r.status()).toBe(403);
  });

  test('only /chip-order may frame Grow’s payment page; every other page keeps the global CSP', async ({ page }) => {
    const order = await page.request.get('/chip-order');
    const csp = order.headers()['content-security-policy'] ?? '';
    expect(csp).toContain("frame-src 'self' https://meshulam.co.il https://*.meshulam.co.il");
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp.match(/default-src/g)).toHaveLength(1); // one policy, not two stacked
    const login = await page.request.get('/login');
    expect(login.headers()['content-security-policy']).not.toContain('meshulam');
  });

  test('a tracking link of an unknown token is a 404, and the page never leaks order details', async ({ page }) => {
    const res = await page.goto(`/chip-order/track/${randomBytes(32).toString('base64url')}`);
    expect(res?.status()).toBe(404);
  });
});

// ── Test mode ──────────────────────────────────────────────────────────────
// The settings switch makes a secret link; with it /chip-order opens without
// Grow under a pinned "מצב בדיקה, אין חיוב" strip, the code arrives on
// WhatsApp (the Green API stub, as in portal-login-otp.spec.ts), the pay
// button finishes the test order on the server (no Grow, no charge) and shows
// the confirmation. A wrong token or no token is the closed page — no hint.
// The previous settings rows are put back afterwards.
test.describe.serial('test mode', () => {
  const STUB = `http://127.0.0.1:${process.env.E2E_GREENAPI_PORT ?? 3110}`;
  const phoneDigits = `05393${String(Date.now()).slice(-5)}`;
  const phoneE164 = `+972${phoneDigits.slice(1)}`;
  const renterDigits = `05395${String(Date.now()).slice(-5)}`;
  const PRICE = 45; // set through /settings below — the page must follow it
  const state = { link: '', orderId: '', orderNumber: 0, rows: {} as Record<string, unknown>, leaseKey: '' };
  const skipState = { orderId: '', phone: '' };
  const saved = { testMode: null as unknown, chipOrders: null as unknown };

  test.beforeAll(async () => {
    const r = await pool.query<{ key: string; value: unknown }>(
      `select key, value from public.app_settings where key in ('chip_orders_test_mode', 'chip_orders')`,
    );
    for (const row of r.rows) {
      if (row.key === 'chip_orders_test_mode') saved.testMode = row.value;
      else saved.chipOrders = row.value;
    }
    // The old price rule's keys, stored as before 21/11/2026 — a save on the
    // new screen must keep them (nothing reads them any more).
    await pool.query(
      `insert into public.app_settings (key, value) values ('chip_orders', $1::jsonb)
       on conflict (key) do update set value = excluded.value`,
      [JSON.stringify({ unitPrice: 50, threshold: 2, priceAbove: 70, maxPerApartment: 4, pickupText: '', termsText: '', ordersOpen: false })],
    );
  });

  test.afterAll(async () => {
    for (const id of [state.orderId, skipState.orderId].filter(Boolean)) {
      await pool.query(`delete from public.chip_orders where id = $1 and is_test`, [id]);
    }
    await pool.query(`delete from public.portal_otp_codes where phone_e164 = any($1::text[])`, [[phoneE164, skipState.phone].filter(Boolean)]);
    for (const [key, value] of [['chip_orders_test_mode', saved.testMode], ['chip_orders', saved.chipOrders]] as const) {
      if (value === null) await pool.query(`delete from public.app_settings where key = $1`, [key]);
      else await pool.query(`update public.app_settings set value = $2::jsonb where key = $1`, [key, JSON.stringify(value)]);
    }
  });

  test('settings: one price per chip — no threshold, price-above or maximum field; the save keeps the old stored keys', async ({ page }) => {
    await page.goto('/settings');
    const card = page.getByTestId('chip-order-settings');
    const price = card.getByLabel('מחיר לצ׳יפ (₪)');
    await expect(price).toHaveValue('50');
    await expect(card.getByText('סף — כמה צ׳יפים לדירה במחיר הבסיס')).toHaveCount(0);
    await expect(card.getByText('מחיר לצ׳יפ מעל הסף (₪)')).toHaveCount(0);
    await expect(card.getByText('מקסימום צ׳יפים לדירה בהזמנה')).toHaveCount(0);
    await price.fill(String(PRICE));
    await card.getByRole('button', { name: 'שמור', exact: true }).click();
    await expect.poll(async () => (await pool.query(`select value from public.app_settings where key = 'chip_orders'`)).rows[0].value)
      .toMatchObject({ unitPrice: PRICE, threshold: 2, priceAbove: 70, maxPerApartment: 4 });
  });

  test('settings: switching test mode on shows a secret link with a copy button', async ({ page }) => {
    await page.goto('/settings');
    const section = page.getByTestId('chip-order-test-mode');
    await expect(section).toBeVisible();
    const sw = section.getByRole('switch', { name: 'מצב בדיקה' });
    if ((await sw.getAttribute('aria-checked')) === 'true') {
      await sw.click();
      await expect(sw).toHaveAttribute('aria-checked', 'false');
    }
    await sw.click();
    const link = section.getByTestId('chip-order-test-link');
    await expect(link).toBeVisible();
    state.link = await link.inputValue();
    expect(state.link).toMatch(/\/chip-order\?test=[A-Za-z0-9_-]{43}$/);
    await expect(section.getByRole('button', { name: 'העתק' })).toBeVisible();
  });

  test('a wrong token (or none) is the closed page — no hint of test mode, every write 403', async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page = await ctx.newPage();
    const token = new URL(state.link).searchParams.get('test')!;
    const wrong = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
    await page.goto(`/chip-order?test=${wrong}`);
    await expect(page.getByTestId('chip-order-closed')).toBeVisible();
    await expect(page.getByTestId('chip-order-test-banner')).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText('מצב בדיקה');
    const r = await page.request.post('/api/public/chip-order/test-finish', {
      headers: { 'x-chip-order-test': wrong }, data: { trackingToken: 'x'.repeat(43) },
    });
    expect(r.status()).toBe(403);
    expect((await page.request.post('/api/public/chip-order/test-finish', { data: { trackingToken: 'x'.repeat(43) } })).status()).toBe(403);
    await ctx.close();
  });

  test('with the link: an owner row and a renter row (prefilled, lease + end date), up to 10 per apartment, one flat price line, the note, the card never sent, the code on WhatsApp → the confirmation', async ({ browser }) => {
    await fetch(`${STUB}/__reset`, { method: 'POST' });
    const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] }, viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    const posted: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/public/chip-order') posted.push(r.postDataBuffer()?.toString('latin1') ?? '');
    });
    const res = await page.goto(new URL(state.link).pathname + new URL(state.link).search);
    expect(res?.headers()['referrer-policy']).toBe('no-referrer');
    await expect(page.getByTestId('chip-order-test-banner')).toHaveText('מצב בדיקה, אין חיוב');
    await expect(page.getByTestId('chip-order-closed')).toHaveCount(0);

    const rows = page.getByTestId('chip-order-line');
    const first = rows.nth(0);
    await expect(first.getByRole('radio', { name: 'בעלים' })).toHaveAttribute('aria-checked', 'true');
    await expect(first.getByRole('radio')).toHaveCount(2); // owner and renter only
    await first.getByLabel('שם מלא').fill('בודק בדיקה');
    await first.getByRole('button', { name: 'דירה, שורה 1' }).click();
    await page.getByLabel('חיפוש לפי מספר דירה').fill(APT_PUB);
    await page.getByLabel('חיפוש לפי מספר דירה').press('Enter');
    await expect(first.getByRole('button', { name: 'דירה, שורה 1' })).toHaveText(`דירה ${APT_PUB}`);
    // Seven chips for one apartment — past the old caps of 4 and 6.
    const plus = first.getByRole('button', { name: 'יותר' });
    for (let k = 0; k < 6; k++) await plus.click();
    await expect(first.locator('.cr-qty b')).toHaveText('7');
    await expect(plus).toBeEnabled();
    await first.getByLabel('טלפון נייד').fill(phoneDigits);
    await first.getByLabel('מייל').fill('test-mode.e2e@example.test');

    // "הוספת דירה": the new row starts with the previous row's name, phone and email.
    await page.getByRole('button', { name: 'הוספת דירה' }).click();
    const second = rows.nth(1);
    await expect(second.getByLabel('שם מלא')).toHaveValue('בודק בדיקה');
    await expect(second.getByLabel('טלפון נייד')).toHaveValue(phoneDigits);
    await expect(second.getByLabel('מייל')).toHaveValue('test-mode.e2e@example.test');
    await page.getByLabel('חיפוש לפי מספר דירה').fill(APT_PUB);
    await page.getByLabel('חיפוש לפי מספר דירה').press('Enter');
    await second.getByRole('radio', { name: 'שוכר' }).click();
    await second.getByLabel('שם מלא').fill('שרה שוכרת');
    await second.getByLabel('טלפון נייד').fill(renterDigits);
    await second.getByLabel('מייל').fill('');
    await second.getByLabel('חוזה, שורה 2').setInputFiles({ name: 'lease.pdf', mimeType: 'application/pdf', buffer: PDF });
    await second.getByLabel('תאריך סיום החוזה').fill('2030-01-31');

    // Up to 10 chips per apartment, counted over ITS rows (7 + 3 = 10): one
    // more plus shows the message next to that quantity and adds nothing.
    const plus2 = second.getByRole('button', { name: 'יותר' });
    await plus2.click();
    await plus2.click();
    await expect(second.locator('.cr-qty b')).toHaveText('3');
    await expect(second.locator('.cr-err')).toHaveCount(0);
    await plus2.click();
    await expect(second.locator('.cr-qty b')).toHaveText('3');
    await expect(second.locator('.cr-fld').filter({ has: page.locator('.cr-qty') })).toContainText(APT_LIMIT_MSG);
    await expect(plus2).toBeEnabled();
    await plus.click(); // the other row of the same apartment is refused too
    await expect(first.locator('.cr-qty b')).toHaveText('7');
    await expect(first.locator('.cr-fld').filter({ has: page.locator('.cr-qty') })).toContainText(APT_LIMIT_MSG);
    const minus2 = second.getByRole('button', { name: 'פחות' });
    await minus2.click();
    await minus2.click();
    await expect(second.locator('.cr-qty b')).toHaveText('1');
    await expect(rows.locator('.cr-err')).toHaveCount(0);

    // One breakdown line: all 8 chips at the one price of /settings.
    const brk = page.getByTestId('chip-order-breakdown');
    await expect(brk.locator('.cr-br')).toHaveCount(1);
    await expect(brk.locator('.cr-br')).toContainText('כרטיס בקרת כניסה');
    await expect(brk.locator('.cr-br')).toContainText('8');
    await expect(brk.locator('.cr-br')).toContainText(`${PRICE}₪`);
    await expect(brk).not.toContainText('הכרטיסים הראשונים');
    await expect(brk).not.toContainText('נוסף');
    await expect(page.getByTestId('chip-order-total')).toHaveText(`${8 * PRICE}₪`);

    await page.locator('#co-phone').fill(phoneDigits);
    await page.locator('#co-email').fill('test-mode.e2e@example.test');
    await page.locator('#co-street').fill('רחוב בדיקה 2');
    await page.locator('#co-city').fill('חיפה');
    await page.locator('#co-zip').fill('3300000');
    // "הערות" — optional, up to 500, below the address; it becomes the order's note.
    const noteField = page.getByLabel('הערות', { exact: true });
    await expect(noteField).toHaveAttribute('placeholder', 'למשל: אני מבקש למסור את הכרטיסים ל...');
    await expect(noteField).toHaveAttribute('maxlength', '500');
    await noteField.fill(PUB_NOTE);
    // The card fields are drawn but never read: typed here, absent from every request.
    const card = page.getByTestId('chip-order-card-fields');
    await card.getByLabel('מספר כרטיס').fill('4111111111111111');
    await card.getByLabel('ת"ז בעל הכרטיס').fill('123456782');
    await page.getByRole('checkbox', { name: /הפרטים שמסרתי הינם נכונים/ }).check();
    await expect(page.getByTestId('chip-order-pay')).toBeDisabled(); // the renter commitment is still missing
    await page.getByRole('checkbox', { name: /השוכר מתחייב להחזיר את הכרטיס/ }).check();
    await page.getByTestId('chip-order-pay').click();

    const chatId = `${phoneE164.slice(1)}@c.us`;
    let code = '';
    await expect.poll(async () => {
      const r = await fetch(`${STUB}/__messages?chatId=${encodeURIComponent(chatId)}`);
      const { messages } = (await r.json()) as { messages: { message: string }[] };
      code = messages.at(-1)?.message.match(/(\d{6})/)?.[1] ?? '';
      return code;
    }, { timeout: 15_000 }).toMatch(/^\d{6}$/);
    await page.getByLabel('קוד אימות').fill(code);
    await page.getByTestId('chip-order-pay').click();

    const done = page.getByTestId('chip-order-confirmation');
    await expect(done).toBeVisible();
    await expect(done.getByRole('heading', { level: 2 })).toHaveText('תודה על הזמנתך!');
    await expect(done.locator('p.cr-msg')).toHaveText([
      'הנהלת הבניין תבדוק ותאמת שהפרטים שמסרת נכונים ותואמים, ועם אישור ההזמנה תישלח אליך הודעה על מועד איסוף הכרטיסים מעמדת השומר בלובי הבניין. ניתן להגיע לאיסוף בכל יום ובכל שעה, ללא תיאום מראש.',
      'קבלת הכרטיסים מותנית בהצגת תעודה מזהה התואמת לפחות לאחד מהמוטבים בהזמנה.',
    ]);
    await expect(done).not.toContainText('ההזמנה התקבלה בהצלחה');
    await expect(done).toContainText('בודק בדיקה (בעלים)');
    await expect(done).toContainText('שרה שוכרת (שוכר)');
    await expect(done).toContainText(`${8 * PRICE}₪`);
    // The collections department number (fixed 21/11/2026).
    await expect(done).toContainText('04-8500184');
    await expect(done).not.toContainText('04-83411881');
    await noSideScroll(page);

    expect(posted).toHaveLength(1);
    expect(posted[0]).not.toContain('4111');
    expect(posted[0]).not.toContain('123456782');

    const row = (await pool.query<{ id: string; order_number: number; is_test: boolean; status: string; total: number; grow_process_id: string | null; rt: boolean; address_zip: string; internal_note: string | null }>(
      `select id, order_number, is_test, status, total::float8 as total, grow_process_id, renter_terms_accepted_at is not null as rt, address_zip, internal_note
         from public.chip_orders where phone_e164 = $1 order by created_at desc limit 1`, [phoneE164],
    )).rows[0]!;
    state.orderId = row.id;
    state.orderNumber = row.order_number;
    expect(row).toMatchObject({ is_test: true, status: 'paid', total: 8 * PRICE, grow_process_id: null, rt: true, address_zip: '3300000', internal_note: PUB_NOTE });

    // The server refuses an apartment past 10 over its rows (6 + 5) with the
    // same message, before anything is written (the phone is still verified).
    const over = await page.request.post('/api/public/chip-order', {
      headers: { 'x-chip-order-test': new URL(state.link).searchParams.get('test')! },
      multipart: {
        order: JSON.stringify({
          phone: phoneDigits, email: 'test-mode.e2e@example.test', addressStreet: 'רחוב בדיקה 2', addressCity: 'חיפה', addressZip: '3300000',
          acceptTerms: true, acceptRenterTerms: false,
          rows: [6, 5].map((n) => ({ role: 'owner', fullName: 'בודק בדיקה', apartment: APT_PUB, chipsCount: n, phone: phoneDigits, email: '' })),
        }),
      },
    });
    expect(over.status()).toBe(400);
    expect(((await over.json()) as { message?: string }).message).toBe(APT_LIMIT_MSG);
    expect((await pool.query(`select count(*)::int as n from public.chip_orders where phone_e164 = $1`, [phoneE164])).rows[0].n).toBe(1);
    await expect(done.getByTestId('chip-order-confirmation-number')).toHaveText(String(row.order_number));
    const items = (await pool.query(
      `select chips_count, unit_price::float8 as unit_price, price_above::float8 as price_above, line_total::float8 as line_total
         from public.chip_order_items where order_id = $1`, [row.id],
    )).rows;
    expect(items).toEqual([{ chips_count: 8, unit_price: PRICE, price_above: PRICE, line_total: 8 * PRICE }]);
    const holders = (await pool.query<{ role: string; full_name: string; chips_count: number; lease_file_key: string | null; lease_end: string | null }>(
      `select role, full_name, chips_count, lease_file_key, to_char(lease_end_date, 'YYYY-MM-DD') as lease_end
         from public.chip_order_holders where order_id = $1 order by position`, [row.id],
    )).rows;
    expect(holders.map((h) => [h.role, h.full_name, h.chips_count, h.lease_end])).toEqual([
      ['owner', 'בודק בדיקה', 7, null], ['tenant', 'שרה שוכרת', 1, '2030-01-31'],
    ]);
    state.leaseKey = holders[1]!.lease_file_key ?? '';
    expect(storage.keys('chip-order-leases')).toEqual([`chip-order-leases/${state.leaseKey}`]);
    // The "received & paid" WhatsApp goes out after the response — marked, and with the due date.
    await expect.poll(async () => {
      const r = await fetch(`${STUB}/__messages?chatId=${encodeURIComponent(chatId)}`);
      const { messages } = (await r.json()) as { messages: { message: string }[] };
      const last = messages.at(-1)?.message ?? '';
      return last.startsWith('[בדיקה]') && last.includes('מועד היעד להכנה');
    }, { timeout: 20_000 }).toBe(true);
    await ctx.close();
  });

  test('/chips: the test order — badge, not counted, hides on demand; two blocks with the lease, chips per block, the switch; "מחק הזמנת בדיקה" disables its chips first', async ({ page }) => {
    await page.goto('/chips?view=orders');
    const row = orderRow(page, APT_PUB);
    await expect(row).toBeVisible();
    await expect(row.getByTestId('chip-order-test-badge')).toHaveText('בדיקה');
    const realOpen = (await pool.query<{ n: number }>(
      `select count(*)::int as n from public.chip_order_items i join public.chip_orders o on o.id = i.order_id
        where o.status in ('paid', 'approved', 'ready') and not o.is_test`,
    )).rows[0]!.n;
    const tab = page.getByRole('tab', { name: /הזמנות/ });
    if (realOpen > 0) await expect(tab).toContainText(String(realOpen));
    else await expect(tab).toHaveText('הזמנות');
    await page.getByTestId('chip-orders-toggle-tests').click();
    await expect(row).toHaveCount(0);
    await page.getByTestId('chip-orders-toggle-tests').click();
    await expect(row).toBeVisible();

    await row.click();
    const issue = issueWindow(page);
    const blocks = issue.getByTestId('chip-holder-block');
    await expect(blocks).toHaveCount(2);
    const [owner, renter] = [blocks.nth(0), blocks.nth(1)];
    await expect(renter.getByRole('radio', { name: 'שוכר' })).toHaveAttribute('aria-checked', 'true');
    const lease = renter.getByTestId('chip-order-lease-link');
    await expect(lease).toBeVisible();
    const file = await page.request.get((await lease.getAttribute('href'))!);
    expect(file.status()).toBe(200);
    expect((await file.body()).subarray(0, 5).toString()).toBe('%PDF-');
    const section = issue.getByTestId('chip-order-section');
    await expect(section).toContainText('בדיקה, ללא חיוב');
    await expect(section).toContainText(`כרטיס בקרת כניסה — 8×${PRICE}₪`);
    // The orderer's "הערות" is the window's "הערה", editable as always.
    await expect(issue.getByLabel('הערה', { exact: true })).toHaveValue(PUB_NOTE);

    for (let k = 1; k <= 7; k++) await addChip(owner, `T${tag}${k}`);
    await expect(owner.getByTestId('chip-alloc-counter')).toHaveText('שויכו 7 מתוך 7');
    await renter.getByRole('radio', { name: 'אפליקציה' }).click();
    await addChip(renter, `T${tag}8`, 'button');
    // The save keeps the window open (24/11/2026), reloaded: nothing waits any
    // more, and the row behind it followed.
    await issue.getByTestId('chip-issue-save').click();
    await expect(issue.getByTestId('chip-issue-save')).toBeDisabled();
    await expect(issue.getByText('ממתין לשמירה')).toHaveCount(0);
    await expect(row.getByTestId('chip-order-stage')).toHaveText('שויך');
    await expect(owner.getByTestId('chip-alloc-counter')).toHaveText('שויכו 7 מתוך 7');
    page.once('dialog', (d) => void d.accept());
    await owner.getByRole('button', { name: `השבת את T${tag}1` }).click();
    await expect(owner.getByTestId('chip-alloc-counter')).toHaveText('שויכו 6 מתוך 7');
    await expect.poll(async () => (await pool.query(`select status from public.chips where chip_number = $1`, [`T${tag}1`])).rows[0].status).toBe('inactive');

    await section.getByTestId('chip-order-delete-test').click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'מחק הזמנת בדיקה' }).click();
    await expect(issue).toHaveCount(0);
    await expect(row).toHaveCount(0);
    expect((await pool.query(`select 1 from public.chip_orders where id = $1`, [state.orderId])).rowCount).toBe(0);
    state.orderId = '';
    // Its chips are disabled, never deleted — and no longer linked to the order.
    const chips = (await pool.query<{ status: string; order_item_id: string | null }>(
      `select status, order_item_id from public.chips where chip_number like $1`, [`T${tag}%`],
    )).rows;
    expect(chips).toHaveLength(8);
    expect(chips.every((c) => c.status === 'inactive' && c.order_item_id === null)).toBe(true);
    expect(storage.removed).toContain(`chip-order-leases/${state.leaseKey}`);
  });

  // "דלג על אימות (מצב בדיקה)" (13/11/2026): a failed send keeps the WhatsApp
  // button through the resend cooldown; the send is played by page.route, the
  // skip and everything after it are real. Then the staff reject the test order.
  test('a failed send keeps the WhatsApp button through the cooldown; "דלג על אימות" → confirmation → the window → "דחה" → the row leaves', async ({ browser, page }) => {
    const skipPhone = `05394${String(Date.now()).slice(-5)}`;
    const skipE164 = `+972${skipPhone.slice(1)}`;
    skipState.phone = skipE164;

    const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] }, viewport: { width: 390, height: 844 } });
    const pub = await ctx.newPage();
    const sent: { channel?: string }[] = [];
    await pub.route('**/api/public/chip-order/otp/request', async (route) => {
      const body = route.request().postDataJSON() as { channel?: string };
      sent.push(body);
      await route.fulfill(body.channel === 'whatsapp'
        ? { status: 429, json: { ok: false, retryAfterSec: 2, message: 'אפשר לבקש קוד חדש בעוד 2 שניות.' } }
        : { status: 502, json: { ok: false, retryAfterSec: 2, message: 'שליחת הקוד נכשלה. נסו שוב בעוד רגע.' } });
    });
    await pub.goto(new URL(state.link).pathname + new URL(state.link).search);
    await expect(pub.getByTestId('chip-order-test-banner')).toBeVisible();
    // Nothing to skip before a code was asked for.
    await expect(pub.getByTestId('chip-order-skip-verification')).toHaveCount(0);
    const first = pub.getByTestId('chip-order-line').nth(0);
    await first.getByLabel('שם מלא').fill('בודק דילוג');
    await first.getByRole('button', { name: 'דירה, שורה 1' }).click();
    await pub.getByLabel('חיפוש לפי מספר דירה').fill(APT_SKIP);
    await pub.getByLabel('חיפוש לפי מספר דירה').press('Enter');
    await first.getByLabel('טלפון נייד').fill(skipPhone);
    await pub.locator('#co-phone').fill(skipPhone);
    await pub.locator('#co-email').fill('skip.e2e@example.test');
    await pub.locator('#co-street').fill('רחוב בדיקה 3');
    await pub.locator('#co-city').fill('חיפה');
    await pub.locator('#co-zip').fill('3300000');
    await pub.getByRole('checkbox', { name: /הפרטים שמסרתי הינם נכונים/ }).check();
    await pub.getByTestId('chip-order-pay').click();

    const wa = pub.getByTestId('chip-order-otp-whatsapp-fallback');
    await expect(pub.getByText('שליחת הקוד נכשלה. נסו שוב בעוד רגע.')).toBeVisible();
    await expect(wa).toBeDisabled();
    await expect(wa).toContainText('בעוד');
    await expect(wa).toBeEnabled({ timeout: 5_000 });
    await wa.click();
    await expect.poll(() => sent.at(-1)?.channel).toBe('whatsapp');
    // Refused only by the cooldown → the button stays, counting down again.
    await expect(wa).toBeVisible();
    await expect(wa).toBeEnabled({ timeout: 5_000 });

    await pub.getByTestId('chip-order-skip-verification').click();
    await expect(pub.getByTestId('chip-order-confirmation')).toBeVisible();
    await ctx.close();

    const row = (await pool.query<{ id: string; is_test: boolean; phone_verified: boolean; status: string }>(
      `select id, is_test, phone_verified, status from public.chip_orders where phone_e164 = $1`, [skipE164],
    )).rows;
    expect(row).toHaveLength(1);
    skipState.orderId = row[0]!.id;
    expect(row[0]).toMatchObject({ is_test: true, phone_verified: false, status: 'paid' });
    // No code was issued (the request was played), none consumed by the skip.
    expect((await pool.query(`select 1 from public.portal_otp_codes where phone_e164 = $1`, [skipE164])).rowCount).toBe(0);

    await page.goto('/chips?view=orders');
    const listRow = orderRow(page, APT_SKIP);
    await expect(listRow).toContainText('בודק דילוג');
    await expect(listRow.getByTestId('chip-order-test-badge')).toHaveText('בדיקה');
    await expect(listRow.getByTestId('chip-order-phone-unverified')).toHaveText('טלפון לא אומת');
    await expect(listRow.getByTestId('chip-order-stage')).toHaveText('ממתין לשיוך');
    await listRow.click();
    const issue = issueWindow(page);
    const block = issue.getByTestId('chip-holder-block');
    await expect(block).toHaveCount(1);
    await expect(block.getByLabel('שם מלא')).toHaveValue('בודק דילוג');
    await expect(block.getByLabel('טלפון נייד')).toHaveValue(skipPhone);
    const section = issue.getByTestId('chip-order-section');
    await expect(section).toContainText('skip.e2e@example.test');
    await section.getByRole('button', { name: 'דחה', exact: true }).click();
    const dlg = page.getByRole('alertdialog');
    await dlg.getByLabel('סיבת הדחייה').fill('בדיקת דחייה');
    await dlg.getByRole('button', { name: 'דחה', exact: true }).click();
    await expect(issue).toHaveCount(0);
    await expect(listRow).toHaveCount(0);
    expect((await pool.query(`select status, refund_status, reject_reason from public.chip_orders where id = $1`, [skipState.orderId])).rows[0])
      .toEqual({ status: 'rejected', refund_status: 'not_required', reject_reason: 'בדיקת דחייה' });
  });

  test('switching test mode off kills the link', async ({ page, browser }) => {
    await page.goto('/settings');
    const sw = page.getByTestId('chip-order-test-mode').getByRole('switch', { name: 'מצב בדיקה' });
    await expect(sw).toHaveAttribute('aria-checked', 'true');
    await sw.click();
    await expect(sw).toHaveAttribute('aria-checked', 'false');
    const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const pub = await ctx.newPage();
    await pub.goto(new URL(state.link).pathname + new URL(state.link).search);
    await expect(pub.getByTestId('chip-order-closed')).toBeVisible();
    await ctx.close();
  });
});
