'use client';

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Bot, Send, X } from 'lucide-react';
import { Textarea } from '@/components/ui/textarea';
import { useAuth } from '@/lib/auth/context';
import { cn } from '@/lib/utils';

// Floating read-only collection assistant — a bounded chat widget anchored above
// the FAB (reference layout: fixed-size card, no dimming overlay; the FAB toggles
// to an X to close). Renders only for users who can read the debtors screen
// (same gate as /api/agent/chat: dashboard:view OR contacts:view).
//
// State is in-memory only (no localStorage). Closing the panel RESETS the
// conversation and aborts any in-flight stream (abort BEFORE reset). A late
// `event: text` that was already in flight is dropped via cancelledRef so it can
// never write into a conversation that was reset.
//
// ponytail: intentionally NOT a shadcn Sheet — this is a persistent floating
// widget (per the reference), not an edge drawer; a Sheet would force a
// full-height side panel + overlay.

type Role = 'user' | 'assistant';
interface Msg {
  role: Role;
  content: string;
  /** True while this assistant bubble is a transient status ("searching…"),
   *  before the real answer starts streaming. Rendered dimmed/italic. */
  pending?: boolean;
}

const GREETING = 'היי! אני כאן לעזור לך עם מידע על החייבים. מה תרצה לדעת?';

function statusMessage(status: number): string {
  if (status === 429) return 'יותר מדי בקשות — נסה שוב בעוד רגע.';
  if (status === 503) return 'העוזר אינו מוגדר כרגע. פנה למנהל המערכת.';
  if (status === 401 || status === 403) return 'אין לך הרשאה להשתמש בעוזר.';
  return 'שגיאה בעיבוד הבקשה — נסה שוב.';
}

