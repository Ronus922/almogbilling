import fs from 'node:fs';
import { test, expect, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import { Pool } from 'pg';
import { MAILPIT_URL, mailpitClear, saveSmtpSettings } from './helpers';

// Purchasing ("רכש"), driven as the seeded super admin through the real screens, end to end:
//   wizard (company letterhead, once) → the ONE form: heading with the next number, a request picks
//   its suppliers as chips (listed or hand-typed, any number) and ticks how to send it (e-mail /
//   WhatsApp, none by default) → issuing sends in the same step, then THE FORM CLOSES: a toast
//   tells the outcome and the table is visible (no window is ever opened above another one).
//   Nothing ticked → no sending; each supplier's PDF is reached from the row icons of the table.
//   List rows: a double-click opens the document window; the icons download / print / send are
//   on the row (a request with several suppliers: a small popover menu lists them; the send icon
//   opens the window on its suppliers card). The window: fixed bottom bar, tabs מסמך | השוואת
//   הצעות | יומן שליחות, an inline "הוסף ספק" panel (people-picker + send-by + שלח) usable while
//   the request is open. The supplier's PUBLIC page has a "before VAT / including VAT" toggle
//   (the server stores price_mode, the typed numbers and the NORMALISED before-VAT prices; the
//   comparison always reads before-VAT) → comparison with the cheapest cells highlighted → winner
//   → purchase order from the winner. DRAFTS live on the server (no number until issued).
// Storage is unreachable in CI, so nothing here uploads a file (the file rules are locked by
// tests/purchasing-public-route.test.ts and tests/purchasing-rbac-route.test.ts).
//
// With E2E_PROOF_DIR=/var/billing-proof/rfq-v2 the key screens are saved there (outside the repo).
// Fixtures are removed by the exact ids recorded here (CLAUDE.md iron rule 12); the company
// setting and the two number series are restored to what they were.

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
pool.on('error', () => undefined);

const RUN = Date.now().toString().slice(-7);
const GREEN = `http://127.0.0.1:${process.env.E2E_GREENAPI_PORT ?? '3110'}`;
// Only when E2E_PROOF_DIR is set (never in CI): the screenshots are a local review aid.
const PROOF = process.env.E2E_PROOF_DIR ?? '';
const SUP_A = `ספק א׳ ${RUN}`;
const SUP_B = `ספק ב׳ ${RUN}`;
const MOBILE_A = `05${RUN.slice(0, 8).padEnd(8, '1')}`;
const MOBILE_B = `05${RUN.slice(0, 8).padEnd(8, '2')}`;
const CHAT_A = `972${MOBILE_A.slice(1)}@c.us`;
const CHAT_B = `972${MOBILE_B.slice(1)}@c.us`;
const RFQ_TITLE = `חידוש צבע ${RUN}`;
const TYPED_SUPPLIER = `ספק חופשי ${RUN}`;
const START_RFQ = 500;
const START_PO = 70;
const LINK_RE = /\/quote\/[A-Za-z0-9_-]{43}/;

// The "image" request: three hand-typed suppliers named like the design, one quote each.
const VAT_TITLE = `עבודות צבע בחדר מדרגות — בניין אלמוג ${RUN}`;
const VAT_LINES = ['צביעת קירות חדר מדרגות — 5 קומות', 'תיקוני טיח וגבס לפני צביעה', 'צביעת מעקות מתכת'];
const VAT_SUPPLIERS = [
  { name: 'רונן', phone: `050-${RUN}` },
  { name: 'צבע דני חומרי בניין', phone: `052-${RUN}` },
  { name: 'עופר שזק', phone: `054-${RUN}` },
] as const;

const made = { suppliers: [] as string[], docs: [] as string[] };
let priorCompany: unknown = null;
let hadCompany = false;
let priorSequences: Array<{ doc_type: string; last_number: number }> = [];
// Green's media host is derived from the API host; the stand-in has no `api.`
// to swap, so the seeded instance is pointed at it explicitly for this spec.
let instanceMedia: { id: string; media_url: string | null } | null = null;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  if (PROOF) fs.mkdirSync(PROOF, { recursive: true });
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

/** The id of the document with this (RUN-tagged, unique) title, recorded for cleanup. */
async function docIdByTitle(title: string): Promise<string> {
  const r = await pool.query<{ id: string }>(`select id from public.purchasing_documents where title = $1`, [title]);
  expect(r.rows, `exactly one document titled ${title}`).toHaveLength(1);
  const id = r.rows[0].id;
  if (!made.docs.includes(id)) made.docs.push(id);
  return id;
}

const sheet = (page: Page) => page.getByRole('dialog').last();
const toastOf = (page: Page, text: string) => page.locator('[data-sonner-toast]').filter({ hasText: text }).first();
const shot = async (page: Page, name: string) => { if (PROOF) await page.screenshot({ path: `${PROOF}/${name}.png`, fullPage: true }); };

/** R1: after issuing / saving a draft the form is gone, no other window took its place, the table shows. */
async function expectBackOnTable(page: Page) {
  await expect(page.locator('[data-slot="sheet-content"]')).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  // The table (or, while the tab has no document yet, its empty-state card).
  await expect(page.locator('table[data-list], [data-empty]').first()).toBeVisible();
}

/** Clicks "הפק את המסמך", waits for the outcome toast and checks the form closed (R1). */
async function issueAndBack(page: Page, form: ReturnType<typeof sheet>, toastText: string) {
  await form.getByRole('button', { name: 'הפק את המסמך' }).click();
  await expect(toastOf(page, toastText)).toBeVisible({ timeout: 30_000 });
  await expectBackOnTable(page);
}

/** R3: a double-click on the row opens the document window; returns the window. */
async function openDoc(page: Page, row: string) {
  await page.locator(row).dblclick();
  const panel = page.getByRole('dialog').filter({ has: page.locator('[data-doc-actions]') });
  await expect(panel.locator('[data-doc-details]')).toBeVisible();
  return panel;
}
const byNumber = (n: number) => `tr[data-number="${n}"]`;
const byId = (id: string) => `tr[data-doc="${id}"]`;
/** The row's trash icon only asks: the delete happens on "מחק" in the confirmation (AlertDialog). */
const confirmDeletion = (page: Page) => page.getByRole('alertdialog').locator('[data-delete-confirm]').click();

/** Counts print dialogs (the PDF is printed from a hidden frame; headless has no real dialog). */
async function installPrintCounter(page: Page) {
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
}
const prints = (page: Page) => page.evaluate(() => (window as unknown as { __prints: number }).__prints);

async function fillLine(page: Page, index: number, description: string, quantity: string, price?: string) {
  const row = page.locator(`[data-line="${index}"]`);
  await row.getByPlaceholder('פירוט').fill(description);
  await row.locator('input[inputmode="decimal"]').nth(0).fill(quantity);
  if (price !== undefined) await row.locator('input[inputmode="decimal"]').nth(1).fill(price);
}

const PICKER_PLACEHOLDER = 'חיפוש ספק או הקלדת שם';

/** Opens a supplier picker by its empty padding — a click in the middle of the field can land on a chip's X. */
async function openPicker(scope: ReturnType<Page['locator']>) {
  await scope.locator('#doc-suppliers').click({ position: { x: 6, y: 6 } });
}

/** Adds a supplier from the list to the chips (the picker stays open). */
async function addListedSupplier(page: Page, scope: ReturnType<Page['locator']>, name: string) {
  const search = page.getByPlaceholder(PICKER_PLACEHOLDER);
  if (!(await search.isVisible())) await openPicker(scope);
  await search.fill(name);
  await page.getByRole('option', { name }).click();
}

/** Adds a name that is NOT in the list as a chip of its own. */
async function addTypedSupplier(page: Page, scope: ReturnType<Page['locator']>, name: string) {
  const search = page.getByPlaceholder(PICKER_PLACEHOLDER);
  if (!(await search.isVisible())) await openPicker(scope);
  await search.fill(name);
  await page.locator('[data-picker-create]').click();
}

/** Closes the picker (Escape closes only the picker, not the sheet). */
async function closePicker(page: Page) {
  await page.keyboard.press('Escape');
  await expect(page.getByPlaceholder(PICKER_PLACEHOLDER)).toHaveCount(0);
}

/** A fresh request with the suppliers and ticks given, up to the issue click. */
async function fillRequest(
  page: Page,
  opts: {
    title: string; listed?: string[]; typed?: Array<{ name: string; phone?: string; email?: string }>;
    email?: boolean; whatsapp?: boolean; lines?: string[];
  },
) {
  await page.goto('/purchasing');
  await page.getByRole('button', { name: 'בקשה חדשה' }).click();
  const form = sheet(page);
  for (const n of opts.listed ?? []) await addListedSupplier(page, form, n);
  for (const t of opts.typed ?? []) await addTypedSupplier(page, form, t.name);
  await closePicker(page);
  for (const t of opts.typed ?? []) {
    const card = form.locator('[data-typed-supplier]', { hasText: t.name });
    if (t.phone) await card.locator('input[inputmode="tel"]').fill(t.phone);
    if (t.email) await card.locator('input[type="email"]').fill(t.email);
  }
  if (opts.email) await form.getByRole('checkbox', { name: 'מייל' }).click();
  if (opts.whatsapp) await form.getByRole('checkbox', { name: 'וואטסאפ' }).click();
  await form.locator('#doc-title').fill(opts.title);
  if (opts.lines) {
    for (const [i, d] of opts.lines.entries()) {
      if (i > 0) await page.getByRole('button', { name: 'הוסף', exact: true }).click();
      await fillLine(page, i, d, '1');
    }
  } else {
    await fillLine(page, 0, 'פריט בדיקה', '2');
  }
  return form;
}

const mailCount = async (request: APIRequestContext, q: string) =>
  (await (await request.get(`${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(q)}`)).json()).messages_count as number;
const greenMessages = async (request: APIRequestContext, chat: string) =>
  ((await (await request.get(`${GREEN}/__messages?chatId=${encodeURIComponent(chat)}`)).json()) as {
    messages: Array<{ message: string; fileName?: string }>;
  }).messages;

/** The supplier's own page, opened as a stranger (no session). */
async function supplierPage(browser: Browser, token: string, width = 700) {
  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] }, viewport: { width, height: 1500 }, locale: 'he-IL' });
  const page = await ctx.newPage();
  await page.goto(`/quote/${token}`);
  await expect(page.locator('[data-quote-heading]')).toBeVisible();
  return { ctx, page };
}
const quotePrices = (page: Page) => page.locator('[data-quote-lines] input[inputmode="decimal"]');
const tokenOf = async (rfq: string, name: string) =>
  (await pool.query<{ token: string }>(`select token from public.purchasing_rfq_recipients where rfq_id = $1 and supplier_name = $2`, [rfq, name])).rows[0].token;

