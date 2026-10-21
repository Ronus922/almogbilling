import { test, expect, type Page } from '@playwright/test';
import { Pool } from 'pg';
import { MAILPIT_URL, mailpitClear, saveSmtpSettings } from './helpers';

// Purchasing ("רכש", 21/10/2026), driven as the seeded super admin through the
// real screens, end to end:
//   wizard (company letterhead, once) → first request asks "from which number"
//   → running numbers → send by e-mail (PDF attached, Mailpit) and WhatsApp
//   (message + file, the Green stand-in) → the supplier's PUBLIC link: submit,
//   amend, locked after the due date → a quote received outside the system →
//   comparison + cheapest flag + winner → purchase order from the winner
//   (prefilled, totals with the VAT stamped at issue) → a direct purchase order
//   → the PDF.
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
        where id = any($1::uuid[]) or supplier_id = any($2::uuid[]) or title like $3`,
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
  // so it asks where to start; the date is today and not editable.
  await expect(sheet(page).getByText('בקשה להצעת מחיר חדשה')).toBeVisible();
  await expect(page.locator('#doc-start')).toBeVisible();
  await expect(sheet(page).getByText('זה בקשה להצעת מחיר הראשונה')).toBeVisible();

  await page.locator('#doc-start').fill(String(START_RFQ));
  await page.locator('#doc-title').fill(RFQ_TITLE);
  await fillLine(page, 0, 'צבע אקרילי לבן', '3');
  await page.getByRole('button', { name: 'הוספת שורה' }).click();
  await fillLine(page, 1, 'רולר צביעה', '10');
  await page.getByRole('button', { name: 'הפק מסמך' }).click();

  await expect(page.getByRole('heading', { name: `בקשה להצעת מחיר מספר ${START_RFQ}` })).toBeVisible();
  await docId('rfq', START_RFQ);

  // The company is saved: a second visit does not ask again.
  const co = await pool.query(`select value from public.app_settings where key = 'purchasing_company'`);
  expect(co.rows[0].value.vat_rate).toBe(18);
});

test('the number runs on by itself, is not editable, and "פירוט" completes from earlier lines', async ({ page }) => {
  await page.goto('/purchasing');
  await page.getByRole('button', { name: 'בקשה חדשה' }).click();
  await expect(page.locator('#doc-start')).toHaveCount(0); // the series already runs
  await expect(page.locator('[data-doc-number]')).toHaveText(`יוקצה בשמירה (${START_RFQ + 1})`);

  await page.locator('#doc-title').fill(`בקשה שנייה ${RUN}`);
  const desc = page.locator('[data-line="0"]').getByPlaceholder('פירוט');
  await desc.fill('צבע אקר');
  await page.getByRole('option', { name: 'צבע אקרילי לבן' }).click();
  await expect(desc).toHaveValue('צבע אקרילי לבן');
  await page.locator('[data-line="0"] input[inputmode="decimal"]').first().fill('1');
  await page.getByRole('button', { name: 'הפק מסמך' }).click();
  await expect(page.getByRole('heading', { name: `בקשה להצעת מחיר מספר ${START_RFQ + 1}` })).toBeVisible();
  await docId('rfq', START_RFQ + 1);
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
  await send.getByRole('checkbox', { name: 'WhatsApp' }).click();
  await send.getByRole('button', { name: 'שלח', exact: true }).click();
  await expect(send.locator('[data-send-results] li')).toHaveCount(4);
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

  // The Green stand-in: the message with the link, then the PDF as a file.
  const wa = (await (await request.get(`${GREEN}/__messages?chatId=${encodeURIComponent(CHAT_A)}`)).json()) as {
    messages: Array<{ message: string; fileName?: string }>;
  };
  expect(wa.messages.some((m) => /\/quote\/[A-Za-z0-9_-]{43}/.test(m.message))).toBe(true);
  expect(wa.messages.some((m) => m.fileName?.endsWith('.pdf'))).toBe(true);

  // The log of the send is on the document.
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-dispatches] li')).toHaveCount(4);
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

test('a quote received outside the system, the comparison, the winner — and a purchase order from it', async ({ page }) => {
  await page.goto('/purchasing');
  await page.locator(`tr[data-number="${START_RFQ}"]`).click();
  await expect(page.getByRole('heading', { name: `בקשה להצעת מחיר מספר ${START_RFQ}` })).toBeVisible();

  // Supplier B's offer arrived by e-mail: keyed in as a lump sum, no lines.
  await page.getByRole('button', { name: 'הזנת הצעה' }).last().click();
  const manual = sheet(page);
  await expect(manual.getByText('הצעה שהתקבלה מחוץ למערכת')).toBeVisible();
  await manual.locator('#mq-total').fill('400');
  await manual.getByRole('button', { name: 'שמור הצעה' }).click();
  await expect(page.locator(`[data-recipient="${made.suppliers[1]}"]`)).toContainText('הוזנה ידנית');

  // Comparison: A (lines: 3×10 + 10×4 = 70) vs B (lump sum 400). Cheapest = A.
  const cmp = page.locator('[data-comparison]');
  await expect(cmp).toContainText('₪70.00');
  await expect(cmp).toContainText('₪400.00');
  await expect(cmp).toContainText('סכום כולל, ללא שורות');
  await expect(cmp.getByText('הזול ביותר')).toHaveCount(1);
  await expect(cmp.locator('td.bg-emerald-100')).toContainText('₪70.00');

  // Pick the winner → recorded with who and when.
  await cmp.getByRole('button', { name: 'בחר כזוכה' }).first().click();
  await expect(page.locator('[data-winner]')).toContainText(SUP_A);
  const rfq = await docId('rfq', START_RFQ);
  const row = await pool.query(`select winner_supplier_id, winner_chosen_by, winner_chosen_at from public.purchasing_documents where id = $1`, [rfq]);
  expect(row.rows[0].winner_supplier_id).toBe(made.suppliers[0]);
  expect(row.rows[0].winner_chosen_by).not.toBeNull();
  expect(row.rows[0].winner_chosen_at).not.toBeNull();

  // Purchase order from the winner: supplier + lines + prices copied, editable.
  await page.getByRole('button', { name: 'פתח הזמנת רכש' }).click();
  // (the tab sits behind the open panel, outside the accessibility tree)
  await expect(page.locator('[data-tab="po"]')).toHaveAttribute('aria-selected', 'true');
  const form = sheet(page);
  await expect(form.getByText('הזמנת רכש מהצעה זוכה')).toBeVisible();
  await expect(form.locator('#doc-supplier')).toContainText(SUP_A);
  await expect(page.locator('[data-line="0"] input[inputmode="decimal"]').nth(1)).toHaveValue('10');
  await expect(page.locator('[data-line="1"] input[inputmode="decimal"]').nth(1)).toHaveValue('4');
  // The first purchase order: it asks where to start.
  await form.locator('#doc-start').fill(String(START_PO));
  // Totals with the 18% VAT: 70 + 12.60 = 82.60.
  await expect(form.locator('[data-totals]')).toContainText('₪70.00');
  await expect(form.locator('[data-totals]')).toContainText('₪12.60');
  await expect(form.locator('[data-totals]')).toContainText('₪82.60');
  await form.getByRole('button', { name: 'הפק מסמך' }).click();

  await expect(page.getByRole('heading', { name: `הזמנת רכש מספר ${START_PO}` })).toBeVisible();
  const detail = page.getByRole('dialog').filter({ has: page.locator('[data-doc-details]') });
  await expect(detail.locator('[data-totals]')).toContainText('₪82.60');
  await expect(detail.locator('[data-doc-details]')).toContainText(`מספר ${START_RFQ}`); // opened from the request
  const poId = await docId('po', START_PO);
  const po = await pool.query(`select vat_rate::float8 as vat, source_rfq_id, supplier_id from public.purchasing_documents where id = $1`, [poId]);
  expect(po.rows[0]).toMatchObject({ vat: 18, source_rfq_id: rfq, supplier_id: made.suppliers[0] });
});

test('a direct purchase order, the VAT stamped at issue, and the PDF', async ({ page, request }) => {
  await page.goto('/purchasing?tab=po');
  await page.getByRole('button', { name: 'הזמנה חדשה' }).click();
  const form = sheet(page);
  await expect(page.locator('[data-doc-number]')).toHaveText(`יוקצה בשמירה (${START_PO + 1})`);
  await form.locator('#doc-supplier').click();
  await page.getByText(SUP_B).last().click();
  await form.locator('#doc-title').fill('חומרי ניקוי');
  await fillLine(page, 0, 'נוזל רצפות', '2', '25');
  await expect(form.locator('[data-totals]')).toContainText('₪59.00'); // 50 + 9 VAT
  await form.getByRole('button', { name: 'הפק מסמך' }).click();
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

test('the module is closed to anyone who is not a super admin and to anonymous callers', async ({ browser }) => {
  const anon = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  for (const url of ['/api/purchasing/documents?type=rfq', '/api/purchasing/company', '/api/purchasing/suppliers']) {
    expect((await anon.request.get(url)).status(), url).toBe(401);
  }
  // The proxy for its files: unauthenticated is 401, never the bytes.
  expect((await anon.request.get('/api/files/purchasing-files/00000000-0000-4000-8000-000000000001.pdf')).status()).toBe(401);
  await anon.close();
});
