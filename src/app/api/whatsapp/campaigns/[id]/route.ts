import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { getDbPool } from '@/lib/db';
import { getCampaignDetail } from '@/lib/wa-queue/campaigns';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/whatsapp/campaigns/[id] — live campaign state + creator name from the
// DB, for the details header (whatsapp_chat:view).
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try { await requirePermission('whatsapp_chat', 'view'); }
  catch (err) { const r = authErrorResponse(err); if (r) return r; throw err; }
  const { id } = await params;
  const campaign = await getCampaignDetail(getDbPool(), id);
  if (!campaign) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  return NextResponse.json(campaign);
}
