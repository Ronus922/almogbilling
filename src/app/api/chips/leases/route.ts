import { NextResponse } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { checkRateLimit } from '@/lib/auth/rateLimit';
import { uploadChipOrderLease } from '@/lib/storage/chipOrderLeaseStorage';
import { isLeaseError, readLease } from '@/lib/chipOrders/lease';
import { CHIP_ORDER_LIMITS } from '@/lib/chipOrders/model';
import { logger } from '@/lib/logger';
import type { ChipLeaseRef } from '@/lib/types/chips';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The file plus the multipart envelope around it. */
const MAX_BODY_BYTES = CHIP_ORDER_LIMITS.leaseFileBytes + 64 * 1024;

// POST /api/chips/leases (chips:edit — the permission of the issue window) —
// the lease of a renter block of "הנפק צ׳יפ" (25/11/2026). Multipart, one
// `file`: a PDF or a photo, up to 10MB, checked exactly like the lease of a
// web order (extension, MIME and the file's own first bytes). It lands in the
// SAME private bucket (chip-order-leases) under a bare `<uuid>.<ext>` key and
// is opened only through /api/files/chip-order-leases/<key>, under the same
// rule as every lease there (chips_orders_manage:view).
//
// The answer is a reference, not a link: the window sends it back with the
// save, which writes it on the holder's chips. A file uploaded and never saved
// stays in the bucket unreferenced (the bucket is not swept by the Storage GC).
//
// A ceiling of 30 uploads an hour per user: a lease is attached once per
// renter, so nobody at the reception comes near it, and it bounds how much an
// account can pour into a bucket nothing sweeps.
export async function POST(req: Request) {
  let actor: Actor;
  try {
    actor = await requirePermission('chips', 'edit');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }
  const limit = await checkRateLimit(`chip-lease-upload:user:${actor.id}`, { max: 30, windowSec: 3600 });
  if (!limit.allowed) {
    return NextResponse.json({ error: 'יותר מדי העלאות בשעה האחרונה. נסו שוב מאוחר יותר.' }, { status: 429 });
  }

  const length = Number(req.headers.get('content-length') ?? 'NaN');
  if (!Number.isFinite(length) || length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'הקובץ גדול מדי. אפשר לצרף חוזה עד 10MB.' }, { status: 413 });
  }
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: 'invalid_form_data' }, { status: 400 });
  }
  const file = form.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'נדרש לצרף קובץ' }, { status: 400 });
  }
  const read = await readLease(file);
  if (isLeaseError(read)) return NextResponse.json({ error: read.error }, { status: 400 });

  try {
    // The key takes its extension from the file's own name; the name kept for
    // display is the same one cut to 200 characters, which may have lost it.
    const up = await uploadChipOrderLease(read.bytes, file.name, read.mime);
    const lease: ChipLeaseRef = { key: up.objectKey, name: read.name, mime: read.mime, size: up.sizeBytes };
    return NextResponse.json({ lease }, { status: 201 });
  } catch (err) {
    logger.error('[POST /api/chips/leases] upload failed', err);
    return NextResponse.json({ error: 'העלאת החוזה נכשלה. נסו שוב.' }, { status: 502 });
  }
}
