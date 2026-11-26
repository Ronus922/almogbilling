import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Server-side Sentry reads SENTRY_DSN from the environment at RUNTIME, so the DSN
// in /etc/billing/billing.env takes effect on a restart. Until 07/10/2026 it was
// inlined at build time (next.config.ts `env`), and a build without it shipped
// with the init block minified away. scripts/check-sentry-build.mjs guards the
// compiled output in CI; these tests guard the source.

const { init, info } = vi.hoisted(() => ({ init: vi.fn(), info: vi.fn() }));
vi.mock('@sentry/nextjs', () => ({ init }));
vi.mock('@/lib/logger', () => ({ logger: { info } }));
vi.mock('@sentry/nextjs/config', () => ({ withSentryConfig: (config: unknown) => config }));

import { dropSensitiveRequestData, sentryRuntimeOptions } from '@/lib/sentry-options';

const DSN = 'https://publickey123@o1.ingest.de.sentry.io/42';

describe('sentryRuntimeOptions', () => {
  it('returns null without a DSN — unset, empty or blank', () => {
    expect(sentryRuntimeOptions({})).toBeNull();
    expect(sentryRuntimeOptions({ SENTRY_DSN: '' })).toBeNull();
    expect(sentryRuntimeOptions({ SENTRY_DSN: '   ' })).toBeNull();
  });

  it('keeps the existing settings: sendDefaultPii off, environment from NODE_ENV, 0.1 traces', () => {
    expect(sentryRuntimeOptions({ SENTRY_DSN: ` ${DSN} `, NODE_ENV: 'production' })).toEqual({
      dsn: DSN,
      environment: 'production',
      tracesSampleRate: 0.1,
      sendDefaultPii: false,
    });
  });

  it('SENTRY_ENVIRONMENT and SENTRY_TRACES_SAMPLE_RATE override; empty values count as unset', () => {
    const base = { SENTRY_DSN: DSN, NODE_ENV: 'production' };
    expect(sentryRuntimeOptions({ ...base, SENTRY_ENVIRONMENT: 'staging' })?.environment).toBe('staging');
    expect(sentryRuntimeOptions({ ...base, SENTRY_ENVIRONMENT: '' })?.environment).toBe('production');
    expect(sentryRuntimeOptions({ ...base, SENTRY_TRACES_SAMPLE_RATE: '0.25' })?.tracesSampleRate).toBe(0.25);
    expect(sentryRuntimeOptions({ ...base, SENTRY_TRACES_SAMPLE_RATE: '' })?.tracesSampleRate).toBe(0.1);
  });
});

