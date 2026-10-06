import { beforeEach, describe, expect, it, vi } from 'vitest';

// GET /api/portal/finance/categories/[id]/monthly — the category trend of the
// transactions tab (06/10/2026), exercised through the REAL guard chain:
// requirePortalFinanceAccess → requirePortalSession → getPortalSession → the
// cookie → findPortalSession → isActiveOwner, then the real
// resolvePortalIdentity over a mocked query(). Only the cookie store, the
// session row and the SQL results are fakes.
//
// What is locked here (the database side — only published months, at most 12,
// the sums — is tests/portal-category-trend-db.test.ts):
//   • no session / an unknown session → 401, and no finance SQL runs at all;
//   • not a UUID, an unknown id and a renovation-fund category → one 404;
//   • the answer is `{ months: [{ month, total }] }` in whole shekels — the
//     exact sum rounded once — and nothing else;
//   • the window is built from published rows IN THE SQL.

const PHONE = '+972521234567';
const CAT = '3f1c2a4e-8b7d-4c6a-9e2f-1a2b3c4d5e6f';
const FUND_CAT = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

const h = vi.hoisted(() => ({
  cookie: 'good-token' as string | null,
  financeSql: [] as string[],
  windowParams: [] as unknown[],
  window: [] as Array<{ month: string; total: number }>,
}));

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (name === 'portal_session' && h.cookie ? { name, value: h.cookie } : undefined),
    set: vi.fn(),
    delete: vi.fn(),
  }),
}));
vi.mock('@/lib/db/portal/sessions', () => ({
  findPortalSession: vi.fn(async (token: string) => (token === 'good-token' ? { id: 's1', phoneE164: PHONE } : null)),
  revokePortalSessionsForPhone: vi.fn(),
  revokePortalSession: vi.fn(),
  createPortalSessionRow: vi.fn(),
}));
vi.mock('@/lib/db/portal/ownerPhones', () => ({ isActiveOwner: vi.fn(async () => true) }));
vi.mock('@/lib/db/portal/events', () => ({ logPortalEvent: vi.fn() }));
vi.mock('@/lib/db', () => ({
  query: vi.fn(async (sql: string, params: unknown[] = []) => {
    // The identity's roster read — one owner, one apartment, so the phone is
    // never "blocked" and the guard passes on its own terms.
    if (/from public\.apartment_owner_phones/.test(sql)) {
      return { rows: [{ id: 'r0', role: 'owner', apartment_number: '7', owner_name: 'דנה לוי' }], rowCount: 1 };
    }
    if (/public\.fin_|finance_month_status/.test(sql)) {
      h.financeSql.push(sql);
      h.windowParams = params;
      return { rows: h.window, rowCount: h.window.length };
    }
    return { rows: [], rowCount: 0 };
  }),
  queryOne: vi.fn(async (sql: string, params: unknown[]) => {
    if (/public\.fin_categories/.test(sql)) {
      h.financeSql.push(sql);
      // Only an OPERATING category is found — and only because the SQL asks
      // for the section; a fund category's id answers like an unknown one.
      const operatingOnly = /section = 'operating'/.test(sql);
      if (params[0] === CAT) return { id: CAT };
      if (params[0] === FUND_CAT && !operatingOnly) return { id: FUND_CAT };
      return null;
    }
    return null;
  }),
}));

import { GET } from '@/app/api/portal/finance/categories/[id]/monthly/route';

function call(id: string) {
  return GET(new Request(`http://localhost/api/portal/finance/categories/${id}/monthly`), { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  h.cookie = 'good-token';
  h.financeSql = [];
  h.windowParams = [];
  h.window = [];
});

describe('the category trend route — guard', () => {
  it('no portal session → 401, and no finance query runs', async () => {
    h.cookie = null;
    const res = await call(CAT);
    expect(res.status).toBe(401);
    expect(h.financeSql).toEqual([]);
  });

  it('an unknown session token → 401', async () => {
    h.cookie = 'forged-token';
    const res = await call(CAT);
    expect(res.status).toBe(401);
    expect(h.financeSql).toEqual([]);
  });
});

describe('the category trend route — which category', () => {
  it('not a UUID → 404 without touching the database', async () => {
    for (const id of ['nope', '1', "x' or '1'='1", '../../etc']) {
      const res = await call(id);
      expect(res.status, id).toBe(404);
    }
    expect(h.financeSql).toEqual([]);
  });

  it('an unknown category → 404', async () => {
    const res = await call('00000000-0000-4000-8000-000000000000');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'הסעיף לא נמצא' });
  });

  it('a renovation-fund category is not on that tab → the same 404', async () => {
    const res = await call(FUND_CAT);
    expect(res.status).toBe(404);
  });
});

describe('the category trend route — the answer', () => {
  it('months oldest first, whole shekels rounded from the exact sum, zeros kept, nothing else', async () => {
    h.window = [
      { month: '2026-07', total: 300.55 },
      { month: '2026-08', total: 0 },
      { month: '2026-09', total: 1800.5 },
    ];
    const res = await call(CAT);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      months: [
        { month: '2026-07', total: 301 },
        { month: '2026-08', total: 0 },
        { month: '2026-09', total: 1801 },
      ],
    });
  });

  it('builds its window from published months in the SQL, capped at 12, never past the current month', async () => {
    await call(CAT);
    const windowSql = h.financeSql.find((s) => /finance_month_status/.test(s));
    expect(windowSql).toBeDefined();
    expect(windowSql).toMatch(/where s\.published/);
    expect(windowSql).toMatch(/limit \$3/);
    expect(windowSql).toMatch(/<= \$2::date/);
    expect(h.windowParams[0]).toBe(CAT);
    expect(h.windowParams[1]).toMatch(/^\d{4}-\d{2}-01$/);
    expect(h.windowParams[2]).toBe(12);
    // a line reaches the answer only through the window, and a deleted line never
    expect(windowSql).toMatch(/from win w\s+left join public\.fin_entries e/);
    expect(windowSql).toMatch(/e\.deleted_at is null/);
  });
});
