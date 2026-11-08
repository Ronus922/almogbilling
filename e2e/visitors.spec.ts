import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { Pool } from 'pg';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { loginThroughForm } from './helpers';
import { AnthropicStub, StorageStub } from './visitors-stubs';

// "סריקת כניסה" and the guard ("שומר", 08/11/2026), end to end on the production
// build: the admin creates a guard with a username and a password and NO e-mail
// (through the real Users screen); the guard signs in and sees one screen only —
// every other page and every other API answers no; a scan goes photo → OCR →
// form → save → table → details → notes; the roles that may only read cannot
// write; the admin edits and deletes; the guard changes their own password.
//
// Two stand-ins run IN this process for the length of the spec (no other spec
// sees them): the Anthropic Messages API (the OCR — the app's server is started
// with ANTHROPIC_BASE_URL pointing here) and Supabase Storage (CI runs no
// Storage service). Everything else is real: the production build, Postgres, the
// session cookies, the role guards, the audit log.
//
// Fixtures are removed by the exact ids recorded here (CLAUDE.md iron rule 12).

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
pool.on('error', () => undefined);

const RUN = Date.now().toString(36);
const PASSWORD = 'E2e-Gate-Pass1!';
const NEW_PASSWORD = 'E2e-Gate-Pass2!';
const GUARD = `gate-${RUN}`;
const GUARD2 = `gate2-${RUN}`;
const NAME_TOKEN = `VE${RUN}`;

const ANTHROPIC_PORT = Number(process.env.E2E_ANTHROPIC_PORT ?? 3111);
const storageUrl = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'http://localhost:54321');
const STORAGE_PORT = Number(storageUrl.port || 54321);

const anthropic = new AnthropicStub();
const storage = new StorageStub();

const userIds: string[] = [];
const scanIds: string[] = [];
const roleUser: Record<string, { username: string; id: string }> = {};
const contexts: BrowserContext[] = [];

const OCR_REPLY = {
  document_type: 'id_card',
  document_number: '123 456 789',
  first_name: 'דוד',
  last_name: NAME_TOKEN,
  date_of_birth: '17/05/1990',
  nationality: 'ישראלית',
  confidence: { document_type: 0.99, document_number: 0.96, first_name: 0.95, last_name: 0.93, date_of_birth: 0.55, nationality: 0.9 },
};

async function photo(w = 1200, h = 800): Promise<Buffer> {
  return sharp({ create: { width: w, height: h, channels: 3, background: '#4a6fa5' } }).jpeg().toBuffer();
}

async function userId(username: string): Promise<string> {
  const r = await pool.query<{ id: string }>(`select id from public.users where username = $1`, [username]);
  expect(r.rows, `user ${username}`).toHaveLength(1);
  return r.rows[0]!.id;
}

// Every login attempt counts toward the per-IP limit (20 / 15 min) that the WHOLE e2e job
// shares, and the suite before this spec already spends most of it. So this spec signs in
// through the form only where the form is what is being tested — the guard (once, in capitals:
// the case never matters) and the two sign-ins of the password-change test. Every other
// context gets the session a login would have created: the same row in public.sessions
// (the cookie holds the raw id, the table its SHA-256), inserted for the user directly.
type Signed = Awaited<ReturnType<typeof loginThroughForm>>;
const signedIn = new Map<string, Signed>();

async function sessionContext(browser: Browser, uid: string): Promise<Signed> {
  const raw = randomBytes(32).toString('base64url');
  await pool.query(
    `insert into public.sessions (id, user_id, expires_at, remember) values ($1, $2, now() + interval '3 hours', false)`,
    [createHash('sha256').update(raw).digest('hex'), uid],
  );
  const ctx = await browser.newContext({
    storageState: { cookies: [{ name: 'almog_sid', value: raw, domain: 'localhost', path: '/', httpOnly: true, secure: true, sameSite: 'Lax', expires: -1 }], origins: [] },
  });
  contexts.push(ctx);
  return { ctx, page: await ctx.newPage(), ok: true };
}

async function signIn(browser: Browser, username: string, password = PASSWORD): Promise<Signed> {
  const key = `${username.toLowerCase()}\n${password}`;
  const cached = signedIn.get(key);
  if (cached) return cached;
  const real = password !== PASSWORD || username.toLowerCase() === GUARD;
  let s: Signed;
  if (real) {
    s = await loginThroughForm(browser, username, password);
    contexts.push(s.ctx);
  } else {
    s = await sessionContext(browser, await userId(username));
  }
  signedIn.set(key, s);
  return s;
}

/** Walks a directory and returns every file called `name`. */
function findFiles(dir: string, name: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) findFiles(p, name, out);
    else if (e === name) out.push(p);
  }
  return out;
}

const FAKE_ID = '00000000-0000-4000-8000-0000000000aa';
/** src/app/…/[id]/route.ts → /…/<uuid>  ([...rest] → a/b; (groups) vanish). */
function urlFor(file: string, root: string): string {
  const rel = file.slice(root.length).replace(/\/(page|route)\.tsx?$/, '');
  return (
    rel
      .split('/')
      .filter((s) => s !== '' && !(s.startsWith('(') && s.endsWith(')')))
      .map((s) => (s.startsWith('[...') ? 'a/b' : s.startsWith('[') ? FAKE_ID : s))
      .reduce((acc, s) => `${acc}/${s}`, '') || '/'
  );
}

/** Search for a row by text, wait until the table has settled on exactly that row
 *  (the search is debounced — a click right after typing can still hit the old list),
 *  and open it. */
