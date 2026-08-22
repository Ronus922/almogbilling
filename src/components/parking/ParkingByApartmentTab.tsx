'use client';

import { useMemo } from 'react';
import { ExternalLink } from 'lucide-react';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { SIZE_TYPE_LABEL } from '@/lib/constants/parking';
import type { ParkingSpot, StorageUnit } from '@/lib/types/parking';
import { TableSkeleton, EmptyState } from './shared';

// Tab 2 — one row per apartment, grouped from the two flat lists.
//
// The count column is TOTAL PLACES (sum of capacity), not a row count: a double
// spot is one row and two places, so counting rows would under-report every
// apartment that holds one — which is precisely the arithmetic the source
// document is careful about.

interface ApartmentRow {
  apartment_number: string;
  parking: ParkingSpot[];
  storage: StorageUnit[];
  total_places: number;
}

interface Props {
  spots: ParkingSpot[];
  units: StorageUnit[];
  loading: boolean;
  onSelectSpot: (s: ParkingSpot) => void;
  onSelectUnit: (u: StorageUnit) => void;
  filtered: boolean;
}

function groupByApartment(spots: ParkingSpot[], units: StorageUnit[]): ApartmentRow[] {
  const map = new Map<string, ApartmentRow>();
  const row = (apt: string) => {
    let r = map.get(apt);
    if (!r) {
      r = { apartment_number: apt, parking: [], storage: [], total_places: 0 };
      map.set(apt, r);
    }
    return r;
  };

  for (const s of spots) {
    if (!s.apartment_number) continue;   // developer/committee spots have no apartment row
    const r = row(s.apartment_number);
    r.parking.push(s);
    r.total_places += s.capacity;
  }
  for (const u of units) {
    if (!u.apartment_number) continue;
    row(u.apartment_number).storage.push(u);
  }

  // Numeric sort where possible — apartment numbers are text in the schema, so
  // a plain string sort would put 1042 before 534.
  return [...map.values()].sort((a, b) => {
    const na = Number(a.apartment_number);
    const nb = Number(b.apartment_number);
    if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
    return a.apartment_number.localeCompare(b.apartment_number, 'he');
  });
}

function Chip({
  label, title, onClick, tone,
}: {
  label: string;
  title?: string;
  onClick: () => void;
  tone: 'parking' | 'storage';
}) {
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      title={title}
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums ring-1 transition-colors',
        tone === 'parking'
          ? 'bg-blue-50 text-blue-700 ring-blue-200 hover:bg-blue-100'
          : 'bg-violet-50 text-violet-700 ring-violet-200 hover:bg-violet-100',
      )}
    >
      {label}
    </button>
  );
}

export function ParkingByApartmentTab({
  spots, units, loading, onSelectSpot, onSelectUnit, filtered,
}: Props) {
  const rows = useMemo(() => groupByApartment(spots, units), [spots, units]);

  if (loading) return <TableSkeleton />;

  if (rows.length === 0) {
    return filtered
      ? <EmptyState title="לא נמצאו דירות התואמות לסינון" hint="נסו לנקות את החיפוש או את הסינון." />
      : (
        <EmptyState
          title="אין עדיין הצמדות לדירות"
          hint="חניות ומחסנים המשויכים לדירה יופיעו כאן, מקובצים לפי מספר דירה."
        />
      );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
      <div className="overflow-x-auto">
        <Table>
          <TableHeader className="[&_tr]:border-b [&_tr]:border-slate-200">
            <TableRow className="bg-slate-50 hover:bg-slate-50">
              <TableHead className="h-11 px-4 text-start text-sm font-semibold text-slate-500">מס׳ דירה</TableHead>
              <TableHead className="h-11 px-4 text-start text-sm font-semibold text-slate-500">חניות</TableHead>
              <TableHead className="h-11 px-4 text-start text-sm font-semibold text-slate-500">מחסנים</TableHead>
              <TableHead className="h-11 px-4 text-center text-sm font-semibold text-slate-500">סה״כ מקומות</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.apartment_number} className="h-12 border-b border-slate-100 hover:bg-slate-50">
                <TableCell className="px-4 py-3 text-start text-sm font-bold text-slate-900 tabular-nums">
                  <a
                    href={`/contacts?apartment=${encodeURIComponent(r.apartment_number)}`}
                    className="inline-flex items-center gap-1 hover:text-blue-700 hover:underline"
                  >
                    {r.apartment_number}
                    <ExternalLink className="h-3 w-3 opacity-40" />
                  </a>
                </TableCell>
                <TableCell className="px-4 py-3 text-start">
                  <div className="flex flex-wrap gap-1.5">
                    {r.parking.length === 0
                      ? <span className="text-xs text-slate-300">—</span>
                      : r.parking.map((s) => (
                        <Chip
                          key={s.id}
                          tone="parking"
                          label={s.size_type === 'single' ? String(s.spot_number) : `${s.spot_number} ×2`}
                          title={s.size_type === 'single' ? undefined : SIZE_TYPE_LABEL[s.size_type]}
                          onClick={() => onSelectSpot(s)}
                        />
                      ))}
                  </div>
                </TableCell>
                <TableCell className="px-4 py-3 text-start">
                  <div className="flex flex-wrap gap-1.5">
                    {r.storage.length === 0
                      ? <span className="text-xs text-slate-300">—</span>
                      : r.storage.map((u) => (
                        <Chip
                          key={u.id}
                          tone="storage"
                          label={u.unit_number}
                          onClick={() => onSelectUnit(u)}
                        />
                      ))}
                  </div>
                </TableCell>
                <TableCell
                  dir="ltr"
                  className="px-4 py-3 text-center text-sm font-bold text-slate-900 tabular-nums"
                >
                  {r.total_places}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
