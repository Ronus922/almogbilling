import { test, expect, request as playwrightRequest, type APIRequestContext } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { E2E_USER } from './helpers';

// The dead-cookie loop (21/11/2026). The proxy used to bounce ANY almog_sid
// holder off /login to `/`, and `/` sent a cookie that names no live session
// back to /login: / → /login → / → … (ERR_TOO_MANY_REDIRECTS) until the
// browser's cookies were cleared — and an installed iPhone web app cannot
// clear them. Now only a page that can validate the session decides, a dead
// cookie gets the login form, and /api/auth/session-reset clears it.
//
// Requests are walked hop by hop (maxRedirects 0) and the dead cookie is sent
// on EVERY hop — the worst case, a browser that kept it — so "finite" holds
// even if the clearing Set-Cookie were ignored. Sessions are DB rows (the
// cookie holds the raw id, the table its SHA-256), never a form login: the
// whole job shares one per-IP login budget. Fixtures are removed by exact ids.

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
pool.on('error', () => {});
const tag = String(Date.now()).slice(-6);
const made = { sessions: [] as string[], users: [] as string[] };
let api: APIRequestContext;
let base: string;

test.use({ storageState: { cookies: [], origins: [] } });

const sha = (raw: string) => createHash('sha256').update(raw).digest('hex');

async function userId(username: string): Promise<string> {
  const r = await pool.query<{ id: string }>(`select id from public.users where username = $1`, [username]);
  expect(r.rows, `user ${username}`).toHaveLength(1);
  return r.rows[0]!.id;
}

/** A session row for `uid` that expires `inHours` from now (negative = already expired). */
async function sessionFor(uid: string, inHours: number): Promise<string> {
  const raw = randomBytes(32).toString('base64url');
  await pool.query(
    `insert into public.sessions (id, user_id, expires_at, remember) values ($1, $2, now() + make_interval(hours => $3), false)`,
    [sha(raw), uid, inHours],
  );
  made.sessions.push(sha(raw));
  return raw;
}

async function makeUser(name: string, role: string, active: boolean): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `insert into public.users (username, email, password_hash, full_name, role, is_active)
     values ($1, null, 'not-a-real-hash', $2, $3, $4) returning id`,
    [name, `בדיקת עוגייה ${name}`, role, active],
  );
  made.users.push(r.rows[0]!.id);
  return r.rows[0]!.id;
}

interface Hop { path: string; status: number; location: string | null; setCookie: string }

/** GETs `path`, follows redirects by hand (up to 8), and sends `cookie` on every hop. */
async function walk(path: string, cookie: string | null): Promise<{ hops: Hop[]; final: Hop & { body: string } }> {
  const hops: Hop[] = [];
  let url = path;
  for (let i = 0; i < 8; i++) {
    const r = await api.get(url, { maxRedirects: 0, headers: cookie ? { cookie } : {} });
    const location = r.headers()['location'] ?? null;
    const hop: Hop = { path: url, status: r.status(), location, setCookie: r.headers()['set-cookie'] ?? '' };
    if (r.status() >= 300 && r.status() < 400 && location) {
      hops.push(hop);
      const next = new URL(location, base);
      url = next.pathname + next.search;
      continue;
    }
    return { hops, final: { ...hop, body: await r.text() } };
  }
  throw new Error(`no end after 8 hops: ${hops.map((h) => `${h.path} → ${h.location}`).join(', ')}`);
}

test.beforeAll(async () => {
  base = String(test.info().project.use.baseURL);
  api = await playwrightRequest.newContext({ baseURL: base, storageState: { cookies: [], origins: [] } });
});

test.afterAll(async () => {
  await api?.dispose();
  await pool.query(`delete from public.sessions where id = any($1::text[])`, [made.sessions]);
  await pool.query(`delete from public.users where id = any($1::uuid[])`, [made.users]);
  await pool.end();
});

