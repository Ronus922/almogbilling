'use client';

// Holder view panel — ALL chips of one person (the "name → numbers" direction,
// product rule 4). Person identity is (contact_id, resident_role) [+ the
// holder_name snapshot for other/staff]. Read-only; a chip row click drills
// into the chip detail panel. Chips-skin (declared exception — extended from
// the ref palette; shell structure per DESIGN.md §12 Sheet).

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { KeyRound, Phone, User, X } from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import type { ChipResidentRole, ChipWithHolder } from '@/lib/types/chips';
import {
  CHIP_TYPE_LABEL,
  DEACTIVATION_REASON_LABEL,
  RESIDENT_ROLE_LABEL,
} from '@/lib/constants/chips';
import { formatPhoneDisplay } from '@/lib/phone';

export interface HolderRef {
  contactId: string;
  role: ChipResidentRole;
  /** Narrows the person for snapshot roles (other/staff). */
  holderName: string | null;
  displayName: string;
  apartmentNumber: string;
  phone: string | null;
}

function formatDate(value: string | null): string {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('he-IL', {
    timeZone: 'Asia/Jerusalem', day: '2-digit', month: '2-digit', year: 'numeric',
  });
}

export function ChipHolderPanel({
  holder,
  open,
  onOpenChange,
  onChipClick,
}: {
  holder: HolderRef | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChipClick: (chipId: string) => void;
}) {
  const [items, setItems] = useState<ChipWithHolder[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || !holder) return;
    let cancelled = false;
    setLoading(true);
    const params = holder.holderName
      ? `?holder_name=${encodeURIComponent(holder.holderName)}`
      : '';
    fetch(`/api/chips/holders/${holder.contactId}/${holder.role}${params}`, {
      credentials: 'include',
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { items?: ChipWithHolder[] };
        if (!cancelled) setItems(Array.isArray(data.items) ? data.items : []);
      })
      .catch((err: Error) => {
        if (!cancelled) {
          toast.error(`טעינת צ׳יפי המחזיק נכשלה: ${err.message}`);
          setItems([]);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, holder]);

  const activeCount = items.filter((c) => c.status === 'active').length;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="left"
        className="chips-skin w-full p-0 sm:w-[55vw] md:min-w-[720px] flex flex-col gap-0 overflow-hidden bg-[var(--chip-bg)]"
      >
        {/* Header — ref gradient (115deg, #2B3FB8 → #3D5AFE 62% → #5872FF) */}
        <SheetHeader className="flex-none gap-2 bg-[image:var(--chip-header-gradient)] px-[26px] py-[20px] text-white">
          <div className="flex items-center gap-[13px]">
            <span className="grid h-11 w-11 shrink-0 place-items-center rounded-[11px] border border-white/25 bg-white/12 text-white">
              <User className="h-[21px] w-[21px]" />
            </span>
            <div className="min-w-0 flex-1">
              <SheetTitle className="truncate text-[21px] font-extrabold tracking-[-0.02em] text-white">
                {holder?.displayName ?? ''}
              </SheetTitle>
              <p className="flex flex-wrap items-center gap-x-2 text-[13.5px] font-medium text-white/80">
                <span>{holder ? RESIDENT_ROLE_LABEL[holder.role] : ''}</span>
                <span>·</span>
                <span>דירה {holder?.apartmentNumber ?? ''}</span>
                {holder?.phone && (
                  <>
                    <span>·</span>
                    <span className="chip-num inline-flex items-center gap-1">
                      <Phone className="h-3.5 w-3.5" />
                      {formatPhoneDisplay(holder.phone)}
                    </span>
                  </>
                )}
              </p>
            </div>
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              aria-label="סגור"
              className="grid h-11 w-11 shrink-0 cursor-pointer place-items-center rounded-[11px] border border-white/25 bg-white/12 text-white transition-colors hover:bg-white/22"
            >
              <X className="h-[18px] w-[18px]" strokeWidth={2.4} />
            </button>
          </div>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto p-[22px]">
          <div className="mx-auto flex max-w-[820px] flex-col gap-[18px]">
            <div className="overflow-hidden rounded-[16px] border border-[var(--chip-border)] bg-[var(--chip-panel)]">
              <div className="flex items-center gap-[11px] border-b border-[var(--chip-border)] px-5 py-[14px]">
                <span className="grid h-[34px] w-[34px] shrink-0 place-items-center rounded-[10px] bg-[var(--chip-brand-soft)] text-[var(--chip-brand)]">
                  <KeyRound className="h-[19px] w-[19px]" />
                </span>
                <div className="flex-1 text-start">
                  <h2 className="text-[15.5px] font-extrabold tracking-[-0.01em] text-[var(--chip-ink)]">
                    הצ׳יפים של {holder?.displayName ?? ''}
                  </h2>
                  <div className="mt-0.5 text-[12.5px] font-medium text-[var(--chip-ink-soft)]">
                    {loading ? 'טוען…' : `${items.length} צ׳יפים · ${activeCount} פעילים`}
                  </div>
                </div>
              </div>

              <div className="p-4">
                {loading ? (
                  <div className="space-y-2">
                    {Array.from({ length: 3 }).map((_, i) => (
                      <div key={i} className="h-[52px] animate-pulse rounded-[11px] bg-[var(--chip-hover)]" />
                    ))}
                  </div>
                ) : items.length === 0 ? (
                  <div className="rounded-[12px] border-[1.5px] border-dashed border-[var(--chip-border-strong)] p-6 text-center text-[13px] font-semibold text-[var(--chip-ink-soft)]">
                    לא נמצאו צ׳יפים למחזיק זה
                  </div>
                ) : (
                  <div className="flex flex-col gap-2">
                    {items.map((c) => {
                      const active = c.status === 'active';
                      return (
                        <button
                          key={c.id}
                          type="button"
                          onClick={() => onChipClick(c.id)}
                          className={cn(
                            'flex min-h-[52px] w-full cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 rounded-[11px] border-[1.5px] px-[13px] py-2 text-start transition-colors',
                            active
                              ? 'border-[var(--chip-green-border)] bg-[var(--chip-green-soft)] hover:border-[var(--chip-green)]'
                              : 'border-dashed border-[var(--chip-border-strong)] bg-[var(--chip-panel-alt)] hover:border-[var(--chip-ink-ghost)]',
                          )}
                        >
                          <span
                            className={cn(
                              'chip-num text-[14px] font-semibold tracking-[0.02em]',
                              active
                                ? 'text-[var(--chip-green-ink)]'
                                : 'text-[var(--chip-ink-soft)] line-through decoration-[var(--chip-ink-ghost)]',
                            )}
                          >
                            {c.chip_number}
                          </span>

                          <span
                            className={cn(
                              'inline-flex h-[22px] items-center gap-[5px] rounded-[6px] bg-white px-2 text-[11px] font-bold',
                              active ? 'text-[var(--chip-green-ink)]' : 'bg-[var(--chip-hover)] text-[var(--chip-ink-soft)]',
                            )}
                          >
                            <span
                              className={cn(
                                'h-[6px] w-[6px] rounded-full',
                                active ? 'bg-[var(--chip-green)]' : 'bg-[var(--chip-ink-ghost)]',
                              )}
                            />
                            {active ? 'פעיל' : 'לא פעיל'}
                          </span>

                          <span className="text-[12px] font-bold text-[var(--chip-ink-muted)]">
                            {CHIP_TYPE_LABEL[c.chip_type]}
                          </span>

                          <span className="chip-num text-[12px] text-[var(--chip-ink-soft)]">
                            {formatDate(c.issued_at)}
                          </span>

                          {!active && c.deactivation_reason && (
                            <span className="text-[12px] font-semibold text-[var(--chip-ink-soft)]">
                              סיבה: {DEACTIVATION_REASON_LABEL[c.deactivation_reason]}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
