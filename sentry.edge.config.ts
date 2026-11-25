// Sentry — edge runtime (src/proxy.ts). Loaded by src/instrumentation.ts.
// Same runtime read as the server (the edge sandbox gets the live process.env),
// so the same restart switches it. No boot log here: pino (src/lib/logger.ts)
// cannot run on the edge, and the server line already reports the DSN state.
// Opt-in: with no SENTRY_DSN nothing is initialised and nothing is sent.
import * as Sentry from '@sentry/nextjs';
import { dropSensitiveRequestData, sentryRuntimeOptions } from '@/lib/sentry-options';

const options = sentryRuntimeOptions(process.env);

if (options) {
  // The body and the secret headers of a public chip-order request never go out with an event (see sentry-options.ts).
  Sentry.init({ ...options, beforeSend: dropSensitiveRequestData, beforeSendTransaction: dropSensitiveRequestData });
}
