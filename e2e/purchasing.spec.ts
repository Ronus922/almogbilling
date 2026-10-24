import { test, expect, type Page } from '@playwright/test';
import { Pool } from 'pg';
import { MAILPIT_URL, mailpitClear, saveSmtpSettings } from './helpers';

// Purchasing ("רכש", 21/10/2026), driven as the seeded super admin through the
// real screens, end to end:
//   wizard (company letterhead, once) → the ONE form (Invoice Maven sample): the
//   heading carries the next number, supplier from the list or typed, optional
//   description / prices, three-row summary, draft + preview → send by e-mail
//   (PDF attached, Mailpit) and WhatsApp (message + file, the Green stand-in)
//   → the supplier's PUBLIC link: submit, amend, locked after the due date →
//   comparison + cheapest flag + winner → purchase order from the winner
//   (prefilled, totals with the VAT stamped at issue) → a direct purchase order
//   → the PDF. DRAFTS live on the server (no number until issued, open from
//   another session). A HAND-TYPED supplier gets the same treatment as a listed
//   one: send (e-mail + WhatsApp), personal link, comparison, winner, order, and
//   a channel without a detail is blocked with a plain message.
// Storage is unreachable in CI, so nothing here uploads a file (the file rules
// are locked by tests/purchasing-public-route.test.ts and
// tests/purchasing-rbac-route.test.ts).
//
// Fixtures are removed by the exact ids recorded here (CLAUDE.md iron rule 12);
// the company setting and the two number series are restored to what they were.

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
pool.on('error', () => undefined);

const RUN = Date.now().toString().slice(-7);
const GREEN = `http://127.0.0.1:${process.env.E2E_GREENAPI_PORT ?? '3110'}`;
const SUP_A = `ספק א׳ ${RUN}`;
const SUP_B = `ספק ב׳ ${RUN}`;
const MOBILE_A = `05${RUN.slice(0, 8).padEnd(8, '1')}`;
const MOBILE_B = `05${RUN.slice(0, 8).padEnd(8, '2')}`;
const CHAT_A = `972${MOBILE_A.slice(1)}@c.us`;
const RFQ_TITLE = `חידוש צבע ${RUN}`;
const TYPED_SUPPLIER = `ספק חופשי ${RUN}`;
const START_RFQ = 500;
const START_PO = 70;

const made = { suppliers: [] as string[], docs: [] as string[] };
let priorCompany: unknown = null;
let hadCompany = false;
let priorSequences: Array<{ doc_type: string; last_number: number }> = [];
// Green's media host is derived from the API host; the stand-in has no `api.`
// to swap, so the seeded instance is pointed at it explicitly for this spec.
let instanceMedia: { id: string; media_url: string | null } | null = null;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  const co = await pool.query(`select value from public.app_settings where key = 'purchasing_company'`);
  hadCompany = co.rowCount === 1;
  priorCompany = co.rows[0]?.value ?? null;
  priorSequences = (await pool.query(`select doc_type, last_number from public.purchasing_sequences`)).rows;
  await pool.query(`delete from public.app_settings where key = 'purchasing_company'`);
  await pool.query(`delete from public.purchasing_sequences where doc_type in ('rfq', 'po')`);
  const inst = await pool.query<{ id: string; media_url: string | null }>(
    `select id, media_url from public.whatsapp_instances where api_url = $1`, [GREEN],
  );
  instanceMedia = inst.rows[0] ?? null;
  if (instanceMedia) await pool.query(`update public.whatsapp_instances set media_url = $2 where id = $1`, [instanceMedia.id, GREEN]);
  for (const [name, mobile] of [[SUP_A, MOBILE_A], [SUP_B, MOBILE_B]]) {
    const r = await pool.query<{ id: string }>(
      `insert into public.suppliers (display_name, email, mobile) values ($1, $2, $3) returning id`,
      [name, `e2e-${RUN}-${mobile.slice(-1)}@example.com`, mobile],
    );
    made.suppliers.push(r.rows[0].id);
  }
});

test.afterAll(async () => {
  try {
    // Documents are made through the UI, so the exact ids are found by what ties
    // them to THIS run's fixtures: its suppliers, or the RUN tag in a title.
    const mine = await pool.query<{ id: string }>(
      `select id from public.purchasing_documents
        where id = any($1::uuid[]) or supplier_id = any($2::uuid[]) or title like $3 or supplier_name like $3`,
      [made.docs, made.suppliers, `%${RUN}%`],
    );
    const ids = mine.rows.map((r) => r.id);
    if (ids.length) {
      const audit = await pool.query<{ id: string }>(`select id from public.audit_log where entity_id = any($1::text[])`, [ids]);
      for (const a of audit.rows) await pool.query(`delete from public.audit_log where id = $1`, [a.id]);
      await pool.query(`delete from public.purchasing_documents where id = any($1::uuid[])`, [ids]);
    }
    if (made.suppliers.length) await pool.query(`delete from public.suppliers where id = any($1::uuid[])`, [made.suppliers]);
  } finally {
    if (instanceMedia) await pool.query(`update public.whatsapp_instances set media_url = $2 where id = $1`, [instanceMedia.id, instanceMedia.media_url]);
    await pool.query(`delete from public.app_settings where key = 'purchasing_company'`);
    if (hadCompany) {
      await pool.query(`insert into public.app_settings (key, value) values ('purchasing_company', $1::jsonb)`, [JSON.stringify(priorCompany)]);
    }
    await pool.query(`delete from public.purchasing_sequences where doc_type in ('rfq', 'po')`);
    for (const row of priorSequences) {
      await pool.query(`insert into public.purchasing_sequences (doc_type, last_number) values ($1, $2)`, [row.doc_type, row.last_number]);
    }
    await pool.end();
  }
});

/** The id of the document with this number/type, recorded for cleanup. */
async function docId(type: 'rfq' | 'po', number: number): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `select id from public.purchasing_documents where doc_type = $1 and number = $2`, [type, number],
  );
  const id = r.rows[0]?.id;
  expect(id, `document ${type} #${number} was not created`).toBeTruthy();
  if (!made.docs.includes(id)) made.docs.push(id);
  return id;
}

const sheet = (page: Page) => page.getByRole('dialog').last();

