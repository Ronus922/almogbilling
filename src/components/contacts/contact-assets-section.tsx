'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ExternalLink, Package, Plus, SquareParking, Trash2 } from 'lucide-react';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Field } from '@/components/side-panel/Field';
import { Section, SectionHint } from '@/components/side-panel/Section';
import { DeactivateDialog } from '@/components/parking/DeactivateDialog';
import { parkingConflictMessage } from '@/lib/parking/conflictMessage';
import { parkingErrorMessage } from '@/lib/validation/parking';
import {
  DEFAULT_LOT_CODE, PARKING_SIZE_TYPES, SIZE_TYPE_LABEL,
  SPOT_NUMBER_MAX, SPOT_NUMBER_MIN, STORAGE_UNIT_NUMBER_MAX,
} from '@/lib/constants/parking';
import type {
  ParkingSaleStatus, ParkingSizeType, ParkingSpot, StorageUnit,
} from '@/lib/types/parking';

// "חניות ומחסנים" inside the tenant form.
//
// The contacts table gains NO columns for this. Rows here are rows of
// public.parking_spots / public.storage_units, linked by apartment_number and
// written through the parking module's own API — the same endpoints, guards and
// validation the /parking screen uses. This section is a second door onto that
// data, never a second copy of it.
//
// Three rules the parking module imposes and this section inherits:
//   • Removing a row is toggle-active with a reason, never DELETE. A physical
//     spot does not stop existing because a tenant form stopped listing it.
//   • PATCH is a WHOLE-OBJECT save, so fields this form does not show
//     (sale_status, notes) are carried on the row and written back untouched.
//   • A taken number is reported inline, on the row, naming who holds it —
//     a toast would vanish and leave the user staring at a valid-looking field.

// ── row model ────────────────────────────────────────────────────────────────

interface ParkingRow {
  /** Client-only stable React key. */
  key: string;
  /** null → not saved yet (POST); otherwise PATCH. */
  id: string | null;
  lot_code: string;
  spot_number: string;
  size_type: ParkingSizeType;
  /** Not edited here — preserved so the whole-object PATCH cannot erase them. */
  sale_status: ParkingSaleStatus;
  notes: string | null;
}

interface StorageRow {
  key: string;
  id: string | null;
  unit_number: string;
  notes: string | null;
}

/** A saved row the user removed from the form, waiting for Save to switch it off. */
interface PendingRemoval {
  kind: 'parking' | 'storage';
  id: string;
  /** Already phrased: 'חניה 63' / 'מחסן M-4'. */
  subject: string;
  reason: string;
}

/** Who currently holds a number, for the pre-save occupancy check. */
interface Occupant {
  id: string;
  number: string;
  apartment_number: string | null;
  owner_type: string;
}

function parkingRowOf(spot: ParkingSpot): ParkingRow {
  return {
    key: `saved-p-${spot.id}`,
    id: spot.id,
    lot_code: spot.lot_code,
    spot_number: String(spot.spot_number),
    size_type: spot.size_type,
    sale_status: spot.sale_status,
    notes: spot.notes,
  };
}

function storageRowOf(unit: StorageUnit): StorageRow {
  return {
    key: `saved-s-${unit.id}`,
    id: unit.id,
    unit_number: unit.unit_number,
    notes: unit.notes,
  };
}

/** Stable serialisation for the dirty check — the client-only `key` is excluded. */
function snapshot(parking: ParkingRow[], storage: StorageRow[]): string {
  return JSON.stringify({
    p: parking.map((r) => [r.id, r.lot_code, r.spot_number.trim(), r.size_type]),
    s: storage.map((r) => [r.id, r.unit_number.trim()]),
  });
}

// ── validation (mirrors lib/validation/parking.ts, plus occupancy) ───────────

