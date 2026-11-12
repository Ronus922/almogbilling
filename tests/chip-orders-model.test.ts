import { describe, expect, it } from 'vitest';
import {
  allChipsLinked, chipOrderDueAt, formatIls, isChipOrderOverdue, needsLease, orderTotal, priceLine,
} from '@/lib/chipOrders/model';
import { chipOrderMatchStatus } from '@/lib/chipOrders/match';
import { chipOrderMessage, chipOrderWhatsAppText } from '@/lib/chipOrders/messages';
import { leaseFileProblem } from '@/lib/chipOrders/lease';

// Chip orders (12/11/2026) — the pure rules: the price per apartment, the
// 72-working-hour due date, the match status and the four messages.

const S = { unitPrice: 50, threshold: 2, priceAbove: 70 };

describe('priceLine — chips 1..X at the base price, X+1 onwards above it, per apartment', () => {
  it.each([
    [1, 50],
    [2, 100],
    [3, 170],
    [4, 240],
    [0, 0],
  ])('%i chips → ₪%i', (n, total) => {
    expect(priceLine(n, S).lineTotal).toBe(total);
  });

  it('freezes the rule it was priced with (the snapshot)', () => {
    expect(priceLine(3, S)).toEqual({ unitPrice: 50, threshold: 2, priceAbove: 70, lineTotal: 170 });
  });

  it('threshold 0 = every chip at the higher price', () => {
    expect(priceLine(2, { ...S, threshold: 0 }).lineTotal).toBe(140);
  });

  it('is agorot-safe', () => {
    expect(priceLine(3, { unitPrice: 0.1, threshold: 2, priceAbove: 0.2 }).lineTotal).toBe(0.4);
    expect(orderTotal([{ lineTotal: 0.1 }, { lineTotal: 0.2 }])).toBe(0.3);
  });

  it('prices each apartment on its own (two apartments × 2 chips = 4 × base)', () => {
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

  it('approval on Friday starts counting on Sunday 00:00', () => {
    const due = chipOrderDueAt(new Date('2026-11-20T10:00:00Z'));
    // Sunday 00:00 IL = Saturday 22:00 UTC; + 72h of Sun–Tue = Wednesday 00:00 IL.
    expect(due.toISOString()).toBe('2026-11-24T22:00:00.000Z');
  });

  it('approval on Saturday also starts on Sunday 00:00', () => {
    expect(chipOrderDueAt(new Date('2026-11-21T15:00:00Z')).toISOString()).toBe('2026-11-24T22:00:00.000Z');
  });

  it('Thursday 23:00 → one hour Thursday, then Sun/Mon/Tue (71h) → Tuesday 23:00', () => {
    const due = chipOrderDueAt(new Date('2026-11-19T21:00:00Z'));
    expect(due.toISOString()).toBe('2026-11-24T21:00:00.000Z');
  });

  it('overdue only while approved and past due', () => {
    const now = new Date('2026-11-20T00:00:00Z');
    expect(isChipOrderOverdue({ status: 'approved', due_at: '2026-11-19T00:00:00Z' }, now)).toBe(true);
    expect(isChipOrderOverdue({ status: 'approved', due_at: '2026-11-21T00:00:00Z' }, now)).toBe(false);
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

describe('allChipsLinked', () => {
  it('true only when every line has its chips', () => {
    const on = { status: 'active' };
    const off = { status: 'inactive' };
    expect(allChipsLinked([{ chips_count: 2, linked_chips: [on, on] }, { chips_count: 1, linked_chips: [on] }])).toBe(true);
    expect(allChipsLinked([{ chips_count: 2, linked_chips: [on] }])).toBe(false);
    // A deactivated chip no longer counts as delivered.
    expect(allChipsLinked([{ chips_count: 2, linked_chips: [on, off] }])).toBe(false);
    expect(allChipsLinked([])).toBe(false);
  });
});

describe('chipOrderMessage — the four messages', () => {
  const base = { fullName: 'דנה כהן', orderNumber: 1001, apartments: ['1210'], trackUrl: 'https://x.test/chip-order/track/t' };

  it('paid: tracking link, and the invoice link when Grow sent it', () => {
    const m = chipOrderMessage({ ...base, kind: 'paid', invoiceUrl: 'https://meshulam.co.il/s/abc' });
    const text = chipOrderWhatsAppText(m);
    expect(m.subject).toContain('1001');
    expect(text).toContain(base.trackUrl);
    expect(text).toContain('https://meshulam.co.il/s/abc');
  });

  it('approved carries the due date', () => {
    const text = chipOrderWhatsAppText(chipOrderMessage({ ...base, kind: 'approved', dueText: 'יום רביעי, 18.11.2026' }));
    expect(text).toContain('יום רביעי, 18.11.2026');
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

  it('names several apartments', () => {
    expect(chipOrderMessage({ ...base, apartments: ['1210', '520'], kind: 'paid' }).lines[1]).toContain('דירות 1210, 520');
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
