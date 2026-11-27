import { describe, expect, it } from 'vitest';
import {
  chipOrderDueAt, chipOrderStage, chipOrderStageLabel, formatIls, isChipOrderOverdue, isOpenChipOrder, needsLease,
  orderTotal, priceLine,
} from '@/lib/chipOrders/model';
import { assignToOrderLines, pendingPerLine } from '@/lib/chipOrders/assign';
import { chipOrderMatchStatus } from '@/lib/chipOrders/match';
import { chipOrderMessage, chipOrderWhatsAppText } from '@/lib/chipOrders/messages';
import { leaseFileProblem } from '@/lib/chipOrders/lease';

// Chip orders (12/11/2026) — the pure rules: the price (one flat price per
// chip since 21/11/2026), the
// 72-working-hour due date (from the payment since 13/11/2026), the match
// status, the three messages, and (13/11/2026) the stage of one apartment and
// which order line a new chip number is linked to.

const S = { unitPrice: 50 };

describe('priceLine — one flat price per chip (21/11/2026)', () => {
  it.each([
    [1, 50],
    [2, 100],
    [3, 150],
    [4, 200],
    [9, 450],
    [0, 0],
  ])('%i chips → ₪%i', (n, total) => {
    expect(priceLine(n, S).lineTotal).toBe(total);
  });

  it('freezes the price it was priced with (the snapshot: every chip at the base price)', () => {
    expect(priceLine(3, S)).toEqual({ unitPrice: 50, threshold: 3, priceAbove: 50, lineTotal: 150 });
  });

  it('is agorot-safe', () => {
    expect(priceLine(3, { unitPrice: 0.1 }).lineTotal).toBe(0.3);
    expect(orderTotal([{ lineTotal: 0.1 }, { lineTotal: 0.2 }])).toBe(0.3);
  });

  it('two apartments × 2 chips = 4 × the price', () => {
    expect(orderTotal([priceLine(2, S), priceLine(2, S)])).toBe(200);
  });

  it('formats shekels without trailing zeros', () => {
    expect(formatIls(50)).toBe('₪50');
    expect(formatIls(52.5)).toBe('₪52.5');
  });
});

describe('chipOrderDueAt — 72 hours of Sunday–Thursday, Israel time', () => {
  // 2026-11-15 is a Sunday. Israel is UTC+2 in November.
  it('Sunday 10:00 → Wednesday 10:00 (three full working days)', () => {
    const due = chipOrderDueAt(new Date('2026-11-15T08:00:00Z'));
    expect(due.toISOString()).toBe('2026-11-18T08:00:00.000Z');
  });

  it('Wednesday 10:00 → Wed 14h + Thu 24h, skips Fri/Sat, Sun 24h + Mon 10h → Monday 10:00', () => {
    const due = chipOrderDueAt(new Date('2026-11-18T08:00:00Z'));
    expect(due.toISOString()).toBe('2026-11-23T08:00:00.000Z');
  });

  it('a payment on Friday starts counting on Sunday 00:00', () => {
    const due = chipOrderDueAt(new Date('2026-11-20T10:00:00Z'));
    // Sunday 00:00 IL = Saturday 22:00 UTC; + 72h of Sun–Tue = Wednesday 00:00 IL.
    expect(due.toISOString()).toBe('2026-11-24T22:00:00.000Z');
  });

  it('a payment on Saturday also starts on Sunday 00:00', () => {
    expect(chipOrderDueAt(new Date('2026-11-21T15:00:00Z')).toISOString()).toBe('2026-11-24T22:00:00.000Z');
  });

  it('Thursday 23:00 → one hour Thursday, then Sun/Mon/Tue (71h) → Tuesday 23:00', () => {
    const due = chipOrderDueAt(new Date('2026-11-19T21:00:00Z'));
    expect(due.toISOString()).toBe('2026-11-24T21:00:00.000Z');
  });

  it('overdue only while still being assigned (paid) and past due', () => {
    const now = new Date('2026-11-20T00:00:00Z');
    expect(isChipOrderOverdue({ status: 'paid', due_at: '2026-11-19T00:00:00Z' }, now)).toBe(true);
    expect(isChipOrderOverdue({ status: 'paid', due_at: '2026-11-21T00:00:00Z' }, now)).toBe(false);
    // A legacy 'approved' row reads as paid.
    expect(isChipOrderOverdue({ status: 'approved', due_at: '2026-11-19T00:00:00Z' }, now)).toBe(true);
    expect(isChipOrderOverdue({ status: 'ready', due_at: '2026-11-19T00:00:00Z' }, now)).toBe(false);
    expect(isChipOrderOverdue({ status: 'paid', due_at: null }, now)).toBe(false);
  });
});

