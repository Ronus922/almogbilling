import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { getDbPool } from '@/lib/db';
import { listRecipients, type RecipientLogFilter } from '@/lib/wa-queue/campaigns';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const LOG_FILTERS: readonly RecipientLogFilter[] = [
  'pending', 'processing', 'sent', 'failed', 'skipped', 'cancelled', 'delivered', 'read',
];

// GET /api/whatsapp/campaigns/[id]/recipients?status=&limit=&offset= — the paginated
// delivery log (masked phones, joined debtor name/apartment) (whatsapp_chat:view).
// Returns { rows, total }.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try { await requirePermission('whatsapp_chat', 'view'); }
  catch (err) { const r = authErrorResponse(err); if (r) return r; throw err; }
  const { id } = await params;
  const sp = req.nextUrl.searchParams;
  const statusParam = sp.get('status');
  const status = statusParam && (LOG_FILTERS as readonly string[]).includes(statusParam)
    ? (statusParam as RecipientLogFilter) : undefined;
  return NextResponse.json(await listRecipients(getDbPool(), id, {
    status,
    limit: sp.get('limit') ? Number(sp.get('limit')) : undefined,
    offset: sp.get('offset') ? Number(sp.get('offset')) : undefined,
  }));
}
