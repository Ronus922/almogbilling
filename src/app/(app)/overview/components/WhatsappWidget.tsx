import Link from 'next/link';
import { MessageCircle } from 'lucide-react';
import { OverviewCard, EmptyState } from './OverviewCard';
import { shortStamp, initials } from '../format';
import type { WhatsappWidget as WhatsappData } from '../data';

export function WhatsappWidget({ data }: { data: WhatsappData | null }) {
  return (
    <OverviewCard icon={MessageCircle} tone="emerald" title="וואטסאפ" count={data?.count} action={{ label: 'פתח שיחות', href: '/messages' }}>
      {!data ? (
        <EmptyState message="לא ניתן לטעון שיחות" />
      ) : data.items.length === 0 ? (
        <EmptyState message="אין הודעות שלא נקראו" />
      ) : (
        data.items.map((c) => {
          const name = c.apartment ? `${c.name} · דירה ${c.apartment}` : c.name;
          return (
            <Link key={c.chat_id} href="/messages" className="flex items-center gap-3 bg-emerald-600/[0.04] px-4 py-3 transition-colors hover:bg-row-hover">
              <span className="grid h-[42px] w-[42px] shrink-0 place-items-center rounded-full bg-blue-100 text-sm font-extrabold text-blue-700" aria-hidden>
                {initials(c.name)}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-bold text-ink">{name}</span>
                  <span className="shrink-0 text-[11.5px] font-bold text-emerald-600" dir="ltr">{shortStamp(c.at)}</span>
                </div>
                <div className="mt-0.5 flex items-center justify-between gap-2">
                  <p className="truncate text-[13px] font-medium text-ink-2">{c.last ?? ''}</p>
                  <span className="flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full bg-emerald-600 px-1.5 text-[11px] font-bold text-white tabular-nums">
                    {c.unread}
                  </span>
                </div>
              </div>
            </Link>
          );
        })
      )}
    </OverviewCard>
  );
}
