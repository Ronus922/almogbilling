import { test, expect, type Page } from '@playwright/test';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';

// Reminder description + attachments (05/10/2026), through the real
// /user-reminders panel.
//
// Storage is not reachable in CI, so ONLY the staging upload is stubbed — and
// the stub answers with the id of a staged row this spec inserted for the
// e2e-admin, exactly what the real route would have written. Everything after
// that is real: the save links the row, the edit panel reads it back from
// GET /api/user-reminders/[id], and the delete goes through the real DELETE
// route (its Storage call is best-effort and swallows the unreachable host).
// A refused file (too big / wrong type) never reaches the network.
//
// A viewer with user_reminders VIEW only sees the description and the file
// with its download link, but no dropzone and no delete — and the API refuses
// both writes.
//
// Fixtures are removed by the exact ids recorded here (iron rule 12).

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
pool.on('error', () => undefined);

const RUN = Date.now().toString(36);
const TITLE = `E2E-REM-${RUN}`;
const VIEW_TITLE = `E2E-REM-VIEW-${RUN}`;

const reminderIds: string[] = [];
const attachmentIds: string[] = [];
let viewerPermissionId: string | null = null;

async function userId(username: string): Promise<string> {
  const r = await pool.query<{ id: string }>(`select id from public.users where username = $1`, [username]);
  expect(r.rows).toHaveLength(1);
  return r.rows[0].id;
}

/** A staged row as POST /api/user-reminders/attachments would have written it. */
async function stagedRow(uploadedBy: string, name: string, reminderId: string | null = null) {
  const objectKey = `${randomUUID()}.pdf`;
  const r = await pool.query<{ id: string }>(
    `insert into public.user_reminder_attachments (reminder_id, uploaded_by, object_key, original_name, mime, size)
     values ($1, $2, $3, $4, 'application/pdf', 290816) returning id`,
    [reminderId, uploadedBy, objectKey, name],
  );
  attachmentIds.push(r.rows[0].id);
  return { id: r.rows[0].id, objectKey };
}

function panelOf(page: Page, heading: string) {
  return page.getByRole('dialog').filter({ hasText: heading });
}

const PDF = Buffer.from(
  'JVBERi0xLjQKMSAwIG9iajw8L1R5cGUvQ2F0YWxvZz4+ZW5kb2JqCnRyYWlsZXI8PC9Sb290IDEgMCBSPj4KJSVFT0YK',
  'base64',
);

test.afterAll(async () => {
  if (attachmentIds.length) {
    await pool.query(`delete from public.user_reminder_attachments where id = any($1::uuid[])`, [attachmentIds]);
  }
  if (reminderIds.length) {
    await pool.query(`delete from public.user_reminders where id = any($1::uuid[])`, [reminderIds]);
  }
  if (viewerPermissionId) {
    await pool.query(`delete from public.user_permissions where id = $1`, [viewerPermissionId]);
  }
  await pool.end();
});

