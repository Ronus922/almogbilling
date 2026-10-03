import { test, expect, type Browser, type BrowserContext } from '@playwright/test';
import { Pool } from 'pg';

// "דיווח על תקלה" from the owners portal (/portal/report, decision 03/10/2026),
// end to end on the db/seed/e2e.sql fixtures. The reporter is e2e-owner-a2 —
// יוסי, the SECOND owner of apartment E2E-A — so the row must name the owner of
// the session, not the apartment's first owner.
//
// CI has no real Storage (a dummy URL), so photos are exercised in the browser
// only — the picker, the limits, the thumbnails — and removed before sending;
// the server side of photos is covered by tests/portal-issue-route.test.ts.
//
// The one issue this file creates is found by the call number on the screen
// and removed by its exact id, with the bells that were raised for it
// (iron rule 12).

test.use({ storageState: { cookies: [], origins: [] } });

const STORAGE_STATE = 'e2e/.auth/state.json';
const A2 = 'e2e-owner-a2';
const A2_PHONE = '+972501111112';
// a 1×1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
pool.on('error', () => undefined);
const created: string[] = [];

test.afterAll(async () => {
  for (const id of created) {
    await pool.query(`delete from public.notifications where source_entity_type = 'issue' and source_entity_id = $1`, [id]);
    await pool.query(`delete from public.issues where id = $1`, [id]);
  }
  await pool.end();
});

async function owner(browser: Browser, token: string): Promise<BrowserContext> {
  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] }, viewport: { width: 360, height: 780 } });
  await ctx.addCookies([{ name: 'portal_session', value: token, domain: 'localhost', path: '/' }]);
  return ctx;
}