async function openRow(page: Page, text: string): Promise<void> {
  await page.locator('input[data-filter-search]').fill(text);
  const rows = page.locator('tr[data-visitor-row]');
  await expect(rows).toHaveCount(1);
  await rows.first().click();
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  await anthropic.start(ANTHROPIC_PORT);
  await storage.start(STORAGE_PORT);
});

test.beforeEach(() => {
  anthropic.reset();
  anthropic.reply = OCR_REPLY;
});

test.afterAll(async () => {
  for (const c of contexts) await c.close().catch(() => undefined);
  const strays = await pool.query<{ id: string }>(`select id from public.visitor_scans where scanned_by = any($1::uuid[]) or last_name like $2`, [userIds, `${NAME_TOKEN}%`]);
  const scans = [...new Set([...scanIds, ...strays.rows.map((r) => r.id)])];
  await pool.query(`delete from public.audit_log where entity_id = any($1::text[]) or entity_id = any($2::text[]) or actor_user_id = any($2::uuid[])`, [scans, userIds]);
  await pool.query(`delete from public.visitor_scans where id = any($1::uuid[])`, [scans]);
  // rate-limit rows of the users made here, by their exact buckets (iron rule 12)
  const buckets = userIds.flatMap((id) => [`pwchange:user:${id}`, `visitor-ocr:user:${id}`, `visitor-ocr-day:user:${id}`, `visitor-save:user:${id}`]);
  await pool.query(`delete from public.auth_rate_limits where bucket = any($1::text[]) or bucket = any($2::text[])`, [buckets, [`login:user:${GUARD}`, `login:user:${GUARD2}`]]);
  await pool.query(`delete from public.users where id = any($1::uuid[])`, [userIds]);
  await anthropic.stop();
  await storage.stop();
  await pool.end();
});

// ── 1. The admin creates a guard — no e-mail, no invite ──────────────────────

test('the admin creates a guard with a username and a password, and no e-mail', async ({ page, request }) => {
  await page.goto('/settings/users');
  await page.getByRole('button', { name: 'צור משתמש' }).first().click();
  const panel = page.getByRole('dialog');
  await panel.getByRole('button', { name: /שומר/ }).click();

  // The guard form: a username, an OPTIONAL e-mail, a REQUIRED password.
  await expect(panel.locator('#invite-username')).toBeVisible();
  await expect(panel.getByText('אימייל (אופציונלי)')).toBeVisible();
  const save = panel.getByRole('button', { name: 'צור משתמש' });
  await panel.locator('#invite-name').fill(`שומר ${RUN}`);
  await expect(save).toBeDisabled();
  await panel.locator('#invite-username').fill('Bad Name!');
  await panel.locator('#invite-password').fill(PASSWORD);
  await expect(save).toBeDisabled(); // an invalid username blocks the save
  await panel.locator('#invite-username').fill(GUARD.toUpperCase()); // typed in capitals, stored lower-case
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page.getByText(/המשתמש נוצר — שומר/)).toBeVisible();

  const row = (await pool.query(`select id, username, email, role, is_active, allow_google_auth from public.users where username = $1`, [GUARD])).rows[0];
  expect(row).toMatchObject({ username: GUARD, email: null, role: 'guard', is_active: true, allow_google_auth: false });
  userIds.push(row.id);
  roleUser.guard = { username: GUARD, id: row.id };

  // No matrix rows, no invite.
  expect((await pool.query(`select count(*)::int as n from public.user_permissions where user_id = $1`, [row.id])).rows[0].n).toBe(0);
  expect((await pool.query(`select count(*)::int as n from public.user_invites where lower(full_name) like $1`, [`%שומר ${RUN}%`])).rows[0].n).toBe(0);

  // A second guard without a mailbox is fine (NULL is not a duplicate) …
  const r2 = await request.post('/api/users', { data: { role: 'guard', username: GUARD2, full_name: `שומר שני ${RUN}`, password: PASSWORD } });
  expect(r2.status(), await r2.text()).toBe(201);
  userIds.push(await userId(GUARD2));
  // … a duplicate username is not, whatever the case.
  const dup = await request.post('/api/users', { data: { role: 'guard', username: GUARD.toUpperCase(), full_name: 'כפול', password: PASSWORD } });
  expect(dup.status()).toBe(409);
  // A guard is never invited: no password → 400, never an invite email.
  const noPw = await request.post('/api/users', { data: { role: 'guard', username: `x${GUARD}`, full_name: 'בלי סיסמה' } });
  expect(noPw.status()).toBe(400);
  // A username with "@" is refused (it could collide with someone's e-mail).
  const at = await request.post('/api/users', { data: { role: 'guard', username: 'a@b.co', full_name: 'שגוי', password: PASSWORD } });
  expect(at.status()).toBe(400);

  // The users list shows the username where there is no e-mail, and the Google
  // switch is off + explained (Google identifies by e-mail).
  await page.goto('/settings/users');
  await page.getByRole('button', { name: new RegExp(`שומר ${RUN}`) }).first().click();
  const side = page.getByRole('dialog');
  await expect(side.getByText(/אין —|למשתמש הזה אין/)).toBeVisible();
  await expect(side.getByRole('switch', { name: 'אפשר כניסה עם Google' })).toBeDisabled();
  // The server agrees: turning Google on for an e-mail-less user is a 400.
  const g = await request.patch(`/api/users/${row.id}`, { data: { allow_google_auth: true } });
  expect(g.status()).toBe(400);
});

