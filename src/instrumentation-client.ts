// Sentry — browser. Next.js loads this file before the app hydrates.
// The DSN reaches the client bundle through next.config.ts `env` (build-time
// inline of SENTRY_DSN), so one variable configures every runtime.
// Opt-in: with no SENTRY_DSN nothing is initialised and nothing is sent.
import * as Sentry from '@sentry/nextjs';

const dsn = process.env.SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,
    tracesSampleRate: 0.1,
    sendDefaultPii: false,
  });
}

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
