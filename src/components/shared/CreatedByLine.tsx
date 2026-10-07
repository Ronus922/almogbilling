// Card footer: "נוצר ע״י <name> · DD/MM/YYYY HH:mm" on the Asia/Jerusalem clock.
// One component for the issues kanban, the tasks kanban and the worker issue
// cards (DESIGN.md §37). `name` is the row's created_by_name snapshot; a row
// without one shows the time alone. Placement (self-stretch / mt-*) is the
// caller's, through className.

import { cn } from '@/lib/utils';
import { formatStamp } from '@/lib/dashboard/formatStamp';

export function CreatedByLine({
  name,
  createdAt,
  className,
}: {
  name: string | null;
  createdAt: string;
  className?: string;
}) {
  const creator = name?.trim();
  return (
    <p className={cn('border-t border-slate-200 pt-2 text-xs text-muted-foreground', className)}>
      {creator && <>נוצר ע״י {creator} · </>}
      <span dir="ltr" className="font-num tabular-nums">{formatStamp(createdAt, '/')}</span>
    </p>
  );
}
