import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { Pool } from 'pg';
import { loginThroughForm } from './helpers';

// Who may read, change and delete a user reminder (06/10/2026), through the
// real routes and in a real browser, with two users: the seeded e2e-admin
// (the creator) and a manager this file creates (user B).
//   • the list is the SESSION user's own set: a reminder the admin keeps to
//     themselves is not in B's list — not with ?involvingUser=<admin id>
//     either (the parameter that used to pick whose reminders to list) — and
//     a single GET of it is the same 404 as a missing id;
//   • B, assigned to a second reminder: reads it, marks it done (PATCH with
//     the status alone), and is refused (403) for any other field, for the
//     bin, and for anything on the admin's private reminder;
//   • on screen, B's "משותף איתי" card has "סמן כהושלם" but no bin, the panel
//     is read-only but the status, and the card's check writes the status;
//   • the creator still edits and deletes.
// Every row this file creates is removed by its exact id (iron rule 12).

test.describe.configure({ mode: 'serial' });

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
pool.on('error', () => undefined);

const uniq = `e2e-remacc-${Date.now()}`;
const NAME = `משתמש ב׳ ${uniq}`;
const EMAIL = `${uniq}@billing.local`;
const PASSWORD = 'E2e-Temp0rary!';
const PRIVATE_TITLE = `${uniq} פרטית של האדמין`;
const SHARED_TITLE = `${uniq} משותפת עם ב׳`;

let adminId = '';
let userBId = '';
let privateId = '';
let sharedId = '';
let bCtx: BrowserContext | null = null;
let bPage: Page | null = null;

const inHour = () => new Date(Date.now() + 3_600_000).toISOString();

test.afterAll(async () => {
  await bCtx?.close();
  const reminderIds = [privateId, sharedId].filter(Boolean);
  if (reminderIds.length) {
    const audit = await pool.query<{ id: string }>(
      `select id from public.audit_log where entity_type = 'reminder' and entity_id = any($1::text[])`, [reminderIds],
    );
    for (const r of audit.rows) await pool.query(`delete from public.audit_log where id = $1`, [r.id]);
    for (const id of reminderIds) await pool.query(`delete from public.user_reminders where id = $1`, [id]);
  }
  if (userBId) {
    const audit = await pool.query<{ id: string }>(
      `select id from public.audit_log where entity_type = 'user' and entity_id = $1`, [userBId],
    );
    for (const r of audit.rows) await pool.query(`delete from public.audit_log where id = $1`, [r.id]);
    await pool.query(`delete from public.users where id = $1`, [userBId]);
  }
  await pool.end();
});

const card = (page: Page, id: string) => page.locator(`[data-reminder-id="${id}"]`);