/** The stored rows of one supplier's quote on a request: mode, typed prices and normalised prices, in line order. */
async function storedQuote(rfq: string, name: string) {
  const q = await pool.query<{ price_mode: string; unit_price: string; entered_unit_price: string }>(
    `select q.price_mode, ql.unit_price, ql.entered_unit_price
       from public.purchasing_quotes q
       join public.purchasing_quote_lines ql on ql.quote_id = q.id
       join public.purchasing_lines l on l.id = ql.line_id
      where q.rfq_id = $1 and q.supplier_name = $2 order by l.sort_order`, [rfq, name],
  );
  return {
    mode: q.rows[0]?.price_mode,
    normalised: q.rows.map((r) => Number(r.unit_price)),
    entered: q.rows.map((r) => Number(r.entered_unit_price)),
  };
}

test('nav, wizard and the first request: the letterhead once, then "from which number"', async ({ page, request }) => {
  await saveSmtpSettings(request);
  await mailpitClear(request);
  await request.post(`${GREEN}/__reset`);

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

  // At least one supplier is required — and so is the subject of a request
  // (a purchase order's description stays optional). Nothing is ticked by default.
  await page.locator('#doc-start').fill(String(START_RFQ));
  await fillLine(page, 0, 'צבע אקרילי לבן', '3');
  await expect(form.getByRole('checkbox', { name: 'מייל' })).not.toBeChecked();
  await expect(form.getByRole('checkbox', { name: 'וואטסאפ' })).not.toBeChecked();
  await form.getByRole('button', { name: 'הפק את המסמך' }).click();
  await expect(form.getByText('יש לבחור ספק אחד לפחות')).toBeVisible();
  await expect(form.getByText('יש להזין נושא לבקשה')).toBeVisible();
  // …and the form stays open on the problems.
  await expect(page.locator('[data-slot="sheet-content"]')).toHaveCount(1);

  // Three suppliers: two from the list and one typed by hand (its phone / e-mail
  // are entered under the field), then both channels ticked.
  await addListedSupplier(page, form, SUP_A);
  await addListedSupplier(page, form, SUP_B);
  await addTypedSupplier(page, form, TYPED_SUPPLIER);
  await closePicker(page);
  await expect(form.locator('[data-chip]')).toHaveCount(3);
  const typedCard = form.locator('[data-typed-supplier]');
  await expect(typedCard).toHaveCount(1); // only the typed supplier asks for details
  await typedCard.locator('input[inputmode="tel"]').fill('050-7654321');
  await form.getByRole('checkbox', { name: 'מייל' }).click();
  await form.getByRole('checkbox', { name: 'וואטסאפ' }).click();
  await page.locator('#doc-title').fill(RFQ_TITLE);
  await page.getByRole('button', { name: 'הוסף', exact: true }).click();
  await fillLine(page, 1, 'רולר צביעה', '10');

  // The typed supplier has a phone but no e-mail yet: a warning by its chip (never a block).
  const typedChip = form.locator('[data-chip]', { hasText: TYPED_SUPPLIER });
  await expect(typedChip.locator('[data-chip-warn]')).toContainText('אין מייל');
  await page.setViewportSize({ width: 1440, height: 2000 });
  await page.waitForTimeout(500);
  await shot(page, '02-form-filled');
  await page.setViewportSize({ width: 1280, height: 720 });
  await typedCard.locator('input[type="email"]').fill(`typed-${RUN}@example.com`);
  await expect(form.locator('[data-chip-warn]')).toHaveCount(0);

  // Issued AND sent in the same step; the form closes, ONE toast tells the outcome (3 suppliers).
  await issueAndBack(page, form, `בקשה להצעת מחיר מספר ${START_RFQ} הופקה ונשלחה ל-3 ספקים`);
  await expect(page.locator(byNumber(START_RFQ))).toContainText(RFQ_TITLE);
  const first = await docId('rfq', START_RFQ);
  // The request has no supplier of its own — its suppliers are its recipients; the ticks are kept.
  const doc = await pool.query(`select supplier_id, supplier_name, send_email, send_whatsapp from public.purchasing_documents where id = $1`, [first]);
  expect(doc.rows[0]).toMatchObject({ supplier_id: null, supplier_name: null, send_email: true, send_whatsapp: true });
  const recs = await pool.query(`select supplier_id, manual_key, supplier_name, supplier_phone, supplier_email from public.purchasing_rfq_recipients where rfq_id = $1`, [first]);
  expect(recs.rows).toHaveLength(3);
  expect(recs.rows.filter((r) => r.supplier_id !== null).map((r) => r.supplier_id).sort()).toEqual([...made.suppliers].sort());
  expect(recs.rows.find((r) => r.supplier_id === null)).toMatchObject({
    supplier_name: TYPED_SUPPLIER, supplier_phone: '050-7654321', supplier_email: `typed-${RUN}@example.com`,
  });
  // Never added to the suppliers list.
  expect((await pool.query(`select 1 from public.suppliers where display_name = $1 or company_name = $1`, [TYPED_SUPPLIER])).rowCount).toBe(0);

  // The requests list is told apart by SUBJECT: it has the column, and no supplier column
  // (a request goes to several suppliers — they live inside the request).
  await page.goto('/purchasing?tab=rfq');
  const rfqHead = page.locator('table[data-list="rfq"] th');
  await expect(rfqHead.filter({ hasText: 'נושא' })).toHaveCount(1);
  await expect(rfqHead.filter({ hasText: 'ספק' })).toHaveCount(0);
  await expect(page.locator(byNumber(START_RFQ))).toContainText(RFQ_TITLE);

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

  // The empty form, on the desktop sheet and on a phone.
  await page.setViewportSize({ width: 1440, height: 2000 });
  await page.waitForTimeout(500);
  await shot(page, '01-form-empty');
  await page.setViewportSize({ width: 430, height: 2600 });
  await page.waitForTimeout(500);
  await shot(page, '01-form-empty-phone');
  await page.setViewportSize({ width: 1280, height: 720 });

  // The supplier field searches the list; a listed supplier has no hand-typed details.
  await openPicker(form);
  await page.getByPlaceholder(PICKER_PLACEHOLDER).fill(SUP_B.slice(0, 7));
  await page.getByRole('option', { name: SUP_B }).click();
  await closePicker(page);
  await expect(form.locator('[data-chip]')).toHaveText([new RegExp(SUP_B)]);
  await expect(form.locator('[data-typed-supplier]')).toHaveCount(0);

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
      doc_type: 'rfq', doc_date: '2026-10-22', title: `תפוס ${RUN}`, recipients: [{ key: 'mtaken0001', name: TYPED_SUPPLIER }], due_date: '2099-01-01',
      lines: [{ description: 'שורה', quantity: 1, unit_price: null }],
    },
  });
  expect(taken.status()).toBe(201);
  await docId('rfq', START_RFQ + 1);

  // Nothing ticked: issued without sending; the toast names the number moved on to.
  await issueAndBack(page, form, `המספר ${START_RFQ + 1} נתפס בינתיים`);
  await expect(toastOf(page, 'הופקה בלי שליחה')).toBeVisible();
  await expect(page.locator(byNumber(START_RFQ + 2))).toBeVisible();
  await docId('rfq', START_RFQ + 2);
});