function parkingRowError(
  row: ParkingRow, rows: ParkingRow[], occupancy: Map<string, Occupant>,
): string | null {
  const raw = row.spot_number.trim();
  if (!raw) return parkingErrorMessage('spot_number_required');
  const n = Number(raw);
  if (!Number.isInteger(n)) return parkingErrorMessage('spot_number_invalid');
  if (n < SPOT_NUMBER_MIN || n > SPOT_NUMBER_MAX) {
    return parkingErrorMessage('spot_number_out_of_range');
  }
  if (rows.some((o) => o.key !== row.key && Number(o.spot_number.trim()) === n)) {
    return 'מספר החניה מופיע פעמיים בטופס';
  }
  const holder = occupancy.get(String(n));
  if (holder && holder.id !== row.id) return parkingConflictMessage('parking', holder);
  return null;
}

function storageRowError(
  row: StorageRow, rows: StorageRow[], occupancy: Map<string, Occupant>,
): string | null {
  const raw = row.unit_number.trim();
  if (!raw) return parkingErrorMessage('unit_number_required');
  if (raw.length > STORAGE_UNIT_NUMBER_MAX) return parkingErrorMessage('unit_number_too_long');
  if (rows.some((o) => o.key !== row.key && o.unit_number.trim() === raw)) {
    return 'מספר המחסן מופיע פעמיים בטופס';
  }
  const holder = occupancy.get(raw);
  if (holder && holder.id !== row.id) return parkingConflictMessage('storage', holder);
  return null;
}

// ── network ──────────────────────────────────────────────────────────────────

interface ApiFailure {
  error?: string;
  code?: string;
}

/** POST/PATCH one asset. Throws with the server's Hebrew sentence, which for a
 *  409 already names the holder — so the row can show it verbatim. */
async function write<T>(url: string, method: 'POST' | 'PATCH', body: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T & ApiFailure;
  if (!res.ok) throw new Error(data.error ?? 'שמירת השיוך נכשלה');
  return data;
}

// ── the hook ─────────────────────────────────────────────────────────────────

export interface ContactAssetsState {
  loading: boolean;
  loadError: string | null;
  parking: ParkingRow[];
  storage: StorageRow[];
  removals: PendingRemoval[];
  errorForParking: (key: string) => string | null;
  errorForStorage: (key: string) => string | null;
  /** True when anything here differs from what was loaded. */
  dirty: boolean;
  /** True when at least one row is invalid — Save must stay disabled. */
  blocking: boolean;
  addParking: () => void;
  updateParking: (key: string, patch: Partial<Omit<ParkingRow, 'key' | 'id'>>) => void;
  addStorage: () => void;
  updateStorage: (key: string, patch: Partial<Omit<StorageRow, 'key' | 'id'>>) => void;
  /** Drops an unsaved row outright; stages a saved one for toggle-active. */
  dropParking: (key: string, reason: string) => void;
  dropStorage: (key: string, reason: string) => void;
  /**
   * Apply everything to the parking API, in order: removals, then parking, then
   * storage. Rows are updated in place as each request succeeds, so a failure
   * leaves exactly the outstanding work behind and a retry is safe. Throws the
   * first failure after committing that partial progress.
   */
  flush: (apartmentNumber: string) => Promise<void>;
}

