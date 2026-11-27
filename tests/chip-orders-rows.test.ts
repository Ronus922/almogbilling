import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import type { ChipOrderRow } from '@/lib/chipOrders/model';
import {
  CHIP_ORDERS_EXPORT, CHIP_ORDER_DOC_TEXT, CHIP_ORDER_PAYMENT_LABEL, CHIP_ORDER_TAG_LABEL, CHIP_ORDER_WAITING_LABEL, chipOrderDocState,
  chipOrderRowAction, chipOrderRowDocument, chipOrderRowDocumentNumber, chipOrderRowPayment, chipOrderRowPaymentText, chipOrderRowPeople,
  chipOrderRowPhone, chipOrderRowStatusText, chipOrderRowTags, countOpenChipOrderRows, filterChipOrderRows, missingChipsText,
  safeDocumentUrl, searchHitPeople, summarizeChipOrders, type ChipOrderTag,
} from '@/lib/chipOrders/orderRows';
import { EXPORT_MONEY_FMT, buildListWorkbook, exportDate, exportDateTime } from '@/lib/export/list-export';

// The Orders tab of /chips (24/11/2026) — the pure half: the search (apartment
// number, the orderer's name, the people of the row), the tags of a row, the
// action column of a row (decided from ALL the rows of its order: a row waits
// while chips are missing, and only then offers "מוכן לאיסוף"), and the Excel
// file, read back from the real workbook. A row is one apartment of an order.
// 25/11/2026: an order made at the reception stays in the tab although it is
// collected — tagged "קבלה", status "נאסף", nothing to press, never counted.
// 26/11/2026: the order number is searched from its start; "תשלום" (how the
// order was paid) and "חשבונית" (where its Morning document stands) are
// columns of the tab and of the file; "טלפון לא אומת" only for a code step
// that was skipped (false), never for an order with no code step (null).

const NOW = new Date('2026-11-24T10:00:00Z');

