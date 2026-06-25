import { type NextRequest } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { emitChat, subscribeChat } from '@/lib/whatsapp-events';
import { touchLastSeen } from '@/lib/db/internalChat';
import type { ChatStreamEvent } from '@/lib/types/internalChat';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Disable caching/transforms on this long-lived response.
export const fetchCache = 'force-no-store';

// GET /api/chat/stream — Server-Sent Events for the internal chat: live presence
// (who's online) + typing indicators. REUSES the WhatsApp SSE bus/pattern, but is
// gated on internal_chat (NOT whatsapp_chat) so every chat user gets it without
// leaking WhatsApp events. Presence is broadcast to all chat clients (offline is
// derived client-side by TTL); typing is scoped to the conversation's other
// participants via recipient_ids. Auth via the session cookie (EventSource sends
// it same-origin).
//
// nginx: `X-Accel-Buffering: no` disables proxy buffering (same as the WhatsApp
// stream). The 25s heartbeat (< proxy_read_timeout 300s) keeps the connection
// alive AND refreshes the user's last_seen_at + re-broadcasts their presence so
// other clients' TTLs stay fresh.

const HEARTBEAT_MS = 25_000;

export async function GET(req: NextRequest) {
  let actor: Actor;
  try {
    actor = await requirePermission('internal_chat', 'view');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const me = actor.id;
  const encoder = new TextEncoder();
  // Hoisted so the stream's cancel() can run the same idempotent teardown.
  let cleanup: () => void = () => {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;

      const write = (chunk: string): boolean => {
        if (closed) return false;
        try {
          controller.enqueue(encoder.encode(chunk));
          return true;
        } catch {
          closed = true;
          return false;
        }
      };

      // Initial comment so the client's `onopen` fires immediately.
      write(': connected\n\n');

      // Mark online now + announce to other open clients.
      void touchLastSeen(me);
      emitChat({ type: 'presence', user_id: me, online: true });

      const unsubscribe = subscribeChat((event: ChatStreamEvent) => {
        if (event.type === 'presence') {
          if (event.user_id === me) return; // never echo a client its own presence
          write(`event: presence\ndata: ${JSON.stringify(event)}\n\n`);
          return;
        }
        // typing — deliver ONLY to the conversation's other participants.
        if (event.user_id === me) return;
        if (!event.recipient_ids.includes(me)) return;
        write(`event: typing\ndata: ${JSON.stringify(event)}\n\n`);
      });

      const heartbeat = setInterval(() => {
        void touchLastSeen(me);
        emitChat({ type: 'presence', user_id: me, online: true });
        if (!write(': hb\n\n')) cleanup();
      }, HEARTBEAT_MS);

      cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        req.signal.removeEventListener('abort', cleanup);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      // Client disconnect (tab closed / navigated away / network drop). Presence
      // decays via TTL (no last_seen refresh) — no explicit offline event needed.
      req.signal.addEventListener('abort', cleanup);
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