describe('sentry.server.config — init from the live environment at boot', () => {
  beforeEach(() => {
    init.mockClear();
    info.mockClear();
    vi.resetModules();
    vi.stubEnv('SENTRY_ENVIRONMENT', '');
    vi.stubEnv('SENTRY_TRACES_SAMPLE_RATE', '');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('DSN in the environment → Sentry.init with it + one "Sentry initialized" line without the DSN', async () => {
    vi.stubEnv('SENTRY_DSN', DSN);
    vi.stubEnv('NODE_ENV', 'production');
    await import('../sentry.server.config');

    expect(init).toHaveBeenCalledTimes(1);
    expect(init).toHaveBeenCalledWith({
      dsn: DSN,
      environment: 'production',
      tracesSampleRate: 0.1,
      sendDefaultPii: false,
      // The body and the secret headers of a public chip-order request are dropped from every event (25/11/2026).
      beforeSend: expect.any(Function),
      beforeSendTransaction: expect.any(Function),
    });
    // Both hooks are the scrubber (the module was re-imported, so not the same function object).
    const passed = init.mock.calls[0]![0] as Record<'beforeSend' | 'beforeSendTransaction', (e: unknown) => unknown>;
    for (const hook of [passed.beforeSend, passed.beforeSendTransaction]) {
      expect(hook({ request: { url: '/api/public/chip-order/payplus/callback', data: { secret: 1 } } }))
        .toEqual({ request: { url: '/api/public/chip-order/payplus/callback' } });
    }
    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith({ environment: 'production', tracesSampleRate: 0.1 }, 'Sentry initialized');
    const logged = JSON.stringify(info.mock.calls);
    expect(logged).not.toContain(DSN);
    expect(logged).not.toContain('publickey123');
  });

  it('no DSN → no init, one "Sentry disabled (no DSN)" line', async () => {
    vi.stubEnv('SENTRY_DSN', '');
    await import('../sentry.server.config');

    expect(init).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith('Sentry disabled (no DSN)');
  });
});

describe('sentry.edge.config — same runtime read, no log', () => {
  beforeEach(() => {
    init.mockClear();
    info.mockClear();
    vi.resetModules();
  });
  afterEach(() => vi.unstubAllEnvs());

  it('initialises only when the environment has a DSN', async () => {
    vi.stubEnv('SENTRY_DSN', '');
    await import('../sentry.edge.config');
    expect(init).not.toHaveBeenCalled();

    vi.resetModules();
    vi.stubEnv('SENTRY_DSN', DSN);
    await import('../sentry.edge.config');
    expect(init).toHaveBeenCalledTimes(1);
    expect(init).toHaveBeenCalledWith(expect.objectContaining({ dsn: DSN, sendDefaultPii: false }));
    expect(info).not.toHaveBeenCalled();
  });
});

describe('next.config.ts — no build-time copy of the server DSN', () => {
  it('`env` never inlines the runtime Sentry variables (it would reach the server bundles)', async () => {
    const { default: config } = await import('../next.config');
    for (const key of ['SENTRY_DSN', 'SENTRY_ENVIRONMENT', 'SENTRY_TRACES_SAMPLE_RATE']) {
      expect(config.env ?? {}).not.toHaveProperty(key);
    }
  });

  it('every build-time variable the browser config reads is defined in `env`', async () => {
    const { default: config } = await import('../next.config');
    const source = readFileSync(path.resolve(__dirname, '../src/instrumentation-client.ts'), 'utf8');
    const read = [...source.matchAll(/process\.env\.([A-Z_]+)/g)].map((m) => m[1]).filter((k) => k !== 'NODE_ENV');
    expect(read).toEqual(expect.arrayContaining(['SENTRY_CLIENT_DSN', 'SENTRY_CLIENT_ENVIRONMENT']));
    for (const key of read) expect(config.env ?? {}).toHaveProperty(key);
  });
});

describe('dropSensitiveRequestData — a public chip-order request never leaves its body or its secret headers in an event', () => {
  const body = { transaction: { uid: 'tx' }, data: { card_information: { expiry_month: '05', identification_number: '000000018' } } };

  it('drops the body of the PayPlus callback, the session, the status and the order routes — and the two secret headers', () => {
    for (const url of [
      'https://example.test/api/public/chip-order/payplus/callback',
      // The callback URL names its environment since 26/11/2026.
      'https://example.test/api/public/chip-order/payplus/callback?env=production',
      'https://example.test/api/public/chip-order/payplus/callback?env=sandbox',
      'http://localhost:3003/api/public/chip-order/payplus/session',
      '/api/public/chip-order/payplus/status?x=1',
      'https://example.test/api/public/chip-order',
    ]) {
      const event = dropSensitiveRequestData({
        request: { url, data: structuredClone(body), method: 'POST', headers: { 'X-Chip-Order-Test': 'secret-token', hash: 'sig', 'user-agent': 'PayPlus' } },
      });
      expect(event.request).toEqual({ url, method: 'POST', headers: { 'user-agent': 'PayPlus' } });
      const text = JSON.stringify(event);
      for (const never of ['000000018', 'secret-token', 'sig"']) expect(text).not.toContain(never);
    }
  });

  it('leaves every other request, and an event with no request, as they are', () => {
    const other = { request: { url: 'https://example.test/api/health', data: { a: 1 }, headers: { hash: 'x' } } };
    expect(dropSensitiveRequestData(structuredClone(other))).toEqual(other);
    const plain: { message: string; request?: { url?: string } } = { message: 'x' };
    expect(dropSensitiveRequestData(plain)).toEqual({ message: 'x' });
  });
});
