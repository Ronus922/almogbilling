import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import type { ChipOrderRow } from '@/lib/chipOrders/model';
import {
  CHIP_ORDER_EXPORT_COLUMNS, chipOrderRowAction, chipOrderRowPeople, chipOrderRowStatusText, filterChipOrderRows,
  formatOrderDate, formatOrderDateTime, missingChipsText, searchHitPeople, summarizeChipOrders,
} from '@/lib/chipOrders/orderRows';
import { CHIP_ORDER_MONEY_FMT, buildChipOrdersWorkbook } from '@/lib/export/chip-orders-export';

// The Orders tab of /chips (24/11/2026) — the pure half: the search (apartment
// number, the orderer's name, the people of the row), the quick status button
// of a row (decided from ALL the rows of its order), and the Excel file, read
// back from the real workbook. A row is one apartment of an order.

const NOW = new Date('2026-11-24T10:00:00Z');

function row(over: Partial<ChipOrderRow>): ChipOrderRow {
  return {
    item_id: 'i1', order_id: 'o1', order_number: 1042, contact_id: 'c1', apartment_number: '12',
    full_name: 'דנה כהן', phone_e164: '+972539300001', role: 'owner', status: 'paid',
    chips_count: 2, chips_linked: 0, line_total: 100, people: ['דנה כהן'],
    paid_at: '2026-11-23T08:00:00Z', due_at: '2026-11-26T08:00:00Z', created_at: '2026-11-23T07:30:00Z',
    has_failed_notification: false, is_test: false, phone_verified: true,
    ...over,
  };
}

const ROWS: ChipOrderRow[] = [
  row({ item_id: 'a', order_id: 'o1', apartment_number: '12', full_name: 'דנה כהן', people: ['דנה כהן', 'שרה לוי'] }),
  row({ item_id: 'b', order_id: 'o1', apartment_number: '14', full_name: 'דנה כהן', people: ['דנה כהן'] }),
  row({ item_id: 'c', order_id: 'o2', order_number: 1043, apartment_number: '112', full_name: 'Yossi Mizrahi', people: [] }),
  row({ item_id: 'd', order_id: 'o3', order_number: 1044, apartment_number: '7', full_name: 'רון אבני', people: ['רון אבני', 'מטפלת סיעודית'] }),
];
const found = (q: string) => filterChipOrderRows(ROWS, q).map((r) => r.item_id);

describe('the search of the Orders tab', () => {
  it('an empty search keeps every row, in order', () => {
    expect(found('')).toEqual(['a', 'b', 'c', 'd']);
    expect(found('   ')).toEqual(['a', 'b', 'c', 'd']);
  });

  it('by apartment number — any part of it, as in the chips tab', () => {
    expect(found('14')).toEqual(['b']);
    expect(found('12')).toEqual(['a', 'c']); // 12 and 112
    expect(found('7')).toEqual(['d']);
  });

  it('by the orderer\'s name — every apartment row of that order', () => {
    expect(found('דנה')).toEqual(['a', 'b']);
    expect(found('כהן')).toEqual(['a', 'b']);
    expect(found('yossi')).toEqual(['c']); // case does not matter
  });

  it('by the name of a person of the row — the renter, or whoever the staff added', () => {
    expect(found('שרה')).toEqual(['a']); // the renter lives in apartment 12 only
    expect(found('סיעודית')).toEqual(['d']);
  });

  it('several words must ALL be found, each in any field', () => {
    expect(found('דנה 14')).toEqual(['b']);
    expect(found('  כהן   12 ')).toEqual(['a']);
    expect(found('דנה רון')).toEqual([]);
  });

  it('a row found through a person says who: the people the search hit, never the orderer again', () => {
    expect(searchHitPeople(ROWS[0]!, 'שרה')).toEqual(['שרה לוי']);
    expect(searchHitPeople(ROWS[0]!, 'דנה')).toEqual([]);
    expect(searchHitPeople(ROWS[0]!, '12')).toEqual([]);
    expect(searchHitPeople(ROWS[0]!, '')).toEqual([]);
    expect(searchHitPeople(ROWS[3]!, 'מטפלת')).toEqual(['מטפלת סיעודית']);
  });
});

describe('the quick status button of a row', () => {
  const two = [
    row({ item_id: 'a', order_id: 'o1', apartment_number: '12', chips_count: 3, chips_linked: 3 }),
    row({ item_id: 'b', order_id: 'o1', apartment_number: '14', chips_count: 2, chips_linked: 1 }),
    row({ item_id: 'c', order_id: 'o2', apartment_number: '20', chips_count: 1, chips_linked: 0 }),
  ];

  it('the order is summed over ALL its apartments', () => {
    const s = summarizeChipOrders(two);
    expect(s.get('o1')).toEqual({ missing: 1, apartments: ['12', '14'] });
    expect(s.get('o2')).toEqual({ missing: 1, apartments: ['20'] });
    // More chips than ordered in one apartment never cover another one.
    expect(summarizeChipOrders([{ ...two[0]!, chips_linked: 9 }, two[1]!]).get('o1')!.missing).toBe(1);
  });

  it('"מוכן לאיסוף" waits for every chip of the whole order, and says what is missing', () => {
    const s = summarizeChipOrders(two);
    // Apartment 12 has all its chips — and still waits for apartment 14 of the same order.
    expect(chipOrderRowAction(two[0]!, s.get('o1'))).toEqual({ kind: 'ready', enabled: false, reason: 'חסר צ׳יפ אחד בהזמנה' });
    expect(chipOrderRowAction(two[2]!, s.get('o2'))).toEqual({ kind: 'ready', enabled: false, reason: 'חסר צ׳יפ אחד' });
    const full = two.map((r) => ({ ...r, chips_linked: r.chips_count }));
    expect(chipOrderRowAction(full[0]!, summarizeChipOrders(full).get('o1'))).toEqual({ kind: 'ready', enabled: true, reason: null });
    expect(missingChipsText(3)).toBe('חסרים 3 צ׳יפים');
  });

  it('a ready order offers "נאסף"; a legacy "approved" is still being assigned; a closed order offers nothing', () => {
    const s = summarizeChipOrders(two);
    expect(chipOrderRowAction({ order_id: 'o1', status: 'ready' }, s.get('o1'))).toEqual({ kind: 'collected' });
    expect(chipOrderRowAction({ order_id: 'o2', status: 'approved' }, s.get('o2'))).toMatchObject({ kind: 'ready', enabled: false });
    expect(chipOrderRowAction({ order_id: 'o1', status: 'collected' }, s.get('o1'))).toBeNull();
    expect(chipOrderRowAction({ order_id: 'o1', status: 'rejected' }, s.get('o1'))).toBeNull();
  });
});

