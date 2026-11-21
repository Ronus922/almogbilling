import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// The dead-cookie loop (21/11/2026), unit level — the request-level proof is
// e2e/auth-dead-cookie.spec.ts. Until then the proxy bounced ANY almog_sid
// holder off /login to `/`, and `/` sent a dead cookie back to /login. Now:
//   · the proxy only sends a cookie-LESS visitor of a protected path to /login;
//   · /login, /forgot-password send home only a session the DB confirms;
//   · `/` and the (app) layout send a dead cookie to /api/auth/session-reset,
//     which clears it and always ends on /login — never signs a live session out;
//   · a sign-in sets the cookie under the same name and path, replacing a dead one.

const jar = new Map<string, string>();
const setCookie = vi.fn();
const deleteCookie = vi.fn();
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: setCookie,
    delete: deleteCookie,
  }),
}));
type Sql = (sql: string, params?: unknown[]) => Promise<unknown>;
const dbQuery = vi.fn<Sql>(async () => ({ rows: [], rowCount: 0 }));
const dbQueryOne = vi.fn<Sql>(async () => null);
vi.mock('@/lib/db', () => ({ query: dbQuery, queryOne: dbQueryOne }));
class Redirect extends Error {
  constructor(readonly to: string) { super(`redirect ${to}`); }
}
vi.mock('next/navigation', () => ({ redirect: (to: string) => { throw new Redirect(to); } }));
vi.mock('@/lib/config', () => ({ appUrl: () => 'https://app.example' }));

const { proxy, config } = await import('@/proxy');
const { createSession } = await import('@/lib/auth/session');
const { redirectIfSignedIn } = await import('@/lib/auth/signedIn');
const { GET: sessionReset } = await import('@/app/api/auth/session-reset/route');
const { default: RootPage } = await import('@/app/page');
const { SESSION_COOKIE, SESSION_RESET_PATH } = await import('@/lib/constants');

const LIVE = { sid: 'h', user_id: 'u1', username: 'a', email: null, full_name: 'A', is_active: true, role: 'super_admin' };

async function redirectOf(fn: () => Promise<unknown>): Promise<string | null> {
  try { await fn(); return null; } catch (e) { if (e instanceof Redirect) return e.to; throw e; }
}

beforeEach(() => {
  jar.clear();
  setCookie.mockClear();
  deleteCookie.mockClear();
  dbQuery.mockClear();
  dbQueryOne.mockReset();
  dbQueryOne.mockResolvedValue(null);
});

describe('proxy', () => {
  const req = (path: string, cookie?: string) =>
    new NextRequest(`https://app.example${path}`, { headers: cookie ? { cookie } : {} });

  it('(4) no cookie on a protected path → /login', () => {
    for (const p of ['/overview', '/dashboard', '/dashboard/x']) {
      const r = proxy(req(p));
      expect(r.status).toBe(307);
      expect(r.headers.get('location')).toBe('https://app.example/login');
    }
  });
  it('a cookie — live or dead, the proxy cannot tell — never bounces anyone, and the auth pages are off its matcher', () => {
    for (const p of ['/login', '/forgot-password', '/overview']) {
      const r = proxy(req(p, `${SESSION_COOKIE}=dead`));
      expect(r.headers.get('location')).toBeNull();
      expect(r.headers.get('x-middleware-next')).toBe('1');
    }
    expect(config.matcher).toEqual(['/dashboard/:path*', '/overview/:path*']);
  });
});

describe('the auth pages: home only for a session the DB confirms', () => {
  it('(1) no cookie, or a cookie the DB does not know / has expired → no redirect, the form renders', async () => {
    expect(await redirectOf(redirectIfSignedIn)).toBeNull();
    jar.set(SESSION_COOKIE, 'dead');
    expect(await redirectOf(redirectIfSignedIn)).toBeNull();
    // the lookup itself filters expired rows (expires_at > now())
    expect(String(dbQueryOne.mock.calls[0]![0])).toContain('s.expires_at > now()');
  });
  it('a disabled user\'s session → no redirect either', async () => {
    jar.set(SESSION_COOKIE, 'raw');
    dbQueryOne.mockResolvedValue({ ...LIVE, is_active: false });
    expect(await redirectOf(redirectIfSignedIn)).toBeNull();
  });
  it('(3) a live session → its role home', async () => {
    jar.set(SESSION_COOKIE, 'raw');
    dbQueryOne.mockResolvedValue(LIVE);
    expect(await redirectOf(redirectIfSignedIn)).toBe('/overview');
    dbQueryOne.mockResolvedValue({ ...LIVE, role: 'viewer' });
    expect(await redirectOf(redirectIfSignedIn)).toBe('/dashboard');
  });
});

describe('`/` (the root page)', () => {
  it('no cookie → /login; a dead cookie → the reset route; a live session → home', async () => {
    expect(await redirectOf(() => RootPage())).toBe('/login');
    jar.set(SESSION_COOKIE, 'dead');
    expect(await redirectOf(() => RootPage())).toBe(SESSION_RESET_PATH);
    dbQueryOne.mockResolvedValue(LIVE);
    expect(await redirectOf(() => RootPage())).toBe('/overview');
  });
});

describe('/api/auth/session-reset', () => {
  it('(2) a dead cookie: cleared, → /login (a finite end — /login renders for any cookie)', async () => {
    jar.set(SESSION_COOKIE, 'dead');
    const r = await sessionReset();
    expect(r.status).toBe(307);
    expect(r.headers.get('location')).toBe('https://app.example/login');
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(deleteCookie).toHaveBeenCalledWith(SESSION_COOKIE);
  });
  it('a disabled user: that session row and the cookie go → /login?reason=disabled', async () => {
    jar.set(SESSION_COOKIE, 'raw');
    dbQueryOne.mockImplementation(async (sql: string) =>
      sql.includes('join public.users') ? { ...LIVE, is_active: false } : { id: 'h' });
    const r = await sessionReset();
    expect(r.headers.get('location')).toBe('https://app.example/login?reason=disabled');
    expect(dbQuery).toHaveBeenCalledWith(expect.stringContaining('delete from public.sessions where id = $1'), [expect.any(String)]);
    expect(deleteCookie).toHaveBeenCalledWith(SESSION_COOKIE);
  });
  it('a live session is never signed out by this GET — it goes home, the cookie untouched', async () => {
    jar.set(SESSION_COOKIE, 'raw');
    dbQueryOne.mockResolvedValue(LIVE);
    const r = await sessionReset();
    expect(r.headers.get('location')).toBe('https://app.example/overview');
    expect(deleteCookie).not.toHaveBeenCalled();
    expect(dbQuery).not.toHaveBeenCalled();
  });
});

describe('a sign-in overwrites a dead cookie', () => {
  it('createSession sets the SAME cookie (name, path /, host-only) — the browser replaces the dead value', async () => {
    jar.set(SESSION_COOKIE, 'dead');
    for (const remember of [false, true]) {
      setCookie.mockClear();
      const raw = await createSession('u1', remember);
      expect(raw).not.toBe('dead');
      expect(setCookie).toHaveBeenCalledTimes(1);
      const [name, value, opts] = setCookie.mock.calls[0]! as [string, string, Record<string, unknown>];
      expect([name, value]).toEqual([SESSION_COOKIE, raw]);
      expect(opts).toMatchObject({ path: '/', httpOnly: true, sameSite: 'lax' });
      expect(opts).not.toHaveProperty('domain', expect.anything());
    }
  });
});
