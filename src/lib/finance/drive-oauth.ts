import 'server-only';
import { env } from '@/env';
import { getGoogleConfig, type GoogleConfig } from '@/lib/auth/google';

/**
 * OAuth for the Drive backup — the SAME Google OAuth client as the login
 * (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET), a DIFFERENT redirect URI and a
 * different scope. The login callback mints sessions; this one stores a
 * refresh token. Keeping them apart means a bug in one can never do the
 * other's job.
 *
 * The redirect URI must be registered on the OAuth client in GCP:
 *   https://billing.bios.co.il/api/finance/drive/callback
 */
export const DRIVE_CALLBACK_PATH = '/api/finance/drive/callback';

/** drive.file = only files this app created; openid+email = to record which
 *  account was connected (and warn when it is not the intended one). */
export const DRIVE_SCOPES = ['https://www.googleapis.com/auth/drive.file', 'openid', 'email'] as const;

export function getDriveOAuthConfig(): GoogleConfig | null {
  const cfg = getGoogleConfig();
  if (!cfg) return null;
  return { ...cfg, redirectUri: new URL(DRIVE_CALLBACK_PATH, env.APP_URL).toString() };
}
