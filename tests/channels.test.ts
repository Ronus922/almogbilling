import { describe, it, expect } from 'vitest';
import { coerceChannels, effectiveChannels, REMINDER_CHANNELS } from '@/lib/notify/channels';

describe('REMINDER_CHANNELS', () => {
  it('is exactly the three real channels (no "both")', () => {
    expect([...REMINDER_CHANNELS]).toEqual(['in_app', 'email', 'whatsapp']);
  });
});

describe('coerceChannels', () => {
  it('accepts a valid non-empty subset', () => {
    expect(coerceChannels(['in_app', 'whatsapp'])).toEqual({ ok: true, channels: ['in_app', 'whatsapp'] });
  });
  it('dedupes', () => {
    expect(coerceChannels(['email', 'email'])).toEqual({ ok: true, channels: ['email'] });
  });
  it('rejects an empty array (at least one required)', () => {
    expect(coerceChannels([])).toEqual({ ok: false, error: 'no_reminder_channel' });
  });
  it('rejects a non-array', () => {
    expect(coerceChannels('email')).toEqual({ ok: false, error: 'invalid_reminder_channels' });
    expect(coerceChannels(undefined)).toEqual({ ok: false, error: 'invalid_reminder_channels' });
  });
  it('rejects an unknown / retired channel value', () => {
    expect(coerceChannels(['both'])).toEqual({ ok: false, error: 'invalid_reminder_channel' });
    expect(coerceChannels(['sms'])).toEqual({ ok: false, error: 'invalid_reminder_channel' });
    expect(coerceChannels(['in_app', 42])).toEqual({ ok: false, error: 'invalid_reminder_channel' });
  });
});

describe('effectiveChannels — engine read-time fallback (critical for legacy rows)', () => {
  it('prefers the new channels array when present', () => {
    expect(effectiveChannels(['whatsapp'], 'email')).toEqual(['whatsapp']);
  });
  it('falls back to legacy "both" → in_app + email', () => {
    expect(effectiveChannels(null, 'both')).toEqual(['in_app', 'email']);
    expect(effectiveChannels([], 'both')).toEqual(['in_app', 'email']);
  });
  it('falls back to a legacy single channel', () => {
    expect(effectiveChannels(null, 'email')).toEqual(['email']);
    expect(effectiveChannels(null, 'whatsapp')).toEqual(['whatsapp']);
    expect(effectiveChannels(null, 'in_app')).toEqual(['in_app']);
  });
  it('defaults to in_app for unknown/null legacy (never silently drops)', () => {
    expect(effectiveChannels(null, null)).toEqual(['in_app']);
    expect(effectiveChannels(null, 'garbage')).toEqual(['in_app']);
  });
});
