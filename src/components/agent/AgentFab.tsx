'use client';

import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { AlertCircle, Bot, Building2, Check, Send, X } from 'lucide-react';
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
        data-agent-fab=""
        onClick={() => (open ? closePanel() : openPanel())}
        aria-label="עוזר אישי"
        title="עוזר אישי"
        aria-expanded={open}
        // The safe-area bottom margin lifts the fixed button clear of the iOS home indicator.
        className="fixed bottom-6 left-6 z-50 mb-[env(safe-area-inset-bottom)] grid h-14 w-14 place-items-center rounded-full bg-brand text-white shadow-lg shadow-brand/30 transition-colors hover:bg-brand-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
      >
        {open ? <X className="h-6 w-6" /> : <Bot className="h-6 w-6" />}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="עוזר אישי"
          dir="rtl"
          // Sized in dvw, not vw, so the card never counts a classic scrollbar into
          // its width; the safe-area bottom margin keeps it above the home indicator.
          className="fixed bottom-24 left-6 z-40 mb-[env(safe-area-inset-bottom)] flex h-[640px] max-h-[calc(100dvh-9rem)] w-[calc(100dvw-3rem)] flex-col overflow-hidden rounded-[26px] border border-white/70 bg-white shadow-[0_30px_70px_-25px_rgba(15,23,42,0.4),0_8px_24px_-12px_rgba(15,23,42,0.2)] sm:w-[400px]"
        >
          {/* Header */}
          <div className="flex flex-none items-center gap-3 border-b border-[#eef1f6] bg-gradient-to-b from-[#fbfcfe] to-white px-[18px] py-4">
            <span className="relative grid h-11 w-11 shrink-0 place-items-center rounded-[14px] bg-brand text-white shadow-[0_8px_18px_-8px_rgba(61,90,254,0.7)]">
              <Bot className="h-[23px] w-[23px]" />
              <span className="absolute bottom-0 left-0 h-3 w-3 rounded-full border-[2.5px] border-white bg-[#22c55e]" />
            </span>
            <div className="min-w-0 flex-1 text-start">
              <h2 className="truncate text-[17px] font-extrabold leading-tight tracking-tight text-[#0f172a]">
                עוזר אישי
              </h2>
              <p className="mt-0.5 flex items-center gap-1.5 text-[12px] font-semibold text-[#16a34a]">
                <span className="h-1.5 w-1.5 rounded-full bg-[#22c55e]" />
                מחובר · זמין עכשיו
              </p>
            </div>
          </div>

          {/* Messages */}
          <div
            ref={scrollRef}
            dir="rtl"
            className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto bg-[#f7f9fc] px-[18px] pb-[22px] pt-5"
          >
            <Bubble role="assistant" content={GREETING} />
            {messages.map((m, i) => {
              const isLastStreaming =
                isStreaming && i === messages.length - 1 && m.role === 'assistant';
              // Transient status ("searching…") → dimmed/italic bubble.
              if (isLastStreaming && m.pending) return <StatusBubble key={i} text={m.content} />;
              // No status/text yet → 3-dot typing indicator.
              if (isLastStreaming && m.content === '') return <TypingBubble key={i} />;
              if (m.role === 'user') return <Bubble key={i} role="user" content={m.content} />;
              // Assistant: may embed a ```debtors JSON block → rendered as cards.
              return <Fragment key={i}>{renderAssistant(m.content, isLastStreaming)}</Fragment>;
            })}
          </div>

          {/* Composer — input + send only (no attach / emoji / mic). */}
          <div className="flex flex-none items-end gap-2.5 border-t border-[#eef1f6] bg-white px-3.5 pb-3.5 pt-3">
            <Textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              disabled={isStreaming}
              placeholder="תגיד משהו… (Enter לשליחה)"
              rows={1}
              dir="rtl"
              className="max-h-32 min-h-[46px] flex-1 resize-none rounded-[14px] border-[#e7ebf1] bg-[#fafbfd] px-4 py-3"
            />
            <button
              type="button"
              onClick={() => void send()}
              disabled={!canSend}
              aria-label="שלח"
              className="grid h-11 w-11 shrink-0 place-items-center rounded-[13px] bg-brand text-white shadow-[0_8px_18px_-8px_rgba(61,90,254,0.65)] transition-colors hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Send className="h-[19px] w-[19px] -scale-x-100" />
            </button>
          </div>
        </div>
      )}
    </>
  );
}

// ── message rendering ──────────────────────────────────────────────────────

/** One debtor emitted by the model inside a ```debtors JSON block. All fields
 *  optional/loose — the model's output is untrusted, so render defensively. */
interface Debtor {
  apartment?: string;
  name?: string | null;
  relation?: string | null;
  months_debt?: string | null;
  management_fee?: number | string | null;
  water?: number | string | null;
  total_debt?: number | string | null;
  status?: string | null;
  is_archived?: boolean;
}

/** Text field → value, or "—" for missing/blank. */
function txt(v: unknown): string {
  if (v === null || v === undefined || String(v).trim() === '') return '—';
  return String(v);
}

