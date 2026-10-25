'use client';

// Multi-select picker with search (the people-picker skill): a trigger field
// that shows every pick as a chip (name + X to remove) and opens a panel with a
// search row and checkbox rows. Two optional extensions, both additive:
//   onCreate  — a name that is not in `options` can be added as a pick of its
//               own ("הוספת “X”"); the caller decides what that pick is.
//   warn      — a short amber note on an option's chip (e.g. "אין מייל").

import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronsUpDown, Search, TriangleAlert, X } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface PickerOption {
  id: string;
  label: string;
  /** Shown next to the chip while the option is selected. */
  warn?: string | null;
}

interface Props {
  options: PickerOption[];
  selected: string[];
  onChange: (ids: string[]) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  /** Adds the typed name as a new pick; omitted = only listed options can be picked. */
  onCreate?: (label: string) => void;
  createLabel?: (typed: string) => string;
  disabled?: boolean;
  invalid?: boolean;
  id?: string;
  className?: string;
}

export function MultiSelectPicker({
  options, selected, onChange, placeholder = 'בחר...', searchPlaceholder = 'חיפוש...',
  emptyText = 'לא נמצאו תוצאות', onCreate, createLabel, disabled, invalid, id, className,
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLDivElement>(null);

  const typed = query.trim();
  const filtered = useMemo(() => {
    const q = typed.toLowerCase();
    return q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options;
  }, [options, typed]);
  const canCreate = !!onCreate && typed !== '' && !options.some((o) => o.label.trim().toLowerCase() === typed.toLowerCase());
  const selectedOptions = useMemo(() => options.filter((o) => selected.includes(o.id)), [options, selected]);

  // Close on a press outside and on Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      // Escape closes only the picker and hands the focus back to its field: a focused
      // element that simply vanishes makes an enclosing dialog's focus trap move focus
      // on its own, a moment later — onto whatever the user has just clicked into.
      if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); triggerRef.current?.focus(); }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  // Opening clears the search and focuses it.
  const toggleOpen = () => {
    if (disabled) return;
    if (!open) {
      setQuery('');
      requestAnimationFrame(() => searchRef.current?.focus());
    }
    setOpen(!open);
  };

  const toggle = (optionId: string) => {
    onChange(selected.includes(optionId) ? selected.filter((s) => s !== optionId) : [...selected, optionId]);
  };

  const create = () => {
    if (!onCreate || !canCreate) return;
    onCreate(typed);
    setQuery('');
    requestAnimationFrame(() => searchRef.current?.focus());
  };

  return (
    <div dir="rtl" ref={rootRef} className={cn('relative w-full', className)}>
      <div
        ref={triggerRef}
        id={id}
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-disabled={disabled || undefined}
        data-invalid={invalid || undefined}
        onClick={toggleOpen}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget || disabled) return;
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleOpen(); }
        }}
        className={cn(
          'flex min-h-10 w-full cursor-pointer items-center justify-between gap-2 rounded-md border border-input bg-transparent px-3 py-2 text-start text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
          invalid && 'border-red-400 bg-red-50 focus-visible:ring-red-200',
          disabled && 'cursor-not-allowed opacity-50',
        )}
      >
        {selectedOptions.length === 0 ? (
          <span className="px-1 py-0.5 text-muted-foreground">{placeholder}</span>
        ) : (
          <span className="flex flex-1 flex-wrap items-center gap-1.5">
            {selectedOptions.map((o) => (
              <span
                key={o.id}
                data-chip={o.id}
                className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs text-slate-600 shadow-sm"
              >
                <span className="max-w-[12rem] truncate">{o.label}</span>
                {o.warn && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 font-semibold text-amber-700" data-chip-warn>
                    <TriangleAlert className="h-3 w-3" aria-hidden /> {o.warn}
                  </span>
                )}
                <button
                  type="button"
                  aria-label={`הסר את ${o.label}`}
                  disabled={disabled}
                  onClick={(e) => { e.stopPropagation(); toggle(o.id); }}
                  className="relative -m-2 grid h-8 w-8 place-items-center text-slate-400 transition before:absolute before:-inset-1.5 before:content-[''] hover:text-slate-700"
                >
                  <X className="h-3 w-3" aria-hidden />
                </button>
              </span>
            ))}
          </span>
        )}
        <ChevronsUpDown className="h-4 w-4 shrink-0 text-slate-400" aria-hidden />
      </div>

      {open && (
        <div className="absolute z-50 mt-2 w-full rounded-2xl border border-slate-100 bg-white p-2 shadow-xl">
          <div className="flex items-center gap-2 border-b border-slate-100 px-3 py-2">
            <Search className="h-4 w-4 shrink-0 text-slate-400" aria-hidden />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); create(); } }}
              placeholder={searchPlaceholder}
              aria-label={searchPlaceholder}
              className="min-h-8 w-full bg-transparent text-sm text-slate-700 placeholder:text-slate-400 focus:outline-none"
            />
          </div>

          <ul role="listbox" aria-multiselectable="true" className="max-h-64 overflow-y-auto py-1">
            {canCreate && (
              <li role="option" aria-selected={false}>
                <button
                  type="button"
                  data-picker-create
                  onClick={create}
                  className="flex min-h-11 w-full items-center gap-3 rounded-lg px-3 py-2 text-start text-sm font-semibold text-blue-700 hover:bg-blue-50"
                >
                  {createLabel ? createLabel(typed) : `הוספת “${typed}”`}
                </button>
              </li>
            )}
            {filtered.length === 0 && !canCreate && <li className="px-3 py-3 text-sm text-slate-400">{emptyText}</li>}
            {filtered.map((o) => {
              const checked = selected.includes(o.id);
              return (
                <li key={o.id} role="option" aria-selected={checked}>
                  <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-sm text-slate-600 hover:bg-slate-50">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggle(o.id)}
                      className="h-4 w-4 shrink-0 rounded border-slate-300 accent-blue-600"
                    />
                    <span className="flex-1 truncate">{o.label}</span>
                  </label>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
