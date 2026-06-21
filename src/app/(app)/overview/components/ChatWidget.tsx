import Link from 'next/link';
import { MessageSquare } from 'lucide-react';
import { OverviewCard, EmptyState } from './OverviewCard';
import { shortStamp, initials } from '../format';
import type { ChatUnreadSummary } from '@/lib/types/internalChat';

export function ChatWidget({ data }: { data: ChatUnreadSummary | null }) {
  return (
    <OverviewCard icon={MessageSquare} tone="brand" title="הודעות פנימיות" count={data?.total} action={{ label: "פתח צ'אט", href: '/chat' }}>
      {!data ? (
        <EmptyState message="לא ניתן לטעון הודעות" />
      ) : data.conversations.length === 0 ? (
        <EmptyState message="אין הודעות שלא נקראו" />
      ) : (
        data.conversations.map((c) => (
          <Link key={c.id} href={`/chat?c=${c.id}`} className="flex items-center gap-3 bg-brand/[0.04] px-4 py-3 transition-colors hover:bg-row-hover">
            <span className="grid h-[42px] w-[42px] shrink-0 place-items-center rounded-full bg-violet-100 text-sm font-extrabold text-violet-700" aria-hidden>
              {initials(c.title)}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-sm font-bold text-ink">{c.title}</span>
                {c.last_message_at && (
                  <span className="shrink-0 text-[11.5px] font-bold text-brand" dir="ltr">{shortStamp(c.last_message_at)}</span>
                )}
              </div>
              <div className="mt-0.5 flex items-center justify-between gap-2">
                <p className="truncate text-[13px] font-medium text-ink-2">{c.last_message_content ?? ''}</p>
                <span className="flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full bg-brand px-1.5 text-[11px] font-bold text-white tabular-nums">
                  {c.unread_count}
                </span>
              </div>
            </div>
          </Link>
        ))
      )}
    </OverviewCard>
  );
}
