import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { getDbPool } from '@/lib/db';
import { writeAudit } from '@/lib/db/audit';
import {
  startCampaign, pauseCampaign, resumeCampaign, cancelCampaign, retryFailed,
  CampaignConflictError,
} from '@/lib/wa-queue/campaigns';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ACTIONS = ['start', 'pause', 'resume', 'cancel', 'retry_failed'] as const;
type Action = (typeof ACTIONS)[number];

// POST /api/whatsapp/campaigns/[id]/actions  { action, reason? }
// All state transitions (whatsapp_chat:edit). Backend authorization is enforced
// here regardless of what the UI shows — only a user with whatsapp_chat:edit can
// cancel. Invalid transitions → 409 Conflict.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let actor: Actor;
  try { actor = await requirePermission('whatsapp_chat', 'edit'); }
  catch (err) { const r = authErrorResponse(err); if (r) return r; throw err; }

  const { id } = await params;
  let body: { action?: unknown; reason?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'invalid_json' }, { status: 400 }); }
  const action = body.action as Action;
  if (!ACTIONS.includes(action)) return NextResponse.json({ error: 'unknown_action' }, { status: 400 });
  const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 500) : null;

  const pool = getDbPool();
  try {
    switch (action) {
      case 'start':        return NextResponse.json(await startCampaign(pool, id));
      case 'pause':        return NextResponse.json(await pauseCampaign(pool, id));
      case 'resume':       return NextResponse.json(await resumeCampaign(pool, id));
      case 'cancel': {
        const campaign = await cancelCampaign(pool, id);
        // Audit AFTER the mutation (fail-safe writer, never throws). Counts are the
        // reconciled truth: sent_count = already delivered, cancelled_count = the
        // remaining recipients stopped before sending.
        await writeAudit({
          actorUserId: actor.id,
          action: 'cancelled',
          entityType: 'wa_campaign',
          entityId: id,
          metadata: {
            cancelled_at: campaign.cancelled_at,
            sent_count: campaign.sent_count,
            failed_count: campaign.failed_count,
            remaining_cancelled: campaign.cancelled_count,
            total_count: campaign.total_count,
            reason,
          },
        });
        return NextResponse.json(campaign);
      }
      case 'retry_failed': return NextResponse.json(await retryFailed(pool, id));
    }
  } catch (err) {
    if (err instanceof CampaignConflictError) return NextResponse.json({ error: err.message }, { status: 409 });
    throw err;
  }
}
