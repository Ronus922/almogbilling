'use client';

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import {
  ArrowRight, Check, CheckCheck, Clock, AlertCircle, Send, Loader2,
  Users, MessageCircle, FileText,
} from 'lucide-react';
import { toast } from 'sonner';
import { Textarea } from '@/components/ui/textarea';
import { formatPhoneDisplay } from '@/lib/phone';
import { cn } from '@/lib/utils';
import type { Conversation, ThreadMessage, ChatStatus } from '@/types/whatsapp';
import { conversationTitle, formatTime, formatRelativeDay } from './format';

export function ChatThread({
  conversation,
  messages,
  loading,
  canEdit,
  onSent,
  onBack,
  className,
}: {
  conversation: Conversation | null;
  messages: ThreadMessage[];
  loading: boolean;
  canEdit: boolean;
  onSent: () => void;
  onBack: () => void;
  className?: string;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const prevKeyRef = useRef<string>('');

  // Auto-scroll to newest on conversation switch or when a message is added.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const key = `${conversation?.chat_id ?? ''}:${messages.length}`;
    if (key !== prevKeyRef.current) {
      prevKeyRef.current = key;
      el.scrollTop = el.scrollHeight;
    }
  }, [conversation?.chat_id, messages.length]);

  if (!conversation) {
    return (
      <div
        className={cn(
          'flex min-h-0 flex-col items-center justify-center gap-3 rounded-xl border border-slate-200 bg-white p-8 text-center',
          className,
        )}
      >
        <span className="grid h-14 w-14 place-items-center rounded-full bg-emerald-50 text-emerald-500">
          <MessageCircle className="h-7 w-7" />
        </span>
        <p className="text-sm text-muted-foreground">בחר שיחה מהרשימה כדי להציג את ההתכתבות</p>
      </div>
    );
  }

  const title = conversationTitle(conversation);

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
        <span className={cn(
          'grid h-10 w-10 shrink-0 place-items-center rounded-full text-xs font-bold',
          conversation.is_group ? 'bg-sky-100 text-sky-600' : 'bg-emerald-100 text-emerald-700',
        )}>
          {conversation.is_group ? <Users className="h-5 w-5" /> : initials(title)}
        </span>
        <div className="min-w-0">
          <div className="truncate text-sm font-bold text-slate-900">{title}</div>
          <div className="flex items-center gap-2 text-xs text-slate-500">
            {!conversation.is_group && conversation.phone && (
              <span dir="ltr" className="tabular-nums">{formatPhoneDisplay(conversation.phone)}</span>
            )}
            {conversation.apartment_number && (
              <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-500">
                דירה {conversation.apartment_number}
              </span>
            )}
            {!conversation.debtor_id && !conversation.is_group && (
              <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-600">לא משויך</span>
            )}
          </div>
        </div>
      </div>

      {/* Messages */}
      <div ref={scrollRef} dir="rtl" className="min-h-0 flex-1 space-y-1.5 overflow-y-auto bg-slate-50/60 p-4">
        {loading && messages.length === 0 ? (
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className={cn('flex', i % 2 ? 'justify-end' : 'justify-start')}>
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
            const showDay = !prev || new Date(prev.created_at).toDateString() !== new Date(m.created_at).toDateString();
            return (
              <div key={m.id}>
                {showDay && (
                  <div className="my-2 flex justify-center">
                    <span className="rounded-full bg-white px-3 py-0.5 text-[11px] font-medium text-slate-500 shadow-sm">
                      {formatRelativeDay(m.created_at)}
                    </span>
                  </div>
                )}
                <Bubble message={m} />
              </div>
            );
          })
        )}
      </div>

      {/* Composer */}
      {canEdit ? (
        <Composer chatId={conversation.chat_id} onSent={onSent} />
      ) : (
        <div className="border-t border-slate-200 bg-white px-4 py-3 text-center text-xs text-muted-foreground">
          אין הרשאת שליחת הודעות
        </div>
      )}
    </div>
  );
}

function Bubble({ message: m }: { message: ThreadMessage }) {
  const isSent = m.direction === 'sent';
  return (
    <div className={cn('flex', isSent ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[80%] rounded-2xl px-3 py-2 text-sm leading-relaxed shadow-sm',
          isSent
            ? 'rounded-bl-sm border border-emerald-100 bg-emerald-50 text-slate-800'
            : 'rounded-br-sm border border-slate-200 bg-white text-slate-800',
        )}
      >
        {m.message_type === 'image' && m.media_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={m.media_url} alt="תמונה" className="mb-1 max-h-56 rounded-lg object-cover" />
        ) : m.message_type === 'document' && m.media_url ? (
          <a
            href={m.media_url}
            target="_blank"
            rel="noopener noreferrer"
            className="mb-1 inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-700 hover:underline"
          >
            <FileText className="h-4 w-4" /> פתח קובץ
          </a>
        ) : null}

        {m.content && m.content !== m.media_url && (
          <div className="whitespace-pre-wrap break-words">{m.content}</div>
        )}

        <div className="mt-1 flex items-center justify-end gap-1 text-[10px] text-slate-400">
          <span dir="ltr" className="tabular-nums">{formatTime(m.created_at)}</span>
          {isSent && <StatusTick status={m.status} />}
        </div>

        {m.status === 'failed' && (
          <div className="mt-0.5 text-[10px] font-medium text-red-500">
            {m.error_detail || 'שליחה נכשלה'}
          </div>
        )}
      </div>
    </div>
  );
}

function StatusTick({ status }: { status: ChatStatus }) {
  switch (status) {
    case 'pending':
    case 'queued':
      return <Clock className="h-3 w-3 text-slate-400" aria-label="ממתין" />;
    case 'sent':
      return <Check className="h-3 w-3 text-slate-400" aria-label="נשלח" />;
    case 'delivered':
      return <CheckCheck className="h-3 w-3 text-slate-400" aria-label="נמסר" />;
    case 'read':
      return <CheckCheck className="h-3 w-3 text-sky-500" aria-label="נקרא" />;
    case 'failed':
      return <AlertCircle className="h-3 w-3 text-red-500" aria-label="נכשל" />;
    default:
      return null;
  }
}

function Composer({ chatId, onSent }: { chatId: string; onSent: () => void }) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);

  async function send() {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      const r = await fetch('/api/whatsapp/chat-send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ chat_id: chatId, text: body }),
      });
      const data = (await r.json().catch(() => ({}))) as { error?: string; warning?: string };
      if (!r.ok) throw new Error(data.error || `שליחה נכשלה (HTTP ${r.status})`);
      if (data.warning) toast.warning(data.warning);
      setText('');
      onSent();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'שליחה נכשלה');
    } finally {
      setSending(false);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  const canSend = text.trim().length > 0 && !sending;

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
          disabled={sending}
          className="max-h-32 resize-none pe-14"
        />
        <button
          type="button"
          onClick={() => void send()}
          disabled={!canSend}
          aria-label="שלח"
          className={cn(
            'absolute bottom-2 end-2 z-10 inline-flex h-9 w-9 items-center justify-center rounded-full shadow-sm transition-colors',
            canSend ? 'bg-emerald-600 text-white hover:bg-emerald-700' : 'cursor-not-allowed bg-slate-200 text-slate-400',
          )}
        >
          {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
        </button>
      </div>
    </div>
  );
}

function initials(title: string): string {
  return (
    title
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0])
      .join('')
      .toUpperCase() || '?'
  );
}
