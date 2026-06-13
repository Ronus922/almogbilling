'use client';

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowRight, Send, MessagesSquare, Users } from 'lucide-react';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import type { ConversationSummary, InternalMessage, ThreadPayload } from '@/lib/types/internalChat';
import { MAX_MESSAGE_LENGTH } from '@/lib/types/internalChat';
import { formatTime, formatRelativeDay } from './format';
import { ChatAvatar } from './ChatAvatar';

export function ChatThread({
  conversation,
  header,
  messages,
  loading,
  currentUserId,
  onSend,
  onBack,
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
    } else if (grew && atBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
    prevConvRef.current = conversation?.id ?? null;
    prevCountRef.current = messages.length;
  }, [conversation?.id, messages.length]);

  if (!conversation) {
    return (
      <div
        className={cn(
          'flex min-h-0 flex-col items-center justify-center gap-3 rounded-xl border border-slate-200 bg-white p-8 text-center',
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

  return (
    <div className={cn('flex min-h-0 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white', className)}>
      {/* Thread header */}
      <div className="flex items-center gap-3 border-b border-slate-100 px-4 py-3">
        <button
          type="button"
          onClick={onBack}
          aria-label="חזרה לרשימה"
          className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-slate-500 hover:bg-slate-100 md:hidden"
        >
          <ArrowRight className="h-5 w-5" />
        </button>
        <ChatAvatar title={title} isGroup={isGroup} />
        <div className="min-w-0">
          <div className="truncate text-sm font-bold text-slate-900">{title}</div>
          {isGroup && subtitle && (
            <div className="flex items-center gap-1 truncate text-xs text-slate-500">
              <Users className="h-3 w-3 shrink-0" />
              <span className="truncate">{subtitle}</span>
            </div>
          )}
        </div>
      </div>

      {/* Messages */}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        dir="rtl"
        className="min-h-0 flex-1 space-y-1.5 overflow-y-auto bg-slate-50/60 p-4"
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
            return (
              <div key={m.id}>
                {showDay && (
                  <div className="my-2 flex justify-center">
                    <span className="rounded-full bg-white px-3 py-0.5 text-[11px] font-medium text-slate-500 shadow-sm">
                      {formatRelativeDay(m.created_at)}
                    </span>
                  </div>
                )}
                <Bubble message={m} isMine={isMine} showSender={isGroup && !isMine} />
              </div>
            );
          })
        )}
      </div>

      {/* Composer */}
      <Composer onSend={onSend} />
    </div>
  );
}

function Bubble({
  message: m,
  isMine,
  showSender,
}: {
  message: InternalMessage;
  isMine: boolean;
  showSender: boolean;
}) {
  return (
    <div className={cn('flex', isMine ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[80%] rounded-2xl px-3 py-2 text-sm leading-relaxed shadow-sm',
          isMine
            ? 'rounded-bl-sm bg-brand text-white'
            : 'rounded-br-sm border border-slate-200 bg-white text-slate-800',
        )}
      >
        {showSender && (
          <div className="mb-0.5 text-[11px] font-bold text-brand-text">{m.sender_name || 'משתמש'}</div>
        )}
        {/* React escapes content — no dangerouslySetInnerHTML (XSS-safe). */}
        <div className="whitespace-pre-wrap break-words">{m.content}</div>
        <div className={cn('mt-1 flex justify-end text-[10px]', isMine ? 'text-white/70' : 'text-slate-400')}>
          <span dir="ltr" className="tabular-nums">{formatTime(m.created_at)}</span>
        </div>
      </div>
    </div>
  );
}

function Composer({ onSend }: { onSend: (content: string) => Promise<boolean> }) {
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
      <div className="relative">
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="כתוב הודעה… (Enter לשליחה, Shift+Enter לשורה חדשה)"
          rows={1}
          dir="rtl"
          maxLength={MAX_MESSAGE_LENGTH + 100}
          className={cn('max-h-32 resize-none pe-14', tooLong && 'border-red-400 bg-red-50 focus-visible:ring-red-200')}
        />
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
          <Send className="h-4 w-4" />
        </button>
      </div>
      {tooLong && (
        <p className="mt-1 text-[11px] font-semibold text-red-500">
          ההודעה ארוכה מדי (מקסימום {MAX_MESSAGE_LENGTH.toLocaleString('he-IL')} תווים)
        </p>
      )}
    </div>
  );
}
