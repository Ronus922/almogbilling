'use client';

// Mixed many-to-many handler (גורם מטפל) picker — replaces the old XOR
// AssigneeField. One Popover with a search box + checkbox rows over a merged
// list of internal users (violet / User) and external suppliers (amber /
// Wrench). Value = an array of {assignee_type, id}; any combination allowed.
// Built on the base-ui Popover (no cmdk), mirroring the Combobox pattern.

import { useMemo, useState } from 'react';
import { User, Wrench, Check, ChevronsUpDown, Search, X } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import type { AssigneeInput, AssigneeOption, SupplierOption } from '@/lib/types/assignee';

interface MergedOption {
  kind: 'user' | 'supplier';
  id: string;
  name: string;
}

function keyOf(kind: 'user' | 'supplier', id: string): string {
  return `${kind}:${id}`;
}

function filterByName(opts: MergedOption[], q: string): MergedOption[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return opts;
  return opts.filter((o) => o.name.toLowerCase().includes(needle));
}

export function AssigneeMultiSelect({
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
  /** Fallback `${kind}:${id}` → name for selected items absent from the option
   *  lists (e.g. a soft-deleted supplier still assigned in edit mode). */
  knownNames?: Record<string, string>;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');

  const userOpts = useMemo<MergedOption[]>(
    () => users.map((u) => ({ kind: 'user', id: u.id, name: u.name })),
    [users],
  );
  const supplierOpts = useMemo<MergedOption[]>(
    () => suppliers.map((s) => ({ kind: 'supplier', id: s.id, name: s.display_name })),
    [suppliers],
  );

  const byKey = useMemo(() => {
    const m = new Map<string, MergedOption>();
    [...userOpts, ...supplierOpts].forEach((o) => m.set(keyOf(o.kind, o.id), o));
    return m;
  }, [userOpts, supplierOpts]);

  const selectedSet = useMemo(
    () => new Set(value.map((v) => keyOf(v.assignee_type, v.id))),
    [value],
  );

  const filteredUsers = useMemo(() => filterByName(userOpts, q), [userOpts, q]);
  const filteredSuppliers = useMemo(() => filterByName(supplierOpts, q), [supplierOpts, q]);
  const empty = filteredUsers.length === 0 && filteredSuppliers.length === 0;

  function toggle(kind: 'user' | 'supplier', id: string) {
    const k = keyOf(kind, id);
    if (selectedSet.has(k)) {
      onChange(value.filter((v) => keyOf(v.assignee_type, v.id) !== k));
    } else {
      onChange([...value, { assignee_type: kind, id }]);
    }
  }

  function remove(v: AssigneeInput) {
    onChange(value.filter((x) => !(x.assignee_type === v.assignee_type && x.id === v.id)));
  }

  return (
    <div className="space-y-2">
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
          <span className={cn('truncate text-start', value.length === 0 && 'text-ink-ghost')}>
            {value.length > 0 ? `${value.length} משויכים נבחרו` : 'בחר משויכים…'}
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
                placeholder="חיפוש עובד או ספק…"
                className="h-10 w-full bg-transparent text-sm text-slate-900 outline-none placeholder:text-ink-ghost"
              />
            </div>

            <div className="max-h-72 overflow-y-auto p-1">
              {empty ? (
                <p className="px-3 py-6 text-center text-sm text-slate-400">לא נמצאו תוצאות</p>
              ) : (
                <>
                  {filteredUsers.length > 0 && (
                    <GroupHeader icon={User} tone="violet" label="עובדים" />
                  )}
                  {filteredUsers.map((o) => (
                    <OptionRow
                      key={keyOf('user', o.id)}
                      option={o}
                      checked={selectedSet.has(keyOf('user', o.id))}
                      onToggle={() => toggle('user', o.id)}
                    />
                  ))}
                  {filteredSuppliers.length > 0 && (
                    <GroupHeader icon={Wrench} tone="amber" label="ספקים" />
                  )}
                  {filteredSuppliers.map((o) => (
                    <OptionRow
                      key={keyOf('supplier', o.id)}
                      option={o}
                      checked={selectedSet.has(keyOf('supplier', o.id))}
                      onToggle={() => toggle('supplier', o.id)}
                    />
                  ))}
                </>
              )}
            </div>
          </div>
        </PopoverContent>
      </Popover>

      {/* Selected chips */}
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {value.map((v) => {
            const k = keyOf(v.assignee_type, v.id);
            const name = byKey.get(k)?.name ?? knownNames?.[k] ?? 'לא ידוע';
            const isUser = v.assignee_type === 'user';
            const Icon = isUser ? User : Wrench;
            return (
              <span
                key={keyOf(v.assignee_type, v.id)}
                className={cn(
                  'inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-medium',
                  isUser ? 'bg-violet-50 text-violet-700' : 'bg-amber-50 text-amber-700',
                )}
              >
                <Icon className="h-3 w-3" />
                <span className="max-w-40 truncate">{name}</span>
                {!disabled && (
                  <button
                    type="button"
                    onClick={() => remove(v)}
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

function GroupHeader({
  icon: Icon,
  tone,
  label,
}: {
  icon: typeof User;
  tone: 'violet' | 'amber';
  label: string;
}) {
  return (
    <div className="flex items-center gap-1.5 px-2 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
      <Icon className={cn('h-3 w-3', tone === 'violet' ? 'text-violet-500' : 'text-amber-500')} />
      {label}
    </div>
  );
}

function OptionRow({
  option,
  checked,
  onToggle,
}: {
  option: MergedOption;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      onClick={onToggle}
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
      <span className="min-w-0 flex-1 truncate">{option.name}</span>
    </button>
  );
}
