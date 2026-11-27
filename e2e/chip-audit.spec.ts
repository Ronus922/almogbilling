import { test, expect, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';

// The audit of the chip module after its first real order (27/11/2026). Paths
// the other chip files did not drive end to end:
//   · the first real order's path (order 1020): a web order the card paid, a
//     chip assigned in its window with "שמור שינויים" only — the order stays
//     "שולם" ("שויך" in the table, "מוכן לאיסוף" offered), it is not on the
//     guard screen, the issue window WITHOUT an order shows the chip and no
//     order line (docs/chip-orders.md: no order section there), and
//     "ביטול וזיכוי" is in the order's own window — for a super admin AND a
//     plain admin — and runs;
//   · the public page with two apartments in one order → one row per
//     apartment → chips → "מוכן לאיסוף" in one click → the guard screen,
//     without a price → "נמסר";
//   · a web order the card paid at "מוכן לאיסוף": "ביטול וזיכוי" runs; one
//     PayPlus showed cancelled is kept off the guard screen and "נאסף" is
//     refused, in the window and by the route;
//   · "העברה בנקאית" at the reception, then "ביטול וזיכוי" RUN from the
//     order's line in the issue window, and its stop shown again in a
//     contact's chips tab;
//   · the chips tab searched by a holder's name;
//   · a notification's link to a chip that no longer exists.
// PayPlus and Morning are not configured here (CI), so a refund step stops at
// "PayPlus אינו מוגדר" and a credit step at "מורנינג לא מחובר" — the steps
// before them, and what every window says, are what these tests prove.

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
pool.on('error', () => undefined);

const tag = String(Date.now()).slice(-6);
const APT_RONEN = `997${tag}1`; // the first real order's path
const APT_PUB1 = `997${tag}2`; // the public page: the first apartment…
const APT_PUB2 = `997${tag}3`; // …and the second, in the same order
const APT_READY = `997${tag}4`; // a card order at "מוכן לאיסוף"
const APT_REVERSED = `997${tag}5`; // a ready card order PayPlus showed cancelled
const APT_TRANSFER = `997${tag}6`; // "העברה בנקאית" at the reception, cancelled from its line
const APT_NAME = `997${tag}7`; // the chips tab searched by name
const APT_STUCK = `997${tag}8`; // "סגירה ידנית" of a refund that got no answer
const APT_UNDO = `997${tag}9`; // a new chip refused once "ביטול וזיכוי" started
const HOLDER_NAME = `מחזיקה חיפוש${tag}`;
const made = { contacts: {} as Record<string, string>, orders: [] as string[], users: [] as string[], sessions: [] as string[], debtors: [] as string[] };
const people = {} as Record<'guard' | 'admin', { id: string; name: string }>;
const contexts: BrowserContext[] = [];

async function pageAs(browser: Browser, userId: string): Promise<Page> {
  const raw = randomBytes(32).toString('base64url');
  const sid = createHash('sha256').update(raw).digest('hex');
  await pool.query(`insert into public.sessions (id, user_id, expires_at, remember) values ($1, $2, now() + interval '3 hours', false)`, [sid, userId]);
  made.sessions.push(sid);
  const ctx = await browser.newContext({
    storageState: { cookies: [{ name: 'almog_sid', value: raw, domain: 'localhost', path: '/', httpOnly: true, secure: true, sameSite: 'Lax', expires: -1 }], origins: [] },
  });
  contexts.push(ctx);
  return ctx.newPage();
}

const toast = (page: Page, text: string): Locator => page.locator('[data-sonner-toast]').filter({ hasText: text }).first();
const issueWindow = (page: Page): Locator => page.getByRole('dialog').filter({ hasText: 'הנפקת צ׳יפ' });
const orderRow = (page: Page, text: string): Locator =>
  page.getByTestId('chip-orders-table').getByTestId('chip-order-row').filter({ hasText: text });
const pickupCard = (page: Page, orderNumber: number): Locator =>
  page.getByTestId('chip-pickup-order').filter({ has: page.getByRole('heading', { name: new RegExp(`הזמנה ${orderNumber}(\\D|$)`) }) });

async function pickApartment(page: Page, apt: string) {
  await issueWindow(page).getByText('בחר דירה או יחידה…').click();
  await page.getByPlaceholder('מספר דירה או שם דייר…').fill(apt);
  await page.locator('[data-slot="popover-content"]').getByRole('button').filter({ hasText: apt }).first().click();
}

async function addChip(block: Locator, number: string) {
  const input = block.getByLabel(/^מספר צ׳יפ/);
  await input.click();
  await input.fill(number);
  await input.press('Enter');
  await expect(block.getByText(number, { exact: true })).toBeVisible();
}

/** A REAL web order the card paid — as recordCardPayment leaves it (production
 *  PayPlus, not a test order) — one apartment, one owner, one chip. */
async function cardOrder(apt: string, name: string, phone: string): Promise<{ id: string; orderNumber: number; item: string; holder: string }> {
  const o = (await pool.query<{ id: string; order_number: number }>(
    `insert into public.chip_orders
       (full_name, phone_e164, email, address, role, status, total, tracking_token, paid_at, due_at, is_test, phone_verified,
        address_street, address_city, address_zip,
        card_provider, card_env, card_status, card_page_request_uid, card_session_at, card_transaction_uid,
        card_paid_amount, card_paid_at, card_approval_number, card_last4)
     values ($1, $2, 'audit.e2e@example.test', 'רחוב בדיקה 3, חיפה 3300000', 'owner', 'paid', 50, $3,
             now(), now() + interval '3 days', false, true, 'רחוב בדיקה 3', 'חיפה', '3300000',
             'payplus', 'production', 'paid', $4, now(), $5, 50, now(), '0301986', '4242')
     returning id, order_number`,
    [name, phone, randomBytes(32).toString('base64url'), `e2e-pr-audit-${tag}-${randomUUID()}`, `e2e-tx-audit-${tag}-${randomUUID()}`],
  )).rows[0]!;
  made.orders.push(o.id);
  const item = (await pool.query<{ id: string }>(
    `insert into public.chip_order_items
       (order_id, contact_id, apartment_number, chips_count, unit_price, threshold, price_above, line_total, match_status)
     values ($1, $2, $3, 1, 50, 1, 50, 50, 'review') returning id`,
    [o.id, made.contacts[apt], apt],
  )).rows[0]!;
  const holder = (await pool.query<{ id: string }>(
    `insert into public.chip_order_holders (order_id, item_id, position, source, role, full_name, phone, chips_count)
     values ($1, $2, 0, 'order', 'owner', $3, $4, 1) returning id`,
    [o.id, item.id, name, phone],
  )).rows[0]!;
  return { id: o.id, orderNumber: o.order_number, item: item.id, holder: holder.id };
}

/** Issue `number` to the order's holder line and mark the order ready — the
 *  routes the window calls ("שמור שינויים", then "מוכן לאיסוף"). */
async function assignAndReady(page: Page, o: { id: string; item: string; holder: string }, name: string, phone: string, number: string) {
  const saved = await page.request.post(`/api/chip-orders/${o.id}/holders`, {
    data: {
      holders: [{ id: o.holder, item_id: o.item, legacy: false, role: 'owner', full_name: name, phone, email: null, new_chips: [{ number, chip_type: 'physical' }] }],
      removed_holder_ids: [],
    },
  });
  expect(saved.status()).toBe(201);
  expect((await page.request.post(`/api/chip-orders/${o.id}/ready`)).status()).toBe(200);
}

const orderState = async (id: string) => (await pool.query<{ status: string; cancel_failed_step: string | null; cancel_completed: boolean; refund_requested_at: Date | null }>(
  `select status, cancel_failed_step, cancel_completed_at is not null as cancel_completed, refund_requested_at from public.chip_orders where id = $1`, [id])).rows[0]!;

test.beforeAll(async () => {
  for (const apt of [APT_RONEN, APT_PUB1, APT_PUB2, APT_READY, APT_REVERSED, APT_TRANSFER, APT_NAME, APT_STUCK, APT_UNDO]) {
    made.contacts[apt] = (await pool.query<{ id: string }>(`insert into public.contacts (apartment_number) values ($1) returning id`, [apt])).rows[0]!.id;
  }
  for (const [key, role] of [['guard', 'guard'], ['admin', 'admin']] as const) {
    const username = `chip-audit-${key}-${tag}`;
    const name = `ביקורת ${key === 'guard' ? 'שומר' : 'אדמין'} ${tag}`;
    const u = await pool.query<{ id: string }>(
      `insert into public.users (username, email, password_hash, full_name, role, is_active) values ($1, $2, 'x', $3, $4, true) returning id`,
      [username, role === 'guard' ? null : `${username}@billing.local`, name, role],
    );
    people[key] = { id: u.rows[0]!.id, name };
    made.users.push(u.rows[0]!.id);
  }
});

test.afterAll(async () => {
  const contactIds = Object.values(made.contacts);
  const chips = await pool.query<{ id: string }>(`select id from public.chips where contact_id = any($1::uuid[])`, [contactIds]);
  for (const { id } of chips.rows) {
    await pool.query(`delete from public.chip_events where chip_id = $1`, [id]);
    await pool.query(`delete from public.chips where id = $1`, [id]);
  }
  // Every order of THESE apartments (seeded here, made by the public page or by
  // the reception window) — its documents first (ON DELETE RESTRICT), a credit
  // before the invoice it credits.
  const orders = await pool.query<{ id: string }>(
    `select distinct o.id from public.chip_orders o join public.chip_order_items i on i.order_id = o.id where i.contact_id = any($1::uuid[])`,
    [contactIds],
  );
  for (const id of new Set([...made.orders, ...orders.rows.map((r) => r.id)])) {
    const docs = await pool.query<{ id: string }>(`select id from public.chip_order_documents where order_id = $1 order by (credit_of is null), created_at`, [id]);
    for (const d of docs.rows) await pool.query(`delete from public.chip_order_documents where id = $1`, [d.id]);
    await pool.query(`delete from public.chip_orders where id = $1`, [id]);
  }
  for (const id of made.debtors) await pool.query(`delete from public.debtors where id = $1`, [id]);
  for (const id of contactIds) await pool.query(`delete from public.chip_reception_records where contact_id = $1`, [id]);
  for (const id of contactIds) await pool.query(`delete from public.contacts where id = $1`, [id]);
  for (const c of contexts) await c.close().catch(() => undefined);
  for (const sid of made.sessions) await pool.query(`delete from public.sessions where id = $1`, [sid]);
  if (made.users.length > 0) {
    await pool.query(`delete from public.audit_log where entity_id = any($1::text[]) or actor_user_id = any($1::uuid[])`, [made.users]);
    await pool.query(`delete from public.users where id = any($1::uuid[])`, [made.users]);
  }
  await pool.end();
});

test.describe('chip audit 27/11/2026', () => {
  test('the first real order\'s path: a chip assigned with "שמור שינויים" leaves the order "שולם" — "שויך" with "מוכן לאיסוף" on its row, not on the guard screen; the issue window without an order shows the chip and no order line; "ביטול וזיכוי" is in the order\'s window for a super admin and a plain admin, and it runs', async ({ page, browser }) => {
    const name = 'רונן ביקורת';
    const phone = '+972539300081';
    const o = await cardOrder(APT_RONEN, name, phone);
    const number = `AU${tag}1`;

    await page.goto('/chips?view=orders');
    const row = orderRow(page, APT_RONEN);
    await expect(row.getByTestId('chip-order-stage')).toHaveText('ממתין לשיוך');
    await row.click();
    const issue = issueWindow(page);
    await expect(issue.getByTestId('chip-order-section')).toBeVisible();
    await addChip(issue.getByTestId('chip-holder-block').first(), number);
    await issue.getByTestId('chip-issue-save').click();
    await expect(issue).toHaveCount(0);
    await expect(toast(page, 'הצ׳יפ הונפק')).toBeVisible();

    // Saved, linked to the order — and the order is still "שולם" (nothing marked it ready).
    const chip = (await pool.query<{ status: string; order_item_id: string; order_holder_id: string }>(
      `select status, order_item_id, order_holder_id from public.chips where chip_number = $1`, [number])).rows[0]!;
    expect(chip).toEqual({ status: 'active', order_item_id: o.item, order_holder_id: o.holder });
    expect((await orderState(o.id)).status).toBe('paid');
    await expect(row.getByTestId('chip-order-stage')).toHaveText('שויך');
    await expect(row.getByTestId('chip-order-row-ready')).toHaveText('מוכן לאיסוף');
    await expect(row.getByTestId('chip-order-row-cancel')).toHaveCount(0);

    // The guard screen lists ready orders only.
    const guard = await pageAs(browser, people.guard.id);
    await guard.goto('/chip-pickup');
    await expect(guard.getByTestId('chip-pickup-refresh')).toBeVisible();
    await expect(pickupCard(guard, o.orderNumber)).toHaveCount(0);

    // The issue window WITHOUT an order: the chip, no order section, no order line.
    await page.goto('/chips');
    await page.getByRole('button', { name: 'הנפק צ׳יפ' }).click();
    await pickApartment(page, APT_RONEN);
    await expect(issue.getByText(number, { exact: true })).toBeVisible();
    await expect(issue.getByTestId('chip-order-section')).toHaveCount(0);
    await expect(issue.getByTestId('chip-reception-records')).toHaveCount(0);
    await expect(issue.getByTestId('chip-reception-record-cancel')).toHaveCount(0);
    await issue.getByTestId('chip-issue-close').click();

    // A plain admin finds "ביטול וזיכוי" in the order's window.
    const admin = await pageAs(browser, people.admin.id);
    await admin.goto('/chips?view=orders');
    await orderRow(admin, APT_RONEN).click();
    await expect(issueWindow(admin).getByTestId('chip-order-section').getByTestId('chip-order-cancel-reception')).toHaveText('ביטול וזיכוי');

    // The super admin runs it: the confirmation names the chip, the refund goes
    // to PayPlus first — not configured here, so it stops there, and the chip stays.
    await page.goto('/chips?view=orders');
    await row.click();
    const section = issue.getByTestId('chip-order-section');
    await section.getByTestId('chip-order-cancel-reception').click();
    const dialog = page.getByTestId('reception-cancel-dialog');
    await expect(dialog).toContainText(`ביטול וזיכוי — הזמנה ${o.orderNumber}`);
    await expect(dialog.getByTestId('reception-cancel-amount')).toHaveText('50₪');
    await expect(dialog).toContainText('להזמנה הונפק צ׳יפ פעיל אחד — הוא יושבת');
    await expect(dialog.getByTestId('reception-cancel-run')).toHaveText('ביטול וזיכוי 50₪');
    await dialog.getByLabel('סיבת הביטול').fill('ביקורת');
    await dialog.getByTestId('reception-cancel-run').click();
    await expect(toast(page, 'הביטול נעצר בשלב: הזיכוי ב-PayPlus')).toBeVisible();
    await expect(dialog.getByTestId('reception-cancel-failed')).toContainText('PayPlus אינו מוגדר בשרת לסביבה של ההזמנה');
    expect(await orderState(o.id)).toMatchObject({ status: 'paid', cancel_failed_step: 'refund', cancel_completed: false, refund_requested_at: null });
    expect((await pool.query(`select status from public.chips where chip_number = $1`, [number])).rows[0].status).toBe('active');
  });

  test('the public page with two apartments in one order: a row per apartment, chips in one window, "מוכן לאיסוף" in one click → the guard screen shows both apartments and no price → "נמסר" collects it', async ({ page, browser }) => {
    // Test mode on, through /settings, and back as it was at the end.
    const before = (await pool.query<{ value: unknown }>(`select value from public.app_settings where key = 'chip_orders_test_mode'`)).rows[0]?.value ?? null;
    try {
      await page.goto('/settings');
      const sw = page.getByTestId('chip-order-test-mode').getByRole('switch', { name: 'מצב בדיקה' });
      if ((await sw.getAttribute('aria-checked')) === 'true') await sw.click();
      await sw.click();
      const link = await page.getByTestId('chip-order-test-link').inputValue();

      const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] }, viewport: { width: 390, height: 844 } });
      contexts.push(ctx);
      const pub = await ctx.newPage();
      await pub.goto(new URL(link).pathname + new URL(link).search);
      const rows = pub.getByTestId('chip-order-line');
      const first = rows.nth(0);
      await first.getByLabel('שם מלא').fill('דייר שתי דירות');
      await first.getByRole('button', { name: 'דירה, שורה 1' }).click();
      await pub.getByLabel('חיפוש לפי מספר דירה').fill(APT_PUB1);
      await pub.getByLabel('חיפוש לפי מספר דירה').press('Enter');
      await expect(first.getByRole('button', { name: 'דירה, שורה 1' })).toHaveText(`דירה ${APT_PUB1}`);
      await first.getByLabel('טלפון נייד').fill('0539300082');
      await first.getByLabel('מייל').fill('two-apartments.e2e@example.test');
      await pub.getByRole('button', { name: 'הוספת דירה' }).click();
      await pub.getByLabel('חיפוש לפי מספר דירה').fill(APT_PUB2);
      await pub.getByLabel('חיפוש לפי מספר דירה').press('Enter');
      await expect(rows.nth(1).getByRole('button', { name: 'דירה, שורה 2' })).toHaveText(`דירה ${APT_PUB2}`);
      await pub.locator('#co-street').fill('רחוב בדיקה 4');
      await pub.locator('#co-city').fill('חיפה');
      await pub.locator('#co-zip').fill('3300000');
      await pub.getByRole('checkbox', { name: /הפרטים שמסרתי הינם נכונים/ }).check();
      await pub.getByTestId('chip-order-pay').click();
      await expect(pub.getByTestId('chip-order-confirmation')).toBeVisible();

      const order = (await pool.query<{ id: string; order_number: number; status: string; items: number }>(
        `select o.id, o.order_number, o.status, (select count(*)::int from public.chip_order_items x where x.order_id = o.id) as items
           from public.chip_orders o
          where o.id = (select i.order_id from public.chip_order_items i where i.contact_id = $1 limit 1)`, [made.contacts[APT_PUB1]])).rows[0]!;
      expect(order).toMatchObject({ status: 'paid', items: 2 });

      // One row per apartment, the same order.
      await page.goto('/chips?view=orders');
      for (const apt of [APT_PUB1, APT_PUB2]) {
        await expect(orderRow(page, apt).locator('[data-col="number"]')).toHaveText(String(order.order_number));
      }
      await orderRow(page, APT_PUB1).click();
      const issue = issueWindow(page);
      const blocks = issue.getByTestId('chip-holder-block');
      await expect(blocks).toHaveCount(2);
      await addChip(blocks.nth(0), `AP${tag}1`);
      await addChip(blocks.nth(1), `AP${tag}2`);
      await issue.getByTestId('chip-order-actions').getByRole('button', { name: 'מוכן לאיסוף' }).click();
      await expect(issue).toHaveCount(0);
      await expect(toast(page, 'סומן מוכן לאיסוף')).toBeVisible();
      expect((await orderState(order.id)).status).toBe('ready');

      // The guard: both apartments, the two numbers, no price — then "נמסר".
      const guard = await pageAs(browser, people.guard.id);
      await guard.goto('/chip-pickup');
      const mine = pickupCard(guard, order.order_number);
      await expect(mine.getByTestId('chip-pickup-apartments')).toHaveText(`דירות ${APT_PUB1}, ${APT_PUB2}`);
      await expect(mine.getByTestId('chip-pickup-total')).toHaveText('סה״כ 2 צ׳יפים');
      await expect(mine).not.toContainText('₪');
      await expect(mine.getByRole('button')).toHaveText(['נמסר']);
      await mine.getByTestId('chip-pickup-handover').click();
      const dialog = guard.getByTestId('chip-pickup-confirm');
      await dialog.getByTestId('chip-pickup-collector').first().click();
      await dialog.getByTestId('chip-pickup-confirm-button').click();
      await expect(toast(guard, `הזמנה ${order.order_number} נמסרה`)).toBeVisible();
      expect((await pool.query(`select status, handed_over_via from public.chip_orders where id = $1`, [order.id])).rows[0])
        .toEqual({ status: 'collected', handed_over_via: 'pickup' });
    } finally {
      if (before === null) await pool.query(`delete from public.app_settings where key = 'chip_orders_test_mode'`);
      else await pool.query(`update public.app_settings set value = $1::jsonb where key = 'chip_orders_test_mode'`, [JSON.stringify(before)]);
    }
  });

  test('a card order at "מוכן לאיסוף": "ביטול וזיכוי" runs from its window; one PayPlus showed cancelled is kept off the guard screen, "נאסף" is off in its window and refused by the route', async ({ page, browser }) => {
    const ready = await cardOrder(APT_READY, 'מוכנה ביקורת', '+972539300083');
    await assignAndReady(page, ready, 'מוכנה ביקורת', '+972539300083', `RD${tag}1`);
    const reversed = await cardOrder(APT_REVERSED, 'מבוטלת ביקורת', '+972539300084');
    await assignAndReady(page, reversed, 'מבוטלת ביקורת', '+972539300084', `RD${tag}2`);
    // What the callback of a cancellation made in the PayPlus dashboard leaves.
    await pool.query(`update public.chip_orders set payplus_reversal_at = now(), payplus_reversal_kind = 'cancelled' where id = $1`, [reversed.id]);

    const guard = await pageAs(browser, people.guard.id);
    await guard.goto('/chip-pickup');
    await expect(pickupCard(guard, ready.orderNumber)).toHaveCount(1);
    await expect(pickupCard(guard, reversed.orderNumber)).toHaveCount(0);
    expect((await guard.request.post(`/api/chip-orders/${reversed.id}/collected`, { data: {} })).status()).toBe(403);

    await page.goto('/chips?view=orders');
    await orderRow(page, APT_REVERSED).click();
    const issue = issueWindow(page);
    await expect(issue.getByTestId('chip-order-payplus-reversal')).toContainText('בוטל ב-PayPlus');
    await expect(issue.getByTestId('chip-order-actions').getByRole('button', { name: 'נאסף' })).toBeDisabled();
    const refused = await page.request.post(`/api/chip-orders/${reversed.id}/collected`, { data: {} });
    expect(refused.status()).toBe(409);
    expect(((await refused.json()) as { error?: string }).error).toContain('PayPlus מראה שהחיוב בוטל או זוכה');
    await issue.getByTestId('chip-issue-close').click();

    await orderRow(page, APT_READY).click();
    const section = issue.getByTestId('chip-order-section');
    await section.getByTestId('chip-order-cancel-reception').click();
    const dialog = page.getByTestId('reception-cancel-dialog');
    await expect(dialog).toContainText('להזמנה הונפק צ׳יפ פעיל אחד — הוא יושבת');
    await dialog.getByLabel('סיבת הביטול').fill('ביקורת מוכנה');
    await dialog.getByTestId('reception-cancel-run').click();
    await expect(toast(page, 'הביטול נעצר בשלב: הזיכוי ב-PayPlus')).toBeVisible();
    expect(await orderState(ready.id)).toMatchObject({ status: 'ready', cancel_failed_step: 'refund', cancel_completed: false });
  });

  test('"העברה בנקאית" at the reception: "ביטול וזיכוי" RUN from the order\'s line in the issue window stops at the Morning step, and the same stop shows in a contact\'s chips tab', async ({ page }) => {
    await page.goto('/chips');
    await page.getByRole('button', { name: 'הנפק צ׳יפ' }).click();
    const issue = issueWindow(page);
    await pickApartment(page, APT_TRANSFER);
    const block = issue.getByTestId('chip-holder-block');
    await block.getByRole('radio', { name: 'אורח' }).click();
    await block.getByLabel('שם מלא').fill('אורח העברה ביקורת');
    await addChip(block, `TA${tag}1`);
    await issue.getByTestId('chip-reception-payment').getByTestId('chip-pay-transfer').click();
    await issue.getByTestId('chip-issue-save').click();
    await expect(issue).toHaveCount(0);
    const order = (await pool.query<{ id: string; order_number: number }>(
      `select o.id, o.order_number from public.chip_orders o join public.chip_order_items i on i.order_id = o.id
        where i.contact_id = $1 and o.source = 'reception'`, [made.contacts[APT_TRANSFER]])).rows[0]!;

    await page.getByRole('button', { name: 'הנפק צ׳יפ' }).click();
    await pickApartment(page, APT_TRANSFER);
    const records = issue.getByTestId('chip-reception-records');
    await expect(records).toContainText(`הזמנת קבלה ${order.order_number}`);
    await records.getByTestId('chip-reception-record-cancel').click();
    const dialog = page.getByTestId('reception-cancel-dialog');
    await expect(dialog).toContainText(`ביטול וזיכוי — הזמנת קבלה ${order.order_number}`);
    await dialog.getByLabel('סיבת הביטול').fill('ביקורת העברה');
    await dialog.getByTestId('reception-cancel-run').click();
    await expect(toast(page, 'הביטול נעצר בשלב: מסמך הזיכוי במורנינג')).toBeVisible();
    await expect(dialog.getByTestId('reception-cancel-failed')).toContainText('מורנינג לא מחובר');
    expect(await orderState(order.id)).toMatchObject({ status: 'collected', cancel_failed_step: 'credit', cancel_completed: false });

    // The contact's chips tab: the same line, its stop, and the way to go on.
    const debtor = (await pool.query<{ id: string }>(
      `insert into public.debtors (id, apartment_number, owner_name, phone_owner, total_debt, management_fees, hot_water_debt, contact_id)
       values ($1, $2, 'דייר ביקורת', '0539300085', 100, 100, 0, $3) returning id`,
      [randomUUID(), APT_TRANSFER, made.contacts[APT_TRANSFER]],
    )).rows[0]!;
    made.debtors.push(debtor.id);
    await page.goto(`/dashboard?apt=${APT_TRANSFER}`);
    await page.getByRole('row').filter({ hasText: APT_TRANSFER }).first().click();
    await page.getByRole('button', { name: 'צ׳יפים', exact: true }).click();
    await page.getByRole('button', { name: 'הנפק צ׳יפ' }).click();
    const tabRecords = issueWindow(page).getByTestId('chip-reception-records');
    await expect(tabRecords.getByTestId('chip-reception-record-cancel')).toHaveText('המשך ביטול וזיכוי');
    await expect(tabRecords.getByTestId('chip-reception-record-cancel-stopped')).toContainText('מורנינג לא מחובר');
  });

  test('"סגירה ידנית" of a "ביטול וזיכוי" stuck at a refund that got no answer: the window issues no new chip; only a super admin is offered the action; a reason is required; the order is cancelled, its chip disabled, and the mark stays in the window and on the row', async ({ page, browser }) => {
    const o = await cardOrder(APT_STUCK, 'תקועה ביקורת', '+972539300087');
    await assignAndReady(page, o, 'תקועה ביקורת', '+972539300087', `ST${tag}1`);
    // As the run leaves it when PayPlus never answered the refund call.
    await pool.query(
      `update public.chip_orders
          set cancel_requested_at = now(), cancel_requested_by = $2, cancel_requested_by_name = 'e2e-admin', cancel_request_reason = 'הלקוח ביטל',
              cancel_failed_step = 'refund', cancel_error = 'לא התקבלה תשובה מ-PayPlus על הזיכוי',
              refund_requested_at = now() - interval '1 hour', refund_status = 'manual_required', refund_note = 'לא התקבלה תשובה'
        where id = $1`,
      [o.id, (await pool.query<{ id: string }>(`select id from public.users where username = 'e2e-admin'`)).rows[0]!.id],
    );

    // A plain admin: "המשך ביטול וזיכוי", no "סגירה ידנית"; the route says 403.
    const admin = await pageAs(browser, people.admin.id);
    await admin.goto('/chips?view=orders');
    await orderRow(admin, APT_STUCK).click();
    const adminSection = issueWindow(admin).getByTestId('chip-order-section');
    await expect(adminSection.getByTestId('chip-order-cancel-reception')).toHaveText('המשך ביטול וזיכוי');
    await expect(adminSection.getByTestId('chip-order-close-by-hand')).toHaveCount(0);
    expect((await admin.request.post(`/api/chip-orders/${o.id}/close-by-hand`, { data: { reason: 'ניסיון' } })).status()).toBe(403);

    // Another order whose "ביטול וזיכוי" started (and stopped — PayPlus could
    // not be asked): its window refuses the chip it still lacks, with the reason.
    const undo = await cardOrder(APT_UNDO, 'בדרך חזרה ביקורת', '+972539300088');
    await pool.query(
      `update public.chip_orders
          set cancel_requested_at = now(), cancel_requested_by_name = 'e2e-admin', cancel_request_reason = 'הלקוח ביטל',
              cancel_failed_step = 'refund', cancel_error = 'לא ניתן לבדוק כרגע ב-PayPlus'
        where id = $1`, [undo.id]);
    await page.goto('/chips?view=orders');
    await orderRow(page, APT_UNDO).click();
    const issue = issueWindow(page);
    await addChip(issue.getByTestId('chip-holder-block').first(), `ST${tag}2`);
    await issue.getByTestId('chip-issue-save').click();
    await expect(issue).toContainText('אי אפשר להנפיק לה צ׳יפים חדשים');
    expect((await pool.query(`select 1 from public.chips where chip_number = $1`, [`ST${tag}2`])).rowCount).toBe(0);
    await issue.getByTestId('chip-issue-close').click();
    // The number still waits in the window: leave without it.
    await page.getByRole('button', { name: 'צא ללא שמירה' }).click();
    await expect(issue).toHaveCount(0);

    await orderRow(page, APT_STUCK).click();
    const section = issue.getByTestId('chip-order-section');

    await section.getByTestId('chip-order-close-by-hand').click();
    const dialog = page.getByTestId('close-by-hand-dialog');
    await expect(dialog).toContainText(`סגירה ידנית — הזמנה ${o.orderNumber}`);
    await expect(dialog).toContainText('נעצר בשלב: הזיכוי ב-PayPlus');
    await expect(dialog.getByTestId('close-by-hand-skipped')).toContainText('הסגירה לא שולחת זיכוי ל-PayPlus ולא מפיקה מסמך זיכוי במורנינג');
    await expect(dialog).toContainText('הצ׳יפ הפעיל שלה יושבת');
    const run = dialog.getByTestId('close-by-hand-run');
    await expect(run).toBeDisabled();
    await dialog.getByLabel('הסיבה לסגירה הידנית').fill('הזיכוי בוצע בממשק PayPlus — אומת');
    await run.click();
    await expect(toast(page, `הזמנה ${o.orderNumber} נסגרה ידנית`)).toBeVisible();
    await expect(dialog).toHaveCount(0);
    await expect(section.getByTestId('chip-order-closed-by-hand')).toContainText('נסגרה ידנית — בשלב: הזיכוי ב-PayPlus');
    await expect(section.getByTestId('chip-order-closed-by-hand')).toContainText('הזיכוי בוצע בממשק PayPlus — אומת');
    await expect(section.getByTestId('chip-order-close-by-hand')).toHaveCount(0);
    await expect(section.getByTestId('chip-order-cancel-reception')).toHaveCount(0);
    expect((await pool.query(`select status from public.chips where chip_number = $1`, [`ST${tag}1`])).rows[0].status).toBe('inactive');
    expect((await pool.query(`select status, closed_by_hand_step from public.chip_orders where id = $1`, [o.id])).rows[0])
      .toEqual({ status: 'rejected', closed_by_hand_step: 'refund' });

    // The row keeps the mark for good.
    await page.goto('/chips?view=orders');
    await expect(orderRow(page, APT_STUCK).getByTestId('chip-order-closed-by-hand-tag')).toHaveText('נסגרה ידנית');
  });

  test('the chips tab: a search by a holder\'s name finds the chip', async ({ page }) => {
    await pool.query(
      `insert into public.chips (chip_number, chip_type, contact_id, apartment_number, status, resident_role, holder_name, holder_phone, issued_at, issued_by_name)
       values ($1, 'physical', $2, $3, 'active', 'owner', $4, '+972539300086', now(), 'ביקורת')`,
      [`NM${tag}1`, made.contacts[APT_NAME], APT_NAME, HOLDER_NAME],
    );
    await page.goto('/chips');
    await page.getByPlaceholder('חפש לפי מספר צ׳יפ, מספר דירה או שם דייר').fill(HOLDER_NAME);
    await expect(page.getByTestId('chips-table').getByText(`NM${tag}1`, { exact: true })).toBeVisible();
  });

  test('a notification\'s link to a chip that no longer exists: the page stays usable and says so', async ({ page }) => {
    await page.goto(`/chips?chip=${randomUUID()}`);
    await expect(page.getByRole('heading', { name: 'צ׳יפי כניסה' })).toBeVisible();
    const t = page.locator('[data-sonner-toast]').first();
    await expect(t).toBeVisible();
    test.info().annotations.push({ type: 'toast', description: (await t.innerText()).trim() });
    await expect(issueWindow(page)).toHaveCount(0);
  });
});