async function fillLine(page: Page, index: number, description: string, quantity: string, price?: string) {
  const row = page.locator(`[data-line="${index}"]`);
  await row.getByPlaceholder('פירוט').fill(description);
  await row.locator('input[inputmode="decimal"]').nth(0).fill(quantity);
  if (price !== undefined) await row.locator('input[inputmode="decimal"]').nth(1).fill(price);
}

test('nav, wizard and the first request: the letterhead once, then "from which number"', async ({ page }) => {
  await page.goto('/purchasing');
  await expect(page.getByRole('heading', { name: 'רכש' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'בקשות והזמנות' })).toBeVisible();

  // No company details yet → the one-time wizard, before the document.
  await page.getByRole('button', { name: 'בקשה חדשה' }).click();
  await expect(page.getByText('פרטי החברה למסמכי הרכש')).toBeVisible();
  // Required fields are enforced.
  await page.getByRole('button', { name: 'שמור והמשך' }).click();
  await expect(page.getByText('יש להזין שם חברה')).toBeVisible();

  await page.locator('#co-name').fill(`ועד הבית בדיקה ${RUN}`);
  await page.locator('#co-tax').fill('514123456');
  await page.locator('#co-phone').fill('04-8123456');
  await page.locator('#co-address').fill('דרך הים 12, חיפה');
  await page.locator('#co-email').fill('office@example.com');
  await expect(page.locator('#co-vat')).toHaveValue('18');
  await page.getByRole('button', { name: 'שמור והמשך' }).click();

  // …and it continues to the request the user asked for. The series is empty,
  // so the heading itself asks where to start.
  await expect(page.locator('[data-form-heading]')).toContainText('בקשה להצעת מחיר מספר');
  await expect(page.locator('#doc-start')).toBeVisible();
  await expect(sheet(page).getByText('זה בקשה להצעת מחיר הראשונה')).toBeVisible();

  // The form is exactly the sample's — no file upload, no extras.
  const form = sheet(page);
  for (const gone of ['קבצים מצורפים', 'הוספת קובץ', 'הצעה מחוץ למערכת', 'מטבע', 'הנחה', 'עיגול', 'תגיות', 'פרטי בנק']) {
    await expect(form.getByText(gone)).toHaveCount(0);
  }
  await expect(form.locator('input[type="file"]')).toHaveCount(0);
  await expect(form.getByLabel('תאריך מסמך')).toHaveValue(/^\d{4}-\d{2}-\d{2}$/);
  await expect(page.locator('[data-line="0"] input[inputmode="decimal"]').first()).toHaveValue('1'); // quantity defaults to 1
  await expect(form.locator('[data-totals] dt')).toHaveText(['סה״כ לפני מע״מ', 'מע״מ 18%', 'סה״כ לתשלום']);

  // A supplier is required (from the list, or typed).
  await page.locator('#doc-start').fill(String(START_RFQ));
  await fillLine(page, 0, 'צבע אקרילי לבן', '3');
  await form.getByRole('button', { name: 'הפק את המסמך' }).click();
  await expect(form.getByText('יש לבחור ספק או להקליד שם ספק')).toBeVisible();
  // …and so is the subject of a request (a purchase order's description stays optional).
  await expect(form.getByText('יש להזין נושא לבקשה')).toBeVisible();

  // A supplier typed by hand: its phone / e-mail / address appear and stay on the document.
  await page.locator('#doc-supplier').fill(TYPED_SUPPLIER);
  await page.locator('#doc-supplier-phone').fill('050-7654321');
  await page.locator('#doc-supplier-email').fill(`typed-${RUN}@example.com`);
  await page.locator('#doc-supplier-address').fill('רחוב הבדיקה 1, חיפה');
  await page.locator('#doc-title').fill(RFQ_TITLE);
  await page.getByRole('button', { name: 'הוסף', exact: true }).click();
  await fillLine(page, 1, 'רולר צביעה', '10');
  await form.getByRole('button', { name: 'הפק את המסמך' }).click();

  await expect(page.getByRole('heading', { name: `בקשה להצעת מחיר מספר ${START_RFQ}` })).toBeVisible();
  const first = await docId('rfq', START_RFQ);
  const typed = await pool.query(
    `select supplier_id, supplier_name, supplier_phone, supplier_email, supplier_address from public.purchasing_documents where id = $1`, [first],
  );
  expect(typed.rows[0]).toMatchObject({
    supplier_id: null, supplier_name: TYPED_SUPPLIER, supplier_phone: '050-7654321', supplier_address: 'רחוב הבדיקה 1, חיפה',
  });
  // Never added to the suppliers list.
  expect((await pool.query(`select 1 from public.suppliers where display_name = $1 or company_name = $1`, [TYPED_SUPPLIER])).rowCount).toBe(0);

  // The requests list is told apart by SUBJECT: it has the column, and no supplier column
  // (a request goes to several suppliers — they live inside the request).
  await page.goto('/purchasing?tab=rfq');
  const rfqHead = page.locator('table[data-list="rfq"] th');
  await expect(rfqHead.filter({ hasText: 'נושא' })).toHaveCount(1);
  await expect(rfqHead.filter({ hasText: 'ספק' })).toHaveCount(0);
  await expect(page.locator(`tr[data-number="${START_RFQ}"]`)).toContainText(RFQ_TITLE);

  // The company is saved: a second visit does not ask again.
  const co = await pool.query(`select value from public.app_settings where key = 'purchasing_company'`);
  expect(co.rows[0].value.vat_rate).toBe(18);
});

