import 'server-only';
import { randomBytes } from 'node:crypto';
import { hashToken } from './tokenHash';

export const INVITE_TOKEN_LIFETIME_HOURS = 24;

/** Generates a raw invite token (to be emailed). Store only hashInviteToken(raw). */
export function generateInviteToken(): string {
  return randomBytes(32).toString('base64url');
}

/** SHA-256 of an invite token — the only form stored in user_invites.token. */
export function hashInviteToken(rawToken: string): string {
  return hashToken(rawToken);
}

export function inviteExpiryFromNow(): Date {
  return new Date(Date.now() + INVITE_TOKEN_LIFETIME_HOURS * 60 * 60 * 1000);
}
