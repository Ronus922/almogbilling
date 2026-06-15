'use client';

import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
import {
  supplierStatusMeta,
  type DesignTone,
} from '@/lib/constants/suppliers';
import { formatPhoneDisplay, phoneTelHref } from '@/lib/phone';
import type { SupplierListItem, SupplierStatus } from '@/lib/types/suppliers';

// DESIGN.md §2 tone → badge classes. Only the tones the status palette uses.
const STATUS_TONE: Record<DesignTone, string> = {
  emerald: 'bg-emerald-100 text-emerald-700',
  slate: 'bg-slate-100 text-slate-600',
  amber: 'bg-amber-100 text-amber-700',
};

export function SupplierTable({
  rows,
  loading,
  onRowClick,
}: {
  rows: SupplierListItem[];
  loading: boolean;
  onRowClick: (id: string) => void;
}) {
  if (loading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="h-12 rounded-lg bg-muted/60 animate-pulse" />
        ))}
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="rounded-lg border bg-card p-12 text-center text-sm text-muted-foreground">
        לא נמצאו ספקים. הוסיפו ספק חדש כדי להתחיל.
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
      <Table>
        <TableHeader className="[&_tr]:border-b [&_tr]:border-slate-200">
          <TableRow className="bg-slate-50 hover:bg-slate-50">
            <TableHead className="h-11 px-4 text-right text-sm font-semibold text-slate-500">שם</TableHead>
            <TableHead className="h-11 px-4 text-right text-sm font-semibold text-slate-500">קטגוריה</TableHead>
            <TableHead className="h-11 px-4 text-right text-sm font-semibold text-slate-500">איש קשר</TableHead>
            <TableHead className="h-11 px-4 text-center text-sm font-semibold text-slate-500">טלפון</TableHead>
            <TableHead className="h-11 px-4 text-center text-sm font-semibold text-slate-500 max-md:hidden">נייד</TableHead>
            <TableHead className="h-11 px-4 text-center text-sm font-semibold text-slate-500 max-lg:hidden">אימייל</TableHead>
            <TableHead className="h-11 px-4 text-center text-sm font-semibold text-slate-500">סטטוס</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((s) => {
            const phone = formatPhoneDisplay(s.phone);
            const mobile = formatPhoneDisplay(s.mobile);
            return (
              <TableRow
                key={s.id}
                onClick={() => onRowClick(s.id)}
                className="cursor-pointer border-b border-slate-100 hover:bg-slate-50 h-12"
              >
                <TableCell className="px-4 py-3 text-right text-sm">
                  <span className="block font-bold text-slate-900">{s.display_name}</span>
                  {s.company_name && (
                    <span className="block text-xs text-slate-500">{s.company_name}</span>
                  )}
                </TableCell>
                <TableCell className="px-4 py-3 text-right">
                  {s.category_name ? (
                    <span className="inline-flex items-center rounded-full bg-blue-50 px-2.5 py-0.5 text-xs font-semibold text-blue-700">
                      {s.category_name}
                    </span>
                  ) : (
                    <span className="text-slate-400">—</span>
                  )}
                </TableCell>
                <TableCell className="px-4 py-3 text-right text-sm text-slate-700">
                  {s.contact_person || '—'}
                </TableCell>
                <TableCell dir="ltr" className="px-4 py-3 text-center text-sm tabular-nums">
                  <PhoneLink display={phone} raw={s.phone} />
                </TableCell>
                <TableCell dir="ltr" className="px-4 py-3 text-center text-sm tabular-nums max-md:hidden">
                  <PhoneLink display={mobile} raw={s.mobile} />
                </TableCell>
                <TableCell dir="ltr" className="px-4 py-3 text-center text-sm max-lg:hidden">
                  {s.email ? (
                    <a
                      href={`mailto:${s.email}`}
                      onClick={(e) => e.stopPropagation()}
                      className="text-blue-600 hover:text-blue-700 hover:underline underline-offset-2"
                    >
                      {s.email}
                    </a>
                  ) : (
                    <span className="text-slate-500">—</span>
                  )}
                </TableCell>
                <TableCell className="px-4 py-3 text-center">
                  <StatusBadge status={s.status} />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

/** Clickable tel: link from a (display, raw) phone pair, or an em-dash. */
function PhoneLink({ display, raw }: { display: string | null; raw: string }) {
  const href = phoneTelHref(raw);
  if (!display || !href) return <span className="text-slate-500">—</span>;
  return (
    <a
      href={`tel:${href}`}
      onClick={(e) => e.stopPropagation()}
      className="text-blue-600 hover:text-blue-700 hover:underline underline-offset-2"
    >
      {display}
    </a>
  );
}

function StatusBadge({ status }: { status: SupplierStatus }) {
  const meta = supplierStatusMeta(status);
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-3 py-0.5 text-xs font-semibold',
        STATUS_TONE[meta.tone],
      )}
    >
      {meta.label}
    </span>
  );
}
