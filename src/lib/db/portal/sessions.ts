import 'server-only';
import { randomBytes } from 'node:crypto';
import { query, queryOne } from '@/lib/db';
import { hashToken } from '@/lib/auth/tokenHash';
import { PORTAL_SESSION_LIFETIME_HOURS } from '@/lib/constants/portal';

// Portal sessions (portal_sessions) — deliberately NOT public.sessions: a portal
// session belongs to a PHONE, not to a users row, and the staff cookie must
// never open /portal. Same token contract as the staff session though: the raw
// token lives only in the cookie, the table stores sha256(token).

export interface NewPortalSession {
  id: string;
  /** The raw token — goes into the cookie and nowhere else. */
  token: string;
}

export async function createPortalSessionRow(args: {
  phoneE164: string;
  ip: string | null;
  userAgent: string | null;
}): Promise<NewPortalSession> {
  const token = randomBytes(32).toString('base64url');
  const row = await queryOne<{ id: string }>(
    `insert into public.portal_sessions (token_hash, phone_e164, expires_at, ip, user_agent)
     values ($1, $2, now() + ($3 || ' hours')::interval, $4, $5)
     returning id`,
    [hashToken(token), args.phoneE164, String(PORTAL_SESSION_LIFETIME_HOURS), args.ip, args.userAgent],
  );
  return { id: row!.id, token };
}

/** The live session for a raw token, or null. Expiry is checked here, in SQL —
 *  the 12 hours are enforced server-side against the table, never by trusting
 *  the cookie (which carries no Max-Age at all). */
export async function findPortalSession(token: string): Promise<{ id: string; phoneE164: string } | null> {
  const row = await queryOne<{ id: string; phone_e164: string }>(
    `select id, phone_e164 from public.portal_sessions
      where token_hash = $1 and revoked_at is null and expires_at > now()
      limit 1`,
    [hashToken(token)],
  );
  return row ? { id: row.id, phoneE164: row.phone_e164 } : null;
}

/** Revokes one session by its raw token. Returns the phone it belonged to (for
 *  the log) or null when the token matched nothing live. */
export async function revokePortalSession(token: string): Promise<string | null> {
  const row = await queryOne<{ phone_e164: string }>(
    `update public.portal_sessions set revoked_at = now()
      where token_hash = $1 and revoked_at is null
      returning phone_e164`,
    [hashToken(token)],
  );
  return row?.phone_e164 ?? null;
}

/** Revokes every live session of a phone — used when a phone stops being an
 *  active owner (a sale), so the open tab loses access on its next request. */
export async function revokePortalSessionsForPhone(phoneE164: string): Promise<number> {
  const r = await query(
    `update public.portal_sessions set revoked_at = now()
      where phone_e164 = $1 and revoked_at is null and expires_at > now()`,
    [phoneE164],
  );
  return r.rowCount ?? 0;
}
