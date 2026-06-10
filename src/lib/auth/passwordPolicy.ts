/**
 * Single source of truth for the user-facing password policy.
 * Used by both server-side routes (api/auth/reset-password,
 * api/auth/accept-invite) and client-side forms (ResetPasswordForm,
 * AcceptInviteForm). DO NOT duplicate these rules elsewhere — extend
 * here so server enforcement and client UI stay in sync.
 */

export const PASSWORD_MIN_LENGTH = 8;

// Hebrew block U+0590..U+05FF (matches the regex already shipping in
// ResetPasswordForm). Covers the basic letters א..ת plus niqqud, geresh,
// gershayim, etc. We accept anything in that block as "a Hebrew letter".
const LETTER_RX = /[a-zA-Z֐-׿]/;
const DIGIT_RX = /\d/;

export interface PasswordRequirements {
  length: boolean;
  letter: boolean;
  digit: boolean;
}

export function passwordRequirements(p: string): PasswordRequirements {
  return {
    length: p.length >= PASSWORD_MIN_LENGTH,
    letter: LETTER_RX.test(p),
    digit: DIGIT_RX.test(p),
  };
}

export function isValidPassword(p: string): boolean {
  const r = passwordRequirements(p);
  return r.length && r.letter && r.digit;
}
