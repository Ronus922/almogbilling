import { User, Wrench } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { AssigneeRef } from '@/lib/types/assignee';

/** Renders an entity's mixed assignees as pills — violet/User for internal
 *  users, amber/Wrench for external suppliers (the table/kanban convention).
 *  Empty → an em-dash. Shared by tasks-table, issues-table and tasks-kanban. */
export function AssigneePills({
  assignees,
  size = 'md',
}: {
  assignees: AssigneeRef[];
  size?: 'sm' | 'md';
}) {
  if (assignees.length === 0) {
    return <span className="text-slate-400">—</span>;
  }
  return (
    <div className="flex flex-wrap items-center gap-1">
      {assignees.map((a) => {
        const isUser = a.assignee_type === 'user';
        const Icon = isUser ? User : Wrench;
        return (
          <span
            key={`${a.assignee_type}:${a.user_id ?? a.supplier_id}`}
            className={cn(
              'inline-flex items-center gap-1 rounded-full font-medium',
              size === 'sm' ? 'px-1.5 py-0.5 text-[11px]' : 'px-2 py-0.5 text-xs',
              isUser ? 'bg-violet-50 text-violet-700' : 'bg-amber-50 text-amber-700',
            )}
          >
            <Icon className={size === 'sm' ? 'h-3 w-3' : 'h-3.5 w-3.5'} />
            <span className="max-w-32 truncate">
              {a.display_name ?? (isUser ? 'משתמש' : 'ספק')}
            </span>
          </span>
        );
      })}
    </div>
  );
}
