import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { listChatMessagesByDebtor } from '@/lib/db/chatMessages';
import { listAttachmentsForMessages } from '@/lib/db/whatsappMessageAttachments';
import { buildProxyUrl, type PrivateBucket, PRIVATE_BUCKETS } from '@/lib/storage/server';
import type { ChatMessage } from '@/types/whatsapp';

export const runtime = 'nodejs';

// GET /api/whatsapp/messages?debtor_id=… — chronological message history for the
// debtor card's "היסטוריית WhatsApp" section. Gated on contacts:view, matching
// the rest of the debtor panel (comments / history endpoints).
function isPrivateBucket(b: string): b is PrivateBucket {
  return (PRIVATE_BUCKETS as readonly string[]).includes(b);
}

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
  // Every file of each outbound message, addressed through the authenticated
  // proxy — the bytes live in the private bucket and are never public.
  const byMessage = await listAttachmentsForMessages(messages.map((m) => m.id));
  const withFiles: ChatMessage[] = messages.map((m) => {
    const files = byMessage.get(m.id);
    if (!files?.length) return m;
    return {
      ...m,
      attachments: files.map((f) => ({
        id: f.id,
        original_name: f.original_name,
        mime_type: f.mime_type,
        size_bytes: f.size_bytes,
        url: isPrivateBucket(f.bucket) ? buildProxyUrl(f.bucket, f.object_key) : '',
        // green_api_error is stamped when the upload or the send failed: the
        // file belongs to the message but the recipient never got it.
        ...(f.green_api_error ? { failed: true } : {}),
      })),
    };
  });
  return NextResponse.json(withFiles);
}
