import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { Pool } from 'pg';

// "מסירת צ׳יפים" — the guard's pickup screen (/chip-pickup, 25/11/2026), in the
// browser:
//   · the guard finds it under "אבטחה", next to "סריקת כניסה" — and still has
//     no way into /chips;
//   · it lists ONLY the orders that are ready for pickup: the order number, the
//     apartment(s), the people with the quantity and the chip numbers of each,
//     and the total;
//   · nothing else of an order is on the page OR in what the server sent it —
//     no price, amount, email, phone, address, lease or note;
//   · the search, by apartment number and by name;
//   · "נמסר": a short confirmation where the guard picks who showed the ID —
//     required — and the order becomes collected, with who handed it over and
//     who collected on record; it leaves the list;
//   · a phone and a tablet: nothing scrolls sideways, every control is at
//     least 44px tall, the page keeps its side padding;
//   · an admin has the screen too; a manager — whatever it holds — is sent
//     home, and the API refuses.
// Orders are seeded straight into the DB (ready = what "מוכן לאיסוף" leaves);
// fixtures are numeric apartments far from the seed, removed by exact ids.
// Users get a session row in the DB (the cookie holds the raw token, the table
// its SHA-256) — no form login, so the e2e job's login budget is untouched.

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
pool.on('error', () => undefined);

const tag = String(Date.now()).slice(-6);
const APT = (n: number) => `991${tag}${n}`;
const num = (n: number) => `PK${tag}${n}`;
const SECRET = {
  email: `pickup-secret-${tag}@example.test`,
  address: `PICKUP-SECRET-ADDRESS-${tag}`,
  note: `PICKUP-SECRET-NOTE-${tag}`,
  lease: `PICKUP-SECRET-LEASE-${tag}.pdf`,
  phoneLocal: `05391${tag.slice(-5)}`,
  price: 73.19,
};
const PHONE = `+9725391${tag.slice(-5)}`;

const made = { contacts: {} as Record<string, string>, orders: [] as string[], users: [] as string[], sessions: [] as string[] };
const people: Record<'guard' | 'admin' | 'manager', { id: string; name: string }> = {} as never;
const contexts: BrowserContext[] = [];

async function pageAs(browser: Browser, userId: string, options: Parameters<Browser['newContext']>[0] = {}): Promise<Page> {
  const raw = randomBytes(32).toString('base64url');
  const sid = createHash('sha256').update(raw).digest('hex');
  await pool.query(
    `insert into public.sessions (id, user_id, expires_at, remember) values ($1, $2, now() + interval '3 hours', false)`,
    [sid, userId],
  );
  made.sessions.push(sid); // removed by this exact id at the end
  const ctx = await browser.newContext({
    ...options,
    storageState: { cookies: [{ name: 'almog_sid', value: raw, domain: 'localhost', path: '/', httpOnly: true, secure: true, sameSite: 'Lax', expires: -1 }], origins: [] },
  });
  contexts.push(ctx);
  return ctx.newPage();
}

interface Row { apt: string; name: string; qty: number; chips: string[]; app?: boolean }

/** A web order in the given status: one line per apartment, one holder line
 *  per row, its chips issued and linked. */
