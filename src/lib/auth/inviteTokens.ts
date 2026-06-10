import 'server-only';
import { randomBytes } from 'node:crypto';

export const INVITE_TOKEN_LIFETIME_HOURS = 24;

export function generateInviteToken(): string {
  return randomBytes(32).toString('base64url');
}

export function inviteExpiryFromNow(): Date {
  return new Date(Date.now() + INVITE_TOKEN_LIFETIME_HOURS * 60 * 60 * 1000);
}
