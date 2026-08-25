'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Package, Plus, SquareParking, Trash2 } from 'lucide-react';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Field } from '@/components/side-panel/Field';
import { Section } from '@/components/side-panel/Section';
import {
  apartmentOwner, blankParkingRow, blankStorageRow, fetchAssetIndex,
  parkingRowError, parkingRowOf, RELEASED_OWNER, rowChanged, rowsSnapshot,
  saveParkingRow, saveStorageRow, storageRowError, storageRowOf,
  type Occupant, type ParkingRow, type StorageRow,
} from '@/lib/parking/assetRows';

// "חניות ומחסנים" inside the tenant form.
//
// The contacts table gains NO columns for this. Rows here are rows of
// public.parking_spots / public.storage_units, linked by apartment_number and
// written through /api/parking and /api/storage — the same endpoints, guards
// and validation any other caller gets. This section is a second door onto that
// data, never a second copy of it.
//
// The row model, the validation, the occupancy check and the writes all live in
// lib/parking/assetRows.ts, shared with the /parking table — the two surfaces
// must agree on every rule that decides whether a number is legal. What stays
// here is the part that is genuinely this surface's own: a panel that loads one
// apartment, accumulates edits, and commits them when the tenant is saved.

/**
 * A saved row the user removed from the form, waiting for Save. Both kinds are
 * the same operation — a save pointed at RELEASED_OWNER — so the row travels
 * with it: that whole-object PATCH must not drop size_type, sale_status or
 * notes on the way through.
 */
type PendingRelease =
  | { kind: 'parking'; id: string; row: ParkingRow }
  | { kind: 'storage'; id: string; row: StorageRow };

// ── the hook ─────────────────────────────────────────────────────────────────

