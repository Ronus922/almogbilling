import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/email/send', () => ({ sendWithRetry: vi.fn() }));
vi.mock('@/lib/notify/signature', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/notify/signature')>();
  return {
    ...real,
    getSignature: vi.fn(async () => ({ inviter: 'בניין', manager: 'מנהל', phone: '050' })),
  };
});

import { sendWithRetry } from '@/lib/email/send';
import { sendBulkStatusChangeNotification } from '@/services/email';
import { legalStatusBulkChangeTemplate } from '@/templates/email/legal-status-bulk-change';
import { legalStatusBulkBodySchema, BULK_LEGAL_STATUS_MAX_DEBTORS } from '@/lib/validation/requests';

const send = vi.mocked(sendWithRetry);

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

const CHANGES = [
  { apartment_number: '3', owner_name: 'דוד לוי', old_status_name: 'רגיל' },
  { apartment_number: '12', owner_name: null, old_status_name: null },
  { apartment_number: '101', owner_name: '<b>x</b> & "y"', old_status_name: 'מכתב התראה' },
];

describe('legalStatusBulkChangeTemplate — one mail for the whole bulk change', () => {
  const render = (n: number) =>
    legalStatusBulkChangeTemplate({
      newStatusName: 'לטיפול משפטי',
      changes: CHANGES.slice(0, n).map((c) => ({
        apartmentNumber: c.apartment_number, ownerName: c.owner_name, oldStatusName: c.old_status_name,
      })),
      changedByName: 'אדמין',
      changedAt: '1 בינו׳ 2026, 10:00',
      signatureHtml: '<i>sig</i>',
      signatureText: 'sig',
    });

  it('subject counts the apartments; one apartment reads "דירה אחת"', () => {
    expect(render(3).subject).toBe('עדכון סטטוס משפטי — 3 דירות');
    expect(render(1).subject).toBe('עדכון סטטוס משפטי — דירה אחת');
  });

  it('lists every apartment with old ← new, in the text part too', () => {
    const { html, text } = render(3);
    for (const apt of ['3', '12', '101']) expect(html).toContain(`>${apt}</td>`);
    expect(html).toContain('רגיל &larr; לטיפול משפטי');
    expect(html).toContain('(ללא סטטוס) &larr; לטיפול משפטי');
    expect(text).toContain('דירה 3 · דוד לוי · רגיל ← לטיפול משפטי');
    expect(text).toContain('דירה 12 · (ללא סטטוס) ← לטיפול משפטי');
    expect(text).toContain('הסטטוס המשפטי של 3 דירות עודכן ל-לטיפול משפטי');
    expect(text).toContain('עודכן על ידי: אדמין');
  });

  it('escapes owner names in the HTML', () => {
    const { html } = render(3);
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt; &amp; &quot;y&quot;');
    expect(html).not.toContain('<b>x</b>');
  });
});

describe('sendBulkStatusChangeNotification — ONE mail per recipient, not per apartment', () => {
  it('sends a single message per address carrying every apartment', async () => {
    send.mockResolvedValue(undefined as never);
    const r = await sendBulkStatusChangeNotification({
      new_status_name: 'מכתב התראה', changes: CHANGES, changed_by_name: 'אדמין',
      recipients: ['a@example.com', 'b@example.com'],
    });
    expect(r).toEqual({ sent: 2, failed: 0 });
    expect(send).toHaveBeenCalledTimes(2); // 2 recipients × 1 mail — not 2 × 3 apartments
    const first = send.mock.calls[0]![0];
    expect(first.to).toBe('a@example.com');
    expect(first.subject).toBe('עדכון סטטוס משפטי — 3 דירות');
    for (const apt of ['3', '12', '101']) expect(first.text).toContain(`דירה ${apt}`);
    expect(send.mock.calls[1]![0].to).toBe('b@example.com');
  });

  it('a failing address is logged and skipped — the others still get it, nothing throws', async () => {
    send.mockRejectedValueOnce(new Error('535')).mockResolvedValueOnce(undefined as never);
    const r = await sendBulkStatusChangeNotification({
      new_status_name: 'מכתב התראה', changes: CHANGES, changed_by_name: 'אדמין',
      recipients: ['bad@example.com', 'ok@example.com'],
    });
    expect(r).toEqual({ sent: 1, failed: 1 });
  });

  it('no recipients, or nothing changed → nothing is sent', async () => {
    expect(await sendBulkStatusChangeNotification({
      new_status_name: 'x', changes: CHANGES, changed_by_name: 'a', recipients: [],
    })).toEqual({ sent: 0, failed: 0 });
    expect(await sendBulkStatusChangeNotification({
      new_status_name: 'x', changes: [], changed_by_name: 'a', recipients: ['a@example.com'],
    })).toEqual({ sent: 0, failed: 0 });
    expect(send).not.toHaveBeenCalled();
  });
});

describe('legalStatusBulkBodySchema', () => {
  const A = '00000000-0000-4000-8000-000000000001';
  const B = '00000000-0000-4000-8000-000000000002';
  const S = '00000000-0000-4000-8000-0000000000aa';

  it('accepts ids + a status and de-duplicates the ids', () => {
    const r = legalStatusBulkBodySchema.safeParse({ debtor_ids: [A, B, A], status_id: S });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.debtor_ids).toEqual([A, B]);
  });

  it('rejects an empty list, a non-uuid, a missing/null/invalid status, and a list over the cap', () => {
    expect(legalStatusBulkBodySchema.safeParse({ debtor_ids: [], status_id: S }).success).toBe(false);
    expect(legalStatusBulkBodySchema.safeParse({ debtor_ids: ['x'], status_id: S }).success).toBe(false);
    expect(legalStatusBulkBodySchema.safeParse({ status_id: S }).success).toBe(false);
    expect(legalStatusBulkBodySchema.safeParse({ debtor_ids: [A] }).success).toBe(false);
    expect(legalStatusBulkBodySchema.safeParse({ debtor_ids: [A], status_id: null }).success).toBe(false); // bulk never clears
    expect(legalStatusBulkBodySchema.safeParse({ debtor_ids: [A], status_id: 'nope' }).success).toBe(false);
    const many = Array.from({ length: BULK_LEGAL_STATUS_MAX_DEBTORS + 1 }, (_, i) =>
      `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    expect(legalStatusBulkBodySchema.safeParse({ debtor_ids: many, status_id: S }).success).toBe(false);
  });
});