test('a draft is saved on the server with no number, opens from another session, and gets its number only when issued', async ({ page, browser }) => {
  await page.goto('/purchasing');
  await page.getByRole('button', { name: 'בקשה חדשה' }).click();
  const form = sheet(page);
  const seqNow = async () => (await pool.query(`select last_number from public.purchasing_sequences where doc_type = 'rfq'`)).rows[0].last_number as number;
  const seqBefore = await seqNow();
  const DRAFT_TITLE = `טיוטה ${RUN}`;
  await addListedSupplier(page, form, SUP_A);
  await addTypedSupplier(page, form, `ספק טיוטה ${RUN}`);
  await closePicker(page);
  await form.locator('[data-typed-supplier] input[inputmode="tel"]').fill('050-1112233');
  await form.getByRole('checkbox', { name: 'מייל' }).click();
  await page.locator('#doc-title').fill(DRAFT_TITLE);
  await fillLine(page, 0, 'פריט בטיוטה', '4');
  await form.getByRole('button', { name: 'שמור טיוטה' }).click();
  await expect(toastOf(page, 'הטיוטה נשמרה')).toBeVisible();
  // R1: the form is closed, the table shows, nothing else is open.
  await expectBackOnTable(page);

  // On the server: a draft row, no number, the series untouched.
  const row = await pool.query(`select id, status, number from public.purchasing_documents where title = $1`, [DRAFT_TITLE]);
  expect(row.rows[0]).toMatchObject({ status: 'draft', number: null });
  const draftId: string = row.rows[0].id;
  made.docs.push(draftId);
  // The draft keeps the chosen suppliers and the ticks.
  const draftRecs = await pool.query(`select supplier_id, supplier_name, supplier_phone from public.purchasing_rfq_recipients where rfq_id = $1`, [draftId]);
  expect(draftRecs.rows).toHaveLength(2);
  expect(draftRecs.rows.find((r) => r.supplier_id === null)).toMatchObject({ supplier_name: `ספק טיוטה ${RUN}`, supplier_phone: '050-1112233' });
  expect((await pool.query(`select send_email, send_whatsapp from public.purchasing_documents where id = $1`, [draftId])).rows[0])
    .toMatchObject({ send_email: true, send_whatsapp: false });
  expect(await seqNow()).toBe(seqBefore);
  // In the list of the same tab: a "טיוטה" tag instead of a number; a draft has no PDF / send yet.
  const draftRow = page.locator('tr[data-draft]', { hasText: DRAFT_TITLE });
  await expect(draftRow.locator('td').first()).toHaveText('טיוטה');
  for (const kind of ['download', 'print', 'send']) {
    await expect(draftRow.locator(`[data-row-action="${kind}"]`)).toHaveAttribute('aria-disabled', 'true');
  }
  // Nothing is kept in the browser any more.
  expect(await page.evaluate(() => Object.keys(window.localStorage).filter((k) => k.startsWith('purchasing-draft')))).toEqual([]);

  // Another device / session: the same draft opens in the form (double-click).
  const other = await browser.newContext({ storageState: 'e2e/.auth/state.json' });
  const p2 = await other.newPage();
  await p2.goto('/purchasing');
  await p2.locator('tr[data-draft]', { hasText: DRAFT_TITLE }).dblclick();
  await expect(p2.locator('[data-chip]')).toHaveText([new RegExp(`ספק טיוטה ${RUN}`), new RegExp(SUP_A)], { timeout: 10_000 });
  await expect(p2.locator('[data-typed-supplier] input[inputmode="tel"]')).toHaveValue('050-1112233');
  await expect(sheet(p2).getByRole('checkbox', { name: 'מייל' })).toBeChecked();
  await expect(sheet(p2).getByRole('checkbox', { name: 'וואטסאפ' })).not.toBeChecked();
  await expect(p2.locator('#doc-title')).toHaveValue(DRAFT_TITLE);
  await expect(p2.locator('[data-line="0"]').getByPlaceholder('פירוט')).toHaveValue('פריט בטיוטה');
  await expect(p2.locator('[data-doc-number]')).toHaveText(String(seqBefore + 1)); // the number it WOULD get

  // Edit and save it again — still no number; the form closes again.
  await p2.locator('#doc-title').fill(`${DRAFT_TITLE} ב`);
  await sheet(p2).getByRole('button', { name: 'שמור טיוטה' }).click();
  await expect(toastOf(p2, 'הטיוטה נשמרה')).toBeVisible();
  await expectBackOnTable(p2);
  expect((await pool.query(`select title, number from public.purchasing_documents where id = $1`, [draftId])).rows[0])
    .toMatchObject({ title: `${DRAFT_TITLE} ב`, number: null });

  // A draft cannot be sent and has no PDF; the preview still works.
  const send = await other.request.post(`/api/purchasing/documents/${draftId}/send`, { data: { supplier_ids: [made.suppliers[0]], email: true, whatsapp: false } });
  expect(send.status()).toBe(409);
  expect((await other.request.get(`/api/purchasing/documents/${draftId}/pdf`)).status()).toBe(409);
  await p2.locator('tr[data-draft]', { hasText: `${DRAFT_TITLE} ב` }).dblclick();
  const [pv] = await Promise.all([
    p2.waitForResponse((r) => r.url().includes('/api/purchasing/preview')),
    sheet(p2).getByRole('button', { name: 'תצוגה מקדימה' }).click(),
  ]);
  expect(pv.status()).toBe(200);

  // Issue it (the e-mail tick is switched off first, so nothing is sent from this test):
  // the running number is allocated NOW; the form closes and the row shows the number.
  await sheet(p2).getByRole('checkbox', { name: 'מייל' }).click();
  await issueAndBack(p2, sheet(p2), 'הופקה בלי שליחה');
  await expect(p2.locator(byNumber(seqBefore + 1))).toBeVisible();
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
  await poRow.locator('[data-delete-draft]').click();
  await confirmDeletion(page);
  await expect(poRow).toHaveCount(0);
  expect((await pool.query(`select 1 from public.purchasing_documents where id = $1`, [poId])).rowCount).toBe(0);
  expect((await pool.query(`select last_number from public.purchasing_sequences where doc_type = 'po'`)).rows[0]?.last_number ?? null).toBe(poSeq);
});

test('what issuing the first request sent: e-mail (PDF attached) and WhatsApp (message with the personal link + the PDF)', async ({ page, request }) => {
  await page.goto('/purchasing');
  const panel = await openDoc(page, byNumber(START_RFQ));
  await expect(page.getByRole('heading', { name: `בקשה להצעת מחיר מספר ${START_RFQ}` })).toBeVisible();
  // There is no send step in the request window: it all happened on the form.
  await expect(panel.locator('[data-action="send"]')).toHaveCount(0);

  // Mailpit: one mail per supplier, the PDF really attached.
  await expect.poll(() => mailCount(request, `e2e-${RUN}`), { timeout: 20_000 }).toBe(2);
  const list = (await (await request.get(`${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`e2e-${RUN}`)}`)).json()) as { messages: Array<{ ID: string }> };
  const msg = (await (await request.get(`${MAILPIT_URL}/api/v1/message/${list.messages[0].ID}`)).json()) as {
    Subject: string; Text: string; Attachments: Array<{ FileName: string; ContentType: string }>;
  };
  expect(msg.Subject).toContain(`בקשה להצעת מחיר מספר ${START_RFQ}`);
  expect(msg.Attachments.map((a) => a.ContentType)).toContain('application/pdf');
  expect(msg.Text).toMatch(LINK_RE);

  // The typed supplier got its own mail (PDF attached, its own personal link) and WhatsApp.
  await expect.poll(() => mailCount(request, `typed-${RUN}`), { timeout: 20_000 }).toBe(1);
  const typedList = (await (await request.get(`${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`typed-${RUN}`)}`)).json()) as { messages: Array<{ ID: string }> };
  const typedMsg = (await (await request.get(`${MAILPIT_URL}/api/v1/message/${typedList.messages[0].ID}`)).json()) as {
    Text: string; Attachments: Array<{ ContentType: string }>;
  };
  expect(typedMsg.Attachments.map((a) => a.ContentType)).toContain('application/pdf');
  expect(typedMsg.Text).toMatch(LINK_RE);
  const typedWa = await greenMessages(request, '972507654321@c.us');
  expect(typedWa.some((m) => LINK_RE.test(m.message))).toBe(true);
  expect(typedWa.some((m) => m.fileName?.endsWith('.pdf'))).toBe(true);
  // Its recipient row carries its details — and no supplier row was created.
  const rec = await pool.query(`select supplier_id, supplier_name, supplier_phone, supplier_email from public.purchasing_rfq_recipients where rfq_id = $1 and supplier_id is null`, [await docId('rfq', START_RFQ)]);
  expect(rec.rows).toHaveLength(1);
  expect(rec.rows[0]).toMatchObject({ supplier_name: TYPED_SUPPLIER, supplier_phone: '050-7654321', supplier_email: `typed-${RUN}@example.com` });
  // Every supplier shows when it was sent to, in the suppliers card of the document tab.
  await expect(panel.locator('[data-suppliers-card] [data-recipient]')).toHaveCount(3);
  await expect(panel.locator('[data-recipient-status]').filter({ hasText: 'נשלח' })).toHaveCount(3);
  expect((await pool.query(`select 1 from public.suppliers where display_name = $1 or company_name = $1`, [TYPED_SUPPLIER])).rowCount).toBe(0);

  // The Green stand-in: the message with the link, then the PDF as a file.
  const wa = await greenMessages(request, CHAT_A);
  expect(wa.some((m) => LINK_RE.test(m.message))).toBe(true);
  expect(wa.some((m) => m.fileName?.endsWith('.pdf'))).toBe(true);

  // The log of the send is on the document.
  await panel.locator('[data-doc-tab="log"]').click();
  await expect(panel.locator('[data-dispatches] li')).toHaveCount(6);
});

test('the supplier field: chips with an X, any number of suppliers, a typed name is a chip of its own and stays out of the suppliers list', async ({ page }) => {
  const NAME_1 = `מוקלד ראשון ${RUN}`;
  const NAME_2 = `מוקלד שני ${RUN}`;
  const suppliersBefore = (await pool.query(`select count(*)::int as n from public.suppliers`)).rows[0].n;
  await page.goto('/purchasing');
  await page.getByRole('button', { name: 'בקשה חדשה' }).click();
  const form = sheet(page);
  await expect(form.locator('[data-chip]')).toHaveCount(0);

  // The search lists the suppliers; a name that exists offers no "add as typed".
  await openPicker(form);
  const search = page.getByPlaceholder(PICKER_PLACEHOLDER);
  await search.fill(SUP_A);
  await expect(page.getByRole('option', { name: SUP_A })).toBeVisible();
  await expect(page.locator('[data-picker-create]')).toHaveCount(0);
  // A name that is not there offers it as a typed supplier.
  await search.fill(NAME_1);
  await expect(page.locator('[data-picker-create]')).toContainText(NAME_1);

  // Three suppliers in the field, like the recipients of a mail: name + X.
  await addListedSupplier(page, form, SUP_A);
  await addListedSupplier(page, form, SUP_B);
  await addTypedSupplier(page, form, NAME_1);
  await closePicker(page);
  await expect(form.locator('[data-chip]')).toHaveCount(3);
  for (const n of [SUP_A, SUP_B, NAME_1]) await expect(form.getByRole('button', { name: `הסר את ${n}`, exact: true })).toBeVisible();
  await expect(form.locator('[data-typed-supplier]')).toHaveCount(1);
  // The typed name has phone / e-mail fields under the field.
  await expect(form.locator('[data-typed-supplier]').locator('input[inputmode="tel"], input[type="email"]')).toHaveCount(2);

  // X removes one chip without opening the list.
  await form.getByRole('button', { name: `הסר את ${SUP_B}`, exact: true }).click();
  await expect(form.locator('[data-chip]')).toHaveCount(2);
  await expect(form.getByPlaceholder(PICKER_PLACEHOLDER)).toHaveCount(0);
  await expect(form.locator('[data-chip]', { hasText: SUP_B })).toHaveCount(0);

  // More than one typed supplier, each with its own details.
  await addTypedSupplier(page, form, NAME_2);
  await closePicker(page);
  await expect(form.locator('[data-chip]')).toHaveCount(3);
  await expect(form.locator('[data-typed-supplier]')).toHaveCount(2);
  await form.locator('[data-typed-supplier]', { hasText: NAME_2 }).locator('input[type="email"]').fill('not-an-email');
  await form.getByRole('button', { name: 'הפק את המסמך' }).click();
  await expect(form.getByText('כתובת מייל לא תקינה')).toBeVisible();
  // Removing a typed supplier's chip with its X removes its details card.
  await form.getByRole('button', { name: `הסר את ${NAME_2}`, exact: true }).click();
  await expect(form.locator('[data-typed-supplier]')).toHaveCount(1);
  await form.getByRole('button', { name: `הסר את ${NAME_1}`, exact: true }).click();
  await expect(form.locator('[data-typed-supplier]')).toHaveCount(0);
  await expect(form.locator('[data-chip]')).toHaveCount(1);

  // The chip's typed name never enters the suppliers list.
  expect((await pool.query(`select count(*)::int as n from public.suppliers`)).rows[0].n).toBe(suppliersBefore);
  await form.getByRole('button', { name: 'ביטול' }).click();
  await expectBackOnTable(page);
});

