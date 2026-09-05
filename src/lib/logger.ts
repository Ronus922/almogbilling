/**
 * The single application logger — pino, with error-level records forwarded to
 * Sentry. Import `logger` (or `createLogger('scope')`) instead of `console.*`;
 * ESLint `no-console` enforces that (iron rule 3).
 *
 *   logger.info({ userId }, 'invite sent');
 *   logger.error(err, '[POST /api/foo] failed');     // → Sentry.captureException
 *   logger.error('bllink sync returned 0 rows');      // → Sentry.captureMessage
 *
 * Sentry is a no-op until it is initialised (SENTRY_DSN set — see
 * src/instrumentation.ts / instrumentation-client.ts), so calling
 * logger.error never throws and needs no DSN in tests or local dev.
 *
 * Isomorphic: pino's browser build (console) on the client, stdout JSON on the
 * server. Not for the edge runtime — src/middleware.ts must not import it
 * (pino needs node streams there; it logs nothing today).
 */
import pino, { type Logger as PinoLogger, type LoggerOptions } from 'pino';
import * as Sentry from '@sentry/nextjs';

export type Logger = PinoLogger;

const ERROR_LEVEL = 50; // pino: error=50, fatal=60

function firstError(args: unknown[]): Error | undefined {
  return args.find((a): a is Error => a instanceof Error);
}

/** Forward an error-level record to Sentry. Never throws. */
function forwardToSentry(args: unknown[]): void {
  try {
    const err = firstError(args);
    const message = args.find((a): a is string => typeof a === 'string');
    const extra = args.find(
      (a): a is Record<string, unknown> => typeof a === 'object' && a !== null && !(a instanceof Error),
    );
    if (err) {
      Sentry.captureException(err, { extra: { ...(extra ?? {}), message } });
    } else if (message) {
      Sentry.captureMessage(message, { level: 'error', extra });
    }
  } catch {
    // Monitoring must never take the app down with it.
  }
}

const options: LoggerOptions = {
  level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
  // No pid/hostname per line — systemd/journald already attributes the stream.
  base: undefined,
  timestamp: pino.stdTimeFunctions.isoTime,
  hooks: {
    logMethod(args, method, level) {
      if (level >= ERROR_LEVEL) forwardToSentry(args);
      method.apply(this, args);
    },
  },
  browser: {
    asObject: false,
    // The hooks above do not run in the browser build — forward there too.
    transmit: {
      level: 'error',
      send(_level, logEvent) {
        forwardToSentry(logEvent.messages);
      },
    },
  },
};

// Under vitest (NODE_ENV=test) the JSON lines go to /dev/null so test output
// stays readable; the hooks — and therefore the Sentry forwarding — still run.
// Set LOG_IN_TESTS=1 to see them while debugging a test.
const destination =
  process.env.NODE_ENV === 'test' && !process.env.LOG_IN_TESTS
    ? pino.destination({ dest: '/dev/null', sync: true })
    : undefined;

export const logger: Logger = pino(options, destination);

/** Child logger with a fixed scope, e.g. createLogger('wa-queue'). */
export function createLogger(scope: string): Logger {
  return logger.child({ scope });
}
