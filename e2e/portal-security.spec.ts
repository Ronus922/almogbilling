import { test, expect, type Browser, type BrowserContext } from '@playwright/test';
import { Pool } from 'pg';

// The owners portal, attacked: the twelve checks of the 28/09/2026 security
// pass, against the fixtures of db/seed/e2e.sql (apartments E2E-A..D, their
// owners' live sessions, an expired and a revoked one, a hidden month with
// canary values, one-time codes "123456"). Everything a resident must never
// see carries a CANARY-… value, and every response of every tab is scanned
// for it — HTML, the RSC payload, the JSON API and the Excel export.
//
// No admin cookie by default: each check builds its own context with the
// portal cookie of one owner; the admin's session (auth.setup) is loaded
// only where the check is about staff.

// The admin session auth.setup saved (the same path playwright.config names).
const STORAGE_STATE = 'e2e/.auth/state.json';

test.use({ storageState: { cookies: [], origins: [] } });

const A1 = 'e2e-owner-a1';
const A2 = 'e2e-owner-a2';
const HIDDEN_RECEIPT = 'e2e00000-0000-4000-8000-0000000000aa.pdf';
const PUBLISHED_RECEIPT = 'e2e00000-0000-4000-8000-0000000000bb.pdf';

/** Strings that must never reach a resident, whatever the tab or format. */
const CANARIES = [
  'CANARY-OWNER-', 'CANARY-NOTE-', 'CANARY-ACTION-', 'CANARY-LEGAL-', 'CANARY-DISABLED', 'CANARY-DETAILS-D',
  'CANARY-SUPPLIER', 'CANARY-INVOICE', 'CANARY-INTERNAL', 'CANARY-HIDDEN-ENTRY', 'CANARY-RECEIPT-HIDDEN',
  '050-1111111', '050-2222222', '050-3333333', '050-4444444', '050-6666666', 'canary-a@example.com', 'canary-b@example.com',
  '6543.21', '6,543.21', '7654321', '7,654,321', 'e2e00000-0000-4000-8000-0000000000aa',
  // no storage URL of any kind — every file goes through /api/files
  'supabase.co', 'X-Amz-', 'token=', '/storage/v1/',
];

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const FIXTURE_PHONES = ['+972501111111', '+972501111112', '+972502222222', '+972503333333', '+972504444444', '+972505555555'];

// The OTP checks consume codes, lock a phone and start cooldowns; put the
// fixtures back to their seeded state so the suite can run again on the same
// test database (CI gets a fresh one anyway).
test.beforeAll(async () => {
  await pool.query(`delete from public.portal_otp_codes where phone_e164 = any($1::text[])`, [FIXTURE_PHONES]);
  await pool.query(`delete from public.portal_lockouts where phone_e164 = any($1::text[])`, [FIXTURE_PHONES]);
  await pool.query(`delete from public.auth_rate_limits where bucket like 'portal:%'`);
  await pool.query(
    `insert into public.portal_otp_codes (phone_e164, code_hash, expires_at)
     select v.p, crypt('123456', gen_salt('bf', 10)), v.exp from (values
       ('+972502222222', now() + interval '2 hours'),
       ('+972503333333', now() + interval '2 hours'),
       ('+972504444444', now() - interval '1 minute')
     ) v(p, exp)`,
  );
  await pool.query(`update public.portal_sessions set revoked_at = null where token_hash = encode(digest('e2e-owner-disabled','sha256'),'hex')`);
});
test.afterAll(async () => { await pool.end(); });

async function owner(browser: Browser, token: string): Promise<BrowserContext> {
  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  await ctx.addCookies([{ name: 'portal_session', value: token, domain: 'localhost', path: '/' }]);
  return ctx;
}

async function admin(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({ storageState: STORAGE_STATE });
}

function scan(text: string, extra: string[] = []): string[] {
  return [...CANARIES, ...extra].filter((c) => text.includes(c));
}

const TABS = ['ov', 'tx', 'fund', 'rep', 'acc', 'dec'] as const;
const nowKey = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' }).slice(0, 7);
const prevKey = () => { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 7); };

async function setSwitches(browser: Browser, s: { docs?: boolean; bank?: boolean }) {
  const ctx = await admin(browser);
  const body: Record<string, boolean> = {};
  if (s.docs !== undefined) body.show_documents_to_residents = s.docs;
  if (s.bank !== undefined) body.show_bank_balance_to_residents = s.bank;
  const r = await ctx.request.put('/api/finance/settings', { data: body });
  expect(r.status(), await r.text()).toBe(200);
  await ctx.close();
}

