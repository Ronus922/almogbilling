import 'server-only';
import { OAuth2Client } from 'google-auth-library';
import { env } from '@/env';

/**
 * Google OAuth configuration, read from env. Returns null when any required
 * value is missing so callers can fail soft (redirect to a friendly error)
 * instead of throwing 500s. The redirect URI is derived from APP_URL — the
 * PUBLIC origin (https://billing.bios.co.il) — never request.url, which behind
 * nginx resolves to the internal upstream (127.0.0.1:3003).
 */
export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export function getGoogleConfig(): GoogleConfig | null {
  const clientId = env.GOOGLE_CLIENT_ID;
  const clientSecret = env.GOOGLE_CLIENT_SECRET;
  const appUrl = env.APP_URL;
  if (!clientId || !clientSecret || !appUrl) return null;

  return {
    clientId,
    clientSecret,
    redirectUri: new URL('/api/auth/google/callback', appUrl).toString(),
  };
}

/** Builds an OAuth2Client bound to the configured credentials + redirect URI. */
export function createGoogleClient(cfg: GoogleConfig): OAuth2Client {
  return new OAuth2Client({
    clientId: cfg.clientId,
    clientSecret: cfg.clientSecret,
    redirectUri: cfg.redirectUri,
  });
}

/** Absolute URL on the public origin — for redirects out of route handlers. */
export function appUrl(path: string): string {
  return new URL(path, env.APP_URL ?? 'http://localhost:3003').toString();
}