export interface ContactAssetsState {
  loading: boolean;
  loadError: string | null;
  parking: ParkingRow[];
  storage: StorageRow[];
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
  /** Drops an unsaved row outright; stages a saved one for release to חו״כ. */
  dropParking: (key: string) => void;
  dropStorage: (key: string) => void;
  /**
   * Apply everything to the parking API, in order: releases, then parking, then
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
  const [releases, setReleases] = useState<PendingRelease[]>([]);
  const [initial, setInitial] = useState<string>(rowsSnapshot([], []));
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
        const index = await fetchAssetIndex();
        if (cancelled) return;
        const { spots, units } = index;

        setParkingOccupancy(index.parkingOccupancy);
        setStorageOccupancy(index.storageOccupancy);

        const mine = loadedApartment
          ? spots.filter((s) => s.apartment_number === loadedApartment).map(parkingRowOf)
          : [];
        const myUnits = loadedApartment
          ? units.filter((u) => u.apartment_number === loadedApartment).map(storageRowOf)
          : [];
        setParking(mine);
        setStorage(myUnits);
        setReleases([]);
        setServerErrors(new Map());
        setInitial(rowsSnapshot(mine, myUnits));
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
    setParking((prev) => [...prev, blankParkingRow(`new-p-${rowSeq.current}`)]);
  }, []);

  const addStorage = useCallback(() => {
    rowSeq.current += 1;
    setStorage((prev) => [...prev, blankStorageRow(`new-s-${rowSeq.current}`)]);
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
  // setState updater: an updater must be pure, and queueing setReleases inside
  // one would stage the release twice under StrictMode's double invocation.
  // A row with no id was never saved — there is nothing to release.
  function dropParking(key: string) {
    clearServerError(key);
    const row = parking.find((r) => r.key === key);
    if (!row) return;
    if (row.id) setReleases((rs) => [...rs, { kind: 'parking', id: row.id as string, row }]);
    setParking((prev) => prev.filter((r) => r.key !== key));
  }

  function dropStorage(key: string) {
    clearServerError(key);
    const row = storage.find((r) => r.key === key);
    if (!row) return;
    if (row.id) setReleases((rs) => [...rs, { kind: 'storage', id: row.id as string, row }]);
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

  const dirty = releases.length > 0 || rowsSnapshot(parking, storage) !== initial;
  const blocking = parkingErrors.size > 0 || storageErrors.size > 0;

  // flush() reads through a ref so it does not need to be re-created on every
  // keystroke — the panel holds it across a whole editing session.
  const stateRef = useRef({ parking, storage, releases, initial });
  useEffect(() => {
    stateRef.current = { parking, storage, releases, initial };
  }, [parking, storage, releases, initial]);

  const flush = useCallback(async (apartment: string) => {
    const start = stateRef.current;
    const pendingReleases = [...start.releases];
    const parkingRows = [...start.parking];
    const storageRows = [...start.storage];
    const failures = new Map<string, string>();
    let failure: Error | null = null;

    try {
      // Releases first: a number handed back to חו״כ must be off this
      // apartment before anything further down this same save can claim it.
      while (pendingReleases.length > 0) {
        const r = pendingReleases[0];
        if (r.kind === 'parking') await saveParkingRow(r.row, RELEASED_OWNER);
        else await saveStorageRow(r.row, RELEASED_OWNER);
        pendingReleases.shift();
      }

      const owner = apartmentOwner(apartment);

      const savedParking = new Map(
        baselineRef.current.parking.filter((r) => r.id).map((r) => [r.id as string, r]),
      );
      for (let i = 0; i < parkingRows.length; i += 1) {
        const row = parkingRows[i];
        if (row.id !== null && !rowChanged(savedParking.get(row.id), row)) continue;
        try {
          const spot = await saveParkingRow(row, owner);
          parkingRows[i] = { ...parkingRowOf(spot), key: row.key };
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
        if (row.id !== null && !rowChanged(savedStorage.get(row.id), row)) continue;
        try {
          const unit = await saveStorageRow(row, owner);
          storageRows[i] = { ...storageRowOf(unit), key: row.key };
        } catch (e) {
          failures.set(row.key, (e as Error).message);
          throw e;
        }
      }
    } catch (e) {
      failure = e as Error;
    } finally {
      // Commit whatever went through, so a retry re-sends only what did not.
      setReleases(pendingReleases);
      setParking(parkingRows);
      setStorage(storageRows);
      setInitial(rowsSnapshot(parkingRows, storageRows));
      baselineRef.current = { parking: parkingRows, storage: storageRows };
      if (failures.size > 0) {
        setServerErrors((prev) => new Map([...prev, ...failures]));
      }
    }

    if (failure) throw failure;
  }, []);

  return {
    loading, loadError, parking, storage,
    errorForParking, errorForStorage, dirty, blocking,
    addParking, updateParking, addStorage, updateStorage,
    dropParking, dropStorage, flush,
  };
}

// ── the section ──────────────────────────────────────────────────────────────

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
  const ro = disabled || !canEdit;

  return (
    <Section
      title="חניות ומחסנים"
      icon={SquareParking}
      iconTone="violet"
      subtitle={
        apartmentNumber
          ? 'השיוך נשמר בטבלאות החניות והמחסנים, לא בכרטיס הדייר. הסרת שורה מבטלת את ההצמדה — הרשומה עצמה נשמרת בהיסטוריה.'
          : 'הזן מספר דירה כדי לשייך חניות ומחסנים.'
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
            !ro && apartmentNumber
              ? <AddRowButton label="הוסף חניה" onClick={assets.addParking} />
              : undefined
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
                  onRemove={() => assets.dropParking(row.key)}
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
                  onRemove={() => assets.dropStorage(row.key)}
                />
              ))}
            </div>
          )}
        </Section>

      </div>
    </Section>
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
  // A double spot is ONE row; size_type says HOW it doubles and the DB derives
  // capacity from it. This form asks only whether it is double at all and
  // writes 'double_width'. 'double_length' stays a valid value everywhere else
  // — the DB, the validation layer and the API all still accept it — it simply
  // has no control here, because nobody has needed to record it.
  const isDouble = row.size_type !== 'single';

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
          חניה כפולה
        </Label>
      </div>
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