test('the heading shows the next number, "פירוט" completes, a price is optional, a taken number moves on', async ({ page, request }) => {
  await page.goto('/purchasing');
  await page.getByRole('button', { name: 'בקשה חדשה' }).click();
  await expect(page.locator('#doc-start')).toHaveCount(0); // the series already runs
  await expect(page.locator('[data-doc-number]')).toHaveText(String(START_RFQ + 1));
  await expect(page.getByText('יוקצה בשמירה')).toHaveCount(0);
  const form = sheet(page);

  // The supplier field searches the list.
  await page.locator('#doc-supplier').fill(SUP_B.slice(0, 7));
  await page.getByRole('option', { name: SUP_B }).click();
  await expect(page.locator('#doc-supplier')).toHaveValue(SUP_B);
  await expect(page.locator('#doc-supplier-phone')).toHaveCount(0); // a listed supplier has no hand-typed details

  const desc = page.locator('[data-line="0"]').getByPlaceholder('פירוט');
  await desc.fill('צבע אקר');
  await page.getByRole('option', { name: 'צבע אקרילי לבן' }).click();
  await expect(desc).toHaveValue('צבע אקרילי לבן');
  // The price is optional in a request; filled, the summary follows (18% VAT).
  await page.locator('[data-line="0"] input[inputmode="decimal"]').nth(1).fill('20');
  await expect(form.locator('[data-totals]')).toContainText('₪20.00');
  await expect(form.locator('[data-totals]')).toContainText('₪3.60');
  await expect(form.locator('[data-totals]')).toContainText('₪23.60');

  // A request needs its subject — the preview too.
  await page.locator('#doc-title').fill(`בקשה שנייה ${RUN}`);

  // The preview is a real PDF and saves nothing.
  const before = await pool.query(`select count(*)::int as n from public.purchasing_documents`);
  const [previewRes] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/purchasing/preview')),
    form.getByRole('button', { name: 'תצוגה מקדימה' }).click(),
  ]);
  expect(previewRes.status()).toBe(200);
  expect(previewRes.headers()['content-type']).toBe('application/pdf');
  expect((await pool.query(`select count(*)::int as n from public.purchasing_documents`)).rows[0].n).toBe(before.rows[0].n);

  // Somebody else takes the number shown while this form is open.
  const taken = await request.post('/api/purchasing/documents', {
    data: {
      doc_type: 'rfq', doc_date: '2026-10-22', title: `תפוס ${RUN}`, supplier_name: TYPED_SUPPLIER, due_date: '2099-01-01',
      lines: [{ description: 'שורה', quantity: 1, unit_price: null }],
    },
  });
  expect(taken.status()).toBe(201);
  await docId('rfq', START_RFQ + 1);

  await form.getByRole('button', { name: 'הפק את המסמך' }).click();
  await expect(page.getByText(`המספר ${START_RFQ + 1} נתפס בינתיים — המסמך הופק כמספר ${START_RFQ + 2}`)).toBeVisible();
  await expect(page.getByRole('heading', { name: `בקשה להצעת מחיר מספר ${START_RFQ + 2}` })).toBeVisible();
  await docId('rfq', START_RFQ + 2);
});

test('a draft is saved on the server with no number, opens from another session, and gets its number only when issued', async ({ page, browser }) => {
  await page.goto('/purchasing');
  await page.getByRole('button', { name: 'בקשה חדשה' }).click();
  const form = sheet(page);
  const seqNow = async () => (await pool.query(`select last_number from public.purchasing_sequences where doc_type = 'rfq'`)).rows[0].last_number as number;
  const seqBefore = await seqNow();
  const DRAFT_TITLE = `טיוטה ${RUN}`;
  await page.locator('#doc-supplier').fill(`ספק טיוטה ${RUN}`);
  await page.locator('#doc-title').fill(DRAFT_TITLE);
  await fillLine(page, 0, 'פריט בטיוטה', '4');
  await form.getByRole('button', { name: 'שמור טיוטה' }).click();
  await expect(page.getByText('הטיוטה נשמרה')).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // On the server: a draft row, no number, the series untouched.
  const row = await pool.query(`select id, status, number from public.purchasing_documents where title = $1`, [DRAFT_TITLE]);
  expect(row.rows[0]).toMatchObject({ status: 'draft', number: null });
  const draftId: string = row.rows[0].id;
  made.docs.push(draftId);
  expect(await seqNow()).toBe(seqBefore);
  // In the list of the same tab: a "טיוטה" tag instead of a number.
  const draftRow = page.locator('tr[data-draft]', { hasText: DRAFT_TITLE });
  await expect(draftRow.locator('td').first()).toHaveText('טיוטה');
  // Nothing is kept in the browser any more.
  expect(await page.evaluate(() => Object.keys(window.localStorage).filter((k) => k.startsWith('purchasing-draft')))).toEqual([]);

  // Another device / session: the same draft opens in the form.
  const other = await browser.newContext({ storageState: 'e2e/.auth/state.json' });
  const p2 = await other.newPage();
  await p2.goto('/purchasing');
  await p2.locator('tr[data-draft]', { hasText: DRAFT_TITLE }).click();
  await expect(p2.locator('#doc-supplier')).toHaveValue(`ספק טיוטה ${RUN}`);
  await expect(p2.locator('#doc-title')).toHaveValue(DRAFT_TITLE);
  await expect(p2.locator('[data-line="0"]').getByPlaceholder('פירוט')).toHaveValue('פריט בטיוטה');
  await expect(p2.locator('[data-doc-number]')).toHaveText(String(seqBefore + 1)); // the number it WOULD get

  // Edit and save it again — still no number.
  await p2.locator('#doc-title').fill(`${DRAFT_TITLE} ב`);
  await sheet(p2).getByRole('button', { name: 'שמור טיוטה' }).click();
  await expect(p2.getByText('הטיוטה נשמרה')).toBeVisible();
  expect((await pool.query(`select title, number from public.purchasing_documents where id = $1`, [draftId])).rows[0])
    .toMatchObject({ title: `${DRAFT_TITLE} ב`, number: null });

  // A draft cannot be sent and has no PDF; the preview still works.
  const send = await other.request.post(`/api/purchasing/documents/${draftId}/send`, { data: { supplier_ids: ['manual'], email: true, whatsapp: false } });
  expect(send.status()).toBe(409);
  expect((await other.request.get(`/api/purchasing/documents/${draftId}/pdf`)).status()).toBe(409);
  await p2.locator('tr[data-draft]', { hasText: `${DRAFT_TITLE} ב` }).click();
  const [pv] = await Promise.all([
    p2.waitForResponse((r) => r.url().includes('/api/purchasing/preview')),
    sheet(p2).getByRole('button', { name: 'תצוגה מקדימה' }).click(),
  ]);
  expect(pv.status()).toBe(200);

  // Issue it: the running number is allocated NOW.
  await sheet(p2).getByRole('button', { name: 'הפק את המסמך' }).click();
  await expect(p2.getByRole('heading', { name: `בקשה להצעת מחיר מספר ${seqBefore + 1}` })).toBeVisible();
  expect((await pool.query(`select status, number from public.purchasing_documents where id = $1`, [draftId])).rows[0])
    .toMatchObject({ status: 'issued', number: seqBefore + 1 });
  await expect(p2.locator('tr[data-draft]', { hasText: DRAFT_TITLE })).toHaveCount(0);
  await other.close();

  // A draft of a purchase order, deleted from the list: gone for good, no number used.
  const poSeq = (await pool.query(`select last_number from public.purchasing_sequences where doc_type = 'po'`)).rows[0]?.last_number ?? null;
  const po = await page.request.post('/api/purchasing/documents?mode=draft', {
    data: { doc_type: 'po', doc_date: '2026-10-22', title: `טיוטת הזמנה ${RUN}`, supplier_name: TYPED_SUPPLIER, lines: [] },
  });
  expect(po.status()).toBe(201);
  const poId = (await po.json()).id as string;
  made.docs.push(poId);
  await page.goto('/purchasing?tab=po');
  const poRow = page.locator('tr[data-draft]', { hasText: `טיוטת הזמנה ${RUN}` });
  await expect(poRow).toBeVisible();
  page.once('dialog', (d) => d.accept());
  await poRow.locator('[data-delete-draft]').click();
  await expect(poRow).toHaveCount(0);
  expect((await pool.query(`select 1 from public.purchasing_documents where id = $1`, [poId])).rowCount).toBe(0);
  expect((await pool.query(`select last_number from public.purchasing_sequences where doc_type = 'po'`)).rows[0]?.last_number ?? null).toBe(poSeq);
});

