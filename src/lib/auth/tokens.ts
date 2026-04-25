import 'server-only';
import { randomBytes } from 'node:crypto';
import { query, queryOne } from '@/lib/db';
import { RESET_TOKEN_LIFETIME_MIN } from '@/lib/constants';

export async function generateResetToken(userId: string): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + RESET_TOKEN_LIFETIME_MIN * 60 * 1000);

  await query(
    `insert into public.password_reset_tokens (token, user_id, expires_at)
     values ($1, $2, $3)`,
    [token, userId, expiresAt.toISOString()],
  );

  return token;
}

interface TokenRow {
  user_id: string;
  expires_at: Date;
  used_at: Date | null;
}

/**
 * Validates a reset token and marks it as used.
 * Returns user_id on success, null if token is missing, expired, or already used.
 */
export async function consumeResetToken(token: string): Promise<string | null> {
  const row = await queryOne<TokenRow>(
    `select user_id, expires_at, used_at
     from public.password_reset_tokens
     where token = $1
     limit 1`,
    [token],
  );

  if (!row) return null;
  if (row.used_at) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) return null;

  await query(
    `update public.password_reset_tokens set used_at = now() where token = $1`,
    [token],
  );

  return row.user_id;
}
