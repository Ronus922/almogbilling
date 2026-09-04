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
import { sendStatusChangeNotification } from '@/services/email';
import { buildLegalStatusRecipients } from '@/lib/notify/legalStatusRecipients';
import { STATUS_LEGAL_CARE, STATUS_WARNING } from '@/lib/constants/statuses';

const send = vi.mocked(sendWithRetry);

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('buildLegalStatusRecipients — who gets the legal-status email', () => {
  it('empty legal_contact → skipped silently, only the status addresses remain', () => {
    expect(buildLegalStatusRecipients({
      statusEmails: ['A@Example.com'], newStatusName: STATUS_LEGAL_CARE, legalEmail: '',
    })).toEqual(['a@example.com']);
    expect(buildLegalStatusRecipients({
      statusEmails: ['a@example.com'], newStatusName: STATUS_LEGAL_CARE, legalEmail: '   ',
    })).toEqual(['a@example.com']);
    expect(buildLegalStatusRecipients({
      statusEmails: ['a@example.com'], newStatusName: STATUS_LEGAL_CARE, legalEmail: undefined,
    })).toEqual(['a@example.com']);
  });

  it('moved INTO a legal status + lawyer configured → lawyer is added (normalised)', () => {
    expect(buildLegalStatusRecipients({
      statusEmails: ['a@example.com'], newStatusName: STATUS_LEGAL_CARE, legalEmail: ' Lawyer@Firm.co.il ',
    })).toEqual(['a@example.com', 'lawyer@firm.co.il']);
  });

  it('non-legal status → the lawyer is NOT added even when configured', () => {
    expect(buildLegalStatusRecipients({
      statusEmails: ['a@example.com'], newStatusName: STATUS_WARNING, legalEmail: 'lawyer@firm.co.il',
    })).toEqual(['a@example.com']);
  });

  it('no status addresses + empty lawyer → nothing to send', () => {
    expect(buildLegalStatusRecipients({ statusEmails: null, newStatusName: STATUS_LEGAL_CARE, legalEmail: '' })).toEqual([]);
    expect(buildLegalStatusRecipients({ statusEmails: ['', '  '], newStatusName: null, legalEmail: null })).toEqual([]);
  });

  it('de-duplicates: the lawyer already on the status list is sent once', () => {
    expect(buildLegalStatusRecipients({
      statusEmails: ['Lawyer@Firm.co.il'], newStatusName: STATUS_LEGAL_CARE, legalEmail: 'lawyer@firm.co.il',
    })).toEqual(['lawyer@firm.co.il']);
  });
});

describe('sendStatusChangeNotification — real send through sendWithRetry', () => {
  const base = {
    apartment_number: '12',
    owner_name: 'ישראל ישראלי',
    old_status_name: 'התראה',
    new_status_name: 'טיפול משפטי',
    changed_by_name: 'רונן',
  };

  it('no recipients → no send at all', async () => {
    const r = await sendStatusChangeNotification({ ...base, recipients: [] });
    expect(r).toEqual({ sent: 0, failed: 0 });
    expect(send).not.toHaveBeenCalled();
  });

  it('renders subject + body once and sends to every recipient', async () => {
    send.mockResolvedValue({ messageId: 'm', attempts: 1 });
    const r = await sendStatusChangeNotification({ ...base, recipients: ['a@example.com', 'b@example.com'] });
    expect(r).toEqual({ sent: 2, failed: 0 });
    expect(send).toHaveBeenCalledTimes(2);
    const [first, second] = send.mock.calls.map((c) => c[0]);
    expect(first.to).toBe('a@example.com');
    expect(second.to).toBe('b@example.com');
    expect(first.subject).toBe('עדכון סטטוס משפטי — דירה 12');
    for (const part of [first.text, first.html]) {
      expect(part).toContain('12');
      expect(part).toContain('התראה');
      expect(part).toContain('טיפול משפטי');
      expect(part).toContain('רונן');
      expect(part).toContain('ישראל ישראלי');
    }
    expect(first.html).toContain('dir="rtl"');
    expect(first.text).toMatch(/תאריך: \S+/);
  });

  it('a null previous status reads as "(ללא סטטוס)"', async () => {
    send.mockResolvedValue({ messageId: 'm', attempts: 1 });
    await sendStatusChangeNotification({ ...base, old_status_name: null, recipients: ['a@example.com'] });
    expect(send.mock.calls[0][0].text).toContain('סטטוס קודם: (ללא סטטוס)');
  });

  it('one address failing does not stop the others and never throws', async () => {
    send.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({ messageId: 'm', attempts: 1 });
    const r = await sendStatusChangeNotification({ ...base, recipients: ['bad@example.com', 'ok@example.com'] });
    expect(r).toEqual({ sent: 1, failed: 1 });
    expect(send).toHaveBeenCalledTimes(2);
  });
});
