import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { Pool } from 'pg';
import { loginThroughForm } from './helpers';

// The tiered users screen (07/10/2026), driven as a real ADMIN:
//   • "משתמשים" is in the admin's nav (by role) and opens /settings/users;
//   • in a manager's matrix the management tier (users / permissions /
//     settings) is locked — "סופר אדמין בלבד", disabled — and the route
//     answers 403; finance stays grantable;
//   • an invite to a viewer carries "שלח שוב" / "בטל הזמנה", an invite to an
//     admin carries neither, and the routes agree (200 / 403);
//   • the admin cannot touch the super admin.
// The seeded e2e-admin (a super admin) creates everything; every row made
// here is removed by its exact id at the end (CLAUDE.md iron rule 12).

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
pool.on('error', () => undefined);

const uniq = `e2e-tier-${Date.now()}`;
const PASSWORD = 'E2e-Temp0rary!';
const ADMIN_EMAIL = `${uniq}-admin@billing.local`;
const MANAGER_NAME = `מנהל זמני ${uniq}`;
const VIEWER_INVITE = `צופה מוזמן ${uniq}`;
const ADMIN_INVITE = `אדמין מוזמן ${uniq}`;

let superId = '';
let adminId = '';
let managerId = '';
let viewerInviteId = '';
let adminInviteId = '';
let adminCtx: BrowserContext | null = null;
let adminPage: Page | null = null;

test.describe.configure({ mode: 'serial' });

test.afterAll(async () => {
  await adminCtx?.close();
  const users = [adminId, managerId].filter(Boolean);
  const invites = [viewerInviteId, adminInviteId].filter(Boolean);
  for (const id of invites) await pool.query(`delete from public.user_invites where id = $1`, [id]);
  const audit = await pool.query<{ id: string }>(
    `select id from public.audit_log where entity_id = any($1::text[]) or actor_user_id = any($2::uuid[])`,
    [[...users, ...invites], users],
  );
  for (const r of audit.rows) await pool.query(`delete from public.audit_log where id = $1`, [r.id]);
  for (const id of users) await pool.query(`delete from public.users where id = $1`, [id]);
  await pool.end();
});

const cardOf = (page: Page, name: string) =>
  page.getByText(name, { exact: true }).locator('xpath=ancestor::div[contains(@class,"rounded-lg")][1]');

test.describe('tiered users management — as an admin', () => {
  test('the super admin creates an admin, a manager and two invites', async ({ page }) => {
    const me = (await (await page.request.get('/api/auth/me')).json()) as { user: { id: string; role: string } };
    expect(me.user.role).toBe('super_admin');
    superId = me.user.id;

    const make = async (data: Record<string, string>) => {
      const res = await page.request.post('/api/users', { data });
      expect(res.status(), await res.text()).toBe(201);
      return ((await res.json()) as { id: string }).id;
    };
    adminId = await make({ email: ADMIN_EMAIL, full_name: `אדמין זמני ${uniq}`, role: 'admin', password: PASSWORD });
    managerId = await make({ email: `${uniq}-mgr@billing.local`, full_name: MANAGER_NAME, role: 'manager', password: PASSWORD });
    viewerInviteId = await make({ email: `${uniq}-inv-v@billing.local`, full_name: VIEWER_INVITE, role: 'viewer' });
    adminInviteId = await make({ email: `${uniq}-inv-a@billing.local`, full_name: ADMIN_INVITE, role: 'admin' });
  });

  test('"משתמשים" is in the admin\'s nav and opens the screen', async ({ browser }) => {
    const login = await loginThroughForm(browser, ADMIN_EMAIL, PASSWORD);
    expect(login.ok, 'the temp admin logs in').toBe(true);
    adminCtx = login.ctx;
    adminPage = login.page;

    const link = adminPage.locator('a[href="/settings/users"]').first();
    await expect(link).toBeVisible();
    await link.click();
    await expect(adminPage).toHaveURL(/\/settings\/users$/);
    await expect(adminPage.getByRole('button', { name: new RegExp(MANAGER_NAME) })).toBeVisible();
  });

  test('a manager\'s matrix: the management tier is locked, finance is not — and the route agrees', async () => {
    const page = adminPage!;
    await page.getByRole('button', { name: new RegExp(MANAGER_NAME) }).click();
    const panel = page.getByRole('dialog');
    await expect(panel).toBeVisible();
    await panel.getByRole('tab', { name: /תפקיד והרשאות/ }).click();

    for (const label of ['ניהול משתמשים', 'הרשאות', 'הגדרות']) {
      await expect(panel.getByRole('checkbox', { name: `${label} — צפייה`, exact: true })).toHaveAttribute('aria-disabled', 'true');
      await expect(panel.getByRole('checkbox', { name: `${label} — עריכה`, exact: true })).toHaveAttribute('aria-disabled', 'true');
    }
    await expect(panel.getByText('סופר אדמין בלבד')).toHaveCount(3);
    await expect(panel.getByRole('checkbox', { name: 'שקיפות כספית — צפייה', exact: true })).not.toHaveAttribute('aria-disabled', 'true');

    const put = (module: string, can_view: boolean) =>
      page.request.put(`/api/users/${managerId}/permissions`, { data: { module, can_view, can_edit: false } });
    expect((await put('settings', true)).status()).toBe(403);
    expect((await put('users_management', true)).status()).toBe(403);
    expect((await put('finance', true)).status()).toBe(200);
    expect((await put('finance', false)).status()).toBe(200);
  });

  test('invites: actions only on an invite within the admin\'s scope', async () => {
    const page = adminPage!;
    await page.goto('/settings/users');
    await page.getByRole('button', { name: /^ממתינים/ }).click();

    const viewerCard = cardOf(page, VIEWER_INVITE);
    const adminCard = cardOf(page, ADMIN_INVITE);
    await expect(viewerCard.getByRole('button', { name: 'שלח שוב' })).toBeVisible();
    await expect(viewerCard.getByRole('button', { name: 'בטל הזמנה' })).toBeVisible();
    await expect(adminCard).toBeVisible();
    await expect(adminCard.getByRole('button', { name: 'שלח שוב' })).toHaveCount(0);
    await expect(adminCard.getByRole('button', { name: 'בטל הזמנה' })).toHaveCount(0);

    expect((await page.request.post(`/api/invites/${adminInviteId}/resend`)).status()).toBe(403);
    expect((await page.request.delete(`/api/invites/${adminInviteId}`)).status()).toBe(403);
    expect((await page.request.delete(`/api/invites/${viewerInviteId}`)).status()).toBe(200);
  });

  test('the admin cannot touch the super admin, nor promote the manager', async () => {
    const page = adminPage!;
    expect((await page.request.patch(`/api/users/${superId}`, { data: { is_active: false } })).status()).toBe(403);
    expect((await page.request.patch(`/api/users/${managerId}`, { data: { role: 'admin' } })).status()).toBe(403);
    expect((await page.request.patch(`/api/users/${managerId}`, { data: { role: 'viewer' } })).status()).toBe(200);
  });
});
