import { NextResponse, type NextRequest } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { runReminders } from '@/lib/reminders/engine';
import { logger } from '@/lib/logger';
import { env } from '@/env';

export const runtime = 'nodejs';
export const maxDuration = 120;

/** Constant-time string compare; safe against length leaks. */
function secretsMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// POST /api/cron/reminders — secured by x-cron-secret. Processes due reminders.
// Same auth pattern as the sync cron: a shared secret in the env, no session.
export async function POST(req: NextRequest) {
  const expected = env.BILLING_CRON_SECRET;
  // Fail-closed: if no secret is configured the endpoint is disabled entirely.
  if (!expected) {
    return NextResponse.json({ error: 'cron_disabled' }, { status: 503 });
  }

  const provided = req.headers.get('x-cron-secret') ?? '';
  if (!secretsMatch(provided, expected)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  try {
    const result = await runReminders();
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    logger.error('[POST /api/cron/reminders]', err);
    return NextResponse.json({ error: 'reminders_failed' }, { status: 500 });
  }
}