describe('the Excel file and the print view of the Orders tab', () => {
  it('dates are written in Israel time', () => {
    expect(formatOrderDate('2026-11-23T22:30:00Z')).toBe('24/11/2026'); // already the 24th in Israel
    expect(formatOrderDateTime('2026-11-26T08:00:00Z')).toBe('26/11/2026 10:00');
  });

  it('the status is the row\'s stage in words, with "באיחור" past the due date', () => {
    expect(chipOrderRowStatusText(row({ chips_linked: 0 }), NOW)).toBe('ממתין לשיוך');
    expect(chipOrderRowStatusText(row({ chips_linked: 1 }), NOW)).toBe('שויכו 1 מתוך 2');
    expect(chipOrderRowStatusText(row({ chips_linked: 2 }), NOW)).toBe('שויך');
    expect(chipOrderRowStatusText(row({ status: 'ready', chips_linked: 2 }), NOW)).toBe('מוכן לאיסוף');
    expect(chipOrderRowStatusText(row({ chips_linked: 1, due_at: '2026-11-24T09:00:00Z' }), NOW)).toBe('שויכו 1 מתוך 2 · באיחור');
    // A ready order is never late.
    expect(chipOrderRowStatusText(row({ status: 'ready', chips_linked: 2, due_at: '2026-11-24T09:00:00Z' }), NOW)).toBe('מוכן לאיסוף');
  });

  it('the people of a row; a row that came without any names whoever ordered', () => {
    expect(chipOrderRowPeople(row({ people: ['דנה כהן', 'שרה לוי'] }))).toEqual(['דנה כהן', 'שרה לוי']);
    expect(chipOrderRowPeople(row({ people: [], full_name: 'ותיק בדיקה' }))).toEqual(['ותיק בדיקה']);
  });

  it('the columns, in order', () => {
    expect(CHIP_ORDER_EXPORT_COLUMNS.map((c) => c.header)).toEqual([
      'מס׳ הזמנה', 'תאריך הזמנה', 'שם המזמין', 'טלפון', 'דירה', 'בעלי הצ׳יפ', 'כמות', 'סה״כ (₪)', 'סטטוס', 'יעד להכנה', 'הזמנת בדיקה',
    ]);
  });

  it('the workbook: one line per row on the screen, numbers as numbers, text as text', async () => {
    const rows = [
      row({ item_id: 'a', apartment_number: '012', people: ['דנה כהן', 'שרה לוי'], chips_count: 3, chips_linked: 1, line_total: 157.5 }),
      row({
        item_id: 'b', order_number: 1043, apartment_number: '14', full_name: '=HYPERLINK("http://x","y")', phone_e164: '+447911123456',
        people: [], status: 'ready', chips_count: 1, chips_linked: 1, line_total: 50, due_at: null, is_test: true,
      }),
    ];
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await buildChipOrdersWorkbook(rows, NOW));
    const ws = wb.worksheets[0]!;
    expect(ws.name).toBe('הזמנות צ׳יפים');
    expect(ws.views[0]?.rightToLeft).toBe(true);
    const values = (n: number) => (ws.getRow(n).values as unknown[]).slice(1);
    expect(values(1)).toEqual(CHIP_ORDER_EXPORT_COLUMNS.map((c) => c.header));
    expect(values(2)).toEqual([
      1042, '23/11/2026', 'דנה כהן', '0539300001', '012', 'דנה כהן, שרה לוי', 3, 157.5, 'שויכו 1 מתוך 3', '26/11/2026 10:00', 'לא',
    ]);
    // A name typed like a formula opens as text — also where it stands in for
    // the people of an order with no holder lines; a foreign phone keeps its
    // "+" as text; no due date = a blank cell.
    const formula = '\'=HYPERLINK("http://x","y")';
    expect(ws.getRow(3).getCell(10).value).toBeNull();
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 11].map((c) => ws.getRow(3).getCell(c).value)).toEqual([
      1043, '23/11/2026', formula, '\'+447911123456', '14', formula, 1, 50, 'מוכן לאיסוף', 'כן',
    ]);
    expect(ws.rowCount).toBe(3);
    // The apartment stays text ("012" keeps its zero); the amount is a number with two decimals.
    expect(ws.getRow(2).getCell(5).type).toBe(ExcelJS.ValueType.String);
    expect(ws.getRow(2).getCell(8).type).toBe(ExcelJS.ValueType.Number);
    expect(ws.getRow(2).getCell(8).numFmt).toBe(CHIP_ORDER_MONEY_FMT);
    expect(ws.getRow(2).getCell(1).type).toBe(ExcelJS.ValueType.Number);
  });
});
