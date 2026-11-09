/**
 * The login name of a guard ("שומר", 08/11/2026) — the one user that is created
 * with a username instead of an e-mail. Shared by POST /api/users and the
 * create-user panel so the rule the form shows is the rule the server enforces
 * (the same single-source idea as passwordPolicy.ts).
 *
 * Lower-case latin letters, digits and . _ - only, 3–32 characters. No "@":
 * every other user's username IS their e-mail, so a guard's name must never be
 * able to equal (or be mistaken for) one. Case never matters at login — the
 * lookup is lower(username) — so the name is stored lower-case.
 */
export const GUARD_USERNAME_RX = /^[a-z0-9._-]{3,32}$/;

export const GUARD_USERNAME_HELP = '3–32 תווים באנגלית קטנה, ספרות, נקודה, קו תחתון או מקף';

export function normalizeUsername(raw: string): string {
  return raw.trim().toLowerCase();
}

export function isValidGuardUsername(raw: string): boolean {
  return GUARD_USERNAME_RX.test(normalizeUsername(raw));
}
