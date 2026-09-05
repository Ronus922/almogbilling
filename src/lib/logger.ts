/**
 * The single application logger — pino underneath, console-compatible on top,
 * error-level records forwarded to Sentry. Import `logger` (or
 * `createLogger('scope')`) instead of `console.*`; ESLint `no-console`
 * enforces that (iron rule 3).
 *
 * Console-style calls keep working unchanged:
 *   logger.error('[POST /api/foo] failed', err);      → {"level":50,"msg":"[POST /api/foo] failed","err":{…}}
 *   logger.warn('[sync] skipped', id, reason);         → msg "[sync] skipped <id> <reason>"
 * pino-style calls work too — a leading plain object is the merge object:
 *   logger.info({ userId }, 'invite sent');            → {"level":30,"userId":…,"msg":"invite sent"}
 *
 * Normalisation of the argument list: the first plain object (not an Error) is
 * merged into the record; the first Error becomes `err` (pino's serializer);
 * strings/numbers/booleans are joined into `msg` with spaces, like console;
 * any further objects land in `extra`.
 *
 * error() also reports to Sentry — captureException when an Error is present,
 * captureMessage otherwise. Sentry is a no-op until initialised (SENTRY_DSN,
 * see src/instrumentation.ts / instrumentation-client.ts), so error() never
 * throws and needs no DSN in tests or local dev.
 *
 * Isomorphic: pino's browser build (console) on the client, stdout JSON on the
 * server. Not for the edge runtime — src/middleware.ts must not import it
 * (pino needs node streams there; it logs nothing today).
 */
import pino, { type Logger as PinoLogger, type LoggerOptions } from 'pino';
import * as Sentry from '@sentry/nextjs';

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  /** Child logger with fixed bindings, e.g. logger.child({ scope: 'wa-queue' }). */
  child(bindings: Record<string, unknown>): Logger;
  /** The underlying pino instance (level, flush, transports). */
  readonly pino: PinoLogger;
}

type Level = 'debug' | 'info' | 'warn' | 'error';

interface Normalised {
  record: Record<string, unknown>;
  msg: string;
  err?: Error;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !(v instanceof Error) && !Array.isArray(v);
}

function normalise(args: unknown[]): Normalised {
  const record: Record<string, unknown> = {};
  const parts: string[] = [];
  const extra: unknown[] = [];
  let err: Error | undefined;
  args.forEach((a, i) => {
    if (a instanceof Error) {
      if (err) extra.push(a);
      else err = a;
    } else if (i === 0 && isPlainObject(a)) {
      Object.assign(record, a);
    } else if (typeof a === 'string') {
      parts.push(a);
    } else if (typeof a === 'number' || typeof a === 'boolean' || typeof a === 'bigint' || a == null) {
      parts.push(String(a));
    } else {
      extra.push(a);
    }
  });
  if (err) record.err = err;
  if (extra.length) record.extra = extra;
  return { record, msg: parts.join(' '), err };
}

/** Never throws — monitoring must not take the app down with it. */
function forwardToSentry({ record, msg, err }: Normalised): void {
  try {
    const { err: _err, ...extra } = record;
    void _err;
    if (err) {
      Sentry.captureException(err, { extra: { ...extra, message: msg } });
    } else if (msg) {
      Sentry.captureMessage(msg, { level: 'error', extra });
    }
  } catch {
    // swallow
  }
}

function wrap(p: PinoLogger): Logger {
  const emit = (level: Level) => (...args: unknown[]) => {
    const n = normalise(args);
    if (level === 'error') forwardToSentry(n);
    p[level](n.record, n.msg);
  };
  return {
    debug: emit('debug'),
    info: emit('info'),
    warn: emit('warn'),
    error: emit('error'),
    child: (bindings) => wrap(p.child(bindings)),
    pino: p,
  };
}

const options: LoggerOptions = {
  level: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
  // No pid/hostname per line — systemd/journald already attributes the stream.
  base: undefined,
  timestamp: pino.stdTimeFunctions.isoTime,
  browser: { asObject: false },
};

// Under vitest (NODE_ENV=test) the JSON lines go to /dev/null so test output
// stays readable; normalisation and the Sentry forwarding still run.
// Set LOG_IN_TESTS=1 to see them while debugging a test.
const destination =
  process.env.NODE_ENV === 'test' && !process.env.LOG_IN_TESTS
    ? pino.destination({ dest: '/dev/null', sync: true })
    : undefined;

export const logger: Logger = wrap(pino(options, destination));

/** Child logger with a fixed scope, e.g. createLogger('wa-queue'). */
export function createLogger(scope: string): Logger {
  return logger.child({ scope });
}