function row(over: Partial<ChipOrderRow>): ChipOrderRow {
  return {
    item_id: 'i1', order_id: 'o1', order_number: 1042, contact_id: 'c1', apartment_number: '12',
    full_name: 'דנה כהן', phone_e164: '+972539300001', role: 'owner', source: 'web', status: 'paid',
    chips_count: 2, chips_linked: 0, line_total: 100, people: ['דנה כהן'], people_keys: ['h1'], extra_of_order_number: null,
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

  it('by order number — from its start, like the pickup screen (26/11/2026)', () => {
    expect(found('1042')).toEqual(['a', 'b']); // every apartment row of order 1042
    expect(found('1043')).toEqual(['c']);
    expect(found('104')).toEqual(['a', 'b', 'c', 'd']); // 1042, 1043, 1044
    expect(found('042')).toEqual([]); // the middle of an order number is no hit
    expect(found('10420')).toEqual([]);
    // Combined with a name or an apartment, every word must still be found.
    expect(found('1042 14')).toEqual(['b']);
    expect(found('1044 רון')).toEqual(['d']);
    expect(found('1043 דנה')).toEqual([]);
    // A digit word still finds an apartment that merely contains it, as before.
    expect(found('12')).toEqual(['a', 'c']);
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

  it('"טלפון לא אומת" only when the code step was skipped — an order from a form with no code step (null) has no tag', () => {
    expect(chipOrderRowTags(row({ phone_verified: false }))).toEqual(['phone_unverified']);
    expect(chipOrderRowTags(row({ phone_verified: null }))).toEqual([]);
    expect(chipOrderRowTags(row({ phone_verified: true }))).toEqual([]);
    expect(chipOrderRowTags(row({ is_test: true, phone_verified: null }))).toEqual(['test']);
  });

  it('an order made at the reception is tagged "קבלה" — and a web order never is; a web order handed over is tagged "נמסרה" (27/11/2026), a reception one never', () => {
    expect(chipOrderRowTags(row({ source: 'reception', status: 'collected' }))).toEqual(['reception']);
    expect(CHIP_ORDER_TAG_LABEL.reception).toBe('קבלה');
    expect(chipOrderRowTags(row({ source: 'web', status: 'collected' }))).toEqual(['delivered']);
    expect(CHIP_ORDER_TAG_LABEL.delivered).toBe('נמסרה');
    expect(chipOrderRowTags(row({ source: 'web', status: 'ready' }))).toEqual([]);
    // A row that came without `source` (a tab left open across a rollback) is a web order.
    expect(chipOrderRowTags({ is_test: false, phone_verified: true, has_failed_notification: false })).toEqual([]);
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

  it('a "זיכוי" waiting for PayPlus\'s answer: no action on the row (26/11/2026)', () => {
    const full = row({ item_id: 'f', order_id: 'o9', apartment_number: '30', chips_count: 1, chips_linked: 1 });
    const s = summarizeChipOrders([full]);
    expect(chipOrderRowAction(full, s.get('o9'))).toEqual({ kind: 'ready' });
    expect(chipOrderRowAction({ ...full, refund_in_flight: true }, s.get('o9'))).toBeNull();
    expect(chipOrderRowAction({ ...full, status: 'ready', refund_in_flight: true }, s.get('o9'))).toBeNull();
    expect(chipOrderRowAction({ ...full, status: 'ready', refund_in_flight: false }, s.get('o9'))).toEqual({ kind: 'collected' });
  });

  it('"מוכן לאיסוף" is offered only once every chip of the whole order is issued', () => {
    const full = two.map((r) => ({ ...r, chips_linked: r.chips_count }));
    const s = summarizeChipOrders(full);
    expect(chipOrderRowAction(full[0]!, s.get('o1'))).toEqual({ kind: 'ready' });
    expect(chipOrderRowAction(full[1]!, s.get('o1'))).toEqual({ kind: 'ready' });
    expect(chipOrderRowAction(full[2]!, s.get('o2'))).toEqual({ kind: 'ready' });
  });

  it('a ready order offers "נאסף"; a legacy "approved" still waits for its chips; a rejected order offers nothing', () => {
    const s = summarizeChipOrders(two);
    expect(chipOrderRowAction({ order_id: 'o1', status: 'ready' }, s.get('o1'))).toEqual({ kind: 'collected' });
    expect(chipOrderRowAction({ order_id: 'o2', status: 'approved' }, s.get('o2'))).toEqual({ kind: 'waiting', missing: 'חסר צ׳יפ אחד' });
    expect(chipOrderRowAction({ order_id: 'o1', status: 'rejected' }, s.get('o1'))).toBeNull();
  });

  it('a collected order — a reception order, paid and handed over in one go — has nothing to press: a plain "נאסף"', () => {
    const reception = [row({ item_id: 'r', order_id: 'o9', source: 'reception', status: 'collected', chips_count: 2, chips_linked: 2 })];
    expect(chipOrderRowAction(reception[0]!, summarizeChipOrders(reception).get('o9'))).toEqual({ kind: 'done' });
    // …whatever its chips say: a chip disabled later does not reopen the order.
    expect(chipOrderRowAction({ order_id: 'o9', status: 'collected' }, { missing: 1, apartments: ['12'] })).toEqual({ kind: 'done' });
  });

  it('a refunded web order stays in the tab: rejected → nothing to press; collected → a plain "נאסף"', () => {
    const refunded = row({ order_id: 'o7', status: 'rejected', card_status: 'paid', card_env: 'production', refund_status: 'refunded' });
    expect(chipOrderRowAction(refunded, summarizeChipOrders([refunded]).get('o7'))).toBeNull();
    const collected = row({ order_id: 'o8', status: 'collected', card_status: 'paid', refund_status: 'refunded' });
    expect(chipOrderRowAction(collected, summarizeChipOrders([collected]).get('o8'))).toEqual({ kind: 'done' });
    expect(countOpenChipOrderRows([refunded, collected])).toBe(0);
  });

  it('the badge on the tab counts what still waits for someone: never a test order, never a collected one', () => {
    expect(countOpenChipOrderRows([
      row({}),
      row({ status: 'ready' }),
      row({ is_test: true }),
      row({ source: 'reception', status: 'collected' }),
    ])).toBe(2);
    expect(countOpenChipOrderRows([row({ source: 'reception', status: 'collected' })])).toBe(0);
  });
});

describe('"תשלום" — how a row was paid, one short word', () => {
  const pay = (over: Partial<ChipOrderRow>) => chipOrderRowPaymentText(row(over));

  it('a refund comes first — full or part — whatever paid the order', () => {
    expect(pay({ card_status: 'paid', card_env: 'production', refund_status: 'refunded' })).toBe('זוכה');
    expect(pay({ card_status: 'paid', card_env: 'production', refund_status: 'partial' })).toBe('זוכה חלקית');
    expect(pay({ is_test: true, card_status: 'paid', card_env: 'sandbox', refund_status: 'refunded' })).toBe('זוכה');
    // A refund that has to be done by hand is no refund yet: the order still reads as paid.
    expect(pay({ card_status: 'paid', card_env: 'production', refund_status: 'manual_required' })).toBe('אשראי');
  });

  it('a test order no card paid is "no charge"; a card the processor confirmed is "אשראי" — the sandbox says so', () => {
    expect(pay({ is_test: true })).toBe('בדיקה, ללא חיוב');
    expect(pay({ is_test: true, refund_status: 'not_required' })).toBe('בדיקה, ללא חיוב');
    expect(pay({ is_test: true, card_status: 'paid', card_env: 'sandbox' })).toBe('אשראי · בדיקה');
    expect(pay({ card_status: 'paid', card_env: 'production' })).toBe('אשראי');
    // A card session that never paid is not a payment.
    expect(pay({ card_status: 'failed', card_env: 'production' })).toBe('—');
    expect(pay({ is_test: true, card_status: 'started', card_env: 'sandbox' })).toBe('בדיקה, ללא חיוב');
  });

  it('a reception order: the method it recorded — and the one recorded before the split, as it was', () => {
    expect(pay({ source: 'reception', status: 'collected', payment_method: 'cash' })).toBe('מזומן');
    expect(pay({ source: 'reception', status: 'collected', payment_method: 'bank_transfer' })).toBe('העברה');
    expect(pay({ source: 'reception', status: 'collected', payment_method: 'cash_transfer' })).toBe('מזומן או העברה');
    // A reception order that was cancelled keeps saying how it was paid.
    expect(pay({ source: 'reception', status: 'rejected', payment_method: 'cash' })).toBe('מזומן');
  });

  it('nothing to say → "—": a web order of the former processor, a row from an older build, a method nobody knows', () => {
    expect(pay({})).toBe('—');
    expect(pay({ payment_method: 'something_new' })).toBe('—');
    expect(chipOrderRowPayment({ is_test: false })).toBeNull();
    // "ללא חיוב" is never an order, but its label stays available.
    expect(CHIP_ORDER_PAYMENT_LABEL.none).toBe('ללא חיוב');
  });
});

describe('"חשבונית" — where the Morning document of a row stands', () => {
  const doc = (status: 'pending' | 'issuing' | 'issued' | 'failed', number: string | null = null, url: string | null = null) => ({ status, number, url });

  it('issued → its number and its link', () => {
    expect(chipOrderDocState(doc('issued', '10023', 'https://www.greeninvoice.co.il/d/abc'), true))
      .toEqual({ kind: 'issued', number: '10023', url: 'https://www.greeninvoice.co.il/d/abc' });
    // Whether Morning is connected now does not matter for a document already issued.
    expect(chipOrderDocState(doc('issued', '10023', 'https://example.test/d'), false)).toMatchObject({ kind: 'issued', number: '10023' });
  });

  it('only an https link is ever drawn', () => {
    expect(chipOrderDocState(doc('issued', '7', 'javascript:alert(1)'), true)).toEqual({ kind: 'issued', number: '7', url: null });
    expect(safeDocumentUrl('http://example.test/d')).toBeNull();
    expect(safeDocumentUrl('https://example.test/d"onmouseover=x')).toBeNull();
    expect(safeDocumentUrl(null)).toBeNull();
    expect(safeDocumentUrl('https://example.test/d/1?x=2')).toBe('https://example.test/d/1?x=2');
  });

  it('still queued → "בהפקה" while Morning is connected, "ממתינה לחיבור מורנינג" while it is not', () => {
    expect(chipOrderDocState(doc('pending'), true)).toEqual({ kind: 'waiting', text: 'בהפקה' });
    expect(chipOrderDocState(doc('issuing'), true)).toEqual({ kind: 'waiting', text: 'בהפקה' });
    expect(chipOrderDocState(doc('pending'), false)).toEqual({ kind: 'waiting', text: 'ממתינה לחיבור מורנינג' });
    expect(CHIP_ORDER_DOC_TEXT).toEqual({ waitingMorning: 'ממתינה לחיבור מורנינג', issuing: 'בהפקה', failed: 'לא הופקה' });
  });

  it('failed → "לא הופקה"; no document → nothing; a test order never has one', () => {
    expect(chipOrderDocState(doc('failed'), true)).toEqual({ kind: 'failed', text: 'לא הופקה' });
    expect(chipOrderDocState(null, true)).toEqual({ kind: 'none' });
    expect(chipOrderRowDocument(row({}), true)).toEqual({ kind: 'none' }); // a row from an older build
    expect(chipOrderRowDocument(row({ invoice_doc: null }), true)).toEqual({ kind: 'none' });
    expect(chipOrderRowDocument(row({ is_test: true, invoice_doc: doc('issued', '1', 'https://x.test/1') }), true)).toEqual({ kind: 'none' });
    expect(chipOrderRowDocument(row({ invoice_doc: doc('pending') }), false)).toEqual({ kind: 'waiting', text: 'ממתינה לחיבור מורנינג' });
  });

  it('the file holds the number of an issued document — nothing else', () => {
    expect(chipOrderRowDocumentNumber(row({ invoice_doc: doc('issued', '10023', 'https://x.test/d') }))).toBe('10023');
    expect(chipOrderRowDocumentNumber(row({ invoice_doc: doc('issued', null, 'https://x.test/d') }))).toBe('');
    expect(chipOrderRowDocumentNumber(row({ invoice_doc: doc('failed') }))).toBe('');
    expect(chipOrderRowDocumentNumber(row({ invoice_doc: doc('pending') }))).toBe('');
    expect(chipOrderRowDocumentNumber(row({}))).toBe('');
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
    // A reception order is collected — whatever its chips say now, and with no due date to be late for.
    expect(chipOrderRowStatusText(row({ source: 'reception', status: 'collected', chips_linked: 2, due_at: null }), NOW)).toBe('נאסף');
    expect(chipOrderRowStatusText(row({ source: 'reception', status: 'collected', chips_linked: 0, due_at: null }), NOW)).toBe('נאסף');
  });

  it('the orderer\'s phone: an Israeli mobile in its local form, any other number as it is, and none at all', () => {
    expect(chipOrderRowPhone(row({}))).toBe('0539300001');
    expect(chipOrderRowPhone(row({ phone_e164: '048500184' }))).toBe('048500184'); // a reception order may hold a landline
    expect(chipOrderRowPhone(row({ phone_e164: null }))).toBe('');
  });

  it('the people of a row; a row that came without any names whoever ordered', () => {
    expect(chipOrderRowPeople(row({ people: ['דנה כהן', 'שרה לוי'] }))).toEqual(['דנה כהן', 'שרה לוי']);
    expect(chipOrderRowPeople(row({ people: [], full_name: 'ותיק בדיקה' }))).toEqual(['ותיק בדיקה']);
  });

  it('the columns, in order — the tags right after the orderer, as in the table; the payment and the invoice after the sum', () => {
    expect(CHIP_ORDERS_EXPORT.columns.map((c) => c.header)).toEqual([
      'מס׳ הזמנה', 'תאריך הזמנה', 'שם המזמין', 'טלפון', 'תגיות', 'דירה', 'בעלי הצ׳יפ', 'כמות', 'סה״כ (₪)', 'תשלום', 'חשבונית',
      'סטטוס', 'יעד להכנה', 'הזמנת בדיקה',
      // The three notes of an order (27/11/2026), each its own column.
      'הערת המזמין', 'הערה לשומר', 'הערת מסירה',
    ]);
    // "הזמנות צ׳יפים", not "… פתוחות": the tab lists the reception orders too, and those are collected.
    expect(CHIP_ORDERS_EXPORT).toMatchObject({ title: 'הזמנות צ׳יפים', sheet: 'הזמנות צ׳יפים', file: 'chip-orders' });
  });

  it('the workbook: one line per row on the screen, numbers as numbers, text as text, the tags in words', async () => {
    const rows = [
      row({ item_id: 'a', apartment_number: '012', people: ['דנה כהן', 'שרה לוי'], chips_count: 3, chips_linked: 1, line_total: 157.5 }),
      row({
        item_id: 'b', order_number: 1043, apartment_number: '14', full_name: '=HYPERLINK("http://x","y")', phone_e164: '+447911123456',
        people: [], status: 'ready', chips_count: 1, chips_linked: 1, line_total: 50, due_at: null,
        is_test: true, phone_verified: false, has_failed_notification: true,
      }),
      // An order made at the reception for a guest who left no phone — paid in
      // cash, its invoice issued.
      row({
        item_id: 'c', order_number: 1044, apartment_number: '20', full_name: 'אורח בדיקה', phone_e164: null, role: 'other',
        source: 'reception', status: 'collected', people: ['אורח בדיקה'], chips_count: 2, chips_linked: 2, line_total: 100, due_at: null,
        payment_method: 'cash', invoice_doc: { status: 'issued', number: '10023', url: 'https://example.test/d/10023' },
      }),
      // A web order the card paid and that was refunded; its invoice failed.
      row({
        item_id: 'e', order_number: 1045, apartment_number: '30', status: 'rejected', chips_count: 1, chips_linked: 0, line_total: 50,
        due_at: null, card_status: 'paid', card_env: 'production', refund_status: 'refunded', refunded_amount: 50,
        invoice_doc: { status: 'failed', number: null, url: null },
      }),
    ];
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await buildListWorkbook(CHIP_ORDERS_EXPORT, rows, NOW));
    const ws = wb.worksheets[0]!;
    expect(ws.name).toBe('הזמנות צ׳יפים');
    expect(ws.views[0]?.rightToLeft).toBe(true);
    const cells = (n: number) => CHIP_ORDERS_EXPORT.columns.map((_, i) => ws.getRow(n).getCell(i + 1).value);
    expect(cells(1)).toEqual(CHIP_ORDERS_EXPORT.columns.map((c) => c.header));
    // An order with no tag: the tags cell is blank, not an empty text — and so
    // are its payment (a row of the former processor) and its invoice (none).
    expect(cells(2)).toEqual([
      1042, '23/11/2026', 'דנה כהן', '0539300001', null, '012', 'דנה כהן, שרה לוי', 3, 157.5, null, null, 'שויכו 1 מתוך 3', '26/11/2026 10:00', 'לא', null, null, null,
    ]);
    // A name typed like a formula opens as text — also where it stands in for
    // the people of an order with no holder lines; a foreign phone keeps its
    // "+" as text; no due date = a blank cell; the three tags in words; a test
    // order no card paid is "no charge".
    const formula = '\'=HYPERLINK("http://x","y")';
    expect(cells(3)).toEqual([
      1043, '23/11/2026', formula, '\'+447911123456', 'בדיקה, טלפון לא אומת, הודעה נכשלה', '14', formula, 1, 50, 'בדיקה, ללא חיוב', null,
      'מוכן לאיסוף', null, 'כן', null, null, null,
    ]);
    // The reception order: tagged "קבלה", paid in cash, its invoice number, collected, a blank phone and a blank due date.
    expect(cells(4)).toEqual([
      1044, '23/11/2026', 'אורח בדיקה', null, 'קבלה', '20', 'אורח בדיקה', 2, 100, 'מזומן', '10023', 'נאסף', null, 'לא', null, null, null,
    ]);
    // The refunded web order: "זוכה", and no invoice number (its document failed).
    expect(cells(5)).toEqual([
      1045, '23/11/2026', 'דנה כהן', '0539300001', null, '30', 'דנה כהן', 1, 50, 'זוכה', null, 'נדחה', null, 'לא', null, null, null,
    ]);
    expect(ws.rowCount).toBe(5);
    // The apartment stays text ("012" keeps its zero); the amount is a number with two decimals.
    expect(ws.getRow(2).getCell(6).type).toBe(ExcelJS.ValueType.String);
    expect(ws.getRow(2).getCell(9).type).toBe(ExcelJS.ValueType.Number);
    expect(ws.getRow(2).getCell(9).numFmt).toBe(EXPORT_MONEY_FMT);
    expect(ws.getRow(2).getCell(1).type).toBe(ExcelJS.ValueType.Number);
  });
});
