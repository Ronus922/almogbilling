import { NextResponse, after, type NextRequest } from 'next/server';
import { secretsMatch } from '@/lib/auth/cronSecret';
import { purgeUnpaidChipOrders } from '@/lib/chipOrders/cleanup';
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
export async function POST(req: NextRequest) {
  const expected = env.BILLING_CRON_SECRET;
  if (!expected) {
    return NextResponse.json({ error: 'cron_disabled' }, { status: 503 });
  }

  const provided = req.headers.get('x-cron-secret') ?? '';
  if (!secretsMatch(provided, expected)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  try {
    const { paidOrderIds, ...counts } = await purgeUnpaidChipOrders();
    if (paidOrderIds.length > 0) {
      after(async () => {
        for (const id of paidOrderIds) await afterChipOrderPaid(id, 'purge');
      });
    }
    return NextResponse.json({ ok: true, ...counts, paid: paidOrderIds.length });
  } catch (err) {
    logger.error('[POST /api/cron/chip-orders-purge]', err);
    return NextResponse.json({ error: 'purge_failed' }, { status: 500 });
  }
}
