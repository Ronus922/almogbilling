'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { AlertTriangle, IdCard, Loader2, ScanLine, X, Info } from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Section } from '@/components/side-panel/Section';
import { PanelFooter } from '@/components/side-panel/PanelFooter';
import { useEscapeKey } from '@/lib/hooks/useEscapeKey';
import type { OcrField, OcrResponse } from '@/lib/visitors/model';
import { VisitorForm } from './VisitorForm';
import {
  EMPTY_FORM, formFromOcr, jpegBlobFromBase64, lowConfidenceFields, toPayload, validateForm,
  type FormErrors, type VisitorFormValues,
} from './format';

// The create flow of one scan, opened by the screen's "סרוק תעודה" once a photo
// exists: photo → OCR (the server normalises the photo and Claude reads it) →
// a form pre-filled from the document, every field editable → "שמור". The photo
// reaches Storage only on that last click; closing before it leaves nothing.
//
// Sheet, not Dialog (DESIGN §12): a create form always opens in the side panel,
// which on a phone is the whole screen.

interface Props {
  /** The photo the guard just took; null = closed. */
  file: File | null;
  onClose: () => void;
  onSaved: () => void;
  /** Take another photo (the photo could not be opened). */
  onRetake: () => void;
}

type Phase = 'reading' | 'ready' | 'unreadable';

