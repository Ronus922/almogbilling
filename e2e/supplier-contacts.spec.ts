import { test, expect, type Page, type Locator } from '@playwright/test';
import { Pool } from 'pg';

// Additional supplier contacts — "הוסף איש קשר נוסף" (04/10/2026).
//
// Through the real screens: create a supplier with two additional contacts,
// edit one, remove one, save, reload — and the database holds exactly what the
// screen shows while the PRIMARY contact (contact_person / phone / mobile /
// email) is byte-for-byte what was typed. Archiving afterwards must not touch
// the contacts (the status PATCH omits the key). An existing supplier with no
// additional contacts opens and saves cleanly. A viewer who may only VIEW
// suppliers sees the contacts but no button, and the API refuses the write.
//
// Fixtures are removed by the exact ids recorded here (iron rule 12).

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
pool.on('error', () => undefined);

const RUN = Date.now().toString(36);
const NEW_NAME = `E2E-SUPCON-NEW-${RUN}`;
const OLD_NAME = `E2E-SUPCON-OLD-${RUN}`;
const VIEW_NAME = `E2E-SUPCON-VIEW-${RUN}`;

const supplierIds: string[] = [];
let viewerPermissionId: string | null = null;

interface ContactRow { name: string; role: string; phone: string; email: string }
interface PrimaryRow { contact_person: string; phone: string; mobile: string; email: string }

async function contactsOf(id: string): Promise<ContactRow[]> {
  const r = await pool.query<ContactRow>(
    `select name, role, phone, email from public.supplier_contacts
      where supplier_id = $1 order by sort_order`,
    [id],
  );
  return r.rows;
}

async function primaryOf(id: string): Promise<PrimaryRow> {
  const r = await pool.query<PrimaryRow>(
    `select contact_person, phone, mobile, email from public.suppliers where id = $1`,
    [id],
  );
  return r.rows[0];
}

/** The desktop table row (the phone card list is display:none at this width). */
async function openSupplier(page: Page, name: string): Promise<Locator> {
  await page.getByText(name, { exact: true }).filter({ visible: true }).click();
  const panel = page.getByRole('dialog').filter({ hasText: name });
  await expect(panel.getByRole('tab', { name: 'פרטים' })).toBeVisible();
  return panel;
}

test.afterAll(async () => {
  // supplier_contacts cascade from suppliers.
  if (supplierIds.length) {
    await pool.query(`delete from public.suppliers where id = any($1::uuid[])`, [supplierIds]);
  }
  if (viewerPermissionId) {
    await pool.query(`delete from public.user_permissions where id = $1`, [viewerPermissionId]);
  }
  await pool.end();
});

