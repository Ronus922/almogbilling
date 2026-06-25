import 'server-only';
import { EventEmitter } from 'node:events';
import type { WaStreamEvent } from '@/types/whatsapp';
import type { ChatStreamEvent } from '@/lib/types/internalChat';

// In-process pub/sub for real-time inbox updates. The webhook + send paths emit;
// each open SSE connection (GET /api/whatsapp/stream) subscribes and forwards
// matching events to its client. No external broker — single Node process
// (the standalone server), so a plain EventEmitter is enough.
//
// The SAME bus also carries internal-chat realtime (presence/typing) under a
// separate event name ('chat'), consumed by GET /api/chat/stream — reusing this
// proven SSE infrastructure rather than standing up a second one.
//
// Pinned on globalThis via a Symbol so Next's module duplication (route bundles,
// dev HMR) can't create two separate buses — the emitter and the subscribers
// MUST share one instance or events would be dropped.

const BUS_KEY = Symbol.for('almog.billing.whatsappEventBus');

type GlobalWithBus = typeof globalThis & { [BUS_KEY]?: EventEmitter };

function getBus(): EventEmitter {
  const g = globalThis as GlobalWithBus;
  if (!g[BUS_KEY]) {
    const emitter = new EventEmitter();
    emitter.setMaxListeners(0); // one listener per open inbox tab — no artificial cap
    g[BUS_KEY] = emitter;
  }
  return g[BUS_KEY];
}

const EVENT = 'wa';

/** Publish a real-time event to every open SSE stream. Fire-and-forget, sync,
 *  and cheap (just pushes into in-memory response streams). Never throws. */
export function emitWa(event: WaStreamEvent): void {
  try {
    getBus().emit(EVENT, event);
  } catch {
    // A failing listener must never break the webhook / send path.
  }
}

/** Subscribe to events; returns an unsubscribe fn (call it on stream close). */
export function subscribeWa(listener: (event: WaStreamEvent) => void): () => void {
  const bus = getBus();
  bus.on(EVENT, listener);
  return () => {
    bus.off(EVENT, listener);
  };
}

// ── Internal-chat channel (presence / typing) on the same bus ───────────────

const CHAT_EVENT = 'chat';

/** Publish an internal-chat realtime event (presence/typing) to every open
 *  /api/chat/stream connection. Fire-and-forget, sync, never throws. */
export function emitChat(event: ChatStreamEvent): void {
  try {
    getBus().emit(CHAT_EVENT, event);
  } catch {
    // A failing listener must never break the typing/heartbeat path.
  }
}

/** Subscribe to internal-chat events; returns an unsubscribe fn. */
export function subscribeChat(listener: (event: ChatStreamEvent) => void): () => void {
  const bus = getBus();
  bus.on(CHAT_EVENT, listener);
  return () => {
    bus.off(CHAT_EVENT, listener);
  };
}