test('the other roles exist for the rest of the spec', async ({ request }) => {
  for (const role of ['admin', 'manager', 'viewer', 'maintenance']) {
    const username = `rl-${role}-${RUN}@billing.local`;
    const r = await request.post('/api/users', { data: { role, email: username, full_name: `בודק ${role} ${RUN}`, password: PASSWORD } });
    expect(r.status(), await r.text()).toBe(201);
    const id = await userId(username);
    userIds.push(id);
    roleUser[role] = { username, id };
  }
});

// ── 2. The guard sees ONE screen ─────────────────────────────────────────────

test('the guard lands on /visitors and the menu offers nothing else', async ({ browser }) => {
  const { page, ok } = await signIn(browser, GUARD.toUpperCase()); // case never matters at login
  expect(ok).toBe(true);
  await page.goto('/');
  await expect(page).toHaveURL(/\/visitors$/);
  await expect(page.getByRole('heading', { name: 'סריקת כניסה' })).toBeVisible();

  const links = await page.locator('aside nav a').allInnerTexts();
  expect(links.map((t) => t.trim())).toEqual(['סריקת כניסה']);
  // no Settings link, no bell, no global search, no personal assistant
  await expect(page.locator('aside a[href="/settings"]')).toHaveCount(0);
  await expect(page.getByLabel('התראות')).toHaveCount(0);
  await expect(page.getByLabel('חיפוש גלובלי')).toHaveCount(0);
  await expect(page.locator('[aria-label="עוזר אישי"]')).toHaveCount(0);
  // the header shows the username where an e-mail would be
  await page.getByRole('button', { name: 'חשבון משתמש' }).click();
  await expect(page.getByText(GUARD)).toBeVisible();
  await expect(page.getByText('שומר').first()).toBeVisible();
});

test('every other page sends the guard back; every other API refuses', async ({ browser }) => {
  test.setTimeout(240_000);
  const { page, ctx } = await signIn(browser, GUARD);

  // ── pages ──
  const appRoot = join(process.cwd(), 'src/app');
  const pageFiles = [...findFiles(join(appRoot, '(app)'), 'page.tsx'), ...findFiles(join(appRoot, 'debtors'), 'page.tsx')];
  const pages = [...new Set(pageFiles.map((f) => urlFor(f, f.includes('/debtors/') ? appRoot : join(appRoot, '(app)'))))]
    .filter((u) => u !== '/visitors');
  expect(pages.length).toBeGreaterThan(20); // the crawl really found the app's screens
  const leaked: string[] = [];
  for (const u of pages) {
    const res = await page.goto(u, { waitUntil: 'domcontentloaded' });
    const path = new URL(page.url()).pathname;
    const status = res?.status() ?? 0;
    if (path !== '/visitors' && status < 400) leaked.push(`${u} → ${path} (${status})`);
  }
  expect(leaked, `pages that rendered for a guard:\n${leaked.join('\n')}`).toEqual([]);

  // ── API routes ──
  const apiRoot = join(appRoot, 'api');
  const skip = ['/api/health', '/api/auth/', '/api/public/', '/api/portal/', '/api/webhooks'];
  const allowed = ['/api/visitors', '/api/files/visitor-ids', '/api/account/password'];
  const offenders: string[] = [];
  let probed = 0;
  for (const file of findFiles(apiRoot, 'route.ts')) {
    const url = urlFor(file, appRoot);
    if (skip.some((s) => url.startsWith(s)) || url === '/api/auth') continue;
    const src = readFileSync(file, 'utf8');
    const methods = [...src.matchAll(/export async function (GET|POST|PUT|PATCH|DELETE)\b/g)].map((m) => m[1]!);
    for (const method of methods) {
      probed += 1;
      const res = await ctx.request.fetch(url, {
        method,
        maxRedirects: 0,
        failOnStatusCode: false,
        ...(method === 'GET' ? {} : { data: {} }),
      });
      const s = res.status();
      if (allowed.some((a) => url.startsWith(a))) continue; // asserted by the dedicated tests below
      // /api/work-items validates ?kind= before it asks who you are (400 with no params);
      // with a kind it must refuse — asserted right after the loop.
      if (method === 'GET' && url === '/api/work-items' && s === 400) continue;
      if (![401, 403, 404, 405].includes(s)) offenders.push(`${method} ${url} → ${s}`);
    }
  }
  expect(probed).toBeGreaterThan(100);
  expect(offenders, `API routes that did not refuse a guard:\n${offenders.join('\n')}`).toEqual([]);

  // A fake id can hide a missing guard behind a 404, so the "any authenticated
  // user" reads are asserted by name (check:auth also fails the build if a new
  // one forgets the guard) — these three answered a guard 200 before 08/11/2026.
  for (const kind of ['issue', 'task']) {
    expect((await ctx.request.get(`/api/work-items?kind=${kind}`)).status(), `work-items ${kind}`).toBe(403);
  }
  expect((await ctx.request.get('/api/contacts')).status()).toBe(403);
  expect((await ctx.request.get('/api/contacts?search=a')).status()).toBe(403);
  expect((await ctx.request.get(`/api/contacts/${FAKE_ID}`)).status()).toBe(403);
  expect((await ctx.request.get('/api/settings/billing')).status()).toBe(403);
  expect((await ctx.request.get('/api/targets')).status()).toBe(403);
  expect((await ctx.request.get('/api/search?q=abc')).status()).toBe(403);
});

test('the guard may call the visitor API and its own password change, nothing near them', async ({ browser }) => {
  const { ctx } = await signIn(browser, GUARD);
  expect((await ctx.request.get('/api/visitors')).status()).toBe(200);
  expect((await ctx.request.get('/api/auth/me')).status()).toBe(200);
  expect((await ctx.request.post('/api/account/password', { data: {} })).status()).toBe(400); // allowed in, then validated
  for (const url of ['/api/notifications', '/api/search?q=abc', '/api/sync/status', '/api/agent/chat', '/api/users']) {
    const res = await ctx.request.get(url);
    expect([401, 403, 405], url).toContain(res.status());
  }
});

