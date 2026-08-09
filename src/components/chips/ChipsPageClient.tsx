'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Info, KeyRound, Plus, Search, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import type { Chip, ChipWithHolder, ChipsKpis, ChipTab } from '@/lib/types/chips';
import { isSnapshotRole, resolveChipHolder } from '@/lib/chips/holder';
import { ChipsKpiRow } from './ChipsKpiRow';
import { ChipsTable } from './ChipsTable';
import { IssueChipSheet } from './IssueChipSheet';
import { DeactivateChipDialog } from './DeactivateChipDialog';
import { ReactivateChipDialog } from './ReactivateChipDialog';
import { ChipDetailPanel } from './ChipDetailPanel';
import { ChipHolderPanel, type HolderRef } from './ChipHolderPanel';

// List filter tabs — labels per the chips product spec (ChipTab values).
const TABS: { value: ChipTab; label: string }[] = [
  { value: 'all', label: 'הכל' },
  { value: 'active', label: 'פעילים' },
  { value: 'inactive', label: 'לא פעילים' },
  { value: 'pending_sync', label: 'ממתין לחסימה בבקר' },
  { value: 'app', label: 'אפליקציה' },
];

/** Prefill for the issue sheet (reissue / issue-another flows). */
type IssueInitial = {
  contactId: string;
  apartmentNumber: string;
  residentRole?: string | null;
  holderName?: string | null;
  holderPhone?: string | null;
} | null;

function issueInitialFromChip(chip: Chip): IssueInitial {
  return {
    contactId: chip.contact_id,
    apartmentNumber: chip.apartment_number,
    residentRole: chip.resident_role,
    holderName: chip.holder_name,
    holderPhone: chip.holder_phone,
  };
}

/** Holder identity of one chip — (contact_id, role) [+ holder_name for other/staff]. */
function holderRefFromChip(chip: ChipWithHolder): HolderRef {
  const holder = resolveChipHolder(chip);
  return {
    contactId: chip.contact_id,
    role: chip.resident_role,
    holderName: isSnapshotRole(chip.resident_role) ? chip.holder_name : null,
    displayName: holder.name,
    apartmentNumber: chip.apartment_number,
    phone: holder.phone,
  };
}

function sameHolder(chip: ChipWithHolder, ref: HolderRef): boolean {
  if (chip.contact_id !== ref.contactId || chip.resident_role !== ref.role) return false;
  return ref.holderName === null || chip.holder_name === ref.holderName;
}

