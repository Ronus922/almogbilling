import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { listUnlinkedMessages } from '@/lib/db/chatMessages';

export const runtime = 'nodejs';

// GET /api/whatsapp/unlinked — inbound messages with no matched debtor.
// Gated on whatsapp:view (reading inbound is part of the module).
export async function GET() {
  try {
    await requirePermission('whatsapp', 'view');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const messages = await listUnlinkedMessages();
  return NextResponse.json(messages);
}
