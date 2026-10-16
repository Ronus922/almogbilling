import { test, expect, type Browser, type BrowserContext } from '@playwright/test';
import { Pool } from 'pg';

// The portal by ROLE and the entry warning (03/10/2026), end to end on the
// db/seed/e2e.sql fixtures: a tenant (E2E-T) and an operator (E2E-O) linked
// through their cards; the "טלפונים חסומים" screen; and the apartment card's
// "אותו אדם?" when a phone typed in is registered elsewhere under another name.
//
// The apartments E2E-X1..X4, the debtor of E2E-X4 and the phone +972509999991
// exist only in this file; they are removed by those exact values (iron rule 12).

test.use({ storageState: { cookies: [], origins: [] } });

const STORAGE_STATE = 'e2e/.auth/state.json';
const X_PHONE = '+972509999991';
const X_APTS = ['E2E-X1', 'E2E-X2', 'E2E-X3', 'E2E-X4'];
const X_DEBTOR = '00000000-0000-4000-8000-0000000e2ef4';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
pool.on('error', () => undefined);

async function cleanup() {
  await pool.query(`delete from public.debtors where id = $1`, [X_DEBTOR]);
  await pool.query(`delete from public.portal_phone_entry_flags where phone_e164 = $1`, [X_PHONE]);
  await pool.query(`delete from public.portal_identity_approvals where phone_e164 = $1`, [X_PHONE]);
  await pool.query(`delete from public.contacts where apartment_number = any($1::text[])`, [X_APTS]);
}

test.beforeAll(async () => {
  await cleanup();
  // One phone, two apartments, two unrelated names → blocked.
  await pool.query(
    `insert into public.contacts (apartment_number, owner_name, owner_phone, source) values
       ('E2E-X1', 'ראשון E2E', $1, 'manual'),
       ('E2E-X2', 'שני E2E', $1, 'manual'),
       ('E2E-X3', 'שלישי E2E', null, 'manual'),
       ('E2E-X4', 'רביעי E2E', null, 'manual')`,
    [X_PHONE],
  );
  // A debtor row for E2E-X4 — the dashboard's panel edits ITS card's phones.
  await pool.query(
    `insert into public.debtors (id, apartment_number, owner_name, total_debt, is_archived, contact_id)
     select $1, 'E2E-X4', 'רביעי E2E', 100, false, id from public.contacts where apartment_number = 'E2E-X4'`,
    [X_DEBTOR],
  );
});
test.afterAll(async () => {
  await cleanup();
  await pool.end();
});

async function resident(browser: Browser, token: string): Promise<BrowserContext> {
  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  await ctx.addCookies([{ name: 'portal_session', value: token, domain: 'localhost', path: '/' }]);
  return ctx;
}

for (const r of [
  { token: 'e2e-tenant-t', name: 'טל שוכרת E2E', apt: 'E2E-T', role: 'שוכר', debt: '₪500' },
  { token: 'e2e-operator-o', name: 'עומר מפעיל E2E', apt: 'E2E-O', role: 'מפעיל', debt: '₪0' },
]) {
  test(`a ${r.role} sees the building, the apartment debt with a role tag, and may report`, async ({ browser }) => {
    const ctx = await resident(browser, r.token);
    const page = await ctx.newPage();
    await page.goto('/portal?tab=acc');
    // the header: the same name the identity gives everywhere, the role beside the apartment
    await expect(page.locator('.me .nm')).toContainText(r.name);
    await expect(page.locator('.me .nm')).toContainText(`דירה ${r.apt} · ${r.role}`);
    const acc = page.locator('#t-acc');
    await expect(acc.locator(`[data-role]`)).toHaveText(r.role);
    await expect(acc).toContainText(r.debt);
    await expect(acc).not.toContainText('CANARY');
    // the building's figures are open to every role
    expect((await ctx.request.get('/api/portal/finance/months')).status()).toBe(200);
    // and the fault report
    await page.goto('/portal/report');
    await expect(page.getByRole('heading', { name: 'דיווח על תקלה' })).toBeVisible();
    await ctx.close();
  });
}

test('a blocked phone shows on "טלפונים חסומים" with its classification and the "אדם אחד" button', async ({ browser }) => {
  const ctx = await browser.newContext({ storageState: STORAGE_STATE });
  const page = await ctx.newPage();
  await page.goto('/admin/portal-blocked');
  const card = page.locator(`[data-blocked-phone="${X_PHONE}"]`);
  await expect(card).toBeVisible();
  await expect(card.locator('[data-category]')).toHaveText('שמות ללא קשר — חשד לטעות הזנה');
  await expect(card.getByRole('button', { name: 'אדם אחד' })).toBeEnabled();
  await expect(card).toContainText('דירה E2E-X1');
  await expect(card).toContainText('דירה E2E-X2');
  await ctx.close();
});

