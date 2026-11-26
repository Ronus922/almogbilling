import { NextResponse, after } from 'next/server';
import { requirePermission } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { countUnfinishedTestOrders, listOpenChipOrderRows } from '@/lib/db/chipOrders';
import { processDueDocuments } from '@/lib/chipOrders/documents';
import { morningConfig } from '@/lib/morning/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/chip-orders (chips_orders_manage:view) — the Orders tab: one row
// per APARTMENT of every open order (paid — being assigned — or ready), newest
// first; a row leaves once its order is collected or rejected (13/11/2026).
// pending_payment never appears. Test orders carry is_test;
// `unfinishedTestOrders` counts the test orders never finished
// (pending_payment), which only "מחק את כל הזמנות הבדיקה" removes.
// Loading the list also gives the Morning document queue a turn (after the
// answer; it claims only what is due — 26/11/2026).
export async function GET() {
  try {
    await requirePermission('chips_orders_manage', 'view');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }
  const [items, unfinishedTestOrders] = await Promise.all([listOpenChipOrderRows(), countUnfinishedTestOrders()]);
  after(() => processDueDocuments().then(() => undefined));
  // `documentsConnected`: Morning has a key — a queued document is being
  // issued; without one it waits ("חשבונית ממתינה לחיבור מורנינג").
  return NextResponse.json({ items, unfinishedTestOrders, documentsConnected: morningConfig() !== null });
}
