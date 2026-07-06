import { NextResponse, type NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import puppeteer, { type Browser } from 'puppeteer-core';
import { requireAnyPermission } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { getDebtorApartmentNumber } from '@/lib/db/debtors';
import { SESSION_COOKIE } from '@/lib/constants';

export const runtime = 'nodejs';

const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/google-chrome-stable';
// billing serves on loopback :3003; the renderer hits the print page there with
// the caller's session cookie forwarded so the auth-gated page renders as them.
const INTERNAL_BASE = process.env.INTERNAL_BASE_URL || 'http://127.0.0.1:3003';
const RENDER_TIMEOUT_MS = 30_000;

interface RouteCtx {
  params: Promise<{ id: string }>;
}

// RFC 5987 disposition so the Hebrew filename survives (ASCII fallback + UTF-8).
function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_') || 'document.pdf';
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

// GET /api/debtors/[id]/pdf  (dashboard:view | contacts:view) — renders the print
// page to a PDF via headless Chrome. ponytail: launches/closes a browser per
// request (no pool) — fine for an occasional debtor-card action.
export async function GET(_req: NextRequest, ctx: RouteCtx) {
  try {
    await requireAnyPermission([
      { module: 'dashboard', action: 'view' },
      { module: 'contacts', action: 'view' },
    ]);
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const { id } = await ctx.params;
  const apt = await getDebtorApartmentNumber(id);
  if (!apt) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const sid = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!sid) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  let browser: Browser | null = null;
  try {
    browser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    const page = await browser.newPage();
    await page.setCookie({ name: SESSION_COOKIE, value: sid, url: INTERNAL_BASE });
    await page.goto(`${INTERNAL_BASE}/debtors/${id}/print`, {
      waitUntil: 'networkidle0',
      timeout: RENDER_TIMEOUT_MS,
    });
    await page.emulateMediaType('print');
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '14mm', bottom: '14mm', left: '12mm', right: '12mm' },
    });

    return new NextResponse(Buffer.from(pdf), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': contentDisposition(`פרטי דירה ${apt}.pdf`),
        'Content-Length': String(pdf.length),
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (err) {
    console.error('[GET /api/debtors/:id/pdf] render failed', err);
    return NextResponse.json({ error: 'pdf_render_failed' }, { status: 502 });
  } finally {
    if (browser) await browser.close();
  }
}