test('send the request by e-mail (PDF attached) and WhatsApp (message with the personal link + the PDF)', async ({ page, request }) => {
  await saveSmtpSettings(request);
  await mailpitClear(request);
  await request.post(`${GREEN}/__reset`);

  await page.goto('/purchasing');
  await page.locator(`tr[data-number="${START_RFQ}"]`).click();
  await expect(page.getByRole('heading', { name: `בקשה להצעת מחיר מספר ${START_RFQ}` })).toBeVisible();
  await page.getByRole('button', { name: 'שליחה' }).click();

  const send = sheet(page);
  await expect(send.getByText('שליחה לספקים')).toBeVisible();
  await send.getByRole('checkbox', { name: SUP_A }).click();
  await send.getByRole('checkbox', { name: SUP_B }).click();
  // The request's hand-typed supplier is a row of its own (e-mail + phone from the document).
  await expect(send.locator('[data-send-row="manual"]')).toContainText('ספק שהוקלד');
  await send.getByRole('checkbox', { name: TYPED_SUPPLIER }).click();
  await send.getByRole('checkbox', { name: 'WhatsApp' }).click();
  await send.getByRole('button', { name: 'שלח', exact: true }).click();
  await expect(send.locator('[data-send-results] li')).toHaveCount(6);
  await expect(send.locator('[data-send-results] li svg.text-rose-600')).toHaveCount(0);

  // Mailpit: one mail per supplier, the PDF really attached.
  await expect.poll(async () => (await (await request.get(`${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`e2e-${RUN}`)}`)).json()).messages_count, { timeout: 20_000 }).toBe(2);
  const list = (await (await request.get(`${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`e2e-${RUN}`)}`)).json()) as { messages: Array<{ ID: string }> };
  const msg = (await (await request.get(`${MAILPIT_URL}/api/v1/message/${list.messages[0].ID}`)).json()) as {
    Subject: string; Text: string; Attachments: Array<{ FileName: string; ContentType: string }>;
  };
  expect(msg.Subject).toContain(`בקשה להצעת מחיר מספר ${START_RFQ}`);
  expect(msg.Attachments.map((a) => a.ContentType)).toContain('application/pdf');
  expect(msg.Text).toMatch(/\/quote\/[A-Za-z0-9_-]{43}/);

  // The typed supplier got its own mail (PDF attached, its own personal link) and WhatsApp.
  await expect.poll(async () => (await (await request.get(`${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`typed-${RUN}`)}`)).json()).messages_count, { timeout: 20_000 }).toBe(1);
  const typedList = (await (await request.get(`${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`typed-${RUN}`)}`)).json()) as { messages: Array<{ ID: string }> };
  const typedMsg = (await (await request.get(`${MAILPIT_URL}/api/v1/message/${typedList.messages[0].ID}`)).json()) as {
    Text: string; Attachments: Array<{ ContentType: string }>;
  };
  expect(typedMsg.Attachments.map((a) => a.ContentType)).toContain('application/pdf');
  expect(typedMsg.Text).toMatch(/\/quote\/[A-Za-z0-9_-]{43}/);
  const typedWa = (await (await request.get(`${GREEN}/__messages?chatId=${encodeURIComponent('972507654321@c.us')}`)).json()) as {
    messages: Array<{ message: string; fileName?: string }>;
  };
  expect(typedWa.messages.some((m) => /\/quote\/[A-Za-z0-9_-]{43}/.test(m.message))).toBe(true);
  expect(typedWa.messages.some((m) => m.fileName?.endsWith('.pdf'))).toBe(true);
  // Its recipient row carries its details — and no supplier row was created.
  const rec = await pool.query(`select supplier_id, supplier_name, supplier_phone, supplier_email from public.purchasing_rfq_recipients where rfq_id = $1 and supplier_id is null`, [await docId('rfq', START_RFQ)]);
  expect(rec.rows).toHaveLength(1);
  expect(rec.rows[0]).toMatchObject({ supplier_name: TYPED_SUPPLIER, supplier_phone: '050-7654321', supplier_email: `typed-${RUN}@example.com` });
  expect((await pool.query(`select 1 from public.suppliers where display_name = $1 or company_name = $1`, [TYPED_SUPPLIER])).rowCount).toBe(0);

  // The Green stand-in: the message with the link, then the PDF as a file.
  const wa = (await (await request.get(`${GREEN}/__messages?chatId=${encodeURIComponent(CHAT_A)}`)).json()) as {
    messages: Array<{ message: string; fileName?: string }>;
  };
  expect(wa.messages.some((m) => /\/quote\/[A-Za-z0-9_-]{43}/.test(m.message))).toBe(true);
  expect(wa.messages.some((m) => m.fileName?.endsWith('.pdf'))).toBe(true);

  // The log of the send is on the document.
  await page.keyboard.press('Escape');
  await page.locator('[data-doc-tab="log"]').click();
  await expect(page.locator('[data-dispatches] li')).toHaveCount(6);
});

