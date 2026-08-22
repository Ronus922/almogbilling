'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Plus, Search, Upload, X, Package, SquareParking } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { DEFAULT_LOT_CODE, OWNER_TYPE_LABEL, PARKING_OWNER_TYPES } from '@/lib/constants/parking';
import type {
  ParkingOwnerType, ParkingSpot, ParkingSummary, StorageUnit,
} from '@/lib/types/parking';
import { ParkingSpotsTab } from './ParkingSpotsTab';
import { ParkingByApartmentTab } from './ParkingByApartmentTab';
import { ParkingSummaryTab } from './ParkingSummaryTab';
import { ParkingSpotPanel } from './ParkingSpotPanel';
import { StorageUnitPanel } from './StorageUnitPanel';
import { ParkingImportPanel } from './ParkingImportPanel';
import { DeactivateDialog } from './DeactivateDialog';

type TabKey = 'by_spot' | 'by_apartment' | 'summary';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'by_spot', label: 'לפי חניה' },
  { key: 'by_apartment', label: 'לפי דירה' },
  { key: 'summary', label: 'סיכום' },
];

/** What the deactivate dialog is currently pointed at. */
type ToggleTarget =
  | { kind: 'parking'; row: ParkingSpot }
  | { kind: 'storage'; row: StorageUnit };

