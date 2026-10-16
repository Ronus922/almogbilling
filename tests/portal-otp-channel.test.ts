import { afterEach, describe, expect, it, vi } from 'vitest';

// Mutated per test rather than re-mocked per test: the functions under test
// read env.* at CALL time, so changing this object's properties between
// assertions is enough — no need to reset modules or re-import. vi.hoisted()
// because vi.mock()'s factory runs before any top-level const of this file.
const mockEnv = vi.hoisted(() => ({
  SMS_PROVIDER: undefined as string | undefined,
  SMS_USERNAME: undefined as string | undefined,
  SMS_API_KEY: undefined as string | undefined,
  SMS_SENDER: undefined as string | undefined,
  APP_URL: 'https://almog-haifa.co.il',
}));
vi.mock('@/env', () => ({ env: mockEnv }));

import { isSmsConfigured, resolveDefaultChannel, webOtpDomain } from '@/lib/portal/otpChannel';

// isSmsConfigured() is the single gate between "SMS is the default channel"
// and "nothing changed" — every other piece of this feature (the request
// route, the resend button, "שלח בוואטסאפ במקום") rests on it staying false
// until all four env vars are set for real.
describe('otpChannel — dormant until all four SMS env vars exist', () => {
  afterEach(() => {
    mockEnv.SMS_PROVIDER = undefined;
    mockEnv.SMS_USERNAME = undefined;
    mockEnv.SMS_API_KEY = undefined;
    mockEnv.SMS_SENDER = undefined;
  });

  it('is unconfigured with no var set — today\'s state', () => {
    expect(isSmsConfigured()).toBe(false);
    expect(resolveDefaultChannel()).toBe('whatsapp');
  });

  it('is still unconfigured with only the provider name set', () => {
    mockEnv.SMS_PROVIDER = '019';
    expect(isSmsConfigured()).toBe(false);
    expect(resolveDefaultChannel()).toBe('whatsapp');
  });

  it('is still unconfigured missing just the sender name', () => {
    mockEnv.SMS_PROVIDER = '019';
    mockEnv.SMS_USERNAME = 'user';
    mockEnv.SMS_API_KEY = 'x';
    expect(isSmsConfigured()).toBe(false);
    expect(resolveDefaultChannel()).toBe('whatsapp');
  });

  it('becomes configured once all four are set, and SMS becomes the default', () => {
    mockEnv.SMS_PROVIDER = '019';
    mockEnv.SMS_USERNAME = 'user';
    mockEnv.SMS_API_KEY = 'x';
    mockEnv.SMS_SENDER = 'AlmogTower';
    expect(isSmsConfigured()).toBe(true);
    expect(resolveDefaultChannel()).toBe('sms');
  });
});

describe('webOtpDomain — derived from APP_URL, never a second hardcoded value', () => {
  it('matches the hostname of wherever the app is actually configured to serve from', () => {
    expect(webOtpDomain()).toBe('almog-haifa.co.il');
  });
});