test('the supplier\'s public link: submit, amend, then locked after the due date', async ({ browser }) => {
  const rfq = await docId('rfq', START_RFQ);
  const rec = await pool.query<{ token: string }>(
    `select token from public.purchasing_rfq_recipients where rfq_id = $1 and supplier_id = $2`, [rfq, made.suppliers[0]],
  );
  const link = `/quote/${rec.rows[0].token}`;

  // A stranger: no session at all.
  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await ctx.newPage();
  await page.goto(link);
  await expect(page.locator('[data-quote-heading]')).toHaveText(`בקשה להצעת מחיר מספר ${START_RFQ}`);
  await expect(page.getByText(SUP_A)).toBeVisible();
  await expect(page.getByText(SUP_B)).toHaveCount(0);

  // A unit price is required on EVERY line.
  const prices = page.getByLabel('מחיר ליחידה (₪)');
  await prices.nth(0).fill('10');
  await page.locator('[data-quote-submit]').click();
  await expect(page.locator('[data-quote-message="error"]')).toContainText('מחיר ליחידה בכל שורה');

  await prices.nth(1).fill('5');
  await expect(page.locator('[data-quote-subtotal]')).toHaveText('₪80.00'); // 3×10 + 10×5
  await page.locator('[data-quote-submit]').click();
  await expect(page.locator('[data-quote-message="ok"]')).toContainText('ההצעה נקלטה');

  // Amend: the same link, new price — still one quote.
  await prices.nth(1).fill('4');
  await page.getByRole('button', { name: 'עדכון ההצעה' }).click();
  await expect(page.locator('[data-quote-message="ok"]')).toBeVisible();
  const quotes = await pool.query(`select 1 from public.purchasing_quotes where rfq_id = $1 and supplier_id = $2`, [rfq, made.suppliers[0]]);
  expect(quotes.rowCount).toBe(1);
  const unit = await pool.query<{ unit_price: string }>(
    `select ql.unit_price from public.purchasing_quote_lines ql
       join public.purchasing_quotes q on q.id = ql.quote_id
       join public.purchasing_lines l on l.id = ql.line_id
      where q.rfq_id = $1 and q.supplier_id = $2 order by l.sort_order`, [rfq, made.suppliers[0]],
  );
  expect(unit.rows.map((r) => Number(r.unit_price))).toEqual([10, 4]);

  // The day after the due date: read-only.
  await pool.query(`update public.purchasing_documents set due_date = '2000-01-01' where id = $1`, [rfq]);
  await page.reload();
  await expect(page.locator('[data-quote-locked]')).toBeVisible();
  await expect(page.locator('[data-quote-submit]')).toHaveCount(0);
  await expect(prices.nth(0)).toBeDisabled();
  await expect(prices.nth(0)).toHaveValue('10');
  // And the server agrees, whatever the page does.
  const put = await ctx.request.put(`/api/public/quote/${rec.rows[0].token}`, { data: { prices: {} } });
  expect(put.status()).toBe(403);

  // A wrong link is a plain "not valid" page, nothing else.
  await page.goto(`/quote/${'z'.repeat(43)}`);
  await expect(page.locator('[data-quote-missing]')).toBeVisible();
  await ctx.close();

  // Reopen for the next steps (the staff extends the date).
  await pool.query(`update public.purchasing_documents set due_date = '2099-01-01' where id = $1`, [rfq]);
});

test('the typed supplier\'s own personal link: submit a quote, no supplier row involved', async ({ browser }) => {
  const rfq = await docId('rfq', START_RFQ);
  const rec = await pool.query<{ token: string }>(
    `select token from public.purchasing_rfq_recipients where rfq_id = $1 and supplier_id is null`, [rfq],
  );
  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await ctx.newPage();
  await page.goto(`/quote/${rec.rows[0].token}`);
  await expect(page.locator('[data-quote-heading]')).toHaveText(`בקשה להצעת מחיר מספר ${START_RFQ}`);
  await expect(page.getByText(TYPED_SUPPLIER)).toBeVisible();
  const prices = page.getByLabel('מחיר ליחידה (₪)');
  await prices.nth(0).fill('11');
  await prices.nth(1).fill('6');
  await page.locator('[data-quote-submit]').click();
  await expect(page.locator('[data-quote-message="ok"]')).toContainText('ההצעה נקלטה');
  await ctx.close();
  const q = await pool.query(`select supplier_id, supplier_name, supplier_email from public.purchasing_quotes where rfq_id = $1 and supplier_id is null`, [rfq]);
  expect(q.rows).toHaveLength(1);
  expect(q.rows[0]).toMatchObject({ supplier_name: TYPED_SUPPLIER, supplier_email: `typed-${RUN}@example.com` });
});