test('create with a description and a file → edit reads both back → delete the file', async ({ page }) => {
  const adminId = await userId('e2e-admin');
  const staged = await stagedRow(adminId, 'דף חשבון.pdf');

  let uploads = 0;
  await page.route('**/api/user-reminders/attachments', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    uploads += 1;
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        id: staged.id, original_name: 'דף חשבון.pdf', mime: 'application/pdf', size: 290816,
        url: `/api/files/reminder-attachments/${staged.objectKey}`, created_at: new Date().toISOString(),
      }),
    });
  });

  await page.goto('/user-reminders');
  await page.getByRole('button', { name: 'תזכורת חדשה' }).first().click();
  const create = panelOf(page, 'תזכורת חדשה');
  await expect(create.getByText('כותרת, תיאור, קבצים, מועד, סטטוס, קטגוריה ושיוך.')).toBeVisible();
  await expect(create.locator('#rem-title')).toHaveAttribute('placeholder', 'למשל: לחזור לדייר בנושא חוב');
  await expect(create.getByText('0 / 1000')).toBeVisible();
  await expect(create.getByText('PDF, תמונות, Word, Excel · עד 10 קבצים, 20MB לקובץ')).toBeVisible();

  await create.locator('#rem-title').fill(TITLE);
  await create.locator('#rem-description').fill('חוב של 3 חודשים\nלתאם פריסה');
  await expect(create.getByText('26 / 1000')).toBeVisible();
  await expect(create.getByText('יוצג גם למשתמש המשויך')).toBeVisible();

  const input = create.locator('input[type="file"]');
  await expect(input).toHaveJSProperty('multiple', true);
  await input.setInputFiles([
    { name: 'דף חשבון.pdf', mimeType: 'application/pdf', buffer: PDF },
    { name: 'גדול.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(20 * 1024 * 1024 + 1, 1) },
    { name: 'תוכנה.exe', mimeType: 'application/octet-stream', buffer: PDF },
  ]);
  await expect(create.getByText('הקובץ גדול מ-20MB · לא הועלה')).toBeVisible();
  await expect(create.getByText('סוג הקובץ אינו נתמך · לא הועלה')).toBeVisible();
  // A refusal is not a network failure: X only, no retry.
  await expect(create.getByRole('button', { name: /^ניסיון חוזר/ })).toHaveCount(0);
  await expect(create.getByRole('link', { name: 'הורדת דף חשבון.pdf' })).toBeVisible();
  await expect(create.getByText('1 / 10')).toBeVisible();
  expect(uploads).toBe(1);

  await create.getByRole('button', { name: 'הסרת גדול.pdf' }).click();
  await create.getByRole('button', { name: 'הסרת תוכנה.exe' }).click();
  await create.getByRole('button', { name: 'יצירת תזכורת' }).click();
  await expect(page.getByText('התזכורת נוצרה')).toBeVisible();

  const saved = await pool.query<{ id: string; description: string | null }>(
    `select id, description from public.user_reminders where title = $1`, [TITLE],
  );
  expect(saved.rows).toHaveLength(1);
  const reminderId = saved.rows[0].id;
  reminderIds.push(reminderId);
  expect(saved.rows[0].description).toBe('חוב של 3 חודשים\nלתאם פריסה');
  const linked = await pool.query<{ reminder_id: string | null }>(
    `select reminder_id from public.user_reminder_attachments where id = $1`, [staged.id],
  );
  expect(linked.rows[0].reminder_id).toBe(reminderId);

  // Edit: both come back; the file has its proxy link and can be deleted.
  await page.getByText(TITLE, { exact: true }).click();
  const edit = panelOf(page, 'עריכת תזכורת');
  await expect(edit.locator('#rem-description')).toHaveValue('חוב של 3 חודשים\nלתאם פריסה');
  const download = edit.getByRole('link', { name: 'הורדת דף חשבון.pdf' });
  await expect(download).toHaveAttribute('href', `/api/files/reminder-attachments/${staged.objectKey}`);
  await expect(edit.getByText('1 / 10')).toBeVisible();
  await expect(edit.getByText('הוספת קבצים נוספים')).toBeVisible();

  await edit.getByRole('button', { name: 'מחיקת דף חשבון.pdf' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'מחק' }).click();
  await expect(page.getByText('הקובץ נמחק')).toBeVisible();
  await expect(edit.getByRole('link', { name: 'הורדת דף חשבון.pdf' })).toHaveCount(0);
  const gone = await pool.query(`select 1 from public.user_reminder_attachments where id = $1`, [staged.id]);
  expect(gone.rowCount).toBe(0);
});

test('a viewer sees the description and the file, but cannot upload or delete', async ({ browser }) => {
  const adminId = await userId('e2e-admin');
  const viewerId = await userId('e2e-viewer');
  const r = await pool.query<{ id: string }>(
    `insert into public.user_reminders (title, description, remind_at, created_by, assigned_to)
     values ($1, 'תיאור לצפייה', now() + interval '1 day', $2, $3) returning id`,
    [VIEW_TITLE, adminId, viewerId],
  );
  const reminderId = r.rows[0].id;
  reminderIds.push(reminderId);
  const file = await stagedRow(adminId, 'מסמך לצפייה.pdf', reminderId);

  // The seeded e2e-viewer has no rows at all; give it user_reminders VIEW only.
  const p = await pool.query<{ id: string }>(
    `insert into public.user_permissions (user_id, module, can_view, can_edit)
     values ($1, 'user_reminders', true, false) returning id`,
    [viewerId],
  );
  viewerPermissionId = p.rows[0].id;

  const viewer = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const login = await viewer.request.post('/api/auth/login', {
    data: { username: 'e2e-viewer', password: 'E2e-Viewer0!', remember: false },
  });
  expect(login.status(), await login.text()).toBe(200);

  const page = await viewer.newPage();
  await page.goto('/user-reminders');
  // Assigned TO the viewer → it sits under "משותף איתי", not the default "שלי".
  await page.getByRole('button', { name: /^משותף איתי/ }).click();
  await page.getByText(VIEW_TITLE, { exact: true }).click();
  const panel = panelOf(page, 'עריכת תזכורת');
  await expect(panel.locator('#rem-description')).toHaveValue('תיאור לצפייה');
  await expect(panel.getByRole('link', { name: 'הורדת מסמך לצפייה.pdf' })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'מחיקת מסמך לצפייה.pdf' })).toHaveCount(0);
  await expect(panel.getByText('בחירת קבצים')).toHaveCount(0);
  await expect(panel.locator('input[type="file"]')).toHaveCount(0);

  const upload = await viewer.request.post('/api/user-reminders/attachments', {
    multipart: { file: { name: 'x.pdf', mimeType: 'application/pdf', buffer: PDF } },
  });
  expect(upload.status()).toBe(403);
  const del = await viewer.request.delete(`/api/user-reminders/attachments/${file.id}`);
  expect(del.status()).toBe(403);
  const still = await pool.query(`select 1 from public.user_reminder_attachments where id = $1`, [file.id]);
  expect(still.rowCount).toBe(1);

  await viewer.request.post('/api/auth/logout');
  await viewer.close();
});
