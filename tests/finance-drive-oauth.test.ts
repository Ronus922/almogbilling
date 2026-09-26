import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

// ── Hoisted fixtures (vi.mock factories run before this file's body) ─────────
const h = vi.hoisted(() => {
  return {
    // Any 32 bytes — the cipher only cares about the length.
    KEY: Buffer.from('finance-drive-oauth-test-key-32b').toString('base64'),
    jar: new Map<string, string>(),
    cookieOpts: new Map<string, unknown>(),
    client: {
      getToken: vi.fn(),
      verifyIdToken: vi.fn(),
      revokeToken: vi.fn(async () => ({})),
    },
  };
});

vi.mock('@/env', () => ({
  env: {
    SETTINGS_ENC_KEY: h.KEY,
    APP_URL: 'https://billing.test',
    GOOGLE_CLIENT_ID: 'cid',
    GOOGLE_CLIENT_SECRET: 'sec',
  },
}));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (n: string) => (h.jar.has(n) ? { name: n, value: h.jar.get(n) as string } : undefined),
    set: (n: string, v: string, o?: unknown) => { h.jar.set(n, v); h.cookieOpts.set(n, o); },
    delete: (n: string) => { h.jar.delete(n); },
  }),
}));
vi.mock('next/server', async (importOriginal) => {
  const real = await importOriginal<typeof import('next/server')>();
  // after() needs a request scope; here the callback runs at once.
  return { ...real, after: vi.fn((cb: () => unknown) => { void cb(); }) };
});
vi.mock('@/lib/auth/google', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/auth/google')>();
  return { ...real, getGoogleConfig: vi.fn(real.getGoogleConfig), createGoogleClient: vi.fn(() => h.client) };
});
vi.mock('@/lib/auth/actor', () => ({ requireAdmin: vi.fn() }));
vi.mock('@/lib/auth/session', () => ({ createSession: vi.fn(async () => 'sid') }));
vi.mock('@/lib/auth/rateLimit', () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, retryAfterSec: 0 })),
  clientIp: () => '203.0.113.7',
}));
vi.mock('@/lib/db', () => ({ query: vi.fn(), queryOne: vi.fn() }));
vi.mock('@/lib/db/finance/drive', () => ({ upsertDriveConnection: vi.fn(async () => undefined) }));
vi.mock('@/lib/db/audit', () => ({ writeAudit: vi.fn(async () => undefined) }));
vi.mock('@/lib/finance/drive-sync', () => ({
  retryPendingDriveUploads: vi.fn(async () => ({ processed: 0, done: 0, failed: 0 })),
}));
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() },
}));

import { after } from 'next/server';
import { GET as loginCallback } from '@/app/api/auth/google/callback/route';
import { GET as driveStart } from '@/app/api/finance/drive/start/route';
import {
  DRIVE_NONCE_COOKIE, DRIVE_STATE_TTL_SEC, DRIVE_VERIFIER_COOKIE,
  isDriveStateExpired, openDriveState, sealDriveState,
} from '@/lib/finance/drive-oauth';
import { encrypt } from '@/lib/crypto/settings-cipher';
import { FINANCE_DRIVE_ACCOUNT } from '@/lib/constants/finance';
import { AuthorizationError } from '@/lib/auth/errors';
import { requireAdmin } from '@/lib/auth/actor';
import { getGoogleConfig } from '@/lib/auth/google';
import { createSession } from '@/lib/auth/session';
import { checkRateLimit } from '@/lib/auth/rateLimit';
import { queryOne } from '@/lib/db';
import { upsertDriveConnection } from '@/lib/db/finance/drive';
import { writeAudit } from '@/lib/db/audit';
import { retryPendingDriveUploads } from '@/lib/finance/drive-sync';
import { logger } from '@/lib/logger';

const requirePerm = vi.mocked(requireAdmin);
const googleConfig = vi.mocked(getGoogleConfig);
const mintSession = vi.mocked(createSession);
const rateLimit = vi.mocked(checkRateLimit);
const dbOne = vi.mocked(queryOne);
const upsert = vi.mocked(upsertDriveConnection);
const audit = vi.mocked(writeAudit);
const retry = vi.mocked(retryPendingDriveUploads);
const afterMock = vi.mocked(after);
const fetchMock = vi.fn<typeof fetch>();
vi.stubGlobal('fetch', fetchMock);