test('the comparison, the winner — and a purchase order from it (no "quote outside the system")', async ({ page, browser }) => {
  const rfq = await docId('rfq', START_RFQ);
  // Supplier B answers through ITS OWN link: 3×9 + 10×5 = 77.
  const recB = await pool.query<{ token: string }>(
    `select token from public.purchasing_rfq_recipients where rfq_id = $1 and supplier_id = $2`, [rfq, made.suppliers[1]],
  );
  const ls = await pool.query<{ id: string }>(`select id from public.purchasing_lines where document_id = $1 order by sort_order`, [rfq]);
  const anon = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const sent = await anon.request.put(`/api/public/quote/${recB.rows[0].token}`, {
    data: { prices: { [ls.rows[0].id]: 9, [ls.rows[1].id]: 5 } },
  });
  expect(sent.status()).toBe(200);
  await anon.close();

  await page.goto('/purchasing');
  await page.locator(`tr[data-number="${START_RFQ}"]`).click();
  await expect(page.getByRole('heading', { name: `בקשה להצעת מחיר מספר ${START_RFQ}` })).toBeVisible();
  // The "quote received outside the system" flow is gone.
  await expect(page.getByRole('button', { name: 'הצעה מחוץ למערכת' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'הזנת הצעה' })).toHaveCount(0);

  // Comparison: A (3×10 + 10×4 = 70) vs B (77). Cheapest = A.
  await page.locator('[data-doc-tab="compare"]').click();
  const cmp = page.locator('[data-comparison]');
  await expect(cmp).toContainText('₪70.00');
  await expect(cmp).toContainText('₪77.00');
  await expect(cmp).toContainText('₪93.00'); // the typed supplier: 3×11 + 10×6
  await expect(cmp.locator('thead th')).toContainText([/פריט/, new RegExp(SUP_A), new RegExp(TYPED_SUPPLIER), new RegExp(SUP_B)]);
  await expect(cmp.getByText('הזול ביותר')).toHaveCount(1);
  await expect(cmp.locator('td.bg-emerald-100')).toContainText('₪70.00');

  // Pick the winner → recorded with who and when.
  await cmp.getByRole('button', { name: 'בחר כזוכה' }).first().click();
  await expect(page.locator('[data-winner]')).toContainText(SUP_A);
  const row = await pool.query(`select winner_supplier_id, winner_chosen_by, winner_chosen_at from public.purchasing_documents where id = $1`, [rfq]);
  expect(row.rows[0].winner_supplier_id).toBe(made.suppliers[0]);
  expect(row.rows[0].winner_chosen_by).not.toBeNull();
  expect(row.rows[0].winner_chosen_at).not.toBeNull();

  // Purchase order from the winner: supplier + lines + prices copied, editable.
  await page.getByRole('button', { name: 'פתח הזמנת רכש' }).click();
  // (the tab sits behind the open panel, outside the accessibility tree)
  await expect(page.locator('[data-tab="po"]')).toHaveAttribute('aria-selected', 'true');
  const form = sheet(page);
  await expect(form.locator('[data-form-heading]')).toContainText('הזמנת רכש מספר');
  await expect(form.getByText(`מבקשה מספר ${START_RFQ}`)).toBeVisible();
  await expect(form.locator('#doc-supplier')).toHaveValue(SUP_A);
  await expect(page.locator('[data-line="0"] input[inputmode="decimal"]').nth(1)).toHaveValue('10');
  await expect(page.locator('[data-line="1"] input[inputmode="decimal"]').nth(1)).toHaveValue('4');
  // The first purchase order: it asks where to start.
  await form.locator('#doc-start').fill(String(START_PO));
  // Totals with the 18% VAT: 70 + 12.60 = 82.60.
  await expect(form.locator('[data-totals]')).toContainText('₪70.00');
  await expect(form.locator('[data-totals]')).toContainText('₪12.60');
  await expect(form.locator('[data-totals]')).toContainText('₪82.60');
  await form.getByRole('button', { name: 'הפק את המסמך' }).click();

  await expect(page.getByRole('heading', { name: `הזמנת רכש מספר ${START_PO}` })).toBeVisible();
  const detail = page.getByRole('dialog').filter({ has: page.locator('[data-doc-details]') });
  await expect(detail.locator('[data-totals]')).toContainText('₪82.60');
  await expect(detail.locator('[data-doc-details]')).toContainText(`מספר ${START_RFQ}`); // opened from the request
  const poId = await docId('po', START_PO);
  const po = await pool.query(`select vat_rate::float8 as vat, source_rfq_id, supplier_id from public.purchasing_documents where id = $1`, [poId]);
  expect(po.rows[0]).toMatchObject({ vat: 18, source_rfq_id: rfq, supplier_id: made.suppliers[0] });
});

test('the document panel: actions in the header (delete right; PDF · print · edit · send left, send last), three tabs, print opens the print dialog', async ({ page }) => {
  // Count print dialogs: the PDF is printed from a hidden frame, so the frame's
  // window.print is what must fire (headless Chromium has no real dialog).
  await page.addInitScript(() => {
    const w = window as unknown as { __prints: number };
    w.__prints = 0;
    const orig = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow')!;
    Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
      get() {
        const real = orig.get!.call(this) as Window | null;
        if (!real) return real;
        return new Proxy(real, {
          get(t, k) {
            if (k === 'print') return () => { w.__prints += 1; };
            const v = Reflect.get(t, k);
            return typeof v === 'function' ? v.bind(t) : v;
          },
        });
      },
    });
  });
  await page.goto('/purchasing');
  await page.locator(`tr[data-number="${START_RFQ}"]`).click();
  const panel = page.getByRole('dialog').filter({ has: page.locator('[data-doc-actions]') });
  await expect(panel.locator('[data-doc-details]')).toBeVisible();

  // Order on screen (RTL → larger x = further right): delete is rightmost, send is leftmost.
  const xs = async (action: string) => {
    const box = await panel.locator(`[data-action="${action}"]`).boundingBox();
    expect(box, action).not.toBeNull();
    return box!.x;
  };
  const [del, view, dl, print, edit, send] = await Promise.all(['delete', 'view-pdf', 'download-pdf', 'print', 'edit', 'send'].map(xs));
  expect(del).toBeGreaterThan(view);
  expect(view).toBeGreaterThan(dl);
  expect(dl).toBeGreaterThan(print);
  expect(print).toBeGreaterThan(edit);
  expect(edit).toBeGreaterThan(send);
  // The footer is gone — nothing but the header acts on the document.
  await expect(panel.locator('footer')).toHaveCount(0);

  // Print: no download, no new tab, the print dialog is requested once.
  const pagesBefore = page.context().pages().length;
  await panel.locator('[data-action="print"]').click();
  // (headless Chromium has no inline PDF viewer, so the frame never reports `load` — the helper prints after 2.5s)
  await expect(page.getByText('ההדפסה נכשלה')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __prints: number }).__prints), { timeout: 10_000 }).toBe(1);
  expect(page.context().pages().length).toBe(pagesBefore);

  // Tabs: document (default) · comparison (request only) · send log.
  await expect(panel.locator('[data-doc-tab]')).toHaveText([/מסמך/, /השוואת הצעות/, /יומן שליחות/]);
  await expect(panel.locator('[data-doc-tab="document"]')).toHaveAttribute('aria-selected', 'true');
  await expect(panel.locator('[data-doc-details]')).toBeVisible();
  await expect(panel.locator('[data-comparison]')).toHaveCount(0);
  await panel.locator('[data-doc-tab="compare"]').click();
  await expect(panel.locator('[data-comparison]')).toBeVisible();
  await expect(panel.locator('[data-doc-details]')).toHaveCount(0);
  // The winner (chosen in the comparison test, from this same tab) and the shortcut to the order live here.
  await expect(panel.locator('[data-winner]')).toBeVisible();
  await expect(panel.getByRole('button', { name: 'פתח הזמנת רכש' })).toBeVisible();
  await panel.locator('[data-doc-tab="log"]').click();
  await expect(panel.locator('[data-dispatches]')).toBeVisible();
  await expect(panel.locator('[data-comparison]')).toHaveCount(0);

  // A purchase order has no comparison tab.
  await page.keyboard.press('Escape');
  await page.locator('[data-tab="po"]').click();
  await page.locator('tbody tr[data-number]').first().click();
  const po = page.getByRole('dialog').filter({ has: page.locator('[data-doc-actions]') });
  await expect(po.locator('[data-doc-tab]')).toHaveText([/מסמך/, /יומן שליחות/]);
});