// ── 3. A scan, from the camera to the table ──────────────────────────────────

let firstScanId = '';
let firstScanKey = '';

test('the guard scans a document: photo → OCR → editable form → save → table', async ({ browser }) => {
  const { page } = await signIn(browser, GUARD);
  await page.goto('/visitors');
  await expect(page.locator('[data-scan-button]')).toBeVisible();

  const jpeg = await photo(3200, 2400); // bigger than the 1600px the app keeps
  await page.locator('input[data-visitor-file]').setInputFiles({ name: 'id.jpg', mimeType: 'image/jpeg', buffer: jpeg });

  const sheet = page.getByRole('dialog');
  await expect(sheet.getByText('קורא את התעודה…').first()).toBeVisible();
  // The form arrives pre-filled from the document, every field editable.
  await expect(sheet.locator('#v-first')).toHaveValue('דוד');
  await expect(sheet.locator('#v-last')).toHaveValue(NAME_TOKEN);
  await expect(sheet.locator('#v-docnum')).toHaveValue('123456789');
  await expect(sheet.locator('#v-dob')).toHaveValue('1990-05-17');
  await expect(sheet.getByRole('radio', { name: 'תעודת זהות' })).toHaveAttribute('aria-checked', 'true');
  // The one field the model doubted (0.55) is flagged; the confident ones are not.
  await expect(sheet.getByText('נקרא בביטחון נמוך — בדוק מול התעודה')).toHaveCount(1);
  await expect(sheet.locator('#v-dob').locator('xpath=ancestor::div[contains(@class,"border-amber") or contains(@class,"amber")][1]')).toHaveCount(1);

  // What the server sent the OCR: ONE JPEG, at most 1600px, no EXIF, to the configured model.
  expect(anthropic.calls).toHaveLength(1);
  const sent = anthropic.calls[0]!;
  expect(sent.mediaType).toBe('image/jpeg');
  const meta = await sharp(sent.imageBytes).metadata();
  expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBe(1600);
  expect(meta.exif).toBeUndefined();
  expect(sent.system).toMatch(/untrusted/i);

  // Nothing is stored until "שמור".
  expect(storage.keys('visitor-ids')).toHaveLength(0);
  expect((await pool.query(`select count(*)::int as n from public.visitor_scans where last_name = $1`, [NAME_TOKEN])).rows[0].n).toBe(0);

  // Required fields block the save …
  await sheet.locator('#v-first').fill('');
  await sheet.getByRole('button', { name: 'שמור', exact: true }).click();
  await expect(sheet.getByText('חסר שם פרטי')).toBeVisible();
  // … the guard corrects a field and adds the desk's details.
  await sheet.locator('#v-first').fill('דוד המלך');
  await sheet.locator('#v-phone').fill('050-123 4567');
  await sheet.locator('#v-room').fill('204');
  await sheet.locator('#v-chip').fill('C-7781');
  await sheet.locator('#v-notes').fill('מגיע לפגישה');
  await sheet.getByRole('button', { name: 'שמור', exact: true }).click();
  await expect(page.getByText('הסריקה נשמרה')).toBeVisible();

  const row = (await pool.query(`select * from public.visitor_scans where last_name = $1`, [NAME_TOKEN])).rows[0];
  scanIds.push(row.id);
  firstScanId = row.id;
  firstScanKey = row.image_object_key;
  expect(row).toMatchObject({
    document_type: 'id_card', document_number: '123456789', first_name: 'דוד המלך', last_name: NAME_TOKEN,
    nationality: 'ישראלית', phone: '050-123 4567', room_number: '204', chip_number: 'C-7781', notes: 'מגיע לפגישה',
    scanned_by: roleUser.guard!.id,
  });
  expect(row.date_of_birth.toISOString().slice(0, 10)).toBe('1990-05-17');
  expect(row.image_object_key).toMatch(/^[0-9a-f-]{36}\.jpg$/);

  // The photo is in the PRIVATE bucket, as a JPEG at most 1600px with no metadata.
  const stored = storage.objects.get(`visitor-ids/${row.image_object_key}`);
  expect(stored).toBeDefined();
  expect(stored!.contentType).toBe('image/jpeg');
  const m2 = await sharp(stored!.bytes).metadata();
  expect(m2.format).toBe('jpeg');
  expect(Math.max(m2.width ?? 0, m2.height ?? 0)).toBeLessThanOrEqual(1600);
  expect(m2.exif).toBeUndefined();

  // The table shows the new row; the guard is named as the scanner.
  const tr = page.locator('tr[data-visitor-row]', { hasText: NAME_TOKEN });
  await expect(tr).toHaveCount(1);
  await expect(tr).toContainText('050-123 4567');
  await expect(tr).toContainText('204');
  await expect(tr).toContainText('C-7781');
  await expect(tr).toContainText('תעודת זהות');
});

