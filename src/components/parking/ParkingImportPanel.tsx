'use client';

import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { X, Upload, FileSpreadsheet, AlertTriangle, Info } from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Section } from '@/components/side-panel/Section';
import { PanelFooter } from '@/components/side-panel/PanelFooter';
import { cn } from '@/lib/utils';

// Excel import — admin only, preview-then-commit. A Sheet, matching every other
// multi-step flow in the module.

interface RowError { rowNumber: number; message: string; raw: { spot: string; apartment: string; note: string } }

interface Preview {
  toInsert: number;
  toUpdate: number;
  errors: RowError[];
  duplicateSpotNumbers: number[];
  unknownApartments: string[];
  totalRows: number;
  inserted?: number;
  updated?: number;
}

interface Props {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onImported: () => void;
}

/** Preview is blocking, not advisory: a file with any of these cannot commit. */
function hasBlockingProblems(p: Preview): boolean {
  return p.errors.length > 0 || p.duplicateSpotNumbers.length > 0 || p.unknownApartments.length > 0;
}

export function ParkingImportPanel({ open, onOpenChange, onImported }: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  function reset() {
    setFile(null);
    setPreview(null);
    if (inputRef.current) inputRef.current.value = '';
  }

  function close() {
    if (busy) return;
    reset();
    onOpenChange(false);
  }

  async function send(mode: 'preview' | 'commit') {
    if (!file) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('mode', mode);
      const res = await fetch('/api/parking/import', {
        method: 'POST', body: fd, credentials: 'include',
      });
      const data = (await res.json().catch(() => ({}))) as Preview & { error?: string };
      if (!res.ok) {
        // A rejected commit still carries its diagnostics — keep them on screen
        // so the user can act, instead of clearing back to an empty panel.
        if (data.errors) setPreview(data);
        throw new Error(data.error ?? 'הייבוא נכשל');
      }
      setPreview(data);
      if (mode === 'commit') {
        toast.success(`הייבוא הושלם — ${data.inserted ?? 0} נוספו, ${data.updated ?? 0} עודכנו`);
        onImported();
      }
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const committed = preview?.inserted !== undefined;
  const blocked = preview ? hasBlockingProblems(preview) : false;

  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o) close(); else onOpenChange(o); }}>
      <SheetContent
        side="left"
        dir="rtl"
        showCloseButton={false}
        className="w-full max-w-full p-0 sm:w-[92vw] md:w-[80vw] lg:w-[55vw] lg:min-w-[720px] flex flex-col gap-0 overflow-hidden bg-white"
      >
        <SheetHeader className="flex-none gap-2 bg-gradient-to-bl from-slate-900 via-blue-950 to-blue-900 px-6 py-6 text-white">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <SheetTitle className="text-2xl font-bold text-white">ייבוא חניות מ-Excel</SheetTitle>
              <p className="mt-1 text-sm text-white/70">
                הקובץ נבדק לפני הכתיבה. שום דבר לא נשמר עד לאישור.
              </p>
            </div>
            <button
              type="button" onClick={close} aria-label="סגור" disabled={busy}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-white/25 bg-white/5 text-white transition-colors hover:bg-white/15 hover:border-white/50 disabled:opacity-60"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto bg-slate-50/60 p-5">
          <div className="space-y-4">
            <Section title="מבנה הקובץ" icon={Info} iconTone="slate">
              <div className="space-y-2 py-2 text-sm text-slate-600">
                <p>שלוש עמודות, שורה ראשונה = כותרת:</p>
                <p className="font-semibold text-slate-800">מספר חניה | דירה | הערה</p>
                <ul className="list-disc space-y-1 pe-5 text-[13px]">
                  <li>עמודת <b>דירה</b>: מספר דירה, או <b>חו״כ</b> (חוף הכרמל), או <b>נציגות</b>.</li>
                  <li>עמודת <b>הערה</b>: <b>2</b> = כפולה ברוחב · <b>3</b> = כפולה באורך · <b>1</b> = בתהליך מכירה. כל טקסט אחר נשמר כהערה.</li>
                  <li>הייבוא מוסיף חניות חדשות ומעדכן קיימות לפי מספר החניה. חניות שאינן בקובץ לא משתנות ולא נמחקות.</li>
                </ul>
              </div>
            </Section>

            <Section title="בחירת קובץ" icon={FileSpreadsheet} iconTone="blue">
              <div className="space-y-3 py-2">
                <input
                  ref={inputRef}
                  type="file"
                  accept=".xlsx"
                  disabled={busy}
                  onChange={(e) => { setFile(e.target.files?.[0] ?? null); setPreview(null); }}
                  className="block w-full text-sm text-slate-600 file:me-3 file:rounded-lg file:border-0 file:bg-blue-600 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-white hover:file:bg-blue-700"
                />
                {file && (
                  <p className="text-[13px] text-slate-500">
                    נבחר: <span className="font-semibold text-slate-700">{file.name}</span>
                  </p>
                )}
                <Button
                  type="button"
                  variant="outline"
                  disabled={!file || busy}
                  onClick={() => void send('preview')}
                  className="gap-2"
                >
                  <Upload className="h-4 w-4" />
                  {busy && !committed ? 'בודק…' : 'בדוק את הקובץ'}
                </Button>
              </div>
            </Section>

            {preview && (
              <Section
                title={committed ? 'תוצאות הייבוא' : 'תצוגה מקדימה'}
                icon={blocked ? AlertTriangle : Info}
                iconTone={blocked ? 'amber' : 'blue'}
              >
                <div className="space-y-3 py-2">
                  <div className="grid grid-cols-3 gap-3">
                    <Stat label="שורות בקובץ" value={preview.totalRows} />
                    <Stat
                      label={committed ? 'נוספו' : 'ייווספו'}
                      value={committed ? preview.inserted ?? 0 : preview.toInsert}
                    />
                    <Stat
                      label={committed ? 'עודכנו' : 'יעודכנו'}
                      value={committed ? preview.updated ?? 0 : preview.toUpdate}
                    />
                  </div>

                  {blocked && (
                    <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
                      <p className="text-sm font-semibold text-amber-900">
                        יש לתקן את הקובץ לפני הייבוא
                      </p>

                      {preview.unknownApartments.length > 0 && (
                        <ProblemList
                          title={`דירות שאינן קיימות ברשימת הדיירים (${preview.unknownApartments.length})`}
                          items={preview.unknownApartments}
                        />
                      )}
                      {preview.duplicateSpotNumbers.length > 0 && (
                        <ProblemList
                          title={`מספרי חניה כפולים בתוך הקובץ (${preview.duplicateSpotNumbers.length})`}
                          items={preview.duplicateSpotNumbers.map(String)}
                        />
                      )}
                      {preview.errors.length > 0 && (
                        <div className="mt-3">
                          <p className="text-[13px] font-semibold text-amber-900">
                            שורות עם שגיאה ({preview.errors.length})
                          </p>
                          <ul className="mt-1 max-h-64 space-y-1 overflow-y-auto text-[13px] text-amber-800">
                            {preview.errors.map((e) => (
                              <li key={e.rowNumber} className="rounded bg-white/60 px-2 py-1">
                                <span className="font-bold tabular-nums">שורה {e.rowNumber}:</span>{' '}
                                {e.message}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  )}

                  {!blocked && !committed && (
                    <p className="text-sm text-slate-600">
                      הקובץ תקין. לחצו על ״בצע ייבוא״ כדי לכתוב את השינויים.
                    </p>
                  )}
                  {committed && !blocked && (
                    <p className="text-sm font-semibold text-slate-800">הייבוא הושלם בהצלחה.</p>
                  )}
                </div>
              </Section>
            )}
          </div>
        </div>

        <PanelFooter
          onClose={close}
          onSave={() => void send('commit')}
          saveDisabled={!file || busy || !preview || blocked || committed}
          saveDisabledReason={
            !preview ? 'יש לבדוק את הקובץ תחילה'
              : blocked ? 'יש לתקן את השגיאות בקובץ'
                : committed ? 'הייבוא כבר בוצע' : undefined
          }
          saveLabel={busy ? 'מייבא…' : 'בצע ייבוא'}
        />
      </SheetContent>
    </Sheet>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3 text-center">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div dir="ltr" className="mt-1 text-xl font-extrabold tabular-nums text-slate-900">{value}</div>
    </div>
  );
}

function ProblemList({ title, items }: { title: string; items: string[] }) {
  const shown = items.slice(0, 20);
  return (
    <div className="mt-3">
      <p className="text-[13px] font-semibold text-amber-900">{title}</p>
      <div className={cn('mt-1 flex flex-wrap gap-1')}>
        {shown.map((v) => (
          <span key={v} className="rounded bg-white/70 px-1.5 py-0.5 text-[12px] font-semibold tabular-nums text-amber-800">
            {v}
          </span>
        ))}
        {items.length > shown.length && (
          <span className="text-[12px] text-amber-700">ועוד {items.length - shown.length}…</span>
        )}
      </div>
    </div>
  );
}
