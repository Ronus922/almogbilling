import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// GET /api/debtors/[id]/pdf — what the caller sees when the render cannot run
// (01/11/2026). The server had no /usr/bin/google-chrome-stable, every export
// answered a bare 502 and the UI could only say "הפקת ה-PDF נכשלה". A failed
// render is now a 500 whose JSON carries the message the toast shows, a missing
// browser is told apart from a render error, and a throwing browser.close()
// cannot turn a good PDF into an unhandled error.

const h = vi.hoisted(() => ({
  access: vi.fn<(path: string, mode: number) => Promise<void>>(),
  launch: vi.fn(),
  goto: vi.fn(async () => undefined),
  close: vi.fn(async () => undefined),
  warn: vi.fn(),
}));

vi.mock('@/env', () => ({ env: { CHROME_PATH: undefined, INTERNAL_BASE_URL: undefined } }));
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: h.warn, error: vi.fn() },
}));
vi.mock('@/lib/auth/actor', () => ({ requireAnyPermission: vi.fn(async () => undefined) }));
vi.mock('@/lib/auth/apiGuard', () => ({ authErrorResponse: vi.fn(() => null) }));
vi.mock('@/lib/db/debtors', () => ({ getDebtorApartmentNumber: vi.fn(async () => '12') }));
vi.mock('next/headers', () => ({ cookies: vi.fn(async () => ({ get: () => ({ value: 'sid' }) })) }));
vi.mock('node:fs/promises', () => ({ access: h.access, constants: { X_OK: 1 } }));
vi.mock('puppeteer-core', () => ({ default: { launch: h.launch } }));

import { GET } from '@/app/api/debtors/[id]/pdf/route';

const ID = 'd4af0252-4df1-4250-9c7b-52b189f99a4e';

async function exportPdf() {
  return GET(new NextRequest(`http://localhost/api/debtors/${ID}/pdf`), {
    params: Promise.resolve({ id: ID }),
  });
}

async function errorBody(res: Response) {
  return (await res.json()) as { error?: string; message?: string };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.access.mockResolvedValue(undefined);
  h.goto.mockResolvedValue(undefined);
  h.close.mockResolvedValue(undefined);
  h.launch.mockResolvedValue({
    newPage: async () => ({
      setCookie: async () => undefined,
      goto: h.goto,
      emulateMediaType: async () => undefined,
      pdf: async () => new Uint8Array([0x25, 0x50, 0x44, 0x46]),
    }),
    close: h.close,
  });
});

describe('GET /api/debtors/[id]/pdf — browser missing', () => {
  it('no executable at the Chrome path → 500 with its own message, the browser is never launched', async () => {
    h.access.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    const res = await exportPdf();

    expect(res.status).toBe(500);
    const body = await errorBody(res);
    expect(body.error).toBe('pdf_browser_unavailable');
    expect(body.message).toContain('הדפדפן להפקה לא מותקן');
    expect(h.launch).not.toHaveBeenCalled();
  });

  it('checks the default path, as an executable, when CHROME_PATH is unset', async () => {
    h.access.mockRejectedValue(new Error('ENOENT'));

    await exportPdf();

    expect(h.access).toHaveBeenCalledWith('/usr/bin/google-chrome-stable', 1);
  });
});

describe('GET /api/debtors/[id]/pdf — render failures', () => {
  it('the page fails to load → 500 (never 502) with a message, and the browser is closed once', async () => {
    h.goto.mockRejectedValue(new Error('net::ERR_CONNECTION_REFUSED'));

    const res = await exportPdf();

    expect(res.status).toBe(500);
    const body = await errorBody(res);
    expect(body.error).toBe('pdf_render_failed');
    expect(body.message).toContain('הפקת ה-PDF נכשלה');
    expect(h.close).toHaveBeenCalledTimes(1);
  });

  it('launch itself rejects → 500 with a message, nothing to close', async () => {
    h.launch.mockRejectedValue(new Error('Failed to launch the browser process'));

    const res = await exportPdf();

    expect(res.status).toBe(500);
    expect((await errorBody(res)).error).toBe('pdf_render_failed');
    expect(h.close).not.toHaveBeenCalled();
  });
});

describe('GET /api/debtors/[id]/pdf — success', () => {
  it('returns the PDF with the download headers and closes the browser', async () => {
    const res = await exportPdf();

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition')).toContain('attachment');
    expect(Buffer.from(await res.arrayBuffer()).toString('latin1')).toBe('%PDF');
    expect(h.close).toHaveBeenCalledTimes(1);
  });

  it('a browser.close() that throws does not replace a good PDF with an error', async () => {
    h.close.mockRejectedValue(new Error('Target closed'));

    const res = await exportPdf();

    expect(res.status).toBe(200);
    expect(h.warn).toHaveBeenCalledTimes(1);
  });
});
