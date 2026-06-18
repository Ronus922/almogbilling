'use client';

// Shared optional "target" (יעד) picker for tasks & issues. A type toggle
// (דירה / איזור — none selected by default) + a searchable Combobox whose
// options depend on the chosen type. Loads its options once from /api/targets.

import { useEffect, useState, type ComponentType } from 'react';
import { Home, MapPin } from 'lucide-react';
import { Label } from '@/components/ui/label';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { cn } from '@/lib/utils';
import { areaTypeLabel } from '@/lib/constants/areas';
import type { TargetType, RoomTarget, AreaTarget } from '@/lib/types/targets';

interface TargetValue {
  type: TargetType | null;
  id: string | null;
}

interface Props {
  value: TargetValue;
  onChange: (v: TargetValue) => void;
  disabled?: boolean;
}

export function TargetField({ value, onChange, disabled = false }: Props) {
  const [rooms, setRooms] = useState<RoomTarget[]>([]);
  const [areas, setAreas] = useState<AreaTarget[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    void (async () => {
      setLoading(true);
      try {
        const r = await fetch('/api/targets', { credentials: 'include' });
        if (!r.ok) throw new Error('failed');
        const data = (await r.json()) as { rooms?: RoomTarget[]; areas?: AreaTarget[] };
        if (!alive) return;
        setRooms(Array.isArray(data.rooms) ? data.rooms : []);
        setAreas(Array.isArray(data.areas) ? data.areas : []);
      } catch {
        if (alive) { setRooms([]); setAreas([]); }
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  function selectType(type: TargetType) {
    // Click the active type again → clear. Switch type → reset the chosen value.
    if (value.type === type) onChange({ type: null, id: null });
    else onChange({ type, id: null });
  }

  const roomOptions: ComboboxOption[] = rooms.map((r) => ({
    value: r.id,
    label: `דירה ${r.apartment_number}${r.owner_name ? ` — ${r.owner_name}` : ''}`,
    keywords: `${r.apartment_number} ${r.owner_name ?? ''}`,
  }));
  const areaOptions: ComboboxOption[] = areas.map((a) => ({
    value: a.id,
    label: a.name,
    keywords: a.name,
    trailing: (
      <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">
        {areaTypeLabel(a.area_type)}
      </span>
    ),
  }));

  const options =
    value.type === 'room' ? roomOptions : value.type === 'area' ? areaOptions : [];

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <Label className="text-base font-medium text-muted-foreground">יעד (אופציונלי)</Label>
        {(value.type || value.id) && !disabled && (
          <button
            type="button"
            onClick={() => onChange({ type: null, id: null })}
            className="text-xs font-medium text-slate-400 transition-colors hover:text-slate-600"
          >
            נקה
          </button>
        )}
      </div>

      {/* Type selector — 2 options, none selected by default (mobile-first, DESIGN §19) */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <TypeButton active={value.type === 'room'} icon={Home} label="דירה" onClick={() => selectType('room')} disabled={disabled} />
        <TypeButton active={value.type === 'area'} icon={MapPin} label="איזור" onClick={() => selectType('area')} disabled={disabled} />
      </div>

      {/* Value combobox — only once a type is chosen */}
      {value.type && (
        <Combobox
          value={value.id}
          onChange={(id) => onChange({ type: value.type, id })}
          options={options}
          placeholder={value.type === 'room' ? 'בחר דירה' : 'בחר איזור'}
          searchPlaceholder="חיפוש..."
          emptyText={loading ? 'טוען…' : 'לא נמצאו תוצאות'}
          fallbackLabel={loading ? 'טוען…' : undefined}
          disabled={disabled}
        />
      )}
    </div>
  );
}

function TypeButton({
  active, icon: Icon, label, onClick, disabled,
}: {
  active: boolean;
  icon: ComponentType<{ className?: string }>;
  label: string;
  onClick: () => void;
  disabled: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={cn(
        'flex items-center justify-center gap-2 rounded-lg border px-4 py-2.5 text-sm font-medium transition-colors',
        active
          ? 'border-blue-500 bg-blue-50 text-blue-700'
          : 'border-slate-200 bg-slate-50/50 text-slate-600 hover:bg-slate-50',
        disabled && 'cursor-not-allowed opacity-60',
      )}
    >
      <Icon className="h-4 w-4" />
      {label}
    </button>
  );
}
