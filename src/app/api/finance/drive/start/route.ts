import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createHash, randomBytes } from 'node:crypto';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { appUrl, getGoogleConfig } from '@/lib/auth/google';
import { FINANCE_DRIVE_ACCOUNT } from '@/lib/constants/finance';
import {
  DRIVE_NONCE_COOKIE, DRIVE_SCOPES, DRIVE_STATE_TTL_SEC, DRIVE_VERIFIER_COOKIE, newDriveNonce, requireDriveConnector, sealDriveState,
} from '@/lib/finance/drive-oauth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';

// GET /api/finance/drive/start — "חבר Google Drive": sends an admin to Google's
// account chooser (login_hint = the designated account) and consent screen for
// the drive.file scope. access_type=offline + prompt=consent is what makes
// Google return a REFRESH token. The redirect_uri is the LOGIN callback — the
// one already registered in GCP; the sealed `state` (flow marker + nonce +
// admin id + expiry) is what routes the return into the Drive branch there.
export async function GET() {
  let actorId: string;
  try { actorId = (await requireDriveConnector()).id; }
  catch (err) { const r = authErrorResponse(err); if (r) return r; throw err; }

  const cfg = getGoogleConfig();
  if (!cfg) return NextResponse.redirect(appUrl('/finance/settings?drive=error&reason=unavailable'));

  const nonce = newDriveNonce();
  const state = sealDriveState({ uid: actorId, nonce });
  const codeVerifier = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier).digest().toString('base64url');

  const cookieOpts = {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const, // survives the top-level GET redirect back from Google
    path: '/',
    maxAge: DRIVE_STATE_TTL_SEC,
  };
  const cookieStore = await cookies();
  cookieStore.set(DRIVE_NONCE_COOKIE, nonce, cookieOpts);
  cookieStore.set(DRIVE_VERIFIER_COOKIE, codeVerifier, cookieOpts);

  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: 'code',
    scope: DRIVE_SCOPES.join(' '),
    state,
    nonce,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    access_type: 'offline',
    prompt: 'select_account consent',
    login_hint: FINANCE_DRIVE_ACCOUNT,
    include_granted_scopes: 'false',
  });
  return NextResponse.redirect(`${GOOGLE_AUTH_ENDPOINT}?${params.toString()}`);
}