async function seedOrder(status: 'paid' | 'ready' | 'collected', rows: Row[]): Promise<{ id: string; orderNumber: number; holders: string[] }> {
  const n = made.orders.length;
  const qty = rows.reduce((s, r) => s + r.qty, 0);
  const o = await pool.query<{ id: string; order_number: number }>(
    `insert into public.chip_orders
       (full_name, phone_e164, email, address, role, status, total, tracking_token, paid_at, due_at, ready_at, collected_at,
        grow_process_id, grow_transaction_id, address_street, address_city, address_zip, internal_note)
     values ($1, $2, $3, $4, 'owner', $5, $6, $7, now(), now() + interval '3 days',
             case when $5 in ('ready', 'collected') then now() end, case when $5 = 'collected' then now() end,
             $8, $9, 'רחוב נסתר 1', 'חיפה', '3300000', $10)
     returning id, order_number`,
    [rows[0]!.name, PHONE, SECRET.email, SECRET.address, status, qty * SECRET.price, randomBytes(32).toString('base64url'),
      `pkp-${tag}-${n}`, `pkt-${tag}-${n}`, SECRET.note],
  );
  const order = o.rows[0]!;
  made.orders.push(order.id);
  const items: Record<string, string> = {};
  for (const apt of [...new Set(rows.map((r) => r.apt))]) {
    const q = rows.filter((r) => r.apt === apt).reduce((s, r) => s + r.qty, 0);
    items[apt] = (await pool.query<{ id: string }>(
      `insert into public.chip_order_items
         (order_id, contact_id, apartment_number, chips_count, unit_price, threshold, price_above, line_total, match_status)
       values ($1, $2, $3, $4, $5, $4, $5, $6, 'matched') returning id`,
      [order.id, made.contacts[apt], apt, q, SECRET.price, q * SECRET.price],
    )).rows[0]!.id;
  }
  const holders: string[] = [];
  for (const [position, r] of rows.entries()) {
    const holderId = (await pool.query<{ id: string }>(
      `insert into public.chip_order_holders (order_id, item_id, position, source, role, full_name, phone, email, chips_count, lease_file_key, lease_file_name)
       values ($1, $2, $3, 'order', 'owner', $4, $5, $6, $7, $8, $9) returning id`,
      [order.id, items[r.apt], position, r.name, PHONE, SECRET.email, r.qty,
        position === 0 ? `${order.id.slice(0, 8)}-0000-4000-8000-00000000000${n}.pdf` : null, position === 0 ? SECRET.lease : null],
    )).rows[0]!.id;
    holders.push(holderId);
    for (const chip of r.chips) {
      await pool.query(
        `insert into public.chips (chip_number, chip_type, contact_id, apartment_number, resident_role, holder_name, holder_phone, order_item_id, order_holder_id)
         values ($1, $2, $3, $4, 'other', $5, $6, $7, $8)`,
        [chip, r.app ? 'app' : 'physical', made.contacts[r.apt], r.apt, r.name, SECRET.phoneLocal, items[r.apt], holderId],
      );
    }
  }
  return { id: order.id, orderNumber: order.order_number, holders };
}

/** The card of ONE order — by its heading, exactly: an order number is short,
 *  and could otherwise be found inside another card's apartment or chip number. */
const card = (page: Page, orderNumber: number) => page.getByTestId('chip-pickup-order')
  .filter({ has: page.getByRole('heading', { name: `הזמנה ${orderNumber}`, exact: true }) });
const sideScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

let ready: Awaited<ReturnType<typeof seedOrder>>; // two apartments, three people
let readyB: Awaited<ReturnType<typeof seedOrder>>; // one apartment, one person
let preparing: Awaited<ReturnType<typeof seedOrder>>;
let done: Awaited<ReturnType<typeof seedOrder>>;

test.beforeAll(async () => {
  for (const [key, role] of [['guard', 'guard'], ['admin', 'admin'], ['manager', 'manager']] as const) {
    const username = `pk-${key}-${tag}`;
    const u = await pool.query<{ id: string }>(
      `insert into public.users (username, email, password_hash, full_name, role, is_active) values ($1, $2, 'x', $3, $4, true) returning id`,
      [username, role === 'guard' ? null : `${username}@billing.local`, `מסירה ${key}`, role],
    );
    made.users.push(u.rows[0]!.id);
    people[key] = { id: u.rows[0]!.id, name: `מסירה ${key}` };
  }
  // The manager holds every chips permission the matrix can grant.
  for (const mod of ['chips', 'chips_orders_manage', 'dashboard']) {
    await pool.query(`insert into public.user_permissions (user_id, module, can_view, can_edit) values ($1, $2, true, true)`, [people.manager.id, mod]);
  }
  for (let i = 1; i <= 5; i++) {
    const r = await pool.query<{ id: string }>(
      `insert into public.contacts (apartment_number, owner_name, owner_phone) values ($1, 'בעלים רשום', $2) returning id`, [APT(i), SECRET.phoneLocal]);
    made.contacts[APT(i)] = r.rows[0]!.id;
  }
  ready = await seedOrder('ready', [
    { apt: APT(1), name: 'דנה מהלובי', qty: 2, chips: [num(1), num(2)] },
    { apt: APT(1), name: 'שרה מהלובי', qty: 1, chips: [num(3)], app: true },
    { apt: APT(2), name: 'יוסף בן הדוד עם שם ארוך במיוחד שנשבר לשתי שורות', qty: 1, chips: [num(4)] },
  ]);
  readyB = await seedOrder('ready', [{ apt: APT(3), name: 'רון השכן', qty: 1, chips: [num(5)] }]);
  preparing = await seedOrder('paid', [{ apt: APT(4), name: 'עדיין לא מוכן', qty: 1, chips: [num(6)] }]);
  done = await seedOrder('collected', [{ apt: APT(5), name: 'כבר אסף', qty: 1, chips: [num(7)] }]);
});

