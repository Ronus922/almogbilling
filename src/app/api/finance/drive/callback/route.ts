import { NextResponse, type NextRequest, after } from 'next/server';
import { cookies } from 'next/headers';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { appUrl, createGoogleClient } from '@/lib/auth/google';
import { getDriveOAuthConfig } from '@/lib/finance/drive-oauth';
import { retryPendingDriveUploads } from '@/lib/finance/drive-sync';
import { upsertDriveConnection } from '@/lib/db/finance/drive';
import { writeAudit } from '@/lib/db/audit';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TEMP_COOKIES = ['fin_drive_state', 'fin_drive_verifier'] as const;

// GET /api/finance/drive/callback — Google sends the admin back here. Guarded
// by the SESSION (the same admin who pressed "חבר Google Drive" must still be
// logged in — this is not a login) plus the state cookie. The refresh token is
// encrypted into fin_drive_connection; every outcome redirects to the settings
// screen with ?drive=connected or ?drive=error&reason=<code>.
export async function GET(req: NextRequest) {
  const cookieStore = await cookies();
  const clearTemp = () => TEMP_COOKIES.forEach((n) => cookieStore.delete(n));
  const fail = (reason: string) => {
    clearTemp();
    return NextResponse.redirect(appUrl(`/finance/settings?drive=error&reason=${reason}`));
  };

  let actor: Actor;
  try { actor = await requirePermission('finance', 'edit'); }
  catch { return NextResponse.redirect(appUrl('/login')); }

  const cfg = getDriveOAuthConfig();
  if (!cfg) return fail('unavailable');

  const url = new URL(req.url);
  if (url.searchParams.get('error')) return fail('denied');

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const expectedState = cookieStore.get('fin_drive_state')?.value;
  const codeVerifier = cookieStore.get('fin_drive_verifier')?.value;
  if (!code || !state || !expectedState || state !== expectedState || !codeVerifier) return fail('state');

  let email: string | undefined;
  let refreshToken: string | undefined;
  try {
    const client = createGoogleClient(cfg);
    const { tokens } = await client.getToken({ code, codeVerifier });
    refreshToken = tokens.refresh_token ?? undefined;
    if (tokens.id_token) {
      const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: cfg.clientId });
      const payload = ticket.getPayload();
      if (payload?.email && payload.email_verified) email = payload.email;
    }
    if (!email && tokens.access_token) {
      // openid/email were granted but no id_token came back — ask userinfo.
      const r = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });
      if (r.ok) {
        const info = (await r.json()) as { email?: string; email_verified?: boolean };
        if (info.email && info.email_verified) email = info.email;
      }
    }
  } catch (err) {
    logger.error('[GET /api/finance/drive/callback] token exchange failed', err);
    return fail('exchange');
  }

  // Google returns a refresh token only on a consent it actually showed. If the
  // user had already granted this app before and Google skipped the screen,
  // there is none — the settings screen tells them to revoke and reconnect.
  if (!refreshToken) return fail('no_refresh_token');
  if (!email) return fail('no_email');

  await upsertDriveConnection({ email: email.toLowerCase(), refreshToken, connectedBy: actor.id });
  await writeAudit({ actorUserId: actor.id, action: 'drive_connected', entityType: 'fin_drive_connection', metadata: { email: email.toLowerCase() } });
  clearTemp();

  // Whatever was waiting for a connection gets its backup now.
  after(() => retryPendingDriveUploads(50).catch((err) => logger.error('[drive callback] retry failed', err)));

  return NextResponse.redirect(appUrl('/finance/settings?drive=connected'));
}
