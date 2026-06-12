import { type NextRequest } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { resolveViewInstanceId } from '@/lib/db/whatsappInstances';
import { subscribeWa } from '@/lib/whatsapp-events';
import type { WaStreamEvent } from '@/types/whatsapp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Disable caching/transforms on this long-lived response.
export const fetchCache = 'force-no-store';

// GET /api/whatsapp/stream?instance_id=… — Server-Sent Events. Pushes
// message_received / message_sent / message_status the instant the webhook or
// send path stores them, replacing the 5s poll. Scoped to ONE instance (the
// selected one for admins, the actor's own otherwise). Auth via the existing
// session cookie (EventSource sends it same-origin).
//
// nginx: the `X-Accel-Buffering: no` response header disables proxy buffering
// for this response (same mechanism the send-bulk NDJSON stream already relies
// on), so no nginx config change is required. A 25s heartbeat keeps the
// connection alive under nginx's proxy_read_timeout 300s (see
// /etc/nginx/sites-available/billing) — keep HEARTBEAT_MS well below it.

const HEARTBEAT_MS = 25_000;

export async function GET(req: NextRequest) {
  let actor: Actor;
  try {
    actor = await requirePermission('whatsapp_chat', 'view');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const requestedInstance = req.nextUrl.searchParams.get('instance_id');
  const instanceId = await resolveViewInstanceId(actor, requestedInstance);

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

      const unsubscribe = subscribeWa((event: WaStreamEvent) => {
        // FAIL CLOSED: a viewer with no resolved instance (instanceId === null)
        // receives NOTHING — never the firehose of every instance's messages.
        if (!instanceId || event.instance_id !== instanceId) return;
        write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      });

      const heartbeat = setInterval(() => {
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

      // Client disconnect (tab closed / navigated away / network drop).
      req.signal.addEventListener('abort', cleanup);
    },
    // Fires when the consumer cancels the stream (the reverse proxy may surface
    // a disconnect here rather than via req.signal). Runs the same teardown.
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
