import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Part A: the throttled, bell-only admin alert ─────────────────────────────
vi.mock('@/lib/db/appSettings', () => ({ claimSmtpAuthAlertSlot: vi.fn() }));
vi.mock('@/lib/db/users', () => ({ listActiveAdmins: vi.fn() }));
vi.mock('@/lib/db/notifications', () => ({ createNotification: vi.fn() }));
// ── Part B: send.ts wiring (transporter + alert are mocked, nothing hits SMTP)
vi.mock('@/lib/email/transporter', () => ({ getTransporter: vi.fn() }));
vi.mock('@/lib/email/authAlert', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/email/authAlert')>();
  return { ...real, notifyAdminsOfSmtpAuthFailure: vi.fn(async () => undefined) };
});

import { claimSmtpAuthAlertSlot } from '@/lib/db/appSettings';
import { listActiveAdmins } from '@/lib/db/users';
import { createNotification } from '@/lib/db/notifications';
import { getTransporter } from '@/lib/email/transporter';
import { notifyAdminsOfSmtpAuthFailure, SMTP_AUTH_ALERT_MESSAGE } from '@/lib/email/authAlert';
import { sendWithRetry, isAuthFailure } from '@/lib/email/send';
import { NOTIFICATION_REGISTRY } from '@/lib/notifications/registry';

const claim = vi.mocked(claimSmtpAuthAlertSlot);
const admins = vi.mocked(listActiveAdmins);
const insert = vi.mocked(createNotification);
const transporter = vi.mocked(getTransporter);
const alert = vi.mocked(notifyAdminsOfSmtpAuthFailure);

// notifyAdminsOfSmtpAuthFailure is mocked module-wide for Part B; Part A needs
// the real implementation, so pull it straight from the source file.
const realAlert = async () => {
  const mod = await vi.importActual<typeof import('@/lib/email/authAlert')>('@/lib/email/authAlert');
  return mod.notifyAdminsOfSmtpAuthFailure;
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
});

describe('smtp_auth_failed — registry contract', () => {
  it('is bell-only: the "email is broken" alert can never email', () => {
    expect(NOTIFICATION_REGISTRY.smtp_auth_failed.channels).toEqual(['inapp']);
    expect(NOTIFICATION_REGISTRY.smtp_auth_failed.sourceModule).toBe('system');
  });
});

describe('notifyAdminsOfSmtpAuthFailure — throttle', () => {
  it('throttled (slot not claimed) → nobody is looked up, nothing is inserted', async () => {
    claim.mockResolvedValueOnce(null);
    const run = await realAlert();
    await run();
    expect(claim).toHaveBeenCalledTimes(1);
    expect(admins).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it('slot claimed → exactly one bell row per active admin, lowercase entity type, no email fields', async () => {
    claim.mockResolvedValueOnce({ at: '2026-09-04T10:00:00+00:00' });
    admins.mockResolvedValueOnce([{ id: 'u1', name: 'א' }, { id: 'u2', name: 'ב' }]);
    insert.mockResolvedValue(null);
    const run = await realAlert();
    await run();
    expect(insert).toHaveBeenCalledTimes(2);
    const first = insert.mock.calls[0][0];
    expect(first).toMatchObject({
      userId: 'u1',
      type: 'smtp_auth_failed',
      message: SMTP_AUTH_ALERT_MESSAGE,
      sourceModule: 'system',
      sourceEntityType: 'smtp_settings',
      priority: 'urgent',
      actionUrl: '/settings',
      dedupeKey: 'smtp_auth_failed:u1:2026-09-04T10:00:00+00:00',
    });
    expect(first.sourceEntityType).toBe(first.sourceEntityType?.toLowerCase());
    expect(insert.mock.calls[1][0].userId).toBe('u2');
  });

  it('two failures inside the window → one claim wins, the other is silent', async () => {
    claim.mockResolvedValueOnce({ at: '2026-09-04T10:00:00+00:00' }).mockResolvedValueOnce(null);
    admins.mockResolvedValue([{ id: 'u1', name: 'א' }]);
    insert.mockResolvedValue(null);
    const run = await realAlert();
    await run();
    await run();
    expect(admins).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it('never throws — a broken insert is logged, the other admins still get theirs', async () => {
    claim.mockResolvedValueOnce({ at: 'x' });
    admins.mockResolvedValueOnce([{ id: 'u1', name: 'א' }, { id: 'u2', name: 'ב' }]);
    insert.mockRejectedValueOnce(new Error('db down')).mockResolvedValueOnce(null);
    const run = await realAlert();
    await expect(run()).resolves.toBeUndefined();
    expect(insert).toHaveBeenCalledTimes(2);
  });

  it('never throws — even the claim itself failing is swallowed', async () => {
    claim.mockRejectedValueOnce(new Error('db down'));
    const run = await realAlert();
    await expect(run()).resolves.toBeUndefined();
    expect(insert).not.toHaveBeenCalled();
  });
});

describe('isAuthFailure', () => {
  it('EAUTH / 534 / 535 are auth failures; transient + other 5xx are not', () => {
    expect(isAuthFailure({ code: 'EAUTH' })).toBe(true);
    expect(isAuthFailure({ responseCode: 535 })).toBe(true);
    expect(isAuthFailure({ responseCode: 534 })).toBe(true);
    expect(isAuthFailure({ code: 'ETIMEDOUT' })).toBe(false);
    expect(isAuthFailure({ responseCode: 550 })).toBe(false);
    expect(isAuthFailure(null)).toBe(false);
  });
});

describe('sendWithRetry — auth failure path + success log', () => {
  function fakeTransport(sendMail: (...a: unknown[]) => Promise<unknown>) {
    transporter.mockResolvedValue({
      transporter: { sendMail } as unknown as Awaited<ReturnType<typeof getTransporter>>['transporter'],
      from: '"ALMOG" <x@example.com>',
    });
  }
  const args = { to: 'a@example.com', subject: 'נושא', html: '<p>x</p>', text: 'x' };

  it('EAUTH → alert raised once, no retry, error rethrown', async () => {
    const err = Object.assign(new Error('Invalid login'), { code: 'EAUTH', responseCode: 535 });
    const sendMail = vi.fn().mockRejectedValue(err);
    fakeTransport(sendMail);
    await expect(sendWithRetry(args)).rejects.toBe(err);
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(alert).toHaveBeenCalledTimes(1);
  });

  it('permanent 5xx (not auth) → no alert, no retry', async () => {
    const err = Object.assign(new Error('mailbox unavailable'), { responseCode: 550 });
    const sendMail = vi.fn().mockRejectedValue(err);
    fakeTransport(sendMail);
    await expect(sendWithRetry(args)).rejects.toBe(err);
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(alert).not.toHaveBeenCalled();
  });

  it('success → returns messageId + attempts and logs exactly one line without the body', async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: '<id-1@example.com>' });
    fakeTransport(sendMail);
    const info = vi.mocked(console.info);
    const r = await sendWithRetry(args);
    expect(r).toEqual({ messageId: '<id-1@example.com>', attempts: 1 });
    expect(alert).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledTimes(1);
    const line = info.mock.calls[0].join(' ');
    expect(line).toContain('a@example.com');
    expect(line).toContain('נושא');
    expect(line).toContain('<id-1@example.com>');
    expect(line).toContain('"attempts":1');
    expect(line).not.toContain('<p>x</p>');
  });
});
