import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { Pool } from 'pg';
import { E2E_DEBTOR_ID, loginThroughForm } from './helpers';

// "מחק לצמיתות" in /settings/users (06/10/2026): the super admin deletes a
// user for good — the account is gone from the list and the counters, cannot
// log in, its open session is dead — while a note and a reminder the user
// wrote stay, under their name. The seeded e2e-admin (a super admin) is the
// actor; the user it deletes is created here and never existed before.
//
// Rows that survive BY DESIGN (the note, the reminder, the audit row) are
// removed by their exact ids at the end, so the throwaway database does not
// collect one per run (CLAUDE.md iron rule 12).

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
pool.on('error', () => undefined);

const uniq = `e2e-udel-${Date.now()}`;
const NAME = `משתמש זמני ${uniq}`;
const EMAIL = `${uniq}@billing.local`;
const PASSWORD = 'E2e-Temp0rary!';

let userId = '';
let adminId = '';
let commentId = '';
let reminderId = '';
let tempCtx: BrowserContext | null = null;
let tempPage: Page | null = null;

test.describe.configure({ mode: 'serial' });

const managerTab = (page: Page) => page.getByRole('button', { name: /^מנהל\s*\d+$/ });
const tabCount = async (page: Page) => Number((await managerTab(page).innerText()).replace(/\D/g, ''));

test.afterAll(async () => {
  await tempCtx?.close();
  if (commentId) await pool.query(`delete from public.comments where id = $1`, [commentId]);
  if (reminderId) await pool.query(`delete from public.user_reminders where id = $1`, [reminderId]);
  if (userId) {
    const audit = await pool.query<{ id: string }>(`select id from public.audit_log where entity_type = 'user' and entity_id = $1`, [userId]);
    for (const r of audit.rows) await pool.query(`delete from public.audit_log where id = $1`, [r.id]);
    // Only if a step failed before the deletion itself ran.
    await pool.query(`delete from public.users where id = $1`, [userId]);
  }
  await pool.end();
});

test.describe('permanent deletion of a user', () => {
  test('the super admin creates the user; the user writes a note and a reminder', async ({ page, browser }) => {
    const me = (await (await page.request.get('/api/auth/me')).json()) as { user: { id: string; role: string } };
    expect(me.user.role).toBe('super_admin');
    adminId = me.user.id;

    const created = await page.request.post('/api/users', { data: { email: EMAIL, full_name: NAME, role: 'manager', password: PASSWORD } });
    expect(created.status(), await created.text()).toBe(201);
    userId = ((await created.json()) as { id: string }).id;

    const login = await loginThroughForm(browser, EMAIL, PASSWORD);
    expect(login.ok, 'the new user logs in through the form').toBe(true);
    tempCtx = login.ctx;
    tempPage = login.page;

    const note = await tempPage.request.post(`/api/debtors/${E2E_DEBTOR_ID}/comments`, { data: { content: `${uniq} הערת גבייה` } });
    expect(note.status(), await note.text()).toBe(201);
    commentId = ((await note.json()) as { id: string }).id;

    const reminder = await tempPage.request.post('/api/user-reminders', {
      data: { title: `${uniq} תזכורת`, remind_at: new Date(Date.now() + 3_600_000).toISOString(), assigned_to: adminId },
    });
    expect(reminder.status(), await reminder.text()).toBe(201);
    reminderId = ((await reminder.json()) as { reminder: { id: string } }).reminder.id;
  });

  test('the panel deletes the user for good — the list, the counters and the API agree', async ({ page }) => {
    await page.goto('/settings/users');
    const card = page.getByRole('button', { name: new RegExp(uniq) });
    await expect(card).toBeVisible();
    const managersBefore = await tabCount(page);

    await card.click();
    const panel = page.getByRole('dialog');
    await expect(panel).toBeVisible();
    // Distinct from "השבת": its own section, a filled red button.
    const deleteButton = panel.getByRole('button', { name: 'מחק לצמיתות' });
    await expect(deleteButton).toBeVisible();
    await expect(panel.getByRole('button', { name: 'השבת' })).toBeVisible();
    await deleteButton.click();

    const confirm = page.getByRole('alertdialog');
    await expect(confirm).toContainText('למחוק את המשתמש לצמיתות?');
    await expect(confirm).toContainText('בלתי הפיכה');
    await expect(confirm).toContainText('יישאר במערכת עם שמו');
    await confirm.getByRole('button', { name: 'מחק לצמיתות' }).click();

    await expect(page.getByText('המשתמש נמחק לצמיתות')).toBeVisible();
    await expect(panel).toBeHidden();
    await expect(card).toHaveCount(0);
    await expect.poll(() => tabCount(page)).toBe(managersBefore - 1);

    expect((await page.request.get(`/api/users/${userId}`)).status()).toBe(404);
    const list = (await (await page.request.get('/api/users')).json()) as { users?: Array<{ id: string }> } | Array<{ id: string }>;
    const rows = Array.isArray(list) ? list : list.users ?? [];
    expect(rows.some((u) => u.id === userId)).toBe(false);
  });

  test('the deleted account cannot log in, and its open session is dead', async ({ browser }) => {
    expect((await tempPage!.request.get('/api/auth/me')).status()).toBe(401);
    const again = await loginThroughForm(browser, EMAIL, PASSWORD);
    expect(again.ok).toBe(false);
    await expect(again.page.getByText('שם משתמש או סיסמה שגויים')).toBeVisible();
    await again.ctx.close();
  });

  test('the note and the reminder survive, under the name', async ({ page }) => {
    const notes = (await (await page.request.get(`/api/debtors/${E2E_DEBTOR_ID}/comments`)).json()) as Array<{ id: string; author_name: string }>;
    const note = notes.find((n) => n.id === commentId);
    expect(note).toBeDefined();
    expect(note!.author_name).toBe(NAME);
    // the API never exposes author_id — the row itself holds the name and no id
    const stored = await pool.query<{ author_id: string | null; author_name: string }>(`select author_id, author_name from public.comments where id = $1`, [commentId]);
    expect(stored.rows[0]).toEqual({ author_id: null, author_name: NAME });

    const reminders = (await (await page.request.get('/api/user-reminders')).json()) as { items: Array<{ id: string; created_by: string | null; created_by_name: string | null }> };
    const reminder = reminders.items.find((r) => r.id === reminderId);
    expect(reminder).toBeDefined();
    expect(reminder!.created_by).toBeNull();
    expect(reminder!.created_by_name).toBe(NAME);

    // …and on screen: the debtor's history still names the note's author
    await page.goto('/dashboard?apt=E2E-101&open=details');
    const panel = page.getByRole('dialog');
    await expect(panel).toBeVisible();
    // the tab, not the footer's (disabled, "בקרוב") button of the same name
    await panel.getByRole('button', { name: 'היסטוריה', exact: true, disabled: false }).click();
    await expect(panel.getByText(`${uniq} הערת גבייה`)).toBeVisible();
    await expect(panel.getByText(NAME, { exact: true })).toBeVisible();
  });

  test('the super admin cannot delete their own account from the panel', async ({ page }) => {
    await page.goto('/settings/users');
    await page.getByRole('button', { name: /e2e-admin|E2E Admin/i }).first().click();
    const panel = page.getByRole('dialog');
    await expect(panel).toBeVisible();
    await expect(panel.getByRole('button', { name: 'מחק לצמיתות' })).toBeDisabled();
    await expect(panel.getByText('אי אפשר למחוק את החשבון שלך.')).toBeVisible();
  });
});