test('an iPhone HEIC photo goes through end to end', async ({ browser }) => {
  const { page } = await signIn(browser, GUARD);
  await page.goto('/visitors');
  anthropic.reply = { ...OCR_REPLY, first_name: 'חיים', last_name: `${NAME_TOKEN}H`, document_number: 'AB 123 456', document_type: 'passport' };
  const heic = readFileSync(join(process.cwd(), 'tests/fixtures/synthetic-96x64.heic'));
  await page.locator('input[data-visitor-file]').setInputFiles({ name: 'IMG_0001.HEIC', mimeType: 'image/heic', buffer: heic });

  const sheet = page.getByRole('dialog');
  await expect(sheet.locator('#v-first')).toHaveValue('חיים');
  await expect(sheet.locator('#v-docnum')).toHaveValue('AB123456');
  await expect(sheet.getByRole('radio', { name: 'דרכון' })).toHaveAttribute('aria-checked', 'true');
  // The OCR got a JPEG (decoded from the HEIC), not the HEIC.
  expect(anthropic.calls).toHaveLength(1);
  expect(anthropic.calls[0]!.imageBytes.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
  // The preview shows (a browser cannot draw a HEIC; this is the converted JPEG).
  const loaded = await sheet.locator('img[alt="צילום התעודה"]').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0);
  expect(loaded).toBe(true);

  await sheet.getByRole('button', { name: 'שמור', exact: true }).click();
  await expect(page.getByText('הסריקה נשמרה')).toBeVisible();
  const row = (await pool.query(`select id, image_object_key from public.visitor_scans where last_name = $1`, [`${NAME_TOKEN}H`])).rows[0];
  scanIds.push(row.id);
  const stored = storage.objects.get(`visitor-ids/${row.image_object_key}`)!;
  expect(stored.bytes.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
  expect((await sharp(stored.bytes).metadata()).format).toBe('jpeg');
});

test('when the OCR cannot read, the form opens empty and the guard fills it by hand', async ({ browser }) => {
  const { page } = await signIn(browser, GUARD);
  await page.goto('/visitors');
  for (const mode of ['error', 'garbage'] as const) {
    anthropic.mode = mode;
    await page.locator('input[data-visitor-file]').setInputFiles({ name: 'id.jpg', mimeType: 'image/jpeg', buffer: await photo() });
    const sheet = page.getByRole('dialog');
    await expect(sheet.getByText('לא הצלחנו לקרוא את התעודה אוטומטית')).toBeVisible();
    await expect(sheet.locator('#v-first')).toHaveValue('');
    await expect(sheet.locator('img[alt="צילום התעודה"]')).toBeVisible(); // the photo is still there to read from
    if (mode === 'garbage') {
      await sheet.getByRole('radio', { name: 'רישיון נהיגה' }).click();
      await sheet.locator('#v-docnum').fill('7654321');
      await sheet.locator('#v-first').fill('ידני');
      await sheet.locator('#v-last').fill(`${NAME_TOKEN}M`);
      await sheet.getByRole('button', { name: 'שמור', exact: true }).click();
      await expect(page.getByText('הסריקה נשמרה')).toBeVisible();
      const row = (await pool.query(`select id, document_type from public.visitor_scans where last_name = $1`, [`${NAME_TOKEN}M`])).rows[0];
      scanIds.push(row.id);
      expect(row.document_type).toBe('driver_license');
    } else {
      // leave without saving → a confirmation, then nothing is stored
      await page.keyboard.press('Escape');
      await expect(sheet).toHaveCount(0);
    }
  }
});

test('a file that is not an image is refused and nothing is stored', async ({ browser }) => {
  const { page, ctx } = await signIn(browser, GUARD);
  await page.goto('/visitors');
  const before = storage.keys('visitor-ids').length;
  await page.locator('input[data-visitor-file]').setInputFiles({ name: 'doc.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 not an image') });
  await expect(page.getByRole('dialog').getByText('הקובץ אינו תמונה נתמכת')).toBeVisible();
  expect(storage.keys('visitor-ids')).toHaveLength(before);
  // and straight at the API
  const res = await ctx.request.post('/api/visitors/ocr', { multipart: { image: { name: 'x.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') } } });
  expect(res.status()).toBe(415);
});

// ── 4. The table: search, dates, details, the photo ──────────────────────────

test('the guard searches by name and by phone; the date range narrows; clearing restores', async ({ browser }) => {
  const { page } = await signIn(browser, GUARD);
  await page.goto('/visitors');
  const search = page.locator('input[data-filter-search]');
  const rows = page.locator('tr[data-visitor-row]');

  await search.fill(NAME_TOKEN);
  await expect(rows.first()).toContainText(NAME_TOKEN);
  const withToken = await rows.count();
  expect(withToken).toBeGreaterThanOrEqual(3);

  await search.fill('דוד המלך');
  await expect(rows).toHaveCount(1);
  await search.fill(`${NAME_TOKEN} דוד`); // last name first
  await expect(rows).toHaveCount(1);
  await search.fill('0501234567'); // a phone written another way
  await expect(rows.filter({ hasText: NAME_TOKEN }).first()).toBeVisible();
  await search.fill('תוצאה-שלא-קיימת');
  await expect(page.locator('[data-visitor-empty]')).toContainText('לא נמצאו סריקות');

  await page.locator('[data-filter-clear]').click();
  await expect(search).toHaveValue('');

  // Date range: today's scans are in; a range in the past has none.
  await search.fill(NAME_TOKEN);
  await expect(rows.first()).toBeVisible();
  await page.locator('input[data-filter-from]').fill('2020-01-01');
  await page.locator('input[data-filter-to]').fill('2020-01-31');
  await expect(page.locator('[data-visitor-empty]')).toBeVisible();
  await page.locator('input[data-filter-from]').fill('2020-01-01');
  await page.locator('input[data-filter-to]').fill('2999-01-01');
  await expect(rows.first()).toBeVisible();
});

