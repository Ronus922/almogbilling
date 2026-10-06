import { describe, expect, it } from 'vitest';
import { toNum } from '@/lib/sync/bllinkCompare';
import { buildSnapshot, dedupeByApartment, mapSourceRow, type SourceDebtorRecord } from '@/lib/sync/bllinkMap';

// The mapper from a Bllink snapshot row (billing's bllink_scrape_rows, in the
// CRM's old debtor_records naming) to what the sync writes. Until 06/10/2026
// this file also pinned the apartment-by-apartment comparison with the CRM;
// the CRM was torn down that day and the comparison went with it.

const src = (over: Partial<SourceDebtorRecord> = {}): SourceDebtorRecord => ({
  apartment_number: '1035', owner_name: 'ישראל ישראלי', phone_primary: '0501234567',
  total_debt: 100, monthly_debt: 80, special_debt: 20, management_months_raw: '07/26-09/26', notes: null, ...over,
});

describe('toNum', () => {
  it('accepts the string pg returns for numeric, and 0 for anything else', () => {
    expect(toNum('12.50')).toBe(12.5);
    expect(toNum(3)).toBe(3);
    expect(toNum(null)).toBe(0);
    expect(toNum('abc')).toBe(0);
    expect(toNum(Number.NaN)).toBe(0);
  });
});

describe('mapSourceRow — the write is rebuilt from the components', () => {
  it('E → management_fees, G → hot_water_debt, F → monthly_debt text, H → details, total RECOMPUTED', () => {
    const m = mapSourceRow(src({ total_debt: 999, notes: ' בהסדר ' }));
    expect(m).toEqual({
      apartment_number: '1035', owner_name: 'ישראל ישראלי', tenant_name: null,
      // Nothing from the resident list on this record, so both names fall
      // back to the export's labelled cell — and a fallback name may fill but
      // may not ask.
      owner_name_from_list: false, tenant_name_from_list: false,
      phone_owner: '0501234567', phone_tenant: null,
      owner_email: null, tenant_email: null,
      total_debt: 100, management_fees: 80, monthly_debt: '07/26-09/26', hot_water_debt: 20, details: 'בהסדר',
    });
  });
  it('accepts pg numeric strings (bllink_scrape_rows) exactly like plain numbers', () => {
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
  it('reports Σ source total (D) against Σ components and dates the snapshot', () => {
    const snap = buildSnapshot(
      [src({ apartment_number: '1' }), src({ apartment_number: '2', total_debt: '50.5', monthly_debt: '50.5', special_debt: '0' })],
      { minAt: '2026-09-26T02:30:00Z', maxAt: '2026-09-26T02:30:40Z' },
    );
    expect(snap.rows.map((r) => r.apartment_number)).toEqual(['1', '2']);
    expect(snap.report).toEqual({ count: 2, rawTotal: 150.5, componentTotal: 150.5, runMinAt: '2026-09-26T02:30:00Z', runMaxAt: '2026-09-26T02:30:40Z' });
  });
});
