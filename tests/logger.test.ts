import { describe, it, expect, vi, beforeEach } from 'vitest';

// Sentry is mocked: the logger must forward error-level records to it and must
// never throw — with or without a DSN (the mock represents the "initialised"
// case; the real SDK is a no-op when it is not).
vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

import * as Sentry from '@sentry/nextjs';
import { logger, createLogger } from '@/lib/logger';

const captureException = vi.mocked(Sentry.captureException);
const captureMessage = vi.mocked(Sentry.captureMessage);

describe('logger', () => {
  beforeEach(() => {
    captureException.mockClear();
    captureMessage.mockClear();
  });

  it('forwards an Error at error level to Sentry.captureException without throwing', () => {
    const err = new Error('boom');
    expect(() => logger.error(err, '[test] failed')).not.toThrow();
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(captureException.mock.calls[0][0]).toBe(err);
  });

  it('forwards a plain message at error level to Sentry.captureMessage', () => {
    expect(() => logger.error('plain failure')).not.toThrow();
    expect(captureMessage).toHaveBeenCalledWith('plain failure', expect.objectContaining({ level: 'error' }));
    expect(captureException).not.toHaveBeenCalled();
  });

  it('does not forward info/warn records', () => {
    logger.info('hello');
    logger.warn({ x: 1 }, 'careful');
    expect(captureException).not.toHaveBeenCalled();
    expect(captureMessage).not.toHaveBeenCalled();
  });

  it('survives a throwing Sentry', () => {
    captureException.mockImplementationOnce(() => {
      throw new Error('sentry down');
    });
    expect(() => logger.error(new Error('x'), 'still fine')).not.toThrow();
  });

  it('child loggers keep the forwarding', () => {
    const log = createLogger('scope');
    log.error(new Error('child'));
    expect(captureException).toHaveBeenCalledTimes(1);
  });
});
