'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { OWNER_TYPE_LABEL } from '@/lib/constants/parking';
import {
  apartmentOwner, blankParkingRow, blankStorageRow, parkingNumberError, parkingOccupancyOf,
  parkingRowOf, RELEASED_OWNER, saveParkingRow, saveStorageRow, storageNumberError,
  storageOccupancyOf, storageRowOf,
  type ParkingRow, type StorageRow,
} from '@/lib/parking/assetRows';
import { parkingClaimQuestion, parkingConflictMessage } from '@/lib/parking/conflictMessage';
import type { ParkingSizeType, ParkingSpot, StorageUnit } from '@/lib/types/parking';
import type { CellItem, CellSaveResult } from '@/components/parking/asset-cell';
import { AssetsTable, type AssetTableRow, type EditingCell } from '@/components/parking/assets-table';

// The state and the writing behind the /parking table.
//
// Every rule about what a number may be, who holds it and what a save does
// lives in lib/parking/assetRows.ts — the same layer the tenant form uses. What
// is local here is the one thing the two surfaces genuinely do differently:
// this screen sees every apartment at once, so a number held elsewhere is a
// transfer it can carry out, not a refusal it has to report.

/** Apartment numbers sort like numbers; anything unparseable sinks to the end. */
function byApartment(a: string, b: string): number {
  const na = Number(a.replace(/\D/g, ''));
  const nb = Number(b.replace(/\D/g, ''));
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
  return a.localeCompare(b, 'he');
}

function parkingItems(spots: ParkingSpot[]): CellItem[] {
  return [...spots]
    .sort((a, b) => a.spot_number - b.spot_number)
    .map((s) => ({
      key: `p-${s.id}`, id: s.id, number: String(s.spot_number), double: s.size_type !== 'single',
    }));
}

function storageItems(units: StorageUnit[]): CellItem[] {
  return [...units]
    .sort((a, b) => a.unit_number.localeCompare(b.unit_number, 'he', { numeric: true }))
    .map((u) => ({ key: `s-${u.id}`, id: u.id, number: u.unit_number, double: null }));
}

function replaceById<T extends { id: string }>(list: T[], saved: T): T[] {
  const i = list.findIndex((x) => x.id === saved.id);
  if (i === -1) return [...list, saved];
  const next = list.slice();
  next[i] = saved;
  return next;
}

