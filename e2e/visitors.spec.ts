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
// every other page and every other API answers no; a scan goes photo → CROP →
// OCR → form → save → table → details → notes; manager / viewer / cleaner /
// maintenance have no access to the module at all (09/11/2026); the admin edits,
// re-crops a stored photo and deletes; the guard changes their own password; the
// nationality is read and saved but shown nowhere.
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

interface Frame { x: number; y: number; w: number; h: number }

/** The crop step is on screen, the picture is drawn, and the sheet has FINISHED sliding in (it takes
 *  1.2s from the left): a drag that aims at a handle's coordinates while the sheet still moves would
 *  miss a 44px target. Only finite animations are awaited — spinners never end. */
async function cropReady(page: Page): Promise<void> {
  await expect(page.locator('[data-crop-rect]')).toBeVisible();
  await page.evaluate(() => Promise.all(
    document.getAnimations()
      .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
      .map((a) => a.finished.catch(() => undefined)),
  ));
}

/** Presses "המשך" on the crop step. */
async function cropContinue(page: Page): Promise<void> {
  await cropReady(page);
  await page.locator('[data-crop-confirm]').click();
}

/** The frame in the PICTURE's pixels, read off the editor — once two reads 40ms apart agree (the
 *  last pointer move of a drag commits a render later). */
async function frameOf(page: Page): Promise<Frame> {
  const read = () => page.locator('[data-crop-rect]').evaluate((el) => {
    const d = (el as HTMLElement).dataset;
    return { x: Number(d.x), y: Number(d.y), w: Number(d.w), h: Number(d.h) };
  });
  let prev = await read();
  for (let i = 0; i < 25; i += 1) {
    await page.waitForTimeout(40);
    const cur = await read();
    if (cur.x === prev.x && cur.y === prev.y && cur.w === prev.w && cur.h === prev.h) return cur;
    prev = cur;
  }
  return prev;
}

async function centerOf(page: Page, selector: string): Promise<{ x: number; y: number }> {
  const box = await page.locator(selector).first().boundingBox();
  expect(box, selector).not.toBeNull();
  return { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
}

/** Drags a point on screen with the mouse (pointer events, like a trackpad / desktop admin). */
async function dragFrom(page: Page, from: { x: number; y: number }, dx: number, dy: number): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 8 });
  await page.mouse.up();
}

const dragHandle = async (page: Page, handle: string, dx: number, dy: number) =>
  dragFrom(page, await centerOf(page, `[data-crop-handle="${handle}"]`), dx, dy);

function iou(a: Frame, b: Frame): number {
  const w = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const h = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = w * h;
  return inter / (a.w * a.h + b.w * b.h - inter);
}

