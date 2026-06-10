import 'server-only';
import { randomBytes } from 'node:crypto';
import { query, queryOne } from '@/lib/db';
import { RESET_TOKEN_LIFETIME_MIN } from '@/lib/constants';
import { hashToken } from './tokenHash';

/**
 * Creates a password-reset token. The raw token is returned (to be emailed);
 * ONLY its SHA-256 hash is persisted in password_reset_tokens.token.
 */
export async function generateResetToken(userId: string): Promise<string> {
  const rawToken = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + RESET_TOKEN_LIFETIME_MIN * 60 * 1000);

  await query(
    `insert into public.password_reset_tokens (token, user_id, expires_at)
     values ($1, $2, $3)`,
    [hashToken(rawToken), userId, expiresAt.toISOString()],
  );

  return rawToken;
}

interface TokenRow {
  user_id: string;
}

/**
 * Validates a reset token and atomically marks it as used.
 * Returns user_id on success, null if missing, expired, or already used.
 * The incoming raw token is hashed before lookup (storage is hash-only).
 *
 * The UPDATE ... WHERE used_at IS NULL makes consumption atomic: two concurrent
 * requests with the same token cannot both succeed (only one UPDATE affects a row).
 */
export async function consumeResetToken(rawToken: string): Promise<string | null> {
  const row = await queryOne<TokenRow>(
    `update public.password_reset_tokens
        set used_at = now()
      where token = $1
        and used_at is null
        and expires_at > now()
      returning user_id`,
    [hashToken(rawToken)],
  );

  return row ? row.user_id : null;
}
