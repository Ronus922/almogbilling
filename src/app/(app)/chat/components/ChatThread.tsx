'use client';

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowRight, Send, MessagesSquare, Users, Check, CheckCheck, Paperclip, Smile } from 'lucide-react';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import type {
  ConversationSummary,
  InternalMessage,
  ReceiptStatus,
  ThreadPayload,
} from '@/lib/types/internalChat';
import { MAX_MESSAGE_LENGTH } from '@/lib/types/internalChat';
import { formatTime, formatRelativeDay, receiptStatus } from './format';
import { ChatAvatar } from './ChatAvatar';

export function ChatThread({
  conversation,
  header,
  messages,
  loading,
  currentUserId,
  onSend,
  onBack,
  online = false,
  typingName = null,
  onTyping,
  className,
}: {
  conversation: ConversationSummary | null;
  header: ThreadPayload['conversation'] | null;
  messages: InternalMessage[];
  loading: boolean;
  currentUserId: string;
  /** Send a message; returns true when accepted by the server. */
  onSend: (content: string) => Promise<boolean>;
  onBack: () => void;
  /** The other participant is online (direct only) — header presence indicator. */
  online?: boolean;
  /** Name of the other participant currently typing in this conversation, or null. */
  typingName?: string | null;
  /** Fire a transient "I'm typing" signal (throttled by the caller). */
  onTyping?: () => void;
  className?: string;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const atBottomRef = useRef(true);
  const prevCountRef = useRef(0);
  const prevConvRef = useRef<string | null>(null);

  // Track whether the user is pinned to the bottom (within a small threshold).
  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }

  // Auto-scroll: always on conversation switch; on new messages only if the
  // user was already at the bottom (don't yank them up mid-scroll).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const convChanged = prevConvRef.current !== (conversation?.id ?? null);
    const grew = messages.length > prevCountRef.current;
    if (convChanged) {
      el.scrollTop = el.scrollHeight;
      atBottomRef.current = true;
    } else if ((grew || typingName) && atBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
    prevConvRef.current = conversation?.id ?? null;
    prevCountRef.current = messages.length;
  }, [conversation?.id, messages.length, typingName]);

  if (!conversation) {
    return (
      <div
        className={cn(
          'flex min-h-0 flex-col items-center justify-center gap-3 rounded-2xl border border-slate-200 bg-white p-8 text-center',
          className,
        )}
      >
        <span className="grid h-14 w-14 place-items-center rounded-full bg-brand-soft text-brand">
          <MessagesSquare className="h-7 w-7" />
        </span>
        <p className="text-sm text-muted-foreground">בחר שיחה מהרשימה כדי להציג את ההתכתבות</p>
      </div>
    );
  }

  const title = header?.title ?? conversation.title;
  const isGroup = conversation.type === 'group';
  const subtitle = isGroup
    ? (header?.participant_names ?? conversation.participant_names).join(', ')
    : null;

  // Receipt of my most-recent message (direct only) — drives the status bar.
  const lastMine = !isGroup
    ? [...messages].reverse().find((m) => m.sender_user_id === currentUserId)
    : undefined;
  const lastMineStatus =
    lastMine && header
      ? receiptStatus(lastMine.created_at, header.other_last_read_at, header.other_last_seen_at)
      : null;

  return (
    <div className={cn('flex min-h-0 flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white', className)}>
      {/* Thread header */}
      <div className="flex items-center gap-3 border-b border-slate-100 px-5 py-3.5">
        <button
          type="button"
          onClick={onBack}
          aria-label="חזרה לרשימה"
          className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-slate-500 hover:bg-slate-100 md:hidden"
        >
          <ArrowRight className="h-5 w-5" />
        </button>
        <ChatAvatar title={title} isGroup={isGroup} online={!isGroup && online} />
        <div className="min-w-0">
          <div className="truncate text-sm font-bold text-slate-900">{title}</div>
          {isGroup && subtitle ? (
            <div className="flex items-center gap-1 truncate text-xs text-slate-500">
              <Users className="h-3 w-3 shrink-0" />
              <span className="truncate">{subtitle}</span>
            </div>
          ) : !isGroup && online ? (
            // Presence — emerald is the sanctioned exception (online indicator).
            <div className="flex items-center gap-1.5 text-xs font-medium text-emerald-600">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
              מחובר עכשיו
            </div>
          ) : null}
        </div>
      </div>

      {/* Messages */}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        dir="rtl"
        className="min-h-0 flex-1 space-y-1.5 overflow-y-auto bg-slate-50 p-4"
      >
        {loading && messages.length === 0 ? (
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className={cn('flex', i % 2 ? 'justify-start' : 'justify-end')}>
                <div className="h-12 w-48 animate-pulse rounded-2xl bg-muted/60" />
              </div>
            ))}
          </div>
        ) : messages.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <p className="text-sm text-muted-foreground">אין הודעות בשיחה זו עדיין</p>
          </div>
        ) : (
          messages.map((m, i) => {
            const prev = messages[i - 1];
            const showDay =
              !prev || new Date(prev.created_at).toDateString() !== new Date(m.created_at).toDateString();
            const isMine = m.sender_user_id === currentUserId;
            // Per-bubble ticks: only for my messages in a 1:1.
            const status =
              isMine && !isGroup && header
                ? receiptStatus(m.created_at, header.other_last_read_at, header.other_last_seen_at)
                : undefined;
            return (
              <div key={m.id}>
                {showDay && (
                  <div className="my-2 flex justify-center">
                    <span className="rounded-full bg-white px-3 py-0.5 text-[11px] font-medium text-slate-500 shadow-sm">
                      {formatRelativeDay(m.created_at)}
                    </span>
                  </div>
                )}
                <Bubble message={m} isMine={isMine} showSender={isGroup && !isMine} status={status} />
              </div>
            );
          })
        )}

        {/* Typing indicator — the other side is composing (incoming side = right). */}
        {typingName && (
          <div className="flex justify-start pt-1">
            <div className="flex items-center gap-1.5 rounded-2xl rounded-tr-[5px] border border-slate-200 bg-white px-4 py-3 text-slate-400 shadow-sm">
              <span className="chat-typing-dot" />
              <span className="chat-typing-dot" />
              <span className="chat-typing-dot" />
            </div>
          </div>
        )}
      </div>

      {/* Read-receipt status of my latest message (1:1 only). */}
      {lastMineStatus && <ReceiptBar status={lastMineStatus} />}

      {/* Composer */}
      <Composer onSend={onSend} onTyping={onTyping} />
    </div>
  );
}