/** Parse a loose money value → a finite number, or null when missing/blank/NaN.
 *  Used for BOTH display and the no-debt derivation, so "unknown" (null/blank) is
 *  never coerced to 0 → never a false green "ללא חוב". */
function num(v: unknown): number | null {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Money field → "N ₪" (localized), or "—" when missing. */
function money(v: unknown): string {
  const n = num(v);
  return n === null ? '—' : `${n.toLocaleString('he-IL')} ₪`;
}

/**
 * Render one assistant message. It may carry a ```debtors JSON block (the
 * structured protocol from the system prompt): a warm sentence, then the fence.
 * - no fence              → plain text bubble (warm text / "לא מצאתי" / stream)
 * - fence open, no close  → streaming: warm text + typing dots (partial block)
 * - closed + valid array  → warm text + one card per debtor
 * - closed + BAD json     → raw content as a plain text bubble (never blank/crash)
 */
// While streaming, the ```debtors fence label can arrive in pieces ("```",
// "```deb"). Hide a trailing partial-fence prefix so raw backticks never flash
// as literal text before the block is recognized.
// ponytail: strips only a ≥3-char prefix of the fence, so a stray inline ` / ``
// in warm text survives; transient-only (the final, non-streaming render always
// uses the full content).
function stripPartialFence(s: string): string {
  const FENCE = '```debtors';
  for (let k = FENCE.length - 1; k >= 3; k--) {
    if (s.endsWith(FENCE.slice(0, k))) return s.slice(0, s.length - k);
  }
  return s;
}

function renderAssistant(content: string, streaming: boolean) {
  const FENCE = '```debtors';
  const at = content.indexOf(FENCE);
  if (at === -1) {
    // No complete fence yet. While streaming, the label may be mid-arrival
    // ("```deb") — strip that partial and, if a block is starting, show the
    // warm text + typing dots instead of flashing raw backticks.
    if (streaming) {
      const shown = stripPartialFence(content);
      if (shown !== content) {
        return (
          <div className="flex items-end justify-start gap-2">
            <BotAvatar />
            <div className="flex max-w-[88%] flex-col gap-2.5">
              {shown.trim() && <BotText content={shown.trim()} />}
              <TypingDots />
            </div>
          </div>
        );
      }
    }
    return <Bubble role="assistant" content={content} />;
  }

  const pre = content.slice(0, at).trim();
  const rest = content.slice(at + FENCE.length);
  const end = rest.indexOf('```');

  if (end === -1) {
    // Block still streaming — or, if the stream ended, a broken never-closed block.
    if (!streaming) return <Bubble role="assistant" content={content} />;
    return (
      <div className="flex items-end justify-start gap-2">
        <BotAvatar />
        <div className="flex max-w-[88%] flex-col gap-2.5">
          {pre && <BotText content={pre} />}
          <TypingDots />
        </div>
      </div>
    );
  }

  let debtors: Debtor[] | null = null;
  try {
    const parsed: unknown = JSON.parse(rest.slice(0, end).trim());
    if (Array.isArray(parsed)) debtors = parsed as Debtor[];
  } catch {
    /* invalid JSON → raw fallback below */
  }
  // Closed but unparseable → show the raw content, never an empty/broken bubble.
  if (!debtors) return <Bubble role="assistant" content={content} />;

  const post = rest.slice(end + 3).trim();
  return (
    <div className="flex items-start justify-start gap-2">
      <BotAvatar />
      <div className="flex max-w-[88%] flex-col gap-2.5">
        {pre && <BotText content={pre} />}
        {debtors.map((d, i) => (
          <DebtorCard key={i} d={d} />
        ))}
        {post && <BotText content={post} />}
      </div>
    </div>
  );
}

function BotAvatar() {
  return (
    <span className="mb-0.5 grid h-[30px] w-[30px] shrink-0 place-items-center rounded-[10px] bg-[#eaf0ff] text-brand">
      <Bot className="h-4 w-4" />
    </span>
  );
}

/** Bot bubble body (no avatar — the caller supplies one). */
function BotText({ content }: { content: string }) {
  return (
    <div className="rounded-[18px] rounded-br-[6px] border border-[#eef1f6] bg-white px-3.5 py-2.5 text-sm leading-[1.55] text-[#0f172a] shadow-[0_2px_6px_-3px_rgba(15,23,42,0.08)]">
      <div className="whitespace-pre-wrap break-words">{content}</div>
    </div>
  );
}

function Bubble({ role, content }: { role: Role; content: string }) {
  if (role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[75%] rounded-[18px] rounded-bl-[6px] bg-brand px-[15px] py-2.5 text-sm font-medium leading-relaxed text-white shadow-[0_6px_16px_-7px_rgba(61,90,254,0.6)]">
          <div className="whitespace-pre-wrap break-words">{content}</div>
        </div>
      </div>
    );
  }
  return (
    <div className="flex items-end justify-start gap-2">
      <BotAvatar />
      <div className="max-w-[80%]">
        <BotText content={content} />
      </div>
    </div>
  );
}

