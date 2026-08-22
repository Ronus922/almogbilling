'use client';

import { cn } from '@/lib/utils';
import {
  OWNER_TYPE_SHORT, SALE_STATUS_LABEL, SIZE_TYPE_LABEL,
} from '@/lib/constants/parking';
import type {
  ParkingOwnerType, ParkingSaleStatus, ParkingSizeType,
} from '@/lib/types/parking';

// Small read-only pills shared by the three tabs (DESIGN.md §10 badge + §2 tones).
//
// NOTE ON GREEN: emerald is reserved for WhatsApp across this project, so
// nothing here uses it — not even for "fine". Neutral facts read slate, the
// developer/committee owners read blue/violet, and amber is kept for the one
// thing that genuinely wants attention (a sale in progress, a deviation).

const OWNER_TONE: Record<ParkingOwnerType, string> = {
  apartment: 'bg-blue-50 text-blue-700 ring-blue-200',
  developer: 'bg-slate-100 text-slate-600 ring-slate-200',
  committee: 'bg-violet-50 text-violet-700 ring-violet-200',
};

export function OwnerBadge({
  ownerType, apartmentNumber, className,
}: {
  ownerType: ParkingOwnerType;
  apartmentNumber: string | null;
  className?: string;
}) {
  // An apartment spot shows the NUMBER, not the word "דירה" — the number is the
  // information; the category is already implied by showing one.
  const label = ownerType === 'apartment' && apartmentNumber
    ? apartmentNumber
    : OWNER_TYPE_SHORT[ownerType];
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ring-1',
        OWNER_TONE[ownerType],
        ownerType === 'apartment' && 'tabular-nums',
        className,
      )}
    >
      {label}
    </span>
  );
}

/** Rendered ONLY for a double spot — a "רגילה" pill on 178 of 187 rows would be
 *  noise that hides the 9 rows that matter. */
export function SizeBadge({ sizeType }: { sizeType: ParkingSizeType }) {
  if (sizeType === 'single') {
    return <span className="text-xs text-slate-400">{SIZE_TYPE_LABEL.single}</span>;
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-700 ring-1 ring-amber-200">
      {SIZE_TYPE_LABEL[sizeType]}
      <span className="tabular-nums opacity-70">×2</span>
    </span>
  );
}

const SALE_TONE: Record<ParkingSaleStatus, string> = {
  none: '',
  for_sale: 'bg-sky-50 text-sky-700 ring-sky-200',
  in_process: 'bg-amber-50 text-amber-700 ring-amber-200',
  sold: 'bg-slate-100 text-slate-600 ring-slate-200',
};

export function SaleStatusBadge({ saleStatus }: { saleStatus: ParkingSaleStatus }) {
  if (saleStatus === 'none') return <span className="text-xs text-slate-300">—</span>;
  return (
    <span className={cn(
      'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ring-1',
      SALE_TONE[saleStatus],
    )}>
      {SALE_STATUS_LABEL[saleStatus]}
    </span>
  );
}

/** Marks a row that has been switched off. Rows are never deleted, so without
 *  this an inactive row would be indistinguishable from a live one. */
export function InactiveBadge() {
  return (
    <span className="inline-flex items-center rounded-full bg-rose-50 px-2 py-0.5 text-xs font-semibold text-rose-700 ring-1 ring-rose-200">
      מבוטלת
    </span>
  );
}
