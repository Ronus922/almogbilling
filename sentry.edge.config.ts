// Sentry — edge runtime (src/middleware.ts). Loaded by src/instrumentation.ts.
// Opt-in: with no SENTRY_DSN nothing is initialised and nothing is sent.
import * as Sentry from '@sentry/nextjs';

const dsn = process.env.SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? '0.1'),
    sendDefaultPii: false,
  });
}