function TypingDots() {
  return (
    <div className="flex w-fit items-center gap-1.5 rounded-[18px] rounded-br-[6px] border border-[#eef1f6] bg-white px-4 py-3 text-slate-400 shadow-[0_2px_6px_-3px_rgba(15,23,42,0.08)]">
      <span className="chat-typing-dot" />
      <span className="chat-typing-dot" />
      <span className="chat-typing-dot" />
    </div>
  );
}

function TypingBubble() {
  return (
    <div className="flex items-end justify-start gap-2">
      <BotAvatar />
      <TypingDots />
    </div>
  );
}

// Transient "searching…" bubble shown while the tool runs (event: status),
// replaced by the real answer once text starts streaming. Dimmed + italic.
function StatusBubble({ text }: { text: string }) {
  return (
    <div className="flex items-end justify-start gap-2">
      <BotAvatar />
      <div className="max-w-[80%] rounded-[18px] rounded-br-[6px] border border-[#eef1f6] bg-white px-3.5 py-2 text-sm italic text-slate-400 shadow-[0_2px_6px_-3px_rgba(15,23,42,0.08)]">
        {text}
      </div>
    </div>
  );
}

// A single debtor card — matches ref/בוט.html: building icon + apartment number,
// a debt/no-debt badge (derived here from total_debt===0), field rows, total bar.
function DebtorCard({ d }: { d: Debtor }) {
  const noDebt = num(d?.total_debt) === 0;
  const months = txt(d?.months_debt);
  const inArrears = months !== '—';
  const rows: { label: string; value: string; cls: string }[] = [
    { label: 'שם', value: txt(d?.name), cls: 'font-bold text-[#0f172a]' },
    { label: 'זיקה', value: txt(d?.relation), cls: 'font-semibold text-[#0f172a]' },
    {
      label: 'חודשי חוב',
      value: months,
      cls: inArrears ? 'font-bold text-[#b91c1c]' : 'font-semibold text-[#0f172a]',
    },
    { label: 'דמי ניהול', value: money(d?.management_fee), cls: 'font-semibold text-[#0f172a]' },
    { label: 'מים חמים', value: money(d?.water), cls: 'font-semibold text-[#0f172a]' },
  ];
  return (
    <div className="rounded-2xl border border-[#e9edf4] bg-white p-3.5 shadow-[0_3px_10px_-5px_rgba(15,23,42,0.1)]">
      <div className="mb-3 flex items-center justify-between gap-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="grid h-[38px] w-[38px] shrink-0 place-items-center rounded-[11px] bg-[#eaf0ff] text-brand">
            <Building2 className="h-[19px] w-[19px]" />
          </span>
          <div className="min-w-0 text-start">
            <p className="text-[11px] font-semibold text-[#94a3b8]">מספר דירה</p>
            <p className="mt-px flex items-center gap-1.5 text-base font-extrabold tracking-tight text-[#0f172a]">
              {txt(d?.apartment)}
              {d?.is_archived && (
                <span className="text-[10px] font-medium text-[#94a3b8]">(בארכיון)</span>
              )}
            </p>
          </div>
        </div>
        {noDebt ? (
          <span className="inline-flex flex-none items-center gap-1 rounded-full bg-[#dcfce7] px-2.5 py-1 text-[11.5px] font-bold text-[#15803d]">
            <Check className="h-3 w-3" strokeWidth={3} />
            ללא חוב
          </span>
        ) : (
          <span className="inline-flex flex-none items-center gap-1 rounded-full bg-[#fee2e2] px-2.5 py-1 text-[11.5px] font-bold text-[#b91c1c]">
            <AlertCircle className="h-3 w-3" />
            חוב פתוח
          </span>
        )}
      </div>
      <div className="flex flex-col">
        {rows.map((r, i) => (
          <div
            key={r.label}
            className={cn(
              'flex items-center justify-between py-[7px]',
              i < rows.length - 1 && 'border-b border-[#f1f4f9]',
            )}
          >
            <span className="text-[12.5px] font-medium text-[#94a3b8]">{r.label}</span>
            <span className={cn('text-[13px]', r.cls)}>{r.value}</span>
          </div>
        ))}
      </div>
      <div
        className={cn(
          'mt-2.5 flex items-center justify-between rounded-[11px] px-3.5 py-2.5',
          noDebt ? 'border border-[#dcfce7] bg-[#f0fdf4]' : 'border border-[#fee2e2] bg-[#fef2f2]',
        )}
      >
        <span className={cn('text-[13px] font-bold', noDebt ? 'text-[#166534]' : 'text-[#991b1b]')}>
          סה&quot;כ חוב
        </span>
        <span
          className={cn(
            'text-[17px] font-extrabold tracking-tight',
            noDebt ? 'text-[#16a34a]' : 'text-[#dc2626]',
          )}
        >
          {money(d?.total_debt)}
        </span>
      </div>
    </div>
  );
}
