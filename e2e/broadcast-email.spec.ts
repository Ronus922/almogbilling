import { test, expect, type APIRequestContext } from '@playwright/test';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { MAILPIT_URL, mailpitClear, saveSmtpSettings, E2E_USER } from './helpers';

// The unified broadcast (09/10/2026): the "תפוצה" category, an email broadcast
// end to end — compose with the channel selector, a template that brings its
// own subject, a file, the "X עם אימייל / Y ללא" counter and its list — and the
// mail actually landing in Mailpit (subject, body with the placeholder
// resolved, the attachment). Then the regression: a WhatsApp broadcast from
// the same screen still goes out on WhatsApp, and the chat's own window is
// still WhatsApp-only.
//
// Two stand-ins, exactly where CI has nothing real:
//   • Storage is unreachable, so ONLY the staging upload is stubbed — it
//     answers with a staged row this spec inserted for e2e-admin (the reminder
//     spec does the same); the worker's byte reader returns the fixture bytes.
//   • No wa-queue-worker runs in the e2e stack, so the spec drives the REAL
//     DeliveryWorker in-process: real campaign rows, the real email path, the
//     real SMTP transport pointed at Mailpit; WhatsApp through MockProvider
//     (nothing reaches Green API).
//
// Fixtures are removed by the exact ids recorded here (iron rule 12). The
// audience is narrowed with "רק מי שחייב — מעל ₪" to this spec's two
// apartments (a debt no seed apartment carries).

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
pool.on('error', () => undefined);

const RUN = Date.now().toString().slice(-7);
const ADDRESS = `e2e-bcast-${RUN}@example.com`;
const WITH_EMAIL = 'נמען מייל';
const NO_EMAIL = `ללא מייל ${RUN}`;
const DEBT = 987_654;
const OVER = '987000';
const PHONE_LOCAL = `05${RUN.slice(0, 8).padEnd(8, '7')}`;
const PHONE_INTL = `972${PHONE_LOCAL.slice(1)}`;
const TEMPLATE = `E2E מייל ${RUN}`;
const EMAIL_CAMPAIGN = `E2E תפוצת מייל ${RUN}`;
const WA_CAMPAIGN = `E2E תפוצת וואטסאפ ${RUN}`;
const FILE_NAME = 'מסמך-בדיקה.pdf';
const PDF = Buffer.from(
  'JVBERi0xLjQKMSAwIG9iajw8L1R5cGUvQ2F0YWxvZz4+ZW5kb2JqCnRyYWlsZXI8PC9Sb290IDEgMCBSPj4KJSVFT0YK',
  'base64',
);

const made = { contacts: [] as string[], debtors: [] as string[], templates: [] as string[], attachments: [] as string[] };
let aptWith = '';
let aptWithout = '';

async function makeApartment(ownerName: string, email: string | null, phone: string | null): Promise<string> {
  const apt = `98${RUN}${made.contacts.length}`;
  const c = await pool.query<{ id: string }>(
    `insert into public.contacts (apartment_number, owner_name, owner_email, owner_phone, owner_is_primary_contact)
     values ($1, $2, $3, $4, true) returning id`, [apt, ownerName, email, phone]);
  made.contacts.push(c.rows[0].id);
  const d = await pool.query<{ id: string }>(
    `insert into public.debtors (apartment_number, contact_id, is_archived, total_debt)
     values ($1, $2, false, $3) returning id`, [apt, c.rows[0].id, DEBT]);
  made.debtors.push(d.rows[0].id);
  return apt;
}

/** Drain this spec's broadcasts with the REAL worker (scripts/e2e/drain-broadcasts.ts,
 *  under tsx like production). SMTP → Mailpit; WhatsApp → MockProvider.
 *  Returns the WhatsApp chat ids the mock provider was asked to send to. */
function drain(names: string[]): string[] {
  const out = execFileSync(process.execPath, [
    'node_modules/tsx/dist/cli.mjs', 'scripts/e2e/drain-broadcasts.ts', JSON.stringify(names), PDF.toString('base64'),
  ], {
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      SKIP_ENV_VALIDATION: '1',
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: process.env.MAILPIT_SMTP_PORT ?? '55525',
      SMTP_REQUIRE_TLS: 'false',
    },
  });
  return (JSON.parse(out.trim().split('\n').pop() ?? '{}') as { whatsapp: string[] }).whatsapp;
}

interface MailpitDetail {
  Subject: string;
  Text: string;
  HTML: string;
  To: { Address: string }[];
  Attachments: { FileName: string; ContentType: string; Size: number }[];
}