test('the guard opens a row: details, the photo, notes — and every other field is locked', async ({ browser }) => {
  const { page, ctx } = await signIn(browser, GUARD);
  await page.goto('/visitors');
  await openRow(page, 'דוד המלך');

  const sheet = page.getByRole('dialog');
  await expect(sheet.getByText('123456789')).toBeVisible();
  await expect(sheet.getByText('204')).toBeVisible();
  // The photo loads through the session-gated proxy.
  const photoEl = sheet.locator('img[data-visitor-photo]');
  await expect(photoEl).toHaveAttribute('src', `/api/files/visitor-ids/${firstScanKey}`);
  await expect.poll(() => photoEl.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0)).toBe(true);
  // Opening it is audited: one file_viewed row for this guard and this scan.
  const viewed = await pool.query(`select metadata from public.audit_log where action = 'file_viewed' and entity_type = 'visitor_scan' and entity_id = $1 and actor_user_id = $2`, [firstScanId, roleUser.guard!.id]);
  expect(viewed.rows).toHaveLength(1);
  expect(viewed.rows[0].metadata).toMatchObject({ bucket: 'visitor-ids', object_key: firstScanKey });

  // Fields are NOT editable for a guard; the notes are.
  await expect(sheet.locator('#v-first')).toHaveCount(0);
  await expect(sheet.getByRole('button', { name: 'מחק סריקה' })).toHaveCount(0);
  const notes = sheet.locator('#v-notes');
  await expect(notes).toHaveValue('מגיע לפגישה');
  await notes.fill('מגיע לפגישה — אושר ע״י הדייר');
  await sheet.getByRole('button', { name: 'שמור הערות' }).click();
  await expect(page.getByText('ההערות נשמרו')).toBeVisible();
  expect((await pool.query(`select notes from public.visitor_scans where id = $1`, [firstScanId])).rows[0].notes).toBe('מגיע לפגישה — אושר ע״י הדייר');

  // The server holds the same line: the guard cannot touch another field.
  const bad = await ctx.request.patch(`/api/visitors/${firstScanId}`, { data: { first_name: 'פרצה' } });
  expect(bad.status()).toBe(403);
  const del = await ctx.request.delete(`/api/visitors/${firstScanId}`);
  expect(del.status()).toBe(403);
  expect((await pool.query(`select first_name from public.visitor_scans where id = $1`, [firstScanId])).rows[0].first_name).toBe('דוד המלך');

  // The photo can be opened full screen.
  await sheet.getByRole('button', { name: 'מסך מלא' }).first().click();
  const full = page.locator('img[data-visitor-photo-full]');
  await expect(full).toBeVisible();
  await expect.poll(() => full.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0)).toBe(true);
  const vp = page.viewportSize()!;
  const fb = (await full.boundingBox())!;
  expect(fb.width).toBeGreaterThan(vp.width * 0.8); // really full screen, not a thumbnail
  await full.click(); // zooms to the natural size
  await expect(page.getByRole('button', { name: 'התאם למסך' })).toBeVisible();
  await page.getByRole('button', { name: 'סגור את התצוגה' }).click();
  await expect(full).toHaveCount(0);
  await expect(sheet.locator('img[data-visitor-photo]')).toBeVisible(); // back in the sheet, still open
});

test('the roles that may only read cannot write — the screen and the API agree', async ({ browser }) => {
  for (const role of ['manager', 'viewer', 'maintenance'] as const) {
    const { page, ctx } = await signIn(browser, roleUser[role]!.username);
    await page.goto('/visitors');
    // they see the table, the details and the photo …
    await expect(page.locator('[data-scan-button]')).toHaveCount(0); // … but no scan button
    await openRow(page, 'דוד המלך');
    const sheet = page.getByRole('dialog');
    await expect(sheet.getByText('123456789')).toBeVisible();
    await expect(sheet.locator('img[data-visitor-photo]')).toBeVisible();
    await expect(sheet.locator('#v-notes')).toHaveCount(0); // notes are text, not a field
    await expect(sheet.getByRole('button', { name: 'שמור הערות' })).toHaveCount(0);
    await expect(sheet.getByRole('button', { name: 'מחק סריקה' })).toHaveCount(0);
    // … and the API says the same
    expect((await ctx.request.get('/api/visitors')).status()).toBe(200);
    expect((await ctx.request.get(`/api/files/visitor-ids/${firstScanKey}`)).status()).toBe(200);
    expect((await ctx.request.patch(`/api/visitors/${firstScanId}`, { data: { notes: 'x' } })).status()).toBe(403);
    expect((await ctx.request.delete(`/api/visitors/${firstScanId}`)).status()).toBe(403);
    expect((await ctx.request.post('/api/visitors/ocr', { multipart: { image: { name: 'a.jpg', mimeType: 'image/jpeg', buffer: await photo(50, 50) } } })).status()).toBe(403);
    expect((await ctx.request.get('/api/account/password')).status()).toBe(405);
    expect((await ctx.request.post('/api/account/password', { data: { current_password: 'a', new_password: 'b' } })).status()).toBe(403);
  }
  expect(anthropic.calls).toHaveLength(0);
});

