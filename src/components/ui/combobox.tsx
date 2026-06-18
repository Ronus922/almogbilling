'use client';

// Combobox — a searchable single-select dropdown (DESIGN.md §27). Built on the
// base-ui Popover + a filtered list (no cmdk dependency). Full RTL: dir="rtl",
// flex-row (never flex-row-reverse — that double-flips inside an RTL ancestor).
// Client-side filtering over the already-loaded options.

import { useMemo, useRef, useState } from 'react';
import { Check, ChevronsUpDown, Search } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

export interface ComboboxOption {
  value: string;
  /** Display + search text (string so the trigger and filter can use it). */
  label: string;
  /** Extra text included in the search match (e.g. owner name). */
  keywords?: string;
  /** Optional trailing node in the list row (e.g. a type badge). */
  trailing?: React.ReactNode;
}

interface Props {
  value: string | null;
  onChange: (value: string | null) => void;
  options: ComboboxOption[];
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  /** Shown in the trigger when a value is set but not yet found in options. */
  fallbackLabel?: string;
  disabled?: boolean;
  id?: string;
}

export function Combobox({
  value,
  onChange,
  options,
  placeholder = 'בחר…',
  searchPlaceholder = 'חיפוש...',
  emptyText = 'לא נמצאו תוצאות',
  fallbackLabel,
  disabled = false,
  id,
}: Props) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const selected = options.find((o) => o.value === value) ?? null;

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return options;
    return options.filter((o) =>
      `${o.label} ${o.keywords ?? ''}`.toLowerCase().includes(needle),
    );
  }, [q, options]);

  function close() {
    setOpen(false);
    setQ('');
  }

  function pick(v: string) {
    onChange(v);
    close();
  }

  const triggerText = selected?.label ?? (value && fallbackLabel) ?? placeholder;
  const isPlaceholder = !selected && !(value && fallbackLabel);

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        if (disabled) return;
        setOpen(o);
        if (!o) setQ('');
      }}
    >
      <PopoverTrigger
        id={id}
        disabled={disabled}
        className={cn(
          'flex h-10 w-full items-center justify-between gap-2 rounded-md border border-input bg-white px-3 text-sm text-slate-900 transition-colors',
          'focus-visible:border-brand focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[rgba(61,90,254,0.12)]',
          'disabled:cursor-not-allowed disabled:opacity-50',
        )}
      >
        <span className={cn('truncate text-start', isPlaceholder && 'text-ink-ghost')}>
          {triggerText}
        </span>
        <ChevronsUpDown className="h-4 w-4 shrink-0 text-slate-400" />
      </PopoverTrigger>

      <PopoverContent
        align="start"
        sideOffset={6}
        className="w-(--anchor-width) min-w-72 p-0"
      >
        <div dir="rtl" className="flex flex-col">
          {/* Search */}
          <div className="flex items-center gap-2 border-b border-slate-200 px-3">
            <Search className="h-4 w-4 shrink-0 text-slate-400" />
            <input
              ref={inputRef}
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && filtered.length > 0) {
                  e.preventDefault();
                  pick(filtered[0].value);
                }
              }}
              placeholder={searchPlaceholder}
              className="h-10 w-full bg-transparent text-sm text-slate-900 outline-none placeholder:text-ink-ghost"
            />
          </div>

          {/* List */}
          <div className="max-h-64 overflow-y-auto p-1">
            {filtered.length === 0 ? (
              <p className="px-3 py-6 text-center text-sm text-slate-400">{emptyText}</p>
            ) : (
              filtered.map((o) => {
                const isSel = o.value === value;
                return (
                  <button
                    key={o.value}
                    type="button"
                    onClick={() => pick(o.value)}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-md px-2 py-2 text-start text-sm transition-colors',
                      isSel ? 'bg-blue-50 text-blue-700' : 'text-slate-700 hover:bg-slate-50',
                    )}
                  >
                    <Check className={cn('h-4 w-4 shrink-0', isSel ? 'text-blue-600 opacity-100' : 'opacity-0')} />
                    <span className="min-w-0 flex-1 truncate">{o.label}</span>
                    {o.trailing}
                  </button>
                );
              })
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