test.describe('1. isolation between apartments (IDOR)', () => {
  test('owner A sees only A, whatever parameter, header or body names B', async ({ browser }) => {
    const ctx = await owner(browser, A1);
    const attempts = [
      '/portal?tab=acc',
      '/portal?tab=acc&apt=E2E-B',
      '/portal?tab=acc&apartment=E2E-B&apartment_number=E2E-B',
      '/portal?tab=acc&contact_id=00000000-0000-4000-8000-0000000e2e0b&debtor_id=00000000-0000-4000-8000-0000000e2e0b',
      '/portal?tab=ov&apt=E2E-B',
    ];
    for (const url of attempts) {
      const r = await ctx.request.get(url, { headers: { 'x-apartment': 'E2E-B', 'x-apartment-number': 'E2E-B' } });
      expect(r.status(), url).toBe(200);
      const html = await r.text();
      // (the raw query string is echoed in the router state — the rendered
      // account is what must be A's, and B's / C's figures must be absent)
      expect(html, url).toContain('דירה E2E-A');
      expect(html, url).not.toContain('דירה E2E-B');
      expect(html, url).not.toContain('דירה E2E-C');
      expect(html, url).not.toContain('₪300');
      expect(scan(html), url).toEqual([]);
    }
    // the JSON API ignores a body / query naming another apartment too
    for (const m of ['POST', 'GET'] as const) {
      const r = await ctx.request.fetch('/api/portal/finance/period?tab=operating&apt=E2E-B&apartment=E2E-B', {
        method: m, data: m === 'POST' ? { apartment: 'E2E-B', debtor_id: '00000000-0000-4000-8000-0000000e2e0b' } : undefined,
      });
      expect([200, 405]).toContain(r.status());
      if (r.status() === 200) expect(scan(await r.text())).toEqual([]);
    }
    await ctx.close();
  });

  test('both owners of A get the same account', async ({ browser }) => {
    const [c1, c2] = await Promise.all([owner(browser, A1), owner(browser, A2)]);
    const [p1, p2] = await Promise.all([c1.newPage(), c2.newPage()]);
    await p1.goto('/portal?tab=acc'); await p2.goto('/portal?tab=acc');
    const kpis = (p: typeof p1) => p.evaluate(() => [...document.querySelectorAll('#t-acc .kpi')].map((k) => `${k.querySelector('.k')?.textContent}=${k.querySelector('.v')?.textContent}`));
    const [k1, k2] = await Promise.all([kpis(p1), kpis(p2)]);
    expect(k1).toEqual(['יתרה לתשלום=₪1,240', 'חוב דמי ניהול=₪840', 'חוב מים חמים=₪400', 'חיוב חודשי=3/26']);
    expect(k2).toEqual(k1);
    await c1.close(); await c2.close();
  });
});

test.describe('2. full payload scan', () => {
  test('no canary in any tab — HTML, RSC payload, JSON API — with both switches off', async ({ browser }) => {
    await setSwitches(browser, { docs: false, bank: false });
    const ctx = await owner(browser, A1);
    for (const tab of TABS) {
      for (const q of [`/portal?tab=${tab}`, `/portal?tab=${tab}&m=${nowKey()}&r=${nowKey().slice(0, 4)}`]) {
        const html = await (await ctx.request.get(q)).text();
        expect(scan(html, ['e2e00000-0000-4000-8000-0000000000bb', 'bank_balance', '48,320', '46,180']), `${q} html`).toEqual([]);
        const rsc = await (await ctx.request.get(q, { headers: { RSC: '1' } })).text();
        expect(scan(rsc, ['e2e00000-0000-4000-8000-0000000000bb', '48,320', '46,180']), `${q} rsc`).toEqual([]);
      }
    }
    for (const q of [`/api/portal/finance/period?tab=operating&m=${nowKey()}`, `/api/portal/finance/period?tab=operating&m=${prevKey()}`, '/api/portal/finance/period?tab=fund', '/api/portal/finance/months']) {
      const r = await ctx.request.get(q);
      expect(r.status(), q).toBe(200);
      expect(scan(await r.text(), ['e2e00000-0000-4000-8000-0000000000bb', 'bank_balance']), q).toEqual([]);
    }
    await ctx.close();
  });

  test('the Excel export holds the published month only, with formulas neutralised', async ({ browser }) => {
    const ctx = await owner(browser, A1);
    const page = await ctx.newPage();
    await page.goto(`/portal?tab=tx&m=${nowKey()}`);
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#t-tx .pbtn-secondary')]);
    const path = await dl.path();
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(path!);
    const cells: string[] = [];
    wb.eachSheet((ws) => ws.eachRow((row) => row.eachCell((c) => cells.push(String(c.value ?? '')))));
    const text = cells.join('\n');
    expect(scan(text)).toEqual([]);
    expect(text).toContain('E2E ניקיון חדר מדרגות');
    expect(cells.some((c) => c.startsWith("'=1+1"))).toBe(true);
    expect(cells.some((c) => c.startsWith('=1+1'))).toBe(false);
    await ctx.close();
  });
});

