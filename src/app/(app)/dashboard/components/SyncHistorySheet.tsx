'use client';

import { useEffect, useState } from 'react';
import { History, X } from 'lucide-react';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { formatStamp } from '@/lib/dashboard/formatStamp';
import { SYNC_STAGE_LABELS, type SyncStage } from '@/lib/sync/decision';

interface RunRow {
  id: string;
  started_at: string;
  finished_at: string | null;
  status: 'running' | 'success' | 'error';
  error_stage: SyncStage | null;
  error_message: string | null;
  source_run_at: string | null;
  rows_count: number | null;
  trigger_source: 'ui' | 'cron';
  triggered_by_email: string | null;
}

const STATUS: Record<RunRow['status'], { label: string; cls: string }> = {
  success: { label: 'הצליח', cls: 'bg-emerald-50 text-emerald-700' },
  error:   { label: 'נכשל',  cls: 'bg-rose-50 text-rose-700' },
  running: { label: 'רץ',    cls: 'bg-slate-100 text-slate-600' },
};

/**
 * Admin-only side panel (DESIGN.md §12 Sheet, side="left") listing the last 30
 * Bllink sync runs: when, status, failed stage, message, "data correct as of",
 * apartments written and who/what triggered it. Read-only, so the footer is a
 * single "סגור".
 */
export function SyncHistorySheet({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="left"
        dir="rtl"
        showCloseButton={false}
        className="w-full max-w-full p-0 sm:w-[92vw] md:w-[80vw] lg:w-[55vw] lg:min-w-[720px] flex flex-col gap-0 overflow-hidden bg-white"
      >
        {/* Header — gradient (DESIGN canonical) */}
        <div className="flex-none bg-gradient-to-bl from-slate-900 via-blue-950 to-blue-900 px-6 py-6 text-white">
          <div className="flex items-start justify-between gap-4">
            <div className="flex min-w-0 items-center gap-3">
              <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-white/10">
                <History className="h-5 w-5" />
              </span>
              <div className="min-w-0">
                <SheetTitle className="text-xl font-bold text-white">היסטוריית סנכרונים</SheetTitle>
                <p className="mt-0.5 text-sm text-white/70">30 הריצות האחרונות מול בלינק</p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              aria-label="סגור"
              className="grid h-11 w-11 shrink-0 place-items-center rounded-lg border border-white/25 bg-white/5 hover:bg-white/15"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {/* Body — mounted per open, so each opening starts from a clean fetch */}
        <div className="flex-1 overflow-y-auto bg-slate-50/60 p-5">
          {open && <HistoryBody />}
        </div>

        {/* Footer */}
        <div className="flex flex-none justify-start border-t border-slate-200 bg-white px-5 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>סגור</Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** Loads the runs once on mount; the parent remounts it every time the sheet opens. */
function HistoryBody() {
  const [runs, setRuns] = useState<RunRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/sync/runs', { credentials: 'include' })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (await r.json()) as { runs: RunRow[] };
      })
      .then((j) => { if (!cancelled) setRuns(j.runs); })
      .catch((e: unknown) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, []);

  if (error) {
    return (
      <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-900">
        טעינת ההיסטוריה נכשלה: {error}
      </div>
    );
  }
  if (runs === null) {
    return (
      <div className="space-y-2">
        {[0, 1, 2, 3].map((i) => <div key={i} className="h-12 rounded-lg bg-muted/60 animate-pulse" />)}
      </div>
    );
  }
  if (runs.length === 0) {
    return (
      <div className="rounded-lg border bg-card p-12 text-center text-sm text-muted-foreground">
        טרם בוצע סנכרון.
      </div>
    );
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
      <Table>
        <TableHeader className="[&_tr]:border-b [&_tr]:border-slate-200">
          <TableRow className="bg-slate-50 hover:bg-slate-50">
            <TableHead className="h-11 px-4 text-start text-sm font-semibold text-slate-500">זמן · הופעל ע״י</TableHead>
            <TableHead className="h-11 px-4 text-start text-sm font-semibold text-slate-500">תוצאה</TableHead>
            <TableHead className="h-11 px-4 text-start text-sm font-semibold text-slate-500">הודעה</TableHead>
            <TableHead className="h-11 px-4 text-start text-sm font-semibold text-slate-500">נתון נכון ל-</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {runs.map((r) => {
            const st = STATUS[r.status];
            return (
              <TableRow key={r.id} className="border-b border-slate-100 hover:bg-slate-50">
                <TableCell className="whitespace-normal px-4 py-3 text-start text-sm align-top">
                  <div className="font-num tabular-nums text-slate-800">{formatStamp(r.started_at)}</div>
                  <div className="text-xs text-slate-500">
                    {r.trigger_source === 'cron' ? 'סנכרון אוטומטי' : (r.triggered_by_email ?? 'משתמש')}
                  </div>
                </TableCell>
                <TableCell className="whitespace-nowrap px-4 py-3 text-start text-sm align-top">
                  <span className={cn('inline-flex rounded-full px-2 py-0.5 text-xs font-semibold', st.cls)}>{st.label}</span>
                  {r.error_stage ? (
                    <div className="mt-1 text-xs text-slate-600">{SYNC_STAGE_LABELS[r.error_stage]}</div>
                  ) : r.rows_count != null ? (
                    <div className="mt-1 text-xs text-slate-600"><span className="font-num tabular-nums">{r.rows_count}</span> דירות</div>
                  ) : null}
                </TableCell>
                <TableCell className="min-w-[12rem] max-w-[22ch] whitespace-normal px-4 py-3 text-start text-sm text-slate-600 align-top" title={r.error_message ?? undefined}>
                  <span dir="auto" className="line-clamp-2 break-words [unicode-bidi:plaintext]">{r.error_message ?? '—'}</span>
                </TableCell>
                <TableCell className="whitespace-nowrap px-4 py-3 text-start text-sm font-num tabular-nums text-slate-800 align-top">
                  {r.source_run_at ? formatStamp(r.source_run_at) : <span className="text-slate-400">—</span>}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