test('phone width: the tabs stay on one row and the actions fit the header', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/purchasing');
  await page.locator(`tr[data-number="${START_RFQ}"]`).click();
  const panel = page.getByRole('dialog').filter({ has: page.locator('[data-doc-actions]') });
  const tabs = panel.locator('[data-doc-tab]');
  await expect(tabs).toHaveCount(3);
  const ys = await tabs.evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().y)));
  expect(new Set(ys).size).toBe(1);
  for (const a of ['delete', 'print', 'edit', 'send']) {
    const box = await panel.locator(`[data-action="${a}"]`).boundingBox();
    expect(box!.height, a).toBeGreaterThanOrEqual(44);
  }
  // The panel itself never scrolls sideways (the list's own table, behind it, is a separate scroller).
  expect(await panel.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  // (after the slide-in has settled)
  await expect.poll(async () => {
    const b = await panel.locator('[data-doc-actions]').boundingBox();
    return b ? Math.round(b.x) >= 0 && Math.round(b.x + b.width) <= 390 : false;
  }).toBe(true);
});

test('a direct purchase order, the VAT stamped at issue, and the PDF', async ({ page, request }) => {
  await page.goto('/purchasing?tab=po');
  await page.getByRole('button', { name: 'הזמנה חדשה' }).click();
  const form = sheet(page);
  await expect(page.locator('[data-doc-number]')).toHaveText(String(START_PO + 1));
  await form.locator('#doc-supplier').fill(SUP_B.slice(0, 7));
  await page.getByRole('option', { name: SUP_B }).click();
  await form.locator('#doc-title').fill('חומרי ניקוי');
  await fillLine(page, 0, 'נוזל רצפות', '2', '25');
  await expect(form.locator('[data-totals]')).toContainText('₪59.00'); // 50 + 9 VAT
  await form.getByRole('button', { name: 'הפק את המסמך' }).click();
  await expect(page.getByRole('heading', { name: `הזמנת רכש מספר ${START_PO + 1}` })).toBeVisible();
  const id = await docId('po', START_PO + 1);

  // Changing the company VAT later does not touch an issued document.
  await pool.query(
    `update public.app_settings set value = jsonb_set(value, '{vat_rate}', '17') where key = 'purchasing_company'`,
  );
  const stamped = await pool.query<{ vat: number }>(`select vat_rate::float8 as vat from public.purchasing_documents where id = $1`, [id]);
  expect(stamped.rows[0].vat).toBe(18);
  await page.reload();
  await page.locator(`tr[data-number="${START_PO + 1}"]`).click();
  await expect(page.getByRole('dialog').filter({ has: page.locator('[data-doc-details]') }).locator('[data-totals]')).toContainText('₪59.00');

  // The PDF: a real PDF, inline and as a download.
  const pdf = await request.get(`/api/purchasing/documents/${id}/pdf`);
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()['content-type']).toBe('application/pdf');
  const bytes = await pdf.body();
  expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
  expect(bytes.length).toBeGreaterThan(8_000);
  const dl = await request.get(`/api/purchasing/documents/${id}/pdf?download=1`);
  expect(dl.headers()['content-disposition']).toContain('attachment');
});

test('the typed supplier wins: the order opens with ITS details, is issued and sent to its e-mail', async ({ page, request }) => {
  await mailpitClear(request);
  await page.goto('/purchasing');
  await page.locator(`tr[data-number="${START_RFQ}"]`).click();
  await page.locator('[data-doc-tab="compare"]').click();
  const cmp = page.locator('[data-comparison]');
  // A is the current winner; columns are A, the typed supplier, B (submission order).
  await cmp.locator('tr', { hasText: 'הצעה זוכה' }).locator('td').nth(2).getByRole('button', { name: 'בחר כזוכה' }).click();
  await expect(page.locator('[data-winner]')).toContainText(TYPED_SUPPLIER);
  const rfq = await docId('rfq', START_RFQ);
  const w = await pool.query(`select winner_supplier_id, winner_chosen_by, winner_chosen_at from public.purchasing_documents where id = $1`, [rfq]);
  expect(w.rows[0].winner_supplier_id).toBeNull();
  expect(w.rows[0].winner_chosen_at).not.toBeNull();
  expect(w.rows[0].winner_chosen_by).not.toBeNull();

  await page.getByRole('button', { name: 'פתח הזמנת רכש' }).click();
  const form = sheet(page);
  await expect(form.locator('#doc-supplier')).toHaveValue(TYPED_SUPPLIER);
  await expect(form.locator('#doc-supplier-phone')).toHaveValue('050-7654321');
  await expect(form.locator('#doc-supplier-email')).toHaveValue(`typed-${RUN}@example.com`);
  await expect(form.locator('#doc-supplier-address')).toHaveValue('רחוב הבדיקה 1, חיפה');
  await expect(page.locator('[data-line="0"] input[inputmode="decimal"]').nth(1)).toHaveValue('11');
  await form.getByRole('button', { name: 'הפק את המסמך' }).click();
  await expect(page.getByRole('heading', { name: `הזמנת רכש מספר ${START_PO + 2}` })).toBeVisible();
  const poId = await docId('po', START_PO + 2);
  const po = await pool.query(`select supplier_id, supplier_name, supplier_phone, supplier_email, source_rfq_id from public.purchasing_documents where id = $1`, [poId]);
  expect(po.rows[0]).toMatchObject({
    supplier_id: null, supplier_name: TYPED_SUPPLIER, supplier_phone: '050-7654321', supplier_email: `typed-${RUN}@example.com`, source_rfq_id: rfq,
  });

  // The order goes to ITS supplier only — the typed one, by the e-mail on the document.
  await page.getByRole('button', { name: 'שליחה' }).click();
  const sendSheet = sheet(page);
  await expect(sendSheet.locator('[data-send-row]')).toHaveCount(1);
  await expect(sendSheet.locator('[data-send-row="manual"]')).toContainText(TYPED_SUPPLIER);
  await sendSheet.getByRole('button', { name: 'שלח', exact: true }).click();
  await expect(sendSheet.locator('[data-send-results] li')).toHaveCount(1);
  await expect(sendSheet.locator('[data-send-results] li svg.text-rose-600')).toHaveCount(0);
  await expect.poll(async () => (await (await request.get(`${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`typed-${RUN}`)}`)).json()).messages_count, { timeout: 20_000 }).toBe(1);
  const list = (await (await request.get(`${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`typed-${RUN}`)}`)).json()) as { messages: Array<{ ID: string }> };
  const msg = (await (await request.get(`${MAILPIT_URL}/api/v1/message/${list.messages[0].ID}`)).json()) as {
    Subject: string; Attachments: Array<{ ContentType: string }>;
  };
  expect(msg.Subject).toContain(`הזמנת רכש מספר ${START_PO + 2}`);
  expect(msg.Attachments.map((a) => a.ContentType)).toContain('application/pdf');
  expect((await pool.query(`select 1 from public.suppliers where display_name = $1 or company_name = $1`, [TYPED_SUPPLIER])).rowCount).toBe(0);
});

