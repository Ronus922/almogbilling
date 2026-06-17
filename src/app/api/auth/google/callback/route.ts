import { NextResponse, type NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { queryOne } from '@/lib/db';
import { createSession } from '@/lib/auth/session';
import { checkRateLimit, clientIp } from '@/lib/auth/rateLimit';
import { getGoogleConfig, createGoogleClient, appUrl } from '@/lib/auth/google';
import { AUTH_RATE_WINDOW_SEC, LOGIN_MAX_PER_IP } from '@/lib/constants';

export const runtime = 'nodejs';

const TEMP_COOKIES = ['g_oauth_state', 'g_oauth_nonce', 'g_oauth_verifier'] as const;

interface GateRow {
  id: string;
  is_active: boolean;
  allow_google_auth: boolean;
}

export async function GET(req: NextRequest) {
  const cookieStore = await cookies();
  const clearTemp = () => TEMP_COOKIES.forEach((n) => cookieStore.delete(n));

  // Helper: clear the one-shot OAuth cookies, then redirect to a login error.
  const fail = (code: string) => {
    clearTemp();
    return NextResponse.redirect(appUrl(`/login?error=${code}`));
  };

  // Coarse abuse cap on the callback by IP (independent of the password buckets).
  const rl = await checkRateLimit('google:ip:' + clientIp(req), {
    max: LOGIN_MAX_PER_IP,
    windowSec: AUTH_RATE_WINDOW_SEC,
  });
  if (!rl.allowed) return fail('google_failed');

  const cfg = getGoogleConfig();
  if (!cfg) return fail('google_unavailable');

  const url = new URL(req.url);
  // User denied consent, or Google returned an error.
  if (url.searchParams.get('error')) return fail('google_failed');

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const expectedState = cookieStore.get('g_oauth_state')?.value;
  const expectedNonce = cookieStore.get('g_oauth_nonce')?.value;
  const codeVerifier = cookieStore.get('g_oauth_verifier')?.value;

  // CSRF: state from Google must match the cookie we set in /start.
  if (!code || !state || !expectedState || state !== expectedState) {
    return fail('google_failed');
  }
  if (!codeVerifier || !expectedNonce) return fail('google_failed');

  // Exchange the code (with PKCE verifier) and verify the id_token signature,
  // issuer, audience and expiry. Any failure → generic google_failed.
  let email: string | undefined;
  let emailVerified: boolean | undefined;
  try {
    const client = createGoogleClient(cfg);
    const { tokens } = await client.getToken({ code, codeVerifier });
    if (!tokens.id_token) return fail('google_failed');

    const ticket = await client.verifyIdToken({
      idToken: tokens.id_token,
      audience: cfg.clientId,
    });
    const payload = ticket.getPayload();
    if (!payload) return fail('google_failed');

    // Replay protection: the nonce in the token must match the one we issued.
    if (payload.nonce !== expectedNonce) return fail('google_failed');

    email = payload.email;
    emailVerified = payload.email_verified;
  } catch {
    return fail('google_failed');
  }

  // Only trust a Google-verified email address.
  if (!email || emailVerified !== true) return fail('google_failed');

  // ── Per-user gate ───────────────────────────────────────────────
  // Default-deny: no matching user, disabled user, or Google not enabled for
  // them → ONE identical outcome (no enumeration of which condition failed).
  const row = await queryOne<GateRow>(
    `select id, is_active, allow_google_auth
       from public.users
      where lower(email) = lower($1)
      limit 1`,
    [email],
  );
  if (!row || !row.is_active || !row.allow_google_auth) {
    return fail('google_not_allowed');
  }

  // Success: mint a normal 24h session (remember=false), same almog_sid cookie
  // as a password login, then drop the one-shot OAuth cookies.
  await createSession(row.id, false);
  clearTemp();
  return NextResponse.redirect(appUrl('/dashboard'));
}
