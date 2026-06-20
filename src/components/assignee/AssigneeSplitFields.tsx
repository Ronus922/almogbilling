'use client';

// "גורם מטפל" as TWO separate single-kind pickers — internal users (violet) and
// external suppliers (emerald) — sharing ONE value array (AssigneeInput[], the
// entity_assignees junction model, migration 047). Either may be used alone or
// both together, so the underlying value stays a single mixed list and the
// form's submit / validation / NotifyMatrix / createNotify are unchanged.

import { useMemo, useState } from 'react';
import { User, Building2, Check, ChevronsUpDown, Search, X, type LucideIcon } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import type { AssigneeInput, AssigneeKind, AssigneeOption, SupplierOption } from '@/lib/types/assignee';

interface KindMeta {
  icon: LucideIcon;
  iconColor: string;
  chip: string;
  label: string;
  placeholder: string;
  search: string;
  empty: string;
}

const KIND_META: Record<AssigneeKind, KindMeta> = {
  user: {
    icon: User,
    iconColor: 'text-violet-500',
    chip: 'bg-violet-50 text-violet-700',
    label: 'עובד / משתמש בארגון',
    placeholder: 'בחר עובד…',
    search: 'חיפוש עובד…',
    empty: 'אין עובדים',
  },
  supplier: {
    icon: Building2,
    iconColor: 'text-emerald-500',
    chip: 'bg-emerald-50 text-emerald-700',
    label: 'ספק חיצוני',
    placeholder: 'בחר ספק…',
    search: 'חיפוש ספק…',
    empty: 'אין ספקים',
  },
};

function countLabel(n: number): string {
  return n === 1 ? '1 נבחר' : `${n} נבחרו`;
}

interface KindOption {
  id: string;
  name: string;
}

