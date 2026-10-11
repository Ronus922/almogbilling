import { NextResponse, type NextRequest } from 'next/server';
import { secretsMatch } from '@/lib/auth/cronSecret';
import { archiveOldClosedWorkItems } from '@/lib/db/workItems';
import { logger } from '@/lib/logger';
import { env } from '@/env';

export const runtime = 'nodejs';
export const maxDuration = 60;

// POST /api/cron/archive-work-items — secured by x-cron-secret (same pattern
// as /api/cron/reminders). Unified module (11/10/2026) daily sweep: issues/
// tasks closed more than 30 days ago move to the archive tab.
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
    const result = await archiveOldClosedWorkItems();
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    logger.error('[POST /api/cron/archive-work-items]', err);
    return NextResponse.json({ error: 'archive_failed' }, { status: 500 });
  }
}
