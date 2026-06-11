import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { listChatMessagesByDebtor } from '@/lib/db/chatMessages';

export const runtime = 'nodejs';

// GET /api/whatsapp/messages?debtor_id=… — chronological message history for the
// debtor card's "היסטוריית WhatsApp" section. Gated on contacts:view, matching
// the rest of the debtor panel (comments / history endpoints).
export async function GET(req: NextRequest) {
  try {
    await requirePermission('contacts', 'view');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const debtorId = req.nextUrl.searchParams.get('debtor_id')?.trim();
  if (!debtorId) {
    return NextResponse.json({ error: 'debtor_id חסר' }, { status: 400 });
  }

  const messages = await listChatMessagesByDebtor(debtorId);
  return NextResponse.json(messages);
}
