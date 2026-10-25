import { describe, expect, it } from 'vitest';
import { cheapestLineIndex, comparisonOf, formatStampShortIL, withVat } from '@/lib/purchasing/model';

const lines = [
  { id: 'l1', description: 'א', quantity: 1 },
  { id: 'l2', description: 'ב', quantity: 2 },
];
const q = (key: string, p1: number, p2: number) => ({
  supplier_id: null, manual_key: key, supplier_name: key, prices: { l1: p1, l2: p2 }, total_amount: null,
});

describe('comparison helpers', () => {
  it('flags the cheapest total and the cheapest cell of each row (ties: all)', () => {
    const cols = comparisonOf(lines, [q('maaaaaa', 500, 300), q('mbbbbbb', 450, 300), q('mcccccc', 520, 290)]);
    expect(cols.map((c) => c.total)).toEqual([1100, 1050, 1100]);
    expect(cols.map((c) => c.cheapest)).toEqual([false, true, false]);
    expect(cheapestLineIndex(cols, 0)).toEqual([1]);
    expect(cheapestLineIndex(cols, 1)).toEqual([2]);
    const tie = comparisonOf(lines, [q('maaaaaa', 100, 100), q('mbbbbbb', 100, 100)]);
    expect(cheapestLineIndex(tie, 0)).toEqual([0, 1]);
    expect(tie.map((c) => c.cheapest)).toEqual([true, true]);
  });

  it('a single offer is not the cheapest of anything', () => {
    const cols = comparisonOf(lines, [q('maaaaaa', 1, 1)]);
    expect(cols[0].cheapest).toBe(false);
  });

  it('computes the VAT of a subtotal to the agora', () => {
    expect(withVat(2000, 18)).toEqual({ vat: 360, total: 2360 });
    expect(withVat(2160, 18)).toEqual({ vat: 388.8, total: 2548.8 });
  });

  it('formats a short Israel-time stamp', () => {
    expect(formatStampShortIL('2026-07-25T19:19:00Z')).toBe('25/07 22:19');
    expect(formatStampShortIL(null)).toBe('');
  });
});
