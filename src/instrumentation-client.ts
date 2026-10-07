// Sentry — browser. Next.js loads this file before the app hydrates.
// The browser has no process.env, so its DSN is a BUILD-time value: next.config.ts
// `env` inlines the build environment's SENTRY_DSN as SENTRY_CLIENT_DSN (and
// SENTRY_ENVIRONMENT as SENTRY_CLIENT_ENVIRONMENT). Separate names on purpose —
// the server reads SENTRY_DSN at runtime and must not get a build-time copy.
// Opt-in: with no DSN in the build environment nothing is initialised or sent.
import * as Sentry from '@sentry/nextjs';

const dsn = process.env.SENTRY_CLIENT_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.SENTRY_CLIENT_ENVIRONMENT || process.env.NODE_ENV,
    tracesSampleRate: 0.1,
    sendDefaultPii: false,
  });
}

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