test('the admin edits every field and deletes — the photo goes with the row', async ({ browser }) => {
  const { page } = await signIn(browser, roleUser.admin!.username);
  await page.goto('/visitors');
  await openRow(page, 'דוד המלך');
  const sheet = page.getByRole('dialog');

  await sheet.locator('#v-first').fill('דוד');
  await sheet.locator('#v-room').fill('305');
  await sheet.locator('#v-phone').fill('');
  await sheet.getByRole('button', { name: 'שמור שינויים' }).click();
  await expect(page.getByText('השינויים נשמרו')).toBeVisible();
  const row = (await pool.query(`select first_name, room_number, phone from public.visitor_scans where id = $1`, [firstScanId])).rows[0];
  expect(row).toEqual({ first_name: 'דוד', room_number: '305', phone: null });
  const audit = await pool.query(`select metadata from public.audit_log where entity_type = 'visitor_scan' and entity_id = $1 and action = 'updated' and actor_user_id = $2`, [firstScanId, roleUser.admin!.id]);
  expect(audit.rows[0].metadata.fields.sort()).toEqual(['first_name', 'phone', 'room_number']);

  // delete → confirm → the row and the stored photo are gone
  expect(storage.objects.has(`visitor-ids/${firstScanKey}`)).toBe(true);
  await sheet.getByRole('button', { name: 'מחק סריקה' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'מחק', exact: true }).click();
  await expect(page.getByText('הסריקה נמחקה')).toBeVisible();
  expect((await pool.query(`select count(*)::int as n from public.visitor_scans where id = $1`, [firstScanId])).rows[0].n).toBe(0);
  expect(storage.objects.has(`visitor-ids/${firstScanKey}`)).toBe(false);
  expect(storage.removed).toContain(`visitor-ids/${firstScanKey}`);
});

test('deleting the only row of the last page steps back instead of stranding the admin', async ({ browser }) => {
  const { page } = await signIn(browser, roleUser.admin!.username);
  const token = `${NAME_TOKEN}P`;
  for (let i = 0; i < 26; i += 1) {
    const r = await pool.query<{ id: string }>(
      `insert into public.visitor_scans (document_type, document_number, first_name, last_name, image_object_key, scanned_by, scanned_by_name, created_at)
       values ('id_card', $1, $2, $3, $4, $5, 'בודק', now() - ($6 || ' minutes')::interval) returning id`,
      [`P${i}`, `פ${String(i).padStart(2, '0')}`, token, `${randomUUID()}.jpg`, roleUser.admin!.id, String(i)],
    );
    scanIds.push(r.rows[0]!.id);
  }
  await page.goto('/visitors');
  await page.locator('input[data-filter-search]').fill(token);
  await expect(page.locator('[data-page-info]')).toContainText('עמוד 1 מתוך 2');
  await page.locator('[data-page-next]').click();
  await expect(page.locator('[data-page-info]')).toContainText('עמוד 2 מתוך 2');
  const rows = page.locator('tr[data-visitor-row]');
  await expect(rows).toHaveCount(1);
  await rows.first().click();
  await page.getByRole('dialog').getByRole('button', { name: 'מחק סריקה' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'מחק', exact: true }).click();
  await expect(page.getByText('הסריקה נמחקה')).toBeVisible();
  // not the empty state: back on page 1 with its 25 rows
  await expect(rows).toHaveCount(25);
  await expect(page.locator('[data-visitor-empty]')).toHaveCount(0);
});

test('when Storage refuses to drop the photo, the row goes and the admin is TOLD', async ({ browser }) => {
  const { page } = await signIn(browser, roleUser.admin!.username);
  const key = `${randomUUID()}.jpg`;
  storage.objects.set(`visitor-ids/${key}`, { contentType: 'image/jpeg', bytes: await photo(10, 10) });
  const r = await pool.query<{ id: string }>(
    `insert into public.visitor_scans (document_type, document_number, first_name, last_name, image_object_key, scanned_by, scanned_by_name)
     values ('passport', 'KEEP1', 'מחיקה', $1, $2, $3, 'בודק') returning id`,
    [`${NAME_TOKEN}K`, key, roleUser.admin!.id],
  );
  const id = r.rows[0]!.id;
  scanIds.push(id);
  storage.failRemove = true;
  try {
    await page.goto('/visitors');
    await openRow(page, `${NAME_TOKEN}K`);
    await page.getByRole('dialog').getByRole('button', { name: 'מחק סריקה' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'מחק', exact: true }).click();
    await expect(page.getByText(/צילום התעודה לא נמחק מהאחסון/)).toBeVisible();
  } finally {
    storage.failRemove = false;
  }
  expect((await pool.query(`select count(*)::int as n from public.visitor_scans where id = $1`, [id])).rows[0].n).toBe(0);
  const audit = await pool.query(`select metadata from public.audit_log where entity_type = 'visitor_scan' and entity_id = $1 and action = 'deleted'`, [id]);
  expect(audit.rows[0].metadata).toMatchObject({ photo_removed: false, object_key: key });
  expect(storage.objects.has(`visitor-ids/${key}`)).toBe(true); // the photo is still there — and now it is known
  storage.objects.delete(`visitor-ids/${key}`);
});

// ── 5. The guard's own password ──────────────────────────────────────────────

test('the guard changes their own password; the old one stops working', async ({ browser }) => {
  const { page, ctx } = await signIn(browser, GUARD2);
  await page.goto('/visitors');
  await page.locator('[data-change-password]').click();
  const sheet = page.getByRole('dialog');
  const save = sheet.getByRole('button', { name: 'שמור סיסמה' });

  await expect(save).toBeDisabled();
  await sheet.locator('#pw-current').fill('wrong-Current1');
  await sheet.locator('#pw-new').fill(NEW_PASSWORD);
  await sheet.locator('#pw-again').fill(NEW_PASSWORD + 'x');
  await expect(sheet.getByText('הסיסמאות אינן זהות')).toBeVisible();
  await expect(save).toBeDisabled();
  await sheet.locator('#pw-again').fill(NEW_PASSWORD);
  await save.click();
  await expect(page.getByText('הסיסמה הנוכחית שגויה')).toBeVisible(); // still on the form, still signed in
  expect((await ctx.request.get('/api/auth/me')).status()).toBe(200);

  await sheet.locator('#pw-current').fill(PASSWORD);
  await save.click();
  await expect(page.getByText('הסיסמה עודכנה')).toBeVisible();
  expect((await ctx.request.get('/api/auth/me')).status()).toBe(200); // this session stays

  const old = await loginThroughForm(browser, GUARD2, PASSWORD);
  contexts.push(old.ctx);
  expect(old.ok).toBe(false);
  const fresh = await signIn(browser, GUARD2, NEW_PASSWORD);
  expect(fresh.ok).toBe(true);
  await expect(fresh.page).toHaveURL(/\/visitors$/);

  // a weak new password is refused by the server too
  const weak = await ctx.request.post('/api/account/password', { data: { current_password: NEW_PASSWORD, new_password: 'short' } });
  expect(weak.status()).toBe(400);
  const same = await ctx.request.post('/api/account/password', { data: { current_password: NEW_PASSWORD, new_password: NEW_PASSWORD } });
  expect(same.status()).toBe(400);
});

