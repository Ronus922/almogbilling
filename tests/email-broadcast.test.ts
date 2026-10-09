import { describe, expect, it } from 'vitest';
import {
  interpolateTemplate, interpolateBroadcastTemplate, emailSubjectError, toSubjectLine,
  EMAIL_SUBJECT_MAX_CHARS,
} from '@/lib/whatsapp-template';
import {
  validateBroadcastAttachmentSet, EMAIL_ATTACHMENTS_MAX_TOTAL_BYTES, WHATSAPP_ATTACHMENT_LIMITS,
} from '@/lib/constants/whatsappAttachments';
import { broadcastEmailTemplate } from '@/templates/email/broadcast';
import { smtpEmailTransport, MockEmailTransport } from '@/lib/wa-queue/email';
import type { SmtpHandle } from '@/lib/email/smtp-core';

// The email channel of a broadcast (09/10/2026) — the pure parts: the subject
// goes through the SAME placeholder functions as the body, the 25MB total that
// one email can carry, the email body itself, and how an SMTP failure is read.
// The worker/queue side runs against a database in tests/wa-queue-email.test.ts.

const MB = 1024 * 1024;

describe('placeholders — one engine for body and subject', () => {
  const debtor = { owner_name: 'ישראל ישראלי', apartment_number: '1210', total_debt: 12500, management_fees: 300, hot_water_debt: 50 };

  it('the subject interpolates with the same function as the body', () => {
    const subject = 'עדכון חוב לדירה {{apartment}} — {{name}}';
    expect(interpolateTemplate(subject, debtor)).toBe('עדכון חוב לדירה 1210 — ישראל ישראלי');
    expect(interpolateTemplate('יתרה: {{debt}}', debtor)).toBe('יתרה: ₪ 12,500');
  });

  it('a consolidated (debt) subject sees the grand totals, like text outside the block', () => {
    const rendered = interpolateBroadcastTemplate('{{name}} — סה״כ {{total_debt}}', {
      name: 'דנה',
      apartments: [
        { apartment_number: '520', total_debt: 100 },
        { apartment_number: '1210', total_debt: 250 },
      ],
    });
    expect(rendered.text).toBe('דנה — סה״כ ₪ 350');
  });

  it('a subject is one header line — breaks and runs of spaces collapse', () => {
    expect(toSubjectLine('שלום\nעולם   יקר \r\n')).toBe('שלום עולם יקר');
  });

  it('subject rules: length cap and no repeating block', () => {
    expect(emailSubjectError('תזכורת תשלום {{name}}')).toBeNull();
    expect(emailSubjectError('א'.repeat(EMAIL_SUBJECT_MAX_CHARS))).toBeNull();
    expect(emailSubjectError('א'.repeat(EMAIL_SUBJECT_MAX_CHARS + 1))).toMatch(/ארוך מדי/);
    expect(emailSubjectError('{{#apartments}}{{apartment}}{{/apartments}}')).toMatch(/קטע חוזר/);
  });
});

describe('attachments — 25MB total on the email channel', () => {
  const files = (...mb: number[]) => mb.map((m) => ({ size: m * MB }));

  it('up to 25MB in total is accepted for an email broadcast', () => {
    expect(EMAIL_ATTACHMENTS_MAX_TOTAL_BYTES).toBe(25 * MB);
    expect(validateBroadcastAttachmentSet(files(10, 15), [], 10, EMAIL_ATTACHMENTS_MAX_TOTAL_BYTES)).toBeNull();
  });

  it('over 25MB is refused for email with a Hebrew message', () => {
    expect(validateBroadcastAttachmentSet(files(10, 15.5), [], 10, EMAIL_ATTACHMENTS_MAX_TOTAL_BYTES))
      .toBe('סך הקבצים המצורפים חורג מ-25MB');
  });

  it('WhatsApp keeps its own 100MB total (the default is unchanged)', () => {
    expect(validateBroadcastAttachmentSet(files(40, 40))).toBeNull();
    expect(validateBroadcastAttachmentSet(files(60, 50)))
      .toBe(`סך הקבצים המצורפים חורג מ-${WHATSAPP_ATTACHMENT_LIMITS.maxTotalBytes / MB}MB`);
  });

  it('the file count cap is the same 10 on both channels', () => {
    expect(validateBroadcastAttachmentSet(files(...Array(11).fill(0.1)), [], 10, EMAIL_ATTACHMENTS_MAX_TOTAL_BYTES))
      .toBe('ניתן לצרף עד 10 קבצים');
  });
});

