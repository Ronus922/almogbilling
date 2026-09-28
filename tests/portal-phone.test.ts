import { describe, expect, it } from 'vitest';
import { e164ToChatId, e164ToLocal, toPortalE164 } from '@/lib/portal/phone';

// The portal roster, the codes, the sessions and the log are all keyed on E.164,
// and toPortalE164 is the ONLY way a number gets there — so the whole login
// surface rests on these rules. It delegates every format decision to
// normalizePhone (src/lib/whatsapp.ts) and adds exactly two things: the '+' and
// mobile-only for Israel. Since 28/09/2026 a foreign number written with its
// '+' is accepted as general E.164 — the SAME rule as the roster's CHECK
// (migration owner_phone_e164_international).
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

  it('rejects junk and empties', () => {
    expect(toPortalE164(null)).toBeNull();
    expect(toPortalE164(undefined)).toBeNull();
    expect(toPortalE164('')).toBeNull();
    expect(toPortalE164('   ')).toBeNull();
    expect(toPortalE164('0000000000')).toBeNull();
    expect(toPortalE164('abc')).toBeNull();
    // A mobile missing a digit is NOT silently widened into a landline match.
    expect(toPortalE164('052414558')).toBeNull();
    // Too long.
    expect(toPortalE164('05412345678')).toBeNull();
  });

  it("accepts a foreign number written with its '+' — E.164 verbatim", () => {
    expect(toPortalE164('+14155552671')).toBe('+14155552671');
    expect(toPortalE164('+1 (415) 555-2671')).toBe('+14155552671');
    expect(toPortalE164('+44 7911 123456')).toBe('+447911123456');
    expect(toPortalE164('+33 6 12 34 56 78')).toBe('+33612345678');
    // The shortest and the longest E.164 there is.
    expect(toPortalE164('+1234567')).toBe('+1234567');
    expect(toPortalE164('+123456789012345')).toBe('+123456789012345');
  });

  it('rejects a bad prefix or a bad length after the +', () => {
    expect(toPortalE164('+')).toBeNull();
    expect(toPortalE164('+0541234567')).toBeNull();   // no 972 is injected after a '+'
    expect(toPortalE164('+123456')).toBeNull();       // 6 digits
    expect(toPortalE164('+1234567890123456')).toBeNull(); // 16 digits
    expect(toPortalE164('+abc')).toBeNull();
  });

  it("a foreign number WITHOUT its '+' is not a number — the '+' is the signal", () => {
    expect(toPortalE164('14155552671')).toBeNull();
    expect(toPortalE164('0014155552671')).toBeNull();
  });

  it('+972 is still mobile-only, whatever the spelling', () => {
    expect(toPortalE164('+972541234567')).toBe('+972541234567');
    expect(toPortalE164('+972722592624')).toBeNull();  // VoIP with a '+'
    expect(toPortalE164('+97231234567')).toBeNull();   // landline with a '+'
    expect(toPortalE164('+9720541234567')).toBeNull(); // trunk 0 kept after +972
  });

  it('is idempotent — feeding its own output back changes nothing', () => {
    const once = toPortalE164('0541234567')!;
    expect(toPortalE164(once)).toBe(once);
    const foreign = toPortalE164('+44 7911 123456')!;
    expect(toPortalE164(foreign)).toBe(foreign);
  });
});

describe('E.164 → the two forms the rest of the code needs', () => {
  it('e164ToLocal gives back the number an Israeli reads', () => {
    expect(e164ToLocal('+972541234567')).toBe('0541234567');
    // Not ours to rewrite: a non-IL value passes through untouched.
    expect(e164ToLocal('+14155552671')).toBe('+14155552671');
  });

  it('e164ToChatId gives Green API its chat id — international digits, no +', () => {
    expect(e164ToChatId('+972541234567')).toBe('972541234567@c.us');
    expect(e164ToChatId('+14155552671')).toBe('14155552671@c.us');
  });

  it('round-trips through the local form', () => {
    expect(toPortalE164(e164ToLocal('+972541234567'))).toBe('+972541234567');
  });
});
