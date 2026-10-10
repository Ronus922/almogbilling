import { test, expect, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { Pool } from 'pg';
import { loginThroughForm } from './helpers';

// Roles on /settings/users (10/10/2026), driven as a real ADMIN in the browser:
//   • "צור משתמש" opens with NO role chosen — the form cannot be sent until
//     one is, and a maintenance worker made through it is saved as
//     maintenance (the 09/10 user was meant to be one and arrived a manager);
//   • the admin moves a manager to "עובד אחזקה" and on to "עובד ניקיון" from
//     the panel — both save (until 10/10 every move to a worker role failed
//     with "תפקיד לא תקין"), and each change is in the audit log: who, from →
//     to, when;
//   • the admin opening another admin, the super admin, or their own row gets
//     a clear notice and a read-only panel — and the route agrees (403).
// The seeded e2e-admin (a super admin) creates the fixtures; every row made
// here is removed by its exact id at the end (CLAUDE.md iron rule 12).

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
pool.on('error', () => undefined);

const uniq = `e2e-role-${Date.now()}`;
const PASSWORD = 'E2e-Temp0rary!';
const ADMIN_EMAIL = `${uniq}-admin@billing.local`;
const ADMIN_NAME = `אדמין זמני ${uniq}`;
const OTHER_ADMIN_NAME = `אדמין אחר ${uniq}`;
const MANAGER_NAME = `מנהל זמני ${uniq}`;
const NEW_WORKER_NAME = `עובד אחזקה חדש ${uniq}`;
const NEW_WORKER_EMAIL = `${uniq}-worker@billing.local`;

let superId = '';
let superName = '';
let adminId = '';
let otherAdminId = '';
let managerId = '';
let newWorkerId = '';
let adminCtx: BrowserContext | null = null;
let adminPage: Page | null = null;

test.describe.configure({ mode: 'serial' });

test.afterAll(async () => {
  await adminCtx?.close();
  const users = [adminId, otherAdminId, managerId, newWorkerId].filter(Boolean);
  const audit = await pool.query<{ id: string }>(
    `select id from public.audit_log where entity_id = any($1::text[]) or actor_user_id = any($2::uuid[])`,
    [users, users],
  );
  for (const r of audit.rows) await pool.query(`delete from public.audit_log where id = $1`, [r.id]);
  for (const id of users) await pool.query(`delete from public.users where id = $1`, [id]);
  await pool.end();
});

const roleOf = async (id: string) =>
  (await pool.query<{ role: string }>(`select role from public.users where id = $1`, [id])).rows[0]?.role;

/** Open a user's side panel from the list (the card is a button named after the user). */
async function openUser(page: Page, name: string): Promise<Locator> {
  await page.goto('/settings/users');
  await page.getByRole('button', { name: new RegExp(name) }).click();
  const panel = page.getByRole('dialog');
  await expect(panel).toBeVisible();
  await expect(panel.locator('#user-fullname')).toBeVisible();
  return panel;
}

test.describe('roles on /settings/users — as an admin', () => {
  test('the super admin creates the fixtures: an admin, another admin, a manager', async ({ page }) => {
    const me = (await (await page.request.get('/api/auth/me')).json()) as { user: { id: string; role: string; full_name: string } };
    expect(me.user.role).toBe('super_admin');
    superId = me.user.id;
    superName = me.user.full_name;

    const make = async (data: Record<string, string>) => {
      const res = await page.request.post('/api/users', { data });
      expect(res.status(), await res.text()).toBe(201);
      return ((await res.json()) as { id: string }).id;
    };
    adminId = await make({ email: ADMIN_EMAIL, full_name: ADMIN_NAME, role: 'admin', password: PASSWORD });
    otherAdminId = await make({ email: `${uniq}-admin2@billing.local`, full_name: OTHER_ADMIN_NAME, role: 'admin', password: PASSWORD });
    managerId = await make({ email: `${uniq}-mgr@billing.local`, full_name: MANAGER_NAME, role: 'manager', password: PASSWORD });

    const login = await loginThroughForm(page.context().browser()!, ADMIN_EMAIL, PASSWORD);
    expect(login.ok, 'the temp admin logs in').toBe(true);
    adminCtx = login.ctx;
    adminPage = login.page;
  });

  test('"צור משתמש": no role until one is chosen — and a maintenance worker is saved as maintenance', async () => {
    const page = adminPage!;
    await page.goto('/settings/users');
    await page.getByRole('button', { name: 'צור משתמש' }).click();
    const panel = page.getByRole('dialog');
    await expect(panel.getByRole('heading', { name: 'צור משתמש' })).toBeVisible();

    const roleCards = panel.locator('button[aria-pressed]');
    await expect(roleCards).toHaveCount(4); // an admin: manager, viewer, cleaner, maintenance
    await expect(panel.locator('button[aria-pressed="true"]')).toHaveCount(0);
    await expect(panel.getByText('בחר תפקיד — אין ברירת מחדל')).toBeVisible();

    await panel.locator('#invite-name').fill(NEW_WORKER_NAME);
    await panel.locator('#invite-email').fill(NEW_WORKER_EMAIL);
    await panel.locator('#invite-password').fill(PASSWORD);
    const submit = panel.getByRole('button', { name: 'צור משתמש', exact: true });
    await expect(submit).toBeDisabled();

    await panel.getByRole('button', { name: /^עובד אחזקה/ }).click();
    await expect(panel.getByRole('button', { name: /^עובד אחזקה/ })).toHaveAttribute('aria-pressed', 'true');
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect(page.getByText('המשתמש נוצר — עובד אחזקה')).toBeVisible();

    const row = await pool.query<{ id: string; role: string }>(`select id, role from public.users where email = $1`, [NEW_WORKER_EMAIL]);
    newWorkerId = row.rows[0]!.id;
    expect(row.rows[0]!.role).toBe('maintenance');
    const audit = await pool.query<{ actor_user_id: string; metadata: { role: string } }>(
      `select actor_user_id, metadata from public.audit_log where entity_id = $1 and action = 'created'`, [newWorkerId],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({ actor_user_id: adminId, metadata: { role: 'maintenance' } });
  });

  test('a manager moved to "עובד אחזקה", then to "עובד ניקיון" — both save and both are logged', async () => {
    const page = adminPage!;
    for (const [label, role] of [['עובד אחזקה', 'maintenance'], ['עובד ניקיון', 'cleaner']] as const) {
      const panel = await openUser(page, MANAGER_NAME);
      await panel.getByRole('tab', { name: /תפקיד והרשאות/ }).click();
      await panel.getByRole('button', { name: new RegExp(`^${label}`) }).click();
      await panel.getByRole('button', { name: 'שמור שינויים' }).click();
      await expect(page.getByText(`התפקיד עודכן — ${label}`)).toBeVisible();
      await expect(panel).toBeHidden();
      expect(await roleOf(managerId)).toBe(role);
    }

    const log = await pool.query<{ actor_user_id: string; actor_name: string; changes: { before: { role: string }; after: { role: string } }; created_at: Date }>(
      `select actor_user_id, actor_name, changes, created_at from public.audit_log
        where entity_id = $1 and action = 'updated' order by created_at`, [managerId],
    );
    expect(log.rows.map((r) => [r.changes.before.role, r.changes.after.role])).toEqual([
      ['manager', 'maintenance'],
      ['maintenance', 'cleaner'],
    ]);
    for (const r of log.rows) expect(r).toMatchObject({ actor_user_id: adminId, actor_name: ADMIN_NAME });

    // A worker's matrix saves like a manager's (PUT answered 400 to workers).
    const put = await page.request.put(`/api/users/${managerId}/permissions`, { data: { module: 'calendar', can_view: true, can_edit: false } });
    expect(put.status()).toBe(200);
  });

  test('another admin and the super admin: a clear notice, a read-only panel — and 403 from the route', async () => {
    const page = adminPage!;
    for (const [name, label] of [[OTHER_ADMIN_NAME, 'אדמין'], [superName, 'סופר אדמין']] as const) {
      const panel = await openUser(page, name);
      await expect(panel.getByRole('note')).toContainText(`אין לך הרשאה לנהל משתמש בתפקיד „${label}”`);
      await expect(panel.getByRole('note')).toContainText('מנהל, צופה, עובד ניקיון, עובד אחזקה');
      await expect(panel.locator('#user-fullname')).toBeDisabled();
      await expect(panel.locator('#user-phone')).toBeDisabled();
      await panel.getByRole('tab', { name: /תפקיד והרשאות/ }).click();
      await expect(panel.getByText('אין לך הרשאה לנהל משתמש בתפקיד זה.')).toBeVisible();
      await expect(panel.getByRole('button', { name: /^מנהל/ })).toBeDisabled();
      await page.keyboard.press('Escape');
      await expect(panel).toBeHidden();
    }
    expect((await page.request.patch(`/api/users/${otherAdminId}`, { data: { role: 'manager' } })).status()).toBe(403);
    expect((await page.request.patch(`/api/users/${superId}`, { data: { role: 'admin' } })).status()).toBe(403);
    expect(await roleOf(otherAdminId)).toBe('admin');
    expect(await roleOf(superId)).toBe('super_admin');
  });

  test('the admin\'s own row: read-only, and it says only a super admin changes it', async () => {
    const page = adminPage!;
    const panel = await openUser(page, ADMIN_NAME);
    await expect(panel.getByRole('note')).toContainText('זה החשבון שלך');
    await expect(panel.locator('#user-fullname')).toBeDisabled();
    expect((await page.request.patch(`/api/users/${adminId}`, { data: { role: 'manager' } })).status()).toBe(403);
    expect(await roleOf(adminId)).toBe('admin');
  });
});
