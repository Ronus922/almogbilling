'use client';

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import {
  ArrowRight, Check, CheckCheck, Clock, AlertCircle, Send, Loader2,
  MessageCircle, FileText, Paperclip, RotateCw,
} from 'lucide-react';
import { toast } from 'sonner';
import { Textarea } from '@/components/ui/textarea';
import { formatPhoneDisplay } from '@/lib/phone';
import { cn } from '@/lib/utils';
import type { Conversation, ThreadMessage, ChatStatus } from '@/types/whatsapp';
import { conversationTitle, formatTime, formatRelativeDay } from './format';
import { ChatAvatar } from './ChatAvatar';

export function ChatThread({
  conversation,
  messages,
  loading,
  canEdit,
  instanceId,
  onSent,
  onBack,
  className,
}: {
  conversation: Conversation | null;
  messages: ThreadMessage[];
  loading: boolean;
  canEdit: boolean;
  instanceId: string | null;
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
        <ChatAvatar title={title} isGroup={conversation.is_group} avatarUrl={conversation.avatar_url} />
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
                <Bubble message={m} canEdit={canEdit} onResent={onSent} />
              </div>
            );
          })
        )}
      </div>

      {/* Composer */}
      {canEdit ? (
        <Composer chatId={conversation.chat_id} instanceId={instanceId} onSent={onSent} />
      ) : (
        <div className="border-t border-slate-200 bg-white px-4 py-3 text-center text-xs text-muted-foreground">
          אין הרשאת שליחת הודעות
        </div>
      )}
    </div>
  );
}

function Bubble({
  message: m,
  canEdit,
  onResent,
}: {
  message: ThreadMessage;
  canEdit: boolean;
  onResent: () => void;
}) {
  const isSent = m.direction === 'sent';
  const [resending, setResending] = useState(false);

  async function resend() {
    if (resending) return;
    setResending(true);
    try {
      const r = await fetch(`/api/whatsapp/messages/${m.id}/resend`, {
        method: 'POST',
        credentials: 'include',
      });
      const data = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(data.error || `שליחה נכשלה (HTTP ${r.status})`);
      onResent();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'שליחה נכשלה');
    } finally {
      setResending(false);
    }
  }

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
          <a href={m.media_url} target="_blank" rel="noopener noreferrer">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={m.media_url} alt="תמונה" className="mb-1 max-h-56 rounded-lg object-cover" />
          </a>
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
          <div className="mt-1 flex items-center justify-between gap-2">
            <span className="text-[10px] font-medium text-red-500">
              {m.error_detail || 'שליחה נכשלה'}
            </span>
            {isSent && canEdit && (
              <button
                type="button"
                onClick={() => void resend()}
                disabled={resending}
                className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-white px-2 py-0.5 text-[10px] font-semibold text-red-600 hover:bg-red-50 disabled:opacity-60"
              >
                {resending ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCw className="h-3 w-3" />}
                שלח שוב
              </button>
            )}
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

const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50MB — Green API limit

function Composer({
  chatId,
  instanceId,
  onSent,
}: {
  chatId: string;
  instanceId: string | null;
  onSent: () => void;
}) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  async function send() {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      const r = await fetch('/api/whatsapp/chat-send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ chat_id: chatId, text: body, instance_id: instanceId }),
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

  async function sendFile(file: File) {
    if (uploading) return;
    if (file.size > MAX_FILE_BYTES) {
      toast.error('הקובץ גדול מדי (מקסימום 50MB)');
      return;
    }
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('chat_id', chatId);
      if (instanceId) fd.append('instance_id', instanceId);
      const caption = text.trim();
      if (caption) fd.append('caption', caption);
      const r = await fetch('/api/whatsapp/chat-send-file', {
        method: 'POST',
        credentials: 'include',
        body: fd,
      });
      const data = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(data.error || `שליחה נכשלה (HTTP ${r.status})`);
      setText('');
      onSent();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'שליחת הקובץ נכשלה');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  const busy = sending || uploading;
  const canSend = text.trim().length > 0 && !busy;

  return (
    <div className="border-t border-slate-200 bg-white p-3">
      <div className="relative">
        <input
          ref={fileRef}
          type="file"
          hidden
          accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx,.txt,.zip"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void sendFile(f);
          }}
        />
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="כתוב הודעה… (Enter לשליחה, Shift+Enter לשורה חדשה)"
          rows={1}
          dir="rtl"
          disabled={busy}
          className="max-h-32 resize-none pe-24"
        />
        {/* Attach (Part E) */}
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={busy}
          aria-label="צרף קובץ"
          className={cn(
            'absolute bottom-2 end-12 z-10 inline-flex h-9 w-9 items-center justify-center rounded-full text-slate-500 transition-colors hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50',
          )}
        >
          {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Paperclip className="h-4 w-4" />}
        </button>
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