function AssigneeKindSelect({
  kind,
  options,
  value,
  onChange,
  knownNames,
  disabled,
}: {
  kind: AssigneeKind;
  options: KindOption[];
  value: AssigneeInput[];
  onChange: (next: AssigneeInput[]) => void;
  knownNames?: Record<string, string>;
  disabled?: boolean;
}) {
  const meta = KIND_META[kind];
  const Icon = meta.icon;
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');

  const selected = useMemo(() => value.filter((v) => v.assignee_type === kind), [value, kind]);
  const selectedIds = useMemo(() => new Set(selected.map((v) => v.id)), [selected]);
  const nameById = useMemo(() => {
    const m = new Map<string, string>();
    options.forEach((o) => m.set(o.id, o.name));
    return m;
  }, [options]);
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle ? options.filter((o) => o.name.toLowerCase().includes(needle)) : options;
  }, [options, q]);

  function toggle(id: string) {
    if (selectedIds.has(id)) {
      onChange(value.filter((v) => !(v.assignee_type === kind && v.id === id)));
    } else {
      onChange([...value, { assignee_type: kind, id }]);
    }
  }
  function remove(id: string) {
    onChange(value.filter((v) => !(v.assignee_type === kind && v.id === id)));
  }

  return (
    <div className="space-y-2">
      <Label className="flex items-center gap-1.5 text-base font-medium text-muted-foreground">
        <Icon className={cn('h-4 w-4', meta.iconColor)} />
        {meta.label}
      </Label>

      <Popover
        open={open}
        onOpenChange={(o) => {
          if (disabled) return;
          setOpen(o);
          if (!o) setQ('');
        }}
      >
        <PopoverTrigger
          disabled={disabled}
          className={cn(
            'flex h-10 w-full items-center justify-between gap-2 rounded-md border border-input bg-white px-3 text-sm text-slate-900 transition-colors',
            'focus-visible:border-brand focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[rgba(61,90,254,0.12)]',
            'disabled:cursor-not-allowed disabled:opacity-50',
          )}
        >
          <span className={cn('truncate text-start', selected.length === 0 && 'text-ink-ghost')}>
            {selected.length > 0 ? countLabel(selected.length) : meta.placeholder}
          </span>
          <ChevronsUpDown className="h-4 w-4 shrink-0 text-slate-400" />
        </PopoverTrigger>

        <PopoverContent align="start" sideOffset={6} className="w-(--anchor-width) min-w-72 p-0">
          <div dir="rtl" className="flex flex-col">
            <div className="flex items-center gap-2 border-b border-slate-200 px-3">
              <Search className="h-4 w-4 shrink-0 text-slate-400" />
              <input
                autoFocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={meta.search}
                className="h-10 w-full bg-transparent text-sm text-slate-900 outline-none placeholder:text-ink-ghost"
              />
            </div>
            <div className="max-h-72 overflow-y-auto p-1">
              {filtered.length === 0 ? (
                <p className="px-3 py-6 text-center text-sm text-slate-400">
                  {q.trim() ? 'לא נמצאו תוצאות' : meta.empty}
                </p>
              ) : (
                filtered.map((o) => {
                  const checked = selectedIds.has(o.id);
                  return (
                    <button
                      key={o.id}
                      type="button"
                      role="checkbox"
                      aria-checked={checked}
                      onClick={() => toggle(o.id)}
                      className={cn(
                        'flex min-h-11 w-full items-center gap-2 rounded-md px-2 py-2 text-start text-sm transition-colors',
                        checked ? 'bg-blue-50 text-blue-700' : 'text-slate-700 hover:bg-slate-50',
                      )}
                    >
                      <span
                        className={cn(
                          'grid h-4 w-4 shrink-0 place-items-center rounded border',
                          checked ? 'border-blue-600 bg-blue-600 text-white' : 'border-slate-300 bg-white',
                        )}
                      >
                        {checked && <Check className="h-3 w-3" />}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{o.name}</span>
                    </button>
                  );
                })
              )}
            </div>
          </div>
        </PopoverContent>
      </Popover>

      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selected.map((v) => {
            const name = nameById.get(v.id) ?? knownNames?.[`${kind}:${v.id}`] ?? 'לא ידוע';
            return (
              <span
                key={v.id}
                className={cn('inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-medium', meta.chip)}
              >
                <Icon className="h-3 w-3" />
                <span className="max-w-40 truncate">{name}</span>
                {!disabled && (
                  <button
                    type="button"
                    onClick={() => remove(v.id)}
                    aria-label={`הסר ${name}`}
                    className="rounded-full p-0.5 transition-colors hover:bg-black/10"
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * The "גורם מטפל" body: two separate pickers (users + suppliers) over one shared
 * value array. Drop-in replacement for AssigneeMultiSelect (same props), so the
 * owning form's onChange / validation / notify-pruning are unchanged.
 */
export function AssigneeSplitFields({
  users,
  suppliers,
  value,
  onChange,
  knownNames,
  disabled = false,
}: {
  users: AssigneeOption[];
  suppliers: SupplierOption[];
  value: AssigneeInput[];
  onChange: (next: AssigneeInput[]) => void;
  knownNames?: Record<string, string>;
  disabled?: boolean;
}) {
  const userOptions = useMemo<KindOption[]>(
    () => users.map((u) => ({ id: u.id, name: u.name })),
    [users],
  );
  const supplierOptions = useMemo<KindOption[]>(
    () => suppliers.map((s) => ({ id: s.id, name: s.display_name })),
    [suppliers],
  );

  return (
    <div className="space-y-4 py-2">
      <AssigneeKindSelect
        kind="user"
        options={userOptions}
        value={value}
        onChange={onChange}
        knownNames={knownNames}
        disabled={disabled}
      />
      <AssigneeKindSelect
        kind="supplier"
        options={supplierOptions}
        value={value}
        onChange={onChange}
        knownNames={knownNames}
        disabled={disabled}
      />
    </div>
  );
}