export function ParkingPageClient({
  canEdit, canImport, initialApartment,
}: {
  canEdit: boolean;
  canImport: boolean;
  initialApartment: string | null;
}) {
  const [tab, setTab] = useState<TabKey>(initialApartment ? 'by_apartment' : 'by_spot');
  const [spots, setSpots] = useState<ParkingSpot[]>([]);
  const [units, setUnits] = useState<StorageUnit[]>([]);
  const [summary, setSummary] = useState<ParkingSummary | null>(null);
  const [loading, setLoading] = useState(true);

  const [search, setSearch] = useState(initialApartment ?? '');
  const [ownerFilter, setOwnerFilter] = useState<ParkingOwnerType | null>(null);
  const [showInactive, setShowInactive] = useState(false);

  const [spotPanel, setSpotPanel] = useState<{ open: boolean; spot: ParkingSpot | null }>({ open: false, spot: null });
  const [unitPanel, setUnitPanel] = useState<{ open: boolean; unit: StorageUnit | null }>({ open: false, unit: null });
  const [importOpen, setImportOpen] = useState(false);
  const [toggleTarget, setToggleTarget] = useState<ToggleTarget | null>(null);
  const [toggling, setToggling] = useState(false);

  // One fetch for all three tabs: the by-apartment view is a client-side
  // grouping of the same two lists the first tab shows, and the summary is
  // cheap. Refetching per tab would make switching tabs flash.
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      // The heading says "חניון 1P", so the list must show that lot and no
      // other — the summary is already scoped the same way.
      qs.set('lot_code', DEFAULT_LOT_CODE);
      if (search.trim()) qs.set('q', search.trim());
      if (ownerFilter) qs.set('owner_type', ownerFilter);
      if (showInactive) qs.set('include_inactive', '1');
      const suffix = qs.toString() ? `?${qs}` : '';

      // storage has no lot concept — strip the param rather than send a filter
      // the storage route would silently ignore.
      const storageQs = new URLSearchParams(qs);
      storageQs.delete('lot_code');
      const storageSuffix = storageQs.toString() ? `?${storageQs}` : '';

      const [pRes, sRes, sumRes] = await Promise.all([
        fetch(`/api/parking${suffix}`, { credentials: 'include' }),
        fetch(`/api/storage${storageSuffix}`, { credentials: 'include' }),
        fetch('/api/parking/summary', { credentials: 'include' }),
      ]);
      if (!pRes.ok || !sRes.ok || !sumRes.ok) throw new Error('טעינת הנתונים נכשלה');

      const [pData, sData, sumData] = await Promise.all([
        pRes.json() as Promise<{ spots?: ParkingSpot[] }>,
        sRes.json() as Promise<{ units?: StorageUnit[] }>,
        sumRes.json() as Promise<ParkingSummary>,
      ]);
      setSpots(Array.isArray(pData.spots) ? pData.spots : []);
      setUnits(Array.isArray(sData.units) ? sData.units : []);
      setSummary(sumData);
    } catch (e) {
      toast.error((e as Error).message);
      setSpots([]); setUnits([]); setSummary(null);
    } finally {
      setLoading(false);
    }
  }, [search, ownerFilter, showInactive]);

  useEffect(() => { void load(); }, [load]);

  async function confirmToggle(reason: string) {
    if (!toggleTarget) return;
    setToggling(true);
    try {
      const { kind, row } = toggleTarget;
      const base = kind === 'parking' ? '/api/parking' : '/api/storage';
      const res = await fetch(`${base}/${row.id}/toggle-active`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ is_active: false, reason }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? 'ביטול ההפעלה נכשל');
      toast.success(kind === 'parking' ? 'הפעלת החניה בוטלה' : 'הפעלת המחסן בוטלה');
      setToggleTarget(null);
      void load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setToggling(false);
    }
  }

  /** Reactivation carries no reason, so it needs no confirmation dialog. */
  async function reactivate(kind: 'parking' | 'storage', id: string) {
    try {
      const base = kind === 'parking' ? '/api/parking' : '/api/storage';
      const res = await fetch(`${base}/${id}/toggle-active`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ is_active: true }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? 'ההפעלה מחדש נכשלה');
      toast.success('הופעל מחדש');
      void load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  const filtered = !!search.trim() || !!ownerFilter;
  const counts = useMemo(() => ({
    by_spot: spots.length,
    by_apartment: new Set([
      ...spots.filter((s) => s.apartment_number).map((s) => s.apartment_number as string),
      ...units.filter((u) => u.apartment_number).map((u) => u.apartment_number as string),
    ]).size,
    summary: summary ? summary.rows.filter((r) => !r.ok).length : 0,
  }), [spots, units, summary]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="flex items-baseline gap-3">
          <h1 className="text-2xl font-extrabold text-slate-900">חניות ומחסנים</h1>
          <span className="text-sm text-muted-foreground">חניון 1P — הצמדות לדירות, ליזם ולנציגות</span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {canImport && (
            <Button type="button" variant="outline" onClick={() => setImportOpen(true)} className="gap-2">
              <Upload className="h-4 w-4" />
              ייבוא Excel
            </Button>
          )}
          {canEdit && (
            <>
              <Button
                type="button" variant="outline" className="gap-2"
                onClick={() => setUnitPanel({ open: true, unit: null })}
              >
                <Package className="h-4 w-4" />
                מחסן חדש
              </Button>
              <Button
                type="button" className="gap-2"
                onClick={() => setSpotPanel({ open: true, spot: null })}
              >
                <Plus className="h-4 w-4" />
                חניה חדשה
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Tabs (DESIGN.md §16) */}
      <div className="grid grid-cols-3 gap-2">
        {TABS.map((t) => {
          const active = tab === t.key;
          // The summary counter is a DEVIATION count, so it stays amber even
          // when idle — a zero simply isn't rendered.
          const isWarn = t.key === 'summary' && counts.summary > 0;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={cn(
                'flex cursor-pointer items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition-colors',
                active
                  ? 'bg-blue-600 text-white'
                  : 'border border-slate-200 bg-white text-slate-700 hover:bg-slate-50',
              )}
            >
              {t.label}
              {counts[t.key] > 0 && (
                <span className={cn(
                  'grid h-5 min-w-5 place-items-center rounded-full px-1.5 text-[11.5px] font-extrabold tabular-nums',
                  active ? 'bg-white/25 text-white'
                    : isWarn ? 'bg-amber-100 text-amber-700' : 'bg-blue-100 text-blue-700',
                )}>
                  {counts[t.key]}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div className="space-y-4 rounded-lg border bg-card p-4">
        {/* Toolbar — hidden on the summary tab, which is not a filtered list */}
        {tab !== 'summary' && (
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="relative w-full max-w-sm">
              <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="חיפוש לפי מספר חניה, דירה או הערה..."
                className={cn('ps-9', search && 'pe-9')}
              />
              {search && (
                <button
                  type="button"
                  aria-label="נקה חיפוש"
                  onClick={() => setSearch('')}
                  className="absolute end-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <FilterChip
                label="הכול"
                active={ownerFilter === null}
                onClick={() => setOwnerFilter(null)}
              />
              {PARKING_OWNER_TYPES.map((t) => (
                <FilterChip
                  key={t}
                  label={OWNER_TYPE_LABEL[t]}
                  active={ownerFilter === t}
                  onClick={() => setOwnerFilter(ownerFilter === t ? null : t)}
                />
              ))}
              <span className="mx-1 h-5 w-px bg-slate-200" aria-hidden />
              <FilterChip
                label="כולל מבוטלות"
                active={showInactive}
                onClick={() => setShowInactive((v) => !v)}
              />
            </div>
          </div>
        )}

        {tab === 'by_spot' && (
          <ParkingSpotsTab
            spots={spots}
            loading={loading}
            canEdit={canEdit}
            filtered={filtered}
            onEdit={(s) => setSpotPanel({ open: true, spot: s })}
            onCreate={() => setSpotPanel({ open: true, spot: null })}
            onToggleActive={(s) => {
              if (s.is_active) setToggleTarget({ kind: 'parking', row: s });
              else void reactivate('parking', s.id);
            }}
          />
        )}

        {tab === 'by_apartment' && (
          <ParkingByApartmentTab
            spots={spots}
            units={units}
            loading={loading}
            filtered={filtered}
            onSelectSpot={(s) => setSpotPanel({ open: true, spot: s })}
            onSelectUnit={(u) => setUnitPanel({ open: true, unit: u })}
          />
        )}

        {tab === 'summary' && <ParkingSummaryTab summary={summary} loading={loading} />}
      </div>

      <ParkingSpotPanel
        open={spotPanel.open}
        spot={spotPanel.spot}
        canEdit={canEdit}
        onOpenChange={(o) => setSpotPanel((p) => ({ ...p, open: o }))}
        onSaved={load}
      />
      <StorageUnitPanel
        open={unitPanel.open}
        unit={unitPanel.unit}
        canEdit={canEdit}
        onOpenChange={(o) => setUnitPanel((p) => ({ ...p, open: o }))}
        onSaved={load}
      />
      {canImport && (
        <ParkingImportPanel
          open={importOpen}
          onOpenChange={setImportOpen}
          onImported={load}
        />
      )}

      <DeactivateDialog
        open={!!toggleTarget}
        submitting={toggling}
        subject={
          toggleTarget
            ? toggleTarget.kind === 'parking'
              ? `חניה ${toggleTarget.row.spot_number}`
              : `מחסן ${toggleTarget.row.unit_number}`
            : ''
        }
        assignedTo={
          toggleTarget?.row.apartment_number
            ? `דירה ${toggleTarget.row.apartment_number}`
            : null
        }
        onCancel={() => setToggleTarget(null)}
        onConfirm={(reason) => void confirmToggle(reason)}
      />
    </div>
  );
}

function FilterChip({
  label, active, onClick,
}: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'cursor-pointer rounded-full px-3 py-1.5 text-xs font-semibold ring-1 transition-colors',
        active
          ? 'bg-blue-600 text-white ring-blue-600'
          : 'bg-white text-slate-600 ring-slate-200 hover:bg-slate-50',
      )}
    >
      {label}
    </button>
  );
}
