import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createHash, randomBytes } from 'node:crypto';
import { requirePermission } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { appUrl } from '@/lib/auth/google';
import { DRIVE_SCOPES, getDriveOAuthConfig } from '@/lib/finance/drive-oauth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TEMP_COOKIE_MAX_AGE = 600; // 10 minutes — enough to complete consent.

// GET /api/finance/drive/start — "חבר Google Drive": sends an admin to Google's
// consent screen for the drive.file scope. access_type=offline + prompt=consent
// is what makes Google return a REFRESH token (it returns one only on a consent
// it shows). State + PKCE exactly like the login flow (/api/auth/google/start).
export async function GET() {
  try { await requirePermission('finance', 'edit'); }
  catch (err) { const r = authErrorResponse(err); if (r) return r; throw err; }

  const cfg = getDriveOAuthConfig();
  if (!cfg) return NextResponse.redirect(appUrl('/finance/settings?drive=error&reason=unavailable'));

  const state = randomBytes(16).toString('base64url');
  const codeVerifier = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier).digest().toString('base64url');

  const cookieOpts = {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
    maxAge: TEMP_COOKIE_MAX_AGE,
  };
  const cookieStore = await cookies();
  cookieStore.set('fin_drive_state', state, cookieOpts);
  cookieStore.set('fin_drive_verifier', codeVerifier, cookieOpts);

  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: 'code',
    scope: DRIVE_SCOPES.join(' '),
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    access_type: 'offline',
    prompt: 'consent select_account',
    include_granted_scopes: 'false',
  });
  return NextResponse.redirect(`${GOOGLE_AUTH_ENDPOINT}?${params.toString()}`);
}
