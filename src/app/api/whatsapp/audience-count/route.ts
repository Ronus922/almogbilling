import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { resolveBroadcastRecipients } from '@/lib/whatsapp-broadcast';
import type { BroadcastAudienceType } from '@/types/whatsapp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TYPES: readonly BroadcastAudienceType[] = ['all', 'owners', 'tenants'];

// GET /api/whatsapp/audience-count?type=all|owners|tenants — how many recipients
// (debtors with a valid phone) a broadcast audience resolves to. whatsapp_chat:view.
export async function GET(req: NextRequest) {
  try {
    await requirePermission('whatsapp_chat', 'view');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const typeParam = req.nextUrl.searchParams.get('type') ?? 'all';
  const type = (TYPES as readonly string[]).includes(typeParam)
    ? (typeParam as BroadcastAudienceType)
    : 'all';

  const recipients = await resolveBroadcastRecipients({ type });
  return NextResponse.json({ count: recipients.length });
}