const ADMIN = { id: 'admin-1', username: 'ronen', email: 'r@bios.co.il', full_name: null, role: 'admin' as const, permissions: [], isAuthenticated: true as const };
const OTHER_ADMIN = { ...ADMIN, id: 'admin-2', username: 'other' };
const CALLBACK = 'https://billing.test/api/auth/google/callback';

const b64url = (n: number) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 37) % 251)).toString('base64url');

function callback(params: Record<string, string>) {
  const url = new URL(CALLBACK);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return loginCallback(new Request(url) as unknown as NextRequest);
}

function location(res: Response): URL {
  expect(res.status).toBe(307);
  return new URL(res.headers.get('location') ?? '');
}

function loginError(res: Response): string | null {
  const loc = location(res);
  expect(loc.pathname).toBe('/login');
  return loc.searchParams.get('error');
}

function driveErrorReason(res: Response): string | null {
  const loc = location(res);
  expect(loc.pathname).toBe('/finance/settings');
  expect(loc.searchParams.get('drive')).toBe('error');
  return loc.searchParams.get('reason');
}

/** Press "חבר Google Drive" as `actor`: fills the cookie jar and returns what Google would echo back. */
async function startDrive(actor = ADMIN) {
  requirePerm.mockResolvedValueOnce(actor);
  const res = await driveStart();
  const loc = location(res);
  return { loc, state: loc.searchParams.get('state') as string, nonce: loc.searchParams.get('nonce') as string };
}

function googleReturns(tokens: Record<string, string | undefined>, payload: Record<string, unknown> | null) {
  h.client.getToken.mockResolvedValueOnce({ tokens });
  h.client.verifyIdToken.mockResolvedValueOnce({ getPayload: () => payload });
}

const userinfo = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks keeps queued *Once values — drop them so no test inherits another's actor.
  requirePerm.mockReset();
  h.jar.clear();
  h.cookieOpts.clear();
  fetchMock.mockReset();
  fetchMock.mockRejectedValue(new Error('unexpected network call'));
});

