import 'server-only';
import { env } from '@/env';

/**
 * Single source of truth for the public app URL.
 * Used in all absolute URL construction (emails, redirects, etc).
 * Configured via APP_URL env var. Throws fail-closed in production
 * if missing, falls back to localhost in dev.
 */
export function appUrl(): string {
  const configured = env.APP_URL?.trim();
  if (configured) return configured.replace(/\/+$/, ''); // strip trailing slash
  if (process.env.NODE_ENV === 'production') {
    throw new Error('APP_URL is required in production');
  }
  return 'http://localhost:3003';
}
