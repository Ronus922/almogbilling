import { beforeEach, describe, expect, it, vi } from 'vitest';

// Containment (03/10/2026): a phone whose apartments belong to different
// people gets NO financial data from the portal API. Exercised through the
// REAL guard chain — requirePortalFinanceAccess → requirePortalSession →
// getPortalSession → the cookie → findPortalSession → isActiveOwner — and the
// REAL identity (resolvePortalIdentity, getPortalMyAccount) over a mocked
// query(): only the cookie store, the session row and the SQL results are
// fakes. The finance layer returns canaries, so a leak would show in the body.

const PHONE = '+972521234567';

type RosterRow = { apartment_number: string; owner_name: string | null };

const h = vi.hoisted(() => ({
  cookie: 'good-token' as string | null,
  roster: [] as RosterRow[],
  debtSql: 0,
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
vi.mock('@/lib/db/portal/events', () => ({ logPortalEvent: vi.fn() }));
vi.mock('@/lib/db', () => ({
  query: vi.fn(async (sql: string) => {
    // The identity reads each link with its id and role (owner here).
    if (/from public\.apartment_owner_phones/.test(sql)) {
      return { rows: h.roster.map((r, i) => ({ id: `r${i}`, role: 'owner', ...r })), rowCount: h.roster.length };
    }
    if (/from public\.debtors/.test(sql)) {
      h.debtSql += 1;
      return {
        rows: h.roster.map((r) => ({
          apartment_number: r.apartment_number, total_debt: 4321, management_fees: 4321, hot_water_debt: 0,
          monthly_debt: 'CANARY-MONTHLY', details: 'CANARY-DETAILS',
        })),
        rowCount: h.roster.length,
      };
    }
    return { rows: [], rowCount: 0 };
  }),
  queryOne: vi.fn(async (sql: string) => {
    if (/from public\.apartment_owner_phones/.test(sql)) return h.roster.length ? { n: 1 } : null;
    return null;
  }),
}));
vi.mock('@/lib/db/finance/portal', () => ({
  getPublishedMonths: vi.fn(async () => [{ year: 2026, month: 8 }]),
  getResidentMonthData: vi.fn(async () => ({ canary: 'CANARY-MONTH' })),
  getPeriodReport: vi.fn(async () => ({ canary: 'CANARY-REPORT' })),
  getResidentFundKpis: vi.fn(async () => ({ canary: 'CANARY-FUND' })),
}));

import { GET as monthsGET } from '@/app/api/portal/finance/months/route';
import { GET as periodGET } from '@/app/api/portal/finance/period/route';
import { getPortalMyAccount } from '@/lib/db/portal/account';
import { getPeriodReport, getPublishedMonths, getResidentFundKpis, getResidentMonthData } from '@/lib/db/finance/portal';
import { PORTAL_ACCOUNT_REVIEW_MESSAGE } from '@/lib/portal/ownership';

const MIXED: RosterRow[] = [
  { apartment_number: '1210', owner_name: 'רונן משולם' },
  { apartment_number: '1237', owner_name: "אלי אברג'יל" },
  { apartment_number: '520', owner_name: 'טלי אראל' },
];
const ONE_PERSON: RosterRow[] = [
  { apartment_number: '1210', owner_name: 'רונן משולם' },
  { apartment_number: '1237', owner_name: ' רונן  משולם' },
];

beforeEach(() => {
  vi.clearAllMocks();
  h.cookie = 'good-token';
  h.debtSql = 0;
});

describe('portal finance API — a phone with apartments of two different people', () => {
  beforeEach(() => { h.roster = MIXED; });

  it('GET /api/portal/finance/months → 403 with the notice, no month read', async () => {
    const res = await monthsGET();
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toEqual({ error: PORTAL_ACCOUNT_REVIEW_MESSAGE });
    expect(getPublishedMonths).not.toHaveBeenCalled();
  });

  it('GET /api/portal/finance/period (both tabs) → 403, no figure read, no canary in the body', async () => {
    for (const tab of ['operating', 'fund']) {
      const res = await periodGET(new Request(`http://x/api/portal/finance/period?tab=${tab}&m=2026-08`));
      expect(res.status).toBe(403);
      expect(await res.text()).not.toContain('CANARY');
    }
    for (const fn of [getPublishedMonths, getResidentMonthData, getPeriodReport, getResidentFundKpis]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });

  it('getPortalMyAccount → [] and the debtors table is never read', async () => {
    expect(await getPortalMyAccount({ id: 's1', phoneE164: PHONE })).toEqual([]);
    expect(h.debtSql).toBe(0);
  });

  it('a nameless second apartment is treated the same way', async () => {
    h.roster = [{ apartment_number: '1323', owner_name: null }, { apartment_number: '1324', owner_name: 'שפייזר אייל' }];
    expect((await monthsGET()).status).toBe(403);
    expect(await getPortalMyAccount({ id: 's1', phoneE164: PHONE })).toEqual([]);
  });

  it('no session → 401 before any roster check', async () => {
    h.cookie = null;
    expect((await monthsGET()).status).toBe(401);
  });
});

describe('portal finance API — several apartments of ONE person', () => {
  beforeEach(() => { h.roster = ONE_PERSON; });

  it('months and period answer 200 with the data', async () => {
    const months = await monthsGET();
    expect(months.status).toBe(200);
    expect(await months.json()).toEqual({ months: ['2026-08'] });
    const period = await periodGET(new Request('http://x/api/portal/finance/period?tab=operating&m=2026-08'));
    expect(period.status).toBe(200);
    expect(await period.text()).toContain('CANARY-MONTH');
  });

  it('getPortalMyAccount → one account per apartment, all of them', async () => {
    const acc = await getPortalMyAccount({ id: 's1', phoneE164: PHONE });
    expect(acc.map((a) => a.apartment_number)).toEqual(['1210', '1237']);
    expect(acc.every((a) => a.total_debt === 4321)).toBe(true);
  });

  it('a single apartment is never blocked', async () => {
    h.roster = [{ apartment_number: '520', owner_name: 'טלי אראל' }];
    expect((await monthsGET()).status).toBe(200);
    expect(await getPortalMyAccount({ id: 's1', phoneE164: PHONE })).toHaveLength(1);
  });
});