test('"הוסף" in the lines focuses the new row\'s פירוט: request form and purchase-order form', async ({ page }) => {
  await page.goto('/purchasing');
  await page.getByRole('button', { name: 'בקשה חדשה' }).click();
  const rfq = sheet(page);
  await fillLine(page, 0, 'שורה ראשונה', '1');
  await rfq.getByRole('button', { name: 'הוסף', exact: true }).click();
  await expect(page.locator('[data-line="1"]').getByPlaceholder('פירוט')).toBeFocused();
  await rfq.getByRole('button', { name: 'הוסף', exact: true }).click();
  await expect(page.locator('[data-line="2"]').getByPlaceholder('פירוט')).toBeFocused();
  // Typing goes straight into the new row.
  await page.keyboard.type('שורה שלישית');
  await expect(page.locator('[data-line="2"]').getByPlaceholder('פירוט')).toHaveValue('שורה שלישית');
  await rfq.getByRole('button', { name: 'ביטול' }).click();
  await expectBackOnTable(page);

  await page.goto('/purchasing?tab=po');
  await page.getByRole('button', { name: 'הזמנה חדשה' }).click();
  const po = sheet(page);
  await fillLine(page, 0, 'פריט ראשון', '1');
  await po.getByRole('button', { name: 'הוסף', exact: true }).click();
  await expect(page.locator('[data-line="1"]').getByPlaceholder('פירוט')).toBeFocused();
  await po.getByRole('button', { name: 'ביטול' }).click();
  await expectBackOnTable(page);
});

test('issue by e-mail only: every supplier gets its own mail with its personal link; no WhatsApp; the form closes', async ({ page, request }) => {
  await mailpitClear(request);
  await request.post(`${GREEN}/__reset`);
  const title = `רק מייל ${RUN}`;
  const form = await fillRequest(page, { title, listed: [SUP_A, SUP_B], email: true });
  await issueAndBack(page, form, 'הופקה ונשלחה ל-2 ספקים');
  const id = await docIdByTitle(title);
  await expect.poll(() => mailCount(request, `e2e-${RUN}`), { timeout: 20_000 }).toBe(2);
  // Each mail: the PDF attached and its own link.
  const list = (await (await request.get(`${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`e2e-${RUN}`)}`)).json()) as { messages: Array<{ ID: string }> };
  const links = new Set<string>();
  for (const m of list.messages) {
    const full = (await (await request.get(`${MAILPIT_URL}/api/v1/message/${m.ID}`)).json()) as { Text: string; Attachments: Array<{ ContentType: string }> };
    expect(full.Attachments.map((a) => a.ContentType)).toContain('application/pdf');
    links.add(full.Text.match(LINK_RE)![0]);
  }
  expect(links.size).toBe(2);
  expect(await greenMessages(request, CHAT_A)).toHaveLength(0);
  expect((await pool.query(`select channel, status from public.purchasing_dispatches where document_id = $1`, [id])).rows)
    .toEqual([{ channel: 'email', status: 'sent' }, { channel: 'email', status: 'sent' }]);
});

test('issue by WhatsApp only: message with the personal link + the PDF as a file; no e-mail; the form closes', async ({ page, request }) => {
  await mailpitClear(request);
  await request.post(`${GREEN}/__reset`);
  const title = `רק וואטסאפ ${RUN}`;
  const form = await fillRequest(page, {
    title, listed: [SUP_A], typed: [{ name: `מוקלד וואטסאפ ${RUN}`, phone: '050-7771122' }], whatsapp: true,
  });
  await issueAndBack(page, form, 'הופקה ונשלחה ל-2 ספקים');
  const id = await docIdByTitle(title);
  for (const chat of [CHAT_A, '972507771122@c.us']) {
    const wa = await greenMessages(request, chat);
    expect(wa.some((m) => LINK_RE.test(m.message)), chat).toBe(true);
    expect(wa.some((m) => m.fileName?.endsWith('.pdf')), chat).toBe(true);
  }
  expect(await mailCount(request, `e2e-${RUN}`)).toBe(0);
  expect((await pool.query(`select distinct channel from public.purchasing_dispatches where document_id = $1`, [id])).rows).toEqual([{ channel: 'whatsapp' }]);
});

test('issue with nothing ticked: no sending; each supplier has its own PDF to download and print from the row icons', async ({ page, request }) => {
  await mailpitClear(request);
  await request.post(`${GREEN}/__reset`);
  await installPrintCounter(page);
  const TYPED = `מוקלד ללא שליחה ${RUN}`;
  const title = `ללא שליחה ${RUN}`;
  const form = await fillRequest(page, { title, listed: [SUP_A, SUP_B], typed: [{ name: TYPED }] });
  await issueAndBack(page, form, 'הופקה בלי שליחה');
  const id = await docIdByTitle(title);
  const row = page.locator(byId(id));
  await expect(row).toBeVisible();

  // Nothing was sent anywhere.
  expect((await pool.query(`select 1 from public.purchasing_dispatches where document_id = $1`, [id])).rowCount).toBe(0);
  expect(await mailCount(request, `e2e-${RUN}`)).toBe(0);
  expect(await greenMessages(request, CHAT_A)).toHaveLength(0);

  // The download icon of a multi-supplier request: a small menu, not a window; one entry per supplier.
  await row.locator('[data-row-action="download"]').click();
  const menu = page.locator('[data-party-menu="download"]');
  await expect(menu).toBeVisible();
  await expect(menu.locator('[data-party]')).toHaveCount(3);
  await expect(page.locator('[data-slot="sheet-content"]')).toHaveCount(0);
  const keys = await menu.locator('[data-party]').evaluateAll((els) => els.map((e) => ({ key: e.getAttribute('data-party')!, name: e.textContent!.trim() })));
  expect(keys.map((k) => k.name).sort()).toEqual([SUP_A, SUP_B, TYPED].sort());

  // A real download through the menu, for the first supplier…
  const [dl] = await Promise.all([
    page.waitForEvent('download'),
    menu.locator('[data-party]', { hasText: SUP_A }).click(),
  ]);
  expect(dl.suggestedFilename()).toMatch(/\.pdf$/i);
  const first = fs.readFileSync((await dl.path())!);
  expect(first.subarray(0, 5).toString()).toBe('%PDF-');
  // …and the PDF each menu entry points at is its own, addressed to that supplier.
  const bodies: string[] = [first.toString('base64')];
  for (const k of keys.filter((x) => x.name !== SUP_A)) {
    const res = await request.get(`/api/purchasing/documents/${id}/pdf?party=${k.key}&download=1`);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toBe('application/pdf');
    expect(res.headers()['content-disposition']).toContain('attachment');
    const bytes = await res.body();
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
    bodies.push(bytes.toString('base64'));
  }
  expect(new Set(bodies).size).toBe(3); // three different addressees
  // A key that is not one of the request's suppliers has no PDF.
  expect((await request.get(`/api/purchasing/documents/${id}/pdf?party=mzzzzzzzz`)).status()).toBe(404);

  // The print icon: the same small menu; picking a supplier requests the print dialog once.
  await expect(row.locator('[data-row-action="print"]')).toHaveCount(1);
  await row.locator('[data-row-action="print"]').click();
  await expect(page.locator('[data-party-menu="print"] [data-party]')).toHaveCount(3);
  await page.locator('[data-party-menu="print"] [data-party]', { hasText: SUP_A }).click();
  await expect.poll(() => prints(page), { timeout: 10_000 }).toBe(1);
  await expect(page.locator('[data-slot="sheet-content"]')).toHaveCount(0);

  // The table with its row icons.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.mouse.move(0, 0);
  await shot(page, '03-table-with-icons');
  await page.setViewportSize({ width: 1280, height: 720 });

  // The send icon opens the window on its suppliers card, with the three suppliers.
  await row.locator('[data-row-action="send"]').click();
  const panel = page.getByRole('dialog').filter({ has: page.locator('[data-doc-actions]') });
  await expect(panel.locator('[data-suppliers-card]')).toBeVisible();
  await expect(panel.locator('[data-suppliers-card] [data-recipient]')).toHaveCount(3);
  await expect(panel.locator('[data-suppliers-card]')).toBeInViewport();
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
  // The page opens in "before VAT" mode.
  await expect(page.locator('[data-quote-mode]')).toHaveAttribute('data-quote-mode', 'excl');

  // A unit price is required on EVERY line.
  const prices = quotePrices(page);
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
  await expect(page.locator('[data-mode="incl"]')).toBeDisabled();
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
  const prices = quotePrices(page);
  await prices.nth(0).fill('11');
  await prices.nth(1).fill('6');
  await page.locator('[data-quote-submit]').click();
  await expect(page.locator('[data-quote-message="ok"]')).toContainText('ההצעה נקלטה');
  await ctx.close();
  const q = await pool.query(`select supplier_id, supplier_name, supplier_email from public.purchasing_quotes where rfq_id = $1 and supplier_id is null`, [rfq]);
  expect(q.rows).toHaveLength(1);
  expect(q.rows[0]).toMatchObject({ supplier_name: TYPED_SUPPLIER, supplier_email: `typed-${RUN}@example.com` });
});

