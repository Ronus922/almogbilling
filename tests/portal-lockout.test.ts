import { describe, expect, it } from 'vitest';
import {
  PORTAL_LOCKOUT_ALERT_TIER, PORTAL_LOCKOUT_TIER_MINUTES, PORTAL_NOT_OWNER_MESSAGE,
  PORTAL_OTP_MAX_ATTEMPTS, PORTAL_OTP_MAX_PER_IP, PORTAL_OTP_MAX_REQUESTS_PER_WINDOW,
  PORTAL_SESSION_LIFETIME_HOURS, PORTAL_VERIFY_MAX_PER_IP,
  portalLockedMessage, portalLockoutAlertMessage,
} from '@/lib/constants/portal';

// The escalation ladder createLockout() walks: tier = (lockouts inside the 24h
// window) + 1, capped at the last tier. Pure arithmetic, extracted here so the
// ladder cannot drift from what was agreed (30 min → 2 h → 24 h) without a
// failing test.
function tierFor(priorInWindow: number): number {
  return Math.min(priorInWindow + 1, PORTAL_LOCKOUT_TIER_MINUTES.length);
}

describe('lockout escalation', () => {
  it('is 30 minutes, then 2 hours, then 24 hours', () => {
    expect(PORTAL_LOCKOUT_TIER_MINUTES).toEqual([30, 120, 1440]);
  });

  it('rises with each repeat inside the window and then stays at the top tier', () => {
    expect(tierFor(0)).toBe(1); // first offence
    expect(tierFor(1)).toBe(2);
    expect(tierFor(2)).toBe(3);
    expect(tierFor(3)).toBe(3); // capped — never overflows the table's CHECK (1..3)
    expect(tierFor(99)).toBe(3);
  });

  it('maps each tier to its duration', () => {
    expect(PORTAL_LOCKOUT_TIER_MINUTES[tierFor(0) - 1]).toBe(30);
    expect(PORTAL_LOCKOUT_TIER_MINUTES[tierFor(1) - 1]).toBe(120);
    expect(PORTAL_LOCKOUT_TIER_MINUTES[tierFor(2) - 1]).toBe(1440);
  });

  it('alerts the manager on the THIRD lockout in the window, not the first two', () => {
    expect(PORTAL_LOCKOUT_ALERT_TIER).toBe(3);
    expect(1 >= PORTAL_LOCKOUT_ALERT_TIER).toBe(false);
    expect(2 >= PORTAL_LOCKOUT_ALERT_TIER).toBe(false);
    expect(3 >= PORTAL_LOCKOUT_ALERT_TIER).toBe(true);
    // A phone already at the top tier keeps alerting on further offences.
    expect(4 >= PORTAL_LOCKOUT_ALERT_TIER).toBe(true);
  });
});

describe('the ceilings that trigger a lockout', () => {
  it('is 5 wrong codes and 5 code requests per window', () => {
    expect(PORTAL_OTP_MAX_ATTEMPTS).toBe(5);
    expect(PORTAL_OTP_MAX_REQUESTS_PER_WINDOW).toBe(5);
  });

  it('locks out on the 5th wrong code, not the 4th', () => {
    expect(4 >= PORTAL_OTP_MAX_ATTEMPTS).toBe(false);
    expect(5 >= PORTAL_OTP_MAX_ATTEMPTS).toBe(true);
  });
});

describe('the copy a resident reads', () => {
  it('tells an unregistered number to call the management company', () => {
    expect(PORTAL_NOT_OWNER_MESSAGE).toContain('אינו רשום כבעל דירה');
    expect(PORTAL_NOT_OWNER_MESSAGE).toContain('פנה לחברת הניהול');
  });

  it('never says "0 דקות" — a part-minute rounds up to 1', () => {
    expect(portalLockedMessage(0)).toContain('בעוד 1 דקות');
    expect(portalLockedMessage(0.2)).toContain('בעוד 1 דקות');
    expect(portalLockedMessage(29.4)).toContain('בעוד 30 דקות');
    expect(portalLockedMessage(30)).toContain('בעוד 30 דקות');
    expect(portalLockedMessage(-5)).toContain('בעוד 1 דקות');
  });

  it('names the blocked number in the manager alert', () => {
    const msg = portalLockoutAlertMessage('+972541234567');
    expect(msg).toContain('+972541234567');
    expect(msg).toContain('3 פעמים');
  });
});

describe('session lifetime', () => {
  it('is 12 hours (or the browser closing — whichever comes first)', () => {
    expect(PORTAL_SESSION_LIFETIME_HOURS).toBe(12);
  });
});

describe('the per-IP verify ceiling', () => {
  it('is derived from the honest flow, not picked — 20 codes × 5 guesses', () => {
    expect(PORTAL_VERIFY_MAX_PER_IP).toBe(PORTAL_OTP_MAX_PER_IP * PORTAL_OTP_MAX_ATTEMPTS);
    expect(PORTAL_VERIFY_MAX_PER_IP).toBe(100);
  });

  it('is never TIGHTER than what a legitimate caller can need', () => {
    // A building behind one NAT must not be cut off mid-flow: every code an IP is
    // allowed to request must still be fully guessable from that same IP.
    expect(PORTAL_VERIFY_MAX_PER_IP).toBeGreaterThanOrEqual(
      PORTAL_OTP_MAX_PER_IP * PORTAL_OTP_MAX_ATTEMPTS,
    );
  });
});
