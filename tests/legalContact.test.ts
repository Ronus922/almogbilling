import { describe, it, expect } from 'vitest';
import {
  normalizeLegalContact,
  LEGAL_CONTACT_NAME_MAX,
} from '@/lib/validation/legalContact';
import {
  isLegalStatusName,
  STATUS_LEGAL_CARE,
  STATUS_LEGAL_PROCEEDING,
  STATUS_WARNING,
} from '@/lib/constants/statuses';

// The lawyer's address is a Settings value (app_settings 'legal_contact'),
// never a constant in code. These cover the two pure pieces around it: the
// shared validation and the "is this a legal status" gate that decides when
// the address is added to a status-change notification.

describe('normalizeLegalContact', () => {
  it('trims and lower-cases a valid contact', () => {
    const r = normalizeLegalContact({ name: '  עו"ד ישראלי ', email: ' Lawyer@Example.co.il ' });
    expect(r).toEqual({ ok: true, value: { name: 'עו"ד ישראלי', email: 'lawyer@example.co.il' } });
  });

  it('accepts an empty contact — cleared means nothing is sent', () => {
    expect(normalizeLegalContact({ name: '', email: '' })).toEqual({ ok: true, value: { name: '', email: '' } });
    expect(normalizeLegalContact({})).toEqual({ ok: true, value: { name: '', email: '' } });
    expect(normalizeLegalContact({ name: 42, email: null })).toEqual({ ok: true, value: { name: '', email: '' } });
  });

  it('rejects a malformed email with a field-level Hebrew message', () => {
    const r = normalizeLegalContact({ name: 'x', email: 'not-an-email' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.email).toBeTruthy();
      expect(r.errors.name).toBeUndefined();
    }
  });

  it('rejects a name longer than the limit', () => {
    const r = normalizeLegalContact({ name: 'א'.repeat(LEGAL_CONTACT_NAME_MAX + 1), email: '' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.name).toBeTruthy();
    expect(normalizeLegalContact({ name: 'א'.repeat(LEGAL_CONTACT_NAME_MAX), email: '' }).ok).toBe(true);
  });
});

describe('isLegalStatusName', () => {
  it('is true only for the two legal statuses', () => {
    expect(isLegalStatusName(STATUS_LEGAL_CARE)).toBe(true);
    expect(isLegalStatusName(STATUS_LEGAL_PROCEEDING)).toBe(true);
    expect(isLegalStatusName(` ${STATUS_LEGAL_PROCEEDING} `)).toBe(true);
    expect(isLegalStatusName(STATUS_WARNING)).toBe(false);
    expect(isLegalStatusName('רגיל')).toBe(false);
    expect(isLegalStatusName(null)).toBe(false);
    expect(isLegalStatusName(undefined)).toBe(false);
    expect(isLegalStatusName('')).toBe(false);
  });
});
