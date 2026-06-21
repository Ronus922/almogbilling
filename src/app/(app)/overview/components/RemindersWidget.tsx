import Link from 'next/link';
import { Bell } from 'lucide-react';
import { cn } from '@/lib/utils';
import { OverviewCard, EmptyState } from './OverviewCard';
import { relativeDay, hhmm, jslDate } from '../format';
import { todayInJerusalem } from '@/lib/dates';
import type { RemindersWidget as RemindersData } from '../data';

export function RemindersWidget({ data }: { data: RemindersData | null }) {
  const today = todayInJerusalem();
  return (
    <OverviewCard icon={Bell} tone="amber" title="תזכורות" count={data?.count} action={{ label: 'הצג הכל', href: '/user-reminders' }}>
      {!data ? (
        <EmptyState message="לא ניתן לטעון תזכורות" />
      ) : data.items.length === 0 ? (
        <EmptyState message="אין תזכורות פתוחות" />
      ) : (
        data.items.map((r) => {
          const day = jslDate(r.remind_at);
          const soon = day <= today; // today or overdue → amber emphasis
          return (
            <Link key={r.id} href="/user-reminders" className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-row-hover">
              <span
                className="h-5 w-5 shrink-0 rounded-[7px] border-2"
                style={{ borderColor: r.category_color ?? '#cbd5e1' }}
                aria-hidden
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-ink">{r.title}</p>
                <p className={cn('mt-0.5 text-xs font-semibold', soon ? 'text-amber-700' : 'text-ink-3')}>
                  {relativeDay(day)} · {hhmm(r.remind_at)}
                </p>
              </div>
            </Link>
          );
        })
      )}
    </OverviewCard>
  );
}