test.describe('the login flow with a dead session cookie', () => {
  test('(1) /login and /forgot-password with an unknown or expired cookie render their form (200), never a redirect', async () => {
    const expired = await sessionFor(await userId(E2E_USER), -1);
    for (const cookie of ['almog_sid=dead', `almog_sid=${expired}`]) {
      const login = await api.get('/login', { maxRedirects: 0, headers: { cookie } });
      expect(login.status()).toBe(200);
      expect(await login.text()).toContain('id="username"');
      const forgot = await api.get('/forgot-password', { maxRedirects: 0, headers: { cookie } });
      expect(forgot.status()).toBe(200);
    }
  });

  test('(2) / with a dead cookie ends on the login form in a finite chain, and the reset hop clears the cookie', async () => {
    const expired = await sessionFor(await userId(E2E_USER), -1);
    for (const cookie of ['almog_sid=dead', `almog_sid=${expired}`]) {
      const { hops, final } = await walk('/', cookie);
      expect(hops.map((h) => [h.path, h.location?.replace(base, '')])).toEqual([
        ['/', '/api/auth/session-reset'],
        ['/api/auth/session-reset', '/login'],
      ]);
      expect(hops[1]!.setCookie).toMatch(/almog_sid=;.*(Max-Age=0|Expires=Thu, 01 Jan 1970)/i);
      expect(final).toMatchObject({ path: '/login', status: 200 });
      expect(final.body).toContain('id="username"');
      // A protected page goes the same way (the (app) layout), not through `/`.
      const viaApp = await walk('/overview', cookie);
      expect(viaApp.hops.map((h) => h.location?.replace(base, ''))).toEqual(['/api/auth/session-reset', '/login']);
      expect(viaApp.final.status).toBe(200);
    }
    // The expired row the reset route saw is gone — that row, by its own hash.
    expect((await pool.query(`select 1 from public.sessions where id = $1`, [sha(expired)])).rowCount).toBe(0);
  });

  test('a disabled user\'s live session row: cleared on the way to /login?reason=disabled', async () => {
    const uid = await makeUser(`e2e-dead-cookie-off-${tag}`, 'manager', false);
    const raw = await sessionFor(uid, 3);
    const { hops, final } = await walk('/overview', `almog_sid=${raw}`);
    expect(hops.map((h) => h.location?.replace(base, ''))).toEqual(['/api/auth/session-reset', '/login?reason=disabled']);
    expect(final).toMatchObject({ path: '/login?reason=disabled', status: 200 });
    expect((await pool.query(`select 1 from public.sessions where id = $1`, [sha(raw)])).rowCount).toBe(0);
  });

  test('(3) a valid session on /login and /forgot-password still lands on the role home; the reset route never signs it out', async () => {
    const raw = await sessionFor(await userId(E2E_USER), 3);
    const cookie = `almog_sid=${raw}`;
    for (const path of ['/login', '/forgot-password']) {
      const r = await api.get(path, { maxRedirects: 0, headers: { cookie } });
      expect(r.status()).toBe(307);
      expect(r.headers()['location']?.replace(base, '')).toBe('/overview'); // super_admin's home
    }
    const reset = await api.get('/api/auth/session-reset', { maxRedirects: 0, headers: { cookie } });
    expect(reset.status()).toBe(307);
    expect(reset.headers()['location']?.replace(base, '')).toBe('/overview');
    expect(reset.headers()['set-cookie'] ?? '').not.toContain('almog_sid');
    expect((await pool.query(`select 1 from public.sessions where id = $1`, [sha(raw)])).rowCount).toBe(1);
    const me = await api.get('/api/auth/me', { headers: { cookie } });
    expect(me.status()).toBe(200);
  });

  test('(4) no cookie: /overview and / go to /login; /login renders', async () => {
    const overview = await api.get('/overview', { maxRedirects: 0 });
    expect(overview.status()).toBe(307);
    expect(overview.headers()['location']?.replace(base, '')).toBe('/login');
    const { hops, final } = await walk('/', null);
    expect(hops.map((h) => h.location?.replace(base, ''))).toEqual(['/login']);
    expect(final.status).toBe(200);
  });

  test('zero permissions still end on /no-access — with a valid session, also from /login', async () => {
    const uid = await makeUser(`e2e-dead-cookie-none-${tag}`, 'manager', true); // a matrix role, no rows
    const raw = await sessionFor(uid, 3);
    const fromLogin = await walk('/login', `almog_sid=${raw}`);
    expect(fromLogin.hops.map((h) => h.location?.replace(base, ''))).toEqual(['/overview', '/no-access']);
    expect(fromLogin.final).toMatchObject({ path: '/no-access', status: 200 });
  });

  test('the public pages answer the same with no cookie, a dead cookie and a valid one', async () => {
    const valid = `almog_sid=${await sessionFor(await userId(E2E_USER), 3)}`;
    for (const path of ['/chip-order', '/chip-order?test=not-a-token', '/portal']) {
      const none = await walk(path, null);
      for (const cookie of ['almog_sid=dead', valid]) {
        const r = await walk(path, cookie);
        expect(r.hops.map((h) => h.location), `${path} with ${cookie.slice(0, 14)}`).toEqual(none.hops.map((h) => h.location));
        expect(r.final.status, `${path} with ${cookie.slice(0, 14)}`).toBe(none.final.status);
      }
      expect(none.final.status, path).toBe(200);
    }
  });

  test('in the browser: a dead cookie opens the login form (no error page) and is gone; a stale jar that keeps it still ends on the form', async ({ browser }) => {
    const dead = { name: 'almog_sid', value: 'dead', domain: 'localhost', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' as const, expires: -1 };
    const ctx = await browser.newContext({ storageState: { cookies: [dead], origins: [] }, viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    const res = await page.goto('/');
    expect(res?.status()).toBe(200);
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.locator('#username')).toBeVisible();
    expect((await ctx.cookies()).filter((c) => c.name === 'almog_sid')).toHaveLength(0);

    // The installed-app case: the start URL `/` with the dead cookie back in
    // the jar ends on the form again — and so does /login itself. (That a
    // sign-in overwrites the cookie is tests/auth-dead-cookie.test.ts:
    // this file stays off the job's shared per-IP login budget.)
    await ctx.addCookies([dead]);
    await page.goto('/');
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.locator('#username')).toBeVisible();
    await ctx.addCookies([dead]);
    await page.goto('/login');
    await expect(page.locator('#username')).toBeVisible();
    await ctx.close();
  });
});