export function ParkingPageClient({
  apartments,
  initialSpots,
  initialUnits,
  canEdit,
}: {
  apartments: string[];
  initialSpots: ParkingSpot[];
  initialUnits: StorageUnit[];
  canEdit: boolean;
}) {
  const [spots, setSpots] = useState<ParkingSpot[]>(initialSpots);
  const [units, setUnits] = useState<StorageUnit[]>(initialUnits);
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<EditingCell>(null);

  // A save writes several rows in sequence and each write must see what the
  // previous one did — so the loops carry their own copy and push it into state
  // as they go, rather than reading a value React has not re-rendered yet.
  const spotsRef = useRef(spots);
  spotsRef.current = spots;
  const unitsRef = useRef(units);
  unitsRef.current = units;

  const rows = useMemo<AssetTableRow[]>(() => {
    // Every apartment gets a row, including the ones holding nothing — an empty
    // cell is exactly where a spot is assigned. An apartment_number that exists
    // only on a spot (never in the contacts list) still gets one, so no
    // allocation can be invisible here.
    const names = new Set(apartments);
    for (const s of spots) if (s.apartment_number) names.add(s.apartment_number);
    for (const u of units) if (u.apartment_number) names.add(u.apartment_number);

    const out: AssetTableRow[] = [...names].sort(byApartment).map((name) => ({
      key: `apt-${name}`,
      label: name,
      kind: 'apartment' as const,
      editable: canEdit,
      parking: parkingItems(spots.filter((s) => s.apartment_number === name)),
      storage: storageItems(units.filter((u) => u.apartment_number === name)),
    }));

    for (const kind of ['developer', 'committee'] as const) {
      out.push({
        key: kind,
        label: OWNER_TYPE_LABEL[kind],
        kind,
        editable: false,
        parking: parkingItems(spots.filter((s) => s.owner_type === kind)),
        storage: storageItems(units.filter((u) => u.owner_type === kind)),
      });
    }
    return out;
  }, [apartments, spots, units, canEdit]);

  const visible = useMemo(() => {
    const q = search.trim();
    if (!q) return rows;
    return rows.filter((r) =>
      r.label.includes(q)
      || r.parking.some((i) => i.number.includes(q))
      || r.storage.some((i) => i.number.includes(q)),
    );
  }, [rows, search]);

  // ── saving one cell ────────────────────────────────────────────────────────

  const saveParkingCell = useCallback(async (
    row: AssetTableRow, draft: CellItem[], approved: Set<string>,
  ): Promise<CellSaveResult> => {
    const owner = apartmentOwner(row.label);
    let working = spotsRef.current;
    const byId = new Map(working.map((s) => [s.id, s]));
    const occupancy = parkingOccupancyOf(working);
    const numberOf = (item: CellItem) => String(Number(item.number.trim()));

    const asRows: ParkingRow[] = draft.map((it) => ({
      ...blankParkingRow(it.key), spot_number: it.number,
    }));
    for (const r of asRows) {
      const err = parkingNumberError(r, asRows);
      if (err) return { status: 'error', message: err };
    }

    for (const it of draft) {
      const holder = occupancy.get(numberOf(it));
      if (!holder || holder.id === it.id) continue;
      // Renaming a spot onto a number someone else holds is not a transfer —
      // it would leave two rows claiming one number. Only a number TYPED into
      // this cell moves its row here, and only after the user says so.
      if (it.id !== null) return { status: 'error', message: parkingConflictMessage('parking', holder) };
      if (!approved.has(it.key)) {
        return { status: 'confirm', itemKey: it.key, question: parkingClaimQuestion('parking', holder) };
      }
    }

    const keep = new Set<string>();
    for (const it of draft) {
      const id = it.id ?? occupancy.get(numberOf(it))?.id;
      if (id) keep.add(id);
    }

    try {
      // Released first: a number leaving this cell frees itself before anything
      // tries to take it.
      for (const spot of working.filter((s) => s.apartment_number === row.label && !keep.has(s.id))) {
        const saved = await saveParkingRow(parkingRowOf(spot), RELEASED_OWNER);
        working = replaceById(working, saved);
        setSpots(working);
      }

      for (const it of draft) {
        const number = numberOf(it);
        const targetId = it.id ?? occupancy.get(number)?.id ?? null;
        const base = targetId ? byId.get(targetId) ?? null : null;
        // `double === null` means the user never touched the toggle: a number
        // that turns out to be an existing spot keeps the shape it already has.
        const size: ParkingSizeType = it.double === null
          ? base?.size_type ?? 'single'
          : (it.double ? 'double_width' : 'single');

        if (base && String(base.spot_number) === number && base.size_type === size
            && base.owner_type === owner.owner_type && base.apartment_number === owner.apartment_number) {
          continue; // nothing moved — no PATCH
        }

        const toSave: ParkingRow = base
          ? { ...parkingRowOf(base), spot_number: number, size_type: size }
          : { ...blankParkingRow(it.key), spot_number: number, size_type: size };
        const saved = await saveParkingRow(toSave, owner);
        working = replaceById(working, saved);
        setSpots(working);
      }
    } catch (err) {
      return { status: 'error', message: (err as Error).message };
    }
    return { status: 'ok' };
  }, []);

  const saveStorageCell = useCallback(async (
    row: AssetTableRow, draft: CellItem[], approved: Set<string>,
  ): Promise<CellSaveResult> => {
    const owner = apartmentOwner(row.label);
    let working = unitsRef.current;
    const byId = new Map(working.map((u) => [u.id, u]));
    const occupancy = storageOccupancyOf(working);
    const numberOf = (item: CellItem) => item.number.trim();

    const asRows: StorageRow[] = draft.map((it) => ({
      ...blankStorageRow(it.key), unit_number: it.number,
    }));
    for (const r of asRows) {
      const err = storageNumberError(r, asRows);
      if (err) return { status: 'error', message: err };
    }

    for (const it of draft) {
      const holder = occupancy.get(numberOf(it));
      if (!holder || holder.id === it.id) continue;
      if (it.id !== null) return { status: 'error', message: parkingConflictMessage('storage', holder) };
      if (!approved.has(it.key)) {
        return { status: 'confirm', itemKey: it.key, question: parkingClaimQuestion('storage', holder) };
      }
    }

    const keep = new Set<string>();
    for (const it of draft) {
      const id = it.id ?? occupancy.get(numberOf(it))?.id;
      if (id) keep.add(id);
    }

    try {
      for (const unit of working.filter((u) => u.apartment_number === row.label && !keep.has(u.id))) {
        const saved = await saveStorageRow(storageRowOf(unit), RELEASED_OWNER);
        working = replaceById(working, saved);
        setUnits(working);
      }

      for (const it of draft) {
        const number = numberOf(it);
        const targetId = it.id ?? occupancy.get(number)?.id ?? null;
        const base = targetId ? byId.get(targetId) ?? null : null;

        if (base && base.unit_number === number
            && base.owner_type === owner.owner_type && base.apartment_number === owner.apartment_number) {
          continue;
        }

        const toSave: StorageRow = base
          ? { ...storageRowOf(base), unit_number: number }
          : { ...blankStorageRow(it.key), unit_number: number };
        const saved = await saveStorageRow(toSave, owner);
        working = replaceById(working, saved);
        setUnits(working);
      }
    } catch (err) {
      return { status: 'error', message: (err as Error).message };
    }
    return { status: 'ok' };
  }, []);

  const onSave = useCallback((
    row: AssetTableRow, kind: 'parking' | 'storage', draft: CellItem[], approved: Set<string>,
  ) => (kind === 'parking' ? saveParkingCell(row, draft, approved) : saveStorageCell(row, draft, approved)),
  [saveParkingCell, saveStorageCell]);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-extrabold text-slate-900">חניות ומחסנים</h1>

      <div className="space-y-3 rounded-lg border bg-card p-4">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400 start-3" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="חיפוש לפי מספר דירה, חניה או מחסן..."
            className="h-10 ps-9"
          />
        </div>

        <AssetsTable
          rows={visible}
          editing={editing}
          onOpen={(rowKey, kind) => setEditing({ rowKey, kind })}
          // Closing is scoped to the cell that asked: a save that lands after
          // the user has already clicked into another cell must not shut it.
          onClose={(rowKey) => setEditing((cur) => (cur && cur.rowKey === rowKey ? null : cur))}
          onSave={onSave}
        />
      </div>
    </div>
  );
}
