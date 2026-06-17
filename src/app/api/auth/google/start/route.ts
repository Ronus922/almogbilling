import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createHash, randomBytes } from 'node:crypto';
import { getGoogleConfig, appUrl } from '@/lib/auth/google';

export const runtime = 'nodejs';

const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TEMP_COOKIE_MAX_AGE = 600; // 10 minutes — enough to complete consent.

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

export async function GET() {
  const cfg = getGoogleConfig();
  if (!cfg) {
    // Misconfigured env — fail soft to a friendly login error, not a 500.
    return NextResponse.redirect(appUrl('/login?error=google_unavailable'));
  }

  // CSRF (state), replay protection (nonce) and PKCE (verifier/challenge).
  const state = b64url(randomBytes(16));
  const nonce = b64url(randomBytes(16));
  const codeVerifier = b64url(randomBytes(32));
  const codeChallenge = b64url(createHash('sha256').update(codeVerifier).digest());

  const secure = process.env.NODE_ENV === 'production';
  const cookieOpts = {
    httpOnly: true,
    secure,
    sameSite: 'lax' as const, // survives the top-level GET redirect back from Google
    path: '/',
    maxAge: TEMP_COOKIE_MAX_AGE,
  };
  const cookieStore = await cookies();
  cookieStore.set('g_oauth_state', state, cookieOpts);
  cookieStore.set('g_oauth_nonce', nonce, cookieOpts);
  cookieStore.set('g_oauth_verifier', codeVerifier, cookieOpts);

  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    nonce,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    access_type: 'online',
    prompt: 'select_account',
  });

  return NextResponse.redirect(`${GOOGLE_AUTH_ENDPOINT}?${params.toString()}`);
}