export function ChipsPageClient({ canEdit }: { canEdit: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [items, setItems] = useState<ChipWithHolder[]>([]);
  const [kpis, setKpis] = useState<ChipsKpis | null>(null);
  const [loading, setLoading] = useState(true);

  const [tab, setTab] = useState<ChipTab>('all');
  const [search, setSearch] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');

  // "N צ׳יפים" filter — client-side narrowing of the list to one holder.
  const [holderFilter, setHolderFilter] = useState<HolderRef | null>(null);

  // Panels / dialogs state machine
  const [selectedChipId, setSelectedChipId] = useState<string | null>(null);
  const [holderPanel, setHolderPanel] = useState<HolderRef | null>(null);
  const [issueOpen, setIssueOpen] = useState(false);
  const [issueInitial, setIssueInitial] = useState<IssueInitial>(null);
  const [deactivateTarget, setDeactivateTarget] = useState<Chip | null>(null);
  const [reactivateTarget, setReactivateTarget] = useState<Chip | null>(null);

  // Partial-registry banner — starts hidden so SSR markup matches, then reveals
  // on mount unless previously dismissed (localStorage flag).
  const [bannerVisible, setBannerVisible] = useState(false);
  useEffect(() => {
    try {
      if (window.localStorage.getItem('chips_registry_banner_dismissed') !== '1') {
        setBannerVisible(true);
      }
    } catch {
      // Storage blocked — keep the banner hidden for this visit.
    }
  }, []);

  const dismissBanner = useCallback(() => {
    setBannerVisible(false);
    try {
      window.localStorage.setItem('chips_registry_banner_dismissed', '1');
    } catch {
      // Storage blocked — dismissal holds for this session only.
    }
  }, []);

  // Debounce the free-text search (300ms). Tab changes refetch immediately.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const fetchChips = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (tab !== 'all') params.set('tab', tab);
      if (debouncedQ) params.set('q', debouncedQ);
      const qs = params.toString();
      const res = await fetch(qs ? `/api/chips?${qs}` : '/api/chips', {
        credentials: 'include',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { items?: ChipWithHolder[] };
      setItems(Array.isArray(data.items) ? data.items : []);
    } catch (err) {
      toast.error(`טעינת הצ׳יפים נכשלה: ${(err as Error).message}`);
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [tab, debouncedQ]);

  const fetchKpis = useCallback(async () => {
    try {
      const res = await fetch('/api/chips/kpis', { credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { kpis?: ChipsKpis };
      if (data.kpis) setKpis(data.kpis);
    } catch (err) {
      toast.error(`טעינת הנתונים נכשלה: ${(err as Error).message}`);
    }
  }, []);

  useEffect(() => {
    void fetchChips();
  }, [fetchChips]);

  useEffect(() => {
    void fetchKpis();
  }, [fetchKpis]);

  const refetchAll = useCallback(() => {
    void fetchChips();
    void fetchKpis();
  }, [fetchChips, fetchKpis]);

  // Deep link: ?chip=<id> opens the detail panel on mount.
  useEffect(() => {
    const id = searchParams.get('chip');
    if (id) setSelectedChipId(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Closing the panel clears the ?chip= param (keeps other params intact).
  const closeDetail = useCallback(() => {
    setSelectedChipId(null);
    if (searchParams.get('chip')) {
      const params = new URLSearchParams(searchParams.toString());
      params.delete('chip');
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    }
  }, [router, pathname, searchParams]);

  function openIssueSheet(initial: IssueInitial) {
    setIssueInitial(initial);
    setIssueOpen(true);
  }

  const visibleItems = useMemo(
    () => (holderFilter ? items.filter((c) => sameHolder(c, holderFilter)) : items),
    [items, holderFilter],
  );

  return (
    <div className="chips-skin space-y-6">
      {/* Top bar — structure §28.9, chips-skin tones (ref) */}
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="flex items-center gap-[13px]">
          <span className="grid h-12 w-12 shrink-0 place-items-center rounded-[14px] bg-[var(--chip-brand-soft)] text-[var(--chip-brand)]">
            <KeyRound className="h-6 w-6" />
          </span>
          <div>
            <h1 className="text-[27px] font-black tracking-[-0.02em] text-[var(--chip-ink)]">
              צ׳יפי כניסה
            </h1>
            <p className="text-[13.5px] font-medium text-[var(--chip-ink-soft)]">
              ניהול צ׳יפי הכניסה לבניין
              {kpis ? ` · ${kpis.active} פעילים` : ''}
            </p>
          </div>
        </div>

        {canEdit && (
          <Button
            type="button"
            onClick={() => openIssueSheet(null)}
            className="h-[46px] gap-2 rounded-[11px] bg-[var(--chip-brand)] px-[26px] text-[15px] font-bold text-white hover:bg-[var(--chip-brand-hover)]"
          >
            <Plus className="h-[17px] w-[17px]" strokeWidth={2.3} />
            הנפק צ׳יפ
          </Button>
        )}
      </div>

      {/* Partial-registry info banner — dismissible, remembered in localStorage */}
      {bannerVisible && (
        <div className="flex items-center gap-3 rounded-[11px] border border-[var(--chip-amber-border)] bg-[var(--chip-amber-soft)] px-4 py-3 text-[12.5px] font-semibold text-[var(--chip-amber-ink)]">
          <Info className="h-4 w-4 shrink-0" aria-hidden />
          <p className="min-w-0 flex-1">
            המרשם עשוי להיות חלקי — ייבא דיירים או הוסף דירות ידנית
            {kpis
              ? ` · במרשם ${kpis.apartments_total} דירות (מתוכן ${kpis.apartments_with_debtor} עם חוב פעיל)`
              : ''}
          </p>
          <button
            type="button"
            onClick={dismissBanner}
            aria-label="סגור הודעה"
            className="-my-2 -me-2 grid h-11 w-11 shrink-0 place-items-center rounded-[9px] transition-colors hover:bg-[var(--chip-amber-border)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* KPI row */}
      <ChipsKpiRow kpis={kpis} />

      {/* Single card: toolbar (border-bottom) → table */}
      <div className="overflow-hidden rounded-[16px] border border-[var(--chip-border)] bg-[var(--chip-panel)]">
        <div className="flex flex-col gap-3 border-b border-[var(--chip-border)] px-[22px] py-4 md:flex-row md:items-center md:justify-between">
          {/* Tab pills (RTL start = right) */}
          <div className="flex flex-wrap items-center gap-2">
            {TABS.map((t) => (
              <button
                key={t.value}
                type="button"
                onClick={() => setTab(t.value)}
                className={cn(
                  'inline-flex h-9 cursor-pointer items-center rounded-full px-4 text-[13.5px] transition-colors',
                  tab === t.value
                    ? 'bg-[var(--chip-brand)] font-bold text-white'
                    : 'border-[1.5px] border-[var(--chip-border)] bg-[var(--chip-panel)] font-semibold text-[var(--chip-ink-muted)] hover:bg-[var(--chip-hover)]',
                )}
              >
                {t.label}
              </button>
            ))}
            {debouncedQ && (
              <span className="inline-flex h-9 items-center rounded-full bg-[var(--chip-brand-soft)] px-3 text-[12px] font-bold text-[var(--chip-brand-ink)]">
                מציג תוצאות מכל הסטטוסים
              </span>
            )}
          </div>

          {/* Search — one box, both directions (number → name, name → numbers) */}
          <div className="relative w-full md:w-[340px]">
            <Search className="pointer-events-none absolute start-[13px] top-1/2 h-[17px] w-[17px] -translate-y-1/2 text-[var(--chip-ink-soft)]" />
            <Input
              placeholder="חפש לפי מספר צ׳יפ, מספר דירה או שם דייר"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-11 rounded-[11px] border-[1.5px] border-[var(--chip-border)] bg-[var(--chip-panel)] ps-[42px] pe-[14px] text-[14px] placeholder:text-[var(--chip-ink-soft)] focus-visible:border-[var(--chip-brand)] focus-visible:ring-4 focus-visible:ring-[rgba(61,90,254,0.12)]"
            />
          </div>
        </div>

        {/* Holder-filter bar — active after clicking "N צ׳יפים" */}
        {holderFilter && (
          <div className="flex items-center gap-3 border-b border-[var(--chip-border)] bg-[var(--chip-brand-soft)] px-[22px] py-[10px]">
            <p className="min-w-0 flex-1 truncate text-[13px] font-bold text-[var(--chip-brand-ink)]">
              מציג את הצ׳יפים של {holderFilter.displayName} · דירה {holderFilter.apartmentNumber}
            </p>
            <button
              type="button"
              onClick={() => setHolderFilter(null)}
              className="inline-flex h-8 shrink-0 cursor-pointer items-center gap-1 rounded-[8px] border border-[var(--chip-brand-border)] bg-white px-3 text-[12.5px] font-bold text-[var(--chip-brand-ink)] transition-colors hover:bg-[var(--chip-hover)]"
            >
              <X className="h-3.5 w-3.5" />
              ניקוי סינון
            </button>
          </div>
        )}

        <ChipsTable
          items={visibleItems}
          loading={loading}
          searchTerm={debouncedQ}
          onRowClick={(chip) => setSelectedChipId(chip.id)}
          onHolderClick={(chip) => setHolderPanel(holderRefFromChip(chip))}
          onHolderFilter={(chip) => setHolderFilter(holderRefFromChip(chip))}
        />
      </div>

      <IssueChipSheet
        open={issueOpen}
        onOpenChange={(o: boolean) => {
          setIssueOpen(o);
          if (!o) setIssueInitial(null);
        }}
        initial={issueInitial}
        onIssued={refetchAll}
      />

      <DeactivateChipDialog
        chip={deactivateTarget}
        open={!!deactivateTarget}
        onOpenChange={(o: boolean) => {
          if (!o) setDeactivateTarget(null);
        }}
        onDone={(opts?: { reissue?: boolean }) => {
          const chip = deactivateTarget;
          setDeactivateTarget(null);
          closeDetail();
          refetchAll();
          if (opts?.reissue && chip) openIssueSheet(issueInitialFromChip(chip));
        }}
      />

      <ReactivateChipDialog
        chip={reactivateTarget}
        open={!!reactivateTarget}
        onOpenChange={(o: boolean) => {
          if (!o) setReactivateTarget(null);
        }}
        onDone={() => {
          setReactivateTarget(null);
          closeDetail();
          refetchAll();
        }}
      />

      <ChipDetailPanel
        chipId={selectedChipId}
        open={!!selectedChipId}
        onOpenChange={(o: boolean) => {
          if (!o) closeDetail();
        }}
        canEdit={canEdit}
        onChanged={refetchAll}
        onRequestDeactivate={(chip: Chip) => setDeactivateTarget(chip)}
        onRequestReactivate={(chip: Chip) => setReactivateTarget(chip)}
        onRequestReissue={(chip: Chip) => {
          closeDetail();
          openIssueSheet(issueInitialFromChip(chip));
        }}
        onOpenHolder={(chip: ChipWithHolder) => {
          closeDetail();
          setHolderPanel(holderRefFromChip(chip));
        }}
      />

      {/* Holder view — all chips of one person (name → numbers) */}
      <ChipHolderPanel
        holder={holderPanel}
        open={!!holderPanel}
        onOpenChange={(o: boolean) => {
          if (!o) setHolderPanel(null);
        }}
        onChipClick={(chipId: string) => {
          setHolderPanel(null);
          setSelectedChipId(chipId);
        }}
      />
    </div>
  );
}
