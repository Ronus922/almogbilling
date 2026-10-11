'use client';

// Unified תקלות/משימות module (11/10/2026) — "שיוך מהיר" single-select popover:
// one employee OR one supplier, never both (decision 11/10/2026, §3). A plain
// search list over the combined options, not AssigneeSplitFields (that widget
// is for the full multi-assignee edit panel, a separate concept kept as-is).

import { useMemo, useState } from 'react';
import { User, Building2, Check, Search, X } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { WORK_AVATAR } from '@/lib/constants/workItems';
import type { WorkItemPrimaryAssignee } from '@/lib/types/workItems';

interface Option {
  kind: 'user' | 'supplier';
  id: string;
  name: string;
}

export function PrimaryAssigneePicker({
  value,
  employees,
  suppliers,
  onChange,
  disabled,
  trigger,
}: {
  value: WorkItemPrimaryAssignee | null;
  employees: { id: string; name: string }[];
  suppliers: { id: string; display_name: string }[];
  onChange: (next: { kind: 'user' | 'supplier'; id: string } | null) => void;
  disabled?: boolean;
  trigger: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');

  const options: Option[] = useMemo(
    () => [
      ...employees.map((e) => ({ kind: 'user' as const, id: e.id, name: e.name })),
      ...suppliers.map((s) => ({ kind: 'supplier' as const, id: s.id, name: s.display_name })),
    ],
    [employees, suppliers],
  );
  const filtered = useMemo(
    () => (q.trim() ? options.filter((o) => o.name.includes(q.trim())) : options),
    [options, q],
  );

  function pick(o: Option | null) {
    onChange(o ? { kind: o.kind, id: o.id } : null);
    setOpen(false);
    setQ('');
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger disabled={disabled} className="disabled:cursor-not-allowed disabled:opacity-60">
        {trigger}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-0">
        <div className="flex items-center gap-2 border-b border-line p-2">
          <Search className="h-4 w-4 shrink-0 text-ink-ghost" />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="חיפוש עובד או ספק…"
            className="h-8 w-full border-0 bg-transparent text-sm outline-none placeholder:text-ink-ghost"
          />
        </div>
        <div className="max-h-72 overflow-y-auto p-1">
          {value && (
            <button
              type="button"
              onClick={() => pick(null)}
              className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-start text-sm text-rose-600 hover:bg-rose-50"
            >
              <X className="h-4 w-4 shrink-0" />
              בטל שיוך
            </button>
          )}
          {filtered.length === 0 && (
            <p className="px-2 py-3 text-center text-xs text-ink-ghost">אין תוצאות</p>
          )}
          {filtered.map((o) => {
            const selected = value?.kind === o.kind && value.id === o.id;
            const Icon = o.kind === 'user' ? User : Building2;
            return (
              <button
                key={`${o.kind}:${o.id}`}
                type="button"
                onClick={() => pick(o)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-lg px-2 py-2 text-start text-sm hover:bg-row-hover',
                  selected && 'bg-blue-50',
                )}
              >
                <span className={cn('grid h-6 w-6 shrink-0 place-items-center rounded-full', WORK_AVATAR)}>
                  <Icon className="h-3.5 w-3.5" />
                </span>
                <span className="min-w-0 flex-1 truncate">{o.name}</span>
                {selected && <Check className="h-4 w-4 shrink-0 text-blue-600" />}
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