// Read-receipt milestones for my latest 1:1 message — נשלח / נמסר / נקרא, the
// reached state highlighted (נקרא = blue). Mirrors the ref's status row.
function ReceiptBar({ status }: { status: ReceiptStatus }) {
  const delivered = status === 'delivered' || status === 'read';
  const read = status === 'read';
  return (
    <div className="flex items-center justify-center gap-4 border-t border-slate-100 bg-white py-1.5 text-[11px] font-medium">
      <span className="inline-flex items-center gap-1 text-slate-400">
        <Check className="h-3.5 w-3.5" /> נשלח
      </span>
      <span className={cn('inline-flex items-center gap-1', delivered ? 'text-slate-400' : 'text-slate-300')}>
        <CheckCheck className="h-3.5 w-3.5" /> נמסר
      </span>
      <span className={cn('inline-flex items-center gap-1', read ? 'text-brand' : 'text-slate-300')}>
        <CheckCheck className="h-3.5 w-3.5" /> נקרא
      </span>
    </div>
  );
}

function Bubble({
  message: m,
  isMine,
  showSender,
  status,
}: {
  message: InternalMessage;
  isMine: boolean;
  showSender: boolean;
  /** Receipt for my 1:1 messages (undefined for incoming / group → plain sent ✓). */
  status?: ReceiptStatus;
}) {
  return (
    <div className={cn('flex', isMine ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[80%] rounded-2xl px-3.5 py-2 text-sm leading-relaxed shadow-sm',
          isMine
            ? 'rounded-tl-[5px] bg-brand text-white'
            : 'rounded-tr-[5px] border border-slate-200 bg-white text-slate-800',
        )}
      >
        {showSender && (
          <div className="mb-0.5 text-[11px] font-bold text-brand-text">{m.sender_name || 'משתמש'}</div>
        )}
        {/* React escapes content — no dangerouslySetInnerHTML (XSS-safe). */}
        <div className="whitespace-pre-wrap break-words">{m.content}</div>
        <div className={cn('mt-1 flex items-center justify-end gap-1 text-[10px]', isMine ? 'text-white/70' : 'text-slate-400')}>
          <span dir="ltr" className="tabular-nums">{formatTime(m.created_at)}</span>
          {/* Receipt ticks (1:1): נקרא = brighter ✓✓, נמסר = ✓✓, נשלח = ✓. Group
              messages get the plain sent ✓ (status undefined). */}
          {isMine &&
            (status === 'read' ? (
              <CheckCheck className="h-3.5 w-3.5 shrink-0 text-white" aria-label="נקרא" />
            ) : status === 'delivered' ? (
              <CheckCheck className="h-3.5 w-3.5 shrink-0" aria-label="נמסר" />
            ) : (
              <Check className="h-3 w-3 shrink-0" aria-label="נשלח" />
            ))}
        </div>
      </div>
    </div>
  );
}

