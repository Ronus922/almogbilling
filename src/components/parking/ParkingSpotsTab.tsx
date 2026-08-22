'use client';

import { Ban, Pencil, RotateCcw } from 'lucide-react';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { ParkingSpot } from '@/lib/types/parking';
import { InactiveBadge, OwnerBadge, SaleStatusBadge, SizeBadge } from './badges';
import { TableSkeleton, EmptyState } from './shared';

// Tab 1 — every spot, ordered by number (DESIGN.md §9).

interface Props {
  spots: ParkingSpot[];
  loading: boolean;
  canEdit: boolean;
  onEdit: (s: ParkingSpot) => void;
  onToggleActive: (s: ParkingSpot) => void;
  onCreate: () => void;
  /** True when a filter/search is narrowing the list — changes the empty copy
   *  from "nothing exists" to "nothing matched", which are different problems. */
  filtered: boolean;
}

export function ParkingSpotsTab({
  spots, loading, canEdit, onEdit, onToggleActive, onCreate, filtered,
}: Props) {
  if (loading) return <TableSkeleton />;

  if (spots.length === 0) {
    return filtered
      ? <EmptyState title="לא נמצאו חניות התואמות לסינון" hint="נסו לנקות את החיפוש או את הסינון." />
      : (
        <EmptyState
          title="אין עדיין חניות במערכת"
          hint="ניתן להוסיף חניה ידנית, או לייבא את רשימת החניון מקובץ Excel."
          actionLabel={canEdit ? 'חניה חדשה' : undefined}
          onAction={canEdit ? onCreate : undefined}
        />
      );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
      <div className="overflow-x-auto">
        <Table>
          <TableHeader className="[&_tr]:border-b [&_tr]:border-slate-200">
            <TableRow className="bg-slate-50 hover:bg-slate-50">
              <TableHead className="h-11 px-4 text-start text-sm font-semibold text-slate-500">מס׳ חניה</TableHead>
              <TableHead className="h-11 px-4 text-start text-sm font-semibold text-slate-500">שיוך</TableHead>
              <TableHead className="h-11 px-4 text-start text-sm font-semibold text-slate-500">גודל</TableHead>
              <TableHead className="h-11 px-4 text-start text-sm font-semibold text-slate-500">סטטוס</TableHead>
              <TableHead className="h-11 px-4 text-start text-sm font-semibold text-slate-500">הערות</TableHead>
              <TableHead className="h-11 px-4 text-end text-sm font-semibold text-slate-500">פעולות</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {spots.map((s) => (
              <TableRow
                key={s.id}
                onClick={() => onEdit(s)}
                className={cn(
                  'h-12 cursor-pointer border-b border-slate-100 hover:bg-slate-50',
                  !s.is_active && 'opacity-60',
                )}
              >
                <TableCell className="px-4 py-3 text-start text-sm font-bold text-slate-900 tabular-nums">
                  {s.spot_number}
                </TableCell>
                <TableCell className="px-4 py-3 text-start text-sm">
                  <OwnerBadge ownerType={s.owner_type} apartmentNumber={s.apartment_number} />
                </TableCell>
                <TableCell className="px-4 py-3 text-start text-sm">
                  <SizeBadge sizeType={s.size_type} />
                </TableCell>
                <TableCell className="px-4 py-3 text-start text-sm">
                  {s.is_active ? <SaleStatusBadge saleStatus={s.sale_status} /> : <InactiveBadge />}
                </TableCell>
                <TableCell className="max-w-[22rem] px-4 py-3 text-start text-sm text-slate-500">
                  <span className="line-clamp-2">
                    {!s.is_active && s.deactivation_reason
                      ? `סיבת הביטול: ${s.deactivation_reason}`
                      : s.notes ?? ''}
                  </span>
                </TableCell>
                <TableCell
                  className="px-4 py-3 text-end"
                  onClick={(e) => e.stopPropagation()}
                >
                  {canEdit && (
                    <div className="flex items-center justify-end gap-1">
                      <Tooltip>
                        <TooltipTrigger render={<span className="block" />}>
                          <Button
                            type="button" variant="ghost" size="icon"
                            aria-label="ערוך חניה"
                            onClick={() => onEdit(s)}
                          >
                            <Pencil className="h-4 w-4 text-slate-400" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>ערוך</TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger render={<span className="block" />}>
                          <Button
                            type="button" variant="ghost" size="icon"
                            aria-label={s.is_active ? 'בטל הפעלה' : 'הפעל מחדש'}
                            onClick={() => onToggleActive(s)}
                          >
                            {s.is_active
                              ? <Ban className="h-4 w-4 text-rose-500" />
                              : <RotateCcw className="h-4 w-4 text-blue-500" />}
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>{s.is_active ? 'בטל הפעלה' : 'הפעל מחדש'}</TooltipContent>
                      </Tooltip>
                    </div>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