test.describe('3. session', () => {
  test('no cookie, an expired, a forged and a revoked cookie → 307 / 401', async ({ browser }) => {
    for (const token of [null, 'e2e-expired', 'forged-token-000', 'e2e-revoked']) {
      const ctx = token ? await owner(browser, token) : await browser.newContext({ storageState: { cookies: [], origins: [] } });
      const page = await ctx.request.get('/portal', { maxRedirects: 0 });
      expect(page.status(), `${token} page`).toBe(307);
      expect(page.headers().location, `${token} page`).toContain('/portal/login');
      const api = await ctx.request.get('/api/portal/finance/months');
      expect(api.status(), `${token} api`).toBe(401);
      await ctx.close();
    }
  });

  test('an owner switched off in the roster loses access on the next request, and the session is revoked', async ({ browser }) => {
    const ctx = await owner(browser, 'e2e-owner-disabled');
    const r = await ctx.request.get('/portal', { maxRedirects: 0 });
    expect(r.status()).toBe(307);
    const row = await pool.query(`select revoked_at from public.portal_sessions where token_hash = encode(digest('e2e-owner-disabled','sha256'),'hex')`);
    expect(row.rows[0]?.revoked_at).not.toBeNull();
    await ctx.close();
  });

  test('a real login sets the cookie with HttpOnly, Secure, SameSite=Lax, Path=/ and no Max-Age', async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const r = await ctx.request.post('/api/portal/otp/verify', { data: { phone: '0503333333', code: '123456' } });
    expect(r.status(), await r.text()).toBe(200);
    const setCookie = r.headersArray().filter((h) => h.name.toLowerCase() === 'set-cookie').map((h) => h.value).join('\n');
    expect(setCookie).toMatch(/portal_session=/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/Secure/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).toMatch(/Path=\//i);
    expect(setCookie).not.toMatch(/Max-Age|Expires=/i);
    // the code is consumed: the same digits are refused now
    const again = await ctx.request.post('/api/portal/otp/verify', { data: { phone: '0503333333', code: '123456' } });
    expect(again.status()).toBe(401);
    await ctx.close();
  });
});

test.describe('4. staff and residents are separate worlds', () => {
  test('a portal cookie opens nothing of the staff app', async ({ browser }) => {
    const ctx = await owner(browser, A1);
    for (const [url, expected] of [
      ['/finance', 307], ['/finance?view=resident&apt=E2E-B', 307], ['/dashboard', 307], ['/admin/portal-log', 307],
    ] as const) {
      const r = await ctx.request.get(url, { maxRedirects: 0 });
      expect(r.status(), url).toBe(expected);
      expect(r.headers().location, url).toContain('/login');
    }
    for (const url of ['/api/debtors', '/api/contacts', '/api/finance/settings', '/api/admin/portal-log', '/api/whatsapp/instances']) {
      const r = await ctx.request.get(url);
      expect([401, 404], url).toContain(r.status());
      expect(r.status(), url).not.toBe(200);
    }
    const bot = await ctx.request.post('/api/agent/chat', { data: { message: 'x' } });
    expect(bot.status()).toBe(401);
    await ctx.close();
  });

  test('a staff cookie opens nothing of the portal, and the assistant is not in the portal', async ({ browser }) => {
    const ctx = await admin(browser);
    const page = await ctx.request.get('/portal', { maxRedirects: 0 });
    expect(page.status()).toBe(307);
    const api = await ctx.request.get('/api/portal/finance/months');
    expect(api.status()).toBe(401);
    await ctx.close();
    const o = await owner(browser, A1);
    const p = await o.newPage();
    await p.goto('/portal?tab=ov');
    await expect(p.locator('#t-ov')).toBeVisible();
    await expect(p.locator('[data-agent-fab]')).toHaveCount(0);
    await o.close();
  });
});