test('"ערוך שם" on an approved identity updates the display name in place', async ({ browser }) => {
  const phone = '+972508888881';
  const apts = ['E2E-RN1', 'E2E-RN2'];
  const cleanupRename = async () => {
    await pool.query(`delete from public.portal_identity_approvals where phone_e164 = $1`, [phone]);
    await pool.query(`delete from public.contacts where apartment_number = any($1::text[])`, [apts]);
  };
  await cleanupRename();
  await pool.query(
    `insert into public.contacts (apartment_number, owner_name, owner_phone, source) values
       ('E2E-RN1', 'חברה לרישום בדיקה', $1, 'manual'),
       ('E2E-RN2', 'שם רישום בדיקה', $1, 'manual')`,
    [phone],
  );
  const approval = await pool.query<{ id: string }>(
    `insert into public.portal_identity_approvals
       (phone_e164, status, display_name, names, request_source, requested_by, decided_by, decided_at)
     select $1, 'approved', 'שם ישן E2E', array['חברה לרישום בדיקה', 'שם רישום בדיקה'], 'blocked_screen', id, id, now()
       from public.users where email = 'e2e-admin@billing.local'
     returning id`,
    [phone],
  );
  const approvalId = approval.rows[0]!.id;
  await pool.query(
    `insert into public.portal_identity_apartments (approval_id, apartment_number, relation) values
       ($1, 'E2E-RN1', 'company_authorized'), ($1, 'E2E-RN2', 'personal')`,
    [approvalId],
  );

  try {
    const ctx = await browser.newContext({ storageState: STORAGE_STATE });
    const page = await ctx.newPage();
    await page.goto('/contacts');
    const row = page.locator(`[data-approved-phone="${phone}"]`);
    await expect(row).toContainText('שם ישן E2E');
    await row.getByRole('button', { name: 'ערוך שם' }).click();
    const dialog = page.getByRole('dialog').filter({ hasText: 'עריכת שם תצוגה' });
    await expect(dialog).toBeVisible();
    await dialog.locator('#identity-name-input').fill('שם מעודכן E2E');
    await dialog.getByRole('button', { name: 'שמור' }).click();
    await expect(dialog).toBeHidden();
    await expect(row).toContainText('שם מעודכן E2E');
    await expect(row).not.toContainText('שם ישן E2E');
    await ctx.close();

    const saved = await pool.query<{ display_name: string }>(
      `select display_name from public.portal_identity_approvals where id = $1`, [approvalId]);
    expect(saved.rows[0]?.display_name).toBe('שם מעודכן E2E');
    const audit = await pool.query(
      `select 1 from public.audit_log where action = 'portal_identity_display_name_changed' and entity_id = $1`, [phone]);
    expect(audit.rowCount).toBe(1);
  } finally {
    await cleanupRename();
  }
});

test('the apartment card asks "אותו אדם?" — cancel saves nothing, "no" saves and flags', async ({ browser }) => {
  const ctx = await browser.newContext({ storageState: STORAGE_STATE });
  const page = await ctx.newPage();
  const ownerPhone = async () =>
    (await pool.query<{ owner_phone: string | null }>(
      `select owner_phone from public.contacts where apartment_number = 'E2E-X3'`)).rows[0]?.owner_phone ?? null;

  await page.goto('/contacts?apt=E2E-X3');
  const phone = page.locator('#owner-phone');
  await expect(phone).toBeVisible();
  await phone.fill('050-999-9991');
  await page.getByRole('button', { name: 'שמור שינויים' }).click();

  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('הטלפון הזה רשום אצל');
  await expect(dialog).toContainText('ראשון E2E בדירה E2E-X1');
  await expect(dialog).toContainText('אותו אדם?');
  await dialog.getByRole('button', { name: 'ביטול' }).click();
  await expect(dialog).toBeHidden();
  expect(await ownerPhone()).toBeNull();

  await page.getByRole('button', { name: 'שמור שינויים' }).click();
  await expect(dialog).toContainText('אותו אדם?');
  await dialog.getByRole('button', { name: 'לא, אדם אחר' }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(ownerPhone).not.toBeNull();
  const flags = await pool.query(`select 1 from public.portal_phone_entry_flags where phone_e164 = $1 and apartment_number = 'E2E-X3'`, [X_PHONE]);
  expect(flags.rowCount).toBe(1);
  await ctx.close();
});

test('the debtor panel asks the same "אותו אדם?" — cancel saves nothing, "no" saves and flags', async ({ browser }) => {
  const ctx = await browser.newContext({ storageState: STORAGE_STATE });
  const page = await ctx.newPage();
  const ownerPhone = async () =>
    (await pool.query<{ owner_phone: string | null }>(
      `select owner_phone from public.contacts where apartment_number = 'E2E-X4'`)).rows[0]?.owner_phone ?? null;

  await page.goto('/dashboard?apt=E2E-X4&open=details');
  const panel = page.getByRole('dialog').filter({ hasText: 'רביעי E2E' });
  await expect(panel).toBeVisible({ timeout: 15_000 });
  await panel.locator('button[title="לחצו לעריכה"]').first().click();   // טלפון בעלים

  const edit = page.getByRole('dialog').filter({ hasText: 'עריכת טלפון בעלים' });
  await edit.locator('#phone-input').fill('050-999-9991');
  await edit.getByRole('button', { name: 'שמור' }).click();

  const ask = page.getByRole('alertdialog');
  await expect(ask).toContainText('הטלפון הזה רשום אצל');
  await expect(ask).toContainText('ראשון E2E בדירה E2E-X1');
  await expect(ask).toContainText('אותו אדם?');
  await ask.getByRole('button', { name: 'ביטול' }).click();
  await expect(ask).toBeHidden();
  await expect(edit).toBeVisible();                       // back to editing, the number still typed
  await expect(edit.locator('#phone-input')).toHaveValue(/999/);
  expect(await ownerPhone()).toBeNull();

  await edit.getByRole('button', { name: 'שמור' }).click();
  await expect(ask).toContainText('אותו אדם?');
  await ask.getByRole('button', { name: 'לא, אדם אחר' }).click();
  await expect(ask).toBeHidden();
  await expect(edit).toBeHidden();
  await expect.poll(ownerPhone).not.toBeNull();
  const flags = await pool.query(`select 1 from public.portal_phone_entry_flags where phone_e164 = $1 and apartment_number = 'E2E-X4'`, [X_PHONE]);
  expect(flags.rowCount).toBe(1);
  await ctx.close();
});
