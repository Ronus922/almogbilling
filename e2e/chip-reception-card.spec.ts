import { test, expect, type Browser, type BrowserContext, type Page, type Locator } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { Pool } from 'pg';

// "אשראי" at the reception (26/11/2026) — the card payment of the issue window
// without an order, what CI can show WITHOUT PayPlus (the CI stack has no
// PayPlus values; the real sandbox flow is run by hand):
//   · an admin is drawn the "אשראי" option — disabled, with its reason ("יופעל
//     לאחר חיבור הסליקה"), no card field anywhere — and the session route
//     answers 403 with its own Hebrew reason, real and test alike;
//   · a manager who may issue chips (chips:edit) is not drawn the option at
//     all, and the session and status routes refuse it (admin only, by role);
//   · the guard has no way in: no /chips, and the reception routes refuse it.
// Users get a session row in the DB (the cookie holds the raw token, the table
// its SHA-256) — no form login. Fixtures are removed by their exact ids.

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
pool.on('error', () => undefined);

const tag = String(Date.now()).slice(-6);
const APT = `992${tag}`;
const made = { contact: '', users: [] as string[], sessions: [] as string[] };
const people: Record<'admin' | 'manager' | 'guard', string> = {} as never;
const contexts: BrowserContext[] = [];

async function pageAs(browser: Browser, userId: string): Promise<Page> {
  const raw = randomBytes(32).toString('base64url');
  const sid = createHash('sha256').update(raw).digest('hex');
  await pool.query(
    `insert into public.sessions (id, user_id, expires_at, remember) values ($1, $2, now() + interval '3 hours', false)`,
    [sid, userId],
  );
  made.sessions.push(sid); // removed by this exact id at the end
  const ctx = await browser.newContext({
    storageState: { cookies: [{ name: 'almog_sid', value: raw, domain: 'localhost', path: '/', httpOnly: true, secure: true, sameSite: 'Lax', expires: -1 }], origins: [] },
  });
  contexts.push(ctx);
  return ctx.newPage();
}

function issueWindow(page: Page): Locator {
  return page.getByRole('dialog').filter({ hasText: 'הנפקת צ׳יפ' });
}

/** "הנפק צ׳יפ" → the apartment → one new number: the payment of the new chips shows. */
async function openWithOneNewChip(page: Page): Promise<Locator> {
  await page.goto('/chips');
  await page.getByRole('button', { name: 'הנפק צ׳יפ' }).click();
  const issue = issueWindow(page);
  await issue.getByText('בחר דירה או יחידה…').click();
  await page.getByPlaceholder('מספר דירה או שם דייר…').fill(APT);
  await page.locator('[data-slot="popover-content"]').getByRole('button').filter({ hasText: APT }).first().click();
  const block = issue.getByTestId('chip-holder-block').first();
  const input = block.getByLabel(/^מספר צ׳יפ/);
  await input.click();
  await input.fill(`RC${tag}1`);
  await input.press('Enter');
  await expect(block.getByText(`RC${tag}1`, { exact: true })).toBeVisible();
  return issue.getByTestId('chip-reception-payment');
}

const cardBody = (test: boolean) => ({
  contact_id: made.contact, new_chips: 1, test, role: 'owner', orderer: { name: 'בדיקת אשראי' },
});

test.beforeAll(async () => {
  for (const role of ['admin', 'manager', 'guard'] as const) {
    const username = `rc-${role}-${tag}`;
    const u = await pool.query<{ id: string }>(
      `insert into public.users (username, email, password_hash, full_name, role, is_active) values ($1, $2, 'x', $3, $4, true) returning id`,
      [username, role === 'guard' ? null : `${username}@billing.local`, `אשראי ${role}`, role],
    );
    made.users.push(u.rows[0]!.id);
    people[role] = u.rows[0]!.id;
  }
  // The manager may issue chips (and see the module) — and is still not an admin.
  for (const mod of ['chips', 'dashboard']) {
    await pool.query(`insert into public.user_permissions (user_id, module, can_view, can_edit) values ($1, $2, true, true)`, [people.manager, mod]);
  }
  const c = await pool.query<{ id: string }>(
    `insert into public.contacts (apartment_number, owner_name, owner_phone) values ($1, 'בעלים רשום', '0539300099') returning id`, [APT]);
  made.contact = c.rows[0]!.id;
});

