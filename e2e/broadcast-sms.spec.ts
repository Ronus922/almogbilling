import { test, expect, type Page } from '@playwright/test';
import { Pool } from 'pg';

// SMS broadcast — the compose form → API request, and the server's hard gate
// (08/11/2026).
//
// The incident this guards: the compose form sent `channel` for EMAIL only, so
// choosing "SMS" silently created a WhatsApp broadcast (019 was never called)
// and the building's WhatsApp number sent ~540 messages. Two layers now:
//   • the form ALWAYS sends `channel`, and `sms_whatsapp_fallback` only on SMS
//     (a checkbox, OFF by default);
//   • the server refuses a request without `channel`, a fallback flag on any
//     channel but SMS, and a non-boolean flag — all BEFORE anything is written.
//
// Nothing is sent: the audience count and the create call are intercepted in
// the browser (the POST body is what is asserted), the server-side refusals are
// 400s that return before the first DB write (and carry dry_run besides, so a
// regressed gate could not start a real send), and the API wiring tests create
// STAGED campaigns (start:false — no worker runs in e2e) that are removed by
// the exact ids the API returned.

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
pool.on('error', () => undefined);

const FALLBACK_LABEL = 'גיבוי בוואטסאפ לנמענים שה-SMS נכשל אצלם';
const CAMPAIGN_ID = '00000000-0000-4000-8000-000000000e2e';

interface CapturedBody {
  channel?: string;
  subject?: string;
  sms_whatsapp_fallback?: unknown;
  attachment_ids?: unknown;
  body?: string;
  name?: string;
}

/** Stub the audience count (so the send button enables) and capture the create
 *  call without creating anything; returns a getter for the captured body. */
async function interceptBroadcast(page: Page): Promise<() => CapturedBody | null> {
  let captured: CapturedBody | null = null;
  const campaign = {
    id: CAMPAIGN_ID, type: 'broadcast', channel: 'sms', status: 'completed', name: 'x', body: 'x',
    total_count: 3, pending_count: 0, processing_count: 0, sent_count: 3, failed_count: 0,
    skipped_count: 0, cancelled_count: 0,
  };
  await page.route('**/api/whatsapp/audience-count', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ count: 3, partial_count: 0, missing: [] }),
  }));
  // Exactly the create call and the status poll of one campaign — not /attachments, /health, …
  await page.route(new RegExp(`/api/whatsapp/campaigns(/${CAMPAIGN_ID})?(\\?.*)?$`), (route) => {
    const req = route.request();
    if (req.method() === 'POST') {
      captured = req.postDataJSON() as CapturedBody;
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(campaign) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(campaign) });
  });
  return () => captured;
}

async function compose(page: Page, channelLabel: 'וואטסאפ' | 'SMS' | 'מייל'): Promise<void> {
  await page.goto('/broadcasts/new');
  await page.getByRole('radio', { name: channelLabel }).click();
  await page.getByLabel('שם התפוצה').fill(`E2E ${channelLabel}`);
  await page.locator('#bc-content').fill('שלום {{name}}');
  await expect(page.getByRole('button', { name: /שלח לתפוצה \(3\)/ })).toBeEnabled();
}

test.describe('SMS broadcast compose', () => {
  test('choosing SMS sends channel "sms" with the fallback OFF by default', async ({ page }) => {
    const body = await interceptBroadcast(page);
    await compose(page, 'SMS');

    const box = page.getByRole('checkbox', { name: FALLBACK_LABEL });
    await expect(box).toBeVisible();
    await expect(box).not.toBeChecked();

    await page.getByRole('button', { name: /שלח לתפוצה \(3\)/ }).click();
    await expect.poll(body).not.toBeNull();
    expect(body()).toMatchObject({ channel: 'sms', sms_whatsapp_fallback: false });
    expect(body()).not.toHaveProperty('subject');
  });

  test('ticking the box is the only way the request opts in to the WhatsApp fallback', async ({ page }) => {
    const body = await interceptBroadcast(page);
    await compose(page, 'SMS');

    await page.getByRole('checkbox', { name: FALLBACK_LABEL }).click();
    await page.getByRole('button', { name: /שלח לתפוצה \(3\)/ }).click();
    await expect.poll(body).not.toBeNull();
    expect(body()).toMatchObject({ channel: 'sms', sms_whatsapp_fallback: true });
  });

  test('switching away from SMS drops the box and the flag: a WhatsApp broadcast never carries it', async ({ page }) => {
    const body = await interceptBroadcast(page);
    await compose(page, 'SMS');
    await page.getByRole('checkbox', { name: FALLBACK_LABEL }).click();

    await page.getByRole('radio', { name: 'וואטסאפ' }).click();
    await expect(page.getByRole('checkbox', { name: FALLBACK_LABEL })).toHaveCount(0);
    await page.getByRole('button', { name: /שלח לתפוצה \(3\)/ }).click();
    await expect.poll(body).not.toBeNull();
    expect(body()).toMatchObject({ channel: 'whatsapp' });
    expect(body()).not.toHaveProperty('sms_whatsapp_fallback');
  });

  test('email still sends channel "email" with its subject and no SMS flag', async ({ page }) => {
    const body = await interceptBroadcast(page);
    await page.goto('/broadcasts/new');
    await page.getByRole('radio', { name: 'מייל' }).click();
    await page.getByLabel('שם התפוצה').fill('E2E מייל');
    await page.getByLabel('נושא המייל').fill('נושא בדיקה');
    await page.locator('#bc-content').fill('שלום');
    await page.getByRole('button', { name: /שלח לתפוצה \(3\)/ }).click();
    await expect.poll(body).not.toBeNull();
    expect(body()).toMatchObject({ channel: 'email', subject: 'נושא בדיקה' });
    expect(body()).not.toHaveProperty('sms_whatsapp_fallback');
  });
});

