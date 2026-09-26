import 'server-only';
import { NextResponse, after } from 'next/server';
import { cookies } from 'next/headers';
import type { OAuth2Client } from 'google-auth-library';
import type { Actor } from '@/lib/auth/actor';
import { appUrl, createGoogleClient, getGoogleConfig } from '@/lib/auth/google';
import { upsertDriveConnection } from '@/lib/db/finance/drive';
import { writeAudit } from '@/lib/db/audit';
import { retryPendingDriveUploads } from '@/lib/finance/drive-sync';
import { FINANCE_DRIVE_ACCOUNT } from '@/lib/constants/finance';
import { logger } from '@/lib/logger';
import {
  DRIVE_NONCE_COOKIE, DRIVE_VERIFIER_COOKIE, isDriveStateExpired, requireDriveConnector, type DriveOAuthState,
} from './drive-oauth';

/**
 * The Drive branch of /api/auth/google/callback. Reached ONLY when the login
 * callback opened the `state` parameter as an authentic Drive state
 * (src/lib/finance/drive-oauth.ts); everything else in that route is the
 * unchanged login flow. This is NOT a login: no session is minted, the
 * `allow_google_auth` gate is never consulted and the signed-in admin stays
 * who they are. Every outcome redirects to the settings screen with
 * ?drive=connected or ?drive=error&reason=<code>.
 */

const TEMP_COOKIES = [DRIVE_NONCE_COOKIE, DRIVE_VERIFIER_COOKIE] as const;

export type DriveCallbackReason =
  | 'unavailable' | 'denied' | 'state' | 'session' | 'exchange'
  | 'no_email' | 'wrong_account' | 'no_refresh_token';

interface GoogleTokens {
  access_token?: string | null;
  refresh_token?: string | null;
  id_token?: string | null;
}

/** Best effort: a grant we refuse to store must not stay live in Google. */
async function revokeGrant(client: OAuth2Client, tokens: GoogleTokens): Promise<void> {
  const token = tokens.refresh_token ?? tokens.access_token;
  if (!token) return;
  try {
    await client.revokeToken(token);
  } catch (err) {
    logger.warn('[drive callback] revoke of a rejected grant failed', err);
  }
}

type Identity = { ok: true; email: string } | { ok: false; reason: 'no_email' | 'state' };

/** Who is behind the tokens: the verified e-mail from the id_token (nonce
 *  checked) or, when Google sent none, from userinfo. */
async function identify(client: OAuth2Client, tokens: GoogleTokens, cfg: { clientId: string }, nonce: string): Promise<Identity> {
  if (tokens.id_token) {
    const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: cfg.clientId });
    const payload = ticket.getPayload();
    // Replay protection: the nonce we sent must come back inside the id_token.
    if (!payload || payload.nonce !== nonce) return { ok: false, reason: 'state' };
    if (payload.email && payload.email_verified) return { ok: true, email: payload.email };
    return { ok: false, reason: 'no_email' };
  }
  if (tokens.access_token) {
    // openid/email were granted but no id_token came back — ask userinfo.
    const r = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    if (r.ok) {
      const info = (await r.json()) as { email?: string; email_verified?: boolean };
      if (info.email && info.email_verified) return { ok: true, email: info.email };
    }
  }
  return { ok: false, reason: 'no_email' };
}

export async function handleDriveCallback(reqUrl: string, state: DriveOAuthState): Promise<NextResponse> {
  const cookieStore = await cookies();
  const clearTemp = () => TEMP_COOKIES.forEach((n) => cookieStore.delete(n));
  const fail = (reason: DriveCallbackReason) => {
    clearTemp();
    return NextResponse.redirect(appUrl(`/finance/settings?drive=error&reason=${reason}`));
  };

  // 1. The state is authentic (that is how we got here); it must also be fresh
  //    and echo the nonce cookie this browser received at /start.
  if (isDriveStateExpired(state)) return fail('state');
  const nonceCookie = cookieStore.get(DRIVE_NONCE_COOKIE)?.value;
  const codeVerifier = cookieStore.get(DRIVE_VERIFIER_COOKIE)?.value;
  if (!nonceCookie || nonceCookie !== state.nonce || !codeVerifier) return fail('state');

  // 2. The same admin who started the flow must still be signed in.
  let actor: Actor;
  try { actor = await requireDriveConnector(); }
  catch { clearTemp(); return NextResponse.redirect(appUrl('/login')); }
  if (actor.id !== state.uid) return fail('session');

  const cfg = getGoogleConfig();
  if (!cfg) return fail('unavailable');

  const url = new URL(reqUrl);
  if (url.searchParams.get('error')) return fail('denied');
  const code = url.searchParams.get('code');
  if (!code) return fail('state');

  // 3. Exchange the code with the SAME redirect_uri the login uses (cfg).
  const client = createGoogleClient(cfg);
  let tokens: GoogleTokens;
  try {
    ({ tokens } = await client.getToken({ code, codeVerifier }));
  } catch (err) {
    logger.error('[drive callback] token exchange failed', err);
    return fail('exchange');
  }

  // 4. Only the designated account may hold the backups — anything else is
  //    refused, its grant revoked, nothing stored.
  let who: Identity;
  try {
    who = await identify(client, tokens, cfg, state.nonce);
  } catch (err) {
    logger.error('[drive callback] identity verification failed', err);
    await revokeGrant(client, tokens);
    return fail('exchange');
  }
  if (!who.ok) {
    await revokeGrant(client, tokens);
    return fail(who.reason);
  }
  const email = who.email;
  const normalized = email.trim().toLowerCase();
  if (normalized !== FINANCE_DRIVE_ACCOUNT) {
    await revokeGrant(client, tokens);
    await writeAudit({
      actorUserId: actor.id, action: 'drive_connect_rejected', entityType: 'fin_drive_connection',
      metadata: { email: normalized, reason: 'wrong_account' },
    });
    return fail('wrong_account');
  }

  // 5. Google returns a refresh token only on a consent it actually showed
  //    (prompt=consent asks for one every time; this guards the exception).
  //    Revoking the access token also revokes the earlier grant it belongs
  //    to, so the next attempt gets a fresh consent — and a refresh token.
  if (!tokens.refresh_token) {
    await revokeGrant(client, tokens);
    return fail('no_refresh_token');
  }

  await upsertDriveConnection({ email: normalized, refreshToken: tokens.refresh_token, connectedBy: actor.id });
  await writeAudit({ actorUserId: actor.id, action: 'drive_connected', entityType: 'fin_drive_connection', metadata: { email: normalized } });
  clearTemp();

  // Whatever was waiting for a connection gets its backup now.
  after(() => retryPendingDriveUploads(50).catch((err) => logger.error('[drive callback] retry failed', err)));

  return NextResponse.redirect(appUrl('/finance/settings?drive=connected'));
}
