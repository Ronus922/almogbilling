'use client';

import { DoorClosed, Trees, MapPin, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { areaTypeLabel, AREA_NO_COLOR } from '@/lib/constants/areas';
import type { Area, AreaType } from '@/lib/types/areas';

interface Props {
  rows: Area[];
  loading: boolean;
  canEdit: boolean;
  canDelete: boolean;
  onEdit: (area: Area) => void;
  onDelete: (area: Area) => void;
  onCreate: () => void;
}

export function AreaCards({ rows, loading, canEdit, canDelete, onEdit, onDelete, onCreate }: Props) {
  if (loading) {
    return (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-28 rounded-xl bg-muted/60 animate-pulse" />
        ))}
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-slate-300 bg-card p-12 text-center">
        <span className="grid h-14 w-14 place-items-center rounded-full bg-blue-50 text-blue-600">
          <MapPin className="h-7 w-7" />
        </span>
        <div className="space-y-1">
          <p className="text-base font-semibold text-slate-900">עדיין אין אזורים</p>
          <p className="text-sm text-muted-foreground">
            הגדירו את האזורים בבניין — חדרים סגורים ומרחבים פתוחים — כדי לנהל אותם במקום אחד.
          </p>
        </div>
        {canEdit && (
          <Button type="button" onClick={onCreate} className="mt-1 gap-2">
            <Plus className="h-4 w-4" />
            הוספת אזור ראשון
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {rows.map((a) => (
        <AreaCard
          key={a.id}
          area={a}
          canEdit={canEdit}
          canDelete={canDelete}
          onEdit={onEdit}
          onDelete={onDelete}
        />
      ))}
    </div>
  );
}

function AreaCard({
  area, canEdit, canDelete, onEdit, onDelete,
}: {
  area: Area;
  canEdit: boolean;
  canDelete: boolean;
  onEdit: (a: Area) => void;
  onDelete: (a: Area) => void;
}) {
  const stripe = area.color || AREA_NO_COLOR;

  return (
    <div
      className="group relative overflow-hidden rounded-xl border border-s-4 border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-colors hover:bg-slate-50"
      style={{ borderInlineStartColor: stripe }}
    >
      {/* Full-card click target (edit). Sits behind the content; the action
          cluster re-enables pointer events so it never nests buttons. */}
      <button
        type="button"
        onClick={() => onEdit(area)}
        aria-label={`עריכת האזור ${area.name}`}
        className="absolute inset-0 z-0 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
      />

      <div className="pointer-events-none relative z-10 p-4">
        <div className="flex items-start justify-between gap-2">
          <h3 className="min-w-0 flex-1 truncate text-base font-bold text-slate-900">{area.name}</h3>
          <div className="pointer-events-auto flex items-center gap-1.5">
            <TypeBadge type={area.area_type} />
            {canDelete && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label="מחיקה"
                      onClick={(e) => { e.stopPropagation(); onDelete(area); }}
                      className="grid h-8 w-8 place-items-center rounded-md text-slate-300 transition-colors hover:bg-rose-50 hover:text-rose-600"
                    />
                  }
                >
                  <Trash2 className="h-4 w-4" />
                </TooltipTrigger>
                <TooltipContent>מחיקה</TooltipContent>
              </Tooltip>
            )}
          </div>
        </div>

        {area.description ? (
          <p className="mt-1.5 line-clamp-2 text-sm text-slate-600">{area.description}</p>
        ) : (
          <p className="mt-1.5 text-sm text-slate-400">ללא תיאור</p>
        )}
      </div>
    </div>
  );
}

const TYPE_STYLE: Record<AreaType, { tone: string; Icon: typeof DoorClosed }> = {
  closed_room: { tone: 'bg-slate-100 text-slate-700', Icon: DoorClosed },
  open_space: { tone: 'bg-emerald-100 text-emerald-700', Icon: Trees },
};

function TypeBadge({ type }: { type: AreaType }) {
  const { tone, Icon } = TYPE_STYLE[type];
  return (
    <span className={cn('inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold', tone)}>
      <Icon className="h-3.5 w-3.5" />
      {areaTypeLabel(type)}
    </span>
  );
}