test.describe('POST /api/whatsapp/campaigns — the server\'s hard gate (refused before anything is written)', () => {
  // dry_run: if a gate ever regressed, the request still could not start a real send.
  const valid = { name: 'E2E gate', body: 'שלום', audience: { type: 'selection', roles: ['owners'] }, dry_run: true };

  test('a request without a channel is refused — it no longer defaults to WhatsApp', async ({ page }) => {
    const res = await page.request.post('/api/whatsapp/campaigns', { data: valid });
    expect(res.status()).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('ערוץ');
  });

  test('an unknown channel is refused', async ({ page }) => {
    const res = await page.request.post('/api/whatsapp/campaigns', { data: { ...valid, channel: 'fax' } });
    expect(res.status()).toBe(400);
  });

  test('the fallback flag is refused on whatsapp and on email', async ({ page }) => {
    for (const channel of ['whatsapp', 'email']) {
      const res = await page.request.post('/api/whatsapp/campaigns', {
        data: { ...valid, channel, subject: 's', sms_whatsapp_fallback: true },
      });
      expect(res.status(), channel).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain('SMS');
    }
  });

  test('a non-boolean flag is refused even on sms', async ({ page }) => {
    const res = await page.request.post('/api/whatsapp/campaigns', {
      data: { ...valid, channel: 'sms', sms_whatsapp_fallback: 'true' },
    });
    expect(res.status()).toBe(400);
  });
});

test.describe('POST /api/whatsapp/campaigns — what the server stores (staged, never started)', () => {
  const RUN = Date.now().toString().slice(-7);
  const DEBT = 876_543;
  const PHONE = `05${RUN.padEnd(8, '6')}`;
  const made = { contacts: [] as string[], debtors: [] as string[], campaigns: [] as string[] };

  test.beforeAll(async () => {
    const apt = `97${RUN}0`;
    const c = await pool.query<{ id: string }>(
      `insert into public.contacts (apartment_number, owner_name, owner_phone, owner_is_primary_contact)
       values ($1, $2, $3, true) returning id`, [apt, `E2E SMS ${RUN}`, PHONE]);
    made.contacts.push(c.rows[0].id);
    const d = await pool.query<{ id: string }>(
      `insert into public.debtors (apartment_number, contact_id, is_archived, total_debt)
       values ($1, $2, false, $3) returning id`, [apt, c.rows[0].id, DEBT]);
    made.debtors.push(d.rows[0].id);
  });

  test.afterAll(async () => {
    if (made.campaigns.length) await pool.query(`delete from public.wa_campaigns where id = any($1::uuid[])`, [made.campaigns]);
    if (made.debtors.length) await pool.query(`delete from public.debtors where id = any($1::uuid[])`, [made.debtors]);
    if (made.contacts.length) await pool.query(`delete from public.contacts where id = any($1::uuid[])`, [made.contacts]);
    await pool.end();
  });

  async function create(page: Page, extra: Record<string, unknown>): Promise<{ id: string; total_count: number }> {
    const res = await page.request.post('/api/whatsapp/campaigns', {
      data: {
        name: `E2E ${RUN} ${Math.random().toString(36).slice(2, 7)}`, body: 'שלום',
        audience: { type: 'selection', roles: ['owners'], debt_filter: { only_with_debt: true, min_debt_amount: 876_000 } },
        start: false, ...extra,
      },
    });
    expect(res.status(), await res.text()).toBe(201);
    const body = (await res.json()) as { id: string; total_count: number };
    made.campaigns.push(body.id);
    return body;
  }

  async function stored(id: string): Promise<{ channel: string; sms_whatsapp_fallback: boolean; instance_id: string | null; status: string }> {
    const r = await pool.query(`select channel, sms_whatsapp_fallback, instance_id, status from public.wa_campaigns where id = $1`, [id]);
    return r.rows[0];
  }

  test('sms without the flag: stored as sms, flag false, and NO WhatsApp instance is attached', async ({ page }) => {
    const c = await create(page, { channel: 'sms' });
    expect(c.total_count).toBe(1);
    expect(await stored(c.id)).toMatchObject({ channel: 'sms', sms_whatsapp_fallback: false, instance_id: null, status: 'queued' });
  });

  test('sms with the explicit flag: the flag is stored and the WhatsApp instance the fallback needs is attached', async ({ page }) => {
    const c = await create(page, { channel: 'sms', sms_whatsapp_fallback: true });
    const row = await stored(c.id);
    expect(row).toMatchObject({ channel: 'sms', sms_whatsapp_fallback: true });
    expect(row.instance_id).not.toBeNull();
  });

  test('whatsapp: stored as whatsapp with an instance and no flag (unchanged)', async ({ page }) => {
    const c = await create(page, { channel: 'whatsapp' });
    const row = await stored(c.id);
    expect(row).toMatchObject({ channel: 'whatsapp', sms_whatsapp_fallback: false });
    expect(row.instance_id).not.toBeNull();
  });
});
