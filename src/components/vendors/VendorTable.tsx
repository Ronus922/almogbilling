'use client';

import { Pencil, Trash2, Users } from 'lucide-react';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatPhoneDisplay, phoneTelHref } from '@/lib/phone';
import type { VendorListItem } from '@/lib/types/vendors';

export function VendorTable({
  rows,
  loading,
  canEdit,
  onRowClick,
  onDelete,
}: {
  rows: VendorListItem[];
  loading: boolean;
  canEdit: boolean;
  onRowClick: (id: string) => void;
  onDelete: (vendor: VendorListItem) => void;
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
      <div className="flex flex-col items-center justify-center gap-3 rounded-lg border bg-card p-12 text-center">
        <span className="grid h-12 w-12 place-items-center rounded-full bg-blue-50 text-blue-600">
          <Users className="h-5 w-5" />
        </span>
        <p className="text-sm text-muted-foreground">לא נמצאו ספקים. הוסיפו ספק חדש כדי להתחיל.</p>
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
            <TableHead className="h-11 px-4 text-right text-sm font-semibold text-slate-500 max-md:hidden">איש קשר</TableHead>
            <TableHead className="h-11 px-4 text-center text-sm font-semibold text-slate-500">טלפון</TableHead>
            <TableHead className="h-11 px-4 text-center text-sm font-semibold text-slate-500 max-lg:hidden">אימייל</TableHead>
            <TableHead className="h-11 px-4 text-left text-sm font-semibold text-slate-500">פעולות</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((v) => {
            const phone = formatPhoneDisplay(v.phone);
            return (
              <TableRow
                key={v.id}
                onClick={() => onRowClick(v.id)}
                className="cursor-pointer border-b border-slate-100 hover:bg-slate-50 h-12"
              >
                <TableCell className="px-4 py-3 text-right text-sm font-bold text-slate-900">
                  {v.name}
                </TableCell>
                <TableCell className="px-4 py-3 text-right">
                  {v.category_name ? (
                    <span className="inline-flex items-center rounded-full bg-blue-50 px-2.5 py-0.5 text-xs font-semibold text-blue-700">
                      {v.category_name}
                    </span>
                  ) : (
                    <span className="text-slate-400">—</span>
                  )}
                </TableCell>
                <TableCell className="px-4 py-3 text-right text-sm text-slate-700 max-md:hidden">
                  {v.contact_person || '—'}
                </TableCell>
                <TableCell dir="ltr" className="px-4 py-3 text-center text-sm tabular-nums">
                  <PhoneLink display={phone} raw={v.phone} />
                </TableCell>
                <TableCell dir="ltr" className="px-4 py-3 text-center text-sm max-lg:hidden">
                  {v.email ? (
                    <a
                      href={`mailto:${v.email}`}
                      onClick={(e) => e.stopPropagation()}
                      className="text-blue-600 hover:text-blue-700 hover:underline underline-offset-2"
                    >
                      {v.email}
                    </a>
                  ) : (
                    <span className="text-slate-500">—</span>
                  )}
                </TableCell>
                <TableCell className="px-4 py-3 text-left">
                  <div className="flex items-center justify-end gap-1">
                    <Tooltip>
                      <TooltipTrigger render={<span className="inline-flex" />}>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          onClick={(e) => { e.stopPropagation(); onRowClick(v.id); }}
                          aria-label="עריכה"
                          className="h-9 w-9 text-slate-500 hover:text-slate-700"
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>עריכה</TooltipContent>
                    </Tooltip>
                    {canEdit && (
                      <Tooltip>
                        <TooltipTrigger render={<span className="inline-flex" />}>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            onClick={(e) => { e.stopPropagation(); onDelete(v); }}
                            aria-label="מחיקה"
                            className="h-9 w-9 text-red-400 hover:text-red-600"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>מחיקה</TooltipContent>
                      </Tooltip>
                    )}
                  </div>
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
