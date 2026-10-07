import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { Pool } from 'pg';
import { loginThroughForm } from './helpers';

// The admin preview of the portal's decisions tab (/finance?view=resident&tab=dec),
// closed off the BRIEF backlog on 07/10/2026: "פתיחת המסמך" and "הורדה" go
// through the staff file path, which demands portal_decisions:view. A staff
// member who opens the preview through finance:view alone used to get the two
// buttons and a 403 after the click; now the row shows a note instead and the
// page carries no file path at all. The 403 stays on the route as the guard.
//
// The decision row is inserted straight into the table: Storage is not
// reachable in CI, and nothing here opens the bytes — only where the buttons
// lead, and that the route still refuses. Every row made here is removed by
// its exact id at the end (CLAUDE.md iron rule 12).

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
pool.on('error', () => undefined);

const uniq = `e2e-declock-${Date.now()}`;
const PASSWORD = 'E2e-Temp0rary!';
const MANAGER_EMAIL = `${uniq}-mgr@billing.local`;
const TITLE = `החלטת בדיקה ${uniq}`;
// The files route 404s any leaf that does not open with a UUID — before its
// permission guard — so the key must look like a real one for the 403 to show.
const OBJECT_KEY = `${randomUUID()}.pdf`;
const STAFF_PATH = `/api/files/portal-decisions/${OBJECT_KEY}`;
const PREVIEW = '/finance?view=resident&tab=dec';

let decisionId = '';
let managerId = '';

test.describe.configure({ mode: 'serial' });

test.afterAll(async () => {
  if (decisionId) await pool.query(`delete from public.portal_decisions where id = $1`, [decisionId]);
  if (managerId) {
    const audit = await pool.query<{ id: string }>(
      `select id from public.audit_log where entity_id = $1 or actor_user_id = $2::uuid`,
      [managerId, managerId],
    );
    for (const r of audit.rows) await pool.query(`delete from public.audit_log where id = $1`, [r.id]);
    await pool.query(`delete from public.users where id = $1`, [managerId]);
  }
  await pool.end();
});

test.describe('decisions in the admin preview — buttons follow portal_decisions:view', () => {
  test('a published decision and a manager with finance but not decisions', async ({ page }) => {
    const { rows } = await pool.query<{ id: string }>(
      `insert into public.portal_decisions
         (title, doc_type, decided_at, object_key, original_filename, file_size, mime_type, published)
       values ($1, 'decision', '2026-10-05', $2, 'בדיקה.pdf', 4096, 'application/pdf', true)
       returning id`,
      [TITLE, OBJECT_KEY],
    );
    decisionId = rows[0].id;

    const res = await page.request.post('/api/users', {
      data: { email: MANAGER_EMAIL, full_name: `מנהל זמני ${uniq}`, role: 'manager', password: PASSWORD },
    });
    expect(res.status(), await res.text()).toBe(201);
    managerId = ((await res.json()) as { id: string }).id;
    const grant = await page.request.put(`/api/users/${managerId}/permissions`, {
      data: { module: 'finance', can_view: true, can_edit: false },
    });
    expect(grant.status(), await grant.text()).toBe(200);
  });

  test('with the permission (the seeded admin): both buttons, on the staff path', async ({ page }) => {
    await page.goto(PREVIEW);
    const row = page.locator('.drow', { hasText: TITLE });
    await row.locator('.dmain').click();
    await expect(row.getByRole('link', { name: 'פתיחת המסמך' })).toHaveAttribute('href', STAFF_PATH);
    await expect(row.getByRole('link', { name: 'הורדה' })).toHaveAttribute('href', `${STAFF_PATH}?download=1`);
    await expect(row.locator('.dlock')).toHaveCount(0);
  });

  test('without it: the row and a note, no buttons, no file path — and the route still says 403', async ({ browser }) => {
    const login = await loginThroughForm(browser, MANAGER_EMAIL, PASSWORD);
    expect(login.ok, 'the temp manager logs in').toBe(true);
    const page = login.page;
    try {
      await page.goto(PREVIEW);
      const row = page.locator('.drow', { hasText: TITLE });
      await row.locator('.dmain').click();
      await expect(row.locator('.dlock')).toHaveText(/הרשאת „החלטות ופרוטוקולים”/);
      await expect(row.getByRole('link')).toHaveCount(0);
      expect(await page.content()).not.toContain(OBJECT_KEY);

      expect((await page.request.get(STAFF_PATH)).status()).toBe(403);
    } finally {
      await login.ctx.close();
    }
  });
});
