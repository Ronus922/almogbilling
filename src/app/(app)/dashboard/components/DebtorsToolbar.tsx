'use client';

import { useState, useEffect, useTransition } from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { Search, Printer, FileSpreadsheet, FileText, X, Loader2, type LucideIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { Debtor } from '@/lib/db/debtors';
import { exportDebtorsExcel, exportDebtorsPdf } from '@/lib/export/debtors-export';
import { PrintableDebtorsTable } from './PrintableDebtorsTable';

type Busy = null | 'excel' | 'pdf' | 'print';

export function DebtorsToolbar({ totalRows, canExport }: { totalRows: number; canExport: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();

  const [apt, setApt] = useState(searchParams.get('apt') ?? '');
  const [q, setQ] = useState(searchParams.get('q') ?? '');
  const [busy, setBusy] = useState<Busy>(null);
  const [printRows, setPrintRows] = useState<Debtor[] | null>(null);

  // Debounced sync to URL
  useEffect(() => {
    const t = setTimeout(() => {
      const params = new URLSearchParams(searchParams.toString());
      if (apt) params.set('apt', apt); else params.delete('apt');
      if (q)   params.set('q', q);     else params.delete('q');
      params.delete('page');
      const qs = params.toString();
      startTransition(() => {
        router.push(qs ? `${pathname}?${qs}` : pathname);
      });
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apt, q]);

  // Fetch ALL rows matching the current filter (tab + search + sort) — the
  // export/print scope is the full filtered set, not just the visible page.
  async function fetchAllRows(): Promise<Debtor[]> {
    const params = new URLSearchParams();
    for (const key of ['tab', 'sort', 'q', 'apt'] as const) {
      const v = searchParams.get(key);
      if (v) params.set(key, v);
    }
    const res = await fetch(`/api/debtors/export?${params.toString()}`, { credentials: 'include' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { rows?: Debtor[] };
    return Array.isArray(data.rows) ? data.rows : [];
  }

  async function handleExcel() {
    if (busy) return;
    setBusy('excel');
    try {
      const rows = await fetchAllRows();
      await exportDebtorsExcel(rows);
      toast.success('הקובץ יוצא');
    } catch (e) {
      toast.error(`הייצוא נכשל: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  async function handlePdf() {
    if (busy) return;
    setBusy('pdf');
    try {
      const rows = await fetchAllRows();
      await exportDebtorsPdf(rows);
      toast.success('הקובץ יוצא');
    } catch (e) {
      toast.error(`הייצוא נכשל: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  async function handlePrint() {
    if (busy) return;
    setBusy('print');
    try {
      const rows = await fetchAllRows();
      setPrintRows(rows); // → triggers the print effect once the portal renders
    } catch (e) {
      toast.error(`ההדפסה נכשלה: ${(e as Error).message}`);
      setBusy(null);
    }
  }

  // Once the printable table is in the DOM, open the print dialog, then clean up.
  useEffect(() => {
    if (!printRows) return;
    const t = setTimeout(() => {
      window.print();
      setPrintRows(null);
      setBusy(null);
    }, 80);
    return () => clearTimeout(t);
  }, [printRows]);

  return (
    <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
      <div className="flex items-baseline gap-3">
        <h2 className="text-[16px] font-bold text-ink">טבלת חייבים</h2>
        <span className="text-sm text-ink-2">
          סה״כ <span className="font-num tabular-nums">{totalRows}</span> רשומות
        </span>
      </div>

      {/* On a phone the two search fields each take a full row and the rest of
          the controls wrap beneath them, instead of being squeezed into one
          horizontal strip. `[&>div]:w-full` targets SearchField's relative
          wrapper so the input inside it can actually reach full width. */}
      <div className="flex flex-wrap items-center gap-2 [&>div]:w-full sm:[&>div]:w-auto">
        <SearchField
          placeholder="מספר דירה..."
          value={apt}
          onChange={setApt}
          widthClass="w-full sm:w-40"
        />
        <SearchField
          placeholder="שם בעלים..."
          value={q}
          onChange={setQ}
          widthClass="w-full sm:w-48"
        />
        <Select disabled defaultValue="all">
          <SelectTrigger className="h-11 w-full rounded-lg border-line bg-surface-2 sm:w-40 md:h-[34px]">
            <SelectValue placeholder="כל המצבים" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">כל המצבים</SelectItem>
          </SelectContent>
        </Select>

        {/* Bulk export / print — `export` permission (manager+). Hidden for a
            read-only viewer, whose API call to /api/debtors/export would 403. */}
        {canExport && (
          <>
            <span className="mx-0.5 h-6 w-px bg-line" aria-hidden />

            <ExportIconButton
              label="הדפסה"
              icon={Printer}
              onClick={handlePrint}
              busy={busy === 'print'}
              disabled={busy !== null}
              tone="text-ink-2 hover:bg-row-hover hover:text-ink"
            />
            <ExportIconButton
              label="ייצוא Excel"
              icon={FileSpreadsheet}
              onClick={handleExcel}
              busy={busy === 'excel'}
              disabled={busy !== null}
              tone="text-emerald-600 hover:bg-emerald-50 hover:text-emerald-700"
            />
            <ExportIconButton
              label="ייצוא PDF"
              icon={FileText}
              onClick={handlePdf}
              busy={busy === 'pdf'}
              disabled={busy !== null}
              tone="text-red-600 hover:bg-red-50 hover:text-red-700"
            />
          </>
        )}
      </div>

      {printRows && <PrintableDebtorsTable rows={printRows} />}
    </div>
  );
}

function SearchField({
  placeholder, value, onChange, widthClass,
}: {
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  widthClass: string;
}) {
  return (
    <div className="relative">
      {/* Search icon at the start (right in RTL) → pad the start (ps-9). */}
      <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3" />
      <Input
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cn('h-11 rounded-lg border-line bg-surface-2 ps-9 md:h-[34px]', widthClass, value && 'pe-9')}
      />
      {value && (
        <button
          type="button"
          aria-label="נקה חיפוש"
          onClick={() => onChange('')}
          className="hit-44 absolute end-2 top-1/2 -translate-y-1/2 text-slate-400 transition-colors hover:text-slate-600"
        >
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

function ExportIconButton({
  label, icon: Icon, onClick, busy, disabled, tone,
}: {
  label: string;
  icon: LucideIcon;
  onClick: () => void;
  busy: boolean;
  disabled: boolean;
  tone: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span />}>
        <Button
          type="button"
          variant="outline"
          size="icon"
          onClick={onClick}
          disabled={disabled}
          aria-label={label}
          className={cn('h-[34px] w-[34px] rounded-lg border-line bg-surface-2', tone)}
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Icon className="h-4 w-4" />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
