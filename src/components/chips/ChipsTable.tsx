'use client';

import { History, KeyRound, Search, UserX } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ChipMatchType, ChipResidentRole, ChipWithHolder } from '@/lib/types/chips';
import { CHIP_TYPE_LABEL, RESIDENT_ROLE_LABEL } from '@/lib/constants/chips';
import { resolveChipHolder } from '@/lib/chips/holder';

// Chips-skin table (declared exception — extended from the ref palette; the
// ref covers only the issue window). Structure follows DESIGN.md §28.9
// CSS-grid; colors/typography follow ref/proof/whatsapp-broadcast/Chip.md.
// THE HOLDER IS THE PRIMARY COLUMN — apartment + role sit beneath the name.
// מחזיק · מספר צ׳יפ · סוג · סטטוס · הונפק · מנפיק
const COLS = 'grid-cols-[1.9fr_1.4fr_0.8fr_1.1fr_0.9fr_0.9fr]';

// Role badge tones — mapped from the ref tone families (§ role cards).
const ROLE_PILL: Record<ChipResidentRole, string> = {
  owner: 'bg-[var(--chip-brand-soft)] text-[var(--chip-brand-ink)]',
  tenant: 'bg-[var(--chip-violet-soft)] text-[var(--chip-violet-ink)]',
  operator: 'bg-[var(--chip-amber-soft)] text-[var(--chip-amber-ink)]',
  staff: 'bg-[var(--chip-hover)] text-[var(--chip-ink-muted)]',
  other: 'bg-[var(--chip-hover)] text-[var(--chip-ink-muted)]',
};

const MATCH_LABEL: Record<ChipMatchType, string> = {
  chip_number: 'מספר צ׳יפ',
  apartment: 'דירה',
  holder_name: 'שם דייר',
};

function Dash() {
  return <span className="text-[var(--chip-ink-ghost)]">—</span>;
}

function RolePill({ role }: { role: ChipResidentRole }) {
  return (
    <span
      className={cn(
        'inline-flex h-[20px] items-center rounded-[6px] px-2 text-[11px] font-bold',
        ROLE_PILL[role],
      )}
    >
      {RESIDENT_ROLE_LABEL[role]}
    </span>
  );
}

/** "לא במרשם" — snapshot-role holders (other/staff) have no registry row. */
function NotInRegistryBadge() {
  return (
    <span className="inline-flex h-[20px] items-center gap-1 rounded-[6px] border border-dashed border-[var(--chip-border-strong)] bg-[var(--chip-panel-alt)] px-2 text-[11px] font-bold text-[var(--chip-ink-soft)]">
      <UserX className="h-3 w-3" />
      לא במרשם
    </span>
  );
}

/** Live registry name differs from the issuance snapshot — tooltip, not error. */
function NameChangedHint({ issuedAs }: { issuedAs: string }) {
  return (
    <span
      title={`הונפק בשם: ${issuedAs}`}
      className="inline-grid h-[18px] w-[18px] shrink-0 cursor-help place-items-center rounded-full bg-[var(--chip-amber-soft)] text-[var(--chip-amber-ink)]"
    >
      <History className="h-3 w-3" />
    </span>
  );
}

/** Match-type badge — why this row surfaced in a search (rule 4). */
function MatchBadge({ type }: { type: ChipMatchType }) {
  return (
    <span className="inline-flex h-[20px] items-center rounded-[6px] border border-[var(--chip-brand-border)] bg-[var(--chip-brand-soft)] px-2 text-[10.5px] font-bold text-[var(--chip-brand-ink)]">
      {MATCH_LABEL[type]}
    </span>
  );
}

/** Chip number in the ref's tag anatomy: mono, green when active, RED dashed +
 *  line-through when inactive ("צ׳יפ שהונפק לא נמחק" — only toggled). */
function ChipNumberTag({ chip }: { chip: ChipWithHolder }) {
  const active = chip.status === 'active';
  return (
    <span
      className={cn(
        'inline-flex h-[30px] items-center rounded-[9px] border px-[10px]',
        active
          ? 'border-[var(--chip-green-border)] bg-[var(--chip-green-soft)]'
          : 'border-dashed border-[var(--chip-red-border)] bg-[var(--chip-red-soft)]',
      )}
    >
      <span
        className={cn(
          'chip-num text-[13.5px] font-semibold tracking-[0.02em]',
          active
            ? 'text-[var(--chip-green-ink)]'
            : 'text-[var(--chip-red-ink)] line-through decoration-[var(--chip-red-border)]',
        )}
      >
        {chip.chip_number}
      </span>
    </span>
  );
}