// ── State helpers ─────────────────────────────────────────────────────────────
describe('drive state — seal / open', () => {
  it('round-trips and carries flow, nonce, uid and a 10-minute expiry', () => {
    const now = 1_760_000_000_000;
    const raw = sealDriveState({ uid: 'u1', nonce: 'n1', now });
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/); // URL-safe, no encoding surprises
    const s = openDriveState(raw);
    expect(s).toEqual({ flow: 'finance_drive', nonce: 'n1', uid: 'u1', exp: now + DRIVE_STATE_TTL_SEC * 1000 });
    expect(isDriveStateExpired(s!, now + DRIVE_STATE_TTL_SEC * 1000 - 1)).toBe(false);
    expect(isDriveStateExpired(s!, now + DRIVE_STATE_TTL_SEC * 1000)).toBe(true);
  });

  it('is null for a login state, garbage, a tampered blob and empty input', () => {
    expect(openDriveState(b64url(16))).toBeNull();        // what /api/auth/google/start issues
    expect(openDriveState('not base64 at all!')).toBeNull();
    expect(openDriveState('')).toBeNull();
    expect(openDriveState(null)).toBeNull();
    expect(openDriveState('x'.repeat(5000))).toBeNull();
    const raw = sealDriveState({ uid: 'u1', nonce: 'n1' });
    const flipped = raw.slice(0, 40) + (raw[40] === 'A' ? 'B' : 'A') + raw.slice(41);
    expect(openDriveState(flipped)).toBeNull();           // GCM tag fails → not ours
    // A plaintext JSON that merely LOOKS like a state is not a sealed one.
    expect(openDriveState(Buffer.from(JSON.stringify({ flow: 'finance_drive', nonce: 'n', uid: 'u', exp: 9e15 })).toString('base64url'))).toBeNull();
  });

  it('refuses a blob with a shortened auth tag or a wrong-size IV, and a sealed payload of another flow', () => {
    const seal = (blob: object) => Buffer.from(JSON.stringify(blob), 'utf8').toString('base64url');
    const good = encrypt(JSON.stringify({ flow: 'finance_drive', nonce: 'n', uid: 'u', exp: 9e15 }));
    expect(openDriveState(seal(good))).not.toBeNull();
    const shortTag = { ...good, tag: Buffer.from(good.tag, 'base64').subarray(0, 4).toString('base64') };
    expect(openDriveState(seal(shortTag))).toBeNull();
    const twelveTag = { ...good, tag: Buffer.from(good.tag, 'base64').subarray(0, 12).toString('base64') };
    expect(openDriveState(seal(twelveTag))).toBeNull();
    const longIv = { ...good, iv: Buffer.concat([Buffer.from(good.iv, 'base64'), Buffer.alloc(4)]).toString('base64') };
    expect(openDriveState(seal(longIv))).toBeNull();
    // Sealed with our key, but not a Drive state — a login-shaped or unrelated payload never opens.
    expect(openDriveState(seal(encrypt(JSON.stringify({ flow: 'login', nonce: 'n', uid: 'u', exp: 9e15 }))))).toBeNull();
    expect(openDriveState(seal(encrypt(JSON.stringify({ flow: 'finance_drive', nonce: '', uid: 'u', exp: 9e15 }))))).toBeNull();
    expect(openDriveState(seal(encrypt(JSON.stringify({ flow: 'finance_drive', nonce: 'n', uid: 'u', exp: 'soon' }))))).toBeNull();
    expect(openDriveState(seal(encrypt('"just a string"')))).toBeNull();
  });
});

