import { Repeat } from 'lucide-react';
import { cn } from '@/lib/utils';

// Recurrence indicator — the `Repeat` glyph shown wherever a recurring task (a
// series template OR a materialized instance) is rendered: the tasks list/table,
// the kanban card, the form-panel header and the calendar chip. Slate tone per
// DESIGN.md §10/§29; size defaults to the row glyph (h-3.5). One source so all
// surfaces stay identical (Iron Rule #10 — DRY).

interface Props {
  className?: string;
  title?: string;
}

export function RecurringBadge({ className, title = 'משימה חוזרת' }: Props) {
  return (
    <span title={title} className="inline-flex shrink-0 items-center">
      <Repeat className={cn('h-3.5 w-3.5 text-slate-400', className)} aria-label={title} />
    </span>
  );
}
