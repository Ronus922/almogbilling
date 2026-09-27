import { describe, expect, it } from 'vitest';
import { e164ToChatId, e164ToLocal, toPortalE164 } from '@/lib/portal/phone';

// The portal roster, the codes, the sessions and the log are all keyed on E.164,
// and toPortalE164 is the ONLY way a number gets there — so the whole login
// surface rests on these rules. It delegates every format decision to
// normalizePhone (src/lib/whatsapp.ts) and adds exactly two things: the '+' and
// mobile-only.
describe('toPortalE164 — the roster key', () => {
  it('accepts an Israeli mobile in every format it is written in', () => {
    expect(toPortalE164('0541234567')).toBe('+972541234567');
    expect(toPortalE164('054-123-4567')).toBe('+972541234567');
    expect(toPortalE164('054 123 4567')).toBe('+972541234567');
    expect(toPortalE164('972541234567')).toBe('+972541234567');
    expect(toPortalE164('+972-54-123-4567')).toBe('+972541234567');
    expect(toPortalE164('00972541234567')).toBe('+972541234567');
    // Subscriber digits without the trunk 0, as an Excel cell often holds them.
    expect(toPortalE164('541234567')).toBe('+972541234567');
  });

  it('takes the first number of a compound cell, like the broadcast gate does', () => {
    expect(toPortalE164('0541234567 / 0521111111')).toBe('+972541234567');
    expect(toPortalE164('0541234567, 0521111111')).toBe('+972541234567');
  });

  it('REJECTS a landline — WhatsApp cannot deliver a code to one', () => {
    // These are the exact values the 27/09/2026 backfill skipped.
    expect(toPortalE164('0722592624')).toBeNull(); // 072 VoIP
    expect(toPortalE164('0774001278')).toBeNull(); // 077 VoIP
    expect(toPortalE164('039335349')).toBeNull();  // 03 landline
    expect(toPortalE164('025850379')).toBeNull();
    expect(toPortalE164('048704782')).toBeNull();
  });

  it('rejects junk, empties and foreign numbers', () => {
    expect(toPortalE164(null)).toBeNull();
    expect(toPortalE164(undefined)).toBeNull();
    expect(toPortalE164('')).toBeNull();
    expect(toPortalE164('   ')).toBeNull();
    expect(toPortalE164('0000000000')).toBeNull();
    expect(toPortalE164('abc')).toBeNull();
    expect(toPortalE164('+14155552671')).toBeNull();
    // A mobile missing a digit is NOT silently widened into a landline match.
    expect(toPortalE164('052414558')).toBeNull();
    // Too long.
    expect(toPortalE164('05412345678')).toBeNull();
  });

  it('is idempotent — feeding its own output back changes nothing', () => {
    const once = toPortalE164('0541234567')!;
    expect(toPortalE164(once)).toBe(once);
  });
});

describe('E.164 → the two forms the rest of the code needs', () => {
  it('e164ToLocal gives back the number an Israeli reads', () => {
    expect(e164ToLocal('+972541234567')).toBe('0541234567');
    // Not ours to rewrite: a non-IL value passes through untouched.
    expect(e164ToLocal('+14155552671')).toBe('+14155552671');
  });

  it('e164ToChatId gives Green API its chat id', () => {
    expect(e164ToChatId('+972541234567')).toBe('972541234567@c.us');
  });

  it('round-trips through the local form', () => {
    expect(toPortalE164(e164ToLocal('+972541234567'))).toBe('+972541234567');
  });
});
