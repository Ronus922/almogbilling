import { test, expect, type Page } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';

// Chip orders, in the browser (12/11/2026; handled inside the issue window
// since 13/11/2026 — there is no order panel and no "אשר" step):
//   · /chips keeps its chips view as the default — KPIs, the table, "הנפק צ׳יפ";
//   · the issue window opened WITHOUT an order is unchanged (no order section,
//     no "עדכן בכרטיס הדייר"), even for an apartment that has an open order;
//   · a PAID order is one Orders-tab row per apartment; the row opens the
//     EXISTING issue window on the apartment with the orderer's block
//     prefilled and its "פרטי הזמנה" section; more chips than ordered warn but
//     save; the tenants list is written ONLY by "עדכן בכרטיס הדייר", after a
//     confirmation; "מוכן לאיסוף" → "נאסף" takes the row out of the tab; a
//     repeat order of the same person opens the SAME block with its chips;
//   · /chip-order is closed ("ההזמנות ייפתחו בקרוב") while Grow is not
//     configured — the CI state — and no page scrolls sideways on a phone.
// The real order is seeded straight into the DB (paid = what Grow's verified
// callback produces); fixtures are numeric apartments, removed by exact ids.

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
pool.on('error', () => undefined);

const tag = String(Date.now()).slice(-6);
const APT = `992${tag}1`;
const PHONE = '+972539300001';
const made = { contact: '', orders: [] as string[] };

async function noSideScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

/** A PAID real order of 'דנה בדיקה' for APT — what Grow's verified callback leaves. */
async function seedPaidOrder(chips: number): Promise<{ id: string; orderNumber: number; itemId: string }> {
  const o = await pool.query<{ id: string; order_number: number }>(
    `insert into public.chip_orders
       (full_name, phone_e164, email, address, role, status, total, tracking_token, paid_at, due_at,
        grow_process_id, grow_transaction_id, grow_asmachta)
     values ('דנה בדיקה', $4, 'dana.e2e@example.test', 'רחוב בדיקה 1', 'owner', 'paid', $5, $1, now(), now() + interval '3 days',
             $2, $3, 'e2e')
     returning id, order_number`,
    [randomBytes(32).toString('base64url'), `e2e-p-${tag}-${made.orders.length}`, `e2e-t-${tag}-${made.orders.length}`, PHONE, 50 * chips],
  );
  made.orders.push(o.rows[0]!.id);
  const i = await pool.query<{ id: string }>(
    `insert into public.chip_order_items
       (order_id, contact_id, apartment_number, chips_count, unit_price, threshold, price_above, line_total, match_status)
     values ($1, $2, $3, $4, 50, 2, 70, $5, 'unassigned') returning id`,
    [o.rows[0]!.id, made.contact, APT, chips, 50 * chips],
  );
  return { id: o.rows[0]!.id, orderNumber: o.rows[0]!.order_number, itemId: i.rows[0]!.id };
}

test.beforeAll(async () => {
  const c = await pool.query<{ id: string }>(
    `insert into public.contacts (apartment_number) values ($1) returning id`,
    [APT],
  );
  made.contact = c.rows[0]!.id;
});

