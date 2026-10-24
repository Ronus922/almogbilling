import { NextResponse, type NextRequest } from 'next/server';
import { parseJsonBody } from '@/lib/http/body';
import {
  findPublicContext, getCompany, markRecipientViewed, upsertQuote, type PublicQuoteContext,
} from '@/lib/db/purchasing';
import { publicQuoteBodySchema } from '@/lib/validation/purchasing';
import { PUBLIC_HEADERS, publicReadGate, publicWriteGate } from '@/lib/purchasing/publicGate';
import { isRfqOpen, PURCHASING_LIMITS } from '@/lib/purchasing/model';
import { logger } from '@/lib/logger';
import { notifyQuoteSubmitted } from '@/lib/purchasing/notify';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// PUBLIC (no session) — the personal link of ONE supplier on ONE request.
// Everything is resolved from the token; the response carries no id that opens
// anything else. An unknown token and a deleted request are the same 404.
// (Listed in scripts/check-api-auth.mjs PUBLIC, with its token gate.)

interface Ctx { params: Promise<{ token: string }> }

const notFound = () => NextResponse.json({ error: 'not_found' }, { status: 404, headers: PUBLIC_HEADERS });

function view(ctx: PublicQuoteContext, companyName: string) {
  return {
    company_name: companyName,
    supplier_name: ctx.recipient.supplier_name,
    rfq: {
      number: ctx.rfq.number, title: ctx.rfq.title, doc_date: ctx.rfq.doc_date, due_date: ctx.rfq.due_date,
      notes: ctx.rfq.notes,
    },
    open: isRfqOpen(ctx.rfq.due_date),
    lines: ctx.lines,
    rfq_files: ctx.rfq_files.map((f) => ({ id: f.id, name: f.original_filename, size: f.file_size })),
    quote: ctx.quote && {
      valid_until: ctx.quote.valid_until,
      notes: ctx.quote.notes,
      prices: ctx.quote.prices,
      submitted_at: ctx.quote.submitted_at,
      updated_at: ctx.quote.updated_at,
      files: ctx.quote.files.map((f) => ({ id: f.id, name: f.original_filename, size: f.file_size, mine: f.uploaded_via === 'supplier' })),
    },
    limits: { files: PURCHASING_LIMITS.supplierFilesMax, file_bytes: PURCHASING_LIMITS.supplierFileBytes },
  };
}

export async function GET(req: NextRequest, ctx: Ctx) {
  const blocked = await publicReadGate(req);
  if (blocked) return blocked;
  const { token } = await ctx.params;
  const found = await findPublicContext(token);
  if (!found) return notFound();
  await markRecipientViewed(found.recipient.id).catch((e) => logger.error('[public quote] view stamp failed', e));
  const company = await getCompany();
  return NextResponse.json(view(found, company?.name ?? ''), { headers: PUBLIC_HEADERS });
}

// PUT — submit or amend the quote (a unit price for EVERY line, an optional
// validity date and note). Allowed through the due date; after it the link is
// read-only (403 `closed`).
export async function PUT(req: NextRequest, ctx: Ctx) {
  const { token } = await ctx.params;
  const blocked = await publicWriteGate(req, token);
  if (blocked) return blocked;
  const found = await findPublicContext(token);
  if (!found) return notFound();
  if (!isRfqOpen(found.rfq.due_date)) {
    return NextResponse.json({ error: 'closed', message: 'חלף תאריך היעד להגשה — ההצעה נעולה לעריכה' }, { status: 403, headers: PUBLIC_HEADERS });
  }

  const body = await parseJsonBody(req, publicQuoteBodySchema);
  if (!body.ok) return body.response;

  const lineIds = new Set(found.lines.map((l) => l.id));
  const given = Object.keys(body.data.prices);
  if (given.some((id) => !lineIds.has(id))) {
    return NextResponse.json({ error: 'שורה לא שייכת לבקשה' }, { status: 400, headers: PUBLIC_HEADERS });
  }
  if (found.lines.some((l) => body.data.prices[l.id] === undefined)) {
    return NextResponse.json({ error: 'יש להזין מחיר ליחידה בכל שורה' }, { status: 400, headers: PUBLIC_HEADERS });
  }

  const quoteId = await upsertQuote({
    rfq_id: found.rfq.id, supplier_id: found.recipient.supplier_id, party: found.recipient.party, source: 'portal',
    total_amount: null, valid_until: body.data.valid_until, notes: body.data.notes,
    prices: body.data.prices, actor_id: null,
  });
  // The creator of the request hears about it (bell + e-mail). Fire and forget:
  // the supplier's answer never waits for, or fails on, a notice.
  const fresh = await findPublicContext(token);
  if (fresh?.quote) {
    void notifyQuoteSubmitted({
      rfqId: found.rfq.id, quoteId, quoteStamp: fresh.quote.updated_at, isUpdate: found.quote !== null,
      supplierName: found.recipient.supplier_name,
    });
  }
  const company = await getCompany();
  return NextResponse.json(view(fresh ?? found, company?.name ?? ''), { headers: PUBLIC_HEADERS });
}
