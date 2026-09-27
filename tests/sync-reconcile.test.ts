import { describe, expect, it } from 'vitest';
import {
  listApartments,
  reconcileAfterWrite,
  snapshotTotals,
  type CategoryTotals,
  type DebtorsAfterWrite,
} from '@/lib/sync/reconcile';

// Post-write reconciliation (27/09/2026). The pre-write guards only see the
// snapshot; this is the check that catches what actually landed in debtors —
// above all the case of that day: an apartment that paid, vanished from the
// Bllink report, and was still carrying its debt in debtors.
type AfterOverrides = Omit<Partial<DebtorsAfterWrite>, 'totals'> & { totals?: Partial<CategoryTotals> };
function after(over: AfterOverrides = {}): DebtorsAfterWrite {
  return {
    totals: { management: 335874.5, hotWater: 72558, ...over.totals },
    leftovers: over.leftovers ?? [],
    unwritten: over.unwritten ?? [],
    mismatched: over.mismatched ?? [],
    archivedLeftovers: over.archivedLeftovers ?? [],
  };
}
const EXPECTED: CategoryTotals = { management: 335874.5, hotWater: 72558 };

describe('snapshotTotals — what the merge was asked to write, per category', () => {
  it('sums management fees and hot water separately, rounded to agorot', () => {
    const t = snapshotTotals([
      { management_fees: 9810, hot_water_debt: 190 },
      { management_fees: 2700, hot_water_debt: 154 },
      { management_fees: 0, hot_water_debt: 205 },
    ]);
    expect(t).toEqual({ management: 12510, hotWater: 549 });
  });
  it('does not let float noise through (0.1 + 0.2)', () => {
    expect(snapshotTotals([{ management_fees: 0.1, hot_water_debt: 0 }, { management_fees: 0.2, hot_water_debt: 0 }]).management).toBe(0.3);
  });
  it('an empty report sums to zero — every non-archived apartment is expected at 0', () => {
    expect(snapshotTotals([])).toEqual({ management: 0, hotWater: 0 });
  });
});

describe('reconcileAfterWrite — passes', () => {
  it('equal sums, no lists → ok, no warning', () => {
    expect(reconcileAfterWrite(EXPECTED, after())).toEqual({ ok: true, warning: null });
  });
  it('float noise below an agora is not a gap', () => {
    const r = reconcileAfterWrite(EXPECTED, after({ totals: { management: 335874.50000000006, hotWater: 72557.99999999999 } }));
    expect(r.ok).toBe(true);
  });
  it('an archived apartment the report dropped is a warning, never a failure (outside the write scope)', () => {
    const r = reconcileAfterWrite(EXPECTED, after({ archivedLeftovers: ['1518'] }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.warning).toContain('1518');
      expect(r.warning).toContain('מאורכבות');
    }
  });
});

describe('reconcileAfterWrite — fails', () => {
  it("THE 27/09 CASE: a paid apartment's debt was not zeroed → leftover, named, category gap shown", () => {
    // 1421 paid 10,000 (9,810 management + 190 hot water) and vanished from the
    // report; debtors still carried it.
    const r = reconcileAfterWrite(
      EXPECTED,
      after({ totals: { management: 335874.5 + 9810, hotWater: 72558 + 190 }, leftovers: ['1421'] }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain('1421');
      expect(r.message).toContain('לא אופסו');
      expect(r.message).toContain('דמי ניהול: דוח 335,874.50 ₪, נכתב 345,684.50 ₪ (פער 9,810.00 ₪)');
      expect(r.message).toContain('מים חמים: דוח 72,558.00 ₪, נכתב 72,748.00 ₪ (פער 190.00 ₪)');
      // Honest about the state: data WAS written.
      expect(r.message).toContain('הכתיבה בוצעה');
      expect(r.message).not.toContain('לא הועתק דבר');
    }
  });
  it('a single agora in one category is a gap; the matching category says so', () => {
    const r = reconcileAfterWrite(EXPECTED, after({ totals: { management: 335874.51 } }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain('דמי ניהול: דוח 335,874.50 ₪, נכתב 335,874.51 ₪ (פער 0.01 ₪)');
      expect(r.message).toContain('מים חמים: 72,558.00 ₪ (תואם)');
    }
  });
  it('offsetting per-apartment errors (+100 / −100) leave the sums equal but still fail', () => {
    const r = reconcileAfterWrite(EXPECTED, after({ mismatched: ['913', '914'] }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain('נכתבו בסכום שונה (2): 913, 914');
      expect(r.message).toContain('(תואם)');
    }
  });
  it('a report apartment with no debtors row at all (insert did not happen)', () => {
    const r = reconcileAfterWrite(EXPECTED, after({ totals: { management: 335874.5 - 176 }, unwritten: ['2011'] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('חסרות ב-debtors (1): 2011');
  });
  it('lists that are empty are not mentioned; the archived warning does not appear in the failure text', () => {
    const r = reconcileAfterWrite(EXPECTED, after({ leftovers: ['737'], archivedLeftovers: ['1518'] }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).not.toContain('נכתבו בסכום שונה');
      expect(r.message).not.toContain('חסרות ב-debtors');
      expect(r.message).not.toContain('1518');
    }
  });
});

describe('listApartments — stays readable when a whole zero-out is missing', () => {
  it('lists up to 10 apartments, then "ועוד N"', () => {
    const apts = Array.from({ length: 12 }, (_, i) => String(1000 + i));
    expect(listApartments(apts)).toBe('1000, 1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008, 1009 ועוד 2');
    expect(listApartments(['1', '2'])).toBe('1, 2');
  });
});
