import 'server-only';
import { createHash } from 'node:crypto';

/**
 * One-way hash for security tokens (password-reset, invite) before they touch
 * the database. The raw token is sent only in the email/URL; only its SHA-256
 * hash is ever stored, so a DB read (backup leak, replica, injection) cannot
 * yield usable tokens. High-entropy input (32 random bytes) → a fast hash is
 * sufficient (no salt/peppering needed for unguessable random tokens).
 */
export function hashToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}
