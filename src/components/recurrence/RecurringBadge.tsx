import { Repeat } from 'lucide-react';
import { cn } from '@/lib/utils';

// Recurrence indicator — the `Repeat` glyph shown wherever a recurring task is
// rendered: the tasks list/table, the kanban card, the form-panel header and the
// calendar chip. Blue tone, matching the cadence strip and the recurrence form
// (DESIGN.md §30); size defaults to the row glyph (h-3.5). One source so all
// surfaces stay identical (Iron Rule #10 — DRY).

interface Props {
  className?: string;
  title?: string;
}

export function RecurringBadge({ className, title = 'משימה חוזרת' }: Props) {
  return (
    <span title={title} className="inline-flex shrink-0 items-center">
      <Repeat className={cn('h-3.5 w-3.5 text-blue-500', className)} aria-label={title} />
    </span>
  );
}
