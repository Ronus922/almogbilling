import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import type { ChipOrderRow } from '@/lib/chipOrders/model';
import {
  CHIP_ORDERS_EXPORT, CHIP_ORDER_TAG_LABEL, CHIP_ORDER_WAITING_LABEL, chipOrderRowAction, chipOrderRowPeople, chipOrderRowStatusText,
  chipOrderRowTags, filterChipOrderRows, missingChipsText, searchHitPeople, summarizeChipOrders, type ChipOrderTag,
} from '@/lib/chipOrders/orderRows';
import { EXPORT_MONEY_FMT, buildListWorkbook, exportDate, exportDateTime } from '@/lib/export/list-export';

// The Orders tab of /chips (24/11/2026) — the pure half: the search (apartment
// number, the orderer's name, the people of the row), the tags of a row, the
// action column of a row (decided from ALL the rows of its order: a row waits
// while chips are missing, and only then offers "מוכן לאיסוף"), and the Excel
// file, read back from the real workbook. A row is one apartment of an order.

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

describe('the tags of a row', () => {
  it('an ordinary order has none; a test order, an unproved phone and a failed message are tags, in that order', () => {
    expect(chipOrderRowTags(row({}))).toEqual([]);
    expect(chipOrderRowTags(row({ is_test: true }))).toEqual(['test']);
    expect(chipOrderRowTags(row({ has_failed_notification: true }))).toEqual(['notify_failed']);
    const all: ChipOrderTag[] = ['test', 'phone_unverified', 'notify_failed'];
    expect(chipOrderRowTags(row({ is_test: true, phone_verified: false, has_failed_notification: true }))).toEqual(all);
    expect(all.map((t) => CHIP_ORDER_TAG_LABEL[t])).toEqual(['בדיקה', 'טלפון לא אומת', 'הודעה נכשלה']);
  });
});

describe('the action column of a row', () => {
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

  it('while chips are missing there is nothing to press: the row waits, and says what is missing', () => {
    const s = summarizeChipOrders(two);
    // Apartment 12 has all its chips — and still waits for apartment 14 of the same order.
    expect(chipOrderRowAction(two[0]!, s.get('o1'))).toEqual({ kind: 'waiting', missing: 'חסר צ׳יפ אחד בהזמנה' });
    expect(chipOrderRowAction(two[1]!, s.get('o1'))).toEqual({ kind: 'waiting', missing: 'חסר צ׳יפ אחד בהזמנה' });
    expect(chipOrderRowAction(two[2]!, s.get('o2'))).toEqual({ kind: 'waiting', missing: 'חסר צ׳יפ אחד' });
    const three = summarizeChipOrders([{ ...two[2]!, chips_count: 3 }]);
    expect(chipOrderRowAction(two[2]!, three.get('o2'))).toEqual({ kind: 'waiting', missing: 'חסרים 3 צ׳יפים' });
    expect(missingChipsText(3)).toBe('חסרים 3 צ׳יפים');
    expect(CHIP_ORDER_WAITING_LABEL).toBe('בהמתנה');
  });

  it('"מוכן לאיסוף" is offered only once every chip of the whole order is issued', () => {
    const full = two.map((r) => ({ ...r, chips_linked: r.chips_count }));
    const s = summarizeChipOrders(full);
    expect(chipOrderRowAction(full[0]!, s.get('o1'))).toEqual({ kind: 'ready' });
    expect(chipOrderRowAction(full[1]!, s.get('o1'))).toEqual({ kind: 'ready' });
    expect(chipOrderRowAction(full[2]!, s.get('o2'))).toEqual({ kind: 'ready' });
  });

  it('a ready order offers "נאסף"; a legacy "approved" still waits for its chips; a closed order offers nothing', () => {
    const s = summarizeChipOrders(two);
    expect(chipOrderRowAction({ order_id: 'o1', status: 'ready' }, s.get('o1'))).toEqual({ kind: 'collected' });
    expect(chipOrderRowAction({ order_id: 'o2', status: 'approved' }, s.get('o2'))).toEqual({ kind: 'waiting', missing: 'חסר צ׳יפ אחד' });
    expect(chipOrderRowAction({ order_id: 'o1', status: 'collected' }, s.get('o1'))).toBeNull();
    expect(chipOrderRowAction({ order_id: 'o1', status: 'rejected' }, s.get('o1'))).toBeNull();
  });
});

