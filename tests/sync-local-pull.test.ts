import { beforeEach, describe, expect, it, vi } from 'vitest';

// BLLINK_SOURCE=billing reads billing's own newest successful scrape. Mock the
// DB layer and pin: which scrape is chosen, how the snapshot is dated, and that
// the rows go through the shared mapper unchanged.
vi.mock('@/lib/db', () => ({ query: vi.fn(), queryOne: vi.fn() }));

import { query, queryOne } from '@/lib/db';
import { fetchLocalDebtorRows, recordWitnessCompare } from '@/lib/sync/localPull';

const mQuery = query as unknown as ReturnType<typeof vi.fn>;
const mQueryOne = queryOne as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mQuery.mockReset();
  mQueryOne.mockReset();
});

describe('fetchLocalDebtorRows', () => {
  it('returns null (and reads no rows) when no scrape ever succeeded', async () => {
    mQueryOne.mockResolvedValue(null);
    expect(await fetchLocalDebtorRows()).toBeNull();
    expect(mQueryOne.mock.calls[0][0]).toMatch(/status = 'success'/);
    expect(mQueryOne.mock.calls[0][0]).toMatch(/order by finished_at desc/);
    expect(mQuery).not.toHaveBeenCalled();
  });

  it('dates the snapshot by the scrape\'s finished_at and maps its rows through the shared mapper', async () => {
    mQueryOne.mockResolvedValue({ id: 'scrape-1', finished_at: new Date('2026-09-26T02:30:40.500Z') });
    mQuery.mockResolvedValue({
      rows: [
        { apartment_number: '1035', owner_name: 'א', phone_primary: '0501234567', total_debt: '261.00', monthly_debt: '0.00', special_debt: '261.00', management_months_raw: null, notes: 'מים חמים' },
        { apartment_number: '2001', owner_name: 'ב', phone_primary: null, total_debt: '1500.00', monthly_debt: '1500.00', special_debt: '0.00', management_months_raw: '07/26-09/26', notes: null },
      ],
    });
    const snap = await fetchLocalDebtorRows();
    expect(snap?.scrapeId).toBe('scrape-1');
    expect(snap?.finishedAt).toBe('2026-09-26T02:30:40.500Z');
    expect(mQuery.mock.calls[0][0]).toMatch(/from public\.bllink_scrape_rows/);
    expect(mQuery.mock.calls[0][1]).toEqual(['scrape-1']);
    expect(snap?.report).toEqual({
      count: 2, rawTotal: 1761, componentTotal: 1761,
      runMinAt: '2026-09-26T02:30:40.500Z', runMaxAt: '2026-09-26T02:30:40.500Z',
    });
    expect(snap?.rows).toEqual([
      { apartment_number: '1035', owner_name: 'א', phone_owner: '0501234567', phone_tenant: null, total_debt: 261, management_fees: 0, monthly_debt: null, hot_water_debt: 261, details: 'מים חמים' },
      { apartment_number: '2001', owner_name: 'ב', phone_owner: null, phone_tenant: null, total_debt: 1500, management_fees: 1500, monthly_debt: '07/26-09/26', hot_water_debt: 0, details: null },
    ]);
    expect(snap?.compareRows.get('1035')).toEqual({ total_debt: 261, monthly_debt: 0, special_debt: 261, management_months_raw: null, notes: 'מים חמים' });
  });
});

describe('recordWitnessCompare', () => {
  it('stores the result as jsonb on the scrape row it copied', async () => {
    mQuery.mockResolvedValue({ rows: [] });
    const result = { compare: 'unavailable' as const, reason: 'CRM down', local_rows: 224, compared_by: 'sync' as const, compared_at: '2026-09-26T03:00:00Z' };
    await recordWitnessCompare('scrape-1', result);
    const [sql, params] = mQuery.mock.calls[0];
    expect(sql).toMatch(/update public\.bllink_scrapes set compare_summary = \$2::jsonb where id = \$1/);
    expect(params).toEqual(['scrape-1', JSON.stringify(result)]);
  });
});
