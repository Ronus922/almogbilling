'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { FileSpreadsheet, FileText, Loader2, Printer } from 'lucide-react';
import {
  PDF_MIME, XLSX_MIME, buildListWorkbook, downloadFile, exportCellText, exportDateTime, exportFileName,
  type ListExport,
} from '@/lib/export/list-export';
import { PrintableChipList } from './PrintableChipList';

// "הדפסה" · "ייצוא לאקסל" · "הורדה ל-PDF" — the three ways a list of /chips
// leaves the screen (25/11/2026, Ronen). ONE component for both tabs, so the
// buttons are the same three, in the same order, with the same look — and
// ChipsToolbar puts them at the same place of each toolbar. All three act on
// the rows the tab shows right
// now — after its search and its filters — and on the columns of the list's
// one description (ListExport). Nothing is fetched and nothing is sent: the
// files are built in the browser, so whoever sees the tab has them.

// A label is one line always. The buttons live in the toolbar (ChipsToolbar)
// and follow ITS width (a container query, not the window's): in a narrow
// card the three share the card's width — on a phone two on the first line
// and the third under them — and from 720px each takes its own width. 44px
// tall everywhere.
const TOOL_BTN =
  'inline-flex h-11 flex-1 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-[11px] border-[1.5px] border-[var(--chip-border)] bg-[var(--chip-panel)] px-3 text-[13.5px] font-semibold text-[var(--chip-ink-muted)] transition-colors hover:bg-[var(--chip-hover)] disabled:cursor-not-allowed disabled:opacity-50 @min-[720px]:flex-none @min-[720px]:px-4';

/** Lets the browser draw the spinner before a build that holds the page. */
const afterPaint = () => new Promise<void>((resolve) => { setTimeout(resolve, 30); });

export function ChipListExports<T>({
  list, rows, rowKey, filter, disabled = false, testId,
}: {
  list: ListExport<T>;
  /** The rows on the screen, in their order. */
  rows: T[];
  rowKey: (row: T) => string;
  /** The filter in force, in words — printed under the title. Empty = none. */
  filter: string[];
  /** The list is still loading. */
  disabled?: boolean;
  /** `<testId>-print`, `<testId>-export`, `<testId>-pdf`. */
  testId: string;
}) {
  const [busy, setBusy] = useState<'excel' | 'pdf' | null>(null);
  // What "הדפסה" was pressed on — kept as it was at the click.
  const [printing, setPrinting] = useState<{ rows: T[]; meta: string[]; date: string } | null>(null);
  const off = disabled || rows.length === 0;
  const meta = () => [`סה״כ ${rows.length} שורות`, ...filter];

  async function exportExcel() {
    if (off || busy) return;
    setBusy('excel');
    try {
      downloadFile(await buildListWorkbook(list, rows), XLSX_MIME, exportFileName(list.file, 'xlsx'));
    } catch {
      toast.error('הייצוא לאקסל נכשל');
    } finally {
      setBusy(null);
    }
  }

  async function exportPdf() {
    if (off || busy) return;
    setBusy('pdf');
    try {
      const now = new Date();
      // jsPDF and the two embedded fonts load on the first click only.
      const { buildListPdf } = await import('@/lib/export/list-pdf');
      await afterPaint();
      const file = await buildListPdf({
        title: list.title,
        date: exportDateTime(now),
        meta: meta(),
        // Everything that is not free text reads left to right: a number, a
        // phone, a date, a chip number.
        columns: list.columns.map((c) => ({ header: c.header, ltr: c.kind !== 'text' })),
        rows: rows.map((r) => list.columns.map((c) => exportCellText(c, r, now))),
      });
      downloadFile(file.bytes, PDF_MIME, exportFileName(list.file, 'pdf', now));
    } catch {
      toast.error('הפקת קובץ ה-PDF נכשלה');
    } finally {
      setBusy(null);
    }
  }

  // Once the print-only table is in the DOM, open the print dialog. The table
  // is taken down when the browser says the printing is over (`afterprint`),
  // not when print() returns: where print() does not wait for the dialog (a
  // phone), the page would be printed after the table is already gone.
  useEffect(() => {
    if (!printing) return;
    const done = () => setPrinting(null);
    window.addEventListener('afterprint', done);
    const t = setTimeout(() => window.print(), 80);
    return () => {
      clearTimeout(t);
      window.removeEventListener('afterprint', done);
    };
  }, [printing]);

  return (
    <div className="flex flex-wrap items-center gap-2 @min-[720px]:flex-nowrap" data-testid={`${testId}-exports`}>
      <button
        type="button"
        className={TOOL_BTN}
        disabled={off}
        onClick={() => setPrinting({ rows: [...rows], meta: meta(), date: exportDateTime(new Date()) })}
        data-testid={`${testId}-print`}
      >
        <Printer className="h-4 w-4 shrink-0" />
        הדפסה
      </button>
      <button type="button" className={TOOL_BTN} disabled={off || busy !== null} onClick={() => void exportExcel()} data-testid={`${testId}-export`}>
        {busy === 'excel' ? <Loader2 className="h-4 w-4 shrink-0 animate-spin" /> : <FileSpreadsheet className="h-4 w-4 shrink-0" />}
        ייצוא לאקסל
      </button>
      <button type="button" className={TOOL_BTN} disabled={off || busy !== null} onClick={() => void exportPdf()} data-testid={`${testId}-pdf`}>
        {busy === 'pdf' ? <Loader2 className="h-4 w-4 shrink-0 animate-spin" /> : <FileText className="h-4 w-4 shrink-0" />}
        הורדה ל-PDF
      </button>
      {printing && (
        <PrintableChipList list={list} rows={printing.rows} rowKey={rowKey} meta={printing.meta} date={printing.date} />
      )}
    </div>
  );
}
