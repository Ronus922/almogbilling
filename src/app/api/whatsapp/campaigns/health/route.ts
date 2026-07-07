import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { getDbPool } from '@/lib/db';
import { queueHealth } from '@/lib/wa-queue/health';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/whatsapp/campaigns/health — worker liveness + queue lag + stuck
// campaigns, for the ops dashboard / site-health integration (whatsapp_chat:view).
export async function GET() {
  try { await requirePermission('whatsapp_chat', 'view'); }
  catch (err) { const r = authErrorResponse(err); if (r) return r; throw err; }
  const health = await queueHealth(getDbPool());
  return NextResponse.json(health, { status: health.ok ? 200 : 503 });
}