test.afterAll(async () => {
  for (const c of contexts) await c.close().catch(() => undefined);
  // Nothing here issues a chip or makes an order; the contact is removed by its id.
  await pool.query(`delete from public.contacts where id = $1`, [made.contact]);
  for (const sid of made.sessions) await pool.query(`delete from public.sessions where id = $1`, [sid]);
  for (const id of made.users) {
    await pool.query(`delete from public.auth_rate_limits where bucket = $1`, [`chip-reception:card-session:user:${id}`]);
    await pool.query(`delete from public.user_permissions where user_id = $1`, [id]);
    await pool.query(`delete from public.users where id = $1`, [id]);
  }
  await pool.end();
});

test.describe.serial('"אשראי" at the reception, without PayPlus', () => {
  test('admin: the option is drawn disabled with its reason, no card field opens, and the session route says why', async ({ browser }) => {
    const page = await pageAs(browser, people.admin);
    const ctx = await (await page.request.get('/api/chips/reception')).json() as { card_option?: boolean; card_live?: boolean; card_test?: boolean };
    expect(ctx.card_option).toBe(true);
    test.skip(Boolean(ctx.card_live || ctx.card_test), 'PayPlus is configured in this environment — the real flow is checked by hand');

    const pay = await openWithOneNewChip(page);
    const card = pay.getByTestId('chip-pay-card');
    await expect(card).toBeDisabled();
    await expect(card).toContainText('אשראי');
    await expect(card).toContainText('יופעל לאחר חיבור הסליקה');
    await expect(pay.getByRole('radio')).toHaveText([/^אשראי/, /^מזומן/, /^העברה בנקאית/, /^ללא חיוב/]);
    // No card part, and no processor frame, anywhere in the window.
    await expect(page.getByTestId('chip-reception-card')).toHaveCount(0);
    await expect(page.locator('iframe')).toHaveCount(0);

    for (const testMode of [false, true]) {
      const r = await page.request.post('/api/chips/reception/card', { data: cardBody(testMode) });
      expect(r.status(), `test: ${testMode}`).toBe(403);
      expect((await r.json()).error).toBe(testMode ? 'סביבת הבדיקות של PayPlus אינה מוגדרת בשרת' : 'תשלום באשראי אמיתי אינו פעיל עדיין — אפשר לנסות במצב בדיקה');
    }
  });

  test('a manager who may issue chips is not drawn "אשראי", and the card routes refuse it', async ({ browser }) => {
    const page = await pageAs(browser, people.manager);
    const ctx = await (await page.request.get('/api/chips/reception')).json() as { card_option?: boolean; card_live?: boolean; card_test?: boolean };
    expect(ctx).toMatchObject({ card_option: false, card_live: false, card_test: false });

    const pay = await openWithOneNewChip(page);
    await expect(pay.getByTestId('chip-pay-card')).toHaveCount(0);
    await expect(pay.getByRole('radio')).toHaveText([/^מזומן/, /^העברה בנקאית/, /^ללא חיוב/]);

    expect((await page.request.post('/api/chips/reception/card', { data: cardBody(true) })).status()).toBe(403);
    expect((await page.request.post('/api/chips/reception/card/status', { data: { token: 'x'.repeat(43) } })).status()).toBe(403);
  });

  test('the guard has no way in: no /chips, and the reception routes refuse it', async ({ browser }) => {
    const page = await pageAs(browser, people.guard);
    await page.goto('/chips');
    await expect(page).not.toHaveURL(/\/chips(?:\?|$)/);
    expect((await page.request.get('/api/chips/reception')).status()).toBe(403);
    expect((await page.request.post('/api/chips/reception/card', { data: cardBody(true) })).status()).toBe(403);
    expect((await page.request.post('/api/chips/reception/card/status', { data: { token: 'x'.repeat(43) } })).status()).toBe(403);
  });
});