export function ScanSheet({ file, onClose, onSaved, onRetake }: Props) {
  const [phase, setPhase] = useState<Phase>('reading');
  const [problem, setProblem] = useState('');
  const [ocrOk, setOcrOk] = useState(true);
  const [imageB64, setImageB64] = useState('');
  const [values, setValues] = useState<VisitorFormValues>(EMPTY_FORM);
  const [low, setLow] = useState<ReadonlySet<OcrField>>(new Set());
  const [errors, setErrors] = useState<FormErrors>({});
  const [saving, setSaving] = useState(false);
  const [confirmCloseOpen, setConfirmCloseOpen] = useState(false);

  const open = file !== null;

  // Step 1 — normalise + read. The parent gives every new photo a new `key`, so this
  // component starts from the 'reading' state each time — nothing to reset here.
  useEffect(() => {
    if (!file) return;
    const ctl = new AbortController();

    (async () => {
      try {
        const fd = new FormData();
        fd.append('image', file, file.name || 'scan.jpg');
        const r = await fetch('/api/visitors/ocr', { method: 'POST', body: fd, credentials: 'include', signal: ctl.signal });
        const data = (await r.json().catch(() => ({}))) as Partial<OcrResponse> & { error?: string };
        if (!r.ok || !data.fields || !data.image_base64) {
          setProblem(data.error ?? 'לא ניתן לפתוח את התמונה — צלם שוב');
          setPhase('unreadable');
          return;
        }
        setImageB64(data.image_base64);
        setOcrOk(data.ok === true);
        setValues(formFromOcr(data.fields));
        setLow(lowConfidenceFields({ fields: data.fields, confidence: data.confidence ?? {} }));
        setPhase('ready');
      } catch (e) {
        if ((e as Error).name === 'AbortError') return;
        setProblem('החיבור נכשל — בדוק את הקליטה ונסה שוב');
        setPhase('unreadable');
      }
    })();
    return () => ctl.abort();
  }, [file]);

  useEscapeKey(open && !confirmCloseOpen, () => requestClose());
  useEscapeKey(confirmCloseOpen, () => setConfirmCloseOpen(false));

  function requestClose() {
    if (saving) return;
    // A read photo is unsaved work: closing it deserves a second tap.
    if (phase === 'ready') setConfirmCloseOpen(true);
    else onClose();
  }

  function patch(p: Partial<VisitorFormValues>) {
    setValues((v) => ({ ...v, ...p }));
    setErrors((e) => {
      const next = { ...e };
      for (const k of Object.keys(p) as (keyof VisitorFormValues)[]) delete next[k];
      return next;
    });
  }

  async function save() {
    const found = validateForm(values);
    if (Object.keys(found).length > 0) {
      setErrors(found);
      toast.error('חסרים פרטים חובה');
      return;
    }
    setSaving(true);
    try {
      const fd = new FormData();
      // The photo is the normalised JPEG; its name is the camera's own (IMG_0001.HEIC → IMG_0001.jpg).
      const base = ((file?.name ?? '').replace(/\.[^.]+$/, '') || 'scan').slice(0, 120);
      fd.append('image', jpegBlobFromBase64(imageB64), `${base}.jpg`);
      fd.append('data', JSON.stringify(toPayload(values)));
      const r = await fetch('/api/visitors', { method: 'POST', body: fd, credentials: 'include' });
      const data = (await r.json().catch(() => ({}))) as { error?: string; duplicate?: boolean };
      if (!r.ok) throw new Error(data.error ?? 'שמירת הסריקה נכשלה');
      toast.success(data.duplicate ? 'הסריקה כבר נשמרה הרגע — לא נוצרה כפילות' : 'הסריקה נשמרה');
      onSaved();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Sheet open={open} onOpenChange={(o) => { if (!o) requestClose(); }}>
        <SheetContent
          side="left" dir="rtl" showCloseButton={false}
          className="w-full max-w-full p-0 sm:w-[92vw] md:w-[80vw] lg:w-[55vw] lg:min-w-[720px] flex flex-col gap-0 overflow-hidden bg-white"
        >
          <SheetHeader className="flex-none gap-2 bg-gradient-to-bl from-slate-900 via-blue-950 to-blue-900 px-6 py-6 text-white">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <SheetTitle className="text-2xl font-bold text-white">סריקת תעודה</SheetTitle>
                <p className="mt-1 text-sm text-white/70">
                  {phase === 'reading' ? 'קורא את התעודה…' : 'בדוק את הפרטים, מלא חדר / צ׳יפ / טלפון ושמור.'}
                </p>
              </div>
              <button
                type="button" onClick={requestClose} aria-label="סגור" disabled={saving}
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-white/25 bg-white/5 text-white transition-colors hover:bg-white/15 hover:border-white/50 disabled:opacity-60"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
          </SheetHeader>

          <div className="flex-1 overflow-y-auto bg-slate-50/60 p-5">
            {phase === 'reading' && (
              <div role="status" aria-live="polite" className="flex flex-col items-center gap-4 rounded-lg border border-slate-200 bg-white p-8 text-center">
                <Loader2 className="h-9 w-9 animate-spin text-brand" aria-hidden />
                <div className="text-lg font-bold text-slate-900">קורא את התעודה…</div>
                <div className="text-sm text-slate-500">זה לוקח כמה שניות. אפשר לא לסגור את החלון.</div>
              </div>
            )}

            {phase === 'unreadable' && (
              <div role="alert" className="flex flex-col items-center gap-4 rounded-lg border border-red-200 bg-red-50 p-8 text-center">
                <AlertTriangle className="h-9 w-9 text-red-500" aria-hidden />
                <div className="text-lg font-bold text-slate-900">{problem}</div>
                <Button type="button" onClick={onRetake} className="gap-2">
                  <ScanLine className="h-4 w-4" aria-hidden />
                  צלם שוב
                </Button>
              </div>
            )}

            {phase === 'ready' && (
              <div className="space-y-4">
                {ocrOk ? (
                  <div className="flex items-start gap-3 rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm text-blue-900">
                    <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                    <span>הפרטים נקראו מהתעודה. בדוק מול הצילום ותקן לפני שמירה{low.size > 0 ? ' — שדות מסומנים בצהוב נקראו בביטחון נמוך' : ''}.</span>
                  </div>
                ) : (
                  <div role="alert" className="flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                    <span>לא הצלחנו לקרוא את התעודה אוטומטית — מלא את הפרטים ידנית מהצילום.</span>
                  </div>
                )}

                {/* eslint-disable-next-line @next/next/no-img-element -- a one-off data: URL of the photo just taken; next/image cannot optimise it */}
                <img
                  src={`data:image/jpeg;base64,${imageB64}`} alt="צילום התעודה"
                  className="mx-auto max-h-72 w-full rounded-lg border border-slate-200 bg-white object-contain"
                />

                <Section title="פרטי המסמך" icon={IdCard} iconTone="blue">
                  <div className="py-2">
                    <VisitorForm values={values} onChange={patch} errors={errors} lowConfidence={low} disabled={saving} />
                  </div>
                </Section>
              </div>
            )}
          </div>

          <PanelFooter
            onClose={requestClose}
            onSave={() => void save()}
            saveDisabled={phase !== 'ready' || saving}
            saveLabel={saving ? 'שומר…' : 'שמור'}
          />
        </SheetContent>
      </Sheet>

      <AlertDialog open={confirmCloseOpen} onOpenChange={setConfirmCloseOpen}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>לצאת בלי לשמור את הסריקה?</AlertDialogTitle>
            <AlertDialogDescription>הצילום והפרטים לא יישמרו. אפשר לסרוק שוב בכל עת.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>המשך עריכה</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => { setConfirmCloseOpen(false); onClose(); }}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              צא ללא שמירה
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
