'use client';

import { useEffect, useState } from 'react';
import { MessageCircle, Check, CheckCheck, X as XIcon, Clock, Paperclip, Image as ImageIcon, ExternalLink } from 'lucide-react';
import { Section } from './Section';
import { cn } from '@/lib/utils';
import type { ChatMessage, ChatStatus } from '@/types/whatsapp';

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('he-IL', {
    timeZone: 'Asia/Jerusalem',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

const STATUS_META: Record<ChatStatus, { label: string; cls: string; icon: typeof Check }> = {
  sent:      { label: 'נשלח',  cls: 'bg-emerald-50 text-emerald-700 ring-emerald-200', icon: Check },
  delivered: { label: 'נמסר',  cls: 'bg-emerald-50 text-emerald-700 ring-emerald-200', icon: CheckCheck },
  read:      { label: 'נקרא',  cls: 'bg-sky-50 text-sky-700 ring-sky-200',             icon: CheckCheck },
  failed:    { label: 'נכשל',  cls: 'bg-red-50 text-red-700 ring-red-200',             icon: XIcon },
  pending:   { label: 'ממתין', cls: 'bg-slate-100 text-slate-600 ring-slate-200',      icon: Clock },
  queued:    { label: 'בתור',  cls: 'bg-slate-100 text-slate-600 ring-slate-200',      icon: Clock },
};

function StatusBadge({ status }: { status: ChatStatus }) {
  const m = STATUS_META[status];
  const Icon = m.icon;
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1', m.cls)}>
      <Icon className="h-3 w-3" />
      {m.label}
    </span>
  );
}

// File messages (inbound) store the Green API downloadUrl in `content`.
function FileLink({ type, url }: { type: 'image' | 'document'; url: string }) {
  const Icon = type === 'image' ? ImageIcon : Paperclip;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1.5 text-sm font-medium text-emerald-700 hover:underline"
    >
      <Icon className="h-4 w-4 shrink-0" />
      {type === 'image' ? 'תמונה' : 'קובץ מצורף'}
      <ExternalLink className="h-3 w-3 opacity-70" />
    </a>
  );
}

function MessageBubble({ m }: { m: ChatMessage }) {
  const inbound = m.direction === 'received';
  const isFile = m.message_type === 'image' || m.message_type === 'document';

  return (
    <li className={cn('flex', inbound ? 'justify-start' : 'justify-end')}>
      <div
        className={cn(
          'max-w-[82%] rounded-2xl border p-3',
          inbound
            ? 'rounded-ss-sm border-slate-200 bg-white'
            : m.status === 'failed'
              ? 'rounded-se-sm border-red-200 bg-red-50/50'
              : 'rounded-se-sm border-emerald-200 bg-emerald-50/60',
        )}
      >
        <div className="flex items-center justify-between gap-3">
          <span className="text-[11px] font-semibold text-slate-500">
            {inbound ? 'התקבלה' : 'נשלחה'}
          </span>
          {!inbound && <StatusBadge status={m.status} />}
        </div>

        <div className="mt-1.5 text-sm leading-relaxed text-slate-800">
          {isFile && m.content ? (
            <FileLink type={m.message_type as 'image' | 'document'} url={m.content} />
          ) : (
            <p className="whitespace-pre-wrap break-words">
              {m.content ?? <span className="text-slate-400">—</span>}
            </p>
          )}
        </div>

        <div className="mt-2 flex items-center justify-between gap-3 text-[11px] text-slate-400">
          <span className="tabular-nums" dir="ltr">{formatTime(m.created_at)}</span>
          {inbound
            ? null
            : <span className="truncate">{m.sent_by_name ?? 'מערכת'}</span>}
        </div>

        {!inbound && m.status === 'failed' && m.error_detail && (
          <p className="mt-1 truncate text-[11px] text-red-500" title={m.error_detail}>
            {m.error_detail}
          </p>
        )}
      </div>
    </li>
  );
}

export function WhatsAppHistorySection({ debtorId }: { debtorId: string }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const r = await fetch(`/api/whatsapp/messages?debtor_id=${encodeURIComponent(debtorId)}`, {
          credentials: 'include',
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = (await r.json()) as ChatMessage[];
        if (!cancelled) setMessages(data);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'שגיאה');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [debtorId]);

  return (
    <Section
      title="היסטוריית WhatsApp"
      icon={MessageCircle}
      iconTone="emerald"
      subtitle={!loading && !error ? `${messages.length} הודעות` : undefined}
    >
      <div className="pb-1">
        {loading ? (
          <div className="space-y-2">
            <div className="h-14 rounded-lg bg-slate-100 animate-pulse" />
            <div className="h-14 rounded-lg bg-slate-100 animate-pulse" />
          </div>
        ) : error ? (
          <p className="py-3 text-center text-xs text-red-500">טעינת ההיסטוריה נכשלה: {error}</p>
        ) : messages.length === 0 ? (
          <p className="py-4 text-center text-xs text-slate-400">אין הודעות WhatsApp לדייר זה.</p>
        ) : (
          <ul className="space-y-2.5">
            {messages.map((m) => <MessageBubble key={m.id} m={m} />)}
          </ul>
        )}
      </div>
    </Section>
  );
}
