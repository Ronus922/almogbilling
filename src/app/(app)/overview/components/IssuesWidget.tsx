import Link from 'next/link';
import { AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { OverviewCard, EmptyState } from './OverviewCard';
import { ISSUE_PRIORITY } from '../meta';
import { formatRelativeTime } from '@/lib/notifications/registry';
import type { IssuesWidget as IssuesData } from '../data';

export function IssuesWidget({ data }: { data: IssuesData | null }) {
  return (
    <OverviewCard icon={AlertTriangle} tone="red" title="תקלות" count={data?.count} action={{ label: 'הצג הכל', href: '/issues' }}>
      {!data ? (
        <EmptyState message="לא ניתן לטעון תקלות" />
      ) : data.items.length === 0 ? (
        <EmptyState message="אין תקלות פתוחות" />
      ) : (
        data.items.map((i) => {
          const p = ISSUE_PRIORITY[i.priority];
          const meta = [i.location, formatRelativeTime(i.created_at)].filter(Boolean).join(' · ');
          return (
            <Link key={i.id} href={`/issues?issue=${i.id}`} className="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-row-hover">
              <span className="grid h-[34px] w-[34px] shrink-0 place-items-center rounded-[9px] bg-red-50 text-red-600" aria-hidden>
                <AlertTriangle className="h-[17px] w-[17px]" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <p className="truncate text-sm font-bold text-ink">{i.title}</p>
                  <span className={cn('shrink-0 rounded-md px-2 py-0.5 text-[11px] font-bold', p.pill)}>{p.label}</span>
                </div>
                <p className="mt-0.5 truncate text-xs font-medium text-ink-2">{meta}</p>
              </div>
            </Link>
          );
        })
      )}
    </OverviewCard>
  );
}
