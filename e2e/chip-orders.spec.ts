import { test, expect, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import { Pool } from 'pg';
import { readFileSync } from 'node:fs';
import { paintedText } from '../tests/helpers/pdf-painted';
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
//     "אבטחה" in the menu;
//   · 25/11/2026, fourth round (Ronen): the Orders table has a "תגיות" column
//     of its own and every value sits under its header; while chips are
//     missing the action column holds a plain label "בהמתנה" — no button; and
//     both tabs carry the same three buttons — "הדפסה", "ייצוא לאקסל",
//     "הורדה ל-PDF" — on the rows the tab shows. The PDF is read back by what
//     is painted (tests/helpers/pdf-painted.ts): Hebrew right to left, a phone
//     and a date in their reading order.
//   · 25/11/2026, issuing at the reception (Ronen): "הנפק צ׳יפ" — the window
//     with no order — collects who ordered, the holder's email and a renter's
//     lease, all optional; "עמלת הנפקה (₪)" and "החיוב בוצע" are gone in both
//     modes; the NEW chips of a save need a payment method, none chosen by
//     default: "אשראי" (disabled — admin and super admin only), "מזומן או
//     העברה" (the save makes an order of the reception: paid, collected,
//     tagged "קבלה" in the Orders tab, opened like any order, in the search
//     and the files, nobody notified) or "ללא חיוב" (no order; the details
//     come back on the block). Editing saved chips needs no payment. A
//     manager — not an admin — issues with the same permission and never sees
//     "אשראי".
//   · 25/11/2026, round six (Ronen): a number beyond the quantity an apartment
//     paid for online is an EXTRA chip — the reception's payment section
//     appears for the extras only ("מזומן או העברה" makes a reception order
//     for them, "ללא חיוב" makes none; the web order and its total never
//     change); "נאסף" asks first and may name who collected; a reception order
//     can be cancelled by an admin ("בטל הזמנת קבלה", a reason required — its
//     chips are disabled, the row stays as "בוטל"); the holder panel has ONE
//     close button; and a lease that was uploaded and never saved is swept 24
//     hours later by the hourly purge, while an attached one never is. The
//     guard's pickup screen has a file of its own (e2e/chip-pickup.spec.ts).
//   · 25/11/2026, evening (Ronen, after testing on production): in the window
//     of an order, "שמור שינויים", "מוכן לאיסוף" and "נאסף" close the window
//     once they went through (a failure keeps it open); and a ready order keeps
//     its row's place, with "נאסף" — also a test order, at every width.
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
const APT_T1 = `993${tag}5`; // the table's columns: an ordinary order…
const APT_T2 = `993${tag}6`; // …and a test order with every tag
const APT_CH = `993${tag}7`; // the chips tab: print / Excel / PDF
const APT_REC = `993${tag}8`; // the reception: a paid issue — a renter with a lease, and a guest
const APT_MGR = `993${tag}9`; // the reception: issued by a manager, not an admin
const APT_NOORD = `995${tag}1`; // the look of the window without an order
const APT_EXTRA = `995${tag}2`; // round six: extra chips of a web order, and cancelling their reception order
const APT_LEASE = `995${tag}3`; // round six: the sweep of leases nobody saved
const APT_RDY = `995${tag}4`; // 25/11/2026: a test order marked ready in the window keeps its row
const APT_LIMIT_MSG = 'ניתן להזמין עד 10 כרטיסים לדירה בהזמנה אחת. לכמות גדולה יותר יש לפנות להנהלת הבניין.';
const PUB_NOTE = 'אני מבקש למסור את הכרטיסים לשכן מדירה 5';
const P_OWNER = '+972539300001';
const P_RENTER = '+972539300002';
const made = { contacts: {} as Record<string, string>, orders: [] as string[], users: [] as string[], leases: [] as string[] };
const contexts: BrowserContext[] = [];

const storageUrl = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'http://localhost:54321');
const storage = new StorageStub();

const PDF = Buffer.from('%PDF-1.4\n% e2e lease\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n');

/** The price per chip the server charges right now: the settings row, or the
 *  default when nobody saved one. */
async function unitPrice(): Promise<number> {
  const r = await pool.query<{ p: string | null }>(`select value->>'unitPrice' as p from public.app_settings where key = 'chip_orders'`);
  return r.rows[0]?.p ? Number(r.rows[0].p) : 50;
}

/** A page signed in as the given user — its session row goes straight into
 *  the DB (the cookie holds the raw token, the table its SHA-256), so the
 *  login budget of the e2e job is not touched. */
async function pageAs(browser: Browser, userId: string): Promise<Page> {
  const raw = randomBytes(32).toString('base64url');
  await pool.query(
    `insert into public.sessions (id, user_id, expires_at, remember) values ($1, $2, now() + interval '3 hours', false)`,
    [createHash('sha256').update(raw).digest('hex'), userId],
  );
  const ctx = await browser.newContext({
    storageState: { cookies: [{ name: 'almog_sid', value: raw, domain: 'localhost', path: '/', httpOnly: true, secure: true, sameSite: 'Lax', expires: -1 }], origins: [] },
  });
  contexts.push(ctx);
  return ctx.newPage();
}

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

/** A paid TEST-mode order — what the test link leaves once it is paid: one
 *  apartment, one owner, one chip, paid `ago` before now (an interval). */
async function seedTestOrder(apt: string, name: string, phone: string, ago: string): Promise<{ id: string; orderNumber: number; item: string }> {
  const o = await pool.query<{ id: string; order_number: number }>(
    `insert into public.chip_orders
       (full_name, phone_e164, email, address, role, status, total, tracking_token, paid_at, due_at, is_test, phone_verified)
     values ($1, $2, 'test.e2e@example.test', 'רחוב בדיקה 1, חיפה 3300000', 'owner', 'paid', 50, $3,
             now() - $4::interval, now() + interval '3 days', true, false)
     returning id, order_number`,
    [name, phone, randomBytes(32).toString('base64url'), ago],
  );
  const order = o.rows[0]!;
  made.orders.push(order.id);
  const i = await pool.query<{ id: string }>(
    `insert into public.chip_order_items
       (order_id, contact_id, apartment_number, chips_count, unit_price, threshold, price_above, line_total, match_status)
     values ($1, $2, $3, 1, 50, 1, 50, 50, 'unassigned') returning id`,
    [order.id, made.contacts[apt], apt],
  );
  await pool.query(
    `insert into public.chip_order_holders (order_id, item_id, position, source, role, full_name, phone, chips_count)
     values ($1, $2, 0, 'order', 'owner', $3, $4, 1)`,
    [order.id, i.rows[0]!.id, name, phone],
  );
  return { id: order.id, orderNumber: order.order_number, item: i.rows[0]!.id };
}

/** The window's apartment rows in /chips → "הזמנות". */
function orderRow(page: Page, text: string): Locator {
  return page.getByTestId('chip-orders-table').getByTestId('chip-order-row').filter({ hasText: text });
}

/** Where the row of an apartment sits in the Orders table (0 = the top). */
function rowIndex(page: Page, apt: string): Promise<number> {
  return page.getByTestId('chip-orders-table').getByTestId('chip-order-row')
    .evaluateAll((rows, a) => rows.findIndex((r) => (r.textContent ?? '').includes(a)), apt);
}

/** Where an apartment line of an order sits in the Orders tab (0 = the top,
 *  -1 = not listed). For rows that look alike — the same person, apartment
 *  and date: the tab draws the rows in the order the list API returns them
 *  (the tests switch on, the search empty). */
async function apiRowIndex(page: Page, itemId: string): Promise<number> {
  const data = (await (await page.request.get('/api/chip-orders')).json()) as { items: { item_id: string }[] };
  return data.items.findIndex((r) => r.item_id === itemId);
}

