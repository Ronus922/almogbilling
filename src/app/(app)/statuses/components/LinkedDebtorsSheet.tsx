'use client';

import { useEffect, useState } from 'react';
import { ChevronLeft, X } from 'lucide-react';
import {
  Sheet, SheetContent, SheetTitle,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import type { StatusAdminRow, LinkedDebtorRow } from '@/lib/db/statuses';

const numFmt = new Intl.NumberFormat('he-IL', { maximumFractionDigits: 0 });
const ils = (v: number) => `₪ ${numFmt.format(v)}`;

export function LinkedDebtorsSheet({
  status,
  onOpenChange,
  onNavigate,
}: {
  status: StatusAdminRow | null;
  onOpenChange: (v: boolean) => void;
  onNavigate: (apartment: string) => void;
}) {
  const open = status !== null;
  const [rows, setRows] = useState<LinkedDebtorRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!status) {
      setRows([]);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/statuses/${status.id}/debtors`, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data: LinkedDebtorRow[]) => {
        if (!cancelled) setRows(data);
      })
      .catch((err) => { if (!cancelled) setError((err as Error).message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [status]);

  return (
    <Sheet open={open} onOpenChange={(v) => onOpenChange(v)}>
      <SheetContent
        side="left"
        dir="rtl"
        showCloseButton={false}
        className="w-full p-0 sm:w-[55vw] md:min-w-[640px] flex flex-col gap-0 overflow-hidden bg-white"
      >
        <div className="flex-none border-b border-slate-200 bg-white px-6 py-4">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <SheetTitle className="text-lg font-bold text-slate-900 truncate">
                דיירים משויכים — {status?.name ?? ''}
              </SheetTitle>
              <p className="mt-0.5 text-xs text-muted-foreground tabular-nums">
                סך הכל: <span className="font-semibold text-slate-700">{status?.linked_count ?? 0}</span> דיירים
              </p>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => onOpenChange(false)}
              aria-label="סגור"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto bg-slate-50/60 p-5">
          {loading ? (
            <div className="space-y-2">
              {[...Array(6)].map((_, i) => (
                <div key={i} className="h-10 rounded-lg bg-muted/60 animate-pulse" />
              ))}
            </div>
          ) : error ? (
            <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
              שגיאה בטעינת הדיירים: {error}
            </div>
          ) : rows.length === 0 ? (
            <div className="rounded-lg border bg-white p-8 text-center text-sm text-muted-foreground">
              אין דיירים משויכים לסטטוס זה.
            </div>
          ) : (
            <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
              <Table>
                <TableHeader className="[&_tr]:border-b [&_tr]:border-slate-200">
                  <TableRow className="bg-slate-50 hover:bg-slate-50">
                    <TableHead className="h-10 px-4 text-right text-xs font-semibold text-slate-500">
                      מס׳ דירה
                    </TableHead>
                    <TableHead className="h-10 px-4 text-right text-xs font-semibold text-slate-500">
                      בעל הדירה
                    </TableHead>
                    <TableHead className="h-10 px-4 text-center text-xs font-semibold text-slate-500">
                      סה״כ חוב
                    </TableHead>
                    <TableHead className="h-10 px-4 w-10" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((d) => (
                    <TableRow
                      key={d.id}
                      onClick={() => onNavigate(d.apartment_number)}
                      className="cursor-pointer border-b border-slate-100 hover:bg-slate-50 h-11"
                    >
                      <TableCell className="px-4 py-2 text-right text-sm font-bold text-slate-900 tabular-nums">
                        {d.apartment_number}
                      </TableCell>
                      <TableCell className="px-4 py-2 text-right text-sm font-medium text-slate-800">
                        {d.owner_name ?? '—'}
                      </TableCell>
                      <TableCell
                        dir="ltr"
                        className="px-4 py-2 text-center text-sm font-bold text-red-600 tabular-nums"
                      >
                        {ils(Number(d.total_debt))}
                      </TableCell>
                      <TableCell className="px-4 py-2 text-left">
                        <ChevronLeft className="h-4 w-4 text-slate-300" />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