test('the comparison, the winner — and a purchase order from it (the form closes; the order is in the table)', async ({ page, browser }) => {
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
  const panel = await openDoc(page, byNumber(START_RFQ));
  await expect(page.getByRole('heading', { name: `בקשה להצעת מחיר מספר ${START_RFQ}` })).toBeVisible();
  // The "quote received outside the system" flow is gone.
  await expect(page.getByRole('button', { name: 'הצעה מחוץ למערכת' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'הזנת הצעה' })).toHaveCount(0);
  // The comparison tab carries the count of submitted quotes.
  await expect(panel.locator('[data-compare-count]')).toHaveText('3');

  // Comparison: A (3×10 + 10×4 = 70) vs B (77) vs the typed one (93). Cheapest = A.
  await panel.locator('[data-doc-tab="compare"]').click();
  const cmp = panel.locator('[data-comparison]');
  await expect(cmp).toContainText('₪70.00');
  await expect(cmp).toContainText('₪77.00');
  await expect(cmp).toContainText('₪93.00'); // the typed supplier: 3×11 + 10×6
  await expect(cmp.locator('thead th')).toContainText([/פריט/, new RegExp(SUP_A), new RegExp(TYPED_SUPPLIER), new RegExp(SUP_B)]);
  await expect(panel.locator('[data-comparison-count]')).toContainText('3 מתוך 3 ספקים הגישו');
  await expect(cmp.locator('[data-cheapest-pill]')).toHaveCount(1);
  await expect(cmp.locator('[data-cheapest-pill]')).toHaveText('ההצעה הזולה');
  await expect(cmp.locator('td[data-total-excl][data-cheapest]')).toHaveCount(1);
  await expect(cmp.locator('td[data-total-excl][data-cheapest]')).toContainText('₪70.00');
  await expect(cmp.locator('td[data-total-excl][data-cheapest]')).toHaveClass(/bg-emerald/);

  // Pick the winner → recorded with who and when.
  await cmp.locator('[data-action="pick-winner"]').first().click();
  await expect(panel.locator('[data-winner]')).toContainText(SUP_A);
  const row = await pool.query(`select winner_supplier_id, winner_chosen_by, winner_chosen_at from public.purchasing_documents where id = $1`, [rfq]);
  expect(row.rows[0].winner_supplier_id).toBe(made.suppliers[0]);
  expect(row.rows[0].winner_chosen_by).not.toBeNull();
  expect(row.rows[0].winner_chosen_at).not.toBeNull();

  // Purchase order from the winner: supplier + lines + prices copied, editable.
  await panel.getByRole('button', { name: 'פתח הזמנת רכש' }).click();
  // (the tab sits behind the open panel, outside the accessibility tree)
  await expect(page.locator('[data-tab="po"]')).toHaveAttribute('aria-selected', 'true');
  const form = sheet(page);
  await expect(page.locator('[data-slot="sheet-content"]')).toHaveCount(1); // the request window gave way to the form
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
  await issueAndBack(page, form, `הזמנת רכש מספר ${START_PO} הופקה`);

  // R4: the order is in its table; nothing opened over it.
  await expect(page.locator(byNumber(START_PO))).toBeVisible();
  const poId = await docId('po', START_PO);
  const po = await pool.query(`select vat_rate::float8 as vat, source_rfq_id, supplier_id from public.purchasing_documents where id = $1`, [poId]);
  expect(po.rows[0]).toMatchObject({ vat: 18, source_rfq_id: rfq, supplier_id: made.suppliers[0] });
  const poPanel = await openDoc(page, byNumber(START_PO));
  await expect(page.getByRole('heading', { name: `הזמנת רכש מספר ${START_PO}` })).toBeVisible();
  await expect(poPanel.locator('[data-totals]')).toContainText('₪82.60');
  await expect(poPanel.locator('[data-doc-details]')).toContainText(`מספר ${START_RFQ}`); // opened from the request
});

test('the document panel: fixed bottom bar (delete right; edit · PDF · print left), three tabs, PDF and print per supplier from a menu', async ({ page }) => {
  await installPrintCounter(page);
  await page.goto('/purchasing');
  const panel = await openDoc(page, byNumber(START_RFQ));

  // Order on screen (RTL → larger x = further right): delete rightmost, edit leftmost.
  const xs = async (action: string) => {
    const box = await panel.locator(`[data-action="${action}"]`).boundingBox();
    expect(box, action).not.toBeNull();
    return box!.x;
  };
  const [del, print, dl, edit] = await Promise.all(['delete', 'print', 'download-pdf', 'edit'].map(xs));
  expect(del).toBeGreaterThan(print);
  expect(print).toBeGreaterThan(dl);
  expect(dl).toBeGreaterThan(edit);
  // A request is sent from its form / suppliers card, not from the bar (an order still has "שליחה").
  await expect(panel.locator('[data-action="send"]')).toHaveCount(0);

  // The bar is fixed: outside the scrolling area, at the bottom of the window, the same in every tab.
  const bar = panel.locator('[data-doc-actions]');
  await expect(panel.locator('[data-doc-scroll] [data-doc-actions]')).toHaveCount(0);
  const panelBox = (await panel.boundingBox())!;
  const barBox = (await bar.boundingBox())!;
  expect(Math.round(barBox.y + barBox.height)).toBe(Math.round(panelBox.y + panelBox.height));

  // Print: no download, no new tab; for several suppliers a small menu lists them, the print dialog is requested once.
  const pagesBefore = page.context().pages().length;
  await panel.locator('[data-action="print"]').click();
  await expect(page.locator('[data-party-menu="print"] [data-party]')).toHaveCount(3);
  await page.locator('[data-party-menu="print"] [data-party]').first().click();
  // (headless Chromium has no inline PDF viewer, so the frame never reports `load` — the helper prints after 2.5s)
  await expect(page.getByText('ההדפסה נכשלה')).toHaveCount(0);
  await expect.poll(() => prints(page), { timeout: 10_000 }).toBe(1);
  expect(page.context().pages().length).toBe(pagesBefore);

  // Download: the same menu, a real PDF per supplier.
  await panel.locator('[data-action="download-pdf"]').click();
  await expect(page.locator('[data-party-menu="download"] [data-party]')).toHaveCount(3);
  const [dlEvent] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('[data-party-menu="download"] [data-party]', { hasText: SUP_A }).click(),
  ]);
  expect(fs.readFileSync((await dlEvent.path())!).subarray(0, 5).toString()).toBe('%PDF-');

  // Tabs: document (default) · comparison (request only, with the count) · send log.
  await expect(panel.locator('[data-doc-tab]')).toHaveText([/מסמך/, /השוואת הצעות/, /יומן שליחות/]);
  await expect(panel.locator('[data-doc-tab="document"]')).toHaveAttribute('aria-selected', 'true');
  await expect(panel.locator('[data-doc-details]')).toBeVisible();
  await expect(panel.locator('[data-suppliers-card]')).toBeVisible();
  await expect(panel.locator('[data-comparison]')).toHaveCount(0);
  await panel.locator('[data-doc-tab="compare"]').click();
  await expect(panel.locator('[data-comparison]')).toBeVisible();
  await expect(panel.locator('[data-doc-details]')).toHaveCount(0);
  // The winner (chosen in the comparison test, from this same tab) and the shortcut to the order live here.
  await expect(panel.locator('[data-winner]')).toBeVisible();
  await expect(panel.getByRole('button', { name: 'פתח הזמנת רכש' })).toBeVisible();
  await expect(bar).toBeVisible();
  expect(Math.round((await bar.boundingBox())!.y)).toBe(Math.round(barBox.y));
  await panel.locator('[data-doc-tab="log"]').click();
  await expect(panel.locator('[data-dispatches]')).toBeVisible();
  await expect(panel.locator('[data-comparison]')).toHaveCount(0);
  expect(Math.round((await bar.boundingBox())!.y)).toBe(Math.round(barBox.y));

  // A purchase order has no comparison tab; it keeps "שליחה" in the bar.
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-slot="sheet-content"]')).toHaveCount(0);
  await page.locator('[data-tab="po"]').click();
  await page.locator('tbody tr[data-number]').first().dblclick();
  const po = page.getByRole('dialog').filter({ has: page.locator('[data-doc-actions]') });
  await expect(po.locator('[data-doc-tab]')).toHaveText([/מסמך/, /יומן שליחות/]);
  await expect(po.locator('[data-action="send"]')).toHaveCount(1);
});