function TypePill({ chip }: { chip: ChipWithHolder }) {
  const app = chip.chip_type === 'app';
  return (
    <span
      className={cn(
        'inline-flex h-[22px] items-center rounded-[6px] px-2 text-[11px] font-bold',
        app
          ? 'bg-[var(--chip-brand-soft)] text-[var(--chip-brand-ink)]'
          : 'bg-[var(--chip-amber-soft)] text-[var(--chip-amber-ink)]',
      )}
    >
      {CHIP_TYPE_LABEL[chip.chip_type]}
    </span>
  );
}

function StatusPill({ chip }: { chip: ChipWithHolder }) {
  const active = chip.status === 'active';
  return (
    <span
      className={cn(
        'inline-flex h-[22px] items-center gap-[5px] rounded-[6px] px-2 text-[11px] font-bold',
        active
          ? 'bg-[var(--chip-green-soft)] text-[var(--chip-green-ink)]'
          : 'bg-[var(--chip-red-soft)] text-[var(--chip-red-ink)]',
      )}
    >
      <span
        className={cn(
          'h-[6px] w-[6px] rounded-full',
          active ? 'bg-[var(--chip-green)]' : 'bg-[var(--chip-red)]',
        )}
      />
      {active ? 'פעיל' : 'לא פעיל'}
    </span>
  );
}

function PendingControllerHint() {
  return (
    <span className="inline-flex items-center gap-1 rounded-[6px] bg-[var(--chip-amber-soft)] px-2 py-0.5 text-[10.5px] font-bold text-[var(--chip-amber-ink)]">
      ממתין לחסימה בבקר
    </span>
  );
}

function formatDate(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('he-IL', {
    timeZone: 'Asia/Jerusalem', day: '2-digit', month: '2-digit', year: 'numeric',
  });
}

const HEAD_CELL = 'text-[12.5px] font-bold text-[var(--chip-ink-soft)]';

