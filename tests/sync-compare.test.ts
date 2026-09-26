import { describe, expect, it } from 'vitest';
import { compareSnapshots, isCompareUnavailable, sameValue, toNum, type CompareRow } from '@/lib/sync/bllinkCompare';
import { buildSnapshot, dedupeByApartment, mapSourceRow, toCompareMap, type SourceDebtorRecord } from '@/lib/sync/bllinkMap';

// The witness comparison and the shared mapper. Both sources of public.debtors
// (the CRM's debtor_records and billing's own bllink_scrape_rows) go through
// this code, so what these pin is "the switch changes where rows come from,
// never what is written".

const row = (over: Partial<CompareRow> = {}): CompareRow => ({
  total_debt: 100, monthly_debt: 80, special_debt: 20, management_months_raw: '07/26-09/26', notes: null, ...over,
});

const src = (over: Partial<SourceDebtorRecord> = {}): SourceDebtorRecord => ({
  apartment_number: '1035', owner_name: 'ישראל ישראלי', phone_primary: '0501234567',
  total_debt: 100, monthly_debt: 80, special_debt: 20, management_months_raw: '07/26-09/26', notes: null, ...over,
});

describe('sameValue', () => {
  it('money within half an agora is the same; beyond it is a difference', () => {
    expect(sameValue('total_debt', 100, 100.004)).toBe(true);
    expect(sameValue('total_debt', 100, 100.01)).toBe(false);
  });
  it('text is compared trimmed, with null and empty equal', () => {
    expect(sameValue('notes', null, '')).toBe(true);
    expect(sameValue('notes', ' a ', 'a')).toBe(true);
    expect(sameValue('management_months_raw', '07/26', '08/26')).toBe(false);
  });
  it('toNum accepts the string pg returns for numeric, and 0 for anything else', () => {
    expect(toNum('12.50')).toBe(12.5);
    expect(toNum(3)).toBe(3);
    expect(toNum(null)).toBe(0);
    expect(toNum('abc')).toBe(0);
    expect(toNum(Number.NaN)).toBe(0);
  });
});

describe('compareSnapshots', () => {
  it('two identical snapshots agree: 0 diffs, dated by the CRM, signed by whoever compared', () => {
    const local = new Map([['1', row()], ['2', row({ total_debt: 5, monthly_debt: 5, special_debt: 0 })]]);
    const crm = new Map([['1', row()], ['2', row({ total_debt: 5, monthly_debt: 5, special_debt: 0 })]]);
    const s = compareSnapshots(local, crm, { crmSnapshotAt: '2026-09-26T03:00:37Z', comparedBy: 'sync', now: new Date('2026-09-26T03:01:00Z') });
    expect(s.diff_count).toBe(0);
    expect(s.local_rows).toBe(2);
    expect(s.crm_rows).toBe(2);
    expect(s.crm_snapshot_at).toBe('2026-09-26T03:00:37Z');
    expect(s.compared_by).toBe('sync');
    expect(s.compared_at).toBe('2026-09-26T03:01:00.000Z');
    expect(s.parse_skipped).toBe(0);
  });
  it('counts missing (CRM only), extra (local only) and per-field diffs, sorted', () => {
    const local = new Map([['1', row()], ['3', row()], ['2', row({ special_debt: 0, total_debt: 80 })]]);
    const crm = new Map([['1', row()], ['2', row()], ['9', row()]]);
    const s = compareSnapshots(local, crm, { crmSnapshotAt: null, comparedBy: 'scrape', parseSkipped: 2 });
    expect(s.missing).toEqual(['9']);
    expect(s.extra).toEqual(['3']);
    expect(s.diffs).toEqual([
      { apt: '2', field: 'total_debt', crm: 100, local: 80 },
      { apt: '2', field: 'special_debt', crm: 20, local: 0 },
    ]);
    expect(s.diff_count).toBe(4);
    expect(s.parse_skipped).toBe(2);
  });
  it('isCompareUnavailable tells the warning apart from a summary', () => {
    expect(isCompareUnavailable({ compare: 'unavailable', reason: 'x', local_rows: 1, compared_by: 'sync', compared_at: 't' })).toBe(true);
    expect(isCompareUnavailable(compareSnapshots(new Map(), new Map(), { crmSnapshotAt: null, comparedBy: 'sync' }))).toBe(false);
    expect(isCompareUnavailable(null)).toBe(false);
  });
});

describe('mapSourceRow — the write is rebuilt from the components, identically for both sources', () => {
  it('E → management_fees, G → hot_water_debt, F → monthly_debt text, H → details, total RECOMPUTED', () => {
    const m = mapSourceRow(src({ total_debt: 999, notes: ' בהסדר ' }));
    expect(m).toEqual({
      apartment_number: '1035', owner_name: 'ישראל ישראלי', phone_owner: '0501234567', phone_tenant: null,
      total_debt: 100, management_fees: 80, monthly_debt: '07/26-09/26', hot_water_debt: 20, details: 'בהסדר',
    });
  });
  it('accepts pg numeric strings (bllink_scrape_rows) exactly like JSON numbers (debtor_records)', () => {
    const fromPg = mapSourceRow(src({ total_debt: '100.00', monthly_debt: '80.00', special_debt: '20.00' }));
    const fromRest = mapSourceRow(src());
    expect(fromPg).toEqual(fromRest);
  });
  it('drops an apartment-less row and treats missing money as 0', () => {
    expect(mapSourceRow(src({ apartment_number: '  ' }))).toBeNull();
    const m = mapSourceRow(src({ monthly_debt: null, special_debt: null }));
    expect(m?.total_debt).toBe(0);
    expect(m?.management_fees).toBe(0);
    expect(m?.hot_water_debt).toBe(0);
  });
});

describe('buildSnapshot / dedupe', () => {
  it('last occurrence of a trimmed apartment wins', () => {
    const d = dedupeByApartment([src({ apartment_number: '7', notes: 'first' }), src({ apartment_number: ' 7 ', notes: 'last' }), src({ apartment_number: null })]);
    expect([...d.keys()]).toEqual(['7']);
    expect(d.get('7')?.notes).toBe('last');
  });
  it('reports Σ source total (D) against Σ components, dates the snapshot, and builds the compare rows', () => {
    const snap = buildSnapshot(
      [src({ apartment_number: '1' }), src({ apartment_number: '2', total_debt: '50.5', monthly_debt: '50.5', special_debt: '0' })],
      { minAt: '2026-09-26T02:30:00Z', maxAt: '2026-09-26T02:30:40Z' },
    );
    expect(snap.rows.map((r) => r.apartment_number)).toEqual(['1', '2']);
    expect(snap.report).toEqual({ count: 2, rawTotal: 150.5, componentTotal: 150.5, runMinAt: '2026-09-26T02:30:00Z', runMaxAt: '2026-09-26T02:30:40Z' });
    expect(snap.compareRows.get('2')).toEqual({ total_debt: 50.5, monthly_debt: 50.5, special_debt: 0, management_months_raw: '07/26-09/26', notes: null });
  });
  it('toCompareMap gives the same rows the snapshot does', () => {
    const records = [src({ apartment_number: '1' }), src({ apartment_number: '2', special_debt: 0, total_debt: 80 })];
    expect(toCompareMap(records)).toEqual(buildSnapshot(records, { minAt: null, maxAt: null }).compareRows);
  });
});
