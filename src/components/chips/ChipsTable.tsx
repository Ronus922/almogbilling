'use client';

import { KeyRound } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Chip, ChipResidentRole } from '@/lib/types/chips';
import { CHIP_TYPE_LABEL, RESIDENT_ROLE_LABEL } from '@/lib/constants/chips';

// DESIGN.md §28.9 — CSS-grid table inside the page card.
// מספר צ׳יפ · דירה/יחידה · מחזיק · סוג · סטטוס · הונפק · מנפיק
const COLS = 'grid-cols-[1.1fr_1fr_1.5fr_0.9fr_1.2fr_1fr_1fr]';

// Role pill tones (DESIGN.md §10 — bg-{tone}-100 text-{tone}-700).
const ROLE_PILL: Record<ChipResidentRole, string> = {
  owner: 'bg-blue-100 text-blue-700',
  tenant: 'bg-violet-100 text-violet-700',
  operator: 'bg-amber-100 text-amber-700',
  staff: 'bg-sky-100 text-sky-700',
  other: 'bg-slate-100 text-slate-600',
};

export function ChipsTable({
  items,
  loading,
  onRowClick,
}: {
  items: Chip[];
  loading: boolean;
  onRowClick: (chip: Chip) => void;
}) {
  if (loading) {
    return (
      <div className="space-y-2 p-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="h-12 animate-pulse rounded-lg bg-muted/60" />
        ))}
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="p-12 text-center text-sm text-muted-foreground">
        אין צ׳יפים עדיין. הנפקת צ׳יפ ראשון תאכלס את הטבלה.
      </div>
    );
  }

  return (
    <>
      {/* Desktop — §28.9 CSS grid */}
      <div className="hidden overflow-x-auto sm:block">
        <div className="min-w-[880px]">
          {/* head */}
          <div className={cn('grid gap-3 border-b border-[#eef1f6] bg-[#fafbfd] px-6 py-[14px]', COLS)}>
            <span className="text-right text-[12.5px] font-bold text-[#94a3b8]">מספר צ׳יפ</span>
            <span className="text-center text-[12.5px] font-bold text-[#94a3b8]">דירה/יחידה</span>
            <span className="text-center text-[12.5px] font-bold text-[#94a3b8]">מחזיק</span>
            <span className="text-center text-[12.5px] font-bold text-[#94a3b8]">סוג</span>
            <span className="text-center text-[12.5px] font-bold text-[#94a3b8]">סטטוס</span>
            <span className="text-center text-[12.5px] font-bold text-[#94a3b8]">הונפק</span>
            <span className="text-center text-[12.5px] font-bold text-[#94a3b8]">מנפיק</span>
          </div>

          {/* rows */}
          {items.map((c) => (
            <div
              key={c.id}
              onClick={() => onRowClick(c)}
              className={cn(
                'grid min-h-12 cursor-pointer items-center gap-3 border-b border-[#f1f4f8] px-6 py-[14px] transition-colors last:border-0 hover:bg-[#fafbfd]',
                COLS,
              )}
            >
              <span
                dir="ltr"
                className="truncate text-right font-num text-[14.5px] font-semibold tabular-nums text-[#0f172a]"
              >
                {c.chip_number}
              </span>

              <span className="truncate text-center text-[14px] font-bold text-[#0f172a]">
                {c.apartment_number}
              </span>

              <span className="flex min-w-0 items-center justify-center gap-2">
                {c.holder_name ? (
                  <span className="truncate text-[14px] font-medium text-[#475569]">{c.holder_name}</span>
                ) : (
                  <Dash />
                )}
                {c.resident_role && <RolePill role={c.resident_role} />}
              </span>

              <span className="flex justify-center">
                <TypePill chip={c} />
              </span>

              <span className="flex flex-col items-center gap-1">
                <StatusPill chip={c} />
                {c.status === 'inactive' && !c.controller_synced && <PendingControllerHint />}
              </span>

              <span
                dir="ltr"
                className="text-center font-num text-[13.5px] tabular-nums text-[#475569]"
              >
                {formatDate(c.issued_at)}
              </span>

              <span className="truncate text-center text-[13.5px] font-medium text-[#475569]">
                {c.issued_by_name || <Dash />}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Mobile — stacked entity cards (DESIGN.md §9b) */}
      <div className="space-y-2 p-4 sm:hidden">
        {items.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => onRowClick(c)}
            className="flex w-full cursor-pointer items-center gap-3 rounded-lg border border-slate-200 bg-white p-4 text-start transition-colors hover:bg-slate-50"
          >
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-blue-100 text-blue-700">
              <KeyRound className="h-4 w-4" />
            </span>

            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span dir="ltr" className="truncate font-num text-base font-semibold tabular-nums text-slate-900">
                  {c.chip_number}
                </span>
                <TypePill chip={c} />
              </div>
              <div className="mt-0.5 truncate text-sm text-muted-foreground">
                דירה {c.apartment_number}
                {c.holder_name ? ` · ${c.holder_name}` : ''}
                {c.resident_role ? ` (${RESIDENT_ROLE_LABEL[c.resident_role]})` : ''}
              </div>
              {c.status === 'inactive' && !c.controller_synced && (
                <div className="mt-1">
                  <PendingControllerHint />
                </div>
              )}
            </div>

            <div className="flex shrink-0 items-center gap-1.5 text-xs text-slate-600">
              <span
                className={cn(
                  'h-1.5 w-1.5 rounded-full',
                  c.status === 'active' ? 'bg-emerald-500' : 'bg-slate-400',
                )}
              />
              {c.status === 'active' ? 'פעיל' : 'מושבת'}
            </div>
          </button>
        ))}
      </div>
    </>
  );
}

function RolePill({ role }: { role: ChipResidentRole }) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-semibold',
        ROLE_PILL[role],
      )}
    >
      {RESIDENT_ROLE_LABEL[role]}
    </span>
  );
}

function TypePill({ chip }: { chip: Chip }) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-full px-[11px] py-[4px] text-xs font-semibold',
        chip.chip_type === 'app' ? 'bg-sky-100 text-sky-700' : 'bg-slate-100 text-slate-600',
      )}
    >
      {CHIP_TYPE_LABEL[chip.chip_type]}
    </span>
  );
}

function StatusPill({ chip }: { chip: Chip }) {
  const active = chip.status === 'active';
  return (
    <span
      className={cn(
        'inline-flex items-center gap-[5px] rounded-full px-[11px] py-[4px] text-xs font-semibold',
        active ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-600',
      )}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', active ? 'bg-emerald-500' : 'bg-slate-400')} />
      {active ? 'פעיל' : 'מושבת'}
    </span>
  );
}

/** Inactive chip not yet blocked in the building controller — amber hint. */
function PendingControllerHint() {
  return (
    <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-amber-600">
      <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
      ממתין לבקר
    </span>
  );
}

function Dash() {
  return <em className="not-italic text-[#cbd5e1]">—</em>;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem' });
}
