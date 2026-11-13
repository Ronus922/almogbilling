import 'server-only';
import { randomInt } from 'node:crypto';
import { queryOne } from '@/lib/db';
import { hashPassword, verifyPassword } from '@/lib/auth/password';
import {
  PORTAL_OTP_DIGITS, PORTAL_OTP_MAX_ATTEMPTS, PORTAL_OTP_RESEND_COOLDOWN_SEC, PORTAL_OTP_TTL_MINUTES,
} from '@/lib/constants/portal';

// One-time codes for the owners portal. The 6 digits exist in exactly two
// places: the WhatsApp message and this module's return value. What reaches the
// database is bcrypt(code) — the same primitive as public.users.password_hash —
// so a DB read (backup, replica, injection) cannot yield a usable code. Nothing
// here ever writes the digits to a log.

/** What a code is for (migration 20261112194633). The portal reads only its
 *  own codes, so a code sent for a chip order can never open a portal session;
 *  every caller that omits it is the portal, exactly as before. */
export type OtpPurpose = 'portal_login' | 'chip_order';

export interface IssuedCode {
  id: string;
  /** The plain digits — hand straight to the WhatsApp send, never anywhere else. */
  code: string;
}

/** Cryptographically uniform 6-digit code, leading zeros kept. */
function newCode(): string {
  return String(randomInt(0, 10 ** PORTAL_OTP_DIGITS)).padStart(PORTAL_OTP_DIGITS, '0');
}

/**
 * Seconds still to wait before this phone may ask for another code, or 0. Based
 * on the newest code row, so it is unaffected by how many rows came before.
 */
export async function resendCooldownRemaining(
  phoneE164: string,
  purpose: OtpPurpose = 'portal_login',
): Promise<number> {
  const row = await queryOne<{ remaining: number }>(
    `select ceil(greatest(0, $2::int - extract(epoch from (now() - created_at))))::int as remaining
       from public.portal_otp_codes
      where phone_e164 = $1 and purpose = $3
      order by created_at desc
      limit 1`,
    [phoneE164, PORTAL_OTP_RESEND_COOLDOWN_SEC, purpose],
  );
  return row?.remaining ?? 0;
}

/** Issues a code: stores only its hash, returns the digits to the caller. */
export async function issueCode(
  phoneE164: string,
  ip: string | null,
  purpose: OtpPurpose = 'portal_login',
): Promise<IssuedCode> {
  const code = newCode();
  const codeHash = await hashPassword(code);
  const row = await queryOne<{ id: string }>(
    `insert into public.portal_otp_codes (phone_e164, code_hash, expires_at, ip, purpose)
     values ($1, $2, now() + ($3 || ' minutes')::interval, $4, $5)
     returning id`,
    [phoneE164, codeHash, String(PORTAL_OTP_TTL_MINUTES), ip, purpose],
  );
  return { id: row!.id, code };
}

export type VerifyOutcome =
  /** Matched — the caller may create a session. */
  | { kind: 'ok' }
  /** Wrong digits. `attempts` is the running count against the newest code. */
  | { kind: 'invalid'; attempts: number }
  /** Newest code is past its TTL, already used, or out of attempts. */
  | { kind: 'expired' }
  /** No code was ever issued to this phone. */
  | { kind: 'none' };

/**
 * The ONE verify of a one-time code — the owners portal and the chip-order
 * page alike (13/11/2026; until then the portal compared first and counted
 * after, so a burst of parallel guesses was compared in full). Each purpose
 * keeps its own codes apart through `purpose`.
 *
 * Only the NEWEST code of this phone and purpose counts — asking for a new code
 * invalidates the previous one, or the ceiling could be spread across several
 * live codes. Every guess first RESERVES an attempt on that code in one UPDATE
 * (`attempts < maxAttempts`, live, not consumed), and only a reserved guess is
 * compared — so however the guesses are timed, at most `maxAttempts` values are
 * ever checked against one code, and after that even the right digits are
 * refused (`expired`: ask for a new code). A match then consumes the code with
 * a guarded UPDATE, so of two correct guesses racing only one wins.
 */
export async function verifyCode(
  phoneE164: string,
  code: string,
  purpose: OtpPurpose = 'portal_login',
  maxAttempts: number = PORTAL_OTP_MAX_ATTEMPTS,
): Promise<VerifyOutcome> {
  const reserved = await queryOne<{ id: string; code_hash: string; attempts: number }>(
    `update public.portal_otp_codes
        set attempts = attempts + 1
      where id = (select id from public.portal_otp_codes
                   where phone_e164 = $1 and purpose = $2
                   order by created_at desc limit 1)
        and consumed_at is null
        and expires_at > now()
        and attempts < $3
      returning id, code_hash, attempts`,
    [phoneE164, purpose, maxAttempts],
  );
  if (!reserved) {
    const any = await queryOne<{ id: string }>(
      `select id from public.portal_otp_codes where phone_e164 = $1 and purpose = $2 limit 1`,
      [phoneE164, purpose],
    );
    return any ? { kind: 'expired' } : { kind: 'none' };
  }
  const ok = await verifyPassword(code, reserved.code_hash);
  if (!ok) return { kind: 'invalid', attempts: reserved.attempts };
  const consumed = await queryOne<{ id: string }>(
    `update public.portal_otp_codes set consumed_at = now()
      where id = $1 and consumed_at is null returning id`,
    [reserved.id],
  );
  return consumed ? { kind: 'ok' } : { kind: 'expired' };
}