describe('chipOrderMatchStatus', () => {
  const phone = '+972521234567';
  it('owner whose phone is on file → תואם', () => {
    expect(chipOrderMatchStatus({ role: 'owner', orderPhoneE164: phone, ownerPhonesE164: [phone], ownerOnFile: true })).toBe('matched');
  });
  it('owner, another owner on file → לבדיקה', () => {
    expect(chipOrderMatchStatus({ role: 'owner', orderPhoneE164: phone, ownerPhonesE164: ['+972529999999'], ownerOnFile: true })).toBe('review');
  });
  it('owner, no owner on file → לשיוך', () => {
    expect(chipOrderMatchStatus({ role: 'owner', orderPhoneE164: phone, ownerPhonesE164: [], ownerOnFile: false })).toBe('unassigned');
  });
  it('tenant / operator → מסמך לבדיקה, even with a matching phone', () => {
    for (const role of ['tenant', 'operator'] as const) {
      expect(chipOrderMatchStatus({ role, orderPhoneE164: phone, ownerPhonesE164: [phone], ownerOnFile: true })).toBe('document_review');
    }
  });
  it('only tenant / operator attach a lease', () => {
    expect(needsLease('owner')).toBe(false);
    expect(needsLease('tenant')).toBe(true);
    expect(needsLease('operator')).toBe(true);
  });
});

describe('the stage of one apartment — the Orders tab and the "פרטי הזמנה" section', () => {
  it('ממתין לשיוך → שויכו X מתוך Y → שויך → מוכן לאיסוף', () => {
    expect(chipOrderStage('paid', 0, 3)).toBe('awaiting');
    expect(chipOrderStage('paid', 2, 3)).toBe('partial');
    expect(chipOrderStage('paid', 3, 3)).toBe('assigned');
    // More than ordered is allowed — still "שויך".
    expect(chipOrderStage('paid', 4, 3)).toBe('assigned');
    expect(chipOrderStage('ready', 3, 3)).toBe('ready');
    expect(chipOrderStage('approved', 1, 2)).toBe('partial');
    expect(chipOrderStageLabel('awaiting', 0, 3)).toBe('ממתין לשיוך');
    expect(chipOrderStageLabel('partial', 2, 3)).toBe('שויכו 2 מתוך 3');
    expect(chipOrderStageLabel('assigned', 3, 3)).toBe('שויך');
    expect(chipOrderStageLabel('ready', 3, 3)).toBe('מוכן לאיסוף');
    // A collected order (in the tab only when it was made at the reception):
    // "נאסף", whatever its chips say — a chip disabled later reopens nothing.
    expect(chipOrderStage('collected', 2, 2)).toBe('collected');
    expect(chipOrderStage('collected', 0, 2)).toBe('collected');
    expect(chipOrderStageLabel('collected', 2, 2)).toBe('נאסף');
  });

  it('open = still in the Orders tab: paid (and legacy approved) or ready', () => {
    expect(['pending_payment', 'paid', 'approved', 'ready', 'collected', 'rejected'].filter((x) => isOpenChipOrder(x as never)))
      .toEqual(['paid', 'approved', 'ready']);
  });
});

describe('assignToOrderLines — which order line a new number of the orderer\'s block goes to', () => {
  const a = { item_id: 'a', chips_count: 2, chips_linked: 1 };
  const b = { item_id: 'b', chips_count: 1, chips_linked: 0 };
  it('fills the lines in order (oldest order first), up to what each still misses', () => {
    expect([...assignToOrderLines(['1', '2'], [a, b]).entries()]).toEqual([['1', 'a'], ['2', 'b']]);
  });
  it('the surplus goes to the LAST line (more than ordered is allowed)', () => {
    expect(pendingPerLine(['1', '2', '3', '4'], [a, b])).toEqual({ a: 1, b: 3 });
    expect(pendingPerLine(['1', '2'], [{ ...a, chips_linked: 2 }])).toEqual({ a: 2 });
  });
  it('no open order → nothing is linked', () => {
    expect(assignToOrderLines(['1'], []).size).toBe(0);
  });
});