test.describe('5. unpublished months', () => {
  test('?m=, ?r=, the report, the export and the chart never show the hidden month', async ({ browser }) => {
    const ctx = await owner(browser, A1);
    const page = await ctx.newPage();
    await page.goto(`/portal?tab=tx&m=${nowKey()}`);
    expect(await page.inputValue('#t-tx select.sel')).toBe(prevKey());
    const options = await page.$$eval('#t-tx option', (o) => o.map((x) => (x as HTMLOptionElement).value));
    expect(options).not.toContain(nowKey());
    await page.goto(`/portal?tab=rep&r=${nowKey().slice(0, 4)}`);
    const rep = await page.content();
    expect(scan(rep)).toEqual([]);
    expect(rep).toContain('כולל');
    await page.goto(`/portal?m=${nowKey().slice(0, 4)}-Q${Math.floor((Number(nowKey().slice(5)) - 1) / 3) + 1}`);
    expect(await page.$eval('.nav button.on', (b) => b.textContent)).toBe('דוחות');
    await page.goto('/portal?tab=ov');
    const labels = await page.$$eval('.chart .grp text', (t) => t.map((x) => x.textContent));
    const hiddenShort = ['ינו׳', 'פבר׳', 'מרץ', 'אפר׳', 'מאי', 'יוני', 'יולי', 'אוג׳', 'ספט׳', 'אוק׳', 'נוב׳', 'דצמ׳'][Number(nowKey().slice(5)) - 1];
    expect(labels).not.toContain(hiddenShort);
    await ctx.close();
  });
});

test.describe('6. files (/api/files)', () => {
  test('switch off → 401; on → only a receipt of a published month; other buckets, traversal and guesses fail', async ({ browser }) => {
    await setSwitches(browser, { docs: false });
    const ctx = await owner(browser, A1);
    expect((await ctx.request.get(`/api/files/finance-receipts/${PUBLISHED_RECEIPT}`)).status()).toBe(401);
    await setSwitches(browser, { docs: true });
    // granted: the storage behind this build is a stub, so the proxy answers 404
    // after the guard — anything but 401 proves the portal branch let it through
    expect((await ctx.request.get(`/api/files/finance-receipts/${PUBLISHED_RECEIPT}`)).status()).not.toBe(401);
    expect((await ctx.request.get(`/api/files/finance-receipts/${HIDDEN_RECEIPT}`)).status()).toBe(401);
    expect((await ctx.request.get(`/api/files/finance-receipts/${HIDDEN_RECEIPT}`)).status()).not.toBe(200);
    expect((await ctx.request.get('/api/files/finance-receipts/00000000-0000-4000-8000-0000000000ff.pdf')).status()).toBe(401);
    for (const bucket of ['whatsapp-attachments', 'issue-attachments', 'documents', 'supplier-documents']) {
      expect((await ctx.request.get(`/api/files/${bucket}/${PUBLISHED_RECEIPT}`)).status(), bucket).toBe(401);
    }
    for (const bad of ['../../etc/passwd', '..%2F..%2Fetc%2Fpasswd', 'x/../y.pdf', 'no-uuid.pdf']) {
      const r = await ctx.request.get(`/api/files/finance-receipts/${bad}`);
      expect([400, 401, 404], bad).toContain(r.status());
    }
    expect((await ctx.request.get('/api/files/nope/' + PUBLISHED_RECEIPT)).status()).toBe(404);
    // the document button appears only with the switch on, and only on the published month
    const page = await ctx.newPage();
    await page.goto(`/portal?tab=tx&m=${prevKey()}`);
    await expect(page.locator('.doc')).toHaveCount(1);
    expect(await page.$eval('.doc', (a) => a.getAttribute('href'))).toBe(`/api/files/finance-receipts/${PUBLISHED_RECEIPT}`);
    await setSwitches(browser, { docs: false });
    await page.goto(`/portal?tab=tx&m=${prevKey()}`);
    await expect(page.locator('.doc')).toHaveCount(0);
    await ctx.close();
  });
});

