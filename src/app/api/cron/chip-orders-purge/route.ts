import { NextResponse, after, type NextRequest } from 'next/server';
import { secretsMatch } from '@/lib/auth/cronSecret';
import {
  purgeUnattachedLeases, purgeUnpaidChipOrders, reconcilePendingCardOrders, type LeasePurgeResult,
} from '@/lib/chipOrders/cleanup';
import { afterOrderPaid } from '@/lib/chipOrders/notify';
import { processDueDocuments } from '@/lib/chipOrders/documents';
import { logger } from '@/lib/logger';
import { env } from '@/env';

export const runtime = 'nodejs';
export const maxDuration = 60;

// POST /api/cron/chip-orders-purge — secured by x-cron-secret (the same pattern
// as /api/cron/archive-work-items). Hourly (billing-chip-orders-purge.timer):
// real chip orders still unpaid 48 hours after they were created are deleted
// with their lease files (src/lib/chipOrders/cleanup.ts) — after PayPlus was
// asked about every payment session they had. An order PayPlus says WAS paid
// moves to "paid" instead, and its "received & paid" message goes out after
// the response. The same run reconciles orders whose payment session is 10
// minutes to 48 hours old (a lost callback) — `reconcile` in the answer. The
// counts are the run's log line in the journal.
//
// The same run issues the Morning documents that are due (26/11/2026 — the
// retries of the queue; `documents` in the answer; never fails the run).
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

  // The "received & paid" message of every order that turned paid in this run
  // (the audit row was written with the transition itself).
  const paid: string[] = [];
  let reconcile: Record<string, number> | null = null;
  try {
    const { paidOrderIds, ...counts } = await reconcilePendingCardOrders();
    paid.push(...paidOrderIds);
    reconcile = { ...counts, paid: paidOrderIds.length };
  } catch (err) {
    logger.error('[POST /api/cron/chip-orders-purge] reconcile', err);
  }

  let orders: Record<string, number> | null = null;
  try {
    const { paidOrderIds, ...counts } = await purgeUnpaidChipOrders();
    paid.push(...paidOrderIds);
    orders = { ...counts, paid: paidOrderIds.length };
  } catch (err) {
    logger.error('[POST /api/cron/chip-orders-purge] orders', err);
  }
  if (paid.length > 0) {
    after(async () => {
      for (const id of paid) await afterOrderPaid(id);
    });
  }

  const documents = await processDueDocuments(25);

  let leases: LeasePurgeResult | null = null;
  try {
    leases = await purgeUnattachedLeases();
  } catch (err) {
    logger.error('[POST /api/cron/chip-orders-purge] leases', err);
  }

  if (!orders || !leases || leases.fileFailed > 0) {
    return NextResponse.json({ error: 'purge_failed', ...(orders ?? {}), reconcile, documents, leases }, { status: 500 });
  }
  return NextResponse.json({ ok: true, ...orders, reconcile, documents, leases });
}
