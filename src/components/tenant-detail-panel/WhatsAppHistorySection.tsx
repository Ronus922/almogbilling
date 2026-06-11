'use client';

import { useEffect, useState } from 'react';
import { MessageCircle, Check, X as XIcon, Clock } from 'lucide-react';
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
  sent:    { label: 'נשלח',  cls: 'bg-emerald-50 text-emerald-700 ring-emerald-200', icon: Check },
  failed:  { label: 'נכשל',  cls: 'bg-red-50 text-red-700 ring-red-200',             icon: XIcon },
  pending: { label: 'ממתין', cls: 'bg-slate-100 text-slate-600 ring-slate-200',      icon: Clock },
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
          <p className="py-4 text-center text-xs text-slate-400">לא נשלחו הודעות WhatsApp לדייר זה.</p>
        ) : (
          <ul className="space-y-2">
            {messages.map((m) => (
              <li
                key={m.id}
                className={cn(
                  'rounded-lg border bg-white p-3',
                  m.status === 'failed' ? 'border-red-200 bg-red-50/40' : 'border-slate-200',
                )}
              >
                <div className="flex items-center justify-between gap-3">
                  <StatusBadge status={m.status} />
                  <span className="text-xs text-slate-400 tabular-nums" dir="ltr">
                    {formatTime(m.created_at)}
                  </span>
                </div>
                <p className="mt-2 whitespace-pre-wrap break-words text-sm text-slate-700">
                  {m.content ?? <span className="text-slate-400">—</span>}
                </p>
                <div className="mt-2 flex items-center justify-between gap-3 text-xs text-slate-400">
                  <span>נשלח ע״י {m.sent_by_name ?? 'מערכת'}</span>
                  {m.status === 'failed' && m.error_detail && (
                    <span className="truncate text-red-500" title={m.error_detail}>
                      {m.error_detail}
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Section>
  );
}