// ── 6. Layout invariants on an iPhone (dev-discipline rule 2) ────────────────

test('on an iPhone-sized screen nothing scrolls sideways and the touch targets are big enough', async ({ browser }) => {
  const iphone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true };
  // The guard's existing session, in an iPhone-shaped context — no second login.
  const base = await signIn(browser, GUARD);
  const phoneCtx = await browser.newContext({ ...iphone, storageState: await base.ctx.storageState() });
  contexts.push(phoneCtx);
  const page = await phoneCtx.newPage();
  await page.goto('/visitors');
  await page.locator('input[data-filter-search]').fill(NAME_TOKEN);
  await expect(page.locator('[data-visitor-cards] [data-visitor-row]').first()).toBeVisible();

  const m = await page.evaluate(() => {
    const el = document.scrollingElement!;
    const main = document.querySelector('main')!;
    const inner = main.firstElementChild as HTMLElement;
    const cs = getComputedStyle(inner);
    return {
      pageOverflow: el.scrollWidth - window.innerWidth,
      mainOverflow: main.scrollWidth - main.clientWidth,
      padL: parseFloat(cs.paddingLeft),
      padR: parseFloat(cs.paddingRight),
    };
  });
  expect(m.pageOverflow).toBeLessThanOrEqual(0);
  expect(m.mainOverflow).toBeLessThanOrEqual(0);
  expect(m.padL).toBeGreaterThan(0); // the 10/10/2026 .safe-px regression: content must not touch the edge
  expect(m.padR).toBeGreaterThan(0);

  for (const sel of ['[data-scan-button]', '[data-change-password]', 'input[data-filter-search]', 'input[data-filter-from]', 'input[data-filter-to]']) {
    const box = await page.locator(sel).first().boundingBox();
    expect(box, sel).not.toBeNull();
    expect(box!.height, `${sel} height`).toBeGreaterThanOrEqual(44);
  }
  // The phone shows cards, not the wide table.
  await expect(page.locator('table[data-visitor-table]')).toBeHidden();

  // The scan sheet is the whole screen on a phone and does not overflow either.
  await page.locator('input[data-visitor-file]').setInputFiles({ name: 'id.jpg', mimeType: 'image/jpeg', buffer: await photo() });
  const sheet = page.getByRole('dialog');
  await expect(sheet.locator('#v-first')).toBeVisible();
  const box = await sheet.boundingBox();
  expect(box!.width).toBeLessThanOrEqual(390);
  const sheetOverflow = await sheet.evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(sheetOverflow).toBeLessThanOrEqual(0);
  // the PWA basics the home-screen install relies on
  const meta = await page.evaluate(() => ({
    viewport: document.querySelector('meta[name="viewport"]')?.getAttribute('content') ?? '',
    manifest: document.querySelector('link[rel="manifest"]')?.getAttribute('href') ?? '',
  }));
  expect(meta.viewport).toContain('viewport-fit=cover');
  expect(meta.manifest).toBe('/manifest.webmanifest');
  await page.keyboard.press('Escape');
});

test('the photo of a document is not reachable without a session or by a guessed key', async ({ request, browser }) => {
  const key = `${randomUUID()}.jpg`;
  storage.objects.set(`visitor-ids/${key}`, { contentType: 'image/jpeg', bytes: await photo(10, 10) });
  const anon = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  contexts.push(anon);
  expect((await anon.request.get(`/api/files/visitor-ids/${key}`)).status()).toBe(401);
  // a path that is not a UUID key never reaches Storage
  const { ctx } = await signIn(browser, GUARD);
  expect((await ctx.request.get('/api/files/visitor-ids/..%2Fsecret.jpg')).status()).toBe(404);
  expect((await ctx.request.get('/api/files/visitor-ids/not-a-uuid.jpg')).status()).toBe(404);
  // an unknown bucket is a 404, never a hint
  expect((await ctx.request.get(`/api/files/visitor-id/${key}`)).status()).toBe(404);
  // and the app never hands the client a storage URL
  const list = await (await request.get('/api/visitors?page=1')).json();
  expect(JSON.stringify(list)).not.toMatch(/storage\/v1|:54321|signed|token=/);
  storage.objects.delete(`visitor-ids/${key}`);
});

// An admin-created extra: a page (not a request) proves the Users screen lists the guard.
test('the users screen has a guards tab', async ({ page }: { page: Page }) => {
  await page.goto('/settings/users');
  const tab = page.getByRole('button', { name: /^שומר \d+$/ });
  await expect(tab).toBeVisible();
  await tab.click();
  await expect(page.getByRole('button', { name: new RegExp(`שומר ${RUN}`) }).first()).toBeVisible();
});
