import Link from 'next/link';
import { ListChecks } from 'lucide-react';
import { cn } from '@/lib/utils';
import { OverviewCard, EmptyState } from './OverviewCard';
import { TASK_PRIORITY } from '../meta';
import { relativeDay } from '../format';
import type { TasksWidget as TasksData } from '../data';

export function TasksWidget({ data }: { data: TasksData | null }) {
  return (
    <OverviewCard icon={ListChecks} tone="violet" title="משימות" count={data?.count} action={{ label: 'הצג הכל', href: '/tasks' }}>
      {!data ? (
        <EmptyState message="לא ניתן לטעון משימות" />
      ) : data.items.length === 0 ? (
        <EmptyState message="אין משימות פתוחות" />
      ) : (
        data.items.map((t) => {
          const p = TASK_PRIORITY[t.priority];
          const due = t.due_date ? relativeDay(t.due_date) : null;
          const dueTodayOrOverdue = due === 'היום' || due === 'אתמול';
          const meta = [t.target_label, t.assignee].filter(Boolean).join(' · ');
          return (
            <Link key={t.id} href={`/tasks?task=${t.id}`} className="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-row-hover">
              <span className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: p.dot }} aria-hidden />
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <p className="truncate text-sm font-bold text-ink">{t.title}</p>
                  <span className={cn('shrink-0 rounded-md px-2 py-0.5 text-[11px] font-bold', p.pill)}>{p.label}</span>
                </div>
                <p className="mt-0.5 truncate text-xs font-medium text-ink-2">
                  {meta}
                  {due && (
                    <>
                      {meta && ' · '}
                      <span className={cn(dueTodayOrOverdue && 'font-semibold text-red-600')}>
                        {due}
                        {t.due_time ? ` ${t.due_time}` : ''}
                      </span>
                    </>
                  )}
                </p>
              </div>
            </Link>
          );
        })
      )}
    </OverviewCard>
  );
}