describe('broadcastEmailTemplate', () => {
  const site = 'https://almog-haifa.co.il';

  it('escapes the operator text and keeps its line breaks, RTL', () => {
    const r = broadcastEmailTemplate({ subject: 'נושא <b>', body: 'שלום <script>x</script>\nשורה שנייה', site });
    expect(r.subject).toBe('נושא <b>');
    expect(r.html).toContain('dir="rtl"');
    expect(r.html).toContain('שלום &lt;script&gt;x&lt;/script&gt;<br>שורה שנייה');
    expect(r.html).not.toContain('<script>');
    expect(r.html).toContain('<title>נושא &lt;b&gt;</title>');
  });

  it('plain-text part carries the body and the footer (deliverability)', () => {
    const r = broadcastEmailTemplate({ subject: 's', body: 'גוף ההודעה', site });
    expect(r.text).toContain('גוף ההודעה');
    expect(r.text).toContain(site);
    expect(r.html).toContain('almog-haifa.co.il');
  });
});

describe('smtpEmailTransport — how an SMTP failure is classified', () => {
  const handle = (sendMail: () => Promise<unknown>): (() => Promise<SmtpHandle>) =>
    async () => ({ transporter: { sendMail } as unknown as SmtpHandle['transporter'], from: '"x" <x@gmail.com>' });
  const msg = { to: 'a@b.co', subject: 's', text: 't', html: '<p>t</p>', attachments: [] };

  it('accepted → the SMTP message id', async () => {
    const t = smtpEmailTransport(handle(async () => ({ messageId: '<m1@x>' })));
    await expect(t.send(msg)).resolves.toEqual({ ok: true, messageId: '<m1@x>' });
  });

  it('EAUTH / 535 → an auth failure (never retried)', async () => {
    const t = smtpEmailTransport(handle(async () => { throw Object.assign(new Error('Invalid login'), { code: 'EAUTH', responseCode: 535 }); }));
    const r = await t.send(msg);
    expect(r).toMatchObject({ ok: false, authFailure: true, transient: false });
  });

  it('a network blip or SMTP 4xx → transient (retried)', async () => {
    const t = smtpEmailTransport(handle(async () => { throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }); }));
    await expect(t.send(msg)).resolves.toMatchObject({ ok: false, authFailure: false, transient: true });
    const t2 = smtpEmailTransport(handle(async () => { throw Object.assign(new Error('try later'), { responseCode: 421 }); }));
    await expect(t2.send(msg)).resolves.toMatchObject({ ok: false, transient: true });
  });

  it('SMTP 5xx (e.g. a rejected mailbox) → permanent', async () => {
    const t = smtpEmailTransport(handle(async () => { throw Object.assign(new Error('no such user'), { responseCode: 550, response: '550 5.1.1 no such user' }); }));
    const r = await t.send(msg);
    expect(r).toMatchObject({ ok: false, authFailure: false, transient: false });
    expect(r.ok === false && r.message).toContain('550 5.1.1');
  });

  it('the mock transport records instead of sending, with scripted failures', async () => {
    const t = new MockEmailTransport({ fail: { 'bad@x.co': { message: 'boom' } } });
    await expect(t.send(msg)).resolves.toMatchObject({ ok: true });
    await expect(t.send({ ...msg, to: 'bad@x.co' })).resolves.toMatchObject({ ok: false, message: 'boom' });
    expect(t.sent.map((m) => m.to)).toEqual(['a@b.co']);
  });
});