test('a channel the typed supplier has no detail for is blocked with a plain message — never a server error', async ({ page, request }) => {
  const NAME = `ספק חסום ${RUN}`;
  const made1 = await request.post('/api/purchasing/documents', {
    data: {
      doc_type: 'rfq', doc_date: '2026-10-22', title: `חסום ${RUN}`, supplier_name: NAME, due_date: '2099-01-01',
      lines: [{ description: 'שורה', quantity: 1, unit_price: null }],
    },
  });
  expect(made1.status()).toBe(201);
  const id = (await made1.json()).id as string;
  made.docs.push(id);

  await page.goto('/purchasing');
  await page.locator('tr', { hasText: NAME }).click();
  await page.getByRole('button', { name: 'שליחה' }).click();
  const sendSheet = sheet(page);
  await sendSheet.getByRole('checkbox', { name: NAME }).click();
  // E-mail is on by default and the document has no e-mail.
  await expect(sendSheet.locator('[data-send-blocked]')).toContainText('אין מייל');
  await expect(sendSheet.getByRole('button', { name: 'שלח', exact: true })).toBeDisabled();
  await sendSheet.getByRole('checkbox', { name: 'WhatsApp' }).click();
  await expect(sendSheet.locator('[data-send-blocked]')).toContainText('טלפון ל-WhatsApp');
  await sendSheet.getByRole('checkbox', { name: 'מייל', exact: true }).click(); // e-mail off, WhatsApp still blocked
  await expect(sendSheet.locator('[data-send-blocked]')).toContainText('טלפון ל-WhatsApp');
  await expect(sendSheet.locator('[data-send-blocked]')).not.toContainText('מייל');

  // The API answers plainly too: per-channel results with the reason, not a 500.
  const res = await request.post(`/api/purchasing/documents/${id}/send`, { data: { supplier_ids: ['manual'], email: true, whatsapp: true } });
  expect(res.status()).toBeLessThan(500);
  const out = (await res.json()) as { results: Array<{ channel: string; ok: boolean; error?: string }> };
  expect(out.results.every((r) => !r.ok)).toBe(true);
  expect(out.results.find((r) => r.channel === 'email')?.error).toContain('אין כתובת מייל');
  expect(out.results.find((r) => r.channel === 'whatsapp')?.error).toContain('אין מספר טלפון');
  // 'manual' for a document whose supplier IS listed is refused.
  const listed = await pool.query<{ id: string }>(`select id from public.purchasing_documents where supplier_id = $1 limit 1`, [made.suppliers[0]]);
  if (listed.rows[0]) {
    const bad = await request.post(`/api/purchasing/documents/${listed.rows[0].id}/send`, { data: { supplier_ids: ['manual'], email: true, whatsapp: false } });
    expect(bad.status()).toBe(400);
  }
});

test('the module is closed to anyone who is not a super admin and to anonymous callers', async ({ browser }) => {
  const anon = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  for (const url of ['/api/purchasing/documents?type=rfq', '/api/purchasing/company', '/api/purchasing/suppliers']) {
    expect((await anon.request.get(url)).status(), url).toBe(401);
  }
  // The proxy for its files: unauthenticated is 401, never the bytes.
  expect((await anon.request.get('/api/files/purchasing-files/00000000-0000-4000-8000-000000000001.pdf')).status()).toBe(401);
  await anon.close();
});

test('a request needs its subject; one that predates the rule stays editable while its subject stays empty', async ({ request }) => {
  const NAME = `ספק נושא ${RUN}`;
  const lines = [{ description: 'שורה', quantity: 1, unit_price: null }];

  // Creating a request without a subject is refused, and nothing is written.
  const none = await request.post('/api/purchasing/documents', {
    data: { doc_type: 'rfq', doc_date: '2026-10-22', supplier_name: NAME, due_date: '2099-01-01', lines },
  });
  expect(none.status()).toBe(400);
  expect((await pool.query(`select 1 from public.purchasing_documents where supplier_name = $1`, [NAME])).rowCount).toBe(0);

  // A request issued before the rule: no subject. Editing it without one is accepted…
  const legacy = await pool.query<{ id: string }>(
    `insert into public.purchasing_documents (doc_type, number, status, doc_date, supplier_name, due_date, vat_rate)
     values ('rfq', 777001, 'issued', '2026-10-22', $1, '2099-01-01', 18) returning id`,
    [NAME],
  );
  const id = legacy.rows[0].id;
  made.docs.push(id);
  const body = { doc_date: '2026-10-22', supplier_name: NAME, due_date: '2099-01-01', notes: '' };
  expect((await request.patch(`/api/purchasing/documents/${id}`, { data: { ...body, title: '' } })).status()).toBe(200);

  // …giving it a subject is fine, and from then on the subject cannot be emptied.
  expect((await request.patch(`/api/purchasing/documents/${id}`, { data: { ...body, title: `נושא ${RUN}` } })).status()).toBe(200);
  const emptied = await request.patch(`/api/purchasing/documents/${id}`, { data: { ...body, title: '' } });
  expect(emptied.status()).toBe(400);
  expect((await emptied.json()).error).toBe('יש להזין נושא לבקשה');
});