describe('the Orders tab as a file: Excel, the print view and the PDF share these columns', () => {
  it('dates are written in Israel time', () => {
    expect(exportDate('2026-11-23T22:30:00Z')).toBe('24/11/2026'); // already the 24th in Israel
    expect(exportDateTime('2026-11-26T08:00:00Z')).toBe('26/11/2026 10:00');
    // A value that is no date leaves its cell empty; it never loses the file.
    expect(exportDate('not a date')).toBe('');
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

  it('the columns, in order — the tags right after the orderer, as in the table', () => {
    expect(CHIP_ORDERS_EXPORT.columns.map((c) => c.header)).toEqual([
      'מס׳ הזמנה', 'תאריך הזמנה', 'שם המזמין', 'טלפון', 'תגיות', 'דירה', 'בעלי הצ׳יפ', 'כמות', 'סה״כ (₪)', 'סטטוס', 'יעד להכנה', 'הזמנת בדיקה',
    ]);
    expect(CHIP_ORDERS_EXPORT).toMatchObject({ title: 'הזמנות צ׳יפים פתוחות', sheet: 'הזמנות צ׳יפים', file: 'chip-orders' });
  });

  it('the workbook: one line per row on the screen, numbers as numbers, text as text, the tags in words', async () => {
    const rows = [
      row({ item_id: 'a', apartment_number: '012', people: ['דנה כהן', 'שרה לוי'], chips_count: 3, chips_linked: 1, line_total: 157.5 }),
      row({
        item_id: 'b', order_number: 1043, apartment_number: '14', full_name: '=HYPERLINK("http://x","y")', phone_e164: '+447911123456',
        people: [], status: 'ready', chips_count: 1, chips_linked: 1, line_total: 50, due_at: null,
        is_test: true, phone_verified: false, has_failed_notification: true,
      }),
    ];
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await buildListWorkbook(CHIP_ORDERS_EXPORT, rows, NOW));
    const ws = wb.worksheets[0]!;
    expect(ws.name).toBe('הזמנות צ׳יפים');
    expect(ws.views[0]?.rightToLeft).toBe(true);
    const cells = (n: number) => CHIP_ORDERS_EXPORT.columns.map((_, i) => ws.getRow(n).getCell(i + 1).value);
    expect(cells(1)).toEqual(CHIP_ORDERS_EXPORT.columns.map((c) => c.header));
    // An order with no tag: the tags cell is blank, not an empty text.
    expect(cells(2)).toEqual([
      1042, '23/11/2026', 'דנה כהן', '0539300001', null, '012', 'דנה כהן, שרה לוי', 3, 157.5, 'שויכו 1 מתוך 3', '26/11/2026 10:00', 'לא',
    ]);
    // A name typed like a formula opens as text — also where it stands in for
    // the people of an order with no holder lines; a foreign phone keeps its
    // "+" as text; no due date = a blank cell; the three tags in words.
    const formula = '\'=HYPERLINK("http://x","y")';
    expect(cells(3)).toEqual([
      1043, '23/11/2026', formula, '\'+447911123456', 'בדיקה, טלפון לא אומת, הודעה נכשלה', '14', formula, 1, 50, 'מוכן לאיסוף', null, 'כן',
    ]);
    expect(ws.rowCount).toBe(3);
    // The apartment stays text ("012" keeps its zero); the amount is a number with two decimals.
    expect(ws.getRow(2).getCell(6).type).toBe(ExcelJS.ValueType.String);
    expect(ws.getRow(2).getCell(9).type).toBe(ExcelJS.ValueType.Number);
    expect(ws.getRow(2).getCell(9).numFmt).toBe(EXPORT_MONEY_FMT);
    expect(ws.getRow(2).getCell(1).type).toBe(ExcelJS.ValueType.Number);
  });
});