function tableRow(page: Page, index: number): Locator {
  return page.getByTestId('chip-orders-table').getByTestId('chip-order-row').nth(index);
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

/** Type a number into a block's chip field and add it (Enter or "הוסף"). The
 *  field is clicked first, as a person does: right after a control of the
 *  window was removed from under the focus (the X of a red number), the
 *  window's focus trap is still moving the focus, and an Enter sent in that
 *  instant lands elsewhere — the number then stays in the field (seen once,
 *  25/11/2026). */
async function addChip(block: Locator, number: string, how: 'enter' | 'button' = 'enter') {
  const input = block.getByLabel(/^מספר צ׳יפ/);
  await input.click();
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

/** A string as a right-to-left line is painted in a PDF: back to front. */
const rev = (s: string) => Array.from(s).reverse().join('');

/** The Orders table, measured: for every column, how far each body cell is
 *  from its header. The cell's own box must be the header cell's box (the
 *  same grid track), it must carry the header's alignment, and what it holds
 *  must sit where the header's label sits — the same start edge, or centre
 *  under centre. Returns what is off; an empty list = every value under its
 *  header. An empty cell (a row with no tag) has nothing to measure. */
function offItsHeader(table: Locator): Promise<string[]> {
  return table.evaluate((root) => {
    const ink = (el: Element) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
      return rects.length === 0 ? null : { left: Math.min(...rects.map((r) => r.left)), right: Math.max(...rects.map((r) => r.right)) };
    };
    const off: string[] = [];
    const rows = [...root.querySelectorAll('[data-testid="chip-order-row"]')];
    for (const head of root.querySelectorAll<HTMLElement>('[data-testid="chip-orders-head"] [data-col]')) {
      const col = head.dataset.col!;
      const align = getComputedStyle(head).textAlign;
      const label = ink(head)!;
      const headBox = head.getBoundingClientRect();
      rows.forEach((row, n) => {
        const cell = row.querySelector<HTMLElement>(`[data-col="${col}"]`);
        if (!cell) { off.push(`${col}, row ${n + 1}: no cell`); return; }
        const box = cell.getBoundingClientRect();
        if (Math.abs(box.left - headBox.left) > 0.5 || Math.abs(box.right - headBox.right) > 0.5) off.push(`${col}, row ${n + 1}: the cell is not under the header cell`);
        if (getComputedStyle(cell).textAlign !== align) off.push(`${col}, row ${n + 1}: aligned ${getComputedStyle(cell).textAlign}, the header ${align}`);
        const value = ink(cell);
        if (!value) return;
        const away = align === 'center' ? (value.left + value.right) / 2 - (label.left + label.right) / 2 : value.right - label.right;
        if (Math.abs(away) > 1) off.push(`${col}, row ${n + 1}: ${Math.round(away * 10) / 10}px away from its header`);
      });
    }
    return off;
  });
}

/** The three export buttons of a tab, as they look: the labels in their
 *  order, the look they share, and where the group stands in the toolbar. */
function exportButtons(page: Page, prefix: 'chips' | 'chip-orders') {
  return page.getByTestId(`${prefix}-exports`).evaluate((group) => {
    const buttons = [...group.querySelectorAll('button')];
    const look = (b: HTMLElement) => {
      const cs = getComputedStyle(b);
      return [cs.height, cs.fontSize, cs.fontWeight, cs.borderRadius, cs.borderTopWidth, cs.color, cs.backgroundColor].join(' ');
    };
    const end = group.parentElement!;
    return {
      labels: buttons.map((b) => b.textContent?.trim()),
      looks: [...new Set(buttons.map(look))],
      // The group closes the toolbar's far-end group, right after the search box.
      lastInToolbar: end.lastElementChild === group && end.parentElement!.lastElementChild === end,
      afterSearch: Boolean(group.previousElementSibling?.querySelector('input')),
    };
  });
}

/** Presses a download button and reads the file it hands over. */
async function download(page: Page, testId: string): Promise<{ name: string; bytes: Buffer }> {
  const downloading = page.waitForEvent('download');
  await page.getByTestId(testId).click();
  const file = await downloading;
  return { name: file.suggestedFilename(), bytes: readFileSync((await file.path())!) };
}

interface Printed { text: string; dir: string; shown: string; controls: number; restHidden: boolean; headers: (string | null)[]; rows: number }

/** Presses "הדפסה" with `window.print` replaced by a probe that reads the page
 *  as the printer would get it (print media): the print-only table, and
 *  whether everything else on the page is hidden. */
async function printed(page: Page, testId: string): Promise<Printed> {
  await page.evaluate(() => {
    const w = window as unknown as { __printed: unknown };
    w.__printed = null;
    window.print = () => {
      const root = document.getElementById('chips-print-root');
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
  await page.getByTestId(testId).evaluate((button: HTMLElement) => button.click());
  await expect.poll(() => page.evaluate(() => (window as unknown as { __printed: unknown }).__printed !== null)).toBe(true);
  const result = await page.evaluate(() => (window as unknown as { __printed: Printed }).__printed);
  await page.emulateMedia({ media: null });
  // On the screen the print-only table never shows, and it is gone afterwards.
  await expect(page.locator('#chips-print-root')).toHaveCount(0);
  return result;
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
  for (const apt of [APT, APT_B, APT_OLD, APT_PUB, APT_SKIP, APT_LAY, APT_LAY_B, APT_GONE, APT_TAKEN, APT_ROW, APT_ROW_B, APT_S1, APT_S2, APT_T1, APT_T2, APT_CH, APT_REC, APT_MGR, APT_NOORD, APT_EXTRA, APT_LEASE, APT_RDY]) {
    const c = await pool.query<{ id: string }>(`insert into public.contacts (apartment_number) values ($1) returning id`, [apt]);
    made.contacts[apt] = c.rows[0]!.id;
  }
  // The reception's apartments have a renter in the tenants list: a registry
  // role can be picked in the window only when the list knows its name and
  // phone. (A renter, not an owner — an owner's phone would join the portal.)
  for (const apt of [APT_REC, APT_NOORD, APT_LEASE]) {
    await pool.query(`update public.contacts set tenant_name = 'שוכר קבלה', tenant_phone = '0539300011' where id = $1`, [made.contacts[apt]]);
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
  // What the reception made for THESE apartments (the contact ids are this
  // file's own): its orders, and its no-charge records.
  const reception = await pool.query<{ id: string }>(
    `select distinct o.id from public.chip_orders o join public.chip_order_items i on i.order_id = o.id where i.contact_id = any($1::uuid[])`,
    [contactIds],
  );
  for (const { id } of reception.rows) await pool.query(`delete from public.chip_orders where id = $1`, [id]);
  // The lease registry rows of the files this file put in the stand-in Storage
  // (kept or removed since) — by their exact keys.
  const leaseKeys = [...new Set([...storage.keys('chip-order-leases'), ...storage.removed.filter((k) => k.startsWith('chip-order-leases/'))])]
    .map((k) => k.slice('chip-order-leases/'.length));
  for (const key of leaseKeys) await pool.query(`delete from public.chip_lease_uploads where object_key = $1`, [key]);
  for (const id of contactIds) await pool.query(`delete from public.chip_reception_records where contact_id = $1`, [id]);
  for (const id of contactIds) await pool.query(`delete from public.contacts where id = $1`, [id]);
  for (const c of contexts) await c.close().catch(() => undefined);
  if (made.users.length > 0) {
    await pool.query(`delete from public.audit_log where entity_id = any($1::text[]) or actor_user_id = any($1::uuid[])`, [made.users]);
    await pool.query(`delete from public.users where id = any($1::uuid[])`, [made.users]);
  }
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
  // "מסירת צ׳יפים" — the guard's pickup screen — joined on 25/11/2026 (e2e/chip-pickup.spec.ts).
  expect(await items()).toEqual(['סריקת כניסה', 'מסירת צ׳יפים', 'צ׳יפים']);
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

  test('without an order: one block, no transaction section, 6 chips with no reason, card / app; no fee fields — the payment of the new chips, with no default; "ללא חיוב" makes no order and the details come back; the switch disables and re-enables; an edit alone needs no payment', async ({ page }) => {
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

    // 25/11/2026: "עמלת הנפקה (₪)" and "החיוב בוצע" are gone — the payment of
    // the NEW chips took their place. "הערה" stays.
    await expect(issue.getByLabel('עמלת הנפקה (₪)')).toHaveCount(0);
    await expect(issue.getByRole('checkbox', { name: 'החיוב בוצע' })).toHaveCount(0);
    const price = await unitPrice();
    const pay = issue.getByTestId('chip-reception-payment');
    // The amount, read only: 6 new chips × the price of /settings, drawn as the
    // public page draws its breakdown.
    const breakdown = pay.getByTestId('chip-reception-breakdown');
    await expect(breakdown.locator('.ci-brkh span')).toHaveText(['פריט', 'כמות', 'מחיר ליחידה', 'סה"כ']);
    await expect(breakdown.locator('.ci-brkr span')).toHaveText(['כרטיס בקרת כניסה', '6', `${price}₪`, `${6 * price}₪`]);
    await expect(pay.getByTestId('chip-reception-total')).toHaveText(`${6 * price}₪`);
    // Nothing to type in it: the amount is not a field, and there is no card field anywhere.
    await expect(pay.locator('input')).toHaveCount(0);
    // No default: nothing is chosen, the save is off, and why is on the screen.
    const cash = pay.getByTestId('chip-pay-cash');
    const free = pay.getByTestId('chip-pay-none');
    const save = issue.getByTestId('chip-issue-save');
    await expect(pay.getByRole('radio')).toHaveText([/^אשראי/, /^מזומן או העברה/, /^ללא חיוב/]);
    for (const option of await pay.getByRole('radio').all()) await expect(option).toHaveAttribute('aria-checked', 'false');
    await expect(cash).toContainText('הסכום התקבל במלואו בקבלה');
    await expect(free).toContainText('אורח, צוות או החלפה');
    await expect(save).toBeDisabled();
    await expect(pay.getByTestId('chip-reception-reason')).toHaveText('יש לבחור אמצעי תשלום כדי להנפיק את הצ׳יפים החדשים');
    // "אשראי" is not active yet: drawn for an admin, never pressed.
    const card = pay.getByTestId('chip-pay-card');
    await expect(card).toBeDisabled();
    await expect(card).toContainText('יופעל לאחר חיבור הסליקה');

    // Who ordered — all optional. The name follows the first chip holder of the
    // save until one is typed; this holder has no phone, so neither has the orderer.
    const orderer = issue.getByTestId('chip-reception-orderer');
    await expect(orderer.getByLabel('שם מלא')).toHaveValue('מטפלת בדיקה');
    await expect(orderer.getByLabel('טלפון נייד')).toHaveValue('');
    await block.getByLabel('מייל').fill('Guest.E2E@example.test');
    await orderer.getByLabel('מייל').fill('family.e2e@example.test');
    await orderer.getByLabel('כתובת מגורים נוכחית (רחוב ומספר בית)').fill('הנמל 3');
    await orderer.getByLabel('עיר').fill('חיפה');
    await orderer.getByLabel('מיקוד').fill('33031');
    // "ללא חיוב": the total is 0 — and the save still waits, because what WAS
    // typed about the orderer must be storable (a zip is 7 digits).
    await free.click();
    await expect(free).toHaveAttribute('aria-checked', 'true');
    await expect(pay.getByTestId('chip-reception-total')).toHaveText('0₪');
    await expect(pay.getByTestId('chip-reception-reason')).toHaveCount(0);
    await expect(orderer.getByText('מיקוד — 7 ספרות')).toBeVisible();
    await expect(save).toBeDisabled();
    await orderer.getByLabel('מיקוד').fill('3303105');
    await issue.getByLabel('הערה', { exact: true }).fill('הערת בדיקה');
    await save.click();
    await expect(issue).toHaveCount(0);
    await expect(toast(page, '6 צ׳יפים הונפקו')).toContainText('ללא חיוב');
    const saved = (await pool.query<{ chip_number: string; chip_type: string; status: string; issuance_fee: string | null; fee_charged: boolean; notes: string; limit_override_reason: string | null; order_item_id: string | null; holder_email: string | null; reception_record_id: string | null }>(
      `select chip_number, chip_type, status, issuance_fee, fee_charged, notes, limit_override_reason, order_item_id, holder_email, reception_record_id
         from public.chips where contact_id = $1 order by chip_number`, [made.contacts[APT]],
    )).rows;
    expect(saved).toHaveLength(6);
    const recordId = saved[0]!.reception_record_id;
    expect(recordId).toBeTruthy();
    for (const c of saved) {
      // The old fee columns are not written any more; the email is stored lower-cased.
      expect(c).toMatchObject({
        status: 'active', issuance_fee: null, fee_charged: false, notes: 'הערת בדיקה', limit_override_reason: null, order_item_id: null,
        holder_email: 'guest.e2e@example.test', reception_record_id: recordId,
      });
    }
    // "ללא חיוב" made NO order (APT has one — the web order seeded above — and it is still the only one)…
    expect((await pool.query(
      `select o.source from public.chip_orders o join public.chip_order_items i on i.order_id = o.id where i.contact_id = $1`, [made.contacts[APT]],
    )).rows).toEqual([{ source: 'web' }]);
    // …the details are on a reception record…
    expect((await pool.query(
      `select orderer_name, orderer_phone, orderer_email, address_street, address_city, address_zip, chips_count, unit_price::float8 as unit_price
         from public.chip_reception_records where id = $1`, [recordId],
    )).rows[0]).toEqual({
      orderer_name: 'מטפלת בדיקה', orderer_phone: null, orderer_email: 'family.e2e@example.test', address_street: 'הנמל 3', address_city: 'חיפה',
      address_zip: '3303105', chips_count: 6, unit_price: price,
    });
    // …and the issue is in the audit trail.
    await expect.poll(async () => (await pool.query<{ metadata: Record<string, unknown> }>(
      `select metadata from public.audit_log where entity_type = 'chip_reception_record' and entity_id = $1 and action = 'issued_no_charge'`, [recordId],
    )).rows.map((r) => r.metadata)).toEqual([expect.objectContaining({ method: 'none', amount: 0, chips: 6, unit_price: price, apartment_number: APT })]);
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
    // "Opened later" is also the holder's own panel: what was stored with the
    // chips is shown there again — the email, and the save they came from.
    const stored = holderPanel.getByTestId('chip-holder-details');
    await expect(stored).toContainText('guest.e2e@example.test');
    await expect(stored.getByTestId('chip-holder-reception-record')).toHaveCount(1);
    await expect(stored.getByTestId('chip-holder-reception-record')).toContainText('הנפקה בקבלה');
    await expect(stored.getByTestId('chip-holder-reception-record')).toContainText('ללא חיוב');
    await expect(stored.getByTestId('chip-holder-reception-record')).toContainText('מזמין: מטפלת בדיקה · family.e2e@example.test · הנמל 3, חיפה 3303105');
    await page.keyboard.press('Escape');
    await expect(holderPanel).toHaveCount(0);
    await search.fill('');

    // The switch: off (asks once) and back on — immediate, never deleted.
    await page.getByRole('button', { name: 'הנפק צ׳יפ' }).click();
    await pickApartment(page, APT);
    const again = issue.getByTestId('chip-holder-block').filter({ hasText: 'מטפלת בדיקה' });
    // What was stored with the chips is shown again when they are opened: the
    // holder's email in its field, and under the chips who ordered them and
    // that nothing was charged.
    await expect(again.getByLabel('מייל')).toHaveValue('guest.e2e@example.test');
    const kept = again.getByTestId('chip-reception-records');
    await expect(kept).toContainText('הנפקה בקבלה');
    await expect(kept).toContainText('ללא חיוב');
    await expect(kept).toContainText('6 צ׳יפים');
    await expect(kept).toContainText('מזמין: מטפלת בדיקה · family.e2e@example.test · הנמל 3, חיפה 3303105');
    // Nothing new is being issued: no payment is asked for.
    await expect(issue.getByTestId('chip-reception-breakdown')).toHaveCount(0);
    await expect(issue.getByTestId('chip-reception-total')).toHaveText('0₪');
    for (const option of [issue.getByTestId('chip-pay-cash'), issue.getByTestId('chip-pay-none')]) await expect(option).toBeDisabled();
    page.once('dialog', (d) => void d.accept());
    await again.getByRole('button', { name: `השבת את N${tag}1` }).click();
    await expect.poll(async () => (await pool.query(`select status from public.chips where chip_number = $1`, [`N${tag}1`])).rows[0].status).toBe('inactive');
    await again.getByRole('button', { name: `החזר לפעיל את N${tag}1` }).click();
    await expect.poll(async () => (await pool.query(`select status from public.chips where chip_number = $1`, [`N${tag}1`])).rows[0].status).toBe('active');
    // Picking the apartment counts as an edit: closing asks first.
    await issue.getByRole('button', { name: 'סגור' }).last().click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'צא ללא שמירה' }).click();
    await expect(issue).toHaveCount(0);

    // Editing saved chips alone asks for no payment: change the email, save.
    await page.getByRole('button', { name: 'הנפק צ׳יפ' }).click();
    await pickApartment(page, APT);
    await again.getByLabel('מייל').fill('guest2.e2e@example.test');
    await expect(issue.getByTestId('chip-reception-reason')).toHaveCount(0);
    await issue.getByTestId('chip-issue-save').click();
    await expect(issue).toHaveCount(0);
    expect((await pool.query(`select distinct holder_email from public.chips where contact_id = $1`, [made.contacts[APT]])).rows)
      .toEqual([{ holder_email: 'guest2.e2e@example.test' }]);
    // …and that save recorded no payment and no issue: still the one record, still no reception order.
    expect((await pool.query(`select count(*)::int as n from public.chip_reception_records where contact_id = $1`, [made.contacts[APT]])).rows[0].n).toBe(1);
  });

  test('a paid order: one block per person, the renter, one price line, chips per block, the counter, "הוסף בעל צ׳יפ" outside the paid quantity; "שמור שינויים" saves and closes the window; "מוכן לאיסוף" in ONE click saves what is waiting, marks the order ready and closes the window — the rows offer "נאסף" where they were; "נאסף" in the window closes it too', async ({ page }) => {
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
    // 25/11/2026: no fee fields in this mode either — and no payment section:
    // an order is paid already. "הערה" stays.
    await expect(issue.getByLabel('עמלת הנפקה (₪)')).toHaveCount(0);
    await expect(issue.getByRole('checkbox', { name: 'החיוב בוצע' })).toHaveCount(0);
    await expect(issue.getByTestId('chip-reception-payment')).toHaveCount(0);
    await expect(issue.getByTestId('chip-reception-orderer')).toHaveCount(0);
    await expect(issue.getByLabel('הערה', { exact: true })).toBeVisible();
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

    // "שמור שינויים" saves and CLOSES the window (25/11/2026, Ronen — from
    // 24/11/2026 it stayed open, and every order needed a second action): the
    // success message is on the page, and the row behind the window followed.
    await saveBtn.click();
    await expect(issue).toHaveCount(0);
    await expect(toast(page, '2 צ׳יפים הונפקו')).toBeVisible();
    expect(await savedNumbers()).toEqual([`E2E${tag}1`, `E2E${tag}2`]);
    await expect(orderRow(page, APT).first().getByTestId('chip-order-stage')).toHaveText('שויכו 2 מתוך 3');
    // Opened again: the order as stored — the two numbers are saved chips.
    await row.first().click();
    await expect(owner.getByRole('button', { name: `השבת את E2E${tag}1` })).toBeVisible(); // a saved chip: it has the switch
    await expect(issue.getByText('ממתין לשמירה')).toHaveCount(0);
    await expect(saveBtn).toBeDisabled(); // nothing is left to save
    await expect(section.getByTestId('chip-order-progress')).toHaveText('2 מתוך 4');
    await expect(readyBtn).toBeDisabled();
    await expect(reason).toHaveText('יש לשייך את כל הצ׳יפים שהוזמנו — חסרים 2 צ׳יפים');

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
    // Until this number the window held nothing beyond what was paid online:
    // no payment section.
    await expect(issue.getByTestId('chip-order-extra-payment')).toHaveCount(0);
    await addChip(staff, `E2E${tag}5`);
    await expect(staff.getByTestId('chip-alloc-counter')).toHaveText('שויכו 1');

    // 25/11/2026 — EXTRA CHIPS. The apartment paid online for three chips; this
    // is its fourth. A chip beyond the paid quantity has to be settled: the
    // payment section of the reception appears for it alone, nothing is chosen,
    // and neither the save nor "מוכן לאיסוף" goes until something is.
    const price = await unitPrice();
    const extra = issue.getByTestId('chip-order-extra-payment');
    await expect(extra).toContainText('נוסף צ׳יפ אחד מעבר לכמות ששולמה באתר');
    await expect(extra.getByTestId('chip-reception-breakdown')).toContainText(`${price}₪`);
    await expect(extra.getByTestId('chip-reception-total')).toHaveText(`${price}₪`);
    await expect(extra.getByTestId('chip-pay-card')).toBeDisabled(); // drawn for an admin, never pressed
    await expect(extra.getByTestId('chip-pay-cash')).toHaveAttribute('aria-checked', 'false');
    await expect(extra.getByTestId('chip-pay-none')).toHaveAttribute('aria-checked', 'false');
    await expect(readyBtn).toBeDisabled();
    await expect(saveBtn).toBeDisabled();
    await expect(reason).toHaveText('יש לבחור אמצעי תשלום לצ׳יפים שנוספו מעבר לכמות ששולמה');
    // "ללא חיוב": no order is made for the extra chip — it stays on this order.
    await extra.getByTestId('chip-pay-none').click();
    await expect(extra.getByTestId('chip-reception-total')).toHaveText('0₪');

    // Every ordered chip is covered now — two saved, two still waiting — so
    // "מוכן לאיסוף" is on, and the line under the buttons is gone. Nothing of
    // the three new numbers is saved yet.
    await expect(readyBtn).toBeEnabled();
    await expect(reason).toHaveCount(0);
    expect(await savedNumbers()).toEqual([`E2E${tag}1`, `E2E${tag}2`]);
    expect(await status()).toBe('paid');

    // ONE click: the window is saved, the order is marked ready — and the
    // window closes (25/11/2026). The message is on the page; both rows of the
    // order show the new status, with "נאסף" as their quick step, in the place
    // they had.
    const places = [await rowIndex(page, APT), await rowIndex(page, APT_B)];
    await readyBtn.click();
    await expect(issue).toHaveCount(0);
    await expect(toast(page, 'סומן מוכן לאיסוף — נשלחה הודעה למזמין')).toBeVisible();
    expect(await status()).toBe('ready');
    for (const apt of [APT, APT_B]) {
      await expect(orderRow(page, apt).getByTestId('chip-order-stage')).toHaveText('מוכן לאיסוף');
      await expect(orderRow(page, apt).getByTestId('chip-order-row-collected')).toBeEnabled();
    }
    expect([await rowIndex(page, APT), await rowIndex(page, APT_B)]).toEqual(places);
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

    // The window, opened again: nothing is waiting, all four are linked, the
    // staff holder is a saved block. The three buttons stay: the stage the
    // order is in now is a mark, the next step is the one button to press, and
    // there is no way back or to reject. There is no "בטיפול" — the system has
    // no such status.
    await row.first().click();
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

    // "ללא חיוב" made no order of the reception — and the web order's total did not move.
    expect((await pool.query(`select count(*)::int as n from public.chip_orders where extra_of_order_id = $1`, [order.id])).rows[0].n).toBe(0);
    expect((await pool.query(`select total::float8 as t from public.chip_orders where id = $1`, [order.id])).rows[0].t).toBe(200);
    await expect(issue.getByTestId('chip-order-extra-payment')).toHaveCount(0); // nothing waits any more

    // "נאסף" asks first (25/11/2026), and MAY name who collected — one of the
    // people of the order, each once. Optional here; the guard must choose.
    await section.getByRole('button', { name: 'נאסף', exact: true }).click();
    const collect = page.getByTestId('chip-order-collect-confirm');
    await expect(collect).toContainText(`לסמן את הזמנה ${order.orderNumber} כנאספה?`);
    await expect(collect).toContainText('הסימון חל על ההזמנה כולה');
    const who = collect.getByTestId('chip-order-collect-option');
    await expect(who).toHaveCount(4);
    await expect(who.nth(1)).toContainText('שרה שוכרת');
    for (const o of await who.all()) await expect(o).toHaveAttribute('aria-checked', 'false');
    await expect(collect.getByRole('button', { name: 'סמן כנאסף' })).toBeEnabled(); // nobody has to be named
    await who.nth(1).click();
    await expect(who.nth(1)).toHaveAttribute('aria-checked', 'true');
    expect(await status()).toBe('ready'); // nothing happened yet
    await collect.getByRole('button', { name: 'סמן כנאסף' }).click();
    await expect(issue).toHaveCount(0);
    await expect(toast(page, 'סומן כנאסף')).toBeVisible();
    await expect.poll(status).toBe('collected');
    expect((await pool.query(`select collected_by_name, handed_over_via from public.chip_orders where id = $1`, [order.id])).rows[0])
      .toEqual({ collected_by_name: 'שרה שוכרת', handed_over_via: 'management' });
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
    // A failed save keeps the window open, with its error.
    await expect(issue).toBeVisible();
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
    // Done — and the window closes by itself (25/11/2026); the refusals above kept it open.
    await expect(issue).toHaveCount(0);
    await expect.poll(status).toBe('ready');
    expect(await linked()).toEqual([`TK${tag}1`]);
    // The row followed: ready, with "נאסף" as its quick step.
    await expect(orderRow(page, APT_TAKEN).getByTestId('chip-order-stage')).toHaveText('מוכן לאיסוף');
    await expect(orderRow(page, APT_TAKEN).getByTestId('chip-order-row-collected')).toBeEnabled();
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
      // (Until 25/11/2026 the fee row stood between them; it is gone.)
      const card = (await issue.locator('.ci-inv').boundingBox())!.width;
      expect(note.box, `the note's box is as wide as the transaction card @${width}`).toBeCloseTo(card, 0);
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

// Issuing a chip at the reception (25/11/2026): "הנפק צ׳יפ", the window with
// no order, records how the new chips were paid. Before the Orders-tab tests
// on purpose: the row of a reception order — collected, tagged "קבלה", with a
// plain label in its action column — is then on the table those tests measure.
test.describe('staff: issuing at the reception', () => {
  test('"מזומן או העברה": a renter with a lease and a guest, the orderer details, the amount = chips × the price → an order of the reception: paid, collected, tagged "קבלה" in the Orders tab, opened like any order (read only), in the search and in the Excel file — and nobody is notified', async ({ page }) => {
    const price = await unitPrice();
    await page.goto('/chips');
    await page.getByRole('button', { name: 'הנפק צ׳יפ' }).click();
    const issue = issueWindow(page);
    await pickApartment(page, APT_REC);
    const blocks = issue.getByTestId('chip-holder-block');
    await expect(blocks).toHaveCount(1);

    // A renter of the tenants list: the name and the phone come from it. The
    // lease and its end date are offered — and optional.
    const renter = blocks.nth(0);
    await expect(renter.getByTestId('chip-lease-box')).toHaveCount(0); // no role yet: no lease to ask about
    await renter.getByRole('radio', { name: 'שוכר' }).click();
    await expect(renter.getByLabel('שם מלא')).toHaveValue('שוכר קבלה');
    await expect(renter.getByLabel('טלפון נייד')).toHaveValue('0539300011');
    const leaseBox = renter.getByTestId('chip-lease-box');
    const picker = leaseBox.getByLabel('צרף חוזה שכירות');
    // A file that is no lease is refused on the spot, with the reason — and nothing is sent.
    await picker.setInputFiles({ name: 'lease.exe', mimeType: 'application/octet-stream', buffer: Buffer.from('MZ e2e') });
    await expect(leaseBox.getByRole('alert')).toContainText('החוזה חייב להיות PDF או תמונה');
    await expect(leaseBox.getByTestId('chip-lease-link')).toHaveCount(0);
    await picker.setInputFiles({ name: 'חוזה שכירות.pdf', mimeType: 'application/pdf', buffer: PDF });
    // "צפייה בחוזה" once it is there — through the app's own file proxy, never a signed link.
    const leaseLink = leaseBox.getByTestId('chip-lease-link');
    await expect(leaseLink).toHaveText('צפייה בחוזה');
    await expect(leaseBox.getByRole('alert')).toHaveCount(0);
    await expect(leaseBox).toContainText('חוזה שכירות.pdf');
    const leaseHref = (await leaseLink.getAttribute('href'))!;
    expect(leaseHref).toMatch(/^\/api\/files\/chip-order-leases\/[0-9a-f-]{36}\.pdf$/);
    const leaseKey = leaseHref.split('/').pop()!;
    made.leases.push(leaseKey);
    const opened = await page.request.get(leaseHref);
    expect(opened.status()).toBe(200);
    expect((await opened.body()).equals(PDF)).toBe(true);
    await renter.getByLabel('תאריך סיום חוזה').fill('2030-01-31');
    await renter.getByLabel('מייל').fill('renter.e2e@example.test');
    await addChip(renter, `RC${tag}1`);
    await renter.getByRole('radio', { name: 'אפליקציה' }).click();
    await addChip(renter, `RC${tag}2`, 'button');
    // "מזומן או העברה" chosen now — for the two chips that are here — confirms THAT sum.
    const pay = issue.getByTestId('chip-reception-payment');
    const cash = pay.getByTestId('chip-pay-cash');
    await cash.click();
    await expect(cash).toHaveAttribute('aria-checked', 'true');
    await expect(cash).toContainText(`אישור: התקבלו ${2 * price}₪`);

    // A guest beside him: a name is all a guest needs, and a guest has no lease.
    await issue.getByRole('button', { name: 'הוסף בעל צ׳יפ' }).click();
    const guest = blocks.nth(1);
    await guest.getByRole('radio', { name: 'אורח' }).click();
    await guest.getByLabel('שם מלא').fill('אורח קבלה');
    await expect(guest.getByTestId('chip-lease-box')).toHaveCount(0);
    await addChip(guest, `RC${tag}3`);

    // Who ordered: by default the first chip holder of the save — his name and
    // his phone — and whatever the manager types instead stays.
    const orderer = issue.getByTestId('chip-reception-orderer');
    await expect(orderer.getByLabel('שם מלא')).toHaveValue('שוכר קבלה');
    await expect(orderer.getByLabel('טלפון נייד')).toHaveValue('0539300011');
    await orderer.getByLabel('שם מלא').fill('אבא משלם');
    await orderer.getByLabel('מייל').fill('payer.e2e@example.test');
    await orderer.getByLabel('כתובת מגורים נוכחית (רחוב ומספר בית)').fill('הרצל 5');
    await orderer.getByLabel('עיר').fill('חיפה');
    await orderer.getByLabel('מיקוד').fill('3303105');
    await expect(orderer.getByLabel('שם מלא')).toHaveValue('אבא משלם');
    await expect(orderer.getByLabel('טלפון נייד')).toHaveValue('0539300011'); // still the holder's

    // The amount: 3 new chips × the price now. The third chip came AFTER the
    // sum of two was confirmed, so that confirmation no longer stands: nothing
    // is chosen, the save is off, and the line under the methods says why.
    await expect(pay.getByTestId('chip-reception-breakdown').locator('.ci-brkr span')).toHaveText(['כרטיס בקרת כניסה', '3', `${price}₪`, `${3 * price}₪`]);
    const save = issue.getByTestId('chip-issue-save');
    await expect(cash).toHaveAttribute('aria-checked', 'false');
    await expect(pay.getByTestId('chip-reception-reason')).toHaveText('הסכום לתשלום השתנה — יש לבחור שוב „מזומן או העברה” כדי לאשר את הסכום החדש');
    await expect(save).toBeDisabled();
    await cash.click();
    await expect(cash).toHaveAttribute('aria-checked', 'true');
    // Choosing it IS the confirmation — and it says of how much.
    await expect(cash).toContainText(`אישור: התקבלו ${3 * price}₪`);
    await expect(pay.getByTestId('chip-reception-total')).toHaveText(`${3 * price}₪`);
    await issue.getByLabel('הערה', { exact: true }).fill('שולם במזומן בקבלה');
    await save.click();
    await expect(issue).toHaveCount(0);
    await expect(toast(page, '3 צ׳יפים הונפקו')).toContainText(`נרשם תשלום ${3 * price}₪`);

    // ── What was stored: ONE order of the reception ─────────────────────────
    const orders = (await pool.query<Record<string, unknown>>(
      `select o.id, o.order_number, o.source, o.status, o.full_name, o.phone_e164, o.email, o.address, o.role, o.total::float8 as total,
              o.payment_method, o.payment_recorded_by_name, o.payment_recorded_at, o.is_test, o.internal_note, o.grow_process_id, o.grow_transaction_id,
              o.due_at, o.created_at, i.id as item_id, i.chips_count
         from public.chip_orders o join public.chip_order_items i on i.order_id = o.id
        where i.contact_id = $1`, [made.contacts[APT_REC]],
    )).rows;
    expect(orders).toHaveLength(1);
    const order = orders[0]!;
    expect(order).toMatchObject({
      source: 'reception', status: 'collected', full_name: 'אבא משלם', phone_e164: '+972539300011', email: 'payer.e2e@example.test',
      address: 'הרצל 5, חיפה 3303105', role: 'tenant', total: 3 * price, payment_method: 'cash_transfer', is_test: false,
      internal_note: 'שולם במזומן בקבלה', grow_process_id: null, grow_transaction_id: null, due_at: null, chips_count: 3,
    });
    const recordedBy = order.payment_recorded_by_name as string;
    expect(recordedBy).toBeTruthy();
    expect(order.payment_recorded_at).toBeTruthy();
    // Its people: one holder line per block, part of what was paid.
    expect((await pool.query(
      `select source, role, full_name, phone, email, chips_count, to_char(lease_end_date, 'YYYY-MM-DD') as lease_end
         from public.chip_order_holders where order_id = $1 order by position`, [order.id],
    )).rows).toEqual([
      { source: 'reception', role: 'tenant', full_name: 'שוכר קבלה', phone: '+972539300011', email: 'renter.e2e@example.test', chips_count: 2, lease_end: '2030-01-31' },
      { source: 'reception', role: 'other', full_name: 'אורח קבלה', phone: null, email: null, chips_count: 1, lease_end: null },
    ]);
    // Its chips: linked to the order line, the renter's two carry his email and his lease.
    const chips = (await pool.query<Record<string, unknown>>(
      `select chip_number, chip_type, status, order_item_id, order_holder_id is not null as on_holder, reception_record_id, holder_email, lease_file_key,
              to_char(lease_end_date, 'YYYY-MM-DD') as lease_end, notes
         from public.chips where contact_id = $1 order by chip_number`, [made.contacts[APT_REC]],
    )).rows;
    expect(chips.map((c) => [c.chip_number, c.chip_type, c.holder_email, c.lease_file_key, c.lease_end])).toEqual([
      [`RC${tag}1`, 'physical', 'renter.e2e@example.test', leaseKey, '2030-01-31'],
      [`RC${tag}2`, 'app', 'renter.e2e@example.test', leaseKey, '2030-01-31'],
      [`RC${tag}3`, 'physical', null, null, null],
    ]);
    for (const c of chips) expect(c).toMatchObject({ status: 'active', order_item_id: order.item_id, on_holder: true, reception_record_id: null, notes: 'שולם במזומן בקבלה' });
    // Nobody was notified, and no no-charge record was made: the order is the record.
    expect((await pool.query(`select count(*)::int as n from public.chip_order_notifications where order_id = $1`, [order.id])).rows[0].n).toBe(0);
    expect((await pool.query(`select count(*)::int as n from public.chip_reception_records where contact_id = $1`, [made.contacts[APT_REC]])).rows[0].n).toBe(0);
    // The order and its payment are in the audit trail.
    await expect.poll(async () => (await pool.query<{ action: string; metadata: Record<string, unknown> }>(
      `select action, metadata from public.audit_log where entity_type = 'chip_order' and entity_id = $1 order by created_at, action`, [order.id],
    )).rows.map((r) => r.action).sort()).toEqual(['created', 'payment_recorded']);
    expect((await pool.query<{ metadata: Record<string, unknown> }>(
      `select metadata from public.audit_log where entity_type = 'chip_order' and entity_id = $1 and action = 'payment_recorded'`, [order.id],
    )).rows[0]!.metadata).toMatchObject({ source: 'reception', method: 'cash_transfer', amount: 3 * price, unit_price: price, chips: 3, order_number: order.order_number, apartment_number: APT_REC });

    // ── The Orders tab: there, tagged "קבלה", collected, nothing to press ───
    await page.goto('/chips?view=orders');
    const row = orderRow(page, APT_REC);
    await expect(row).toHaveCount(1);
    await expect(row.locator('[data-col="orderer"]')).toHaveText(/^אבא משלםשוכר · 0539300011$/);
    await expect(row.locator('[data-col="tags"]').getByTestId('chip-order-reception-badge')).toHaveText('קבלה');
    await expect(row.locator('[data-col="tags"]').locator('[data-testid^="chip-order-"]')).toHaveCount(1); // never "בדיקה": test rules do not apply
    await expect(row.getByTestId('chip-order-stage')).toHaveText('נאסף');
    const action = row.locator('[data-col="action"]');
    await expect(action.getByTestId('chip-order-row-done')).toHaveText('נאסף');
    await expect(action.getByRole('button')).toHaveCount(0);
    // It waits for nobody: the badge on the tab counts the open rows only.
    const open = (await pool.query<{ n: number }>(
      `select count(*)::int as n from public.chip_order_items i join public.chip_orders o on o.id = i.order_id
        where o.status in ('paid', 'approved', 'ready') and not o.is_test`,
    )).rows[0]!.n;
    const badge = page.getByRole('tab', { name: /הזמנות/ }).locator('.chip-num');
    if (open > 0) await expect(badge).toHaveText(String(open));
    else await expect(badge).toHaveCount(0);
    // The open orders come first: after the first collected row every row is collected.
    const stages = await page.getByTestId('chip-orders-table').getByTestId('chip-order-stage').allInnerTexts();
    const firstCollected = stages.indexOf('נאסף');
    expect(stages.slice(firstCollected).every((t) => t === 'נאסף'), `open rows first: ${stages.join(' | ')}`).toBe(true);

    // In the search, and in the Excel file — the tag in words, the status, the amount.
    await page.getByTestId('chip-orders-search').fill('אבא משלם');
    await expect(page.getByTestId('chip-orders-table').getByTestId('chip-order-row')).toHaveCount(1);
    const excel = await download(page, 'chip-orders-export');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(excel.bytes as unknown as ArrayBuffer);
    const ws = wb.worksheets[0]!;
    expect(ws.rowCount).toBe(2);
    expect(Array.from({ length: 12 }, (_, i) => ws.getRow(2).getCell(i + 1).value)).toEqual([
      order.order_number, dateInIsrael(order.created_at as Date), 'אבא משלם', '0539300011', 'קבלה', APT_REC, 'שוכר קבלה, אורח קבלה', 3, 3 * price, 'נאסף', null, 'לא',
    ]);
    const paper = await printed(page, 'chip-orders-print');
    expect(paper.rows).toBe(1);
    expect(paper.text).toContain('קבלה');
    expect(paper.text).toContain('אבא משלם');
    await page.getByTestId('chip-orders-search').fill('');

    // ── It opens in the window like any order — read only ───────────────────
    await row.click();
    const section = issue.getByTestId('chip-order-section');
    await expect(section).toContainText(String(order.order_number));
    await expect(section.getByTestId('chip-order-reception-tag')).toHaveText('קבלה');
    await expect(section).toContainText('אבא משלם');
    await expect(section).toContainText('payer.e2e@example.test');
    await expect(section).toContainText('הרצל 5, חיפה 3303105');
    await expect(section).toContainText(`כרטיס בקרת כניסה — 3×${price}₪`);
    await expect(section.getByTestId('chip-order-progress')).toHaveText('3 מתוך 3');
    await expect(section.getByTestId('chip-order-payment-method')).toHaveText('מזומן או העברה');
    await expect(section.getByTestId('chip-order-payment-by')).toContainText(recordedBy);
    // The status row: "נאסף" is where it stands, and none of the three status
    // buttons can be pressed. The one thing an admin can still do to an order
    // of the reception is cancel it (25/11/2026 — its own test, further down).
    const actions = issue.getByTestId('chip-order-actions');
    await expect(actions.locator('[aria-current="step"]')).toHaveText('נאסף');
    await expect(actions.getByRole('button')).toHaveText(['מוכן לאיסוף', 'נאסף', 'דחה', 'בטל הזמנת קבלה']);
    for (const name of ['מוכן לאיסוף', 'נאסף', 'דחה']) await expect(actions.getByRole('button', { name, exact: true })).toBeDisabled();
    await expect(actions.getByTestId('chip-order-cancel-reception')).toBeEnabled();
    await expect(section.getByTestId('chip-order-ready-reason')).toHaveText('הזמנת קבלה: שולמה ונמסרה במקום — ההזמנה סגורה');
    // One block per person, with what the reception stored — and none of it editable.
    await expect(issue.getByTestId('chip-order-closed-note')).toContainText('הזמנת קבלה');
    await expect(blocks).toHaveCount(2);
    const [rb, gb] = [blocks.nth(0), blocks.nth(1)];
    await expect(rb.getByLabel('שם מלא')).toHaveValue('שוכר קבלה');
    await expect(rb.getByLabel('מייל')).toHaveValue('renter.e2e@example.test');
    await expect(rb.getByTestId('chip-alloc-counter')).toHaveText('שויכו 2 מתוך 2');
    await expect(rb).toContainText('סיום חוזה: 31.01.2030');
    await expect(rb.getByTestId('chip-order-lease-link')).toHaveAttribute('href', leaseHref);
    await expect(gb.getByLabel('שם מלא')).toHaveValue('אורח קבלה');
    await expect(gb.getByTestId('chip-alloc-counter')).toHaveText('שויכו 1 מתוך 1');
    for (const field of [rb.getByLabel('שם מלא'), rb.getByLabel('טלפון נייד'), rb.getByLabel('מייל'), gb.getByLabel('שם מלא'), rb.getByLabel(/^מספר צ׳יפ/), issue.getByLabel('הערה', { exact: true })]) {
      await expect(field).toBeDisabled();
    }
    await expect(issue.getByRole('button', { name: 'הוסף בעל צ׳יפ' })).toBeDisabled();
    await expect(issue.getByTestId('chip-holder-registry-update')).toHaveCount(0);
    await expect(issue.getByTestId('chip-issue-save')).toBeDisabled();
    await expect(issue.getByLabel('עמלת הנפקה (₪)')).toHaveCount(0);
    // The chips themselves still answer: the switch of a chip is the chip's own action.
    await expect(rb.getByRole('button', { name: `השבת את RC${tag}1` })).toBeEnabled();
    await issue.getByTestId('chip-issue-close').click();
    await expect(issue).toHaveCount(0);

    // ── And from the chips side: the block says again where its chips came from ─
    await page.goto('/chips');
    await page.getByRole('button', { name: 'הנפק צ׳יפ' }).click();
    await pickApartment(page, APT_REC);
    const tenantBlock = blocks.filter({ hasText: 'שוכר קבלה' });
    await expect(tenantBlock.getByLabel('מייל')).toHaveValue('renter.e2e@example.test');
    await expect(tenantBlock.getByTestId('chip-lease-link')).toHaveAttribute('href', leaseHref);
    await expect(tenantBlock.getByLabel('תאריך סיום חוזה')).toHaveValue('2030-01-31');
    const kept = tenantBlock.getByTestId('chip-reception-records');
    await expect(kept).toContainText(`הזמנת קבלה ${order.order_number}`);
    await expect(kept).toContainText(`שולם ${3 * price}₪ · מזומן או העברה`);
    await expect(kept).toContainText('מזמין: אבא משלם · 0539300011 · payer.e2e@example.test · הרצל 5, חיפה 3303105');
    await issue.getByTestId('chip-issue-close').click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'צא ללא שמירה' }).click();
    await expect(issue).toHaveCount(0);
    // …and so does the holder's own panel: the lease (a link, for whoever may
    // open leases), its end date, the email and the order the chips came from.
    await page.getByPlaceholder('חפש לפי מספר צ׳יפ, מספר דירה או שם דייר').fill(`RC${tag}1`);
    // (He holds two chips: the search has to land — one row — before his name is one button.)
    await expect(page.getByRole('button', { name: 'שוכר קבלה', exact: true })).toHaveCount(1);
    await page.getByRole('button', { name: 'שוכר קבלה', exact: true }).click();
    const holderPanel = page.getByRole('dialog').filter({ hasText: 'הצ׳יפים של שוכר קבלה' });
    const stored = holderPanel.getByTestId('chip-holder-details');
    await expect(stored).toContainText('renter.e2e@example.test');
    await expect(stored.getByTestId('chip-holder-lease-link')).toHaveAttribute('href', leaseHref);
    await expect(stored).toContainText('31.01.2030');
    await expect(stored.getByTestId('chip-holder-reception-record')).toContainText(`הזמנת קבלה ${order.order_number}`);
    await expect(stored.getByTestId('chip-holder-reception-record')).toContainText(`שולם ${3 * price}₪ · מזומן או העברה`);
    await page.keyboard.press('Escape');
    await expect(holderPanel).toHaveCount(0);

    // The stand-in Storage goes back to what the later tests expect to find in it.
    storage.objects.delete(`chip-order-leases/${leaseKey}`);
  });

  test('a manager — not an admin — issues with the permission of issuing chips: no "אשראי" at all, a recorded payment makes the order, the lease is attached without a link, and the Orders tab stays out of reach', async ({ browser, request }) => {
    const price = await unitPrice();
    const email = `chip-manager-${tag}@billing.local`;
    const created = await request.post('/api/users', { data: { role: 'manager', email, full_name: `מנהל קבלה ${tag}`, password: 'E2e-Chip-Pass1!' } });
    expect(created.status(), await created.text()).toBe(201);
    const managerId = (await pool.query<{ id: string }>(`select id from public.users where email = $1`, [email])).rows[0]!.id;
    made.users.push(managerId);
    const page = await pageAs(browser, managerId);

    await page.goto('/chips');
    // A manager holds the chips module and not the orders: no "הזמנות" view.
    await expect(page.getByRole('heading', { name: 'צ׳יפי כניסה' })).toBeVisible();
    await expect(page.getByRole('tab', { name: /הזמנות/ })).toHaveCount(0);
    await page.getByRole('button', { name: 'הנפק צ׳יפ' }).click();
    const issue = issueWindow(page);
    await pickApartment(page, APT_MGR);
    const block = issue.getByTestId('chip-holder-block');
    await block.getByRole('radio', { name: 'אורח' }).click();
    await block.getByLabel('שם מלא').fill('אורח של מנהל');
    await block.getByLabel('טלפון נייד').fill('0539300031');
    await addChip(block, `MG${tag}1`);

    // Two methods only — "אשראי" is not drawn for this role, not even disabled.
    const pay = issue.getByTestId('chip-reception-payment');
    await expect(pay.getByTestId('chip-pay-card')).toHaveCount(0);
    await expect(pay.getByRole('radio')).toHaveText([/^מזומן או העברה/, /^ללא חיוב/]);
    await expect(pay.getByText('אשראי')).toHaveCount(0);
    // The orderer follows the holder — phone and all.
    await expect(issue.getByTestId('chip-reception-orderer').getByLabel('טלפון נייד')).toHaveValue('0539300031');
    await pay.getByTestId('chip-pay-cash').click();
    await issue.getByTestId('chip-issue-save').click();
    await expect(issue).toHaveCount(0);
    await expect(toast(page, 'הצ׳יפ הונפק')).toContainText(`נרשם תשלום ${price}₪`);

    const order = (await pool.query<Record<string, unknown>>(
      `select o.source, o.status, o.full_name, o.phone_e164, o.email, o.address, o.role, o.total::float8 as total, o.payment_method,
              o.payment_recorded_by, o.payment_recorded_by_name
         from public.chip_orders o join public.chip_order_items i on i.order_id = o.id where i.contact_id = $1`, [made.contacts[APT_MGR]],
    )).rows;
    // A guest's order, with no email and no address — nothing of it was required.
    expect(order).toEqual([{
      source: 'reception', status: 'collected', full_name: 'אורח של מנהל', phone_e164: '+972539300031', email: null, address: null, role: 'other',
      total: price, payment_method: 'cash_transfer', payment_recorded_by: managerId, payment_recorded_by_name: `מנהל קבלה ${tag}`,
    }]);

    // A lease: this role may attach one and may not open the lease bucket — so
    // the block says it is attached, with no link (and the proxy refuses).
    await page.getByRole('button', { name: 'הנפק צ׳יפ' }).click();
    await pickApartment(page, APT_NOORD);
    const renter = issue.getByTestId('chip-holder-block');
    await renter.getByRole('radio', { name: 'שוכר' }).click();
    const leaseBox = renter.getByTestId('chip-lease-box');
    await leaseBox.getByLabel('צרף חוזה שכירות').setInputFiles({ name: 'lease.pdf', mimeType: 'application/pdf', buffer: PDF });
    await expect(leaseBox.getByTestId('chip-lease-attached')).toHaveText('החוזה צורף');
    await expect(leaseBox.getByTestId('chip-lease-link')).toHaveCount(0);
    const uploaded = storage.keys('chip-order-leases').filter((k) => !made.leases.some((l) => k.endsWith(l)));
    expect(uploaded).toHaveLength(1);
    expect((await page.request.get(`/api/files/${uploaded[0]}`)).status()).toBe(403);
    // Not saved: the window is closed without issuing anything.
    await issue.getByTestId('chip-issue-close').click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'צא ללא שמירה' }).click();
    await expect(issue).toHaveCount(0);
    storage.objects.delete(uploaded[0]!);

    // The orders list itself is closed to this role, also by its address.
    expect((await page.request.get('/api/chip-orders')).status()).toBe(403);
  });

  test('a lease still on its way when the apartment is switched never lands on the other apartment\'s block', async ({ page }) => {
    await page.goto('/chips');
    await page.getByRole('button', { name: 'הנפק צ׳יפ' }).click();
    const issue = issueWindow(page);
    await pickApartment(page, APT_NOORD);
    const block = issue.getByTestId('chip-holder-block');
    await block.getByRole('radio', { name: 'שוכר' }).click();
    // The upload answers late — after the manager has moved to another apartment.
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    await page.route('**/api/chips/leases', async (route) => {
      await held;
      await route.continue();
    });
    const answered = page.waitForResponse((r) => r.url().endsWith('/api/chips/leases'));
    await block.getByTestId('chip-lease-box').getByLabel('צרף חוזה שכירות').setInputFiles({ name: 'lease.pdf', mimeType: 'application/pdf', buffer: PDF });
    await expect(block.getByTestId('chip-lease-upload')).toContainText('מעלה…');

    // Another apartment: its window starts with ONE empty block — the same block number as before.
    await issue.locator('#chip-contact').click();
    await page.getByPlaceholder('מספר דירה או שם דייר…').fill(APT_MGR);
    await page.locator('[data-slot="popover-content"]').getByRole('button').filter({ hasText: APT_MGR }).first().click();
    await expect(issue.locator('#chip-contact')).toContainText(APT_MGR);
    release();
    expect((await answered).status()).toBe(201);
    await page.unroute('**/api/chips/leases');
    // The file arrived — for the apartment that is no longer on the screen. No
    // block of this one took it: a lease box shows only for a renter or for a
    // block that HOLDS a lease, and this block is neither.
    await page.waitForTimeout(400);
    await expect(issue.getByTestId('chip-lease-box')).toHaveCount(0);
    await expect(issue.getByTestId('chip-lease-link')).toHaveCount(0);
    await issue.getByTestId('chip-issue-close').click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'צא ללא שמירה' }).click();
    await expect(issue).toHaveCount(0);
    // The object the upload left in the stand-in Storage belongs to no chip.
    for (const key of storage.keys('chip-order-leases').filter((k) => !made.leases.some((l) => k.endsWith(l)))) storage.objects.delete(key);
  });

  test('the look of the window without an order: the orderer row, the lease row, the breakdown and the payment methods — nothing cut or scrolling sideways from 1440 down to 320, and the rows fold at the window\'s two breakpoints', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/chips');
    await page.getByRole('button', { name: 'הנפק צ׳יפ' }).click();
    const issue = issueWindow(page);
    await pickApartment(page, APT_NOORD);
    const block = issue.getByTestId('chip-holder-block');
    await block.getByRole('radio', { name: 'שוכר' }).click();
    await block.getByLabel('מייל').fill('a-very-long-address-of-a-renter-that-must-not-push-the-row@example-domain-for-e2e.test');
    await addChip(block, `LY${tag}1`);
    const orderer = issue.getByTestId('chip-reception-orderer');
    await orderer.getByLabel('כתובת מגורים נוכחית (רחוב ומספר בית)').fill('שדרות הנשיא המאוד ארוכות 123, כניסה ב׳, דירה 45');
    const pay = issue.getByTestId('chip-reception-payment');
    await pay.getByTestId('chip-pay-cash').click();
    const body = issue.getByTestId('chip-issue-body');
    const columns = (el: Locator) => el.first().evaluate((node) => getComputedStyle(node).gridTemplateColumns.split(' ').length);

    for (const width of [1440, 1024, 780, 701, 700, 541, 540, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await expect.poll(async () => (await issue.boundingBox())!.x, { message: `panel on the left edge @${width}` }).toBe(0);
      expect(await body.evaluate((el) => el.scrollWidth - el.clientWidth), `the body scrolls sideways @${width}`).toBeLessThanOrEqual(0);
      expect(await cutOff(issue), `content cut off sideways @${width}`).toEqual([]);
      // Name · phone · email and street · city · zip: three in a row, two under
      // 700px (the long field on a line of its own), one under 540px.
      const want = width > 700 ? 3 : width > 540 ? 2 : 1;
      expect(await columns(orderer.locator('.ci-ordrow')), `orderer: name / phone / email @${width}`).toBe(want);
      expect(await columns(orderer.locator('.ci-addrrow')), `orderer: street / city / zip @${width}`).toBe(want);
      expect(await columns(block.locator('.ci-ordrow')), `holder: name / phone / email @${width}`).toBe(want);
      // The lease and its end date; the three payment methods.
      expect(await columns(block.locator('.ci-leasegrid')), `lease / end date @${width}`).toBe(width > 540 ? 2 : 1);
      expect(await columns(pay.locator('.ci-payseg')), `payment methods @${width}`).toBe(width > 540 ? 3 : 1);
      // Every payment method is a real target: at least 44px tall.
      for (const option of await pay.getByRole('radio').all()) {
        expect((await option.boundingBox())!.height, `a payment method is at least 44px tall @${width}`).toBeGreaterThanOrEqual(44);
      }
      // A desktop keeps the reference's 14px in the fields at every width.
      expect(await fieldSizes(issue), `field font size @${width}`).toEqual(['14px']);
    }
    // The amount is a number as every number of the window: Inter, tabular, left to right.
    const total = await pay.getByTestId('chip-reception-total').evaluate((el) => {
      const cs = getComputedStyle(el);
      return { family: cs.fontFamily.split(',')[0]!.replace(/["']/g, '').trim(), numeric: cs.fontVariantNumeric, direction: cs.direction };
    });
    expect(total).toEqual({ family: 'Inter', numeric: 'tabular-nums', direction: 'ltr' });

    await page.setViewportSize({ width: 1280, height: 720 });
    await issue.getByTestId('chip-issue-close').click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'צא ללא שמירה' }).click();
    await expect(issue).toHaveCount(0);
  });
});

// The Orders tab itself (24/11/2026): the action column of a row, the table's
// columns, the search, and the three export buttons — which the chips tab
// carries too. Orders of its own.
test.describe.serial('staff: extra chips of a web order, and cancelling the reception order they made', () => {
  let web: Awaited<ReturnType<typeof seedPaidOrder>>;
  let managerId = '';
  const first = `XT${tag}1`;
  const second = `XT${tag}2`;
  const third = `XT${tag}3`;
  const extraRow = (page: Page) => orderRow(page, APT_EXTRA).filter({ has: page.getByTestId('chip-order-extra-badge') });
  const webRow = (page: Page) => orderRow(page, APT_EXTRA).filter({ hasNot: page.getByTestId('chip-order-extra-badge') });
  const receptionOrder = async () => (await pool.query<{
    id: string; order_number: number; source: string; status: string; total: number; payment_method: string; is_test: boolean;
    full_name: string; reject_reason: string | null; cancelled_by_name: string | null;
  }>(
    `select id, order_number, source, status, total::float8 as total, payment_method, is_test, full_name, reject_reason, cancelled_by_name
       from public.chip_orders where extra_of_order_id = $1`, [web.id])).rows;
  const chipStatus = async (number: string) => (await pool.query<{ status: string }>(`select status from public.chips where chip_number = $1`, [number])).rows[0]?.status;

  test.beforeAll(async () => {
    web = await seedPaidOrder([{ apt: APT_EXTRA, role: 'owner', name: 'גלית תוספת', phone: '+972539300041', qty: 1 }]);
    // A manager who holds every chips permission the matrix can grant — still not an admin.
    const u = await pool.query<{ id: string }>(
      `insert into public.users (username, email, password_hash, full_name, role, is_active)
       values ($1, $1, 'x', $2, 'manager', true) returning id`, [`chip-mgr-orders-${tag}@billing.local`, `מנהל הזמנות ${tag}`]);
    managerId = u.rows[0]!.id;
    made.users.push(managerId);
    for (const mod of ['chips', 'chips_orders_manage']) {
      await pool.query(`insert into public.user_permissions (user_id, module, can_view, can_edit) values ($1, $2, true, true)`, [managerId, mod]);
    }
  });

  test.afterAll(async () => {
    if (managerId) await pool.query(`delete from public.user_permissions where user_id = $1`, [managerId]);
  });

  test('a number beyond the paid quantity is an extra chip: the reception\'s payment section for it alone, nothing chosen; "מזומן או העברה" confirms a sum and makes a reception order for the extra — the web order and its total do not change', async ({ page }) => {
    const price = await unitPrice();
    await page.goto('/chips?view=orders');
    await webRow(page).click();
    const issue = issueWindow(page);
    const block = issue.getByTestId('chip-holder-block');
    const section = issue.getByTestId('chip-order-section');
    const save = issue.getByTestId('chip-issue-save');
    const extra = issue.getByTestId('chip-order-extra-payment');

    // Inside what the apartment paid for: no payment section, as always.
    await addChip(block, first);
    await expect(extra).toHaveCount(0);
    await expect(save).toBeEnabled();

    // One more: it is beyond the paid quantity.
    await addChip(block, second);
    await expect(extra).toContainText('נוסף צ׳יפ אחד מעבר לכמות ששולמה באתר');
    await expect(extra).toContainText('ההזמנה מהאתר והסכום שלה לא משתנים');
    await expect(extra.getByTestId('chip-reception-breakdown')).toContainText('כרטיס בקרת כניסה');
    await expect(extra.getByTestId('chip-reception-total')).toHaveText(`${price}₪`);
    // The same three methods as at the reception, none chosen; "אשראי" is drawn and off.
    await expect(extra.getByRole('radio')).toHaveText([/^אשראי/, /^מזומן או העברה/, /^ללא חיוב/]);
    await expect(extra.getByTestId('chip-pay-card')).toBeDisabled();
    for (const id of ['chip-pay-cash', 'chip-pay-none']) await expect(extra.getByTestId(id)).toHaveAttribute('aria-checked', 'false');
    await expect(save).toBeDisabled();
    await expect(extra.getByTestId('chip-reception-reason')).toHaveText('יש לבחור אמצעי תשלום לצ׳יפים שנוספו מעבר לכמות ששולמה');

    // "מזומן או העברה" is the confirmation of the sum on the screen…
    await extra.getByTestId('chip-pay-cash').click();
    await expect(extra.getByTestId('chip-pay-cash')).toContainText(`אישור: התקבלו ${price}₪`);
    await expect(save).toBeEnabled();
    // …so a sum that moves takes the choice back.
    await addChip(block, third);
    await expect(extra).toContainText('נוספו 2 צ׳יפים מעבר לכמות ששולמה באתר');
    await expect(extra.getByTestId('chip-pay-cash')).toHaveAttribute('aria-checked', 'false');
    await expect(extra.getByTestId('chip-reception-reason')).toContainText('הסכום לתשלום השתנה');
    await expect(save).toBeDisabled();
    await block.getByRole('button', { name: `הסר את המספר ${third} מהרשימה` }).click();
    await expect(extra.getByTestId('chip-reception-total')).toHaveText(`${price}₪`);
    await extra.getByTestId('chip-pay-cash').click();
    await expect(save).toBeEnabled();

    await save.click();
    await expect(issue).toHaveCount(0); // a save closes the window (25/11/2026)
    const made1 = await expect.poll(async () => (await receptionOrder()).length).toBe(1).then(receptionOrder);
    const rec = made1[0]!;
    await expect(toast(page, `נרשם תשלום על צ׳יפ נוסף אחד — הזמנת קבלה ${rec.order_number}`)).toBeVisible();
    // An order of the reception, for the extra chip only: paid, collected, never a test order.
    expect(rec).toMatchObject({ source: 'reception', status: 'collected', total: price, payment_method: 'cash_transfer', is_test: false, full_name: 'גלית תוספת' });
    // The web order: the same line, quantity and total.
    expect((await pool.query(
      `select o.total::float8 as total, o.status, i.chips_count, i.line_total::float8 as line_total,
              (select count(*)::int from public.chips c where c.order_item_id = i.id and c.status = 'active') as linked
         from public.chip_orders o join public.chip_order_items i on i.order_id = o.id where o.id = $1`, [web.id])).rows)
      .toEqual([{ total: 50, status: 'paid', chips_count: 1, line_total: 50, linked: 1 }]);
    // The extra chip belongs to the reception order.
    expect((await pool.query(
      `select c.chip_number from public.chips c join public.chip_order_items i on i.id = c.order_item_id where i.order_id = $1`, [rec.id])).rows)
      .toEqual([{ chip_number: second }]);
    expect((await pool.query(`select count(*)::int as n from public.chip_order_notifications where order_id = any($1::uuid[])`, [[rec.id, web.id]])).rows[0].n).toBe(0);

    // The window, opened again: the order holds what it paid for, and the paid extra is shown in the person's block.
    await webRow(page).click();
    await expect(block.getByTestId('chip-alloc-counter')).toBeVisible();
    await expect(extra).toHaveCount(0);
    await expect(block.getByTestId('chip-alloc-counter')).toHaveText('שויכו 1 מתוך 1');
    await expect(block.getByRole('button', { name: `השבת את ${second}` })).toBeVisible();
    await expect(block.getByTestId('chip-extra-tag')).toHaveText('נוסף · קבלה');
    await expect(section.getByTestId('chip-order-progress')).toHaveText('1 מתוך 1');
    await expect(section.getByTestId('chip-order-extra-orders')).toContainText(`הזמנת קבלה ${rec.order_number}`);
    await expect(section.getByTestId('chip-order-extra-orders')).toContainText(`${price}₪`);
    await expect(section).toContainText('כרטיס בקרת כניסה — 1×50₪');
    await noSideScroll(page);
    await issue.getByTestId('chip-issue-close').click();
    await expect(issue).toHaveCount(0);

    // The Orders tab: the reception order of the extras, tagged — after the open order.
    await expect(extraRow(page)).toHaveCount(1);
    await expect(extraRow(page).getByTestId('chip-order-reception-badge')).toHaveText('קבלה');
    await expect(extraRow(page).getByTestId('chip-order-extra-badge')).toHaveText('צ׳יפים נוספים');
    await expect(extraRow(page).getByTestId('chip-order-stage')).toHaveText('נאסף');
    await expect(webRow(page).getByTestId('chip-order-stage')).toHaveText('שויך');

    // Ready: the guard's pickup list carries BOTH chips under the person — the extra is handed over with the order.
    expect((await page.request.post(`/api/chip-orders/${web.id}/ready`)).status()).toBe(200);
    const pickup = (await (await page.request.get('/api/chip-pickup')).json()) as { orders: { id: string; total: number; people: { name: string; chips: { number: string }[] }[] }[] };
    const mine = pickup.orders.find((o) => o.id === web.id)!;
    expect(mine.total).toBe(2);
    expect(mine.people.map((p) => [p.name, p.chips.map((c) => c.number)])).toEqual([['גלית תוספת', [first, second]]]);
  });

  test('"בטל הזמנת קבלה": admin only, a reason required — the order becomes "בוטל" and stays in the table, its chip is disabled (never deleted), nobody is notified', async ({ page, browser }) => {
    const rec = (await receptionOrder())[0]!;

    // A manager — with every chips permission — sees the order, and no way to cancel it.
    const manager = await pageAs(browser, managerId);
    await manager.goto('/chips?view=orders');
    await extraRow(manager).click();
    const managerWindow = issueWindow(manager);
    await expect(managerWindow.getByTestId('chip-order-reception-tag')).toHaveText('קבלה');
    await expect(managerWindow.getByTestId('chip-order-cancel-reception')).toHaveCount(0);
    await expect(managerWindow.getByTestId('chip-order-actions').getByRole('button')).toHaveText(['מוכן לאיסוף', 'נאסף', 'דחה']);
    expect((await manager.request.post(`/api/chip-orders/${rec.id}/cancel`, { data: { reason: 'ניסיון של מנהל' } })).status()).toBe(403);
    expect((await receptionOrder())[0]!.status).toBe('collected');

    await page.goto('/chips?view=orders');
    await extraRow(page).click();
    const issue = issueWindow(page);
    const section = issue.getByTestId('chip-order-section');
    await expect(section.getByTestId('chip-order-extra-tag')).toHaveText(`צ׳יפים נוספים להזמנה ${web.orderNumber}`);
    await section.getByTestId('chip-order-cancel-reception').click();
    const dialog = page.getByTestId('chip-order-cancel-confirm');
    await expect(dialog).toContainText(`לבטל את הזמנת הקבלה ${rec.order_number}?`);
    await expect(dialog).toContainText('הצ׳יפים שלה יושבתו');
    await expect(dialog).toContainText('לא נשלחת הודעה ללקוח');
    const confirm = dialog.getByRole('button', { name: 'בטל הזמנת קבלה' });
    // No reason, no cancellation.
    await expect(confirm).toBeDisabled();
    await dialog.getByLabel('סיבת הביטול').fill('נ');
    await expect(confirm).toBeDisabled();
    // Backing out changes nothing.
    await dialog.getByRole('button', { name: 'חזרה' }).click();
    await expect(dialog).toHaveCount(0);
    expect((await receptionOrder())[0]!.status).toBe('collected');
    expect(await chipStatus(second)).toBe('active');

    await section.getByTestId('chip-order-cancel-reception').click();
    await dialog.getByLabel('סיבת הביטול').fill('נרשם בטעות');
    await confirm.click();
    await expect(toast(page, 'הזמנת הקבלה בוטלה')).toBeVisible();
    await expect(issue).toHaveCount(0);

    const after = (await receptionOrder())[0]!;
    expect(after).toMatchObject({ status: 'rejected', reject_reason: 'נרשם בטעות' });
    expect(after.cancelled_by_name).toBeTruthy();
    // Its chip is disabled, not deleted; the web order's own chip is untouched.
    expect(await chipStatus(second)).toBe('inactive');
    expect(await chipStatus(first)).toBe('active');
    expect((await pool.query(`select count(*)::int as n from public.chip_order_notifications where order_id = $1`, [rec.id])).rows[0].n).toBe(0);
    expect((await pool.query(
      `select action, metadata->>'reason' as reason from public.audit_log where entity_type = 'chip_order' and entity_id = $1 and action = 'reception_cancelled'`, [rec.id])).rows)
      .toEqual([{ action: 'reception_cancelled', reason: 'נרשם בטעות' }]);

    // The row stays in the table, with its status — and nothing to press.
    await expect(extraRow(page)).toHaveCount(1);
    await expect(extraRow(page).getByTestId('chip-order-stage')).toHaveText('בוטל');
    await expect(extraRow(page).getByTestId('chip-order-row-cancelled')).toHaveText('בוטל');
    // It opens read only, and says who cancelled and why — with no way to cancel again.
    await extraRow(page).click();
    await expect(issue.getByTestId('chip-order-closed-note')).toContainText('הזמנת הקבלה בוטלה');
    await expect(section.getByTestId('chip-order-cancel-reason')).toHaveText('נרשם בטעות');
    await expect(section.getByTestId('chip-order-cancelled-by')).toBeVisible();
    await expect(section.getByTestId('chip-order-cancel-reception')).toHaveCount(0);
    await expect(section.getByTestId('chip-order-ready-reason')).toContainText('הזמנת הקבלה בוטלה');
    expect((await page.request.post(`/api/chip-orders/${rec.id}/cancel`, { data: { reason: 'פעם שנייה' } })).status()).toBe(409);
    await issue.getByTestId('chip-issue-close').click();
    await expect(issue).toHaveCount(0);

    // The pickup list of the web order no longer carries the cancelled extra.
    const pickup = (await (await page.request.get('/api/chip-pickup')).json()) as { orders: { id: string; total: number }[] };
    expect(pickup.orders.find((o) => o.id === web.id)!.total).toBe(1);
    // A web order is never cancelled this way.
    expect((await page.request.post(`/api/chip-orders/${web.id}/cancel`, { data: { reason: 'הזמנה מהאתר' } })).status()).toBe(409);
  });

  test('the holder panel has ONE close button — the white X of the header — and it closes the panel', async ({ page }) => {
    await page.goto('/chips');
    await page.getByPlaceholder('חפש לפי מספר צ׳יפ, מספר דירה או שם דייר').fill(first);
    await expect(page.getByRole('button', { name: 'גלית תוספת', exact: true })).toHaveCount(1);
    await page.getByRole('button', { name: 'גלית תוספת', exact: true }).click();
    const panel = page.getByRole('dialog').filter({ hasText: 'הצ׳יפים של גלית תוספת' });
    await expect(panel).toBeVisible();
    // The shared Sheet's own built-in X is off: it used to sit, small and grey, on top of the header's.
    await expect(panel.locator('[data-slot="sheet-close"]')).toHaveCount(0);
    const close = panel.getByRole('button', { name: /^(סגור|Close)$/ });
    await expect(close).toHaveCount(1);
    await expect(close).toHaveAttribute('data-testid', 'chip-holder-close');
    const box = (await close.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
    await close.click();
    await expect(panel).toHaveCount(0);
  });
});

test.describe('staff: leases nobody saved', () => {
  test('a lease that was uploaded and never saved is swept by the hourly purge once it is 24 hours old — one that is attached to a chip never is, and neither is a fresh one', async ({ page, request }) => {
    const secret = process.env.BILLING_CRON_SECRET ?? '';
    expect(secret, 'BILLING_CRON_SECRET must be set for the purge route').not.toBe('');
    const bucket = 'chip-order-leases';
    const keysNow = () => storage.keys(bucket).map((k) => k.slice(bucket.length + 1));
    const registered = async (key: string) => (await pool.query(`select 1 from public.chip_lease_uploads where object_key = $1`, [key])).rowCount === 1;

    /** Opens the window on the apartment and uploads a lease in the renter's
     *  block — a first one ("צרף חוזה"), or over the one the block already
     *  shows ("החלף"); returns the new file's key. */
    async function uploadLease(how: 'attach' | 'replace'): Promise<string> {
      const before = new Set(keysNow());
      await page.getByRole('button', { name: 'הנפק צ׳יפ' }).click();
      await pickApartment(page, APT_LEASE);
      const renter = issueWindow(page).getByTestId('chip-holder-block');
      if (how === 'attach') await renter.getByRole('radio', { name: 'שוכר' }).click();
      const box = renter.getByTestId('chip-lease-box');
      await box.getByLabel(how === 'attach' ? 'צרף חוזה שכירות' : 'החלף את קובץ החוזה')
        .setInputFiles({ name: 'lease.pdf', mimeType: 'application/pdf', buffer: PDF });
      let added: string[] = [];
      await expect.poll(() => { added = keysNow().filter((k) => !before.has(k)); return added.length; }).toBe(1);
      await expect(box.getByTestId('chip-lease-link')).toHaveAttribute('href', `/api/files/${bucket}/${added[0]}`);
      return added[0]!;
    }
    async function leaveWithoutSaving() {
      const issue = issueWindow(page);
      await issue.getByTestId('chip-issue-close').click();
      await page.getByRole('alertdialog').getByRole('button', { name: 'צא ללא שמירה' }).click();
      await expect(issue).toHaveCount(0);
    }

    await page.goto('/chips');
    // 1. Uploaded, and the window is closed without a save.
    const abandoned = await uploadLease('attach');
    await leaveWithoutSaving();
    // 2. Uploaded and SAVED with a chip (no charge).
    const attached = await uploadLease('attach');
    const issue = issueWindow(page);
    await addChip(issue.getByTestId('chip-holder-block'), `LP${tag}1`);
    await issue.getByTestId('chip-reception-payment').getByTestId('chip-pay-none').click();
    await issue.getByTestId('chip-issue-save').click();
    await expect(issue).toHaveCount(0);
    expect((await pool.query(`select lease_file_key from public.chips where chip_number = $1`, [`LP${tag}1`])).rows[0].lease_file_key).toBe(attached);
    // 3. A moment ago: the saved lease is REPLACED in the window, and the window is left without a save.
    const fresh = await uploadLease('replace');
    await leaveWithoutSaving();
    // The chip still carries the lease that was saved.
    expect((await pool.query(`select lease_file_key from public.chips where chip_number = $1`, [`LP${tag}1`])).rows[0].lease_file_key).toBe(attached);
    // Every upload has its row in the registry.
    for (const key of [abandoned, attached, fresh]) expect(await registered(key), key).toBe(true);

    // A day goes by for the first two.
    await pool.query(`update public.chip_lease_uploads set uploaded_at = now() - interval '25 hours' where object_key = any($1::text[])`, [[abandoned, attached]]);
    // A file of the same bucket that THIS database never recorded — a lease of
    // the public order page, or one another database's instance put there.
    const foreign = `${randomUUID()}.pdf`;
    storage.objects.set(`${bucket}/${foreign}`, { contentType: 'application/pdf', bytes: PDF });
    expect(await registered(foreign)).toBe(false);

    // The purge is the cron route's, behind its secret.
    expect((await request.post('/api/cron/chip-orders-purge', { headers: { 'x-cron-secret': 'not-the-secret' } })).status()).toBe(401);
    for (const key of [abandoned, attached, fresh]) expect(keysNow()).toContain(key);
    const run = await request.post('/api/cron/chip-orders-purge', { headers: { 'x-cron-secret': secret } });
    expect(run.status(), await run.text()).toBe(200);
    const body = (await run.json()) as { ok: boolean; leases: { deleted: number; fileFailed: number } };
    expect(body.ok).toBe(true);
    expect(body.leases).toMatchObject({ fileFailed: 0 });
    expect(body.leases.deleted).toBeGreaterThanOrEqual(1);
    // The sweep works from its own rows alone: a file it has no row for stays.
    expect(keysNow()).toContain(foreign);
    storage.objects.delete(`${bucket}/${foreign}`);

    // Only the lease nobody saved is gone — the file and its row.
    expect(keysNow()).not.toContain(abandoned);
    expect(await registered(abandoned)).toBe(false);
    expect(keysNow()).toContain(attached);
    expect(await registered(attached)).toBe(true);
    expect(keysNow()).toContain(fresh);
    expect(await registered(fresh)).toBe(true);
    // The attached lease still opens.
    expect((await page.request.get(`/api/files/${bucket}/${attached}`)).status()).toBe(200);
    // A second run finds nothing more of ours to delete.
    const again = (await (await request.post('/api/cron/chip-orders-purge', { headers: { 'x-cron-secret': secret } })).json()) as { leases: { deleted: number } };
    expect(again.leases.deleted).toBe(0);
    expect(keysNow()).toContain(attached);

    // The stand-in Storage goes back to what the later tests expect to find in
    // it (they count the bucket's files): both files this test left there.
    storage.objects.delete(`${bucket}/${fresh}`);
    storage.objects.delete(`${bucket}/${attached}`);
  });
});

test.describe('staff: the Orders tab', () => {
  test('the action column of a row: a plain "בהמתנה" with what is missing — no button — until every chip of the ORDER is issued; then "מוכן לאיסוף" and "נאסף" ask first, never open the window, and the rows follow in place — also on a phone card', async ({ page }) => {
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

    // Nothing is issued: there is NO "מוכן לאיסוף" at all — a dimmed one read
    // as if the order were ready. The row waits: a plain label, with what is
    // missing written under it; nothing in the action column can be pressed,
    // and "נאסף" is not offered before its turn.
    for (const r of [rowA, rowB]) {
      await expect(r.getByTestId('chip-order-row-ready')).toHaveCount(0);
      await expect(r.getByTestId('chip-order-row-collected')).toHaveCount(0);
      const waiting = r.getByTestId('chip-order-row-waiting');
      await expect(waiting).toContainText('בהמתנה');
      await expect(waiting.getByTestId('chip-order-row-reason')).toHaveText('חסרים 2 צ׳יפים בהזמנה');
      await expect(r.locator('[data-col="action"]').locator('button, a, [role="button"]')).toHaveCount(0);
    }
    // A 1024px window with the menu panel open leaves the card narrower than
    // the table: the table scrolls sideways inside the card, and the action
    // column stays pinned to the card's edge — in sight without scrolling.
    await page.setViewportSize({ width: 1024, height: 800 });
    const table = page.getByTestId('chip-orders-table');
    expect(await table.evaluate((el) => el.scrollWidth > el.parentElement!.clientWidth), 'the table is wider than its card at 1024').toBe(true);
    await expect(rowA.getByTestId('chip-order-row-waiting')).toBeInViewport({ ratio: 1 });
    await expect(rowA.getByTestId('chip-order-row-reason')).toBeInViewport({ ratio: 1 });
    await noSideScroll(page);
    // The assistant's floating button lives in that same corner of the screen.
    // Scrolled to the end, the LAST row's button is clear of it: the card
    // leaves room under itself.
    await page.locator('main').evaluate((el) => el.scrollTo(0, el.scrollHeight));
    // (Whatever the last row holds: since 25/11/2026 it may be an order of the
    // reception, whose action is the plain label "נאסף".)
    const lastAction = (await table.getByTestId('chip-order-row').last()
      .locator('[data-testid="chip-order-row-waiting"], [data-testid="chip-order-row-ready"], [data-testid="chip-order-row-collected"], [data-testid="chip-order-row-done"]').boundingBox())!;
    const floating = (await page.locator('[data-agent-fab]').boundingBox())!;
    expect(lastAction.y + lastAction.height, 'the last row\'s action ends above the floating button').toBeLessThanOrEqual(floating.y);
    await page.locator('main').evaluate((el) => el.scrollTo(0, 0));
    await page.setViewportSize({ width: 1280, height: 720 });

    // A button may live inside the row, so the row itself is no button: a
    // mouse click anywhere on it opens the window, and for the keyboard (and
    // a screen reader) the orderer's name is the button that does.
    expect(await rowA.getAttribute('role')).toBeNull();
    await rowA.getByRole('button', { name: 'רותם שורה', exact: true }).press('Enter');
    await expect(issue).toBeVisible();
    await issue.getByTestId('chip-issue-close').click();
    await expect(issue).toHaveCount(0);
    // The waiting label holds no click of its own: pressed, the row under it
    // opens the issue window — which is where the missing chips are issued.
    await rowA.getByTestId('chip-order-row-waiting').click();
    await expect(issue).toBeVisible();
    await issue.getByTestId('chip-issue-close').click();
    await expect(issue).toHaveCount(0);

    // Apartment A gets its chip in the window. Its own stage is done — and its
    // button still waits, because the status belongs to the whole order.
    await rowA.click();
    await addChip(blocks.nth(0), `RW${tag}1`);
    await issue.getByTestId('chip-issue-save').click();
    await expect(issue).toHaveCount(0); // a save closes the window (25/11/2026)
    await expect(rowA.getByTestId('chip-order-stage')).toHaveText('שויך');
    await expect(rowA.getByTestId('chip-order-row-ready')).toHaveCount(0);
    await expect(rowA.getByTestId('chip-order-row-waiting')).toContainText('בהמתנה');
    await expect(rowA.getByTestId('chip-order-row-reason')).toHaveText('חסר צ׳יפ אחד בהזמנה');

    await rowB.click();
    await addChip(blocks.nth(1), `RW${tag}2`);
    await issue.getByTestId('chip-issue-save').click();
    await expect(issue).toHaveCount(0);

    // Every chip of the order is issued and saved: only now the button is
    // there, on both rows, and the waiting label is gone. It asks first — and
    // it does not open the issue window.
    for (const r of [rowA, rowB]) {
      await expect(r.getByTestId('chip-order-row-ready')).toBeEnabled();
      await expect(r.getByTestId('chip-order-row-waiting')).toHaveCount(0);
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

  // Ronen, 25/11/2026, on production: a TEST order — its chip issued and
  // "מוכן לאיסוף" pressed inside the window — and back in the table the row he
  // looked at offered no "נאסף". The order's row WAS there, ready, with its
  // "נאסף"; it was no longer where it had been. The tab listed every paid
  // order before every ready one, so the order jumped below the older test
  // orders of the same person that still waited for a chip, and the row now
  // in its place — the same name, apartment and date — was one of those,
  // "בהמתנה". The open orders now keep one order, by when they were paid.
  test('a test order marked ready inside the window: the window closes and the row stays where it was, now with "נאסף" — at every width the table is drawn and on a phone card — and "נאסף" from the row needs no window', async ({ page }) => {
    const NAME = 'נועה בדיקה';
    const PHONE = '+972539300061';
    const older = [await seedTestOrder(APT_RDY, NAME, PHONE, '2 hours'), await seedTestOrder(APT_RDY, NAME, PHONE, '1 hour')];
    const o = await seedTestOrder(APT_RDY, NAME, PHONE, '1 minute');
    const status = async () => (await pool.query(`select status from public.chip_orders where id = $1`, [o.id])).rows[0].status;
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/chips?view=orders');
    await expect(orderRow(page, APT_RDY)).toHaveCount(3);
    const place = await apiRowIndex(page, o.item);
    const olderPlaces = [await apiRowIndex(page, older[0]!.item), await apiRowIndex(page, older[1]!.item)];
    const row = tableRow(page, place);
    // Three rows that look alike; this one is the newest, waiting for its chip.
    await expect(row).toContainText(NAME);
    await expect(row.getByTestId('chip-order-test-badge')).toHaveText('בדיקה');
    await expect(row.getByTestId('chip-order-row-waiting')).toBeVisible();

    await row.click();
    const issue = issueWindow(page);
    const section = issue.getByTestId('chip-order-section');
    await expect(section).toContainText(String(o.orderNumber));
    await addChip(issue.getByTestId('chip-holder-block'), `RD${tag}1`);
    await section.getByRole('button', { name: 'מוכן לאיסוף' }).click();
    await expect(issue).toHaveCount(0);
    await expect(toast(page, 'סומן מוכן לאיסוף — נשלחה הודעה למזמין')).toBeVisible();
    expect(await status()).toBe('ready');
    // The same row, in the same place: ready, and "נאסף" is its next step.
    // The two older orders still wait, where they were.
    await expect(row.getByTestId('chip-order-stage')).toHaveText('מוכן לאיסוף');
    await expect(row.getByTestId('chip-order-row-collected')).toBeEnabled();
    expect(await apiRowIndex(page, o.item)).toBe(place);
    for (const p of olderPlaces) await expect(tableRow(page, p).getByTestId('chip-order-row-waiting')).toBeVisible();

    // Every width the table is drawn at (640px and up; narrower is the phone
    // card): the button is on the screen, inside the card, no sideways scroll.
    for (const width of [1280, 1024, 800, 640]) {
      await page.setViewportSize({ width, height: 800 });
      const btn = row.getByTestId('chip-order-row-collected');
      await expect(btn, `"נאסף" at ${width}px`).toBeVisible();
      const b = (await btn.boundingBox())!;
      const card = (await page.getByTestId('chip-orders-table').locator('..').boundingBox())!;
      expect(b.x, `"נאסף" inside the card at ${width}px`).toBeGreaterThanOrEqual(card.x - 0.5);
      expect(b.x + b.width, `"נאסף" inside the card at ${width}px`).toBeLessThanOrEqual(card.x + card.width + 0.5);
      await noSideScroll(page);
    }
    // A phone: the card carries the same button, 44px tall.
    await page.setViewportSize({ width: 390, height: 844 });
    const phoneButton = page.getByTestId('chip-order-card').nth(place).getByTestId('chip-order-row-collected');
    await expect(phoneButton).toBeVisible();
    expect((await phoneButton.boundingBox())!.height, 'a 44px touch target on a phone').toBeGreaterThanOrEqual(44);
    await page.setViewportSize({ width: 1280, height: 800 });

    // "נאסף" from the row: asked first, and no window opens.
    await row.getByTestId('chip-order-row-collected').click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText(`לסמן את הזמנה ${o.orderNumber} כנאספה?`);
    await expect(issue).toHaveCount(0);
    await dialog.getByRole('button', { name: 'סמן כנאסף' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(toast(page, 'סומן כנאסף')).toBeVisible();
    await expect.poll(status).toBe('collected');
    await expect.poll(() => apiRowIndex(page, o.item)).toBe(-1);
    await expect(orderRow(page, APT_RDY)).toHaveCount(2);
    for (const x of older) expect(await apiRowIndex(page, x.item)).toBeGreaterThanOrEqual(0);
    await page.setViewportSize({ width: 1280, height: 720 });
  });

  test('search by apartment number and by name (the orderer, the people of the order); "הדפסה", "ייצוא לאקסל" and "הורדה ל-PDF" take the rows the search left', async ({ page }) => {
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
    for (const id of ['chip-orders-print', 'chip-orders-export', 'chip-orders-pdf']) await expect(page.getByTestId(id)).toBeDisabled();
    await search.fill(`גדעון ${APT_S1}`);
    await expect(rows).toHaveCount(1);

    // "ייצוא לאקסל": the rows on the screen, in the agreed columns — the tags
    // right after the orderer, as in the table.
    const headers = ['מס׳ הזמנה', 'תאריך הזמנה', 'שם המזמין', 'טלפון', 'תגיות', 'דירה', 'בעלי הצ׳יפ', 'כמות', 'סה״כ (₪)', 'סטטוס', 'יעד להכנה', 'הזמנת בדיקה'];
    const excel = await download(page, 'chip-orders-export');
    expect(excel.name).toMatch(/^chip-orders_\d{4}-\d{2}-\d{2}\.xlsx$/);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(excel.bytes as unknown as ArrayBuffer);
    const ws = wb.worksheets[0]!;
    const cells = (n: number) => headers.map((_, i) => ws.getRow(n).getCell(i + 1).value);
    expect(ws.views[0]?.rightToLeft).toBe(true);
    expect(cells(1)).toEqual(headers);
    expect(ws.rowCount, 'the header and the one row the search left').toBe(2);
    // The order's date is the stored instant, in Israel time (read back from
    // the DB — "today" would be wrong for a run that crosses midnight).
    const ordered = (await pool.query<{ created_at: Date }>(`select created_at from public.chip_orders where id = $1`, [s1.id])).rows[0]!.created_at;
    expect(cells(2)).toEqual([
      s1.orderNumber, dateInIsrael(ordered), 'גדעון חיפוש', '0539300011', null, APT_S1, 'גדעון חיפוש, רינה שוכרת', 3, 150, 'ממתין לשיוך',
      expect.stringMatching(/^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/), 'לא',
    ]);

    // "הדפסה": the print dialog opens on a print-only table of the same rows —
    // right to left, and everything else on the page (the menu, the toolbar,
    // every button) hidden.
    const paper = await printed(page, 'chip-orders-print');
    expect(paper).toMatchObject({ dir: 'rtl', shown: 'block', controls: 0, restHidden: true, headers, rows: 1 });
    // "הזמנות צ׳יפים" — not "… פתוחות": the tab lists the reception orders too.
    expect(paper.text).toContain('הזמנות צ׳יפים');
    expect(paper.text).not.toContain('פתוחות');
    expect(paper.text).toContain('סה״כ 1 שורות');
    expect(paper.text).toContain(`סינון: „גדעון ${APT_S1}”`);
    expect(paper.text).toContain('גדעון חיפוש, רינה שוכרת');
    expect(paper.text).toContain(APT_S1);
    expect(paper.text).not.toContain('מיכל אחרת');
    await expect(rows).toHaveCount(1);

    // "הורדה ל-PDF": a real PDF file of the same rows, read back by what is
    // PAINTED — a Hebrew word goes on the page back to front (the glyphs are
    // laid left to right), a phone, an apartment number and a date do not.
    const pdf = await download(page, 'chip-orders-pdf');
    expect(pdf.name).toMatch(/^chip-orders_\d{4}-\d{2}-\d{2}\.pdf$/);
    expect(pdf.bytes.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.bytes.length, 'a real file, with its fonts inside').toBeGreaterThan(10_000);
    const file = pdf.bytes.toString('latin1');
    expect(file).toContain('/FontFile2'); // an embedded font program…
    expect(file).toContain('/BaseFont /Heebo'); // …the Hebrew one
    const ink = paintedText(pdf.bytes);
    expect(ink.every((p) => p.text !== null), 'nothing is drawn with a font that is not in the file').toBe(true);
    const lines = ink.map((p) => p.text);
    expect(lines).toContain(rev('הזמנות צ׳יפים')); // the title: the tab
    expect(lines.some((l) => /^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2} /.test(l!) && l!.endsWith(rev('תאריך הפקה:'))), 'the date, in its reading order').toBe(true);
    expect(lines).toContain(rev('גדעון חיפוש'));
    expect(lines).toContain(`${rev('רינה שוכרת')} ,${rev('גדעון חיפוש')}`);
    for (const asIs of ['0539300011', APT_S1, String(s1.orderNumber), dateInIsrael(ordered), '150', '3']) expect(lines, asIs).toContain(asIs);
    expect(lines).toContain(`1 ${rev('מתוך')} 1 ${rev('עמוד')}`); // the page number
    expect(lines.some((l) => l!.includes(rev('מיכל'))), 'the row the search hid is not in the file').toBe(false);

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

  test('the table: מזמין · תגיות · דירה · כמות · תאריך הזמנה · סטטוס · פעולה — the tags in a column of their own, every value under its header, and a tidy phone card with the same facts', async ({ page }) => {
    const plain = await seedPaidOrder([{ apt: APT_T1, role: 'owner', name: 'אביגיל עמודות', phone: '+972539300021', qty: 2 }]);
    // A test order that carries every tag: made in test mode, its phone never
    // proved, and a message to its orderer that failed.
    const flagged = await seedPaidOrder([{ apt: APT_T2, role: 'tenant', name: 'בועז תגיות', phone: '+972539300022', qty: 1, leaseEnd: '2030-01-31' }]);
    // (A test order never went through Grow — the table refuses one that carries Grow's ids.)
    await pool.query(
      `update public.chip_orders set is_test = true, phone_verified = false, role = 'tenant', grow_process_id = null, grow_transaction_id = null where id = $1`,
      [flagged.id],
    );
    await pool.query(
      `insert into public.chip_order_notifications (order_id, kind, channel, status, error) values ($1, 'paid', 'email', 'failed', 'e2e')`, [flagged.id],
    );
    try {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto('/chips?view=orders');
      const table = page.getByTestId('chip-orders-table');
      const rowPlain = orderRow(page, APT_T1);
      const rowFlagged = orderRow(page, APT_T2);
      await expect(rowPlain).toHaveCount(1);
      await expect(rowFlagged).toHaveCount(1);

      // The columns, right to left.
      const heads = table.getByTestId('chip-orders-head').locator('[data-col]');
      await expect(heads).toHaveText(['מזמין', 'תגיות', 'דירה', 'כמות', 'תאריך הזמנה', 'סטטוס', 'פעולה']);
      const headX = await heads.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().right));
      expect([...headX].sort((a, b) => b - a), 'the first column is the right-most').toEqual(headX);

      // The orderer's column: the name, the role and the phone under it — and
      // no tag. Every tag of the row stands in the tags column.
      const orderer = rowFlagged.locator('[data-col="orderer"]');
      await expect(orderer).toHaveText(/^בועז תגיותשוכר · 0539300022$/);
      await expect(orderer.locator('[data-testid^="chip-order-"]')).toHaveCount(0);
      const tags = rowFlagged.locator('[data-col="tags"]');
      await expect(tags.getByTestId('chip-order-test-badge')).toHaveText('בדיקה');
      await expect(tags.getByTestId('chip-order-phone-unverified')).toHaveText('טלפון לא אומת');
      await expect(tags.getByTestId('chip-order-notify-failed')).toHaveText('הודעה נכשלה');
      // An ordinary order has none: its name starts exactly where the other's does.
      await expect(rowPlain.locator('[data-col="tags"]')).toHaveText('');
      await expect(rowPlain.locator('[data-col="orderer"]')).toHaveText(/^אביגיל עמודותבעלים · 0539300021$/);
      const nameEdge = (row: Locator) => row.locator('[data-col="orderer"] button').evaluate((el) => el.getBoundingClientRect().right);
      expect(Math.abs((await nameEdge(rowPlain)) - (await nameEdge(rowFlagged))), 'names start on one line, tag or no tag').toBeLessThanOrEqual(0.5);

      // Every value under its header — the cell in the header's track, with
      // the header's alignment, and its content where the label is. Measured
      // with the menu panel open and closed, and at a laptop's width.
      expect(await offItsHeader(table), 'at 1440px').toEqual([]);
      await page.setViewportSize({ width: 1280, height: 800 });
      expect(await offItsHeader(table), 'at 1280px').toEqual([]);
      await page.setViewportSize({ width: 1920, height: 1000 });
      expect(await offItsHeader(table), 'at 1920px').toEqual([]);
      // Narrower than the table (1024px with the menu panel open): the table
      // scrolls inside the card, and the columns still answer their headers —
      // the pinned action column too.
      await page.setViewportSize({ width: 1024, height: 800 });
      expect(await offItsHeader(table), 'at 1024px').toEqual([]);
      await noSideScroll(page);
      // At its minimum width the table still holds its columns: the floors of
      // the columns, with the row's gaps and padding, fit inside every row —
      // no last column sticking out past the row's own line. (The root font
      // is 17px: a "12px" gap is 12.75px.)
      expect(await table.evaluate((el) => el.scrollWidth > el.parentElement!.clientWidth), 'the table scrolls inside its card at 1024').toBe(true);
      expect(
        await table.evaluate((root) => [...root.children].map((row) => row.scrollWidth - row.clientWidth)),
        'no row is wider than the table',
      ).toEqual(await table.evaluate((root) => [...root.children].map(() => 0)));
      // The three number columns are centred under their headers, the text
      // columns start at the header's start edge.
      const aligns = await heads.evaluateAll((els) => els.map((el) => getComputedStyle(el).textAlign));
      expect(aligns).toEqual(['start', 'start', 'center', 'center', 'center', 'start', 'start']);

      // A phone card holds the same facts, each on its own line: who (the name,
      // the role and the phone), the tags, what was ordered, the stage, the step.
      await page.setViewportSize({ width: 390, height: 844 });
      const card = page.getByTestId('chip-order-card').filter({ hasText: APT_T2 });
      await expect(card).toBeVisible();
      await expect(card).toContainText('בועז תגיות');
      await expect(card).toContainText('שוכר · 0539300022');
      await expect(card).toContainText(`דירה ${APT_T2} · 1 צ׳יפים`);
      await expect(card.getByTestId('chip-order-card-tags').locator('[data-testid^="chip-order-"]')).toHaveCount(3);
      await expect(card.getByTestId('chip-order-stage')).toHaveText('ממתין לשיוך');
      await expect(card.getByTestId('chip-order-row-waiting')).toContainText('בהמתנה');
      await expect(card.getByTestId('chip-order-row-reason')).toHaveText('חסר צ׳יפ אחד');
      // The lines follow each other, none beside another, nothing cut.
      const tops = await card.evaluate((el) => [...el.children].map((c) => Math.round(c.getBoundingClientRect().top)));
      expect([...tops].sort((a, b) => a - b), 'one fact under the other').toEqual(tops);
      expect(new Set(tops).size).toBe(tops.length);
      expect(await card.evaluate((el) => el.scrollWidth - el.clientWidth), 'nothing sticks out of the card').toBeLessThanOrEqual(0);
      await noSideScroll(page);
      const plainCard = page.getByTestId('chip-order-card').filter({ hasText: APT_T1 });
      await expect(plainCard.getByTestId('chip-order-card-tags')).toHaveCount(0);
      await expect(plainCard).toContainText('בעלים · 0539300021');
      await noSideScroll(page);
      await page.setViewportSize({ width: 320, height: 700 });
      await noSideScroll(page);

      // The tags travel with the row: in the Excel file they are words.
      await page.setViewportSize({ width: 1280, height: 720 });
      await page.getByTestId('chip-orders-search').fill(APT_T2);
      await expect(table.getByTestId('chip-order-row')).toHaveCount(1);
      const excel = await download(page, 'chip-orders-export');
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(excel.bytes as unknown as ArrayBuffer);
      expect(wb.worksheets[0]!.getRow(1).getCell(5).value).toBe('תגיות');
      expect(wb.worksheets[0]!.getRow(2).getCell(5).value).toBe('בדיקה, טלפון לא אומת, הודעה נכשלה');
      expect((await printed(page, 'chip-orders-print')).text).toContain('בדיקה, טלפון לא אומת, הודעה נכשלה');
    } finally {
      // A test-mode order must not stay behind for the tests that count them.
      await pool.query(`delete from public.chip_orders where id = $1`, [flagged.id]);
      await pool.query(`delete from public.chip_orders where id = $1`, [plain.id]);
      await page.setViewportSize({ width: 1280, height: 720 });
    }
  });

  test('the chips tab: "הדפסה", "ייצוא לאקסל" and "הורדה ל-PDF" take the rows the table shows — the same three buttons, at the same place, as the Orders tab', async ({ page }) => {
    // Three chips of one apartment, straight into the DB: a card of the owner,
    // a disabled app chip of the owner, and a guest's card.
    const chips: [string, string, string, string, string, string | null, string][] = [
      [`EX${tag}1`, 'physical', 'active', 'owner', 'בעלים ייצוא', null, '2026-11-03T10:00:00Z'],
      [`EX${tag}2`, 'app', 'inactive', 'owner', 'בעלים ייצוא', 'lost', '2026-11-02T10:00:00Z'],
      [`EX${tag}3`, 'physical', 'active', 'other', 'אורח ייצוא', null, '2026-11-01T10:00:00Z'],
    ];
    for (const [number, type, status, role, holder, reason, issued] of chips) {
      await pool.query(
        `insert into public.chips (chip_number, chip_type, contact_id, apartment_number, status, resident_role, holder_name, issued_at, issued_by_name, deactivation_reason)
         values ($1, $2, $3, $4, $5, $6, $7, $8, 'בודק ייצוא', $9)`,
        [number, type, made.contacts[APT_CH], APT_CH, status, role, holder, issued, reason],
      );
    }
    await page.goto('/chips');
    const rows = page.getByTestId('chips-table').getByTestId('chips-row');
    const search = page.getByPlaceholder('חפש לפי מספר צ׳יפ, מספר דירה או שם דייר');

    // The same three buttons in both tabs: the labels and their order, one
    // look, and one place — closing the toolbar, right after the search box.
    const onChips = await exportButtons(page, 'chips');
    expect(onChips.labels).toEqual(['הדפסה', 'ייצוא לאקסל', 'הורדה ל-PDF']);
    expect(onChips.looks, 'the three buttons look alike').toHaveLength(1);
    expect(onChips).toMatchObject({ lastInToolbar: true, afterSearch: true });
    await page.getByRole('tab', { name: /הזמנות/ }).click();
    await expect(page.getByTestId('chip-orders-search')).toBeVisible();
    const onOrders = await exportButtons(page, 'chip-orders');
    expect(onOrders.labels).toEqual(onChips.labels);
    expect(onOrders).toMatchObject({ lastInToolbar: true, afterSearch: true });
    await page.getByRole('tab', { name: /צ׳יפים/ }).click();

    // The search narrows the table to the apartment (all statuses) — and the
    // three exports take exactly those rows, in the table's order.
    await search.fill(APT_CH);
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toContainText(`EX${tag}1`);
    const headers = ['מחזיק', 'דירה', 'תפקיד', 'מספר צ׳יפ', 'סוג', 'סטטוס', 'הונפק', 'מנפיק'];
    const sheet = [
      ['בעלים ייצוא', APT_CH, 'בעל דירה', `EX${tag}1`, 'כרטיס', 'פעיל', '03/11/2026', 'בודק ייצוא'],
      ['בעלים ייצוא', APT_CH, 'בעל דירה', `EX${tag}2`, 'אפליקציה', 'לא פעיל', '02/11/2026', 'בודק ייצוא'],
      ['אורח ייצוא', APT_CH, 'אורח', `EX${tag}3`, 'כרטיס', 'פעיל', '01/11/2026', 'בודק ייצוא'],
    ];

    const excel = await download(page, 'chips-export');
    expect(excel.name).toMatch(/^chips_\d{4}-\d{2}-\d{2}\.xlsx$/);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(excel.bytes as unknown as ArrayBuffer);
    const ws = wb.worksheets[0]!;
    const cells = (n: number) => headers.map((_, i) => ws.getRow(n).getCell(i + 1).value);
    expect(ws.name).toBe('צ׳יפים');
    expect(ws.views[0]?.rightToLeft).toBe(true);
    expect([1, 2, 3, 4].map(cells)).toEqual([headers, ...sheet]);
    expect(ws.rowCount, 'the header and the three rows of the table').toBe(4);

    const paper = await printed(page, 'chips-print');
    expect(paper).toMatchObject({ dir: 'rtl', shown: 'block', controls: 0, restHidden: true, headers, rows: 3 });
    expect(paper.text).toContain('צ׳יפים');
    expect(paper.text).toContain('סה״כ 3 שורות');
    expect(paper.text).toContain(`חיפוש: „${APT_CH}” (בכל הסטטוסים)`);
    for (const [number] of chips) expect(paper.text).toContain(number);

    const pdf = await download(page, 'chips-pdf');
    expect(pdf.name).toMatch(/^chips_\d{4}-\d{2}-\d{2}\.pdf$/);
    expect(pdf.bytes.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.bytes.length).toBeGreaterThan(10_000);
    expect(pdf.bytes.toString('latin1')).toContain('/BaseFont /Heebo');
    const ink = paintedText(pdf.bytes);
    expect(ink.every((p) => p.text !== null), 'nothing is drawn with a font that is not in the file').toBe(true);
    const lines = ink.map((p) => p.text);
    expect(lines).toContain(rev('צ׳יפים')); // the title: the tab
    expect(lines.some((l) => /^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2} /.test(l!) && l!.endsWith(rev('תאריך הפקה:'))), 'the date').toBe(true);
    // A chip number, an apartment and a date in their reading order; Hebrew back to front.
    for (const asIs of [`EX${tag}1`, `EX${tag}2`, `EX${tag}3`, APT_CH, '03/11/2026']) expect(lines, asIs).toContain(asIs);
    for (const hebrew of ['בעלים ייצוא', 'אורח ייצוא', 'בעל דירה', 'אורח', 'לא פעיל', 'אפליקציה', 'מספר צ׳יפ']) expect(lines, hebrew).toContain(rev(hebrew));
    expect(lines).toContain(`1 ${rev('מתוך')} 1 ${rev('עמוד')}`);
    // The table's order, top to bottom (a PDF's y grows upward).
    const y = (number: string) => ink.find((p) => p.text === number)!.y;
    expect(y(`EX${tag}1`)).toBeGreaterThan(y(`EX${tag}2`));
    expect(y(`EX${tag}2`)).toBeGreaterThan(y(`EX${tag}3`));

    // The status tabs narrow the files too: "לא פעילים" holds the disabled
    // chip and not the two active ones — as many lines as the table has rows.
    await search.fill('');
    await page.getByRole('button', { name: 'לא פעילים', exact: true }).click();
    await expect(rows.filter({ hasText: `EX${tag}2` })).toHaveCount(1);
    await expect(rows.filter({ hasText: `EX${tag}1` })).toHaveCount(0);
    const onScreen = await rows.count();
    const inactive = new ExcelJS.Workbook();
    await inactive.xlsx.load((await download(page, 'chips-export')).bytes as unknown as ArrayBuffer);
    const numbers = (inactive.worksheets[0]!.getColumn(4).values as unknown[]).slice(2);
    expect(numbers).toHaveLength(onScreen);
    expect(numbers).toContain(`EX${tag}2`);
    expect(numbers).not.toContain(`EX${tag}1`);
    expect((await printed(page, 'chips-print')).text).toContain('סינון: לא פעילים');

    // Nothing to export = nothing to press.
    await search.fill(`אין-כזה-${tag}`);
    await expect(rows).toHaveCount(0);
    for (const id of ['chips-print', 'chips-export', 'chips-pdf']) await expect(page.getByTestId(id)).toBeDisabled();

    // A phone: the three buttons stay whole inside the card, 44px each.
    await search.fill(APT_CH);
    await page.setViewportSize({ width: 390, height: 844 });
    for (const id of ['chips-print', 'chips-export', 'chips-pdf']) {
      const box = (await page.getByTestId(id).boundingBox())!;
      expect(box.height, `${id}: a 44px touch target`).toBeGreaterThanOrEqual(44);
      expect(await textLines(page.getByTestId(id)), `${id}: one line`).toBe(1);
    }
    await noSideScroll(page);
    await page.setViewportSize({ width: 320, height: 700 });
    await noSideScroll(page);
    await page.setViewportSize({ width: 1280, height: 720 });
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
    // The save closes the window (25/11/2026) and the row behind it followed;
    // opened again, nothing waits any more.
    await issue.getByTestId('chip-issue-save').click();
    await expect(issue).toHaveCount(0);
    await expect(row.getByTestId('chip-order-stage')).toHaveText('שויך');
    await row.click();
    await expect(owner.getByTestId('chip-alloc-counter')).toHaveText('שויכו 7 מתוך 7');
    await expect(issue.getByText('ממתין לשמירה')).toHaveCount(0);
    await expect(issue.getByTestId('chip-issue-save')).toBeDisabled();
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
