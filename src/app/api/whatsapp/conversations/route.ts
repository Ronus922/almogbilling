import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { listConversations } from '@/lib/db/whatsappConversations';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/whatsapp/conversations?search=… — the inbox conversation list.
// Gated on the whatsapp_chat module (the /messages inbox surface).
export async function GET(req: NextRequest) {
  try {
    await requirePermission('whatsapp_chat', 'view');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const search = req.nextUrl.searchParams.get('search') ?? '';
  const conversations = await listConversations(search);
  return NextResponse.json(conversations);
}