export function ChipsTable({
  items,
  loading,
  searchTerm,
  onRowClick,
  onHolderClick,
  onHolderFilter,
}: {
  items: ChipWithHolder[];
  loading: boolean;
  /** Non-empty while a search is active — switches the empty state + shows match badges. */
  searchTerm: string;
  onRowClick: (chip: ChipWithHolder) => void;
  /** Click on the holder NAME — opens the holder view (name → numbers). */
  onHolderClick: (chip: ChipWithHolder) => void;
  /** Click on the "N צ׳יפים" pill — filters the table to that person. */
  onHolderFilter: (chip: ChipWithHolder) => void;
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
    // Search-empty is DISTINCT from table-empty (product spec).
    if (searchTerm) {
      return (
        <div className="flex flex-col items-center gap-3 p-12 text-center">
          <span className="grid h-12 w-12 place-items-center rounded-full bg-[var(--chip-hover)] text-[var(--chip-ink-soft)]">
            <Search className="h-5 w-5" />
          </span>
          <p className="text-[15px] font-bold text-[var(--chip-ink)]">
            אין תוצאות עבור „{searchTerm}”
          </p>
          <p className="text-[13px] font-medium text-[var(--chip-ink-soft)]">
            נסה מספר דירה או שם דייר — החיפוש מכסה מספרי צ׳יפ, דירות ושמות מכל הסטטוסים
          </p>
        </div>
      );
    }
    return (
      <div className="p-12 text-center text-sm text-[var(--chip-ink-soft)]">
        אין צ׳יפים עדיין. הנפקת צ׳יפ ראשון תאכלס את הטבלה.
      </div>
    );
  }

  return (
    <>
      {/* Desktop — CSS grid */}
      <div className="hidden overflow-x-auto sm:block">
        <div className="min-w-[880px]">
          {/* head */}
          <div className={cn('grid items-center gap-3 border-b border-[var(--chip-border)] bg-[var(--chip-panel-alt)] px-6 py-[13px]', COLS)}>
            <span className={cn(HEAD_CELL, 'text-start')}>מחזיק</span>
            <span className={cn(HEAD_CELL, 'text-start')}>מספר צ׳יפ</span>
            <span className={cn(HEAD_CELL, 'text-center')}>סוג</span>
            <span className={cn(HEAD_CELL, 'text-center')}>סטטוס</span>
            <span className={cn(HEAD_CELL, 'text-center')}>הונפק</span>
            <span className={cn(HEAD_CELL, 'text-center')}>מנפיק</span>
          </div>

          {/* rows */}
          {items.map((c) => {
            const holder = resolveChipHolder(c);
            return (
              <div
                key={c.id}
                onClick={() => onRowClick(c)}
                className={cn(
                  'grid min-h-[58px] cursor-pointer items-center gap-3 border-b border-[var(--chip-border)] px-6 py-[12px] transition-colors last:border-0 hover:bg-[var(--chip-hover)]',
                  COLS,
                )}
              >
                {/* PRIMARY — holder name; apartment + role beneath (product rule) */}
                <span className="flex min-w-0 flex-col gap-[3px]">
                  <span className="flex min-w-0 items-center gap-[7px]">
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); onHolderClick(c); }}
                      className="truncate text-start text-[14.5px] font-bold text-[var(--chip-ink)] underline-offset-2 hover:text-[var(--chip-brand)] hover:underline"
                    >
                      {holder.name}
                    </button>
                    {holder.name_changed_since_issue && holder.issued_as_name && (
                      <NameChangedHint issuedAs={holder.issued_as_name} />
                    )}
                    {c.holder_chip_count > 1 && (
                      <button
                        type="button"
                        title="סנן את הטבלה לצ׳יפים של מחזיק זה"
                        onClick={(e) => { e.stopPropagation(); onHolderFilter(c); }}
                        className="inline-flex h-[20px] shrink-0 items-center rounded-[6px] border border-[var(--chip-brand-border)] bg-[var(--chip-brand-soft)] px-2 text-[11px] font-bold text-[var(--chip-brand-ink)] transition-colors hover:bg-[var(--chip-brand)] hover:text-white"
                      >
                        {c.holder_chip_count} צ׳יפים
                      </button>
                    )}
                  </span>
                  <span className="flex min-w-0 items-center gap-[6px]">
                    <span className="text-[12.5px] font-semibold text-[var(--chip-ink-muted)]">
                      דירה {c.apartment_number}
                    </span>
                    <RolePill role={c.resident_role} />
                    {!holder.is_registry_linked && <NotInRegistryBadge />}
                  </span>
                </span>

                <span className="flex min-w-0 flex-col items-start gap-[3px]">
                  <ChipNumberTag chip={c} />
                  {searchTerm && c.match_type && <MatchBadge type={c.match_type} />}
                </span>

                <span className="flex justify-center">
                  <TypePill chip={c} />
                </span>

                <span className="flex flex-col items-center gap-1">
                  <StatusPill chip={c} />
                  {c.status === 'inactive' && !c.controller_synced && <PendingControllerHint />}
                </span>

                <span className="chip-num text-center text-[13px] text-[var(--chip-ink-muted)]">
                  {formatDate(c.issued_at)}
                </span>

                <span className="truncate text-center text-[13.5px] font-medium text-[var(--chip-ink-muted)]">
                  {c.issued_by_name || <Dash />}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Mobile — stacked entity cards (structure per DESIGN.md §9b, ref tones) */}
      <div className="space-y-2 p-4 sm:hidden">
        {items.map((c) => {
          const holder = resolveChipHolder(c);
          return (
            <button
              key={c.id}
              type="button"
              onClick={() => onRowClick(c)}
              className="flex w-full cursor-pointer items-center gap-3 rounded-[13px] border border-[var(--chip-border)] bg-[var(--chip-panel)] p-4 text-start transition-colors hover:bg-[var(--chip-hover)]"
            >
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[10px] bg-[var(--chip-violet-soft)] text-[var(--chip-violet)]">
                <KeyRound className="h-[18px] w-[18px]" />
              </span>

              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-[15px] font-bold text-[var(--chip-ink)]">
                    {holder.name}
                  </span>
                  {c.holder_chip_count > 1 && (
                    <span className="inline-flex h-[20px] shrink-0 items-center rounded-[6px] bg-[var(--chip-brand-soft)] px-2 text-[11px] font-bold text-[var(--chip-brand-ink)]">
                      {c.holder_chip_count} צ׳יפים
                    </span>
                  )}
                </div>
                <div className="mt-1 flex min-w-0 flex-wrap items-center gap-[6px]">
                  <ChipNumberTag chip={c} />
                  <span className="text-[12.5px] font-semibold text-[var(--chip-ink-muted)]">
                    דירה {c.apartment_number}
                  </span>
                  <RolePill role={c.resident_role} />
                  {!holder.is_registry_linked && <NotInRegistryBadge />}
                  {searchTerm && c.match_type && <MatchBadge type={c.match_type} />}
                </div>
                {c.status === 'inactive' && !c.controller_synced && (
                  <div className="mt-1.5">
                    <PendingControllerHint />
                  </div>
                )}
              </div>

              <StatusPill chip={c} />
            </button>
          );
        })}
      </div>
    </>
  );
}