test('phone width: the tabs stay on one row and the actions fit the bottom bar', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/purchasing');
  const panel = await openDoc(page, byNumber(START_RFQ));
  const tabs = panel.locator('[data-doc-tab]');
  await expect(tabs).toHaveCount(3);
  const ys = await tabs.evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().y)));
  expect(new Set(ys).size).toBe(1);
  for (const a of ['delete', 'print', 'edit']) {
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

test('a direct purchase order, the VAT stamped at issue, a draft that closes the form, and the PDF', async ({ page, request }) => {
  await page.goto('/purchasing?tab=po');
  await page.getByRole('button', { name: 'הזמנה חדשה' }).click();
  const form = sheet(page);
  await expect(page.locator('[data-doc-number]')).toHaveText(String(START_PO + 1));
  await form.locator('#doc-supplier').fill(SUP_B.slice(0, 7));
  await page.getByRole('option', { name: SUP_B }).click();
  await form.locator('#doc-title').fill('חומרי ניקוי');
  await fillLine(page, 0, 'נוזל רצפות', '2', '25');
  await expect(form.locator('[data-totals]')).toContainText('₪59.00'); // 50 + 9 VAT
  await issueAndBack(page, form, `הזמנת רכש מספר ${START_PO + 1} הופקה`);
  await expect(page.locator(byNumber(START_PO + 1))).toBeVisible();
  const id = await docId('po', START_PO + 1);

  // A draft of an order: saving closes the form too, the table shows it with the draft tag.
  const poSeq = (await pool.query(`select last_number from public.purchasing_sequences where doc_type = 'po'`)).rows[0].last_number as number;
  await page.getByRole('button', { name: 'הזמנה חדשה' }).click();
  const draftForm = sheet(page);
  await draftForm.locator('#doc-supplier').fill(SUP_A.slice(0, 7));
  await page.getByRole('option', { name: SUP_A }).click();
  await draftForm.locator('#doc-title').fill(`טיוטת הזמנה ממסך ${RUN}`);
  await fillLine(page, 0, 'פריט בטיוטה', '1', '10');
  await draftForm.getByRole('button', { name: 'שמור טיוטה' }).click();
  await expect(toastOf(page, 'הטיוטה נשמרה')).toBeVisible();
  await expectBackOnTable(page);
  const draftRow = page.locator('tr[data-draft]', { hasText: `טיוטת הזמנה ממסך ${RUN}` });
  await expect(draftRow).toBeVisible();
  const draftId = await docIdByTitle(`טיוטת הזמנה ממסך ${RUN}`);
  expect((await pool.query(`select status, number from public.purchasing_documents where id = $1`, [draftId])).rows[0]).toMatchObject({ status: 'draft', number: null });
  expect((await pool.query(`select last_number from public.purchasing_sequences where doc_type = 'po'`)).rows[0].last_number).toBe(poSeq);
  await draftRow.locator('[data-delete-draft]').click();
  await confirmDeletion(page);
  await expect(draftRow).toHaveCount(0);

  // Changing the company VAT later does not touch an issued document.
  await pool.query(
    `update public.app_settings set value = jsonb_set(value, '{vat_rate}', '17') where key = 'purchasing_company'`,
  );
  const stamped = await pool.query<{ vat: number }>(`select vat_rate::float8 as vat from public.purchasing_documents where id = $1`, [id]);
  expect(stamped.rows[0].vat).toBe(18);
  await page.reload();
  const panel = await openDoc(page, byNumber(START_PO + 1));
  await expect(panel.locator('[data-totals]')).toContainText('₪59.00');
  // Back to 18% for the documents the later tests issue.
  await pool.query(
    `update public.app_settings set value = jsonb_set(value, '{vat_rate}', '18') where key = 'purchasing_company'`,
  );

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
  const panel = await openDoc(page, byNumber(START_RFQ));
  await panel.locator('[data-doc-tab="compare"]').click();
  const cmp = panel.locator('[data-comparison]');
  // A is the current winner; columns are A, the typed supplier, B (submission order).
  await cmp.locator('tr', { hasText: 'הצעה זוכה' }).locator('td').nth(2).locator('[data-action="pick-winner"]').click();
  await expect(panel.locator('[data-winner]')).toContainText(TYPED_SUPPLIER);
  const rfq = await docId('rfq', START_RFQ);
  const w = await pool.query(`select winner_supplier_id, winner_chosen_by, winner_chosen_at from public.purchasing_documents where id = $1`, [rfq]);
  expect(w.rows[0].winner_supplier_id).toBeNull();
  expect(w.rows[0].winner_chosen_at).not.toBeNull();
  expect(w.rows[0].winner_chosen_by).not.toBeNull();

  await panel.getByRole('button', { name: 'פתח הזמנת רכש' }).click();
  const form = sheet(page);
  await expect(form.locator('#doc-supplier')).toHaveValue(TYPED_SUPPLIER);
  await expect(form.locator('#doc-supplier-phone')).toHaveValue('050-7654321');
  await expect(form.locator('#doc-supplier-email')).toHaveValue(`typed-${RUN}@example.com`);
  await expect(page.locator('[data-line="0"] input[inputmode="decimal"]').nth(1)).toHaveValue('11');
  await issueAndBack(page, form, `הזמנת רכש מספר ${START_PO + 2} הופקה`);
  await expect(page.locator(byNumber(START_PO + 2))).toBeVisible();
  const poId = await docId('po', START_PO + 2);
  const po = await pool.query(`select supplier_id, supplier_name, supplier_phone, supplier_email, source_rfq_id from public.purchasing_documents where id = $1`, [poId]);
  expect(po.rows[0]).toMatchObject({
    supplier_id: null, supplier_name: TYPED_SUPPLIER, supplier_phone: '050-7654321', supplier_email: `typed-${RUN}@example.com`, source_rfq_id: rfq,
  });
  // The request records WHICH typed supplier won.
  expect((await pool.query(`select winner_manual_key from public.purchasing_documents where id = $1`, [rfq])).rows[0].winner_manual_key).toMatch(/^m[a-z0-9]{6,24}$/);

  // The order goes to ITS supplier only — the typed one, by the e-mail on the document.
  const poPanel = await openDoc(page, byNumber(START_PO + 2));
  await poPanel.locator('[data-action="send"]').click();
  const sendSheet = sheet(page);
  await expect(sendSheet.locator('[data-send-row]')).toHaveCount(1);
  await expect(sendSheet.locator('[data-send-row="manual"]')).toContainText(TYPED_SUPPLIER);
  await sendSheet.getByRole('button', { name: 'שלח', exact: true }).click();
  await expect(sendSheet.locator('[data-send-results] li')).toHaveCount(1);
  await expect(sendSheet.locator('[data-send-results] li svg.text-rose-600')).toHaveCount(0);
  await expect.poll(() => mailCount(request, `typed-${RUN}`), { timeout: 20_000 }).toBe(1);
  const list = (await (await request.get(`${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`typed-${RUN}`)}`)).json()) as { messages: Array<{ ID: string }> };
  const msg = (await (await request.get(`${MAILPIT_URL}/api/v1/message/${list.messages[0].ID}`)).json()) as {
    Subject: string; Attachments: Array<{ ContentType: string }>;
  };
  expect(msg.Subject).toContain(`הזמנת רכש מספר ${START_PO + 2}`);
  expect(msg.Attachments.map((a) => a.ContentType)).toContain('application/pdf');
  expect((await pool.query(`select 1 from public.suppliers where display_name = $1 or company_name = $1`, [TYPED_SUPPLIER])).rowCount).toBe(0);
});

test('a supplier without the e-mail / phone for a ticked channel: a warning by its chip before issuing, never a block; skipped when sending', async ({ page, request }) => {
  const NAME = `ספק חסום ${RUN}`;
  await mailpitClear(request);
  const title = `חסום ${RUN}`;
  const form = await fillRequest(page, { title, typed: [{ name: NAME }] });
  const chip = form.locator('[data-chip]', { hasText: NAME });
  await expect(chip.locator('[data-chip-warn]')).toHaveCount(0); // nothing ticked, nothing missing
  await form.getByRole('checkbox', { name: 'מייל' }).click();
  await expect(chip.locator('[data-chip-warn]')).toContainText('אין מייל');
  await form.getByRole('checkbox', { name: 'וואטסאפ' }).click();
  await expect(chip.locator('[data-chip-warn]')).toContainText('אין מייל וטלפון');
  // Giving it a phone clears that part of the warning.
  await form.locator('[data-typed-supplier] input[inputmode="tel"]').fill('050-9998877');
  await expect(chip.locator('[data-chip-warn]')).toContainText('אין מייל');
  await expect(chip.locator('[data-chip-warn]')).not.toContainText('טלפון');
  await form.locator('[data-typed-supplier] input[inputmode="tel"]').fill('');

  // Not blocked: the request is issued; the supplier is skipped on both channels, no dispatch is logged.
  await form.getByRole('button', { name: 'הפק את המסמך' }).click();
  const toast = toastOf(page, 'הופקה, אך לא נשלחה לאף ספק');
  await expect(toast).toBeVisible({ timeout: 30_000 });
  await expect(toast).toContainText(`דולגו (חסר מייל או טלפון): ${NAME}`);
  await expectBackOnTable(page);
  const doc = await pool.query<{ id: string }>(`select id from public.purchasing_documents where title = $1`, [title]);
  expect(doc.rows).toHaveLength(1);
  made.docs.push(doc.rows[0].id);
  expect((await pool.query(`select 1 from public.purchasing_dispatches where document_id = $1`, [doc.rows[0].id])).rowCount).toBe(0);

  // The API: a key that is not one of the request's suppliers is refused; skips are counted, not failed.
  const bad = await request.post(`/api/purchasing/documents/${doc.rows[0].id}/send`, { data: { supplier_ids: [made.suppliers[0]], email: true, whatsapp: false } });
  expect(bad.status()).toBe(400);
  const key = (await pool.query<{ manual_key: string }>(`select manual_key from public.purchasing_rfq_recipients where rfq_id = $1`, [doc.rows[0].id])).rows[0].manual_key;
  const ok = await request.post(`/api/purchasing/documents/${doc.rows[0].id}/send`, { data: { supplier_ids: [key], email: true, whatsapp: true } });
  expect(ok.status()).toBe(200);
  expect(await ok.json()).toMatchObject({ sent_count: 0, failed_count: 0, skipped_count: 2 });
});

test('the module is closed to anonymous callers (per-role access is locked by tests/purchasing-rbac-route.test.ts)', async ({ browser }) => {
  const anon = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  for (const url of ['/api/purchasing/documents?type=rfq', '/api/purchasing/company', '/api/purchasing/suppliers']) {
    expect((await anon.request.get(url)).status(), url).toBe(401);
  }
  // The proxy for its files: unauthenticated is 401, never the bytes.
  expect((await anon.request.get('/api/files/purchasing-files/00000000-0000-4000-8000-000000000001.pdf')).status()).toBe(401);
  // The add-suppliers route is a staff route too.
  expect((await anon.request.post(`/api/purchasing/documents/00000000-0000-4000-8000-000000000001/recipients`, { data: { recipients: [] } })).status()).toBe(401);
  await anon.close();
});

test('a request needs its subject; one that predates the rule stays editable while its subject stays empty', async ({ request }) => {
  const NAME = `ספק נושא ${RUN}`;
  const lines = [{ description: 'שורה', quantity: 1, unit_price: null }];

  // Creating a request without a subject is refused, and nothing is written.
  const none = await request.post('/api/purchasing/documents', {
    data: { doc_type: 'rfq', doc_date: '2026-10-22', recipients: [{ key: 'mnone00001', name: NAME }], due_date: '2099-01-01', lines },
  });
  expect(none.status()).toBe(400);
  expect((await pool.query(`select 1 from public.purchasing_rfq_recipients where supplier_name = $1`, [NAME])).rowCount).toBe(0);

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

test('row icons and double-click: a click selects, a double-click opens; PDF / print / send icons for a request and an order', async ({ page }) => {
  await installPrintCounter(page);
  await page.goto('/purchasing');

  // A single click only selects the row: no window opens. A double-click opens it.
  const row = page.locator(byNumber(START_RFQ));
  await row.click();
  await expect(row).toHaveAttribute('aria-selected', 'true');
  await page.waitForTimeout(400);
  await expect(page.locator('[data-slot="sheet-content"]')).toHaveCount(0);
  await row.dblclick();
  await expect(page.locator('[data-doc-actions]')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-slot="sheet-content"]')).toHaveCount(0);

  // Clicking an icon never opens the window (nor selects through to the row's own open).
  await row.locator('[data-row-action="print"]').click();
  await expect(page.locator('[data-party-menu="print"]')).toBeVisible();
  await expect(page.locator('[data-slot="sheet-content"]')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-party-menu="print"]')).toHaveCount(0);

  // A request with ONE supplier: the PDF icon acts at once, addressed to it (no menu).
  const single = page.locator(byNumber(START_RFQ + 2));
  await expect(single.locator('[data-row-action="print"]')).toHaveCount(1);
  const [dl] = await Promise.all([page.waitForEvent('download'), single.locator('[data-row-action="download"]').click()]);
  expect(dl.suggestedFilename()).toMatch(/\.pdf$/i);
  expect(fs.readFileSync((await dl.path())!).subarray(0, 5).toString()).toBe('%PDF-');
  await expect(page.locator('[data-party-menu]')).toHaveCount(0);
  await single.locator('[data-row-action="print"]').click();
  await expect.poll(() => prints(page), { timeout: 10_000 }).toBe(1);

  // The send icon of the request with three suppliers: the window opens on its suppliers card.
  await row.locator('[data-row-action="send"]').click();
  const panel = page.getByRole('dialog').filter({ has: page.locator('[data-doc-actions]') });
  await expect(panel.locator('[data-suppliers-card]')).toBeVisible();
  await expect(panel.locator('[data-suppliers-card] [data-recipient]')).toHaveCount(3);
  await expect(panel.locator('[data-suppliers-card]')).toBeInViewport();
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-slot="sheet-content"]')).toHaveCount(0);

  // A purchase order (R4): same row icons, a direct PDF and print; double-click opens it.
  await page.locator('[data-tab="po"]').click();
  const po = page.locator(byNumber(START_PO));
  await po.click();
  await page.waitForTimeout(400);
  await expect(page.locator('[data-slot="sheet-content"]')).toHaveCount(0);
  const [poDl] = await Promise.all([page.waitForEvent('download'), po.locator('[data-row-action="download"]').click()]);
  expect(fs.readFileSync((await poDl.path())!).subarray(0, 5).toString()).toBe('%PDF-');
  await expect(page.locator('[data-party-menu]')).toHaveCount(0);
  await po.locator('[data-row-action="print"]').click();
  await expect.poll(() => prints(page), { timeout: 10_000 }).toBe(2);
  await po.dblclick();
  await expect(page.locator('[data-doc-actions]')).toBeVisible();
  await expect(page.getByRole('heading', { name: `הזמנת רכש מספר ${START_PO}` })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-slot="sheet-content"]')).toHaveCount(0);
  // The order's send icon opens its window.
  await po.locator('[data-row-action="send"]').click();
  await expect(page.locator('[data-doc-actions]')).toBeVisible();
});

test('a request in the design\'s numbers: three suppliers, the supplier page in both VAT modes, stored normalised before VAT', async ({ page, browser, request }) => {
  await mailpitClear(request);
  await request.post(`${GREEN}/__reset`);
  const form = await fillRequest(page, { title: VAT_TITLE, typed: [...VAT_SUPPLIERS], whatsapp: true, lines: VAT_LINES });
  await issueAndBack(page, form, 'הופקה ונשלחה ל-3 ספקים');
  const rfq = await docIdByTitle(VAT_TITLE);
  const [ronen, dani, ofer] = VAT_SUPPLIERS.map((s) => s.name);

  // 1) "before VAT" mode: 500 / 600 / 900.
  const a = await supplierPage(browser, await tokenOf(rfq, ronen));
  await expect(a.page.locator('[data-quote-mode]')).toHaveAttribute('data-quote-mode', 'excl');
  await expect(a.page.locator('[data-mode="excl"]')).toHaveAttribute('aria-checked', 'true');
  await expect(a.page.locator('[data-quote-heading]')).toHaveText(/בקשה להצעת מחיר מספר \d+/);
  await expect(a.page.locator('[data-quote-lines]')).toContainText(VAT_LINES[0]);
  for (const [i, v] of ['500', '600', '900'].entries()) await quotePrices(a.page).nth(i).fill(v);
  await expect(a.page.locator('[data-quote-subtotal]')).toHaveText('₪2,000.00');
  await expect(a.page.locator('[data-quote-vat]')).toHaveText('₪360.00');
  await expect(a.page.locator('[data-quote-total]')).toHaveText('₪2,360.00');
  await shot(a.page, '07-supplier-page-excl');
  await a.page.locator('[data-quote-submit]').click();
  await expect(a.page.locator('[data-quote-message="ok"]')).toContainText('ההצעה נקלטה');
  expect(await storedQuote(rfq, ronen)).toEqual({ mode: 'excl', normalised: [500, 600, 900], entered: [500, 600, 900] });
  await a.ctx.close();

  // 2) "including VAT" mode (another supplier): typed with VAT, stored before VAT (÷1.18).
  const b = await supplierPage(browser, await tokenOf(rfq, dani));
  await b.page.locator('[data-mode="incl"]').click();
  await expect(b.page.locator('[data-quote-mode]')).toHaveAttribute('data-quote-mode', 'incl');
  await expect(b.page.locator('[data-mode="incl"]')).toHaveAttribute('aria-checked', 'true');
  for (const [i, v] of ['531', '767', '1156.40'].entries()) await quotePrices(b.page).nth(i).fill(v);
  // The live summary normalises: 450 + 650 + 980 before VAT.
  await expect(b.page.locator('[data-quote-subtotal]')).toHaveText('₪2,080.00');
  await expect(b.page.locator('[data-quote-vat]')).toHaveText('₪374.40');
  await expect(b.page.locator('[data-quote-total]')).toHaveText('₪2,454.40');
  await shot(b.page, '08-supplier-page-incl');
  await b.page.locator('[data-quote-submit]').click();
  await expect(b.page.locator('[data-quote-message="ok"]')).toContainText('ההצעה נקלטה');
  expect(await storedQuote(rfq, dani)).toEqual({ mode: 'incl', normalised: [450, 650, 980], entered: [531, 767, 1156.4] });
  // The page shows back what the supplier typed, in the mode he used.
  await b.page.reload();
  await expect(b.page.locator('[data-quote-mode]')).toHaveAttribute('data-quote-mode', 'incl');
  await expect(quotePrices(b.page).nth(0)).toHaveValue('531');
  await expect(b.page.locator('[data-quote-total]')).toHaveText('₪2,454.40');
  await b.ctx.close();

  // 3) The third supplier answers through the API (before VAT): 520 / 590 / 1050.
  const lines = await pool.query<{ id: string }>(`select id from public.purchasing_lines where document_id = $1 order by sort_order`, [rfq]);
  const anon = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const put = await anon.request.put(`/api/public/quote/${await tokenOf(rfq, ofer)}`, {
    data: { price_mode: 'excl', prices: { [lines.rows[0].id]: 520, [lines.rows[1].id]: 590, [lines.rows[2].id]: 1050 } },
  });
  expect(put.status()).toBe(200);
  await anon.close();
  expect(await storedQuote(rfq, ofer)).toEqual({ mode: 'excl', normalised: [520, 590, 1050], entered: [520, 590, 1050] });
});

test('the request window on the design\'s data: suppliers card, comparison highlights (always before VAT), log, "הוסף ספק" panel', async ({ page }) => {
  const rfq = await docIdByTitle(VAT_TITLE);
  await page.setViewportSize({ width: 1440, height: 1700 });
  await page.goto('/purchasing');
  const panel = await openDoc(page, byId(rfq));
  await page.waitForTimeout(500);

  // Document tab: every supplier with its three steps and the amount before VAT.
  const card = panel.locator('[data-suppliers-card]');
  await expect(card.locator('[data-recipient]')).toHaveCount(3);
  for (const s of VAT_SUPPLIERS) {
    const r = card.locator('[data-recipient]', { hasText: s.name });
    await expect(r.locator('[data-recipient-status]')).toContainText('נשלח');
    await expect(r.locator('[data-recipient-status]')).toContainText('הגיש');
  }
  await expect(card.locator('[data-recipient]', { hasText: 'רונן' }).locator('[data-quote-amount]')).toHaveText('₪2,000');
  await expect(card.locator('[data-recipient]', { hasText: 'צבע דני' }).locator('[data-quote-amount]')).toHaveText('₪2,080');
  await expect(card.locator('[data-recipient]', { hasText: 'עופר שזק' }).locator('[data-quote-amount]')).toHaveText('₪2,160');
  await shot(page, '04-doc-tab');

  // "להשוואה" jumps to the comparison tab.
  await card.locator('[data-recipient]', { hasText: 'רונן' }).locator('[data-action="to-comparison"]').click();
  await expect(panel.locator('[data-doc-tab="compare"]')).toHaveAttribute('aria-selected', 'true');
  await expect(panel.locator('[data-compare-count]')).toHaveText('3');
  await expect(panel.locator('[data-comparison-count]')).toContainText('3 מתוך 3 ספקים הגישו');
  const cmp = panel.locator('[data-comparison]');
  // Cheapest cell of every row — read from the BEFORE-VAT prices: Dani typed 531 incl. VAT = 450, cheaper than Ronen's 500.
  await expect(cmp.locator('[data-comparison-line="0"] [data-cheapest-cell]')).toHaveText('₪450.00');
  await expect(cmp.locator('[data-comparison-line="1"] [data-cheapest-cell]')).toHaveText('₪590.00');
  await expect(cmp.locator('[data-comparison-line="2"] [data-cheapest-cell]')).toHaveText('₪900.00');
  await expect(cmp.locator('[data-cheapest-cell]')).toHaveCount(3);
  await expect(cmp.locator('[data-comparison-line="0"] [data-cheapest-cell]')).toHaveClass(/bg-emerald/);
  // The cheapest TOTAL and its tag: Ronen, 2,000 before VAT / 2,360 with it.
  await expect(cmp.locator('[data-cheapest-pill]')).toHaveCount(1);
  await expect(cmp.locator('thead th', { hasText: 'ההצעה הזולה' })).toContainText('רונן');
  await expect(cmp.locator('td[data-total-excl][data-cheapest]')).toHaveText('₪2,000.00');
  await expect(cmp.locator('td[data-total-incl].bg-emerald-100')).toHaveText('₪2,360.00');
  await expect(cmp.locator('td[data-total-excl]:not([data-cheapest])')).toHaveCount(2);
  await expect(cmp.locator('td[data-total-excl]:not([data-cheapest])')).toContainText([/₪2,(160|080)\.00/, /₪2,(160|080)\.00/]);
  await shot(page, '05-comparison');

  // Log: one row per WhatsApp dispatch.
  await panel.locator('[data-doc-tab="log"]').click();
  await expect(panel.locator('[data-dispatches] li')).toHaveCount(3);
  await expect(panel.locator('[data-dispatches] li').filter({ hasText: 'WhatsApp' })).toHaveCount(3);
  await expect(panel.locator('[data-dispatches] li').filter({ hasText: 'נשלח' })).toHaveCount(3);
  await shot(page, '06-log');

  // "הוסף ספק" expands INLINE in the card (no second window) with the picker and the send-by cards.
  await panel.locator('[data-doc-tab="document"]').click();
  await card.locator('[data-action="add-supplier"]').click();
  const add = card.locator('[data-add-suppliers-panel]');
  await expect(add).toBeVisible();
  await expect(page.locator('[data-slot="sheet-content"]')).toHaveCount(1);
  await expect(add.getByRole('checkbox', { name: 'מייל' })).toBeVisible();
  await expect(add.getByRole('checkbox', { name: 'וואטסאפ' })).toBeVisible();
  await expect(add.locator('[data-action="add-suppliers-send"]')).toHaveText(/שלח/);
  await openPicker(add);
  await expect(page.getByPlaceholder(PICKER_PLACEHOLDER)).toBeVisible();
  await page.waitForTimeout(300);
  await shot(page, '09-suppliers-card-add-open');
  await closePicker(page);
  await add.locator('[data-action="add-suppliers-cancel"]').click();
  await expect(add).toHaveCount(0);
  await page.setViewportSize({ width: 1280, height: 720 });
});

test('amending in "including VAT" mode: 118 incl. at 18% is stored as 100.00 before VAT, and the comparison follows the normalised price', async ({ page, browser }) => {
  const rfq = await docIdByTitle(VAT_TITLE);
  const ofer = VAT_SUPPLIERS[2].name;
  const s = await supplierPage(browser, await tokenOf(rfq, ofer));
  // His saved (before VAT) quote is shown; he switches to "including VAT" and types 118 / 696.20 / 1,239.
  await expect(quotePrices(s.page).nth(0)).toHaveValue('520');
  await s.page.locator('[data-mode="incl"]').click();
  for (const [i, v] of ['118', '696.2', '1239'].entries()) await quotePrices(s.page).nth(i).fill(v);
  await expect(s.page.locator('[data-quote-subtotal]')).toHaveText('₪1,740.00'); // 100 + 590 + 1,050
  await expect(s.page.locator('[data-quote-vat]')).toHaveText('₪313.20');
  await expect(s.page.locator('[data-quote-total]')).toHaveText('₪2,053.20');
  await s.page.getByRole('button', { name: 'עדכון ההצעה' }).click();
  await expect(s.page.locator('[data-quote-message="ok"]')).toBeVisible();
  expect(await storedQuote(rfq, ofer)).toEqual({ mode: 'incl', normalised: [100, 590, 1050], entered: [118, 696.2, 1239] });
  await s.ctx.close();

  // Still ONE quote for him, and the comparison now crowns him (1,740 before VAT).
  expect((await pool.query(`select 1 from public.purchasing_quotes where rfq_id = $1 and supplier_name = $2`, [rfq, ofer])).rowCount).toBe(1);
  await page.goto('/purchasing');
  const panel = await openDoc(page, byId(rfq));
  await panel.locator('[data-doc-tab="compare"]').click();
  const cmp = panel.locator('[data-comparison]');
  await expect(cmp.locator('thead th', { hasText: 'ההצעה הזולה' })).toContainText(ofer);
  await expect(cmp.locator('td[data-total-excl][data-cheapest]')).toHaveText('₪1,740.00');
  await expect(cmp.locator('[data-comparison-line="0"] [data-cheapest-cell]')).toHaveText('₪100.00');
  await expect(cmp.locator('[data-cheapest-pill]')).toHaveCount(1);
});

test('adding a supplier AFTER issue, inline in the suppliers card: sent over the ticked channels; unavailable once the request is past its due date', async ({ page, request }) => {
  await mailpitClear(request);
  await request.post(`${GREEN}/__reset`);
  const title = `הוספת ספק ${RUN}`;
  const form = await fillRequest(page, { title, listed: [SUP_A] });
  await issueAndBack(page, form, 'הופקה בלי שליחה');
  const rfq = await docIdByTitle(title);

  const panel = await openDoc(page, byId(rfq));
  const card = panel.locator('[data-suppliers-card]');
  await expect(card.locator('[data-recipient]')).toHaveCount(1);
  await expect(panel.locator('[data-due-badge]')).toHaveAttribute('data-due-badge', 'open');
  await card.locator('[data-action="add-supplier"]').click();
  const add = card.locator('[data-add-suppliers-panel]');
  await expect(add).toBeVisible();
  // Inline: still ONE window, nothing opened over it.
  await expect(page.locator('[data-slot="sheet-content"]')).toHaveCount(1);
  await expect(page.getByRole('dialog')).toHaveCount(1);

  // The supplier already on the request is not offered; B is picked, both channels ticked.
  await openPicker(add);
  await page.getByPlaceholder(PICKER_PLACEHOLDER).fill(SUP_A);
  // (typing its name only offers the generic "add as a name that is not in the list" row, never the listed supplier)
  await expect(page.locator('[role="option"]:not(:has([data-picker-create]))')).toHaveCount(0);
  await page.getByPlaceholder(PICKER_PLACEHOLDER).fill(SUP_B);
  await page.getByRole('option', { name: SUP_B }).click();
  await closePicker(page);
  await expect(add.locator('[data-chip]')).toHaveCount(1);
  await add.getByRole('checkbox', { name: 'מייל' }).click();
  await add.getByRole('checkbox', { name: 'וואטסאפ' }).click();
  await add.locator('[data-action="add-suppliers-send"]').click();

  // The panel closes; the new supplier is in the card with a "נשלח" pill.
  await expect(add).toHaveCount(0, { timeout: 30_000 });
  const added = card.locator(`[data-recipient="${made.suppliers[1]}"]`);
  await expect(added).toBeVisible();
  await expect(added.locator('[data-recipient-status]')).toContainText('נשלח');
  await expect(card.locator('[data-recipient]')).toHaveCount(2);
  // …sent: e-mail with the PDF + personal link, WhatsApp with the link + the PDF file; nothing went to A.
  await expect.poll(() => mailCount(request, `e2e-${RUN}-2@example.com`), { timeout: 20_000 }).toBe(1);
  expect(await mailCount(request, `e2e-${RUN}-1@example.com`)).toBe(0);
  const list = (await (await request.get(`${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`e2e-${RUN}-2@example.com`)}`)).json()) as { messages: Array<{ ID: string }> };
  const mail = (await (await request.get(`${MAILPIT_URL}/api/v1/message/${list.messages[0].ID}`)).json()) as { Text: string; Attachments: Array<{ ContentType: string }> };
  expect(mail.Attachments.map((x) => x.ContentType)).toContain('application/pdf');
  expect(mail.Text).toMatch(LINK_RE);
  const wa = await greenMessages(request, CHAT_B);
  expect(wa.some((m) => LINK_RE.test(m.message))).toBe(true);
  expect(wa.some((m) => m.fileName?.endsWith('.pdf'))).toBe(true);
  expect(await greenMessages(request, CHAT_A)).toHaveLength(0);
  const recs = await pool.query(`select supplier_id from public.purchasing_rfq_recipients where rfq_id = $1`, [rfq]);
  expect(recs.rows.map((r) => r.supplier_id).sort()).toEqual([...made.suppliers].sort());
  await panel.locator('[data-doc-tab="log"]').click();
  await expect(panel.locator('[data-dispatches] li')).toHaveCount(2); // B by e-mail and by WhatsApp
  await expect(panel.locator('[data-dispatches] li').filter({ hasText: SUP_B })).toHaveCount(2);
  await page.keyboard.press('Escape');

  // Past the due date the request is locked: the button is disabled, and the server refuses.
  await pool.query(`update public.purchasing_documents set due_date = '2000-01-01' where id = $1`, [rfq]);
  await page.reload();
  const locked = await openDoc(page, byId(rfq));
  await expect(locked.locator('[data-due-badge]')).toHaveAttribute('data-due-badge', 'locked');
  await expect(locked.locator('[data-action="add-supplier"]')).toBeDisabled();
  const refused = await request.post(`/api/purchasing/documents/${rfq}/recipients`, {
    data: { recipients: [{ supplier_id: made.suppliers[0] }] },
  });
  expect(refused.status()).toBe(409);
});
