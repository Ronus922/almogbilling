'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  X, Upload, FileSpreadsheet, CheckCircle2, AlertTriangle, ChevronDown, ChevronUp,
} from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';
import { useEscapeKey } from '@/lib/hooks/useEscapeKey';
import { importErrorFromCode, importErrorFromThrown } from '@/lib/excel/import-errors';

interface RunStatus {
  status: string;
  total_rows: number;
  processed_rows: number;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  error_summary: string | null;
  error_details: Array<{ row: number; apartment_number?: string; error: string }> | null;
}

const IN_PROGRESS = ['running', 'parsing', 'processing'];
const POLL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function isExcel(name: string): boolean {
  // ExcelJS reads .xlsx only — legacy .xls dropped with the xlsx→exceljs migration.
  return name.toLowerCase().endsWith('.xlsx');
}

const DEFAULT_ENDPOINT = '/api/contacts/import';
const DEFAULT_TITLE = 'ייבוא רשימת דיירים';
const DEFAULT_DESCRIPTION = 'קובץ Excel עם עמודות: דירה, שם בעלים, טלפון, אימייל, שוכר… (מיזוג — שדות ידניים נשמרים)';

export function ContactImportPanel({
  open,
  onOpenChange,
  onImported,
  endpoint = DEFAULT_ENDPOINT,
  title = DEFAULT_TITLE,
  description = DEFAULT_DESCRIPTION,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onImported: () => void;
  endpoint?: string;
  title?: string;
  description?: React.ReactNode;
}) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [status, setStatus] = useState<RunStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [showErrors, setShowErrors] = useState(false);

  const running = !!runId && (!status || IN_PROGRESS.includes(status.status));
  const done = !!status && !IN_PROGRESS.includes(status.status);

  // Reset everything on each open.
  useEffect(() => {
    if (open) {
      setFile(null); setDragOver(false); setRunId(null); setStatus(null);
      setError(null); setStarting(false); setShowErrors(false);
    }
  }, [open]);

  function requestClose() {
    if (starting || running) return; // don't close mid-flight
    onOpenChange(false);
  }
  useEscapeKey(open, () => requestClose());

  function pickFile(f: File | null | undefined) {
    if (!f) return;
    if (!isExcel(f.name)) { setError(importErrorFromCode('invalid_file_type')); return; }
    setError(null);
    setFile(f);
  }

  async function startImport() {
    if (!file) return;
    setStarting(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch(endpoint, { method: 'POST', body: fd, credentials: 'include' });
      const data = (await res.json().catch(() => ({}))) as { runId?: string; error?: string };
      if (!res.ok || !data.runId) { setError(importErrorFromCode(data.error)); return; }
      setRunId(data.runId);
    } catch (e) {
      setError(importErrorFromThrown(e));
    } finally {
      setStarting(false);
    }
  }

  // Poll the run status while in progress.
  useEffect(() => {
    if (!runId) return;
    const startedAt = Date.now();
    let active = true;
    const tick = async () => {
      if (!active) return;
      try {
        const res = await fetch(`${endpoint}/status/${runId}`, { credentials: 'include' });
        if (res.ok) {
          const next = (await res.json()) as RunStatus;
          if (!active) return;
          setStatus(next);
          if (!IN_PROGRESS.includes(next.status)) return; // terminal — stop polling
        }
      } catch { /* ignore a single poll failure */ }
      if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
        if (active) setError('הייבוא לוקח יותר מדי זמן. בדוק את היסטוריית הייבוא.');
        return;
      }
      if (active) setTimeout(tick, 500);
    };
    void tick();
    return () => { active = false; };
  }, [runId]);

  // On a clean completion, refresh + auto-close after 2s.
  useEffect(() => {
    if (status && status.status === 'completed' && status.failed === 0) {
      onImported();
      router.refresh();
      const t = setTimeout(() => onOpenChange(false), 2000);
      return () => clearTimeout(t);
    }
    // partial / failed: refresh data but keep the panel open for the report.
    if (status && (status.status === 'partial' || status.status === 'failed') && status.failed < status.total_rows) {
      onImported();
      router.refresh();
    }
  }, [status, onImported, onOpenChange, router]);

  const pct = status && status.total_rows > 0
    ? Math.min(100, Math.round((status.processed_rows / status.total_rows) * 100))
    : 0;

  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o) requestClose(); else onOpenChange(o); }}>
      <SheetContent
        side="left"
        dir="rtl"
        showCloseButton={false}
        className="w-full max-w-full p-0 sm:w-[92vw] md:w-[80vw] lg:w-[55vw] lg:min-w-[720px] flex flex-col gap-0 overflow-hidden bg-white"
      >
        <SheetHeader className="flex-none gap-2 bg-gradient-to-bl from-slate-900 via-blue-950 to-blue-900 px-6 py-6 text-white">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <SheetTitle className="text-2xl font-bold text-white">{title}</SheetTitle>
              <p className="mt-1 text-sm text-white/70">{description}</p>
            </div>
            <button
              type="button"
              onClick={requestClose}
              aria-label="סגור"
              disabled={starting || running}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-white/25 bg-white/5 text-white transition-colors hover:bg-white/15 hover:border-white/50 disabled:opacity-60"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto bg-slate-50/60 p-5">
          {/* Phase 1 — pick a file */}
          {!runId && (
            <div className="space-y-4">
              <div
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => { e.preventDefault(); setDragOver(false); pickFile(e.dataTransfer.files?.[0]); }}
                className={cn(
                  'flex h-[200px] flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed text-center transition-colors',
                  dragOver ? 'border-blue-400 bg-blue-50' : 'border-slate-300 bg-white',
                )}
              >
                <div className="grid h-14 w-14 place-items-center rounded-full bg-muted text-muted-foreground">
                  <Upload className="h-7 w-7" />
                </div>
                <p className="text-sm text-muted-foreground">גרור קובץ לכאן או בחר ידנית</p>
                <input
                  ref={inputRef}
                  type="file"
                  accept=".xlsx"
                  className="hidden"
                  onChange={(e) => { pickFile(e.target.files?.[0]); e.target.value = ''; }}
                />
                <Button type="button" variant="outline" className="gap-2" onClick={() => inputRef.current?.click()}>
                  <FileSpreadsheet className="h-4 w-4" /> בחר קובץ
                </Button>
              </div>

              {file && (
                <div className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white p-4">
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-emerald-100 text-emerald-600">
                      <FileSpreadsheet className="h-5 w-5" />
                    </span>
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold text-slate-900">{file.name}</div>
                      <div className="text-xs text-slate-500 tabular-nums">{formatSize(file.size)}</div>
                    </div>
                  </div>
                  <Button type="button" className="gap-2"
                    onClick={startImport} disabled={starting}>
                    <Upload className="h-4 w-4" /> {starting ? 'מתחיל…' : 'התחל ייבוא'}
                  </Button>
                </div>
              )}

              {error && (
                <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-900">
                  {error}
                </div>
              )}
            </div>
          )}

          {/* Phase 2 — running */}
          {running && (
            <div className="rounded-md border border-blue-200 bg-blue-50 p-4">
              <div className="flex items-center justify-between text-sm">
                <span className="font-medium text-blue-900">
                  מייבא {status?.processed_rows ?? 0} מתוך {status?.total_rows ?? 0}…
                </span>
                <span className="font-semibold text-blue-900 tabular-nums">{pct}%</span>
              </div>
              <Progress value={pct} className="mt-3" />
            </div>
          )}

          {/* Phase 3 — done */}
          {done && status && (
            <div className="space-y-3">
              {(status.status === 'completed' || status.status === 'partial') && (
                <div className="flex items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50 p-4 text-sm font-semibold text-emerald-900">
                  <CheckCircle2 className="h-5 w-5 shrink-0" />
                  <span>{status.created} נוצרו, {status.updated} עודכנו</span>
                </div>
              )}

              {status.skipped > 0 && (
                <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                  {status.skipped} שורות דולגו (ללא מספר דירה).
                </div>
              )}

              {status.failed > 0 && (
                <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900">
                  <div className="flex items-center gap-2 font-semibold">
                    <AlertTriangle className="h-4 w-4" />
                    <span>{status.failed} שורות נכשלו</span>
                  </div>
                  {status.error_details && status.error_details.length > 0 && (
                    <>
                      <button
                        type="button"
                        onClick={() => setShowErrors((s) => !s)}
                        className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-red-700 hover:text-red-800"
                      >
                        {showErrors ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                        {showErrors ? 'הסתר שגיאות' : 'הצג שגיאות'}
                      </button>
                      {showErrors && (
                        <ul className="mt-2 space-y-1 text-xs">
                          {status.error_details.map((d, i) => (
                            <li key={i} className="flex flex-wrap gap-x-2 border-t border-red-100 pt-1">
                              <span className="font-semibold tabular-nums">שורה {d.row}</span>
                              {d.apartment_number && <span className="tabular-nums">· דירה {d.apartment_number}</span>}
                              <span className="text-red-700">· {d.error}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </>
                  )}
                </div>
              )}

              {status.status === 'failed' && status.error_summary && (
                <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-900">
                  {importErrorFromThrown(status.error_summary)}
                </div>
              )}

              {status.status === 'completed' && status.failed === 0 && (
                <p className="text-center text-xs text-muted-foreground">החלון ייסגר אוטומטית…</p>
              )}
            </div>
          )}
        </div>

        {/* Footer — manual close (hidden while in-flight) */}
        <footer className="flex-none border-t border-slate-200 bg-white px-5 py-3">
          <div className="flex items-center justify-start">
            <Button type="button" variant="outline" onClick={requestClose} disabled={starting || running}>
              סגור
            </Button>
          </div>
        </footer>
      </SheetContent>
    </Sheet>
  );
}
