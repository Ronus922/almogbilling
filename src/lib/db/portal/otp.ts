import 'server-only';
import { randomInt } from 'node:crypto';
import { query, queryOne } from '@/lib/db';
import { hashPassword, verifyPassword } from '@/lib/auth/password';
import { PORTAL_OTP_DIGITS, PORTAL_OTP_RESEND_COOLDOWN_SEC, PORTAL_OTP_TTL_MINUTES } from '@/lib/constants/portal';

// One-time codes for the owners portal. The 6 digits exist in exactly two
// places: the WhatsApp message and this module's return value. What reaches the
// database is bcrypt(code) — the same primitive as public.users.password_hash —
// so a DB read (backup, replica, injection) cannot yield a usable code. Nothing
// here ever writes the digits to a log.

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
export async function resendCooldownRemaining(phoneE164: string): Promise<number> {
  const row = await queryOne<{ remaining: number }>(
    `select ceil(greatest(0, $2::int - extract(epoch from (now() - created_at))))::int as remaining
       from public.portal_otp_codes
      where phone_e164 = $1
      order by created_at desc
      limit 1`,
    [phoneE164, PORTAL_OTP_RESEND_COOLDOWN_SEC],
  );
  return row?.remaining ?? 0;
}

/** Issues a code: stores only its hash, returns the digits to the caller. */
export async function issueCode(phoneE164: string, ip: string | null): Promise<IssuedCode> {
  const code = newCode();
  const codeHash = await hashPassword(code);
  const row = await queryOne<{ id: string }>(
    `insert into public.portal_otp_codes (phone_e164, code_hash, expires_at, ip)
     values ($1, $2, now() + ($3 || ' minutes')::interval, $4)
     returning id`,
    [phoneE164, codeHash, String(PORTAL_OTP_TTL_MINUTES), ip],
  );
  return { id: row!.id, code };
}

export type VerifyOutcome =
  /** Matched — the caller may create a session. */
  | { kind: 'ok' }
  /** Wrong digits. `attempts` is the running count against the newest code. */
  | { kind: 'invalid'; attempts: number }
  /** Newest code is past its TTL, or was already used. */
  | { kind: 'expired' }
  /** No code was ever issued to this phone. */
  | { kind: 'none' };

interface CodeRow {
  id: string;
  code_hash: string;
  attempts: number;
  expired: boolean;
  consumed: boolean;
}

/**
 * Checks `code` against the NEWEST code of this phone — not "any valid code":
 * asking for a second code must invalidate the first, or the 5-attempt ceiling
 * could be spread across several live codes. A wrong guess bumps `attempts` on
 * that row and returns the new count, which is what drives the lockout.
 */
export async function verifyCode(phoneE164: string, code: string): Promise<VerifyOutcome> {
  const row = await queryOne<CodeRow>(
    `select id, code_hash, attempts,
            (expires_at <= now()) as expired,
            (consumed_at is not null) as consumed
       from public.portal_otp_codes
      where phone_e164 = $1
      order by created_at desc
      limit 1`,
    [phoneE164],
  );
  if (!row) return { kind: 'none' };
  if (row.expired || row.consumed) return { kind: 'expired' };

  const ok = await verifyPassword(code, row.code_hash);
  if (!ok) {
    const bumped = await queryOne<{ attempts: number }>(
      `update public.portal_otp_codes set attempts = attempts + 1
        where id = $1 returning attempts`,
      [row.id],
    );
    return { kind: 'invalid', attempts: bumped?.attempts ?? row.attempts + 1 };
  }

  await query(`update public.portal_otp_codes set consumed_at = now() where id = $1`, [row.id]);
  return { kind: 'ok' };
}