test.afterAll(async () => {
  const contactIds = Object.values(made.contacts);
  const chips = await pool.query<{ id: string }>(`select id from public.chips where contact_id = any($1::uuid[])`, [contactIds]);
  for (const { id } of chips.rows) {
    await pool.query(`delete from public.chip_events where chip_id = $1`, [id]);
    await pool.query(`delete from public.chips where id = $1`, [id]);
  }
  for (const id of made.orders) {
    await pool.query(`delete from public.audit_log where entity_type = 'chip_order' and entity_id = $1`, [id]);
    await pool.query(`delete from public.chip_orders where id = $1`, [id]);
  }
  for (const id of contactIds) await pool.query(`delete from public.contacts where id = $1`, [id]);
  for (const c of contexts) await c.close().catch(() => undefined);
  for (const sid of made.sessions) await pool.query(`delete from public.sessions where id = $1`, [sid]);
  for (const id of made.users) {
    await pool.query(`delete from public.auth_rate_limits where bucket = $1`, [`chip-handover:user:${id}`]);
    await pool.query(`delete from public.user_permissions where user_id = $1`, [id]);
    await pool.query(`delete from public.users where id = $1`, [id]);
  }
  await pool.end();
});

test.describe.serial('the guard\'s pickup screen', () => {
  test('the guard finds "מסירת צ׳יפים" under "אבטחה", next to "סריקת כניסה" — and has no way into /chips', async ({ browser }) => {
    const page = await pageAs(browser, people.guard.id);
    await page.goto('/');
    await expect(page).toHaveURL(/\/visitors$/);
    const rail = page.locator('aside nav[aria-label="קטגוריות ניווט"]');
    expect((await rail.locator('[data-nav-category]').allInnerTexts()).map((t) => t.trim())).toEqual(['אבטחה']);
    // Two items now → a panel, not a direct link.
    await expect(rail.locator('[data-nav-category]')).toHaveAttribute('data-nav-kind', 'panel');
    const panel = page.locator('aside [data-nav-panel]');
    if ((await panel.getAttribute('data-state')) !== 'open') await rail.locator('[data-nav-category]').click();
    expect(await panel.locator('a[data-nav-item]').allInnerTexts()).toEqual(['סריקת כניסה', 'מסירת צ׳יפים']);
    await panel.locator('a[data-nav-item="/chip-pickup"]').click();
    await expect(page).toHaveURL(/\/chip-pickup$/);
    await expect(page.getByRole('heading', { name: 'מסירת צ׳יפים' })).toBeVisible();
    await expect(panel.locator('a[aria-current="page"]')).toHaveText('מסירת צ׳יפים');

    // /chips itself stays closed to the guard — the page and its API.
    await page.goto('/chips');
    await expect(page).not.toHaveURL(/\/chips/);
    for (const url of ['/api/chips', '/api/chip-orders', '/api/chips/kpis', '/api/chips/reception', '/api/settings/chip-orders']) {
      expect((await page.request.get(url)).status(), url).toBe(403);
    }
    // And the money of an order: no "ביטול וזיכוי" (27/11/2026 — the one way a refund is made), no document's retry — admin only.
    expect((await page.request.post(`/api/chip-orders/${ready.id}/cancel`, { data: { reason: 'ניסיון של שומר' } })).status()).toBe(403);
    expect((await page.request.get(`/api/chip-orders/${ready.id}/cancel`)).status()).toBe(403);
    expect((await page.request.post(`/api/chip-orders/${ready.id}/documents/retry`)).status()).toBe(403);
    // The pickup screen never names a payment, a refund or an invoice.
    await page.goto('/chip-pickup');
    await expect(card(page, ready.orderNumber)).toHaveCount(1);
    await expect(page.locator('main')).not.toContainText(/אשראי|זיכוי|חשבונית|מזומן|העברה/);
  });

  test('ONLY the orders that are ready are listed: the number, the apartment(s), the people with the quantity and the chip numbers of each, the total', async ({ browser }) => {
    const page = await pageAs(browser, people.guard.id);
    await page.goto('/chip-pickup');
    const mine = card(page, ready.orderNumber);
    await expect(mine).toHaveCount(1);
    await expect(card(page, readyB.orderNumber)).toHaveCount(1);
    // Still being prepared, and collected already: not here.
    await expect(page.getByText('עדיין לא מוכן')).toHaveCount(0);
    await expect(page.getByText('כבר אסף')).toHaveCount(0);
    await expect(page.getByText(num(6))).toHaveCount(0);
    await expect(page.getByText(num(7))).toHaveCount(0);

    await expect(mine.getByRole('heading')).toHaveText(`הזמנה ${ready.orderNumber}`);
    await expect(mine.getByTestId('chip-pickup-apartments')).toHaveText(`דירות ${APT(1)}, ${APT(2)}`);
    await expect(mine.getByTestId('chip-pickup-total')).toHaveText('סה״כ 4 צ׳יפים');
    const persons = mine.getByTestId('chip-pickup-person');
    await expect(persons).toHaveCount(3);
    await expect(persons.nth(0)).toContainText('דנה מהלובי');
    await expect(persons.nth(0)).toContainText('2 צ׳יפים');
    await expect(persons.nth(0).getByTestId('chip-pickup-chip')).toHaveText([num(1), num(2)]);
    await expect(persons.nth(1)).toContainText('שרה מהלובי');
    await expect(persons.nth(1)).toContainText('צ׳יפ אחד');
    // An app chip says so — there is no card to hand over, and its "number"
    // (an identifier of the person's app account) is not on the screen at all.
    await expect(persons.nth(1).getByTestId('chip-pickup-chip')).toHaveText('אפליקציה');
    await expect(page.getByText(num(3))).toHaveCount(0);
    await expect(persons.nth(2)).toContainText(`דירה ${APT(2)}`);
    await expect(persons.nth(2).getByTestId('chip-pickup-chip')).toHaveText([num(4)]);
    // One apartment: "דירה", and no apartment next to the person.
    await expect(card(page, readyB.orderNumber).getByTestId('chip-pickup-apartments')).toHaveText(`דירה ${APT(3)}`);
    await expect(card(page, readyB.orderNumber).getByTestId('chip-pickup-person')).not.toContainText('דירה');
    // One action per order.
    await expect(mine.getByRole('button')).toHaveText(['נמסר']);
  });

  test('nothing else of an order reaches the screen — not on the page, and not in what the server sent it', async ({ browser }) => {
    const page = await pageAs(browser, people.guard.id);
    const sent: string[] = [];
    page.on('response', async (res) => {
      const type = res.headers()['content-type'] ?? '';
      if (res.url().includes('/_next/static/') || !/json|html|text|x-component/.test(type)) return;
      sent.push(await res.text().catch(() => ''));
    });
    await page.goto('/chip-pickup');
    await expect(card(page, ready.orderNumber)).toHaveCount(1);
    await page.waitForLoadState('networkidle');
    const onPage = await page.locator('body').innerText();
    const secrets = [SECRET.email, SECRET.address, SECRET.note, SECRET.lease, SECRET.phoneLocal, PHONE, String(SECRET.price), 'רחוב נסתר', `pkt-${tag}`, `pkp-${tag}`];
    for (const secret of secrets) {
      expect(onPage, `on the page: ${secret}`).not.toContain(secret);
      for (const body of sent) expect(body, `sent to the page: ${secret}`).not.toContain(secret);
    }
    // No price or sum anywhere on the screen.
    expect(onPage).not.toMatch(/₪/);
    // The API by itself: exactly the narrow shape.
    const api = await page.request.get('/api/chip-pickup');
    expect(api.status()).toBe(200);
    expect(api.headers()['cache-control']).toContain('no-store');
    const body = (await api.json()) as { orders: Record<string, unknown>[] };
    const order = body.orders.find((o) => o.id === ready.id)!;
    // + the two notes the guard reads (27/11/2026): the orderer's and the one
    // written for the guard — never the staff's internal note (SECRET.note).
    expect(Object.keys(order).sort()).toEqual(['apartments', 'guard_note', 'id', 'is_test', 'order_number', 'orderer_note', 'people', 'total']);
    expect(order).toMatchObject({ orderer_note: null, guard_note: null });
    expect(Object.keys((order.people as Record<string, unknown>[])[0]!).sort()).toEqual(['apartment', 'chips', 'key', 'name']);
    // The number of the app chip is not sent — only that there is one.
    expect(JSON.stringify(body)).not.toContain(num(3));
    expect((order.people as { chips: unknown[] }[])[1]!.chips).toEqual([{ number: null, type: 'app' }]);
    expect(body.orders.map((o) => o.id)).not.toContain(preparing.id);
    expect(body.orders.map((o) => o.id)).not.toContain(done.id);
  });

  test('the search: by apartment number and by name', async ({ browser }) => {
    const page = await pageAs(browser, people.guard.id);
    await page.goto('/chip-pickup');
    await expect(card(page, ready.orderNumber)).toHaveCount(1);
    const search = page.getByTestId('chip-pickup-search');
    const shown = async () => (await page.getByTestId('chip-pickup-order').getByRole('heading').allInnerTexts()).filter((t) => t.includes(String(ready.orderNumber)) || t.includes(String(readyB.orderNumber)));

    await search.fill(APT(3));
    await expect(card(page, readyB.orderNumber)).toHaveCount(1);
    await expect(card(page, ready.orderNumber)).toHaveCount(0);
    // The second apartment of an order finds the whole order.
    await search.fill(APT(2));
    await expect(card(page, ready.orderNumber)).toHaveCount(1);
    await expect(card(page, readyB.orderNumber)).toHaveCount(0);
    // A name — any person of the order, not only whoever ordered.
    await search.fill('שרה');
    await expect(card(page, ready.orderNumber)).toHaveCount(1);
    await expect(card(page, readyB.orderNumber)).toHaveCount(0);
    await search.fill('רון השכן');
    expect(await shown()).toEqual([`הזמנה ${readyB.orderNumber}`]);
    // An order that is not ready is not found — and the screen says why.
    await search.fill('עדיין לא מוכן');
    await expect(page.getByTestId('chip-pickup-no-match')).toContainText('לא נמצאה הזמנה מוכנה');
    await expect(page.getByTestId('chip-pickup-order')).toHaveCount(0);
    await page.getByRole('button', { name: 'נקה חיפוש' }).click();
    await expect(card(page, ready.orderNumber)).toHaveCount(1);
    await expect(card(page, readyB.orderNumber)).toHaveCount(1);
  });

  test('a phone and a tablet: nothing scrolls sideways, every control is at least 44px tall, and the page keeps its side padding', async ({ browser }) => {
    for (const viewport of [{ width: 320, height: 640 }, { width: 390, height: 844 }, { width: 768, height: 1024 }, { width: 1024, height: 768 }]) {
      const page = await pageAs(browser, people.guard.id, { viewport, hasTouch: true, isMobile: viewport.width < 768 });
      await page.goto('/chip-pickup');
      const mine = card(page, ready.orderNumber);
      await expect(mine).toHaveCount(1);
      expect(await sideScroll(page), `side scroll at ${viewport.width}px`).toBeLessThanOrEqual(0);
      // The card fits the screen, with room on both sides of it.
      const box = (await mine.boundingBox())!;
      expect(box.x, `start padding at ${viewport.width}px`).toBeGreaterThan(0);
      expect(box.x + box.width, `end padding at ${viewport.width}px`).toBeLessThan(viewport.width);
      // The long name wraps inside the card instead of pushing it wide.
      const long = (await mine.getByTestId('chip-pickup-person').nth(2).boundingBox())!;
      expect(long.x).toBeGreaterThanOrEqual(box.x);
      expect(long.x + long.width).toBeLessThanOrEqual(box.x + box.width + 0.5);
      for (const control of [mine.getByTestId('chip-pickup-handover'), page.getByTestId('chip-pickup-search'), page.getByTestId('chip-pickup-refresh')]) {
        expect((await control.boundingBox())!.height, `a control at ${viewport.width}px`).toBeGreaterThanOrEqual(44);
      }
      // The confirmation too: it fits, and every choice is a full-height row.
      await mine.getByTestId('chip-pickup-handover').click();
      const dialog = page.getByTestId('chip-pickup-confirm');
      await expect(dialog).toBeVisible();
      const d = (await dialog.boundingBox())!;
      expect(d.x).toBeGreaterThanOrEqual(0);
      expect(d.x + d.width).toBeLessThanOrEqual(viewport.width);
      for (const option of await dialog.getByTestId('chip-pickup-collector').all()) {
        expect((await option.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      }
      for (const button of await dialog.getByRole('button').all()) {
        expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      }
      expect(await sideScroll(page), `side scroll under the dialog at ${viewport.width}px`).toBeLessThanOrEqual(0);
      await dialog.getByRole('button', { name: 'ביטול' }).click();
      await expect(dialog).toHaveCount(0);
      await page.context().close();
    }
  });

  test('"נמסר": the guard picks who showed the ID — required — and the order is collected, with who handed it over and who collected on record', async ({ browser }) => {
    const page = await pageAs(browser, people.guard.id);
    await page.goto('/chip-pickup');
    const mine = card(page, ready.orderNumber);
    await mine.getByTestId('chip-pickup-handover').click();
    const dialog = page.getByTestId('chip-pickup-confirm');
    await expect(dialog).toContainText(`מסירת הזמנה ${ready.orderNumber}`);
    await expect(dialog).toContainText('יימסרו 4 צ׳יפים');
    // The people of the order, each once, with the apartment (two apartments).
    const options = dialog.getByTestId('chip-pickup-collector');
    await expect(options).toHaveCount(3);
    await expect(options.nth(0)).toContainText('דנה מהלובי');
    await expect(options.nth(2)).toContainText(`דירה ${APT(2)}`);
    // Nobody is chosen for the guard: the confirmation waits for a pick.
    const confirm = dialog.getByTestId('chip-pickup-confirm-button');
    await expect(confirm).toBeDisabled();
    for (const o of await options.all()) await expect(o).toHaveAttribute('aria-checked', 'false');
    // Cancelling changes nothing.
    await dialog.getByRole('button', { name: 'ביטול' }).click();
    expect((await pool.query(`select status from public.chip_orders where id = $1`, [ready.id])).rows[0].status).toBe('ready');

    await mine.getByTestId('chip-pickup-handover').click();
    await options.nth(1).click();
    await expect(options.nth(1)).toHaveAttribute('aria-checked', 'true');
    await expect(confirm).toBeEnabled();
    await confirm.click();
    await expect(page.locator('[data-sonner-toast]').filter({ hasText: `הזמנה ${ready.orderNumber} נמסרה` })).toBeVisible();
    // It left the list; the other order is still there.
    await expect(card(page, ready.orderNumber)).toHaveCount(0);
    await expect(card(page, readyB.orderNumber)).toHaveCount(1);

    const row = (await pool.query(
      `select status, collected_by_name, collected_holder_id, handed_over_by, handed_over_by_name, handed_over_via, collected_at from public.chip_orders where id = $1`, [ready.id])).rows[0];
    expect(row).toMatchObject({
      status: 'collected', collected_by_name: 'שרה מהלובי', collected_holder_id: ready.holders[1],
      handed_over_by: people.guard.id, handed_over_by_name: people.guard.name, handed_over_via: 'pickup',
    });
    expect(row.collected_at).not.toBeNull();
    const audit = (await pool.query(
      `select action, actor_user_id, metadata from public.audit_log where entity_type = 'chip_order' and entity_id = $1`, [ready.id])).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: 'collected', actor_user_id: people.guard.id,
      metadata: { via: 'pickup', collector: 'holder', collector_holder_id: ready.holders[1], collector_name: 'שרה מהלובי' },
    });
    // Nobody is notified — like the management's "נאסף".
    expect((await pool.query(`select count(*)::int as n from public.chip_order_notifications where order_id = $1`, [ready.id])).rows[0].n).toBe(0);
    // The guard cannot hand over what is not ready, also by calling the API directly.
    expect((await page.request.post(`/api/chip-pickup/${preparing.id}/handover`, { data: { person: preparing.holders[0] } })).status()).toBe(409);
    expect((await page.request.post(`/api/chip-pickup/${ready.id}/handover`, { data: { person: ready.holders[0] } })).status()).toBe(409);
    expect((await page.request.post(`/api/chip-pickup/${readyB.id}/handover`, { data: {} })).status()).toBe(400);
    expect((await page.request.post(`/api/chip-pickup/${readyB.id}/handover`, { data: { person: ready.holders[0] } })).status()).toBe(400);
    expect((await pool.query(`select status from public.chip_orders where id = any($1::uuid[]) order by status`, [[preparing.id, readyB.id]])).rows.map((r) => r.status)).toEqual(['paid', 'ready']);
  });

  test('the management sees who collected: the closed order\'s window says who collected, who handed over, where and when', async ({ browser }) => {
    const page = await pageAs(browser, people.admin.id);
    // A collected web order is not in the Orders tab; its window still opens by the line (the API the window loads).
    const item = (await pool.query<{ id: string }>(`select id from public.chip_order_items where order_id = $1 limit 1`, [ready.id])).rows[0]!.id;
    const res = await page.request.get(`/api/chip-orders/items/${item}`);
    expect(res.status()).toBe(200);
    const win = (await res.json()) as { window: { order: Record<string, unknown> } };
    expect(win.window.order).toMatchObject({
      status: 'collected', collected_by_name: 'שרה מהלובי', handed_over_by_name: people.guard.name, handed_over_via: 'pickup',
    });
  });

  test('an admin has the screen too; a manager — whatever it holds — is sent home, and the API refuses', async ({ browser }) => {
    const admin = await pageAs(browser, people.admin.id);
    await admin.goto('/chip-pickup');
    await expect(admin.getByRole('heading', { name: 'מסירת צ׳יפים' })).toBeVisible();
    await expect(card(admin, readyB.orderNumber)).toHaveCount(1);
    // For an admin "אבטחה" holds all three items.
    const panel = admin.locator('aside [data-nav-panel]');
    expect(await panel.locator('a[data-nav-item]').allInnerTexts()).toEqual(['סריקת כניסה', 'מסירת צ׳יפים', 'צ׳יפים']);

    const manager = await pageAs(browser, people.manager.id);
    await manager.goto('/chip-pickup');
    await expect(manager).not.toHaveURL(/\/chip-pickup/);
    await expect(manager.locator('aside a[href="/chip-pickup"]')).toHaveCount(0);
    expect((await manager.request.get('/api/chip-pickup')).status()).toBe(403);
    expect((await manager.request.post(`/api/chip-pickup/${readyB.id}/handover`, { data: { person: readyB.holders[0] } })).status()).toBe(403);
    expect((await pool.query(`select status from public.chip_orders where id = $1`, [readyB.id])).rows[0].status).toBe('ready');
    // Nobody signed in: the page goes to the login, the API answers 401.
    const anon = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    contexts.push(anon);
    const anonPage = await anon.newPage();
    await anonPage.goto('/chip-pickup');
    await expect(anonPage).toHaveURL(/\/login/);
    expect((await anon.request.get('/api/chip-pickup')).status()).toBe(401);
  });

  test('a guard who stops being one while the screen is open loses the list: the role changed, or the account was disabled', async ({ browser }) => {
    const u = await pool.query<{ id: string }>(
      `insert into public.users (username, password_hash, full_name, role, is_active) values ($1, 'x', 'שומר שהוחלף', 'guard', true) returning id`, [`pk-guard2-${tag}`]);
    const guard2 = u.rows[0]!.id;
    made.users.push(guard2);
    const page = await pageAs(browser, guard2);
    await page.goto('/chip-pickup');
    await expect(card(page, readyB.orderNumber)).toHaveCount(1);

    // The management changes the user's role. The open screen asks again…
    await pool.query(`update public.users set role = 'viewer' where id = $1`, [guard2]);
    await page.getByTestId('chip-pickup-refresh').click();
    // …and nothing of the list stays: the cards go, and the page sends the user away.
    await expect(page.getByTestId('chip-pickup-order')).toHaveCount(0);
    await expect(page).not.toHaveURL(/\/chip-pickup/);
    expect((await page.request.get('/api/chip-pickup')).status()).toBe(403);
    expect((await page.request.post(`/api/chip-pickup/${readyB.id}/handover`, { data: { person: readyB.holders[0] } })).status()).toBe(403);

    // A guard again — and then the account is disabled: the session is dead for the API and for the page.
    await pool.query(`update public.users set role = 'guard' where id = $1`, [guard2]);
    await page.goto('/chip-pickup');
    await expect(card(page, readyB.orderNumber)).toHaveCount(1);
    await pool.query(`update public.users set is_active = false where id = $1`, [guard2]);
    await page.getByTestId('chip-pickup-refresh').click();
    await expect(page.getByTestId('chip-pickup-order')).toHaveCount(0);
    await expect(page).toHaveURL(/\/login/);
    expect((await page.request.get('/api/chip-pickup')).status()).toBe(401);
    expect((await page.request.post(`/api/chip-pickup/${readyB.id}/handover`, { data: { person: readyB.holders[0] } })).status()).toBe(401);
    expect((await pool.query(`select status from public.chip_orders where id = $1`, [readyB.id])).rows[0].status).toBe('ready');
  });

  test('an order whose chips were all disabled shows it, and its "נמסר" is off', async ({ browser }) => {
    const r = await pool.query<{ id: string }>(`insert into public.contacts (apartment_number, owner_name) values ($1, 'בעלים רשום') returning id`, [APT(6)]);
    made.contacts[APT(6)] = r.rows[0]!.id;
    const empty = await seedOrder('ready', [{ apt: APT(6), name: 'בלי צ׳יפים', qty: 1, chips: [num(8)] }]);
    await pool.query(`update public.chips set status = 'inactive', deactivated_at = now(), deactivation_reason = 'lost' where chip_number = $1`, [num(8)]);
    const page = await pageAs(browser, people.guard.id);
    await page.goto('/chip-pickup');
    const mine = card(page, empty.orderNumber);
    await expect(mine.getByTestId('chip-pickup-no-chips')).toContainText('אין צ׳יפים פעילים');
    await expect(mine.getByTestId('chip-pickup-handover')).toBeDisabled();
    // The server refuses it by itself.
    const res = await page.request.post(`/api/chip-pickup/${empty.id}/handover`, { data: { person: empty.holders[0] } });
    expect(res.status()).toBe(409);
    expect((await pool.query(`select status from public.chip_orders where id = $1`, [empty.id])).rows[0].status).toBe('ready');
  });

  test('an empty list says so', async ({ browser }) => {
    const admin = await pageAs(browser, people.admin.id);
    // Hand the last ready order of the suite over (as the admin, through the API the screen uses)…
    expect((await admin.request.post(`/api/chip-pickup/${readyB.id}/handover`, { data: { person: readyB.holders[0] } })).status()).toBe(200);
    const listed = (await (await admin.request.get('/api/chip-pickup')).json()) as { orders: { id: string }[] };
    expect(listed.orders.map((o) => o.id)).not.toContain(readyB.id);
    // …and show the screen with nothing ready. Other suites share this database
    // and may have ready orders of their own, so the answer is the empty one.
    await admin.route('**/api/chip-pickup', (route) => route.fulfill({ json: { ok: true, orders: [] } }));
    await admin.goto('/chip-pickup');
    await expect(admin.getByTestId('chip-pickup-empty')).toContainText('אין כרגע הזמנות שמוכנות לאיסוף');
    await expect(admin.getByTestId('chip-pickup-order')).toHaveCount(0);
  });
});