test.afterAll(async () => {
  const chips = await pool.query<{ id: string }>(`select id from public.chips where contact_id = $1`, [made.contact]);
  for (const { id } of chips.rows) {
    await pool.query(`delete from public.chip_events where chip_id = $1`, [id]);
    await pool.query(`delete from public.chips where id = $1`, [id]);
  }
  for (const id of made.orders) await pool.query(`delete from public.chip_orders where id = $1`, [id]);
  if (made.contact) await pool.query(`delete from public.contacts where id = $1`, [made.contact]);
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

test.describe.serial('staff: orders inside the issue window', () => {
  const first = { id: '', orderNumber: 0, itemId: '' };

  test('the issue window WITHOUT an order is unchanged — even for an apartment with an open order', async ({ page }) => {
    Object.assign(first, await seedPaidOrder(1));
    await page.goto('/chips');
    await page.getByRole('button', { name: 'הנפק צ׳יפ' }).click();
    const issue = page.getByRole('dialog').filter({ hasText: 'הנפקת צ׳יפ' });
    await expect(issue.getByText('בחר דירה כדי להוסיף בעלי צ׳יפ')).toBeVisible();
    await issue.getByText('בחר דירה או יחידה…').click();
    await page.getByPlaceholder('מספר דירה או שם דייר…').fill(APT);
    await page.getByRole('button').filter({ hasText: APT }).first().click();
    await expect(issue.getByTestId('chip-holder-block')).toHaveCount(1);
    await expect(issue.getByTestId('chip-holder-block')).toContainText('בעל צ׳יפ חדש');
    await expect(issue.getByTestId('chip-order-section')).toHaveCount(0);
    await expect(issue.getByTestId('chip-holder-registry-update')).toHaveCount(0);
    await expect(issue.getByLabel('שם בעל הצ׳יפ')).toHaveValue('');
  });

  test('a row per apartment → the prefilled block + "פרטי הזמנה" → more than ordered warns but saves → "שויך" → "עדכן בכרטיס הדייר" only on click → ready → collected → the row leaves', async ({ page }) => {
    await page.goto('/chips?view=orders');
    const row = page.getByTestId('chip-orders-table').getByTestId('chip-order-row').filter({ hasText: APT });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('דנה בדיקה');
    await expect(row.getByTestId('chip-order-stage')).toHaveText('ממתין לשיוך');
    await row.click();

    const issue = page.getByRole('dialog').filter({ hasText: 'הנפקת צ׳יפ' });
    await expect(issue.getByText(`דירה ${APT}`)).toBeVisible();
    const block = issue.getByTestId('chip-holder-block');
    await expect(block).toHaveCount(1);
    await expect(block.getByLabel('שם בעל הצ׳יפ')).toHaveValue('דנה בדיקה');
    await expect(block.getByLabel('טלפון בעל הצ׳יפ')).toHaveValue('0539300001');
    await expect(block).toContainText('בעל דירה');
    const section = block.getByTestId('chip-order-section');
    await expect(section).toContainText('פרטי הזמנה');
    await expect(section).toContainText('dana.e2e@example.test');
    await expect(section).toContainText('רחוב בדיקה 1');
    await expect(section).toContainText(String(first.orderNumber));
    await expect(section).toContainText('₪50');
    await expect(section.getByTestId('chip-order-stage')).toHaveText('ממתין לשיוך');
    await expect(section.getByRole('button', { name: 'מוכן לאיסוף' })).toBeDisabled();

    // Two numbers for one ordered chip: a warning, and the save still goes through.
    const numberInput = block.getByPlaceholder('מספר צ׳יפ');
    for (const n of [`E2E${tag}1`, `E2E${tag}2`]) {
      await numberInput.fill(n);
      await numberInput.press('Enter');
    }
    await expect(section.getByRole('alert')).toContainText('יותר צ׳יפים ממה שהוזמן');
    await issue.getByRole('button', { name: /^(הנפק צ׳יפ|שמור והנפק)$/ }).click();
    await expect(issue).toHaveCount(0);
    const linked = await pool.query(`select count(*)::int as n from public.chips where order_item_id = $1 and status = 'active'`, [first.itemId]);
    expect(linked.rows[0].n).toBe(2);
    // Issuing wrote nothing to the tenants list.
    const untouched = await pool.query(`select owner_name, owner_phone, owner_email from public.contacts where id = $1`, [made.contact]);
    expect(untouched.rows[0]).toEqual({ owner_name: null, owner_phone: null, owner_email: null });
    await expect(row.getByTestId('chip-order-stage')).toHaveText('שויך');

    // The chips are in the "צ׳יפים" tab like any other chip.
    await page.getByRole('tab', { name: /צ׳יפים/ }).click();
    await page.getByPlaceholder('חפש לפי מספר צ׳יפ, מספר דירה או שם דייר').fill(`E2E${tag}1`);
    await expect(page.getByText(`E2E${tag}1`).first()).toBeVisible();
    await page.getByRole('tab', { name: /הזמנות/ }).click();

    await row.click();
    await expect(section.getByTestId('chip-order-stage')).toHaveText('שויך');
    // "עדכן בכרטיס הדייר": a confirmation first; the phone of an owner warns about the portal.
    await block.getByTestId('chip-holder-registry-update').click();
    const confirm = page.getByRole('alertdialog');
    await expect(confirm).toContainText('פורטל הדירה');
    await confirm.getByRole('button', { name: 'עדכן בכרטיס הדייר' }).click();
    await expect.poll(async () => (await pool.query(`select owner_name, owner_phone, owner_email from public.contacts where id = $1`, [made.contact])).rows[0])
      .toEqual({ owner_name: 'דנה בדיקה', owner_phone: '0539300001', owner_email: null });

    await section.getByRole('button', { name: 'מוכן לאיסוף' }).click();
    await expect(section.getByTestId('chip-order-stage')).toHaveText('מוכן לאיסוף');
    // The "ready" message was attempted on both channels, each on its own.
    await expect.poll(async () => (await pool.query(
      `select count(distinct channel)::int as n from public.chip_order_notifications where order_id = $1 and kind = 'ready'`,
      [first.id],
    )).rows[0].n, { timeout: 30_000 }).toBe(2);
    await section.getByRole('button', { name: 'נאסף', exact: true }).click();
    await expect(block.getByTestId('chip-order-section')).toHaveCount(0);
    await expect.poll(async () => (await pool.query(`select status from public.chip_orders where id = $1`, [first.id])).rows[0].status).toBe('collected');
    await issue.getByRole('button', { name: 'סגור' }).last().click();
    await expect(row).toHaveCount(0);
  });

  test('a repeat order of the same person opens the SAME block, with the chips already issued, plus the new "פרטי הזמנה"', async ({ page }) => {
    const repeat = await seedPaidOrder(1);
    await page.goto('/chips?view=orders');
    const row = page.getByTestId('chip-orders-table').getByTestId('chip-order-row').filter({ hasText: APT });
    await expect(row).toHaveCount(1);
    await row.click();
    const issue = page.getByRole('dialog').filter({ hasText: 'הנפקת צ׳יפ' });
    const blocks = issue.getByTestId('chip-holder-block');
    await expect(blocks).toHaveCount(1);
    await expect(blocks).toContainText('2 צ׳יפים קיימים');
    await expect(blocks.getByTestId('chip-order-section')).toHaveCount(1);
    await expect(blocks.getByTestId('chip-order-section')).toContainText(String(repeat.orderNumber));
    const numberInput = blocks.getByPlaceholder('מספר צ׳יפ');
    await numberInput.fill(`E2E${tag}3`);
    await numberInput.press('Enter');
    await issue.getByRole('button', { name: /^(הנפק צ׳יפ|שמור והנפק)$/ }).click();
    await expect(issue).toHaveCount(0);
    const r = await pool.query<{ order_item_id: string; holder_name: string }>(
      `select order_item_id, holder_name from public.chips where chip_number = $1`, [`E2E${tag}3`],
    );
    expect(r.rows[0]).toEqual({ order_item_id: repeat.itemId, holder_name: 'דנה בדיקה' });
    await expect(row.getByTestId('chip-order-stage')).toHaveText('שויך');
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

// ── Test mode (13/11/2026) ─────────────────────────────────────────────────
// The settings switch makes a secret link; with it /chip-order opens without
// Grow under a pinned "מצב בדיקה, אין חיוב" strip, the code arrives on
// WhatsApp (the Green API stub, as in portal-login-otp.spec.ts), the payment
// step is "סיים הזמנת בדיקה", and the order shows in /chips with a "בדיקה"
// badge until "מחק הזמנת בדיקה". A wrong token or no token is the closed page
// as before — no hint. The previous test-mode row is put back afterwards.
test.describe.serial('test mode', () => {
  const STUB = `http://127.0.0.1:${process.env.E2E_GREENAPI_PORT ?? 3110}`;
  const phoneDigits = `05393${String(Date.now()).slice(-5)}`;
  const phoneE164 = `+972${phoneDigits.slice(1)}`;
  const state = { link: '', orderId: '', orderNumber: 0, hadRow: false, row: null as unknown };
  const APT2 = `992${tag}2`;
  const skipState = { contact: '', orderId: '', phone: '' };

  test.beforeAll(async () => {
    const prev = await pool.query(`select value from public.app_settings where key = 'chip_orders_test_mode'`);
    state.hadRow = (prev.rowCount ?? 0) > 0;
    state.row = prev.rows[0]?.value ?? null;
  });

  test.afterAll(async () => {
    if (state.orderId) await pool.query(`delete from public.chip_orders where id = $1 and is_test`, [state.orderId]);
    if (skipState.orderId) {
      const chips = await pool.query<{ id: string }>(
        `select c.id from public.chips c join public.chip_order_items i on i.id = c.order_item_id where i.order_id = $1`,
        [skipState.orderId],
      );
      for (const { id } of chips.rows) {
        await pool.query(`delete from public.chip_events where chip_id = $1`, [id]);
        await pool.query(`delete from public.chips where id = $1`, [id]);
      }
      await pool.query(`delete from public.chip_orders where id = $1 and is_test`, [skipState.orderId]);
    }
    if (skipState.contact) await pool.query(`delete from public.contacts where id = $1`, [skipState.contact]);
    await pool.query(`delete from public.portal_otp_codes where phone_e164 = $1`, [phoneE164]);
    if (state.hadRow) {
      await pool.query(`update public.app_settings set value = $1::jsonb where key = 'chip_orders_test_mode'`, [JSON.stringify(state.row)]);
    } else {
      await pool.query(`delete from public.app_settings where key = 'chip_orders_test_mode'`);
    }
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

  test('with the link: the whole order, the code on WhatsApp, "סיים הזמנת בדיקה", the tracking page; messages say [בדיקה]', async ({ browser }) => {
    await fetch(`${STUB}/__reset`, { method: 'POST' });
    const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] }, viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    const res = await page.goto(new URL(state.link).pathname + new URL(state.link).search);
    expect(res?.headers()['referrer-policy']).toBe('no-referrer');
    await expect(page.getByTestId('chip-order-test-banner')).toHaveText('מצב בדיקה, אין חיוב');
    await expect(page.getByTestId('chip-order-closed')).toHaveCount(0);

    await page.getByLabel('שם מלא').fill('בודק מצב בדיקה');
    await page.getByPlaceholder('05X-XXXXXXX').fill(phoneDigits);
    await page.getByLabel('מייל').fill('test-mode.e2e@example.test');
    await page.getByLabel('כתובת מגורים').fill('רחוב בדיקה 2');
    await page.getByRole('radio', { name: 'בעלים' }).click();
    await page.getByLabel('דירה 1').selectOption(APT);
    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: /המשך לתשלום/ }).click();

    const chatId = `${phoneE164.slice(1)}@c.us`;
    let code = '';
    await expect.poll(async () => {
      const r = await fetch(`${STUB}/__messages?chatId=${encodeURIComponent(chatId)}`);
      const { messages } = (await r.json()) as { messages: { message: string }[] };
      code = messages.at(-1)?.message.match(/(\d{6})/)?.[1] ?? '';
      return code;
    }, { timeout: 15_000 }).toMatch(/^\d{6}$/);
    await page.getByLabel('קוד אימות').fill(code);
    await page.getByRole('button', { name: 'אימות והמשך לתשלום' }).click();

    await expect(page.getByTestId('chip-order-test-step')).toBeVisible();
    await expect(page.getByTestId('chip-order-payment')).toHaveCount(0);
    await page.getByRole('button', { name: 'סיים הזמנת בדיקה' }).click();
    await page.waitForURL(/\/chip-order\/track\//);
    await expect(page.getByTestId('chip-order-track')).toContainText('שולם, בהכנה');
    await expect(page.getByTestId('chip-order-track')).toContainText('מועד היעד להכנה');
    await noSideScroll(page);

    const row = (await pool.query<{ id: string; order_number: number; is_test: boolean; status: string; grow_process_id: string | null }>(
      `select id, order_number, is_test, status, grow_process_id from public.chip_orders where phone_e164 = $1 order by created_at desc limit 1`,
      [phoneE164],
    )).rows[0]!;
    state.orderId = row.id;
    state.orderNumber = row.order_number;
    expect(row).toMatchObject({ is_test: true, status: 'paid', grow_process_id: null });
    // The "received & paid" WhatsApp goes out after the response — marked, and
    // with the due date (there is no separate "approved" message any more).
    await expect.poll(async () => {
      const r = await fetch(`${STUB}/__messages?chatId=${encodeURIComponent(chatId)}`);
      const { messages } = (await r.json()) as { messages: { message: string }[] };
      const last = messages.at(-1)?.message ?? '';
      return last.startsWith('[בדיקה]') && last.includes('מועד היעד להכנה');
    }, { timeout: 20_000 }).toBe(true);
    await ctx.close();
  });

  test('/chips: the test order has the badge, is not counted, hides on demand, and "מחק הזמנת בדיקה" (in its section) removes it', async ({ page }) => {
    await page.goto('/chips?view=orders');
    const row = page.getByTestId('chip-orders-table').getByTestId('chip-order-row').filter({ hasText: 'בודק מצב בדיקה' });
    await expect(row).toBeVisible();
    await expect(row.getByTestId('chip-order-test-badge')).toHaveText('בדיקה');
    // Never counted: the tab's number is the open REAL rows only.
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
    const issue = page.getByRole('dialog').filter({ hasText: 'הנפקת צ׳יפ' });
    const section = issue.getByTestId('chip-order-section');
    await expect(section).toContainText('בדיקה, ללא חיוב');
    await section.getByTestId('chip-order-delete-test').click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'מחק הזמנת בדיקה' }).click();
    await expect(section).toHaveCount(0);
    await issue.getByRole('button', { name: 'סגור' }).last().click();
    await expect(row).toHaveCount(0);
    expect((await pool.query(`select 1 from public.chip_orders where id = $1`, [state.orderId])).rowCount).toBe(0);
    state.orderId = '';
  });

  // "דלג על אימות (מצב בדיקה)" (13/11/2026): with SMS credit at 0 no code
  // reached Ronen's phone, and "שליחת הקוד בוואטסאפ במקום" always met the
  // 45-second resend cooldown the failed SMS had started (429 → the button
  // vanished). The send is played by page.route here (a failing SMS, then that
  // cooldown), the skip and everything after it are real.
  test('a failed send keeps the WhatsApp button through the cooldown; "דלג על אימות" → finish → a row in "הזמנות" → the issue window with the prefilled block and "פרטי הזמנה" → chip → "שויך" → in "צ׳יפים" → ready → collected → the row leaves', async ({ browser, page }) => {
    const skipPhone = `05394${String(Date.now()).slice(-5)}`;
    const skipE164 = `+972${skipPhone.slice(1)}`;
    const c = await pool.query<{ id: string }>(`insert into public.contacts (apartment_number) values ($1) returning id`, [APT2]);
    skipState.contact = c.rows[0]!.id;
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
    await pub.getByLabel('שם מלא').fill('בודק דילוג');
    await pub.getByPlaceholder('05X-XXXXXXX').fill(skipPhone);
    await pub.getByLabel('מייל').fill('skip.e2e@example.test');
    await pub.getByLabel('כתובת מגורים').fill('רחוב בדיקה 3');
    await pub.getByRole('radio', { name: 'בעלים' }).click();
    await pub.getByLabel('דירה 1').selectOption(APT2);
    await pub.getByRole('checkbox').check();
    await pub.getByRole('button', { name: /המשך לתשלום/ }).click();

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
    await expect(pub.getByTestId('chip-order-test-step')).toBeVisible();
    await pub.getByRole('button', { name: 'סיים הזמנת בדיקה' }).click();
    await pub.waitForURL(/\/chip-order\/track\//);
    await expect(pub.getByTestId('chip-order-track')).toContainText('שולם, בהכנה');
    await ctx.close();

    const row = (await pool.query<{ id: string; order_number: number; is_test: boolean; phone_verified: boolean; status: string }>(
      `select id, order_number, is_test, phone_verified, status from public.chip_orders where phone_e164 = $1`, [skipE164],
    )).rows;
    expect(row).toHaveLength(1);
    skipState.orderId = row[0]!.id;
    expect(row[0]).toMatchObject({ is_test: true, phone_verified: false, status: 'paid' });
    // No code was issued (the request was played), none consumed by the skip.
    expect((await pool.query(`select 1 from public.portal_otp_codes where phone_e164 = $1`, [skipE164])).rowCount).toBe(0);

    // Staff: the order is a row in /chips → "הזמנות", badged.
    await page.goto('/chips');
    await page.getByRole('tab', { name: /הזמנות/ }).click();
    const listRow = page.getByTestId('chip-orders-table').getByTestId('chip-order-row').filter({ hasText: APT2 });
    await expect(listRow).toBeVisible();
    await expect(listRow).toContainText('בודק דילוג');
    await expect(listRow.getByTestId('chip-order-test-badge')).toHaveText('בדיקה');
    await expect(listRow.getByTestId('chip-order-phone-unverified')).toHaveText('טלפון לא אומת');
    await expect(listRow.getByTestId('chip-order-stage')).toHaveText('ממתין לשיוך');

    // The row opens the ISSUE window: the apartment, the prefilled block, "פרטי הזמנה".
    await listRow.click();
    const issue = page.getByRole('dialog').filter({ hasText: 'הנפקת צ׳יפ' });
    await expect(issue.getByText(`דירה ${APT2}`)).toBeVisible();
    const block = issue.getByTestId('chip-holder-block');
    await expect(block).toHaveCount(1);
    await expect(block.getByLabel('שם בעל הצ׳יפ')).toHaveValue('בודק דילוג');
    await expect(block.getByLabel('טלפון בעל הצ׳יפ')).toHaveValue(skipPhone);
    const section = block.getByTestId('chip-order-section');
    await expect(section).toContainText('פרטי הזמנה');
    await expect(section).toContainText('skip.e2e@example.test');
    await expect(section).toContainText('בדיקה, ללא חיוב');
    await expect(section.getByTestId('chip-order-phone-unverified')).toBeVisible();

    // Chip number → "הוסף" → save.
    await block.getByPlaceholder('מספר צ׳יפ').fill(`E2S${tag}1`);
    await block.getByRole('button', { name: 'הוסף', exact: true }).click();
    await issue.getByRole('button', { name: /^(הנפק צ׳יפ|שמור והנפק)$/ }).click();
    await expect(issue).toHaveCount(0);
    await expect(listRow.getByTestId('chip-order-stage')).toHaveText('שויך');
    // Nothing was written to the tenants list.
    const contact = await pool.query(`select owner_name, owner_phone, owner_email from public.contacts where id = $1`, [skipState.contact]);
    expect(contact.rows[0]).toEqual({ owner_name: null, owner_phone: null, owner_email: null });

    // The chip is in the "צ׳יפים" tab.
    await page.getByRole('tab', { name: /צ׳יפים/ }).click();
    await page.getByPlaceholder('חפש לפי מספר צ׳יפ, מספר דירה או שם דייר').fill(`E2S${tag}1`);
    await expect(page.getByText(`E2S${tag}1`).first()).toBeVisible();

    // Back to the row: "מוכן לאיסוף" → "נאסף" → the row leaves the tab.
    await page.getByRole('tab', { name: /הזמנות/ }).click();
    await listRow.click();
    await section.getByRole('button', { name: 'מוכן לאיסוף' }).click();
    await expect(section.getByTestId('chip-order-stage')).toHaveText('מוכן לאיסוף');
    await section.getByRole('button', { name: 'נאסף', exact: true }).click();
    await expect.poll(async () => (await pool.query(`select status from public.chip_orders where id = $1`, [skipState.orderId])).rows[0].status).toBe('collected');
    await issue.getByRole('button', { name: 'סגור' }).last().click();
    await expect(listRow).toHaveCount(0);
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
