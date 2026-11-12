import { NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { setChipOrderInvoice } from '@/lib/db/chipOrders';
import { flattenGrowCallback } from '@/lib/grow/client';
import { callbackSignatureValid } from '@/lib/chipOrders/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/public/chip-order/grow/invoice?o=<order>&s=<sig> — Grow's invoice
// callback (invoiceNotifyUrl, R/invoice-server-response):
//   [{ transactionId, processId, invoiceNumber, invoiceUrl }]
// PUBLIC BY DESIGN (Grow calls it), gated by OUR HMAC of the order id and by
// the processId stored on the order. It only attaches the link to Grow's own
// document — nothing about the payment changes here.

function pickInvoice(body: unknown): { processId: string; url: string; number: string | null } | null {
  const first = Array.isArray(body) ? body[0] : body;
  const r = (first ?? {}) as Record<string, unknown>;
  const url = typeof r.invoiceUrl === 'string' ? r.invoiceUrl : '';
  const processId = r.processId === undefined ? '' : String(r.processId);
  if (!/^https:\/\//.test(url) || !processId) return null;
  return { processId, url: url.slice(0, 500), number: r.invoiceNumber === undefined ? null : String(r.invoiceNumber).slice(0, 50) };
}

export async function POST(req: Request) {
  const url = new URL(req.url);
  const orderId = url.searchParams.get('o') ?? '';
  if (!/^[0-9a-f-]{36}$/i.test(orderId) || !callbackSignatureValid('invoice', orderId, url.searchParams.get('s'))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const type = req.headers.get('content-type') ?? '';
  let body: unknown = null;
  if (type.includes('application/json')) {
    body = await req.json().catch(() => null);
  } else {
    const form = await req.formData().catch(() => null);
    if (form) body = flattenGrowCallback(form.entries());
  }
  const invoice = pickInvoice(body);
  if (!invoice) return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  const ok = await setChipOrderInvoice(orderId, invoice.processId, { url: invoice.url, number: invoice.number });
  if (!ok) logger.warn('[chip-order] invoice callback for an unknown process', { orderId });
  return NextResponse.json({ ok });
}
