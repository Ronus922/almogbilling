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

  it('console-style (message, err) forwards the Error to Sentry.captureException without throwing', () => {
    const err = new Error('boom');
    expect(() => logger.error('[test] failed', err)).not.toThrow();
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(captureException.mock.calls[0][0]).toBe(err);
    expect(captureException.mock.calls[0][1]).toMatchObject({ extra: { message: '[test] failed' } });
  });

  it('pino-style (err, message) works the same', () => {
    const err = new Error('boom');
    logger.error(err, '[test] failed');
    expect(captureException.mock.calls[0][0]).toBe(err);
  });

  it('plain message at error level → Sentry.captureMessage', () => {
    expect(() => logger.error('plain failure')).not.toThrow();
    expect(captureMessage).toHaveBeenCalledWith('plain failure', expect.objectContaining({ level: 'error' }));
    expect(captureException).not.toHaveBeenCalled();
  });

  it('joins primitives into the message like console and keeps objects as extra', () => {
    const write = vi.fn();
    const spy = vi.spyOn(logger.pino, 'error').mockImplementation(write as never);
    logger.error('[import:error]', 'run-1', 42, { a: 1 });
    expect(write).toHaveBeenCalledWith({ extra: [{ a: 1 }] }, '[import:error] run-1 42');
    spy.mockRestore();
  });

  it('a leading plain object is the pino merge object', () => {
    const write = vi.fn();
    const spy = vi.spyOn(logger.pino, 'info').mockImplementation(write as never);
    logger.info({ userId: 'u1' }, 'invite sent');
    expect(write).toHaveBeenCalledWith({ userId: 'u1' }, 'invite sent');
    spy.mockRestore();
  });

  it('does not forward info/warn records', () => {
    logger.info('hello');
    logger.warn({ x: 1 }, 'careful', new Error('not forwarded'));
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