async function mailTo(request: APIRequestContext, address: string): Promise<MailpitDetail[]> {
  const list = await request.get(`${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:"${address}"`)}`);
  expect(list.ok()).toBeTruthy();
  const { messages } = (await list.json()) as { messages: { ID: string }[] };
  const out: MailpitDetail[] = [];
  for (const m of messages) {
    const r = await request.get(`${MAILPIT_URL}/api/v1/message/${m.ID}`);
    out.push((await r.json()) as MailpitDetail);
  }
  return out;
}

test.beforeAll(async () => {
  aptWith = await makeApartment(WITH_EMAIL, ADDRESS, PHONE_LOCAL);
  aptWithout = await makeApartment(NO_EMAIL, null, null);
});

test.afterAll(async () => {
  const campaigns = await pool.query<{ id: string }>(
    `select id from public.wa_campaigns where name = any($1::text[])`, [[EMAIL_CAMPAIGN, WA_CAMPAIGN]]);
  const ids = campaigns.rows.map((r) => r.id);
  if (ids.length) await pool.query(`delete from public.wa_campaigns where id = any($1::uuid[])`, [ids]);
  if (made.attachments.length) await pool.query(`delete from public.wa_campaign_attachments where id = any($1::uuid[])`, [made.attachments]);
  if (made.templates.length) await pool.query(`delete from public.whatsapp_templates where id = any($1::uuid[])`, [made.templates]);
  if (made.debtors.length) await pool.query(`delete from public.debtors where id = any($1::uuid[])`, [made.debtors]);
  if (made.contacts.length) await pool.query(`delete from public.contacts where id = any($1::uuid[])`, [made.contacts]);
  await pool.end();
});

test('email broadcast: template subject, file, missing-address list → Mailpit; history + log', async ({ page, request }) => {
  await saveSmtpSettings(request);
  await mailpitClear(request);

  // A shared template with its own email subject — through the real API.
  const tpl = await page.request.post('/api/whatsapp/templates', {
    data: { name: TEMPLATE, content: 'שלום {{name}}, יתרתך {{debt}}', subject: 'עדכון לדירה {{apartment}}' },
  });
  expect(tpl.status(), await tpl.text()).toBe(201);
  made.templates.push(((await tpl.json()) as { id: string }).id);

  // The staged upload the stub hands back (Storage is not reachable in CI).
  const admin = await pool.query<{ id: string }>(`select id from public.users where username = $1`, [E2E_USER]);
  const staged = await pool.query<{ id: string }>(
    `insert into public.wa_campaign_attachments (uploaded_by, bucket, object_key, original_name, mime_type, size_bytes)
     values ($1, 'whatsapp-attachments', $2, $3, 'application/pdf', $4) returning id`,
    [admin.rows[0].id, `${randomUUID()}.pdf`, FILE_NAME, PDF.length]);
  made.attachments.push(staged.rows[0].id);
  await page.route('**/api/whatsapp/campaigns/attachments', (route) => (route.request().method() === 'POST'
    ? route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: staged.rows[0].id, original_name: FILE_NAME, mime_type: 'application/pdf', size_bytes: PDF.length }) })
    : route.continue()));

  // ── The category ───────────────────────────────────────────────────────
  await page.goto('/broadcasts');
  await expect(page).toHaveURL(/\/broadcasts\/new$/);
  await expect(page.getByText('תפוצה', { exact: true }).first()).toBeVisible();

  await page.getByRole('radio', { name: 'מייל' }).click();
  await expect(page.getByLabel('נושא המייל')).toBeVisible();

  await page.getByLabel('שם התפוצה').fill(EMAIL_CAMPAIGN);
  await page.getByRole('checkbox', { name: 'רק מי שחייב' }).click();
  await page.getByLabel('מעל ₪').fill(OVER);

  // The template fills the message AND the subject.
  await page.getByRole('combobox').filter({ hasText: 'כתיבה חופשית' }).click();
  await page.getByRole('option', { name: TEMPLATE }).click();
  await expect(page.getByLabel('נושא המייל')).toHaveValue('עדכון לדירה {{apartment}}');
  await expect(page.locator('#bc-content')).toHaveValue('שלום {{name}}, יתרתך {{debt}}');

  // X with an address / Y without — and who the Y are.
  await expect(page.getByText(/נמענים עם אימייל: 1 · ללא אימייל: 1/)).toBeVisible();
  await page.getByRole('button', { name: /הצג את מי שאין לו אימייל \(1\)/ }).click();
  await expect(page.getByRole('list', { name: 'נמענים ללא אימייל' })).toContainText(`דירה ${aptWithout} · בעלים · ${NO_EMAIL}`);

  await page.locator('input[type="file"]').setInputFiles({ name: FILE_NAME, mimeType: 'application/pdf', buffer: PDF });
  await expect(page.getByText('הועלה')).toBeVisible();

  await page.getByRole('button', { name: /שלח לתפוצה \(1\)/ }).click();
  await expect(page.getByRole('heading', { name: EMAIL_CAMPAIGN })).toBeVisible();

  const row = await pool.query<{ id: string; channel: string; subject: string; total_count: number }>(
    `select id, channel, subject, total_count from public.wa_campaigns where name = $1`, [EMAIL_CAMPAIGN]);
  expect(row.rows[0]).toMatchObject({ channel: 'email', subject: 'עדכון לדירה {{apartment}}', total_count: 1 });

  // ── Delivery ───────────────────────────────────────────────────────────
  drain([EMAIL_CAMPAIGN]);
  const mails = await mailTo(request, ADDRESS);
  expect(mails).toHaveLength(1);
  const [mail] = mails;
  expect(mail.To.map((t) => t.Address)).toEqual([ADDRESS]);
  expect(mail.Subject).toBe(`עדכון לדירה ${aptWith}`);
  expect(mail.Text).toContain(`שלום ${WITH_EMAIL}, יתרתך ₪ 987,654`);
  expect(mail.HTML).toContain('dir="rtl"');
  expect(mail.Attachments).toEqual([expect.objectContaining({ FileName: FILE_NAME, ContentType: 'application/pdf' })]);

  // The apartment without an address: marked above, never a recipient.
  const noMailRow = await pool.query<{ n: number }>(
    `select count(*)::int n from public.wa_campaign_recipients r join public.contacts c on c.id = r.contact_id
      where r.campaign_id = $1 and c.apartment_number = $2`, [row.rows[0].id, aptWithout]);
  expect(noMailRow.rows[0].n).toBe(0);

  // ── History + log ──────────────────────────────────────────────────────
  // A 1440 screen holds the whole table — no horizontal scroll, "נכשלו" and
  // the actions in view (DESIGN.md §9: fixed columns, the name takes the rest).
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/broadcasts/history');
  await page.getByRole('combobox', { name: 'סינון לפי ערוץ' }).click();
  await page.getByRole('option', { name: 'מייל' }).click();
  const histRow = page.getByRole('row').filter({ hasText: EMAIL_CAMPAIGN });
  await expect(histRow).toContainText('מייל');
  await expect(histRow).toContainText('הושלמה');
  const scrolls = await page.locator('main table').evaluate((t) => t.parentElement!.scrollWidth > t.parentElement!.clientWidth);
  expect(scrolls).toBe(false);
  await expect(page.getByRole('columnheader', { name: 'נכשלו' })).toBeInViewport();
  await expect(histRow.getByRole('link', { name: 'צפייה בפרטים' })).toBeInViewport();
  await histRow.getByRole('link', { name: 'צפייה בפרטים' }).click();
  await expect(page).toHaveURL(new RegExp(`/broadcasts/history/${row.rows[0].id}$`));
  await expect(page.getByText(`נושא: עדכון לדירה {{apartment}}`)).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'אימייל' })).toBeVisible();
  const logRow = page.getByRole('row').filter({ hasText: 'e2•••@example.com' });
  await expect(logRow).toContainText('נשלח');
});

test('regression: a WhatsApp broadcast from the category still goes out on WhatsApp; the chat window is WhatsApp-only', async ({ page, request }) => {
  await mailpitClear(request);
  await page.goto('/broadcasts/new');
  await expect(page.getByRole('radio', { name: 'וואטסאפ' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByLabel('נושא המייל')).toHaveCount(0);

  await page.getByLabel('שם התפוצה').fill(WA_CAMPAIGN);
  await page.getByRole('checkbox', { name: 'רק מי שחייב' }).click();
  await page.getByLabel('מעל ₪').fill(OVER);
  await page.locator('#bc-content').fill('שלום {{name}}');
  await expect(page.getByText(/נמענים עם טלפון תקין: 1/)).toBeVisible();
  await expect(page.getByText(/ללא אימייל/)).toHaveCount(0);
  await page.getByRole('button', { name: /שלח לתפוצה \(1\)/ }).click();
  await expect(page.getByRole('heading', { name: WA_CAMPAIGN })).toBeVisible();

  const row = await pool.query<{ channel: string; subject: string | null }>(
    `select channel, subject from public.wa_campaigns where name = $1`, [WA_CAMPAIGN]);
  expect(row.rows[0]).toEqual({ channel: 'whatsapp', subject: null });
  expect(drain([WA_CAMPAIGN])).toEqual([`${PHONE_INTL}@c.us`]);
  const status = await pool.query<{ status: string }>(`select status from public.wa_campaigns where name = $1`, [WA_CAMPAIGN]);
  expect(status.rows[0].status).toBe('completed');
  expect(await mailTo(request, ADDRESS)).toHaveLength(0); // nothing by email

  // The chat's own broadcast window: unchanged, no channel selector.
  await page.goto('/messages');
  await page.getByRole('button', { name: 'תפוצות' }).click();
  const sheet = page.getByRole('dialog').filter({ hasText: 'תפוצת WhatsApp' });
  await expect(sheet.getByLabel('שם התפוצה')).toBeVisible();
  await expect(sheet.getByRole('radio', { name: 'מייל' })).toHaveCount(0);
  await expect(sheet.getByLabel('נושא המייל')).toHaveCount(0);
});