test('an owner reports a fault: errors, chips, photo limits, confirmation — and the issue lands in the issues module', async ({ browser }) => {
  const ctx = await owner(browser, A2);
  const page = await ctx.newPage();

  // Entry: the top bar of the portal.
  await page.goto('/portal');
  await page.getByRole('link', { name: 'דיווח על תקלה' }).click();
  await expect(page).toHaveURL(/\/portal\/report$/);
  await expect(page.getByRole('heading', { name: 'דיווח על תקלה' })).toBeVisible();

  // 03 — an empty send: banner, one error per required field, focus on the first.
  await page.getByRole('button', { name: 'שליחת הדיווח' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'יש למלא 2 שדות חובה' })).toBeVisible();
  await expect(page.getByText('יש לציין היכן התקלה')).toBeVisible();
  await expect(page.getByText('יש לתאר את התקלה בכמה מילים')).toBeVisible();
  await expect(page.locator('#pir-location')).toBeFocused();

  // Live once shown: one letter is still wrong, a chip fixes it.
  await page.locator('#pir-location').fill('ל');
  await expect(page.getByText('יש לציין היכן התקלה')).toBeVisible();
  await page.locator('#pir-location').fill('');
  await page.getByRole('button', { name: 'מעלית', exact: true }).click();
  await expect(page.locator('#pir-location')).toHaveValue('מעלית');
  await expect(page.getByText('יש לציין היכן התקלה')).toHaveCount(0);
  await expect(page.getByRole('alert').filter({ hasText: 'יש למלא שדה חובה אחד' })).toBeVisible();

  await page.locator('#pir-area').fill('קומה 3');
  await page.locator('#pir-description').fill('המעלית נעצרת בין הקומות ודלתה לא נפתחת');
  await expect(page.getByRole('alert').filter({ hasText: 'שדות חובה' })).toHaveCount(0);
  await expect(page.getByText(/^\d+\/2000$/)).toHaveText('38/2000');
  await page.getByRole('radio', { name: 'דחופה' }).click();
  await expect(page.getByRole('radio', { name: 'דחופה' })).toHaveAttribute('aria-checked', 'true');

  // Photos (browser side): six from the gallery → five kept + the limit message.
  const files = Array.from({ length: 6 }, (_, i) => ({ name: `p${i}.png`, mimeType: 'image/png', buffer: PNG }));
  await page.locator('input[type=file][multiple]').setInputFiles(files);
  await expect(page.getByText('ניתן לצרף עד 5 תמונות')).toBeVisible();
  await expect(page.getByText('5/5')).toBeVisible();
  await expect(page.getByRole('button', { name: 'הוספת תמונה' })).toHaveCount(0);
  for (let i = 5; i >= 1; i--) await page.getByRole('button', { name: `הסרת תמונה ${i}` }).click();
  await expect(page.getByText('0/5')).toBeVisible();
  // the camera input exists, with capture; the gallery one has no capture
  await expect(page.locator('input[type=file][capture="environment"]')).toHaveCount(1);
  await expect(page.locator('input[type=file][multiple]')).not.toHaveAttribute('capture', /.*/);
  // a non-image is refused in the browser
  await page.locator('input[type=file][multiple]').setInputFiles({ name: 'doc.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4') });
  await expect(page.getByText('ניתן לצרף תמונות בלבד')).toBeVisible();

  // Send → 04, built from the POST answer only.
  const [res] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/portal/issues') && r.request().method() === 'POST'),
    page.getByRole('button', { name: 'שליחת הדיווח' }).click(),
  ]);
  expect(res.status()).toBe(201);
  const answer = await res.text();
  expect(answer).not.toContain(A2_PHONE);
  expect(answer).not.toContain('יוסי');

  await expect(page.getByRole('heading', { name: 'הדיווח התקבל' })).toBeVisible();
  await expect(page.getByText('חברת הניהול קיבלה את הדיווח ותטפל בו בהקדם.')).toBeVisible();
  const ticketText = (await page.locator('.pir-tk dd').first().textContent()) ?? '';
  const ticket = Number(ticketText.replace('#', ''));
  expect(ticket).toBeGreaterThanOrEqual(1001);
  await expect(page.locator('.pir-tk')).toContainText('מעלית · קומה 3');
  await expect(page.locator('.pir-tk')).toContainText('דחופה');
  await expect(page.locator('.pir-tk')).toContainText('ללא');
  const body = await page.locator('body').innerText();
  for (const word of ['וואטסאפ', 'WhatsApp', 'מעקב']) expect(body).not.toContain(word);
  await expect(page.getByRole('button')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'חזרה לדף הבית' })).toHaveAttribute('href', '/portal');

  // The row: the session's owner, the mapped priority, open and waiting for a handler.
  const row = (await pool.query(
    `select id, source, priority, status, title, created_by, reporter_name, reporter_phone, reporter_apartment,
            reporter_location, reporter_area
       from public.issues where ticket_number = $1`,
    [ticket],
  )).rows[0];
  created.push(row.id);
  expect(row).toMatchObject({
    source: 'portal', priority: 'urgent', status: 'open', title: 'דיווח דייר · מעלית', created_by: null,
    reporter_name: 'יוסי E2E', reporter_phone: A2_PHONE, reporter_apartment: 'E2E-A',
    reporter_location: 'מעלית', reporter_area: 'קומה 3',
  });
  await ctx.close();

  // Staff: the issue is in "מדיירים" + "ממתין לשיוך", and an admin gets the phone.
  const staff = await browser.newContext({ storageState: STORAGE_STATE });
  const listed = (await (await staff.request.get('/api/issues?source=portal&awaiting=1')).json()) as { items: Array<{ id: string; reporter_name: string }> };
  expect(listed.items.find((i) => i.id === row.id)?.reporter_name).toBe('יוסי E2E');
  expect(JSON.stringify(listed)).not.toContain(A2_PHONE);
  const one = (await (await staff.request.get(`/api/issues/${row.id}`)).json()) as { reporter_phone: string | null };
  expect(one.reporter_phone).toBe(A2_PHONE);
  const bells = await pool.query(`select count(*)::int as n from public.notifications where type = 'issue_reported' and source_entity_id = $1`, [row.id]);
  expect(bells.rows[0].n).toBeGreaterThan(0);
  await staff.close();
});

test('the report route opens only for a portal session', async ({ browser }) => {
  const anon = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const multipart = { location: 'לובי', description: 'נורה שרופה בלובי', urgency: 'regular' };
  expect((await anon.request.post('/api/portal/issues', { multipart })).status()).toBe(401);
  const page = await anon.request.get('/portal/report', { maxRedirects: 0 });
  expect(page.status()).toBe(307);
  await anon.close();

  const staff = await browser.newContext({ storageState: STORAGE_STATE });
  expect((await staff.request.post('/api/portal/issues', { multipart })).status()).toBe(401);
  // the admin preview of the portal has no report button
  const preview = await staff.newPage();
  await preview.goto('/finance?view=resident');
  await expect(preview.getByRole('link', { name: 'דיווח על תקלה' })).toHaveCount(0);
  await staff.close();

  const o = await owner(browser, A2);
  const cc = (await o.request.get('/portal/report')).headers()['cache-control'] ?? '';
  expect(cc).toContain('private');
  expect(cc).toContain('no-store');
  await o.close();
});
