import { test, expect, type Page } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';

// Chip orders (12/11/2026), in the browser:
//   · /chips keeps its chips view as the default — KPIs, the table, "הנפק צ׳יפ";
//   · the staff flow on a PAID order: approve (writes the ticked fields to the
//     tenants list) → "שייך צ׳יפים" opens the EXISTING issue window for the
//     order line → ready only once every chip is linked → collected;
//   · /chip-order is closed ("ההזמנות ייפתחו בקרוב") while Grow is not
//     configured — the CI state — and no page scrolls sideways on a phone.
// The order is seeded straight into the DB (paid = what Grow's verified
// callback produces); fixtures are numeric apartments, removed by exact ids.

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
pool.on('error', () => undefined);

const tag = String(Date.now()).slice(-6);
const APT = `992${tag}1`;
const made = { contact: '', order: '', orderNumber: 0, chips: [] as string[] };

async function noSideScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

test.beforeAll(async () => {
  const c = await pool.query<{ id: string }>(
    `insert into public.contacts (apartment_number) values ($1) returning id`,
    [APT],
  );
  made.contact = c.rows[0]!.id;
  const o = await pool.query<{ id: string; order_number: number }>(
    `insert into public.chip_orders
       (full_name, phone_e164, email, address, role, status, total, tracking_token, paid_at,
        grow_process_id, grow_transaction_id, grow_asmachta)
     values ('דנה בדיקה', '+972539300001', 'dana.e2e@example.test', 'רחוב בדיקה 1', 'owner', 'paid', 170, $1, now(),
             $2, $3, 'e2e')
     returning id, order_number`,
    [randomBytes(32).toString('base64url'), `e2e-p-${tag}`, `e2e-t-${tag}`],
  );
  made.order = o.rows[0]!.id;
  made.orderNumber = o.rows[0]!.order_number;
  await pool.query(
    `insert into public.chip_order_items
       (order_id, contact_id, apartment_number, chips_count, unit_price, threshold, price_above, line_total, match_status)
     values ($1, $2, $3, 3, 50, 2, 70, 170, 'unassigned')`,
    [made.order, made.contact, APT],
  );
});

test.afterAll(async () => {
  const chips = await pool.query<{ id: string }>(
    `select c.id from public.chips c join public.chip_order_items i on i.id = c.order_item_id where i.order_id = $1`,
    [made.order],
  );
  for (const { id } of chips.rows) {
    await pool.query(`delete from public.chip_events where chip_id = $1`, [id]);
    await pool.query(`delete from public.chips where id = $1`, [id]);
  }
  if (made.order) await pool.query(`delete from public.chip_orders where id = $1`, [made.order]);
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

test('staff flow: approve → assign through the issue window → ready → collected', async ({ page }) => {
  await page.goto('/chips?view=orders');
  const row = page.getByTestId('chip-orders-table').getByRole('button').filter({ hasText: String(made.orderNumber) });
  await expect(row).toBeVisible();
  await row.click();

  const sheet = page.getByRole('dialog').filter({ hasText: `הזמנת צ׳יפים ${made.orderNumber}` });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText('לשיוך', { exact: true })).toBeVisible();

  // Nothing is ticked by default; the phone warns that it opens the portal.
  for (const f of ['שם', 'טלפון', 'מייל']) {
    const box = sheet.getByRole('checkbox', { name: `לכתוב ${f} לדירה ${APT}` });
    await expect(box).not.toBeChecked();
    await box.click();
  }
  await expect(sheet.getByText('המספר הזה נכנס לפורטל הדירה')).toBeVisible();
  await sheet.getByRole('button', { name: 'אשר', exact: true }).click();
  await expect(sheet.getByText('מאושר, בהכנה').first()).toBeVisible();
  const contact = await pool.query(`select owner_name, owner_phone, owner_email from public.contacts where id = $1`, [made.contact]);
  expect(contact.rows[0]).toEqual({ owner_name: 'דנה בדיקה', owner_phone: '0539300001', owner_email: 'dana.e2e@example.test' });
  // Both channels were attempted for "approved", each on its own.
  await expect.poll(async () => (await pool.query(
    `select count(distinct channel)::int as n from public.chip_order_notifications where order_id = $1 and kind = 'approved'`,
    [made.order],
  )).rows[0].n, { timeout: 30_000 }).toBe(2);

  // Ready is refused until every chip is linked.
  await expect(sheet.getByRole('button', { name: 'מוכן לאיסוף' })).toBeDisabled();

  await sheet.getByRole('button', { name: /שייך צ׳יפים \(3\)/ }).click();
  const issue = page.getByRole('dialog').filter({ hasText: 'הנפקת צ׳יפ' });
  await expect(issue.getByTestId('issue-order-banner')).toContainText(`שיוך להזמנה ${made.orderNumber}`);
  const numberInput = issue.getByPlaceholder('מספר צ׳יפ').first();
  for (const n of [`E2E${tag}1`, `E2E${tag}2`, `E2E${tag}3`]) {
    await numberInput.fill(n);
    await numberInput.press('Enter');
  }
  await issue.getByRole('button', { name: /הנפק/ }).click();

  // Back on the order, with the three chips linked.
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText('צ׳יפים פעילים ששויכו: 3 מתוך 3')).toBeVisible();
  const linked = await pool.query(
    `select count(*)::int as n from public.chips c join public.chip_order_items i on i.id = c.order_item_id where i.order_id = $1`,
    [made.order],
  );
  expect(linked.rows[0].n).toBe(3);

  await sheet.getByRole('button', { name: 'מוכן לאיסוף' }).click();
  await expect(sheet.getByRole('button', { name: 'נאסף', exact: true })).toBeVisible();
  await sheet.getByRole('button', { name: 'נאסף', exact: true }).click();
  await expect.poll(async () => (await pool.query(`select status from public.chip_orders where id = $1`, [made.order])).rows[0].status).toBe('collected');
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
