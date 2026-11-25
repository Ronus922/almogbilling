import { NextResponse, after, type NextRequest } from 'next/server';
import { secretsMatch } from '@/lib/auth/cronSecret';
import { purgeUnattachedLeases, purgeUnpaidChipOrders, type LeasePurgeResult } from '@/lib/chipOrders/cleanup';
import { afterChipOrderPaid } from '@/lib/chipOrders/payment';
import { logger } from '@/lib/logger';
import { env } from '@/env';

export const runtime = 'nodejs';
export const maxDuration = 60;

// POST /api/cron/chip-orders-purge — secured by x-cron-secret (the same pattern
// as /api/cron/archive-work-items). Hourly (billing-chip-orders-purge.timer):
// real chip orders still unpaid 48 hours after they were created are deleted
// with their lease files (src/lib/chipOrders/cleanup.ts). An order Grow says
// WAS paid moves to "paid" instead, and its "received & paid" message goes out
// after the response. The counts are the run's log line in the journal.
//
// The same run sweeps the leases nobody saved (25/11/2026): a lease that the
// issue window uploaded, and that no saved order line, holder line or chip
// points at, is deleted 24 hours after its upload — `leases` in the answer.
// The two parts are independent: the leases are swept also when the orders
// part failed. The run FAILS (500 — so the unit's alert fires), with the
// counts of whatever did run, when either part threw or when Storage refused
// to delete a lease: a sweep that cannot delete must not look like one that
// had nothing to do.
export async function POST(req: NextRequest) {
  const expected = env.BILLING_CRON_SECRET;
  if (!expected) {
    return NextResponse.json({ error: 'cron_disabled' }, { status: 503 });
  }

  const provided = req.headers.get('x-cron-secret') ?? '';
  if (!secretsMatch(provided, expected)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let orders: Record<string, number> | null = null;
  try {
    const { paidOrderIds, ...counts } = await purgeUnpaidChipOrders();
    if (paidOrderIds.length > 0) {
      after(async () => {
        for (const id of paidOrderIds) await afterChipOrderPaid(id, 'purge');
      });
    }
    orders = { ...counts, paid: paidOrderIds.length };
  } catch (err) {
    logger.error('[POST /api/cron/chip-orders-purge] orders', err);
  }

  let leases: LeasePurgeResult | null = null;
  try {
    leases = await purgeUnattachedLeases();
  } catch (err) {
    logger.error('[POST /api/cron/chip-orders-purge] leases', err);
  }

  if (!orders || !leases || leases.fileFailed > 0) {
    return NextResponse.json({ error: 'purge_failed', ...(orders ?? {}), leases }, { status: 500 });
  }
  return NextResponse.json({ ok: true, ...orders, leases });
}