function Composer({
  onSend,
  onTyping,
}: {
  onSend: (content: string) => Promise<boolean>;
  onTyping?: () => void;
}) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);

  async function send() {
    const body = text.trim();
    if (!body || sending) return;
    if (body.length > MAX_MESSAGE_LENGTH) return;
    setSending(true);
    const prev = text;
    setText('');
    const ok = await onSend(body);
    // On failure, restore the text so the user doesn't lose their message.
    if (!ok) setText(prev);
    setSending(false);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  const tooLong = text.trim().length > MAX_MESSAGE_LENGTH;
  const canSend = text.trim().length > 0 && !tooLong && !sending;

  return (
    <div className="border-t border-slate-200 bg-white p-3">
      <div className="flex items-end gap-2">
        {/* Attach — visual affordance only; no upload backend is wired. */}
        <button
          type="button"
          aria-label="צירוף קובץ"
          title="צירוף קובץ"
          className="grid h-10 w-10 shrink-0 place-items-center rounded-xl text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
        >
          <Paperclip className="h-5 w-5" />
        </button>
        <div className="relative flex-1">
          <Textarea
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              if (e.target.value.trim()) onTyping?.();
            }}
            onKeyDown={onKeyDown}
            placeholder="כתוב הודעה… (Enter לשליחה, Shift+Enter לשורה חדשה)"
            rows={1}
            dir="rtl"
            maxLength={MAX_MESSAGE_LENGTH + 100}
            className={cn('max-h-32 resize-none rounded-2xl bg-surface-2 pe-24', tooLong && 'border-red-400 bg-red-50 focus-visible:ring-red-200')}
          />
          {/* Emoji — visual affordance only; no picker is wired. */}
          <button
            type="button"
            aria-label="אימוג׳י"
            title="אימוג׳י"
            className="absolute bottom-2 end-12 z-10 grid h-9 w-9 place-items-center rounded-full text-slate-400 transition-colors hover:text-slate-600"
          >
            <Smile className="h-5 w-5" />
          </button>
          <button
            type="button"
            onClick={() => void send()}
            disabled={!canSend}
            aria-label="שלח"
            className={cn(
              'absolute bottom-2 end-2 z-10 inline-flex h-9 w-9 items-center justify-center rounded-full shadow-sm transition-colors',
              canSend ? 'bg-brand text-white hover:bg-brand-dark' : 'cursor-not-allowed bg-slate-200 text-slate-400',
            )}
          >
            <Send className="h-4 w-4 -scale-x-100" />
          </button>
        </div>
      </div>
      {tooLong && (
        <p className="mt-1 text-[11px] font-semibold text-red-500">
          ההודעה ארוכה מדי (מקסימום {MAX_MESSAGE_LENGTH.toLocaleString('he-IL')} תווים)
        </p>
      )}
    </div>
  );
}