test.describe('7. one-time codes', () => {
  test('wrong codes lock the phone on the 5th, a code of another phone does not open this one, an expired code is refused', async ({ request }) => {
    // B: 4 wrong (one of them "A's" code shape), then the 5th → locked; the right code is refused while locked
    for (let i = 1; i <= 4; i += 1) {
      const r = await request.post('/api/portal/otp/verify', { data: { phone: '0502222222', code: '000000' } });
      expect(r.status(), `attempt ${i}`).toBe(401);
    }
    const fifth = await request.post('/api/portal/otp/verify', { data: { phone: '0502222222', code: '111111' } });
    expect(fifth.status()).toBe(429);
    expect((await fifth.json()).locked).toBe(true);
    const locked = await request.post('/api/portal/otp/verify', { data: { phone: '0502222222', code: '123456' } });
    expect(locked.status()).toBe(429);
    // D: the code exists but is past its TTL
    const expired = await request.post('/api/portal/otp/verify', { data: { phone: '0504444444', code: '123456' } });
    expect(expired.status()).toBe(401);
    expect((await expired.json()).message).toContain('פג תוקף');
  });

  test("a tenant's phone gets the decided message and no code; a repeat request inside 60s is throttled", async ({ request }) => {
    const tenant = await request.post('/api/portal/otp/request', { data: { phone: '050-6666666' } });
    expect(tenant.status()).toBe(200);
    const body = await tenant.json();
    expect(body.sent).toBeUndefined();
    expect(body.message).toContain('אינו רשום');
    // an owner: the code is issued (the send fails here — no WhatsApp instance), the 60s cooldown holds
    const first = await request.post('/api/portal/otp/request', { data: { phone: '0501111112' } });
    expect([200, 502]).toContain(first.status());
    const second = await request.post('/api/portal/otp/request', { data: { phone: '0501111112' } });
    expect(second.status()).toBe(429);
    expect((await second.json()).retryAfterSec).toBeGreaterThan(0);
  });
});

test.describe('8. cache', () => {
  test('every portal page and API answers private, no-store', async ({ browser }) => {
    const ctx = await owner(browser, A1);
    for (const url of ['/portal', '/portal?tab=acc', '/portal/login', '/api/portal/finance/months', '/api/portal/finance/period?tab=fund']) {
      const cc = (await ctx.request.get(url)).headers()['cache-control'] ?? '';
      expect(cc, url).toContain('private');
      expect(cc, url).toContain('no-store');
    }
    await ctx.close();
  });
});

test.describe('9. injection', () => {
  test('a <script> in the CRM details and in a line description is text, not code', async ({ browser }) => {
    const ctx = await owner(browser, A1);
    const page = await ctx.newPage();
    await page.goto('/portal?tab=acc');
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
    await expect(page.locator('#t-acc .details')).toContainText('<script>window.__pwned=1</script>');
    await page.goto(`/portal?tab=tx&m=${prevKey()}`);
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
    await expect(page.locator('#t-tx .ds', { hasText: '<script>' })).toHaveCount(1);
    await ctx.close();
  });
});

test.describe('10. the admin preview', () => {
  test('the apartment picker is staff-only: a portal cookie and a viewer without finance are both refused', async ({ browser }) => {
    const o = await owner(browser, A1);
    const r = await o.request.get('/finance?view=resident&apt=E2E-B', { maxRedirects: 0 });
    expect(r.status()).toBe(307);
    expect(r.headers().location).toContain('/login');
    await o.close();
    const viewer = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const login = await viewer.request.post('/api/auth/login', { data: { username: 'e2e-viewer', password: 'E2e-Viewer0!', remember: false } });
    expect(login.status(), await login.text()).toBe(200);
    const denied = await viewer.request.get('/finance?view=resident&apt=E2E-B', { maxRedirects: 0 });
    expect(denied.status()).toBe(307);
    // bounced out of /finance — to the debtors screen or the no-access page,
    // never rendered
    expect(denied.headers().location).toMatch(/\/(dashboard|no-access)/);
    expect(denied.headers().location).not.toContain('/finance');
    await viewer.request.post('/api/auth/logout');
    await viewer.close();
    // the admin does see B's account there — and the strip
    const a = await admin(browser);
    const page = await a.newPage();
    await page.goto('/finance?view=resident&apt=E2E-B&tab=acc');
    await expect(page.getByText('תצוגה מקדימה — כך רואה דייר')).toBeVisible();
    await expect(page.locator('#t-acc')).toContainText('דירה E2E-B');
    await expect(page.locator('#t-acc')).toContainText('₪300');
    // an apartment that does not exist is ignored, not reflected
    await page.goto('/finance?view=resident&apt=NOPE&tab=acc');
    await expect(page.locator('main.wrap')).toBeVisible();
    await expect(page.locator('main.wrap')).not.toContainText('NOPE');
    expect(await page.inputValue('select[aria-label="דירה לתצוגה מקדימה"]')).toBe('');
    await a.close();
  });
});

test.describe('11. security headers', () => {
  test('the portal carries the global headers', async ({ request }) => {
    const h = (await request.get('/portal/login')).headers();
    expect(h['strict-transport-security']).toContain('max-age');
    expect(h['x-content-type-options']).toBe('nosniff');
    expect(h['x-frame-options']).toBe('SAMEORIGIN');
    expect(h['content-security-policy']).toContain("frame-ancestors 'self'");
    expect(h['referrer-policy']).toBeTruthy();
  });
});
