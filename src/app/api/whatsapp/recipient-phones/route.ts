import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { listExtraRecipientsForDebtors } from '@/lib/db/contactPeople';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/whatsapp/recipient-phones?debtor_id=… — the ADDITIONAL owners/tenants
 * of the debtor's apartment card that are flagged "מקבל הודעות" and carry a
 * phone. The compose form appends these to its phone picker, so a second owner
 * can be picked as the recipient. The primary owner/tenant numbers already come
 * from the debtor row and are NOT repeated here. Gated on whatsapp:edit — same
 * permission the send itself requires.
 */
export async function GET(req: NextRequest) {
  try {
    await requirePermission('whatsapp', 'edit');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const debtorId = req.nextUrl.searchParams.get('debtor_id')?.trim() ?? '';
  if (!UUID_RE.test(debtorId)) {
    return NextResponse.json({ error: 'invalid_debtor_id' }, { status: 400 });
  }

  const rows = await listExtraRecipientsForDebtors([debtorId], ['owner', 'tenant']);
  const phones = rows.map((r) => {
    const role = r.role === 'owner' ? 'בעלים נוסף' : 'שוכר נוסף';
    return { phone: r.phone, label: r.name ? `${role} · ${r.name}` : role };
  });
  return NextResponse.json({ phones });
}
