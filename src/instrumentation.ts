// Next.js instrumentation hook — runs once per server runtime at boot.
// Picks the Sentry config for the runtime; each config is a no-op without SENTRY_DSN.
import * as Sentry from '@sentry/nextjs';

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // Validate the environment before the first request. A missing or malformed
    // variable must stop the process here, with the names printed (src/env.ts),
    // not surface as a 500 on some later request.
    try {
      await import('./env');
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
    await import('../sentry.server.config');
  }
  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('../sentry.edge.config');
  }
}

// Errors thrown by React Server Components / route handlers before any code of
// ours could catch them.
export const onRequestError = Sentry.captureRequestError;
