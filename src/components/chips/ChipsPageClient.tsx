'use client';

import { useCallback, useEffect, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Info, KeyRound, Plus, Search, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import type { Chip, ChipsKpis, ChipTab } from '@/lib/types/chips';
import { ChipsKpiRow } from './ChipsKpiRow';
import { ChipsTable } from './ChipsTable';
import { IssueChipSheet } from './IssueChipSheet';
import { DeactivateChipDialog } from './DeactivateChipDialog';
import { ReactivateChipDialog } from './ReactivateChipDialog';
import { ChipDetailPanel } from './ChipDetailPanel';

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

export function ChipsPageClient({ canEdit }: { canEdit: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [items, setItems] = useState<Chip[]>([]);
  const [kpis, setKpis] = useState<ChipsKpis | null>(null);
  const [loading, setLoading] = useState(true);

  const [tab, setTab] = useState<ChipTab>('all');
  const [search, setSearch] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');

  // Panels / dialogs state machine
  const [selectedChipId, setSelectedChipId] = useState<string | null>(null);
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
      const data = (await res.json()) as { items?: Chip[] };
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

  return (
    <div className="space-y-6">
      {/* Top bar — DESIGN.md §28.9 */}
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="flex items-center gap-[13px]">
          <span className="grid h-12 w-12 shrink-0 place-items-center rounded-[14px] bg-[#e8f0ff] text-[#2563eb]">
            <KeyRound className="h-6 w-6" />
          </span>
          <div>
            <h1 className="text-[27px] font-black tracking-[-0.02em] text-[#0f172a]">
              צ׳יפי כניסה
            </h1>
            <p className="text-[13.5px] font-medium text-[#94a3b8]">
              ניהול צ׳יפי הכניסה לבניין
              {kpis ? ` · ${kpis.active} פעילים` : ''}
            </p>
          </div>
        </div>

        {canEdit && (
          <Button
            type="button"
            onClick={() => openIssueSheet(null)}
            className="h-[46px] gap-2 rounded-[13px] bg-gradient-to-l from-[#1d4ed8] to-[#2563eb] px-5 text-[14.5px] font-bold text-white shadow-[0_10px_22px_-8px_rgba(37,99,235,0.6)] hover:from-[#1e40af] hover:to-[#1d4ed8]"
          >
            <Plus className="h-[17px] w-[17px]" strokeWidth={2.3} />
            הנפק צ׳יפ
          </Button>
        )}
      </div>

      {/* Partial-registry info banner — dismissible, remembered in localStorage */}
      {bannerVisible && (
        <div className="flex items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <Info className="h-4 w-4 shrink-0 text-amber-600" aria-hidden />
          <p className="min-w-0 flex-1">
            המרשם עשוי להיות חלקי — ייבא דיירים או הוסף דירות ידנית
          </p>
          <button
            type="button"
            onClick={dismissBanner}
            aria-label="סגור הודעה"
            className="-my-2 -me-2 grid h-11 w-11 shrink-0 place-items-center rounded-lg text-amber-600 transition-colors hover:bg-amber-100 hover:text-amber-900"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* KPI row */}
      <ChipsKpiRow kpis={kpis} />

      {/* Single card: toolbar (border-bottom) → table — §28.9 */}
      <div className="overflow-hidden rounded-[18px] border border-[#e9edf4] bg-white">
        <div className="flex flex-col gap-3 border-b border-[#eef1f6] px-[22px] py-4 md:flex-row md:items-center md:justify-between">
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
                    ? 'bg-[#2563eb] font-bold text-white'
                    : 'border border-[#e2e8f0] bg-white font-semibold text-[#475569] hover:bg-slate-50',
                )}
              >
                {t.label}
              </button>
            ))}
          </div>

          {/* Search (RTL end = left) */}
          <div className="relative w-full md:w-[300px]">
            <Search className="pointer-events-none absolute start-[13px] top-1/2 h-[17px] w-[17px] -translate-y-1/2 text-[#94a3b8]" />
            <Input
              placeholder="חיפוש לפי מספר צ׳יפ, דירה או מחזיק"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-10 rounded-[11px] border-[#e7ebf1] bg-[#fafbfd] ps-[42px] pe-[14px] text-[14px]"
            />
          </div>
        </div>

        <ChipsTable
          items={items}
          loading={loading}
          onRowClick={(chip) => setSelectedChipId(chip.id)}
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
      />
    </div>
  );
}