// ── /api/finance/drive/start ──────────────────────────────────────────────────
describe('GET /api/finance/drive/start', () => {
  it('sends the admin to Google with the LOGIN redirect_uri, drive scope, offline access, account chooser hint and a sealed state', async () => {
    const { loc, state, nonce } = await startDrive();
    expect(loc.origin + loc.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(loc.searchParams.get('redirect_uri')).toBe(CALLBACK);
    expect(loc.searchParams.get('client_id')).toBe('cid');
    expect(loc.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/drive.file openid email');
    expect(loc.searchParams.get('access_type')).toBe('offline');
    expect(loc.searchParams.get('prompt')).toBe('select_account consent');
    expect(loc.searchParams.get('login_hint')).toBe(FINANCE_DRIVE_ACCOUNT);
    expect(loc.searchParams.get('code_challenge_method')).toBe('S256');
    expect(loc.searchParams.get('code_challenge')).toBeTruthy();
    const opened = openDriveState(state);
    expect(opened?.uid).toBe('admin-1');
    expect(opened?.nonce).toBe(nonce);
    expect(h.jar.get(DRIVE_NONCE_COOKIE)).toBe(nonce);
    expect(h.jar.get(DRIVE_VERIFIER_COOKIE)).toBeTruthy();
    expect(requirePerm).toHaveBeenCalledTimes(1);
  });

  it('stores the nonce and PKCE verifier in httpOnly, SameSite=Lax cookies that live as long as the state', async () => {
    await startDrive();
    for (const name of [DRIVE_NONCE_COOKIE, DRIVE_VERIFIER_COOKIE]) {
      expect(h.cookieOpts.get(name)).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/', maxAge: DRIVE_STATE_TTL_SEC });
    }
  });

  it('is refused without a session (401) and for a non-admin tier (403) — nothing is set', async () => {
    requirePerm.mockRejectedValueOnce(new AuthorizationError('לא מחובר', 401));
    expect((await driveStart()).status).toBe(401);
    requirePerm.mockRejectedValueOnce(new AuthorizationError('דרושה הרשאת מנהל'));
    expect((await driveStart()).status).toBe(403);
    // Belt and braces: even an admin-tier actor must hold finance:edit.
    requirePerm.mockResolvedValueOnce({ ...ADMIN, role: 'manager' as const, permissions: [] });
    expect((await driveStart()).status).toBe(403);
    expect(h.jar.size).toBe(0);
  });

  it('fails soft to the settings screen when Google OAuth is not configured', async () => {
    requirePerm.mockResolvedValueOnce(ADMIN);
    googleConfig.mockReturnValueOnce(null);
    expect(driveErrorReason(await driveStart())).toBe('unavailable');
    expect(h.jar.size).toBe(0);
  });
});

// ── Login flow — must be untouched ────────────────────────────────────────────
describe('login callback — regression', () => {
  it('a login state with no matching cookie still fails as google_failed, touching nothing of the Drive flow', async () => {
    expect(loginError(await callback({ code: 'c', state: b64url(16) }))).toBe('google_failed');
    expect(rateLimit).toHaveBeenCalledTimes(1);
    expect(h.client.getToken).not.toHaveBeenCalled();
    expect(requirePerm).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it('no state at all, an empty state, and a Google error without state all take the login path', async () => {
    expect(loginError(await callback({ code: 'c' }))).toBe('google_failed');
    expect(loginError(await callback({ code: 'c', state: '' }))).toBe('google_failed');
    expect(loginError(await callback({ error: 'access_denied' }))).toBe('google_failed');
    expect(loginError(await callback({ error: 'access_denied', state: b64url(16) }))).toBe('google_failed');
    expect(rateLimit).toHaveBeenCalledTimes(4);
    expect(h.client.getToken).not.toHaveBeenCalled();
    expect(requirePerm).not.toHaveBeenCalled();
  });

  it('a rate-limited IP is still refused before any exchange', async () => {
    rateLimit.mockResolvedValueOnce({ allowed: false, retryAfterSec: 60 });
    const state = b64url(16);
    h.jar.set('g_oauth_state', state);
    h.jar.set('g_oauth_nonce', 'n');
    h.jar.set('g_oauth_verifier', 'v');
    expect(loginError(await callback({ code: 'c', state }))).toBe('google_failed');
    expect(h.client.getToken).not.toHaveBeenCalled();
    expect(mintSession).not.toHaveBeenCalled();
  });

  it('a valid login round-trip still mints a session and lands on /dashboard', async () => {
    const state = b64url(16);
    h.jar.set('g_oauth_state', state);
    h.jar.set('g_oauth_nonce', 'login-nonce');
    h.jar.set('g_oauth_verifier', 'ver');
    googleReturns({ id_token: 'idt' }, { email: 'r@bios.co.il', email_verified: true, nonce: 'login-nonce' });
    dbOne.mockResolvedValueOnce({ id: 'u-ronen', is_active: true, allow_google_auth: true });

    const res = await callback({ code: 'c', state });
    expect(location(res).pathname).toBe('/dashboard');
    expect(h.client.getToken).toHaveBeenCalledWith({ code: 'c', codeVerifier: 'ver' });
    expect(mintSession).toHaveBeenCalledWith('u-ronen', false);
    expect(h.jar.has('g_oauth_state')).toBe(false);
    expect(requirePerm).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it('a login by a user without allow_google_auth is still refused', async () => {
    const state = b64url(16);
    h.jar.set('g_oauth_state', state);
    h.jar.set('g_oauth_nonce', 'n');
    h.jar.set('g_oauth_verifier', 'v');
    googleReturns({ id_token: 'idt' }, { email: 'x@bios.co.il', email_verified: true, nonce: 'n' });
    dbOne.mockResolvedValueOnce({ id: 'u-x', is_active: true, allow_google_auth: false });
    expect(loginError(await callback({ code: 'c', state }))).toBe('google_not_allowed');
    expect(mintSession).not.toHaveBeenCalled();
  });
});

// ── Drive branch ──────────────────────────────────────────────────────────────
describe('Drive branch of the login callback', () => {
  it('a valid state + nonce cookie + the designated account → refresh token stored, backups retried in after(), no session minted', async () => {
    const { state, nonce } = await startDrive();
    requirePerm.mockResolvedValueOnce(ADMIN);
    googleReturns({ refresh_token: 'rt-1', access_token: 'at-1', id_token: 'idt' }, { email: 'Lahav.Yeadim@gmail.com', email_verified: true, nonce });

    const verifier = h.jar.get(DRIVE_VERIFIER_COOKIE);
    const res = await callback({ code: 'code-1', state });
    const loc = location(res);
    expect(loc.pathname).toBe('/finance/settings');
    expect(loc.searchParams.get('drive')).toBe('connected');

    expect(h.client.getToken).toHaveBeenCalledWith({ code: 'code-1', codeVerifier: verifier });
    expect(h.client.verifyIdToken).toHaveBeenCalledWith({ idToken: 'idt', audience: 'cid' });
    expect(upsert).toHaveBeenCalledWith({ email: FINANCE_DRIVE_ACCOUNT, refreshToken: 'rt-1', connectedBy: 'admin-1' });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'drive_connected', actorUserId: 'admin-1' }));
    expect(afterMock).toHaveBeenCalledTimes(1);
    expect(retry).toHaveBeenCalledWith(50);
    expect(h.client.revokeToken).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    // Not a login: no session, no allow_google_auth lookup, no login rate bucket.
    expect(mintSession).not.toHaveBeenCalled();
    expect(dbOne).not.toHaveBeenCalled();
    expect(rateLimit).not.toHaveBeenCalled();
    expect(h.jar.has(DRIVE_NONCE_COOKIE)).toBe(false);
    expect(h.jar.has(DRIVE_VERIFIER_COOKIE)).toBe(false);
  });

  it('a retry that crashes inside after() is logged and does not change the connected outcome', async () => {
    const { state, nonce } = await startDrive();
    requirePerm.mockResolvedValueOnce(ADMIN);
    googleReturns({ refresh_token: 'rt', id_token: 'idt' }, { email: FINANCE_DRIVE_ACCOUNT, email_verified: true, nonce });
    retry.mockRejectedValueOnce(new Error('drive down'));
    const res = await callback({ code: 'c', state });
    expect(location(res).searchParams.get('drive')).toBe('connected');
    await Promise.resolve(); await Promise.resolve();
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logger.error)).toHaveBeenCalled();
  });

  it('with no id_token the identity comes from userinfo (bearer = the access token)', async () => {
    const { state } = await startDrive();
    requirePerm.mockResolvedValueOnce(ADMIN);
    h.client.getToken.mockResolvedValueOnce({ tokens: { refresh_token: 'rt', access_token: 'at' } });
    fetchMock.mockResolvedValueOnce(userinfo({ email: FINANCE_DRIVE_ACCOUNT, email_verified: true }));
    const res = await callback({ code: 'c', state });
    expect(location(res).searchParams.get('drive')).toBe('connected');
    expect(fetchMock).toHaveBeenCalledWith('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: 'Bearer at' } });
    expect(h.client.verifyIdToken).not.toHaveBeenCalled();
    expect(upsert).toHaveBeenCalledWith({ email: FINANCE_DRIVE_ACCOUNT, refreshToken: 'rt', connectedBy: 'admin-1' });
  });

  it('userinfo that fails, is unverified, or names another account → revoked, nothing stored', async () => {
    const cases: Array<[Response, string]> = [
      [userinfo({ error: 'invalid_token' }, 401), 'no_email'],
      [userinfo({ email: FINANCE_DRIVE_ACCOUNT, email_verified: false }), 'no_email'],
      [userinfo({ email: 'r@bios.co.il', email_verified: true }), 'wrong_account'],
    ];
    for (const [response, reason] of cases) {
      const { state } = await startDrive();
      requirePerm.mockResolvedValueOnce(ADMIN);
      h.client.getToken.mockResolvedValueOnce({ tokens: { refresh_token: 'rt', access_token: 'at' } });
      fetchMock.mockResolvedValueOnce(response);
      expect(driveErrorReason(await callback({ code: 'c', state }))).toBe(reason);
    }
    expect(h.client.revokeToken).toHaveBeenCalledTimes(3);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('another Google account → nothing stored, grant revoked, reason=wrong_account', async () => {
    const { state, nonce } = await startDrive();
    requirePerm.mockResolvedValueOnce(ADMIN);
    googleReturns({ refresh_token: 'rt-2', access_token: 'at-2', id_token: 'idt' }, { email: 'r@bios.co.il', email_verified: true, nonce });

    const res = await callback({ code: 'c', state });
    expect(driveErrorReason(res)).toBe('wrong_account');
    expect(upsert).not.toHaveBeenCalled();
    expect(h.client.revokeToken).toHaveBeenCalledWith('rt-2');
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'drive_connect_rejected', metadata: { email: 'r@bios.co.il', reason: 'wrong_account' } }));
    expect(retry).not.toHaveBeenCalled();
    expect(mintSession).not.toHaveBeenCalled();
    expect(h.jar.has(DRIVE_NONCE_COOKIE)).toBe(false);
    expect(h.jar.has(DRIVE_VERIFIER_COOKIE)).toBe(false);
  });

  it('a revoke that fails does not change the rejection (best effort, logged)', async () => {
    const { state, nonce } = await startDrive();
    requirePerm.mockResolvedValueOnce(ADMIN);
    googleReturns({ refresh_token: 'rt', id_token: 'idt' }, { email: 'r@bios.co.il', email_verified: true, nonce });
    h.client.revokeToken.mockRejectedValueOnce(new Error('network'));
    expect(driveErrorReason(await callback({ code: 'c', state }))).toBe('wrong_account');
    expect(vi.mocked(logger.warn)).toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it('an unverified e-mail or a payload without one → revoked, reason=no_email', async () => {
    for (const payload of [{ email: FINANCE_DRIVE_ACCOUNT, email_verified: false }, {}]) {
      const { state, nonce } = await startDrive();
      requirePerm.mockResolvedValueOnce(ADMIN);
      googleReturns({ refresh_token: 'rt', id_token: 'idt' }, { ...payload, nonce });
      expect(driveErrorReason(await callback({ code: 'c', state }))).toBe('no_email');
    }
    expect(upsert).not.toHaveBeenCalled();
    expect(h.client.revokeToken).toHaveBeenCalledTimes(2);
  });

  it('a forged or tampered state never reaches the Drive branch (falls to the login path, which fails closed)', async () => {
    const { state } = await startDrive();
    const tampered = state.slice(0, 30) + (state[30] === 'A' ? 'B' : 'A') + state.slice(31);
    for (const bad of [tampered, b64url(48), 'finance_drive']) {
      expect(loginError(await callback({ code: 'c', state: bad }))).toBe('google_failed');
    }
    expect(rateLimit).toHaveBeenCalledTimes(3);       // charged to the login bucket like any bad login
    expect(requirePerm).toHaveBeenCalledTimes(1);     // only the /start call
    expect(h.client.getToken).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it('an expired state → reason=state, before any session lookup or exchange', async () => {
    const nonce = 'nonce-x';
    const state = sealDriveState({ uid: 'admin-1', nonce, now: Date.now() - (DRIVE_STATE_TTL_SEC + 5) * 1000 });
    h.jar.set(DRIVE_NONCE_COOKIE, nonce);
    h.jar.set(DRIVE_VERIFIER_COOKIE, 'v');
    expect(driveErrorReason(await callback({ code: 'c', state }))).toBe('state');
    expect(requirePerm).not.toHaveBeenCalled();
    expect(h.client.getToken).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
    expect(h.jar.has(DRIVE_NONCE_COOKIE)).toBe(false);
  });

  it('a nonce cookie that does not match the state (or is missing) → reason=state, before any session lookup', async () => {
    const { state } = await startDrive();
    h.jar.set(DRIVE_NONCE_COOKIE, 'someone-elses-nonce');
    expect(driveErrorReason(await callback({ code: 'c', state }))).toBe('state');
    h.jar.delete(DRIVE_NONCE_COOKIE);
    expect(driveErrorReason(await callback({ code: 'c', state }))).toBe('state');
    expect(requirePerm).toHaveBeenCalledTimes(1);     // only the /start call
    expect(h.client.getToken).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it('without an admin session → back to /login, nothing exchanged', async () => {
    const { state } = await startDrive();
    requirePerm.mockRejectedValueOnce(new AuthorizationError('לא מחובר', 401));
    expect(loginError(await callback({ code: 'c', state }))).toBeNull();
    expect(h.client.getToken).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
    expect(h.jar.has(DRIVE_NONCE_COOKIE)).toBe(false);
    expect(h.jar.has(DRIVE_VERIFIER_COOKIE)).toBe(false);
  });

  it('a session of a different user than the one who started → reason=session', async () => {
    const { state } = await startDrive(ADMIN);
    requirePerm.mockResolvedValueOnce(OTHER_ADMIN);
    expect(driveErrorReason(await callback({ code: 'c', state }))).toBe('session');
    expect(h.client.getToken).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it('Google OAuth unconfigured at return time → reason=unavailable', async () => {
    const { state } = await startDrive();
    requirePerm.mockResolvedValueOnce(ADMIN);
    googleConfig.mockReturnValueOnce(null);
    expect(driveErrorReason(await callback({ code: 'c', state }))).toBe('unavailable');
    expect(h.client.getToken).not.toHaveBeenCalled();
  });

  it('Google returned an error (consent denied) → reason=denied; a return with neither code nor error → reason=state', async () => {
    const a = await startDrive();
    requirePerm.mockResolvedValueOnce(ADMIN);
    expect(driveErrorReason(await callback({ state: a.state, error: 'access_denied' }))).toBe('denied');
    const b = await startDrive();
    requirePerm.mockResolvedValueOnce(ADMIN);
    expect(driveErrorReason(await callback({ state: b.state }))).toBe('state');
    expect(h.client.getToken).not.toHaveBeenCalled();
  });

  it('the right account but no refresh token → grant revoked, reason=no_refresh_token, nothing stored', async () => {
    const { state, nonce } = await startDrive();
    requirePerm.mockResolvedValueOnce(ADMIN);
    googleReturns({ access_token: 'at', id_token: 'idt' }, { email: FINANCE_DRIVE_ACCOUNT, email_verified: true, nonce });
    expect(driveErrorReason(await callback({ code: 'c', state }))).toBe('no_refresh_token');
    expect(h.client.revokeToken).toHaveBeenCalledWith('at');
    expect(upsert).not.toHaveBeenCalled();
    expect(retry).not.toHaveBeenCalled();
  });

  it('an id_token whose nonce is not the one we sent (or no payload at all) → reason=state, grant revoked', async () => {
    for (const payload of [{ email: FINANCE_DRIVE_ACCOUNT, email_verified: true, nonce: 'replayed' }, null]) {
      const { state } = await startDrive();
      requirePerm.mockResolvedValueOnce(ADMIN);
      googleReturns({ refresh_token: 'rt', id_token: 'idt' }, payload);
      expect(driveErrorReason(await callback({ code: 'c', state }))).toBe('state');
    }
    expect(h.client.revokeToken).toHaveBeenCalledTimes(2);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('a failed code exchange → reason=exchange; an id_token that fails verification → reason=exchange + revoke', async () => {
    const a = await startDrive();
    requirePerm.mockResolvedValueOnce(ADMIN);
    h.client.getToken.mockRejectedValueOnce(new Error('invalid_grant'));
    expect(driveErrorReason(await callback({ code: 'c', state: a.state }))).toBe('exchange');
    expect(h.client.revokeToken).not.toHaveBeenCalled();

    const b = await startDrive();
    requirePerm.mockResolvedValueOnce(ADMIN);
    h.client.getToken.mockResolvedValueOnce({ tokens: { refresh_token: 'rt', id_token: 'idt' } });
    h.client.verifyIdToken.mockRejectedValueOnce(new Error('bad signature'));
    expect(driveErrorReason(await callback({ code: 'c', state: b.state }))).toBe('exchange');
    expect(h.client.revokeToken).toHaveBeenCalledWith('rt');
    expect(upsert).not.toHaveBeenCalled();
  });
});