describe('chipOrderMessage — the four messages', () => {
  const base = { fullName: 'דנה כהן', orderNumber: 1001, apartments: ['1210'], trackUrl: 'https://x.test/chip-order/track/t' };
  const DOC = 'https://docs.example.test/d/abc';

  it('paid: tracking link, and the link of its Morning document when it was issued already', () => {
    const m = chipOrderMessage({ ...base, kind: 'paid', invoiceUrl: DOC });
    const text = chipOrderWhatsAppText(m);
    expect(m.subject).toContain('1001');
    expect(text).toContain(base.trackUrl);
    expect(text).toContain(`החשבונית / הקבלה: ${DOC}`);
    expect(m.links).toEqual([base.trackUrl, DOC]);
  });

  it('paid, no document yet: "it will reach you by email" only when it will (receiptByEmail) — and never "from the processor"', () => {
    const byEmail = chipOrderWhatsAppText(chipOrderMessage({ ...base, kind: 'paid', receiptByEmail: true }));
    expect(byEmail).toContain('החשבונית / הקבלה תישלח אליך במייל בנפרד.');
    for (const receiptByEmail of [false, undefined]) {
      const text = chipOrderWhatsAppText(chipOrderMessage({ ...base, kind: 'paid', receiptByEmail }));
      expect(text).not.toContain('החשבונית');
      expect(text).not.toContain('חברת הסליקה');
    }
    expect(byEmail).not.toContain('חברת הסליקה');
  });

  it('paid carries the due date (there is no separate "approved" message any more)', () => {
    const text = chipOrderWhatsAppText(chipOrderMessage({ ...base, kind: 'paid', dueText: 'יום רביעי, 18.11.2026' }));
    expect(text).toContain('מועד היעד להכנה: יום רביעי, 18.11.2026.');
    expect(text).not.toContain('ממתינה לבדיקה');
  });

  it('ready carries the pickup place and hours from the settings', () => {
    const text = chipOrderWhatsAppText(chipOrderMessage({ ...base, kind: 'ready', pickupText: 'לובי, א׳–ה׳ 9–13' }));
    expect(text).toContain('לובי, א׳–ה׳ 9–13');
  });

  it('rejected carries the reason and the refund state', () => {
    const refunded = chipOrderWhatsAppText(chipOrderMessage({ ...base, kind: 'rejected', rejectReason: 'אין חוזה בתוקף', refundStatus: 'refunded' }));
    expect(refunded).toContain('אין חוזה בתוקף');
    expect(refunded).toContain('זוכה במלואו');
    const manual = chipOrderWhatsAppText(chipOrderMessage({ ...base, kind: 'rejected', rejectReason: 'x', refundStatus: 'manual_required' }));
    expect(manual).toContain('דורש זיכוי ידני');
  });

  it('refunded: how much went back, to the card — and whether the order was closed or its chips disabled', () => {
    const closed = chipOrderMessage({ ...base, kind: 'refunded', refundedAmount: 150, closedByRefund: true });
    expect(closed.subject).toBe('הזמנת הצ׳יפים זוכתה — הזמנה 1001');
    const text = chipOrderWhatsAppText(closed);
    expect(text).toContain('זוכתה: ₪150 הוחזר לכרטיס שבו שילמת.');
    expect(text).toContain('ההזמנה בוטלה.');
    expect(text).toContain(base.trackUrl);
    const disabled = chipOrderWhatsAppText(chipOrderMessage({ ...base, kind: 'refunded', refundedAmount: null, closedByRefund: false, chipsDisabled: true }));
    expect(disabled).toContain('זוכתה: התשלום הוחזר לכרטיס');
    expect(disabled).toContain('הצ׳יפים של ההזמנה הושבתו.');
    expect(disabled).not.toContain('ההזמנה בוטלה.');
  });

  // Regression (review, 26/11): a refund made in the PayPlus dashboard of an
  // order that stays open or collected disables no chip — the message must
  // not say it did.
  it('refunded with NO chip disabled (a refund PayPlus reported) and the order not closed: nothing is said about the chips', () => {
    for (const chipsDisabled of [false, undefined]) {
      const text = chipOrderWhatsAppText(chipOrderMessage({ ...base, kind: 'refunded', refundedAmount: 80, closedByRefund: false, chipsDisabled }));
      expect(text).toContain('זוכתה: ₪80 הוחזר לכרטיס שבו שילמת.');
      expect(text).not.toContain('הושבתו');
      expect(text).not.toContain('ההזמנה בוטלה.');
      expect(text).toContain(base.trackUrl);
    }
    // Closed by the refund: it says so, whatever the chips.
    const closed = chipOrderWhatsAppText(chipOrderMessage({ ...base, kind: 'refunded', refundedAmount: 80, closedByRefund: true, chipsDisabled: false }));
    expect(closed).toContain('ההזמנה בוטלה.');
    expect(closed).not.toContain('הושבתו');
  });

  it('names several apartments', () => {
    expect(chipOrderMessage({ ...base, apartments: ['1210', '520'], kind: 'paid' }).lines[1]).toContain('דירות 1210, 520');
  });

  it('a test order: every message starts with [בדיקה], no invoice, and a rejection or a refund says nothing was charged', () => {
    for (const kind of ['paid', 'ready', 'rejected', 'refunded'] as const) {
      const m = chipOrderMessage({ ...base, kind, isTest: true, rejectReason: 'בדיקה', refundStatus: 'not_required' });
      expect(m.subject.startsWith('[בדיקה] ')).toBe(true);
      expect(chipOrderWhatsAppText(m).startsWith('[בדיקה] ')).toBe(true);
    }
    // Even if a document URL were somehow present, a test order never links one, nor promises one by email.
    const paid = chipOrderMessage({ ...base, kind: 'paid', isTest: true, invoiceUrl: DOC, receiptByEmail: true });
    const text = chipOrderWhatsAppText(paid);
    expect(text).not.toContain(DOC);
    expect(text).not.toContain('החשבונית');
    expect(paid.links).toEqual([base.trackUrl]);
    const rejected = chipOrderWhatsAppText(chipOrderMessage({ ...base, kind: 'rejected', isTest: true, refundStatus: 'not_required' }));
    expect(rejected).toContain('לא בוצע חיוב');
    expect(rejected).not.toContain('Grow');
    const refunded = chipOrderWhatsAppText(chipOrderMessage({ ...base, kind: 'refunded', isTest: true, refundedAmount: 50 }));
    expect(refunded).toContain('הזמנת בדיקה — לא בוצע חיוב אמיתי');
    expect(refunded).not.toContain('₪50');
  });

  it('a real order never carries the test mark', () => {
    const m = chipOrderMessage({ ...base, kind: 'paid', receiptByEmail: true });
    expect(m.subject).not.toContain('[בדיקה]');
    expect(chipOrderWhatsAppText(m)).not.toContain('[בדיקה]');
    expect(chipOrderWhatsAppText(m)).toContain('החשבונית / הקבלה תישלח אליך במייל בנפרד.');
  });
});

describe('leaseFileProblem — PDF or image, up to 10MB', () => {
  it('accepts a PDF and a photo', () => {
    expect(leaseFileProblem({ name: 'חוזה.pdf', size: 1000, type: 'application/pdf' })).toBeNull();
    expect(leaseFileProblem({ name: 'scan.JPG', size: 1000, type: 'image/jpeg' })).toBeNull();
  });
  it('refuses Word, an empty file and 10MB + 1', () => {
    expect(leaseFileProblem({ name: 'a.docx', size: 10, type: '' })).not.toBeNull();
    expect(leaseFileProblem({ name: 'a.pdf', size: 0, type: 'application/pdf' })).not.toBeNull();
    expect(leaseFileProblem({ name: 'a.pdf', size: 10 * 1024 * 1024 + 1, type: 'application/pdf' })).not.toBeNull();
  });
});