/** A dark desk with a light card (print and a dark photo patch) at a known place. */
async function cardPhoto(): Promise<{ jpeg: Buffer; card: Frame }> {
  const W = 3000;
  const H = 2000;
  const card = { x: 700, y: 480, w: 1700, h: 1070 };
  const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <rect x="${card.x}" y="${card.y}" width="${card.w}" height="${card.h}" fill="#ece8dc"/>
    <rect x="${card.x + 100}" y="${card.y + 250}" width="420" height="600" fill="#3a3a3a"/>
    <rect x="${card.x + 620}" y="${card.y + 200}" width="900" height="70" fill="#222"/>
    <rect x="${card.x + 620}" y="${card.y + 420}" width="700" height="70" fill="#222"/>
    <rect x="${card.x + 620}" y="${card.y + 640}" width="800" height="70" fill="#222"/></svg>`;
  const jpeg = await sharp({ create: { width: W, height: H, channels: 3, background: '#26282b' } })
    .composite([{ input: Buffer.from(svg) }]).jpeg({ quality: 85 }).toBuffer();
  return { jpeg, card };
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
  const buckets = userIds.flatMap((id) => [`pwchange:user:${id}`, `visitor-ocr:user:${id}`, `visitor-ocr-day:user:${id}`, `visitor-save:user:${id}`, `visitor-prepare:user:${id}`, `visitor-recrop:user:${id}`]);
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
  for (const role of ['admin', 'manager', 'viewer', 'cleaner', 'maintenance']) {
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

  // The rail offers ONE category (no "הגדרות" either). With one permitted item it is a direct
  // link to the screen — no panel, no sub-menu (DESIGN.md §14, link category).
  const categories = await page.locator('aside [data-nav-category]').allInnerTexts();
  expect(categories.map((t) => t.trim())).toEqual(['אבטחה']);
  const links = await page.locator('aside nav a').all();
  expect(links).toHaveLength(1);
  await expect(links[0]!).toHaveAttribute('href', '/visitors');
  await expect(page.locator('aside [data-nav-panel]')).toHaveCount(0);
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
  // the crop step's HEIC fallback is open to the guard (400: no photo sent); re-cropping a STORED photo is not
  expect((await ctx.request.post('/api/visitors/prepare', { data: {} })).status()).toBe(400);
  expect((await ctx.request.get('/api/visitors/prepare')).status()).toBe(405);
  expect((await ctx.request.post(`/api/visitors/${FAKE_ID}/image`, { multipart: { image: { name: 'a.jpg', mimeType: 'image/jpeg', buffer: await photo(50, 50) } } })).status()).toBe(403);
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
  // The crop step comes first and nothing has left the phone yet.
  await cropReady(page);
  expect(anthropic.calls).toHaveLength(0);
  await cropContinue(page);
  await expect(sheet.getByText('קורא את התעודה…').first()).toBeVisible();
  // The form arrives pre-filled from the document, every field editable.
  await expect(sheet.locator('#v-first')).toHaveValue('דוד');
  await expect(sheet.locator('#v-last')).toHaveValue(NAME_TOKEN);
  await expect(sheet.locator('#v-docnum')).toHaveValue('123456789');
  await expect(sheet.locator('#v-dob')).toHaveValue('1990-05-17');
  await expect(sheet.getByRole('radio', { name: 'תעודת זהות' })).toHaveAttribute('aria-checked', 'true');
  // The nationality was read (and is saved below) but no field shows it (09/11/2026).
  await expect(sheet.getByText('לאום')).toHaveCount(0);
  await expect(sheet.locator('#v-nat')).toHaveCount(0);
  // The one field the model doubted (0.55) is flagged; the confident ones are not.
  await expect(sheet.getByText('נקרא בביטחון נמוך — בדוק מול התעודה')).toHaveCount(1);
  await expect(sheet.locator('#v-dob').locator('xpath=ancestor::div[contains(@class,"border-amber") or contains(@class,"amber")][1]')).toHaveCount(1);

  // What the server sent the OCR: ONE progressive JPEG (the compressed photo), at most 1600px, no EXIF, under 300KB.
  expect(anthropic.calls).toHaveLength(1);
  const sent = anthropic.calls[0]!;
  expect(sent.mediaType).toBe('image/jpeg');
  const meta = await sharp(sent.imageBytes).metadata();
  expect(meta.format).toBe('jpeg');
  expect(meta.isProgressive).toBe(true);
  expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBe(1600);
  expect(meta.exif).toBeUndefined();
  expect(sent.imageBytes.length).toBeLessThanOrEqual(300 * 1024);
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

  // The photo is in the PRIVATE bucket, as a JPEG at most 1600px with no metadata and under 300KB —
  // and it is the VERY bytes the OCR read (one encode), whose weight the row records.
  const stored = storage.objects.get(`visitor-ids/${row.image_object_key}`);
  expect(stored).toBeDefined();
  expect(stored!.contentType).toBe('image/jpeg');
  const m2 = await sharp(stored!.bytes).metadata();
  expect(m2.format).toBe('jpeg');
  expect(Math.max(m2.width ?? 0, m2.height ?? 0)).toBeLessThanOrEqual(1600);
  expect(m2.exif).toBeUndefined();
  expect(stored!.bytes.length).toBeLessThanOrEqual(300 * 1024);
  expect(stored!.bytes.equals(sent.imageBytes)).toBe(true);
  expect(row.image_bytes).toBe(stored!.bytes.length);

  // The table shows the new row; the guard is named as the scanner.
  const tr = page.locator('tr[data-visitor-row]', { hasText: NAME_TOKEN });
  await expect(tr).toHaveCount(1);
  await expect(tr).toContainText('050-123 4567');
  await expect(tr).toContainText('204');
  await expect(tr).toContainText('C-7781');
  await expect(tr).toContainText('תעודת זהות');
  await expect(page.locator('table[data-visitor-table] thead')).not.toContainText('לאום');
  await expect(tr).not.toContainText('ישראלית');
});

test('an iPhone HEIC photo goes through end to end', async ({ browser }) => {
  const { page } = await signIn(browser, GUARD);
  await page.goto('/visitors');
  const storedBefore = storage.keys('visitor-ids').length;
  anthropic.reply = { ...OCR_REPLY, first_name: 'חיים', last_name: `${NAME_TOKEN}H`, document_number: 'AB 123 456', document_type: 'passport' };
  const heic = readFileSync(join(process.cwd(), 'tests/fixtures/synthetic-96x64.heic'));
  // Chromium cannot draw a HEIC (Safari can): the browser fails to open it, so the file goes ONCE to the
  // server's decoder (/api/visitors/prepare), comes back as a JPEG, and THAT is cropped on screen.
  const prepared = page.waitForResponse((r) => r.url().endsWith('/api/visitors/prepare') && r.request().method() === 'POST');
  await page.locator('input[data-visitor-file]').setInputFiles({ name: 'IMG_0001.HEIC', mimeType: 'image/heic', buffer: heic });
  const prep = await prepared;
  expect(prep.status()).toBe(200);
  expect(prep.headers()['content-type']).toBe('image/jpeg');
  expect(prep.headers()['cache-control']).toMatch(/no-store/); // a photo of a document is never cached (so DevTools keeps no body to read here)
  expect(anthropic.calls).toHaveLength(0); // still nothing read, nothing stored
  expect(storage.keys('visitor-ids')).toHaveLength(storedBefore);
  await cropContinue(page);

  const sheet = page.getByRole('dialog');
  await expect(sheet.locator('#v-first')).toHaveValue('חיים');
  await expect(sheet.locator('#v-docnum')).toHaveValue('AB123456');
  await expect(sheet.getByRole('radio', { name: 'דרכון' })).toHaveAttribute('aria-checked', 'true');
  // The OCR got a JPEG (decoded from the HEIC, cropped, compressed), not the HEIC.
  expect(anthropic.calls).toHaveLength(1);
  expect((await sharp(anthropic.calls[0]!.imageBytes).metadata()).format).toBe('jpeg');
  // The preview shows (a browser cannot draw a HEIC; this is the converted JPEG).
  const loaded = await sheet.locator('img[alt="צילום התעודה"]').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0);
  expect(loaded).toBe(true);

  await sheet.getByRole('button', { name: 'שמור', exact: true }).click();
  await expect(page.getByText('הסריקה נשמרה')).toBeVisible();
  const row = (await pool.query(`select id, image_object_key from public.visitor_scans where last_name = $1`, [`${NAME_TOKEN}H`])).rows[0];
  scanIds.push(row.id);
  const stored = storage.objects.get(`visitor-ids/${row.image_object_key}`)!;
  expect((await sharp(stored.bytes).metadata()).format).toBe('jpeg');
  expect(stored.bytes.equals(anthropic.calls[0]!.imageBytes)).toBe(true);
});

test('when the OCR cannot read, the form opens empty and the guard fills it by hand', async ({ browser }) => {
  const { page } = await signIn(browser, GUARD);
  await page.goto('/visitors');
  for (const mode of ['error', 'garbage'] as const) {
    anthropic.mode = mode;
    await page.locator('input[data-visitor-file]').setInputFiles({ name: 'id.jpg', mimeType: 'image/jpeg', buffer: await photo() });
    await cropContinue(page);
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
  expect(anthropic.calls).toHaveLength(0);
  // and straight at the API
  const res = await ctx.request.post('/api/visitors/ocr', { multipart: { image: { name: 'x.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') } } });
  expect(res.status()).toBe(415);
});

// ── 3b. The crop step (09/11/2026) ───────────────────────────────────────────

test('the frame starts on the document when it is found, and what the OCR reads is only that frame', async ({ browser }) => {
  const { page } = await signIn(browser, GUARD);
  await page.goto('/visitors');
  const { jpeg, card } = await cardPhoto();
  await page.locator('input[data-visitor-file]').setInputFiles({ name: 'desk.jpg', mimeType: 'image/jpeg', buffer: jpeg });
  await cropReady(page);

  // found: the frame hugs the card, and the screen says so
  await expect(page.locator('[data-crop-hint]')).toContainText('זיהינו את התעודה');
  const f = await frameOf(page);
  expect(iou(f, card), `frame ${JSON.stringify(f)} vs card ${JSON.stringify(card)}`).toBeGreaterThan(0.85);

  await page.locator('[data-crop-confirm]').click();
  await expect(page.getByRole('dialog').locator('#v-first')).toHaveValue('דוד');

  // The OCR got the CROPPED photo: the card's proportions, not the desk's (3:2), and bright (the card), not dark (the desk)
  expect(anthropic.calls).toHaveLength(1);
  const sent = anthropic.calls[0]!.imageBytes;
  const meta = await sharp(sent).metadata();
  expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBe(1600); // 1700px of card, shrunk
  const ratio = (meta.width ?? 1) / (meta.height ?? 1);
  expect(Math.abs(ratio - card.w / card.h) / (card.w / card.h)).toBeLessThan(0.08);
  expect(Math.abs(ratio - 1.5)).toBeGreaterThan(0.05);
  expect((await sharp(sent).stats()).channels[0]!.mean).toBeGreaterThan(150);
  await page.keyboard.press('Escape'); // leave without saving
  await page.getByRole('alertdialog').getByRole('button', { name: 'צא ללא שמירה' }).click();
});

test('with no document found the frame is 85% centred; the guard drags the sides and corners, moves it, zooms, resets', async ({ browser }) => {
  const { page } = await signIn(browser, GUARD);
  await page.goto('/visitors');
  await page.locator('input[data-visitor-file]').setInputFiles({ name: 'id.jpg', mimeType: 'image/jpeg', buffer: await photo(3200, 2400) });
  await cropReady(page);

  await expect(page.locator('[data-crop-hint]')).not.toContainText('זיהינו');
  const start = await frameOf(page);
  expect(start).toEqual({ x: 240, y: 180, w: 2720, h: 2040 }); // 85% of 3200×2400, centred
  await expect(page.locator('[data-crop-stage]')).toHaveAttribute('data-crop-zoom', '1.00');

  // a corner moves its two edges and leaves the opposite corner alone
  await dragHandle(page, 'nw', 40, 30);
  const afterNw = await frameOf(page);
  expect(afterNw.x).toBeGreaterThan(start.x);
  expect(afterNw.y).toBeGreaterThan(start.y);
  expect(afterNw.x + afterNw.w).toBe(start.x + start.w);
  expect(afterNw.y + afterNw.h).toBe(start.y + start.h);

  // a side moves one edge
  await dragHandle(page, 'e', -40, 0);
  const afterE = await frameOf(page);
  expect(afterE.w).toBeLessThan(afterNw.w);
  expect(afterE.x).toBe(afterNw.x);
  expect(afterE.h).toBe(afterNw.h);

  // dragging inside moves the whole frame without resizing it
  await dragFrom(page, await centerOf(page, '[data-crop-rect]'), -25, 20);
  const moved = await frameOf(page);
  expect(moved.w).toBe(afterE.w);
  expect(moved.h).toBe(afterE.h);
  expect(moved.x).toBeLessThan(afterE.x);
  expect(moved.y).toBeGreaterThan(afterE.y);

  // the buttons and the wheel zoom the PICTURE (the frame stays in picture pixels)
  await page.locator('[data-crop-zoom-in]').click();
  const z1 = Number(await page.locator('[data-crop-stage]').getAttribute('data-crop-zoom'));
  expect(z1).toBeGreaterThan(1.3);
  await page.mouse.move(...(Object.values(await centerOf(page, '[data-crop-stage]')) as [number, number]));
  await page.mouse.wheel(0, -400);
  await expect.poll(async () => Number(await page.locator('[data-crop-stage]').getAttribute('data-crop-zoom'))).toBeGreaterThan(z1);
  await page.locator('[data-crop-zoom-out]').click();
  expect(await frameOf(page)).toEqual(moved);

  // "אפס מסגרת": the starting frame, the whole picture
  await page.locator('[data-crop-reset]').click();
  expect(await frameOf(page)).toEqual(start);
  await expect(page.locator('[data-crop-stage]')).toHaveAttribute('data-crop-zoom', '1.00');

  // adjust once more and continue: what is read has the frame's proportions
  await dragHandle(page, 'se', -60, -50);
  const final = await frameOf(page);
  await page.locator('[data-crop-confirm]').click();
  await expect(page.getByRole('dialog').locator('#v-first')).toHaveValue('דוד');
  const meta = await sharp(anthropic.calls[0]!.imageBytes).metadata();
  expect(Math.abs((meta.width ?? 1) / (meta.height ?? 1) - final.w / final.h) / (final.w / final.h)).toBeLessThan(0.01);
  expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBe(1600);
  await page.keyboard.press('Escape');
  await page.getByRole('alertdialog').getByRole('button', { name: 'צא ללא שמירה' }).click();
});

test('a phone photo that carries an EXIF rotation is cropped UPRIGHT, the way the guard sees it', async ({ browser }) => {
  // An iPhone stores a portrait shot as a landscape JPEG plus "rotate 90°" in EXIF (orientation 6).
  const rotated = await sharp({ create: { width: 2400, height: 1600, channels: 3, background: '#4a6fa5' } })
    .withMetadata({ orientation: 6 }).jpeg().toBuffer();
  expect((await sharp(rotated).metadata()).orientation).toBe(6); // the fixture really carries it
  const { page } = await signIn(browser, GUARD);
  await page.goto('/visitors');
  await page.locator('input[data-visitor-file]').setInputFiles({ name: 'IMG_0002.jpg', mimeType: 'image/jpeg', buffer: rotated });
  await cropReady(page);
  // the picture is 1600 wide × 2400 tall as displayed → the 85% frame is portrait too
  expect(await frameOf(page)).toEqual({ x: 120, y: 180, w: 1360, h: 2040 });
  await page.locator('[data-crop-confirm]').click();
  await expect(page.getByRole('dialog').locator('#v-first')).toHaveValue('דוד');
  const meta = await sharp(anthropic.calls[0]!.imageBytes).metadata();
  expect((meta.height ?? 0)).toBeGreaterThan(meta.width ?? 0); // what the OCR reads is portrait, upright
  expect(meta.orientation).toBeUndefined(); // and carries no rotation tag any more
  await page.keyboard.press('Escape');
  await page.getByRole('alertdialog').getByRole('button', { name: 'צא ללא שמירה' }).click();
});

test('"צלם שוב" drops the photo and opens the camera again; nothing was read or stored', async ({ browser }) => {
  const { page } = await signIn(browser, GUARD);
  await page.goto('/visitors');
  const storedBefore = storage.keys('visitor-ids').length;
  const rowsBefore = (await pool.query(`select count(*)::int as n from public.visitor_scans where scanned_by = $1`, [roleUser.guard!.id])).rows[0].n;
  await page.locator('input[data-visitor-file]').setInputFiles({ name: 'id.jpg', mimeType: 'image/jpeg', buffer: await photo() });
  await cropReady(page);
  const chooser = page.waitForEvent('filechooser');
  await page.locator('[data-crop-cancel]').click();
  await chooser; // the camera / file picker is open again
  await expect(page.locator('[data-crop-editor]')).toHaveCount(0);
  expect(anthropic.calls).toHaveLength(0);
  expect(storage.keys('visitor-ids')).toHaveLength(storedBefore);
  expect((await pool.query(`select count(*)::int as n from public.visitor_scans where scanned_by = $1`, [roleUser.guard!.id])).rows[0].n).toBe(rowsBefore);
});

test('on a touch screen: a one-finger drag on a handle, a two-finger pinch zooms, the targets are 44px', async ({ browser }) => {
  const iphone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true };
  const base = await signIn(browser, GUARD);
  const phoneCtx = await browser.newContext({ ...iphone, storageState: await base.ctx.storageState() });
  contexts.push(phoneCtx);
  const page = await phoneCtx.newPage();
  await page.goto('/visitors');
  await page.locator('input[data-visitor-file]').setInputFiles({ name: 'id.jpg', mimeType: 'image/jpeg', buffer: await photo(3200, 2400) });
  await cropReady(page);

  // layout: the whole crop screen fits an iPhone, nothing scrolls sideways, every target is 44px
  const sheet = page.getByRole('dialog');
  expect((await sheet.boundingBox())!.width).toBeLessThanOrEqual(390);
  expect(await sheet.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
  const stageBox = (await page.locator('[data-crop-stage]').boundingBox())!;
  expect(stageBox.height).toBeGreaterThan(250); // the picture gets most of the screen
  for (const sel of ['[data-crop-confirm]', '[data-crop-cancel]', '[data-crop-zoom-in]', '[data-crop-zoom-out]', '[data-crop-reset]']) {
    const b = (await page.locator(sel).boundingBox())!;
    expect(b.height, `${sel} height`).toBeGreaterThanOrEqual(44);
    expect(b.width, `${sel} width`).toBeGreaterThanOrEqual(44);
  }
  for (const h of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']) {
    const b = (await page.locator(`[data-crop-handle="${h}"]`).boundingBox())!;
    expect(Math.min(b.width, b.height), `handle ${h}`).toBeGreaterThanOrEqual(44);
  }

  // real touch input (CDP) → pointer events with pointerType "touch"
  const cdp = await phoneCtx.newCDPSession(page);
  const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', points: { x: number; y: number; id: number }[]) =>
    cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : points.map((p) => ({ x: p.x, y: p.y, id: p.id })) });

  const before = await frameOf(page);
  const se = await centerOf(page, '[data-crop-handle="se"]');
  await touch('touchStart', [{ x: se.x, y: se.y, id: 1 }]);
  for (let i = 1; i <= 6; i += 1) await touch('touchMove', [{ x: se.x - i * 8, y: se.y - i * 8, id: 1 }]);
  await touch('touchEnd', []);
  const afterDrag = await frameOf(page);
  expect(afterDrag.w).toBeLessThan(before.w);
  expect(afterDrag.h).toBeLessThan(before.h);
  expect(afterDrag.x).toBe(before.x);

  const mid = await centerOf(page, '[data-crop-stage]');
  await touch('touchStart', [{ x: mid.x - 30, y: mid.y, id: 1 }, { x: mid.x + 30, y: mid.y, id: 2 }]);
  for (let i = 1; i <= 8; i += 1) {
    await touch('touchMove', [{ x: mid.x - 30 - i * 12, y: mid.y, id: 1 }, { x: mid.x + 30 + i * 12, y: mid.y, id: 2 }]);
  }
  await touch('touchEnd', []);
  await expect.poll(async () => Number(await page.locator('[data-crop-stage]').getAttribute('data-crop-zoom'))).toBeGreaterThan(1.5);
  expect(await frameOf(page)).toEqual(afterDrag); // zooming the picture does not move the frame in picture pixels
  await page.locator('[data-crop-cancel]').click();
});

test('on a phone held sideways the crop buttons stay on screen (the picture scrolls, the actions do not)', async ({ browser }) => {
  const base = await signIn(browser, GUARD);
  const phoneCtx = await browser.newContext({
    viewport: { width: 844, height: 390 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, storageState: await base.ctx.storageState(),
  });
  contexts.push(phoneCtx);
  const page = await phoneCtx.newPage();
  await page.goto('/visitors');
  await page.locator('input[data-visitor-file]').setInputFiles({ name: 'id.jpg', mimeType: 'image/jpeg', buffer: await photo(3200, 2400) });
  await cropReady(page);
  for (const sel of ['[data-crop-confirm]', '[data-crop-cancel]']) {
    await expect(page.locator(sel)).toBeInViewport({ ratio: 1 });
    const b = (await page.locator(sel).boundingBox())!;
    expect(b.y + b.height, `${sel} bottom`).toBeLessThanOrEqual(390);
  }
  expect(await page.getByRole('dialog').evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
  await page.locator('[data-crop-cancel]').click(); // leaves the file picker open - nothing else to do here
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

  // "הורד תמונה" (09/11/2026): a plain link to the proxy with ?download=1, a comfortable touch target.
  const dl = sheet.locator('a[data-visitor-download]');
  await expect(dl).toHaveText('הורד תמונה');
  await expect(dl).toHaveAttribute('href', `/api/files/visitor-ids/${firstScanKey}?download=1`);
  expect((await dl.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  const scanDay = (await pool.query<{ d: string }>(`select to_char(created_at at time zone 'Asia/Jerusalem', 'YYYY-MM-DD') as d from public.visitor_scans where id = $1`, [firstScanId])).rows[0]!.d;
  const wantName = `${NAME_TOKEN}_דוד המלך_${scanDay}.jpg`;
  const [saved] = await Promise.all([page.waitForEvent('download'), dl.click()]);
  expect(saved.suggestedFilename()).toBe(wantName); // {last}_{first}_{date}.jpg, Hebrew intact
  // The header itself: an attachment, the UTF-8 name, never cached.
  const head = await page.request.get(`/api/files/visitor-ids/${firstScanKey}?download=1`);
  expect(head.status()).toBe(200);
  expect(head.headers()['content-type']).toBe('image/jpeg');
  expect(head.headers()['content-disposition']).toContain('attachment');
  expect(decodeURIComponent(head.headers()['content-disposition']!.split("filename*=UTF-8''")[1]!)).toBe(wantName);
  expect(head.headers()['cache-control']).toMatch(/no-store/);
  // Each download is its OWN audit row (file_downloaded, no dedupe), apart from file_viewed - and it
  // names no person: the visitor's name is in the header, never in the audit metadata.
  const downloaded = await pool.query(`select metadata from public.audit_log where action = 'file_downloaded' and entity_type = 'visitor_scan' and entity_id = $1 and actor_user_id = $2`, [firstScanId, roleUser.guard!.id]);
  expect(downloaded.rows).toHaveLength(2); // the click and the direct request
  expect(downloaded.rows[0].metadata).toMatchObject({ bucket: 'visitor-ids', object_key: firstScanKey });
  expect(JSON.stringify(downloaded.rows.map((r) => r.metadata))).not.toContain(NAME_TOKEN);
  const viewedAfter = await pool.query(`select 1 from public.audit_log where action = 'file_viewed' and entity_type = 'visitor_scan' and entity_id = $1 and actor_user_id = $2`, [firstScanId, roleUser.guard!.id]);
  expect(viewedAfter.rows).toHaveLength(1); // a download is not a second view

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

test('manager, viewer, cleaner and maintenance have no access at all — menu, page and every API agree', async ({ browser }) => {
  const key = firstScanKey;
  for (const role of ['manager', 'viewer', 'cleaner', 'maintenance'] as const) {
    const { page, ctx } = await signIn(browser, roleUser[role]!.username);
    // the page sends them home (not to /visitors) and the menu has no such item
    await page.goto('/visitors');
    await expect(page).not.toHaveURL(/\/visitors/);
    await expect(page.locator('aside a[href="/visitors"]')).toHaveCount(0);
    await expect(page.getByText('סריקת כניסה')).toHaveCount(0);
    // every route of the module, every method: 403 — the rows, the photo, the writes, the OCR, the crop
    expect((await ctx.request.get('/api/visitors')).status(), `${role} list`).toBe(403);
    expect((await ctx.request.get(`/api/visitors?q=${NAME_TOKEN}`)).status()).toBe(403);
    expect((await ctx.request.get(`/api/files/visitor-ids/${key}`)).status(), `${role} photo`).toBe(403);
    expect((await ctx.request.post('/api/visitors', { multipart: { image: { name: 'a.jpg', mimeType: 'image/jpeg', buffer: await photo(50, 50) }, data: JSON.stringify({ document_type: 'id_card', document_number: '1', first_name: 'a', last_name: 'b' }) } })).status(), `${role} create`).toBe(403);
    expect((await ctx.request.patch(`/api/visitors/${firstScanId}`, { data: { notes: 'x' } })).status(), `${role} patch`).toBe(403);
    expect((await ctx.request.delete(`/api/visitors/${firstScanId}`)).status(), `${role} delete`).toBe(403);
    expect((await ctx.request.post('/api/visitors/ocr', { multipart: { image: { name: 'a.jpg', mimeType: 'image/jpeg', buffer: await photo(50, 50) } } })).status(), `${role} ocr`).toBe(403);
    expect((await ctx.request.post('/api/visitors/prepare', { multipart: { image: { name: 'a.jpg', mimeType: 'image/jpeg', buffer: await photo(50, 50) } } })).status(), `${role} prepare`).toBe(403);
    expect((await ctx.request.post(`/api/visitors/${firstScanId}/image`, { multipart: { image: { name: 'a.jpg', mimeType: 'image/jpeg', buffer: await photo(50, 50) } } })).status(), `${role} recrop`).toBe(403);
    expect((await ctx.request.get('/api/account/password')).status()).toBe(405);
    expect((await ctx.request.post('/api/account/password', { data: { current_password: 'a', new_password: 'b' } })).status()).toBe(403);
  }
  expect(anthropic.calls).toHaveLength(0);
  // …while the three roles that do have it see the item
  const admin = await signIn(browser, roleUser.admin!.username);
  await admin.page.goto('/visitors');
  await expect(admin.page.locator('aside a[href="/visitors"]')).toHaveCount(1);
  // and no request without a session gets anything either
  const anon = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  contexts.push(anon);
  expect((await anon.request.get('/api/visitors')).status()).toBe(401);
  expect((await anon.request.post('/api/visitors/prepare')).status()).toBe(401);
  expect((await anon.request.post(`/api/visitors/${firstScanId}/image`)).status()).toBe(401);
});

test('an admin re-crops a stored photo: the object is replaced, the old one removed, the audit row names both', async ({ browser }) => {
  const { page } = await signIn(browser, roleUser.admin!.username);
  // A stored photo with a known picture: left half red, right half blue.
  const W = 1200;
  const H = 800;
  const stored = await sharp({ create: { width: W, height: H, channels: 3, background: '#cc2222' } })
    .composite([{ input: await sharp({ create: { width: W / 2, height: H, channels: 3, background: '#2222cc' } }).png().toBuffer(), left: W / 2, top: 0 }])
    .jpeg({ quality: 92 }).toBuffer();
  const oldKey = `${randomUUID()}.jpg`;
  storage.objects.set(`visitor-ids/${oldKey}`, { contentType: 'image/jpeg', bytes: stored });
  const row = await pool.query<{ id: string }>(
    `insert into public.visitor_scans (document_type, document_number, first_name, last_name, nationality, image_object_key, scanned_by, scanned_by_name)
     values ('id_card', 'RC1', 'חיתוך', $1, 'ישראלית', $2, $3, 'בודק') returning id`,
    [`${NAME_TOKEN}R`, oldKey, roleUser.admin!.id],
  );
  const id = row.rows[0]!.id;
  scanIds.push(id);

  await page.goto('/visitors');
  await openRow(page, `${NAME_TOKEN}R`);
  const sheet = page.getByRole('dialog').first();
  await expect(sheet.locator('img[data-visitor-photo]')).toHaveAttribute('src', `/api/files/visitor-ids/${oldKey}`);

  // cancelling changes nothing
  await sheet.locator('[data-recrop-open]').click();
  await cropReady(page);
  expect(await frameOf(page)).toEqual({ x: 0, y: 0, w: W, h: H }); // a re-crop starts as the whole picture
  await expect(page.locator('[data-crop-confirm]')).toBeDisabled(); // …and an untouched frame cannot replace (re-encode) the photo
  await page.locator('[data-crop-cancel]').click();
  await expect(page.locator('[data-crop-editor]')).toHaveCount(0);
  expect((await pool.query(`select image_object_key from public.visitor_scans where id = $1`, [id])).rows[0].image_object_key).toBe(oldKey);

  // keep only the right half: drag the west edge to the middle
  await sheet.locator('[data-recrop-open]').click();
  await cropReady(page);
  const stage = (await page.locator('[data-crop-stage]').boundingBox())!;
  const scale = (await page.locator('[data-crop-rect]').boundingBox())!.width / W;
  await dragHandle(page, 'w', (W / 2) * scale, 0);
  const f = await frameOf(page);
  expect(f.x).toBeGreaterThan(W / 2 - 40);
  expect(f.x).toBeLessThan(W / 2 + 40);
  expect(stage.width).toBeGreaterThan(0);

  await page.locator('[data-crop-confirm]').click();
  // the cut is irreversible: a confirmation first
  const confirm = page.getByRole('alertdialog');
  await expect(confirm).toContainText('הצילום הנוכחי יוחלף');
  await confirm.locator('[data-recrop-confirm]').click();
  await expect(page.getByText('הצילום הוחלף')).toBeVisible();

  const after = (await pool.query(`select image_object_key, image_bytes, first_name, nationality from public.visitor_scans where id = $1`, [id])).rows[0];
  expect(after.image_object_key).not.toBe(oldKey);
  expect(after.first_name).toBe('חיתוך');
  expect(after.nationality).toBe('ישראלית'); // the hidden field is untouched
  const newObj = storage.objects.get(`visitor-ids/${after.image_object_key}`)!;
  expect(newObj).toBeDefined();
  const meta = await sharp(newObj.bytes).metadata();
  expect(meta.format).toBe('jpeg');
  expect(Math.abs((meta.width ?? 0) - W / 2)).toBeLessThan(80);
  expect(meta.height).toBe(H);
  const px = await sharp(newObj.bytes).resize(1, 1).raw().toBuffer();
  expect(px[2]!).toBeGreaterThan(px[0]! * 2); // blue, not red: the right half was kept
  expect(storage.objects.has(`visitor-ids/${oldKey}`)).toBe(false); // the old photo is gone from Storage
  expect(storage.removed).toContain(`visitor-ids/${oldKey}`);

  const audit = await pool.query(`select actor_user_id, metadata from public.audit_log where entity_type = 'visitor_scan' and entity_id = $1 and action = 'image_recropped'`, [id]);
  expect(audit.rows).toHaveLength(1);
  expect(audit.rows[0].actor_user_id).toBe(roleUser.admin!.id);
  expect(audit.rows[0].metadata).toEqual({ actor_role: 'admin', old_object_key: oldKey, new_object_key: after.image_object_key, new_image_bytes: newObj.bytes.length, old_photo_removed: true });
  expect(after.image_bytes).toBe(newObj.bytes.length);
  // the sheet shows the new photo, served through the proxy
  await expect(sheet.locator('img[data-visitor-photo]')).toHaveAttribute('src', `/api/files/visitor-ids/${after.image_object_key}`);
});

test('the guard has no "חתוך מחדש" on a saved photo, and the server refuses it too', async ({ browser }) => {
  const { page, ctx } = await signIn(browser, GUARD);
  await page.goto('/visitors');
  await openRow(page, `${NAME_TOKEN}R`);
  const sheet = page.getByRole('dialog').first();
  await expect(sheet.locator('img[data-visitor-photo]')).toBeVisible();
  await expect(sheet.locator('[data-recrop-open]')).toHaveCount(0);
  await expect(sheet.getByRole('button', { name: 'חתוך מחדש' })).toHaveCount(0);
  const id = (await pool.query<{ id: string }>(`select id from public.visitor_scans where last_name = $1`, [`${NAME_TOKEN}R`])).rows[0]!.id;
  const key = (await pool.query<{ image_object_key: string }>(`select image_object_key from public.visitor_scans where id = $1`, [id])).rows[0]!.image_object_key;
  const res = await ctx.request.post(`/api/visitors/${id}/image`, { multipart: { image: { name: 'a.jpg', mimeType: 'image/jpeg', buffer: await photo(50, 50) } } });
  expect(res.status()).toBe(403);
  expect((await pool.query(`select image_object_key from public.visitor_scans where id = $1`, [id])).rows[0].image_object_key).toBe(key);
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
  // the FILTERED total (26), not the unfiltered list's "page 1 of 2" that is on screen until the debounced search lands
  await expect(page.locator('[data-page-info]')).toContainText('עמוד 1 מתוך 2 · 26 סריקות');
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

  // The details sheet (09/11/2026): "הורד תמונה" sits under the photo, inside the screen, a 44px+ target.
  await page.locator('[data-visitor-cards] [data-visitor-row]').first().click();
  const details = page.getByRole('dialog');
  const dl = details.locator('a[data-visitor-download]');
  await dl.scrollIntoViewIfNeeded();
  await expect(dl).toBeVisible();
  await expect.poll(async () => (await dl.boundingBox())!.x).toBeGreaterThanOrEqual(0); // the sheet has slid in
  const dlBox = (await dl.boundingBox())!;
  expect(dlBox.height).toBeGreaterThanOrEqual(44);
  expect(dlBox.x + dlBox.width).toBeLessThanOrEqual(390);
  expect(await details.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
  await details.getByRole('button', { name: 'סגור' }).first().click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // The scan sheet is the whole screen on a phone and does not overflow either.
  await page.locator('input[data-visitor-file]').setInputFiles({ name: 'id.jpg', mimeType: 'image/jpeg', buffer: await photo() });
  await cropContinue(page);
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
