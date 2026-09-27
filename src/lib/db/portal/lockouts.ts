import 'server-only';
import { query, queryOne } from '@/lib/db';
import {
  PORTAL_LOCKOUT_ESCALATION_WINDOW_HOURS,
  PORTAL_LOCKOUT_TIER_MINUTES,
  type PortalLockoutReason,
} from '@/lib/constants/portal';
import type { PortalLockout } from '@/lib/types/portal';

// Escalating lockouts of a PHONE (never of an IP). Tier 1 = 30 minutes,
// 2 = 2 hours, 3 = 24 hours; the tier is derived from how many lockouts that
// phone already collected inside the escalation window, so a phone that misfires
// once a week never leaves tier 1.

const COLS = `id, phone_e164, locked_until, tier, reason, created_at, released_at`;

/** The lockout in force right now, or null. A manual release clears it
 *  immediately (released_at is what the guard reads, not only locked_until). */
export async function activeLockout(phoneE164: string): Promise<PortalLockout | null> {
  return queryOne<PortalLockout>(
    `select ${COLS} from public.portal_lockouts
      where phone_e164 = $1 and released_at is null and locked_until > now()
      order by locked_until desc
      limit 1`,
    [phoneE164],
  );
}

/** Minutes left on an active lockout, rounded up. */
export function lockoutMinutesRemaining(lockout: PortalLockout): number {
  const ms = new Date(lockout.locked_until).getTime() - Date.now();
  return Math.max(1, Math.ceil(ms / 60_000));
}

export interface LockoutResult {
  lockout: PortalLockout;
  /** How many lockouts this phone now has inside the escalation window — the
   *  number the manager alert is keyed on. */
  countInWindow: number;
}

/**
 * Locks the phone out at the next tier. The tier is (lockouts in the window) + 1,
 * capped at the last tier, so a phone already at 24 hours stays there rather
 * than overflowing the table's CHECK.
 */
export async function createLockout(
  phoneE164: string,
  reason: PortalLockoutReason,
): Promise<LockoutResult> {
  const prior = await queryOne<{ c: number }>(
    `select count(*)::int as c from public.portal_lockouts
      where phone_e164 = $1 and created_at > now() - ($2 || ' hours')::interval`,
    [phoneE164, String(PORTAL_LOCKOUT_ESCALATION_WINDOW_HOURS)],
  );
  const countInWindow = (prior?.c ?? 0) + 1;
  const tier = Math.min(countInWindow, PORTAL_LOCKOUT_TIER_MINUTES.length);
  const minutes = PORTAL_LOCKOUT_TIER_MINUTES[tier - 1]!;

  const row = await queryOne<PortalLockout>(
    `insert into public.portal_lockouts (phone_e164, locked_until, tier, reason)
     values ($1, now() + ($2 || ' minutes')::interval, $3, $4)
     returning ${COLS}`,
    [phoneE164, String(minutes), tier, reason],
  );
  return { lockout: row!, countInWindow };
}

/**
 * "שחרר חסימה" from the apartment card: releases every live lockout of the
 * phone. Returns how many were released — 0 means there was nothing to release,
 * which the route answers as 404 rather than pretending to have done something.
 * Released rows are KEPT, so the escalation history is not erased by a release.
 */
export async function releaseLockouts(phoneE164: string, actorId: string): Promise<number> {
  const r = await query(
    `update public.portal_lockouts
        set released_at = now(), released_by = $2
      where phone_e164 = $1 and released_at is null and locked_until > now()`,
    [phoneE164, actorId],
  );
  return r.rowCount ?? 0;
}

/** Every phone of this apartment that is locked right now — the card's banner. */
export async function activeLockoutsForApartment(apartmentNumber: string): Promise<PortalLockout[]> {
  const r = await query<PortalLockout>(
    `select l.id, l.phone_e164, l.locked_until, l.tier, l.reason, l.created_at, l.released_at
       from public.portal_lockouts l
       join public.apartment_owner_phones o on o.phone_e164 = l.phone_e164
      where o.apartment_number = $1
        and l.released_at is null and l.locked_until > now()
      order by l.locked_until desc`,
    [apartmentNumber],
  );
  // One phone can hold several live rows in theory; the banner wants one per phone.
  const seen = new Set<string>();
  return r.rows.filter((x) => (seen.has(x.phone_e164) ? false : (seen.add(x.phone_e164), true)));
}
