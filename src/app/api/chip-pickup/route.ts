import { NextResponse } from 'next/server';
import { requireChipPickup } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { listReadyPickupOrders } from '@/lib/db/chipPickup';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/chip-pickup — the guard's pickup screen ("מסירת צ׳יפים", 25/11/2026).
// By ROLE (CHIP_PICKUP_ROLES: guard, admin, super admin), never a module.
//
// The answer is the NARROW read and nothing else: ONLY orders that are ready
// for pickup, and of each one its number, its apartment numbers, the names of
// its people and their active chip numbers (plus whether it is a test order).
// No price, amount or payment detail, no email, phone or address, no lease, no
// note and no test-mode control — they are not selected at all
// (src/lib/db/chipPickup.ts), so the screen cannot show what the server never
// sent. This route and the hand-over next to it are the guard's whole reach
// into the chips module: /chips, the issue window and every other chip
// endpoint stay behind their module permissions, which the guard cannot hold.
export async function GET() {
  try {
    await requireChipPickup();
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }
  const orders = await listReadyPickupOrders();
  return NextResponse.json({ orders }, { headers: { 'Cache-Control': 'private, no-store' } });
}