export function useContactAssets({
  open, enabled, apartmentNumber, isEdit,
}: {
  open: boolean;
  /** parking:view — when false nothing loads and nothing renders. */
  enabled: boolean;
  apartmentNumber: string;
  isEdit: boolean;
}): ContactAssetsState {
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [parking, setParking] = useState<ParkingRow[]>([]);
  const [storage, setStorage] = useState<StorageRow[]>([]);
  const [removals, setRemovals] = useState<PendingRemoval[]>([]);
  const [initial, setInitial] = useState<string>(snapshot([], []));
  const [parkingOccupancy, setParkingOccupancy] = useState<Map<string, Occupant>>(new Map());
  const [storageOccupancy, setStorageOccupancy] = useState<Map<string, Occupant>>(new Map());
  /** Errors the SERVER produced, keyed by row key. Cleared when the row changes. */
  const [serverErrors, setServerErrors] = useState<Map<string, string>>(new Map());
  const rowSeq = useRef(0);
  /**
   * The rows as last agreed with the server — what was loaded, plus whatever a
   * flush has since written. flush() diffs against THIS to decide which saved
   * rows still need a PATCH. It cannot diff against live state: that already
   * contains the user's edit, so every row would compare equal and every edit
   * to an existing spot would be silently dropped.
   */
  const baselineRef = useRef<{ parking: ParkingRow[]; storage: StorageRow[] }>({
    parking: [], storage: [],
  });

  // The apartment whose rows are loaded. In create mode the number is still
  // being typed, so the load is skipped entirely — a new apartment holds nothing.
  const loadedApartment = isEdit ? apartmentNumber : '';

  useEffect(() => {
    if (!open || !enabled) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    (async () => {
      try {
        // The whole lot, INCLUDING deactivated spots: a parking number is unique
        // per lot regardless of is_active (a painted number on a floor does not
        // free up when the spot is unassigned). Storage is the opposite — a
        // released unit number is genuinely re-issuable — so actives only.
        const [pRes, sRes] = await Promise.all([
          fetch(`/api/parking?lot_code=${encodeURIComponent(DEFAULT_LOT_CODE)}&include_inactive=1`,
            { credentials: 'include' }),
          fetch('/api/storage', { credentials: 'include' }),
        ]);
        if (!pRes.ok || !sRes.ok) throw new Error('טעינת החניות והמחסנים נכשלה');
        const [pData, sData] = await Promise.all([
          pRes.json() as Promise<{ spots?: ParkingSpot[] }>,
          sRes.json() as Promise<{ units?: StorageUnit[] }>,
        ]);
        if (cancelled) return;

        const spots = Array.isArray(pData.spots) ? pData.spots : [];
        const units = Array.isArray(sData.units) ? sData.units : [];

        setParkingOccupancy(new Map(spots.map((s) => [String(s.spot_number), {
          id: s.id, number: String(s.spot_number),
          apartment_number: s.apartment_number, owner_type: s.owner_type,
        }])));
        setStorageOccupancy(new Map(units.map((u) => [u.unit_number, {
          id: u.id, number: u.unit_number,
          apartment_number: u.apartment_number, owner_type: u.owner_type,
        }])));

        // Only ACTIVE rows are listed: a deactivated spot is not part of the
        // apartment's live allocation, and showing it would invite a "removal"
        // of something already removed.
        const mine = loadedApartment
          ? spots.filter((s) => s.is_active && s.apartment_number === loadedApartment).map(parkingRowOf)
          : [];
        const myUnits = loadedApartment
          ? units.filter((u) => u.apartment_number === loadedApartment).map(storageRowOf)
          : [];
        setParking(mine);
        setStorage(myUnits);
        setRemovals([]);
        setServerErrors(new Map());
        setInitial(snapshot(mine, myUnits));
        baselineRef.current = { parking: mine, storage: myUnits };
      } catch (e) {
        if (!cancelled) setLoadError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open, enabled, loadedApartment]);

  function clearServerError(key: string) {
    setServerErrors((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Map(prev);
      next.delete(key);
      return next;
    });
  }

  const addParking = useCallback(() => {
    rowSeq.current += 1;
    setParking((prev) => [...prev, {
      key: `new-p-${rowSeq.current}`,
      id: null,
      lot_code: DEFAULT_LOT_CODE,
      spot_number: '',
      size_type: 'single',
      sale_status: 'none',
      notes: null,
    }]);
  }, []);

  const addStorage = useCallback(() => {
    rowSeq.current += 1;
    setStorage((prev) => [...prev, {
      key: `new-s-${rowSeq.current}`, id: null, unit_number: '', notes: null,
    }]);
  }, []);

  function updateParking(key: string, patch: Partial<Omit<ParkingRow, 'key' | 'id'>>) {
    clearServerError(key);
    setParking((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  function updateStorage(key: string, patch: Partial<Omit<StorageRow, 'key' | 'id'>>) {
    clearServerError(key);
    setStorage((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  // Both drops read the row from current state rather than from inside the
  // setState updater: an updater must be pure, and queueing setRemovals inside
  // one would stage the removal twice under StrictMode's double invocation.
  function dropParking(key: string, reason: string) {
    clearServerError(key);
    const row = parking.find((r) => r.key === key);
    if (!row) return;
    if (row.id) {
      setRemovals((rs) => [...rs, {
        kind: 'parking', id: row.id as string,
        subject: `חניה ${row.spot_number.trim()}`, reason,
      }]);
    }
    setParking((prev) => prev.filter((r) => r.key !== key));
  }

  function dropStorage(key: string, reason: string) {
    clearServerError(key);
    const row = storage.find((r) => r.key === key);
    if (!row) return;
    if (row.id) {
      setRemovals((rs) => [...rs, {
        kind: 'storage', id: row.id as string,
        subject: `מחסן ${row.unit_number.trim()}`, reason,
      }]);
    }
    setStorage((prev) => prev.filter((r) => r.key !== key));
  }

  const parkingErrors = useMemo(() => {
    const m = new Map<string, string>();
    for (const row of parking) {
      const e = parkingRowError(row, parking, parkingOccupancy);
      if (e) m.set(row.key, e);
    }
    return m;
  }, [parking, parkingOccupancy]);

  const storageErrors = useMemo(() => {
    const m = new Map<string, string>();
    for (const row of storage) {
      const e = storageRowError(row, storage, storageOccupancy);
      if (e) m.set(row.key, e);
    }
    return m;
  }, [storage, storageOccupancy]);

  const errorForParking = useCallback(
    (key: string) => serverErrors.get(key) ?? parkingErrors.get(key) ?? null,
    [serverErrors, parkingErrors],
  );
  const errorForStorage = useCallback(
    (key: string) => serverErrors.get(key) ?? storageErrors.get(key) ?? null,
    [serverErrors, storageErrors],
  );

  const dirty = removals.length > 0 || snapshot(parking, storage) !== initial;
  const blocking = parkingErrors.size > 0 || storageErrors.size > 0;

  // flush() reads through a ref so it does not need to be re-created on every
  // keystroke — the panel holds it across a whole editing session.
  const stateRef = useRef({ parking, storage, removals, initial });
  useEffect(() => {
    stateRef.current = { parking, storage, removals, initial };
  }, [parking, storage, removals, initial]);

  const flush = useCallback(async (apartment: string) => {
    const start = stateRef.current;
    const pendingRemovals = [...start.removals];
    const parkingRows = [...start.parking];
    const storageRows = [...start.storage];
    const failures = new Map<string, string>();
    let failure: Error | null = null;

    try {
      // Removals first: freeing a storage number is what makes it re-issuable
      // to a row further down this same save.
      while (pendingRemovals.length > 0) {
        const r = pendingRemovals[0];
        const base = r.kind === 'parking' ? '/api/parking' : '/api/storage';
        await write(`${base}/${r.id}/toggle-active`, 'POST', { is_active: false, reason: r.reason });
        pendingRemovals.shift();
      }

      const savedParking = new Map(
        baselineRef.current.parking.filter((r) => r.id).map((r) => [r.id as string, r]),
      );

      for (let i = 0; i < parkingRows.length; i += 1) {
        const row = parkingRows[i];
        const body = {
          lot_code: row.lot_code,
          spot_number: Number(row.spot_number.trim()),
          size_type: row.size_type,
          owner_type: 'apartment',
          apartment_number: apartment,
          sale_status: row.sale_status,
          notes: row.notes,
        };
        try {
          if (row.id === null) {
            const { spot } = await write<{ spot: ParkingSpot }>('/api/parking', 'POST', body);
            parkingRows[i] = { ...parkingRowOf(spot), key: row.key };
          } else if (JSON.stringify(savedParking.get(row.id)) !== JSON.stringify(row)) {
            const { spot } = await write<{ spot: ParkingSpot }>(`/api/parking/${row.id}`, 'PATCH', body);
            parkingRows[i] = { ...parkingRowOf(spot), key: row.key };
          }
        } catch (e) {
          failures.set(row.key, (e as Error).message);
          throw e;
        }
      }

      const savedStorage = new Map(
        baselineRef.current.storage.filter((r) => r.id).map((r) => [r.id as string, r]),
      );

      for (let i = 0; i < storageRows.length; i += 1) {
        const row = storageRows[i];
        const body = {
          unit_number: row.unit_number.trim(),
          owner_type: 'apartment',
          apartment_number: apartment,
          notes: row.notes,
        };
        try {
          if (row.id === null) {
            const { unit } = await write<{ unit: StorageUnit }>('/api/storage', 'POST', body);
            storageRows[i] = { ...storageRowOf(unit), key: row.key };
          } else if (JSON.stringify(savedStorage.get(row.id)) !== JSON.stringify(row)) {
            const { unit } = await write<{ unit: StorageUnit }>(`/api/storage/${row.id}`, 'PATCH', body);
            storageRows[i] = { ...storageRowOf(unit), key: row.key };
          }
        } catch (e) {
          failures.set(row.key, (e as Error).message);
          throw e;
        }
      }
    } catch (e) {
      failure = e as Error;
    } finally {
      // Commit whatever went through, so a retry re-sends only what did not.
      setRemovals(pendingRemovals);
      setParking(parkingRows);
      setStorage(storageRows);
      setInitial(snapshot(parkingRows, storageRows));
      baselineRef.current = { parking: parkingRows, storage: storageRows };
      if (failures.size > 0) {
        setServerErrors((prev) => new Map([...prev, ...failures]));
      }
    }

    if (failure) throw failure;
  }, []);

  return {
    loading, loadError, parking, storage, removals,
    errorForParking, errorForStorage, dirty, blocking,
    addParking, updateParking, addStorage, updateStorage,
    dropParking, dropStorage, flush,
  };
}

// ── the section ──────────────────────────────────────────────────────────────

/** Which row the removal dialog is pointed at. */
type RemovalTarget =
  | { kind: 'parking'; key: string; subject: string }
  | { kind: 'storage'; key: string; subject: string };

export function ContactAssetsSection({
  assets, apartmentNumber, canEdit, disabled,
}: {
  assets: ContactAssetsState;
  /** '' while a new tenant's number is still being typed. */
  apartmentNumber: string;
  /** parking:edit. False → the rows render read-only. */
  canEdit: boolean;
  /** The panel is saving, or the actor cannot edit at all. */
  disabled: boolean;
}) {
  const [removalTarget, setRemovalTarget] = useState<RemovalTarget | null>(null);
  const ro = disabled || !canEdit;

  // The default reason, used whenever the user does not type one of their own.
  const defaultReason = `הוסר מטופס הדייר ${apartmentNumber || '—'}`;

  function confirmRemoval(reason: string) {
    if (!removalTarget) return;
    const text = reason.trim() || defaultReason;
    if (removalTarget.kind === 'parking') assets.dropParking(removalTarget.key, text);
    else assets.dropStorage(removalTarget.key, text);
    setRemovalTarget(null);
  }

  /** An unsaved row is dropped silently — there is nothing to switch off. */
  function requestRemoval(kind: 'parking' | 'storage', key: string, id: string | null, subject: string) {
    if (id === null) {
      if (kind === 'parking') assets.dropParking(key, '');
      else assets.dropStorage(key, '');
      return;
    }
    setRemovalTarget({ kind, key, subject });
  }

  const totalPlaces = assets.parking.reduce(
    (sum, r) => sum + (r.size_type === 'single' ? 1 : 2), 0,
  );

  return (
    <>
      <Section
        title="חניות ומחסנים"
        icon={SquareParking}
        iconTone="violet"
        subtitle={
          apartmentNumber
            ? 'השיוך נשמר במודול החניות, לא בכרטיס הדייר. הסרת שורה מבטלת את ההצמדה — הרשומה עצמה נשמרת בהיסטוריה.'
            : 'הזן מספר דירה כדי לשייך חניות ומחסנים.'
        }
        headerSlot={
          apartmentNumber ? (
            <a
              href={`/parking?apartment=${encodeURIComponent(apartmentNumber)}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-8 items-center gap-1 rounded-lg border border-slate-200 px-3 text-xs font-semibold text-slate-600 transition-colors hover:bg-slate-50 hover:text-slate-900"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              צפה במודול החניות
            </a>
          ) : undefined
        }
      >
        <div className="space-y-5 py-2">
          {assets.loadError && (
            <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-900">
              {assets.loadError}
            </div>
          )}

          {/* Parking */}
          <Section
            bare
            title="חניות"
            icon={SquareParking}
            headerSlot={
              <>
                {assets.parking.length > 0 && (
                  <SectionHint>
                    {assets.parking.length} חניות · {totalPlaces} מקומות
                  </SectionHint>
                )}
                {!ro && apartmentNumber && (
                  <AddRowButton label="הוסף חניה" onClick={assets.addParking} />
                )}
              </>
            }
          >
            {assets.loading ? (
              <RowsPlaceholder text="טוען…" />
            ) : assets.parking.length === 0 ? (
              <RowsPlaceholder text="אין חניות משויכות לדירה זו." />
            ) : (
              <div className="space-y-3">
                {assets.parking.map((row, i) => (
                  <ParkingRowCard
                    key={row.key}
                    row={row}
                    index={i}
                    error={assets.errorForParking(row.key)}
                    disabled={ro}
                    onChange={(patch) => assets.updateParking(row.key, patch)}
                    onRemove={() => requestRemoval(
                      'parking', row.key, row.id,
                      `חניה ${row.spot_number.trim() || ''}`.trim(),
                    )}
                  />
                ))}
              </div>
            )}
          </Section>

          {/* Storage */}
          <Section
            bare
            title="מחסנים"
            icon={Package}
            headerSlot={
              !ro && apartmentNumber
                ? <AddRowButton label="הוסף מחסן" onClick={assets.addStorage} />
                : undefined
            }
          >
            {assets.loading ? (
              <RowsPlaceholder text="טוען…" />
            ) : assets.storage.length === 0 ? (
              <RowsPlaceholder text="אין מחסנים משויכים לדירה זו." />
            ) : (
              <div className="space-y-3">
                {assets.storage.map((row, i) => (
                  <StorageRowCard
                    key={row.key}
                    row={row}
                    index={i}
                    error={assets.errorForStorage(row.key)}
                    disabled={ro}
                    onChange={(patch) => assets.updateStorage(row.key, patch)}
                    onRemove={() => requestRemoval(
                      'storage', row.key, row.id,
                      `מחסן ${row.unit_number.trim() || ''}`.trim(),
                    )}
                  />
                ))}
              </div>
            )}
          </Section>

          {assets.removals.length > 0 && (
            <div className="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
              {assets.removals.length === 1
                ? 'שורה אחת תוסר מהשיוך בשמירה.'
                : `${assets.removals.length} שורות יוסרו מהשיוך בשמירה.`}{' '}
              הרשומות לא נמחקות — הן מסומנות כלא-פעילות עם הסיבה שנרשמה.
            </div>
          )}
        </div>
      </Section>

      <DeactivateDialog
        open={removalTarget !== null}
        subject={removalTarget?.subject ?? ''}
        assignedTo={apartmentNumber ? `דירה ${apartmentNumber}` : null}
        submitting={false}
        defaultReason={defaultReason}
        onCancel={() => setRemovalTarget(null)}
        onConfirm={confirmRemoval}
      />
    </>
  );
}

function AddRowButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-8 items-center gap-1 rounded-lg bg-blue-600 px-3 text-xs font-semibold text-white transition-colors hover:bg-blue-700"
    >
      <Plus className="h-3.5 w-3.5" /> {label}
    </button>
  );
}

function RowsPlaceholder({ text }: { text: string }) {
  return (
    <div className="rounded-lg border border-dashed border-slate-200 p-3 text-sm text-slate-500">
      {text}
    </div>
  );
}

function RemoveRowButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-slate-400 transition-colors hover:bg-rose-50 hover:text-rose-600"
    >
      <Trash2 className="h-4 w-4" />
    </button>
  );
}

function ParkingRowCard({
  row, index, error, disabled, onChange, onRemove,
}: {
  row: ParkingRow;
  index: number;
  error: string | null;
  disabled: boolean;
  onChange: (patch: Partial<Omit<ParkingRow, 'key' | 'id'>>) => void;
  onRemove: () => void;
}) {
  const idBase = `contact-parking-${index}`;
  // A double spot is ONE row whose size_type says how it doubles. The checkbox
  // is the plain-language version of that ("is this a double?"); the select
  // behind it only appears once the answer is yes, because 'רגילה' is not a
  // kind of doubling and would read as a third option.
  const isDouble = row.size_type !== 'single';
  const doubleTypes = PARKING_SIZE_TYPES.filter((t) => t !== 'single');

  return (
    <div className="space-y-4 rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <Field
            id={`${idBase}-number`}
            label="מספר חניה"
            required
            value={row.spot_number}
            onChange={(v) => onChange({ spot_number: v })}
            error={error}
            disabled={disabled}
            dir="ltr"
            tabularNums
            inputMode="numeric"
            placeholder="63"
            hint={`חניון ${row.lot_code}`}
          />
        </div>
        {!disabled && <RemoveRowButton label="הסר חניה" onClick={onRemove} />}
      </div>

      <div className="flex items-center gap-2">
        <Checkbox
          id={`${idBase}-double`}
          checked={isDouble}
          onCheckedChange={(v) => onChange({ size_type: v === true ? 'double_width' : 'single' })}
          disabled={disabled}
        />
        <Label htmlFor={`${idBase}-double`} className="cursor-pointer text-sm font-medium text-slate-700">
          חניה כפולה (נספרת כ-2 מקומות)
        </Label>
      </div>

      {isDouble && (
        <div className="space-y-2">
          <Label className="text-base font-medium text-muted-foreground">סוג הכפילות</Label>
          <Select
            value={row.size_type}
            onValueChange={(v) => { if (v) onChange({ size_type: v as ParkingSizeType }); }}
            disabled={disabled}
          >
            <SelectTrigger className="w-full data-[size=default]:h-10">
              <SelectValue placeholder="בחר סוג...">
                {(value: string | null) =>
                  value ? SIZE_TYPE_LABEL[value as ParkingSizeType] ?? value : null}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {doubleTypes.map((t) => (
                <SelectItem key={t} value={t}>{SIZE_TYPE_LABEL[t]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
    </div>
  );
}

function StorageRowCard({
  row, index, error, disabled, onChange, onRemove,
}: {
  row: StorageRow;
  index: number;
  error: string | null;
  disabled: boolean;
  onChange: (patch: Partial<Omit<StorageRow, 'key' | 'id'>>) => void;
  onRemove: () => void;
}) {
  const idBase = `contact-storage-${index}`;
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <Field
            id={`${idBase}-number`}
            label="מספר מחסן"
            required
            value={row.unit_number}
            onChange={(v) => onChange({ unit_number: v })}
            error={error}
            disabled={disabled}
            dir="ltr"
            placeholder="M-4"
          />
        </div>
        {!disabled && <RemoveRowButton label="הסר מחסן" onClick={onRemove} />}
      </div>
    </div>
  );
}