test.describe('user reminders — who may read, change and delete', () => {
  test('the admin creates a private reminder and one shared with user B; B logs in', async ({ page, browser }) => {
    const me = (await (await page.request.get('/api/auth/me')).json()) as { user: { id: string; role: string } };
    expect(me.user.role).toBe('super_admin');
    adminId = me.user.id;

    const created = await page.request.post('/api/users', { data: { email: EMAIL, full_name: NAME, role: 'manager', password: PASSWORD } });
    expect(created.status(), await created.text()).toBe(201);
    userBId = ((await created.json()) as { id: string }).id;

    const priv = await page.request.post('/api/user-reminders', { data: { title: PRIVATE_TITLE, remind_at: inHour() } });
    expect(priv.status(), await priv.text()).toBe(201);
    privateId = ((await priv.json()) as { reminder: { id: string } }).reminder.id;

    const shared = await page.request.post('/api/user-reminders', { data: { title: SHARED_TITLE, remind_at: inHour(), assigned_to: userBId } });
    expect(shared.status(), await shared.text()).toBe(201);
    sharedId = ((await shared.json()) as { reminder: { id: string } }).reminder.id;

    const login = await loginThroughForm(browser, EMAIL, PASSWORD);
    expect(login.ok, 'user B logs in').toBe(true);
    bCtx = login.ctx;
    bPage = login.page;
  });

  test('B reads only what is shared with them — whatever user id the client sends', async () => {
    const ids = async (qs: string) => {
      const res = await bPage!.request.get(`/api/user-reminders${qs}`);
      expect(res.status()).toBe(200);
      return ((await res.json()) as { items: Array<{ id: string }> }).items.map((r) => r.id);
    };
    const plain = await ids('');
    expect(plain).toContain(sharedId);
    expect(plain).not.toContain(privateId);

    // The parameter that used to choose whose reminders to list changes nothing.
    const asAdmin = await ids(`?involvingUser=${adminId}`);
    expect(asAdmin).toContain(sharedId);
    expect(asAdmin).not.toContain(privateId);
    expect(await ids(`?createdBy=${adminId}`)).not.toContain(privateId);
    expect(await ids(`?assignedTo=${adminId}`)).not.toContain(privateId);

    // A single GET of the private one is the same 404 as a missing id.
    const foreign = await bPage!.request.get(`/api/user-reminders/${privateId}`);
    expect(foreign.status()).toBe(404);
    expect(await foreign.json()).toEqual({ error: 'not_found' });
    const own = await bPage!.request.get(`/api/user-reminders/${sharedId}`);
    expect(own.status()).toBe(200);
    expect(((await own.json()) as { reminder: { id: string } }).reminder.id).toBe(sharedId);
  });

  test('B changes the status of the shared reminder and nothing else; the private one not at all', async () => {
    const patch = (id: string, data: Record<string, unknown>) =>
      bPage!.request.patch(`/api/user-reminders/${id}`, { data });

    const done = await patch(sharedId, { status: 'done' });
    expect(done.status(), await done.text()).toBe(200);
    expect(((await done.json()) as { reminder: { status: string } }).reminder.status).toBe('done');
    const back = await patch(sharedId, { status: 'pending' });
    expect(back.status()).toBe(200);

    for (const body of [
      { title: 'כותרת אחרת' },
      { status: 'done', title: 'כותרת אחרת' },
      { assigned_to: null },
      { remind_at: inHour() },
      { is_archived: true },
    ]) {
      const res = await patch(sharedId, body);
      expect(res.status(), JSON.stringify(body)).toBe(403);
      expect(await res.json()).toEqual({ error: 'forbidden' });
    }
    expect((await bPage!.request.delete(`/api/user-reminders/${sharedId}`)).status()).toBe(403);

    expect((await patch(privateId, { status: 'done' })).status()).toBe(403);
    expect((await bPage!.request.delete(`/api/user-reminders/${privateId}`)).status()).toBe(403);

    const rows = await pool.query<{ id: string; title: string; status: string; is_archived: boolean }>(
      `select id, title, status, is_archived from public.user_reminders where id = any($1::uuid[])`,
      [[privateId, sharedId]],
    );
    const byId = new Map(rows.rows.map((r) => [r.id, [r.title, r.status, r.is_archived]]));
    expect(byId.get(privateId)).toEqual([PRIVATE_TITLE, 'pending', false]);
    expect(byId.get(sharedId)).toEqual([SHARED_TITLE, 'pending', false]);
  });

  test('on screen: no bin for B, a panel that is read-only but the status, a check that writes it', async () => {
    const page = bPage!;
    await page.goto('/user-reminders');
    await page.getByRole('button', { name: /משותף איתי/ }).click();
    const shared = card(page, sharedId);
    await expect(shared).toBeVisible();
    await expect(card(page, privateId)).toHaveCount(0);

    await shared.hover();
    // exact: the card itself is a button whose name includes its actions' labels.
    await expect(shared.getByRole('button', { name: 'מחיקת תזכורת', exact: true })).toHaveCount(0);
    await expect(shared.getByRole('button', { name: 'סמן כהושלם', exact: true })).toHaveCount(1);

    // The panel: every field disabled but the status; saving needs a status change.
    await shared.click();
    const panel = page.getByRole('dialog').filter({ hasText: 'עריכת תזכורת' });
    await expect(panel).toBeVisible();
    await expect(panel.getByText('תזכורת ששותפה איתך — רק היוצר עורך אותה')).toBeVisible();
    await expect(panel.locator('#rem-title')).toBeDisabled();
    await expect(panel.locator('#rem-description')).toBeDisabled();
    await expect(panel.locator('#rem-date')).toBeDisabled();
    await expect(panel.getByText('גררו קבצים לכאן')).toHaveCount(0);
    await expect(panel.getByRole('combobox').first()).toBeEnabled();
    await expect(panel.getByRole('button', { name: 'שמור שינויים' })).toBeDisabled();
    await panel.getByLabel('סגור').click(); // the header's X (the footer has a 'סגור' button too)
    await expect(panel).toHaveCount(0);

    // The card's check: PATCH {status:'done'} and nothing else.
    const write = page.waitForResponse((r) => r.request().method() === 'PATCH' && r.url().includes(`/api/user-reminders/${sharedId}`));
    await shared.hover();
    await shared.getByRole('button', { name: 'סמן כהושלם', exact: true }).click();
    const res = await write;
    expect(res.status()).toBe(200);
    expect(res.request().postDataJSON()).toEqual({ status: 'done' });
    await expect(page.getByText('התזכורת סומנה כהושלמה')).toBeVisible();
    const row = await pool.query<{ status: string }>(`select status from public.user_reminders where id = $1`, [sharedId]);
    expect(row.rows[0].status).toBe('done');
  });

  test('the creator still edits and deletes', async ({ page }) => {
    const edit = await page.request.patch(`/api/user-reminders/${privateId}`, { data: { title: `${PRIVATE_TITLE} (נערכה)` } });
    expect(edit.status(), await edit.text()).toBe(200);
    expect((await page.request.delete(`/api/user-reminders/${sharedId}`)).status()).toBe(204);
    expect((await page.request.delete(`/api/user-reminders/${privateId}`)).status()).toBe(204);
    const rows = await pool.query<{ is_archived: boolean }>(`select is_archived from public.user_reminders where id = any($1::uuid[])`, [[privateId, sharedId]]);
    expect(rows.rows.map((r) => r.is_archived)).toEqual([true, true]);
  });
});