test('create with two additional contacts → edit one, remove one → reload: saved, primary untouched', async ({ page }) => {
  await page.goto('/suppliers');
  await page.getByRole('button', { name: 'ספק חדש' }).click();
  const create = page.getByRole('dialog').filter({ hasText: 'ספק חדש' });

  await create.locator('#sup-display-name').fill(NEW_NAME);
  await create.locator('#sup-contact-person').fill('ראשי E2E');
  await create.locator('#sup-phone').fill('03-1234567');
  await create.locator('#sup-mobile').fill('052-1111111');
  await create.locator('#sup-email').fill('primary@example.com');

  const add = create.getByRole('button', { name: 'הוסף איש קשר נוסף' });
  await add.click();
  await add.click();
  await expect(create.getByRole('group', { name: 'איש קשר נוסף 2' })).toBeVisible();
  await expect(create.getByRole('group', { name: 'איש קשר נוסף 3' })).toBeVisible();

  await create.locator('#sup-contact-0-name').fill('דנה E2E');
  await create.locator('#sup-contact-0-role').fill('הנהלת חשבונות');
  await create.locator('#sup-contact-0-phone').fill('052-2222222');
  await create.locator('#sup-contact-0-email').fill('dana@example.com');
  await create.locator('#sup-contact-1-name').fill('יוסי E2E');
  await create.locator('#sup-contact-1-role').fill('מנהל עבודה');
  await create.locator('#sup-contact-1-phone').fill('054-3333333');
  await create.locator('#sup-contact-1-email').fill('yossi@example.com');

  // A bad phone in a card blocks the save and says why — right away.
  await create.locator('#sup-contact-1-phone').fill('12');
  await expect(create.getByText('⚠️', { exact: false })).toBeVisible();
  await expect(create.getByRole('button', { name: 'צור ספק' })).toBeDisabled();
  await create.locator('#sup-contact-1-phone').fill('054-3333333');

  await create.getByRole('button', { name: 'צור ספק' }).click();
  await expect(page.getByText('הספק נוצר')).toBeVisible();

  const created = await pool.query<{ id: string }>(
    `select id from public.suppliers where display_name = $1 and deleted_at is null`,
    [NEW_NAME],
  );
  expect(created.rows).toHaveLength(1);
  const id = created.rows[0].id;
  supplierIds.push(id);

  const primary: PrimaryRow = {
    contact_person: 'ראשי E2E', phone: '031234567', mobile: '0521111111', email: 'primary@example.com',
  };
  expect(await primaryOf(id)).toEqual(primary);
  expect(await contactsOf(id)).toEqual([
    { name: 'דנה E2E', role: 'הנהלת חשבונות', phone: '0522222222', email: 'dana@example.com' },
    { name: 'יוסי E2E', role: 'מנהל עבודה', phone: '0543333333', email: 'yossi@example.com' },
  ]);

  // View mode shows them next to the primary contact.
  let panel = await openSupplier(page, NEW_NAME);
  await expect(panel.getByRole('group', { name: 'איש קשר נוסף 2' })).toContainText('דנה E2E');
  await expect(panel.getByRole('group', { name: 'איש קשר נוסף 3' })).toContainText('יוסי E2E');

  // Edit: change Dana's role, remove Yossi, save.
  await panel.getByRole('button', { name: 'ערוך' }).click();
  await expect(panel.locator('#esup-contact-0-name')).toHaveValue('דנה E2E');
  await expect(panel.locator('#esup-contact-1-name')).toHaveValue('יוסי E2E');
  await panel.locator('#esup-contact-0-role').fill('מנהלת חשבונות');
  await panel.getByRole('button', { name: 'הסר איש קשר נוסף 3' }).click();
  await expect(panel.getByRole('group', { name: 'איש קשר נוסף 3' })).toHaveCount(0);
  await panel.getByRole('button', { name: 'שמור שינויים' }).click();
  await expect(page.getByText('הספק עודכן')).toBeVisible();

  // Reload from scratch — what the screen shows comes from the database.
  await page.reload();
  panel = await openSupplier(page, NEW_NAME);
  const dana = panel.getByRole('group', { name: 'איש קשר נוסף 2' });
  await expect(dana).toContainText('דנה E2E');
  await expect(dana).toContainText('מנהלת חשבונות');
  await expect(panel.getByRole('group', { name: 'איש קשר נוסף 3' })).toHaveCount(0);
  await expect(panel.getByText('יוסי E2E')).toHaveCount(0);

  const saved = [{ name: 'דנה E2E', role: 'מנהלת חשבונות', phone: '0522222222', email: 'dana@example.com' }];
  expect(await contactsOf(id)).toEqual(saved);
  expect(await primaryOf(id)).toEqual(primary);

  // The contacts-only edit is in the activity log.
  const audit = await pool.query<{ changes: { fields: string[] } }>(
    `select changes from public.audit_log
      where entity_type = 'supplier' and entity_id = $1 and action = 'updated'`,
    [id],
  );
  expect(audit.rows.map((r) => r.changes.fields)).toContainEqual(['additional_contacts']);

  // Archiving PATCHes the whole supplier WITHOUT the contacts key — they stay.
  await panel.getByRole('button', { name: 'העבר לארכיון' }).click();
  await expect(page.getByText('הסטטוס עודכן')).toBeVisible();
  expect(await contactsOf(id)).toEqual(saved);
  expect(await primaryOf(id)).toEqual(primary);
});

