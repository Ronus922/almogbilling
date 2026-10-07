// Sentry — Node.js server runtime. Loaded by src/instrumentation.ts at boot.
// The DSN is read from the process environment at RUNTIME (billing.service gets
// it from /etc/billing/billing.env), so a restart turns Sentry on or off — no
// rebuild. See src/lib/sentry-options.ts for why it must not be build-inlined.
// Opt-in: with no SENTRY_DSN nothing is initialised and nothing is sent.
// One line per boot tells which it was (journalctl -u billing.service); the
// DSN itself is never logged.
import * as Sentry from '@sentry/nextjs';
import { logger } from '@/lib/logger';
import { sentryRuntimeOptions } from '@/lib/sentry-options';

const options = sentryRuntimeOptions(process.env);

if (options) {
  Sentry.init(options);
  logger.info(
    { environment: options.environment, tracesSampleRate: options.tracesSampleRate },
    'Sentry initialized',
  );
} else {
  logger.info('Sentry disabled (no DSN)');
}
