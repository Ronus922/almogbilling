import { beforeEach, describe, expect, it, vi } from 'vitest';

// Access (03/10/2026, "פורטל לפי תפקיד"; simplified 17/10/2026, "פישוט גישת
// פורטל"): every ACTIVE roster link opens the portal and its finance data,
// whatever the names on the other apartments of the same phone say — there
// is no more "contained" phone and no more approval gate. Exercised through
// the REAL guard chain — requirePortalFinanceAccess → requirePortalSession →
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
import { resolvePortalIdentity } from '@/lib/db/portal/identity';
import { getPeriodReport, getPublishedMonths, getResidentFundKpis, getResidentMonthData } from '@/lib/db/finance/portal';

const DIFFERENT_NAMES: RosterRow[] = [
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

describe('portal finance API — one phone, several apartments, DIFFERENT names (never withheld since 17/10/2026)', () => {
  beforeEach(() => { h.roster = DIFFERENT_NAMES; });

  it('GET /api/portal/finance/months → 200, every month read normally', async () => {
    const res = await monthsGET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ months: ['2026-08'] });
    expect(getPublishedMonths).toHaveBeenCalled();
  });

  it('GET /api/portal/finance/period (both tabs) → 200, with the canary figures', async () => {
    const res1 = await periodGET(new Request(`http://x/api/portal/finance/period?tab=operating&m=2026-08`));
    expect(res1.status).toBe(200);
    expect(await res1.text()).toContain('CANARY-MONTH');
    expect(getResidentMonthData).toHaveBeenCalled();

    const res2 = await periodGET(new Request(`http://x/api/portal/finance/period?tab=fund&m=2026-08`));
    expect(res2.status).toBe(200);
    expect(await res2.text()).toContain('CANARY-FUND');
    expect(getResidentFundKpis).toHaveBeenCalled();
  });

  it('GET /api/portal/finance/period?tab=operating&m=2026-Q3 (a period report) → 200, with the canary figure', async () => {
    const res = await periodGET(new Request('http://x/api/portal/finance/period?tab=operating&m=2026-Q3'));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('CANARY-REPORT');
    expect(getPeriodReport).toHaveBeenCalled();
  });

  it('getPortalMyAccount → one account per apartment, named from the first one (by number) that carries one', async () => {
    const acc = await getPortalMyAccount({ id: 's1', phoneE164: PHONE });
    expect(acc.map((a) => a.apartment_number)).toEqual(['520', '1210', '1237']);
    expect(acc.every((a) => a.total_debt === 4321)).toBe(true);
    expect(h.debtSql).toBeGreaterThan(0);
    expect(acc.every((a) => a.owner_display_name === 'טלי אראל')).toBe(true);
    expect(await resolvePortalIdentity(PHONE)).toMatchObject({ name: 'טלי אראל' });
  });

  it('a nameless apartment among them is treated the same way — every apartment still opens', async () => {
    h.roster = [{ apartment_number: '1323', owner_name: null }, { apartment_number: '1324', owner_name: 'שפייזר אייל' }];
    expect((await monthsGET()).status).toBe(200);
    const acc = await getPortalMyAccount({ id: 's1', phoneE164: PHONE });
    expect(acc.map((a) => a.apartment_number)).toEqual(['1323', '1324']);
  });

  it('no session → 401 before any roster check', async () => {
    h.cookie = null;
    expect((await monthsGET()).status).toBe(401);
  });

  it('no active roster link at all → the session itself is revoked (401), no figure read', async () => {
    // isActiveOwner (the session guard) finds nothing first, so this never
    // reaches the identity check at all — requirePortalSession() already
    // throws 401 before requirePortalFinanceAccess() gets a phone to resolve.
    h.roster = [];
    const res = await monthsGET();
    expect(res.status).toBe(401);
    expect(getPublishedMonths).not.toHaveBeenCalled();
    expect(await getPortalMyAccount({ id: 's1', phoneE164: PHONE })).toEqual([]);
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

  it('a single apartment opens exactly the same way', async () => {
    h.roster = [{ apartment_number: '520', owner_name: 'טלי אראל' }];
    expect((await monthsGET()).status).toBe(200);
    expect(await getPortalMyAccount({ id: 's1', phoneE164: PHONE })).toHaveLength(1);
  });
});
