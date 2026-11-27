import { NextResponse, after } from 'next/server';
import { requirePermission } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { countUnfinishedTestOrders, listChipOrderRowsByNumber, listOpenChipOrderRows } from '@/lib/db/chipOrders';
import { processDueDocuments } from '@/lib/chipOrders/documents';
import { morningConfig } from '@/lib/morning/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/chip-orders (chips_orders_manage:view) — the Orders tab: one row
// per APARTMENT of every open order (paid — being assigned — or ready), newest
// first; a row leaves once its order is collected or rejected (13/11/2026;
// the exceptions are listOpenChipOrderRows'). pending_payment never appears.
// `?number=N` (27/11/2026) — the rows of order N whatever its stage (the
// tab's search by number reaches a delivered order); nothing else is loaded,
// and an order that waits for payment is never returned. Test orders carry is_test;
// `unfinishedTestOrders` counts the test orders never finished
// (pending_payment), which only "מחק את כל הזמנות הבדיקה" removes.
// Loading the list also gives the Morning document queue a turn (after the
// answer; it claims only what is due — 26/11/2026).
export async function GET(req: Request) {
  try {
    await requirePermission('chips_orders_manage', 'view');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }
  const number = new URL(req.url).searchParams.get('number');
  if (number !== null) {
    // Digits only, an int4 the sequence can hold.
    if (!/^\d{1,9}$/.test(number)) return NextResponse.json({ error: 'invalid_number' }, { status: 400 });
    return NextResponse.json({ items: await listChipOrderRowsByNumber(Number(number)) }, { headers: { 'Cache-Control': 'no-store' } });
  }
  const [items, unfinishedTestOrders] = await Promise.all([listOpenChipOrderRows(), countUnfinishedTestOrders()]);
  after(() => processDueDocuments().then(() => undefined));
  // `documentsConnected`: Morning has a key — a queued document is being
  // issued; without one it waits ("חשבונית ממתינה לחיבור מורנינג").
  return NextResponse.json({ items, unfinishedTestOrders, documentsConnected: morningConfig() !== null });
}