test('an existing supplier with no additional contacts opens, edits and saves without an error', async ({ page }) => {
  const r = await pool.query<{ id: string }>(
    `insert into public.suppliers (display_name, contact_person, phone, mobile, email)
     values ($1, 'ראשי ישן', '031112222', '0501112222', 'old@example.com') returning id`,
    [OLD_NAME],
  );
  const id = r.rows[0].id;
  supplierIds.push(id);

  const api = await page.request.get(`/api/suppliers/${id}`);
  expect(api.status()).toBe(200);
  expect(((await api.json()) as { supplier: { additional_contacts: unknown[] } }).supplier.additional_contacts)
    .toEqual([]);

  await page.goto('/suppliers');
  const panel = await openSupplier(page, OLD_NAME);
  await expect(panel.getByRole('group', { name: /איש קשר נוסף/ })).toHaveCount(0);
  await panel.getByRole('button', { name: 'ערוך' }).click();
  await expect(panel.getByRole('button', { name: 'הוסף איש קשר נוסף' })).toBeVisible();
  await panel.getByRole('button', { name: 'שמור שינויים' }).click();
  await expect(page.getByText('הספק עודכן')).toBeVisible();
  await expect(panel.getByRole('button', { name: 'ערוך' })).toBeVisible();

  expect(await contactsOf(id)).toEqual([]);
  expect(await primaryOf(id)).toEqual({
    contact_person: 'ראשי ישן', phone: '031112222', mobile: '0501112222', email: 'old@example.com',
  });
});

test('a viewer sees the contacts but no add/edit button, and the API refuses the write', async ({ browser }) => {
  const s = await pool.query<{ id: string }>(
    `insert into public.suppliers (display_name, contact_person) values ($1, 'ראשי צפייה') returning id`,
    [VIEW_NAME],
  );
  const id = s.rows[0].id;
  supplierIds.push(id);
  await pool.query(
    `insert into public.supplier_contacts (supplier_id, name, role, sort_order)
     values ($1, 'נוסף לצפייה', 'מזכירות', 0)`,
    [id],
  );
  // The seeded e2e-viewer has no rows at all; give it suppliers VIEW only.
  const p = await pool.query<{ id: string }>(
    `insert into public.user_permissions (user_id, module, can_view, can_edit)
     select id, 'suppliers', true, false from public.users where username = 'e2e-viewer'
     returning id`,
  );
  expect(p.rows).toHaveLength(1);
  viewerPermissionId = p.rows[0].id;

  const viewer = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const login = await viewer.request.post('/api/auth/login', {
    data: { username: 'e2e-viewer', password: 'E2e-Viewer0!', remember: false },
  });
  expect(login.status(), await login.text()).toBe(200);

  const page = await viewer.newPage();
  await page.goto('/suppliers');
  await expect(page.getByText(VIEW_NAME, { exact: true }).filter({ visible: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'ספק חדש' })).toHaveCount(0);

  const panel = await openSupplier(page, VIEW_NAME);
  await expect(panel.getByRole('group', { name: 'איש קשר נוסף 2' })).toContainText('נוסף לצפייה');
  await expect(panel.getByRole('button', { name: 'ערוך' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'הוסף איש קשר נוסף' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^הסר איש קשר נוסף/ })).toHaveCount(0);

  const contacts = [{ name: 'פורץ', role: '', phone: '', email: '' }];
  const patch = await viewer.request.patch(`/api/suppliers/${id}`, {
    data: { display_name: VIEW_NAME, contact_person: 'ראשי צפייה', additional_contacts: contacts },
  });
  expect(patch.status()).toBe(403);
  const post = await viewer.request.post('/api/suppliers', {
    data: { display_name: `${VIEW_NAME}-POST`, additional_contacts: contacts },
  });
  expect(post.status()).toBe(403);

  expect(await contactsOf(id)).toEqual([{ name: 'נוסף לצפייה', role: 'מזכירות', phone: '', email: '' }]);
  const stray = await pool.query(`select 1 from public.suppliers where display_name = $1`, [`${VIEW_NAME}-POST`]);
  expect(stray.rowCount).toBe(0);

  await viewer.request.post('/api/auth/logout');
  await viewer.close();
});
