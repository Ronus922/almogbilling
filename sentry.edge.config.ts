// Sentry — edge runtime (src/middleware.ts). Loaded by src/instrumentation.ts.
// Same runtime read as the server (the edge sandbox gets the live process.env),
// so the same restart switches it. No boot log here: pino (src/lib/logger.ts)
// cannot run on the edge, and the server line already reports the DSN state.
// Opt-in: with no SENTRY_DSN nothing is initialised and nothing is sent.
import * as Sentry from '@sentry/nextjs';
import { sentryRuntimeOptions } from '@/lib/sentry-options';

const options = sentryRuntimeOptions(process.env);

if (options) {
  Sentry.init(options);
}