export function AgentFab() {
  const { can } = useAuth();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Flips true the moment we abort/close; the SSE parser checks it before every
  // write so an in-flight delta can't land in a reset conversation.
  const cancelledRef = useRef(false);
  // True once any model text streamed THIS round — suppresses the status bubble
  // so the model's own opener wins (never both). Reset at the start of each send.
  const textStartedRef = useRef(false);

  // Auto-scroll to the newest message / streamed delta.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // Close: abort any active stream FIRST, then reset the conversation to empty.
  const closePanel = useCallback(() => {
    cancelledRef.current = true;
    abortRef.current?.abort();
    abortRef.current = null;
    setMessages([]);
    setInput('');
    setIsStreaming(false);
    setOpen(false);
  }, []);

  // Esc closes (same reset path).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') closePanel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, closePanel]);

  const allowed = can('dashboard', 'view') || can('contacts', 'view');
  if (!allowed) return null;

  function openPanel() {
    cancelledRef.current = false; // fresh conversation
    setOpen(true);
  }

  /** Append a delta to the last (assistant) bubble. The first real text after a
   *  status bubble replaces the status text (clears content + pending). */
  function appendToLast(delta: string) {
    setMessages((prev) => {
      if (prev.length === 0) return prev;
      const next = prev.slice();
      const last = next[next.length - 1];
      const base = last.pending ? '' : last.content;
      next[next.length - 1] = { role: 'assistant', content: base + delta };
      return next;
    });
  }

  /** Show a transient status ("searching…") in the last (assistant) bubble. */
  function setStatus(text: string) {
    setMessages((prev) => {
      if (prev.length === 0) return prev;
      const last = prev[prev.length - 1];
      if (last.role !== 'assistant') return prev;
      const next = prev.slice();
      next[next.length - 1] = { role: 'assistant', content: text, pending: true };
      return next;
    });
  }

  async function send() {
    const text = input.trim();
    if (!text || isStreaming) return;

    cancelledRef.current = false; // reset guard at the start of each send
    textStartedRef.current = false; // no model text yet this round
    const controller = new AbortController();
    abortRef.current = controller;

    const history = messages;
    const payload = [...history, { role: 'user' as Role, content: text }];
    setInput('');
    setMessages([...payload, { role: 'assistant', content: '' }]);
    setIsStreaming(true);

    try {
      const res = await fetch('/api/agent/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: payload.map(({ role, content }) => ({ role, content })),
        }),
        signal: controller.signal,
      });
      if (cancelledRef.current) return;

      if (!res.ok || !res.body) {
        appendToLast(statusMessage(res.status));
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let streamErr = false;
      for (;;) {
        if (cancelledRef.current) break; // panel closed mid-stream → stop
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let sep: number;
        while ((sep = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          let event = 'message';
          let data = '';
          for (const line of block.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) data += line.slice(5).trim();
          }
          if (event === 'status' && data) {
            if (cancelledRef.current) return; // don't write into a reset conversation
            // Show status ONLY if the model hasn't already streamed an opener this
            // round — the model's own preamble wins; never show both.
            if (!textStartedRef.current) {
              try {
                const { text: t } = JSON.parse(data) as { text?: string };
                if (t) setStatus(t);
              } catch {
                /* ignore malformed chunk */
              }
            }
          } else if (event === 'text' && data) {
            if (cancelledRef.current) return; // drop late delta after cancel
            try {
              const { delta } = JSON.parse(data) as { delta?: string };
              if (delta) {
                textStartedRef.current = true; // model text arrived → suppress status
                appendToLast(delta);
              }
            } catch {
              /* ignore malformed chunk */
            }
          } else if (event === 'error') {
            streamErr = true;
          }
        }
      }
      if (!cancelledRef.current && streamErr) appendToLast('\n\n⚠️ אירעה שגיאה. נסה שוב.');
    } catch {
      // AbortError (panel closed) → silent; real network error → friendly message.
      if (!cancelledRef.current) appendToLast('\n\n⚠️ שגיאת רשת. בדוק את החיבור ונסה שוב.');
    } finally {
      if (!cancelledRef.current) setIsStreaming(false);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  const canSend = input.trim().length > 0 && !isStreaming;

  return (
    <>
      {/* FAB — bottom-left (RTL). Toggles to X while open (reference behaviour). */}
      <button
        type="button"
        onClick={() => (open ? closePanel() : openPanel())}
        aria-label="עוזר אישי"
        title="עוזר אישי"
        aria-expanded={open}
        className="fixed bottom-6 left-6 z-50 grid h-14 w-14 place-items-center rounded-full bg-brand text-white shadow-lg shadow-brand/30 transition-colors hover:bg-brand-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
      >
        {open ? <X className="h-6 w-6" /> : <Bot className="h-6 w-6" />}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="עוזר אישי"
          dir="rtl"
          className="fixed bottom-24 left-6 z-40 flex h-[700px] max-h-[calc(100dvh-7rem)] w-[calc(100vw-3rem)] flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl shadow-slate-900/20 sm:w-[380px]"
        >
          {/* Header */}
          <div className="flex items-center gap-2 border-b border-slate-100 p-4">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-brand-soft text-brand">
              <Bot className="h-5 w-5" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-bold text-brand">עוזר אישי</div>
            </div>
          </div>

          {/* Messages */}
          <div
            ref={scrollRef}
            dir="rtl"
            className="min-h-0 flex-1 space-y-1.5 overflow-y-auto bg-slate-50 p-4"
          >
            <Bubble role="assistant" content={GREETING} />
            {messages.map((m, i) => {
              const isLastStreaming =
                isStreaming && i === messages.length - 1 && m.role === 'assistant';
              // Transient status ("searching…") → dimmed/italic bubble.
              if (isLastStreaming && m.pending) return <StatusBubble key={i} text={m.content} />;
              // No status/text yet → 3-dot typing indicator.
              if (isLastStreaming && m.content === '') return <TypingBubble key={i} />;
              return <Bubble key={i} role={m.role} content={m.content} />;
            })}
          </div>

          {/* Composer — input + send only (no attach / emoji / mic). */}
          <div className="border-t border-slate-200 bg-white p-3">
            <div className="flex items-end gap-2">
              <Textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={onKeyDown}
                disabled={isStreaming}
                placeholder="תגיד משהו… (Enter לשליחה)"
                rows={1}
                dir="rtl"
                className="max-h-32 min-h-11 flex-1 resize-none rounded-2xl bg-surface-2 px-4 py-2.5"
              />
              <button
                type="button"
                onClick={() => void send()}
                disabled={!canSend}
                aria-label="שלח"
                className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-brand text-white shadow-sm transition-colors hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Send className="h-5 w-5 -scale-x-100" />
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function Bubble({ role, content }: { role: Role; content: string }) {
  const isUser = role === 'user';
  return (
    <div className={cn('flex', isUser ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[85%] rounded-2xl px-3.5 py-2 text-sm leading-relaxed shadow-sm',
          isUser
            ? 'rounded-tl-[5px] bg-brand text-white'
            : 'rounded-tr-[5px] border border-slate-200 bg-white text-slate-800',
        )}
      >
        <div className="whitespace-pre-wrap break-words">{content}</div>
      </div>
    </div>
  );
}

function TypingBubble() {
  return (
    <div className="flex justify-start">
      <div className="flex items-center gap-1.5 rounded-2xl rounded-tr-[5px] border border-slate-200 bg-white px-4 py-3 text-slate-400 shadow-sm">
        <span className="chat-typing-dot" />
        <span className="chat-typing-dot" />
        <span className="chat-typing-dot" />
      </div>
    </div>
  );
}

// Transient "searching…" bubble shown while the tool runs (event: status),
// replaced by the real answer once text starts streaming. Dimmed + italic.
function StatusBubble({ text }: { text: string }) {
  return (
    <div className="flex justify-start">
      <div className="max-w-[85%] rounded-2xl rounded-tr-[5px] border border-slate-200 bg-white px-3.5 py-2 text-sm italic text-slate-400 shadow-sm">
        {text}
      </div>
    </div>
  );
}
